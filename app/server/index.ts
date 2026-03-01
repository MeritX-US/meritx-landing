import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { AssemblyAI } from 'assemblyai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

import { createClient } from "@deepgram/sdk";

dotenv.config();

// Initialize Deepgram
const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
if (!deepgramApiKey) {
    console.warn("Deepgram API Key not set - skipping Deepgram initialization");
}
const deepgram = deepgramApiKey ? createClient(deepgramApiKey) : null;

// Initialize Gemini client
const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
    console.error("Missing Gemini API Key in .env file");
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(geminiApiKey);

const app = express();
const port = process.env.PORT || 3001;

// Use CORS to allow frontend to communicate with backend
app.use(cors());
app.use(express.json());

// Set up Multer for handling file uploads
const uploadDirectory = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDirectory)) {
    fs.mkdirSync(uploadDirectory);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDirectory);
    },
    filename: (req, file, cb) => {
        // Retain original extension
        const ext = path.extname(file.originalname) || '.webm';
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
});
const upload = multer({ storage });

// Initialize AssemblyAI client
const apiKey = process.env.ASSEMBLYAI_API_KEY;
if (!apiKey) {
    console.warn("Missing AssemblyAI API Key in .env file - ensure TRANSCRIPTION_SERVICE is not assemblyai");
}
const client = new AssemblyAI({ apiKey: apiKey || '' });

// 0. Health check endpoint for UptimeRobot monitoring
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 1. Endpoint to handle audio upload and generate transcript
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No audio file provided' });
    }

    const filePath = req.file.path;
    const activeService = process.env.TRANSCRIPTION_SERVICE || 'assemblyai';
    const selectedLanguage = req.body.language || 'en';
    console.log(`Using transcription service: ${activeService}, language: ${selectedLanguage}`);

    try {
        let transcript;

        if (activeService === 'deepgram') {
            if (!deepgram) throw new Error("Deepgram client not initialized");

            // Deepgram Transcription
            const audioBuffer = fs.readFileSync(filePath);
            console.log(`Deepgram: Sending ${audioBuffer.length} bytes for transcription...`);

            // Performance note: nova-2 is often more robust for non-English auto-detection 
            // than the very new nova-3-general on certain short/challenging audio.
            // Chinese (zh) is specifically not yet supported by Nova-3.
            const nova3SupportedLanguages = ['en', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl'];
            const deepgramOptions: Record<string, any> = {
                model: (selectedLanguage === 'auto' || !nova3SupportedLanguages.includes(selectedLanguage)) ? 'nova-2' : 'nova-3-general',
                smart_format: true,
                diarize: true,
                utterances: true,
                // Comprehensive legal-grade redaction
                redact: [
                    'pci', 'pii', 'phi',
                    'name', 'location', 'phone_number',
                    'email_address', 'bank_account', 'passport_number',
                    'driver_license', 'date', 'ssn'
                ],
            };

            if (selectedLanguage === 'auto') {
                deepgramOptions.detect_language = true;
            } else {
                deepgramOptions.language = selectedLanguage;
            }

            console.log(`Deepgram options:`, JSON.stringify(deepgramOptions));
            const { result, error } = await deepgram.listen.prerecorded.transcribeFile(audioBuffer, deepgramOptions);

            if (error) {
                console.error('Deepgram error:', error);
                throw error;
            }

            // Log detailed results for debugging
            if (result.metadata) {
                console.log(`Deepgram raw result metadata:`, JSON.stringify(result.metadata));
            }
            if (result.results?.channels?.[0]) {
                const chan = result.results.channels[0];
                if (chan.detected_language) {
                    console.log(`Deepgram detected language: ${chan.detected_language} (confidence: ${chan.language_confidence})`);
                }
            }

            const channels = result.results?.channels || [];
            const utterances = result.results?.utterances || [];
            const transcriptText = channels[0]?.alternatives[0]?.transcript || '';

            console.log(`Deepgram channels count: ${channels.length}`);
            console.log(`Deepgram utterances count: ${utterances.length}`);
            console.log(`Deepgram transcript text length: ${transcriptText.length}`);

            if (!transcriptText && selectedLanguage === 'auto') {
                const chan = result.results?.channels?.[0];
                const confidence = chan?.language_confidence || 0;
                const detected = chan?.detected_language || 'unknown';
                console.warn(`Deepgram auto-detect failed. Detected: ${detected} with confidence: ${confidence}`);
                throw new Error(`Language detection failed (detected ${detected} with only ${Math.round(confidence * 100)}% confidence). Please manually select the correct language from the dropdown and try again.`);
            }

            if (!transcriptText && channels[0]?.alternatives?.[0]?.words?.length === 0) {
                console.warn('Deepgram returned no transcript text. Full result:', JSON.stringify(result, null, 2));
                throw new Error("No speech detected in the audio file. Please ensure the recording is clear and has audible speech.");
            }

            // Merge consecutive fragments from the same speaker to avoid fragmented view
            const mergedUtterances: any[] = [];
            utterances.forEach((u: any) => {
                const speaker = u.speaker !== undefined ? String.fromCharCode(65 + u.speaker) : 'A';
                const last = mergedUtterances[mergedUtterances.length - 1];

                const currentWords = (u.words || []).map((w: any) => ({
                    text: w.punctuated_word || w.word,
                    start: Math.floor(w.start * 1000),
                    end: Math.floor(w.end * 1000),
                    confidence: w.confidence,
                    speaker: speaker
                }));

                if (last && last.speaker === speaker) {
                    // Merge into last one
                    // For non-Chinese (which uses spaces), we might need to join with a space.
                    // For Chinese, we don't necessarily need a space. 
                    // To be safe, we join with space if the last one doesn't end with a space.
                    const needsSpace = last.text && !last.text.endsWith(' ') && u.transcript && !u.transcript.startsWith(' ');
                    last.text += (needsSpace ? ' ' : '') + u.transcript;
                    last.end = Math.floor(u.end * 1000);
                    last.words.push(...currentWords);
                } else {
                    // Start new utterance
                    mergedUtterances.push({
                        speaker: speaker,
                        text: u.transcript,
                        start: Math.floor(u.start * 1000),
                        end: Math.floor(u.end * 1000),
                        words: currentWords
                    });
                }
            });

            transcript = {
                id: result?.metadata?.request_id || 'unknown',
                status: 'completed',
                text: transcriptText,
                utterances: mergedUtterances
            };

        } else {
            // Default AssemblyAI Transcription
            const aaiTranscript = await client.transcripts.transcribe({
                audio: filePath,
                speaker_labels: true,
                speech_models: ["universal-2" as any],
                redact_pii: true,
                redact_pii_policies: [
                    "person_name",
                    "email_address",
                    "phone_number",
                    "location",
                    "drivers_license",
                    "passport_number",
                    "us_social_security_number",
                    "banking_information",
                    "account_number",
                    "date",
                    "date_of_birth",
                    "medical_condition",
                    "drug",
                    "injury",
                    "medical_process",
                    "blood_type",
                    "money_amount",
                    "organization"
                ],
                redact_pii_sub: "entity_name"
            } as any);

            transcript = aaiTranscript;
        }

        // Cleanup: Remove the file locally after uploading to API provider keeping zero-data promise locally
        fs.unlinkSync(filePath);

        console.log(`Transcription completed internally. Text available: ${!!transcript?.text}. Keys: ${Object.keys(transcript || {})}`);
        res.json({ transcript });
    } catch (error: any) {
        console.error('Transcription error:', error);
        // Attempt cleanup if it failed during processing
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        res.status(500).json({ error: error.message || 'Transcription failed' });
    }
});

// 2. Endpoint to summarize transcripts decoupled using Gemini
app.post('/api/summarize', async (req, res) => {
    const { text } = req.body;
    console.log('Summarization request received. Full body keys:', Object.keys(req.body));
    console.log('Text length:', text?.length || 0);

    if (!text || text.trim() === '') {
        return res.status(400).json({ error: 'Valid text string is required for summarization' });
    }

    try {
        // Use Gemini 2.5 Flash to generate a summary tailored for a legal consultation
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const prompt = `You are a legal assistant summarizing a client consultation for a law firm (e.g. immigration, family, civil).
      
Please provide a structured summary including:
1. Client Information & Core Issue
2. Key Facts & Timeline
3. Potential Legal Strategies discussed
4. Next Steps & Required Documents for the client
5. Recommended Follow-up Actions for the law firm

Format the response in Markdown.

Here is the consultation transcript:
${text}`;

        const result = await model.generateContent(prompt);
        const responseText = result.response.text();

        res.json({ summary: responseText });
    } catch (error: any) {
        console.error('Summarization error with Gemini:', error.message);
        res.status(500).json({ error: 'Summarization failed', details: error.message });
    }
});

app.listen(port, () => {
    console.log(`Backend server running on port ${port}`);
});
