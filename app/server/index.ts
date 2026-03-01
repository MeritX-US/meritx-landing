import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { AssemblyAI } from 'assemblyai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

import { createClient } from "@deepgram/sdk";
import twilio from 'twilio';

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
app.use(express.urlencoded({ extended: false })); // To parse Twilio's form-encoded body

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

// Initialize Twilio client
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = (twilioAccountSid && twilioAuthToken) ? twilio(twilioAccountSid, twilioAuthToken) : null;

// Persistence Utility for Consultation History
const recordsPath = path.join(__dirname, 'records.json');

const getRecords = (): any[] => {
    try {
        if (!fs.existsSync(recordsPath)) {
            fs.writeFileSync(recordsPath, JSON.stringify([]));
            return [];
        }
        const data = fs.readFileSync(recordsPath, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('Error reading records.json:', err);
        return [];
    }
};

const saveRecord = (record: any) => {
    try {
        const records = getRecords();
        records.unshift(record); // Add to beginning
        fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2));
    } catch (err) {
        console.error('Error saving record:', err);
    }
};

const deleteRecord = (id: string) => {
    try {
        const records = getRecords();
        const filtered = records.filter(r => r.id !== id);
        fs.writeFileSync(recordsPath, JSON.stringify(filtered, null, 2));
        return true;
    } catch (err) {
        console.error('Error deleting record:', err);
        return false;
    }
};

/**
 * SHARED PIPELINE LOGIC
 */

async function runConsultationPipeline(audioSource: string, selectedLanguage: string = 'en', isUrl: boolean = false) {
    const activeService = process.env.TRANSCRIPTION_SERVICE || 'assemblyai';
    let transcript;

    // 1. Transcription Phase
    if (activeService === 'deepgram') {
        if (!deepgram) throw new Error("Deepgram client not initialized");

        const nova3SupportedLanguages = ['en', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl'];
        const deepgramOptions: Record<string, any> = {
            model: (selectedLanguage === 'auto' || !nova3SupportedLanguages.includes(selectedLanguage)) ? 'nova-2' : 'nova-3-general',
            smart_format: true,
            utterances: true,
            redact: [
                'pci', 'pii', 'phi', 'name', 'location', 'phone_number',
                'email_address', 'bank_account', 'passport_number',
                'driver_license', 'date', 'ssn'
            ],
        };

        // For phone calls, use native multichannel instead of probabilistic diarization
        if (isUrl) {
            deepgramOptions.multichannel = true;
        } else {
            deepgramOptions.diarize = true;
        }

        if (selectedLanguage === 'auto') {
            deepgramOptions.detect_language = true;
        } else {
            deepgramOptions.language = selectedLanguage;
        }

        let response;
        if (isUrl) {
            response = await deepgram.listen.prerecorded.transcribeUrl({ url: audioSource }, deepgramOptions);
        } else {
            const buffer = fs.readFileSync(audioSource);
            response = await deepgram.listen.prerecorded.transcribeFile(buffer, deepgramOptions);
        }

        const { result, error } = response;
        if (error) throw error;

        const channels = result.results?.channels || [];
        const utterances = result.results?.utterances || [];

        // If multichannel, we might need to synthesize utterances if Deepgram didn't provide them globally
        // but typically for phone calls, we want to see the sequence.
        const transcriptText = channels[0]?.alternatives[0]?.transcript || '';

        // Merging logic
        const mergedUtterances: any[] = [];

        // Use utterances if available (better for flow)
        if (utterances.length > 0) {
            utterances.forEach((u: any) => {
                // If multichannel, channel 0 is usually the left speaker (Attorney), channel 1 is right (Client)
                const channelId = u.channel !== undefined ? u.channel : (u.speaker !== undefined ? u.speaker : 0);
                const speaker = String.fromCharCode(65 + channelId);
                const last = mergedUtterances[mergedUtterances.length - 1];
                const currentWords = (u.words || []).map((w: any) => ({
                    text: w.punctuated_word || w.word,
                    start: Math.floor(w.start * 1000),
                    end: Math.floor(w.end * 1000),
                    confidence: w.confidence,
                    speaker: speaker
                }));

                if (last && last.speaker === speaker) {
                    const needsSpace = last.text && !last.text.endsWith(' ') && u.transcript && !u.transcript.startsWith(' ');
                    last.text += (needsSpace ? ' ' : '') + u.transcript;
                    last.end = Math.floor(u.end * 1000);
                    last.words.push(...currentWords);
                } else {
                    mergedUtterances.push({
                        speaker: speaker,
                        text: u.transcript,
                        start: Math.floor(u.start * 1000),
                        end: Math.floor(u.end * 1000),
                        words: currentWords
                    });
                }
            });
        }

        transcript = {
            id: result?.metadata?.request_id || 'unknown',
            status: 'completed',
            text: transcriptText,
            utterances: mergedUtterances
        };
    } else {
        // AssemblyAI
        const aaiOptions: any = {
            audio: audioSource as string,
            speaker_labels: !isUrl, // Use labels for mono uploads
            multichannel: isUrl,    // Use native channels for phone calls
            speech_models: ["universal-2" as any],
            redact_pii: true,
            redact_pii_policies: [
                "person_name", "email_address", "phone_number", "location", "drivers_license",
                "passport_number", "us_social_security_number", "banking_information",
                "account_number", "date", "date_of_birth", "medical_condition"
            ],
            redact_pii_sub: "entity_name"
        };

        const aaiTranscript = await client.transcripts.transcribe(aaiOptions);
        transcript = aaiTranscript;
    }

    if (!transcript?.text) throw new Error("No speech detected in audio.");

    // 2. Summarization Phase
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `You are a legal assistant summarizing a client consultation for a law firm.
      
Please provide a structured summary in Markdown including:
1. Client Information & Core Issue
2. Key Facts & Timeline
3. Potential Legal Strategies discussed
4. Next Steps & Required Documents for the client
5. Recommended Follow-up Actions for the law firm

Consultation Transcript:
${transcript.text}`;

    const sumResult = await model.generateContent(prompt);
    const summary = sumResult.response.text();

    // 3. Persistence Phase
    const newRecord = {
        id: `rec_${Date.now()}`,
        timestamp: new Date().toISOString(),
        transcript: transcript,
        summary: summary,
        source: isUrl ? 'phone_call' : 'upload'
    };
    saveRecord(newRecord);

    return newRecord;
}

// 0. Health check endpoint for UptimeRobot monitoring
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 1. Endpoint to handle audio upload and generate transcript
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });
    const filePath = req.file.path;
    try {
        const record = await runConsultationPipeline(filePath, req.body.language || 'en', false);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath); // Cleanup
        res.json({ transcript: record.transcript, summary: record.summary, recordId: record.id });
    } catch (error: any) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.status(500).json({ error: error.message || 'Processing failed' });
    }
});

// 2. Endpoint to summarize (Legacy support or manual override)
app.post('/api/summarize', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent(`Summarize this legal consultation in Markdown:\n${text}`);
        const summary = result.response.text();
        const newRecord = { id: `rec_${Date.now()}`, timestamp: new Date().toISOString(), transcript: { text }, summary };
        saveRecord(newRecord);
        res.json({ summary, recordId: newRecord.id });
    } catch (error: any) {
        res.status(500).json({ error: 'Summarization failed' });
    }
});

/**
 * CONSULTATION RECORDS ENDPOINTS
 */

app.get('/api/records', (req, res) => {
    res.json(getRecords());
});

app.delete('/api/records/:id', (req, res) => {
    const { id } = req.params;
    const success = deleteRecord(id);
    if (success) {
        res.status(200).json({ status: 'deleted' });
    } else {
        res.status(500).json({ error: 'Failed to delete record' });
    }
});

app.listen(port, () => {
    console.log(`Backend server running on port ${port}`);
});

/**
 * TWILIO INTEGRATION ENDPOINTS
 */

// 1. TwiML Endpoint for Inbound/Outbound Calls
app.post('/api/twilio/voice', (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();

    console.log('Voice request received from Twilio:', req.body);

    // Legal Compliance Greeting
    twiml.say({ voice: 'Polly.Amy' }, 'This consultation is being recorded for legal record-keeping and intake purposes.');

    // Dial logic - In a real app, we'd lookup the attorney's number based on the Twilio number dialed
    const dial = twiml.dial({
        record: 'record-from-answer-dual', // Dual channel for speaker separation
        recordingStatusCallback: '/api/twilio/recording-callback',
    });

    // Temporary: Forward to a default number for demo
    // In production, this would be dynamic
    dial.number('+15104035644');

    res.type('text/xml');
    res.send(twiml.toString());
});

// 2. Webhook for when a recording is finished
app.post('/api/twilio/recording-callback', async (req, res) => {
    const { RecordingUrl, CallSid, RecordingSid, RecordingStatus } = req.body;

    console.log(`Twilio Recording ${RecordingStatus}: ${RecordingSid} for Call ${CallSid}`);

    if (RecordingStatus === 'completed' && RecordingUrl) {
        console.log(`🚀 Automatically processing recording from: ${RecordingUrl}`);

        try {
            const record = await runConsultationPipeline(RecordingUrl, 'en', true);
            console.log(`✅ Automated capture successful for Call ${CallSid}. Record ID: ${record.id}`);

            // Note: In production, you might want to call Twilio API to delete the recording
            // to fulfill the zero-retention promise on their side too.
        } catch (error: any) {
            console.error(`❌ Automated capture failed for Call ${CallSid}:`, error.message);
        }
    }

    res.status(200).end();
});
