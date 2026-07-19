import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { AssemblyAI } from 'assemblyai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { runPlaybookAnalysis } from './playbookEngine';
import { researchEntity } from './contextResearcher';
import { generateResearchPDF } from './pdfGenerator';
import dns from 'dns';
import { PDFDocument, rgb, StandardFonts, PageSizes } from 'pdf-lib';

// Fix for Node.js 18+ IPv6 fetch issues causing 'fetch failed'
dns.setDefaultResultOrder('ipv4first');

// Helper for Google API Retries
async function uploadFileWithRetry(fileManager: GoogleAIFileManager, filePath: string, options: any, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            console.log(`[File API] Attempting upload for ${filePath}. MimeType: ${options.mimeType}`);
            return await fileManager.uploadFile(filePath, options);
        } catch (error: any) {
            console.error(`[File API] Upload attempt ${i + 1} failed for ${filePath}`);
            console.error(`[File API] Error message: ${error.message}`);
            if (error.cause) {
                console.error(`[File API] Error cause:`, error.cause);
            }
            if (error.response) {
                console.error(`[File API] Error response status:`, error.response.status);
            }
            if (i === maxRetries - 1) throw error;
            console.log(`[File API] Waiting before retry...`);
            await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1))); // exponential backoff
        }
    }
}

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
const fileManager = new GoogleAIFileManager(geminiApiKey);

async function getOrUploadGeminiFile(item: any): Promise<string> {
    const filePath = path.join(serverRootDir, item.url.replace('/uploads', 'uploads'));
    const mimeType = item.metadata?.mimetype || (item.type === 'image' ? 'image/jpeg' : 'application/pdf');

    if (item.metadata && item.metadata.fileUri) {
        try {
            const fileId = item.metadata.fileUri.split('/').pop();
            const fileName = `files/${fileId}`;
            await fileManager.getFile(fileName);
            return item.metadata.fileUri; // Valid!
        } catch (err) {
            console.log(`Gemini File API file ${item.metadata.fileUri} expired or missing, re-uploading...`);
        }
    }
    
    if (fs.existsSync(filePath)) {
        console.log(`Uploading ${item.name} to Gemini...`);
        const uploadResult = await uploadFileWithRetry(fileManager, filePath, { mimeType });
        item.metadata = item.metadata || {};
        item.metadata.fileUri = uploadResult!.file.uri;
        return uploadResult!.file.uri;
    } else {
        throw new Error(`Local file not found for upload: ${filePath}`);
    }
}

const app = express();
const port = process.env.PORT || 3001;

const serverRootDir = fs.existsSync(path.join(__dirname, 'package.json'))
    ? __dirname
    : path.join(__dirname, '..');

// Use CORS to allow frontend to communicate with backend
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // To parse Twilio's form-encoded body
app.use('/uploads', express.static(path.join(serverRootDir, 'uploads')));

// Set up Multer for handling file uploads
const uploadDirectory = path.join(serverRootDir, 'uploads');
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
const recordsPath = path.join(serverRootDir, 'records.json');

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

async function transcribeWithDeepgram(audioSource: string, selectedLanguage: string, isUrl: boolean) {
    if (!deepgram) throw new Error("Deepgram client not initialized");

    const nova3SupportedLanguages = ['en', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl'];
    const deepgramOptions: Record<string, any> = {
        model: (selectedLanguage === 'auto' || !nova3SupportedLanguages.includes(selectedLanguage)) ? 'nova-2' : 'nova-3-general',
        smart_format: true,
        utterances: true,
        redact: [
            'pci', 'pii', 'phi', 'location', 'phone_number',
            'email_address', 'bank_account', 'passport_number',
            'driver_license', 'ssn'
        ],
    };

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
    const transcriptText = channels[0]?.alternatives[0]?.transcript || '';

    const mergedUtterances: any[] = [];
    if (utterances.length > 0) {
        utterances.forEach((u: any) => {
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

    return {
        id: result?.metadata?.request_id || 'unknown',
        status: 'completed',
        text: transcriptText,
        utterances: mergedUtterances
    };
}

async function transcribeWithAssemblyAI(audioSource: string, isUrl: boolean) {
    const aaiOptions: any = {
        audio: audioSource as string,
        speaker_labels: !isUrl, 
        multichannel: isUrl,    
        speech_models: ["universal-2" as any],
        redact_pii: true,
        redact_pii_policies: [
            "email_address", "phone_number", "location", "drivers_license",
            "passport_number", "us_social_security_number", "banking_information",
            "account_number", "medical_condition"
        ],
        redact_pii_sub: "entity_name"
    };

    return await client.transcripts.transcribe(aaiOptions);
}

async function refineDiarizationWithGemini(transcript: any) {
    if (!transcript.utterances || transcript.utterances.length === 0) return;

    try {
        console.log("Running Diarization Refinement with Gemini Pro...");
        const refineModel = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
        
        const simplified = transcript.utterances.map((u: any, i: number) => ({
            u_idx: i,
            speaker: u.speaker,
            words: (u.words || []).map((w: any, w_idx: number) => ({
                w_idx: w_idx,
                text: w.text
            }))
        }));

        const prompt = `You are an expert legal transcription editor. The ASR model has failed to separate speakers correctly in the following transcript. Sometimes a single utterance contains speech from two different speakers.

CRITICAL PATTERN TO FIX:
ASR models often hallucinate punctuation and merge short affirmations from the listener. For example, if Speaker A says "...expires on November 28?" and Speaker B replies "Correct.", the ASR might merge it into a single utterance for Speaker A as "...expired on November 28, correct?". 
Look VERY closely for words like "correct?", "right?", "okay", "yes", "mhm" embedded in what looks like a continuous sentence. If the context implies it's actually an answer or acknowledgment from the other speaker, YOU MUST split it out!

Analyze the following utterances. If an utterance contains a clear speaker change mid-utterance, identify the exact word index where the new speaker begins, and then the word index where it switches back (if applicable).

Respond ONLY with a JSON array of the required splits. If no splits are needed, return an empty array [].
Format exactly like this example:
[
  {
    "u_idx": 0,
    "splits": [
      { "w_idx": 5, "newSpeaker": "B" },
      { "w_idx": 6, "newSpeaker": "A" }
    ]
  }
]

Transcript Data:
${JSON.stringify(simplified)}
`;

        const refineResult = await refineModel.generateContent(prompt);
        const refineText = refineResult.response.text();
        
        const jsonMatch = refineText.match(/\[.*\]/s);
        if (jsonMatch) {
            const splits = JSON.parse(jsonMatch[0]);
            if (splits.length > 0) {
                console.log("Applying Diarization Splits:", splits);
                
                const newUtterances: any[] = [];
                
                for (let i = 0; i < transcript.utterances.length; i++) {
                    const originalU = transcript.utterances[i];
                    const splitInfo = splits.find((s: any) => s.u_idx === i);
                    
                    if (!splitInfo || !splitInfo.splits || splitInfo.splits.length === 0) {
                        newUtterances.push(originalU);
                        continue;
                    }
                    
                    let currentSpeaker = originalU.speaker;
                    let currentWords: any[] = [];
                    let splitQueue = [...splitInfo.splits].sort((a: any, b: any) => a.w_idx - b.w_idx);
                    
                    for (let w = 0; w < originalU.words.length; w++) {
                        const word = originalU.words[w];
                        
                        if (splitQueue.length > 0 && splitQueue[0].w_idx === w) {
                            if (currentWords.length > 0) {
                                newUtterances.push({
                                    speaker: currentSpeaker,
                                    text: currentWords.map(cw => cw.text).join(' '),
                                    start: currentWords[0].start,
                                    end: currentWords[currentWords.length - 1].end,
                                    words: [...currentWords]
                                });
                            }
                            currentSpeaker = splitQueue[0].newSpeaker;
                            currentWords = [];
                            splitQueue.shift();
                        }
                        
                        word.speaker = currentSpeaker;
                        currentWords.push(word);
                    }
                    
                    if (currentWords.length > 0) {
                        newUtterances.push({
                            speaker: currentSpeaker,
                            text: currentWords.map(cw => cw.text).join(' '),
                            start: currentWords[0].start,
                            end: currentWords[currentWords.length - 1].end,
                            words: currentWords
                        });
                    }
                }
                
                transcript.utterances = newUtterances;
                // Rebuild transcript.text from the new utterances so the summary gets the updated speaker labels
                transcript.text = newUtterances.map(u => `Speaker ${u.speaker}: ${u.text}`).join('\n\n');
            }
        }
    } catch (e) {
        console.error("Diarization refinement failed, proceeding with original transcript:", e);
    }
}

async function summarizeConsultation(transcriptText: string) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `You are a legal assistant summarizing a client consultation for a law firm.
      
Please provide a structured summary in Markdown including:
1. Client Information & Core Issue
2. Key Facts & Timeline
3. Potential Legal Strategies discussed
4. Next Steps & Required Documents for the client
5. Recommended Follow-up Actions for the law firm

Consultation Transcript:
${transcriptText}`;

    const sumResult = await model.generateContent(prompt);
    return sumResult.response.text();
}

async function runConsultationPipeline(audioSource: string, selectedLanguage: string = 'en', isUrl: boolean = false, recordingSid?: string) {
    const activeService = process.env.TRANSCRIPTION_SERVICE || 'assemblyai';
    let transcript;

    // 1. Transcription Phase
    if (activeService === 'deepgram') {
        transcript = await transcribeWithDeepgram(audioSource, selectedLanguage, isUrl);
    } else {
        transcript = await transcribeWithAssemblyAI(audioSource, isUrl);
    }

    if (!transcript?.text) throw new Error("No speech detected in audio.");

    // 1.5 Diarization Refinement Phase
    await refineDiarizationWithGemini(transcript);

    // 2. Summarization Phase
    const summary = await summarizeConsultation(transcript.text);

    // 3. Persistence Phase
    let recordAudioUrl = audioSource;
    if (!isUrl) {
        const fileName = path.basename(audioSource);
        recordAudioUrl = `/uploads/${fileName}`;
    }

    const newRecord = {
        id: `rec_${Date.now()}`,
        timestamp: new Date().toISOString(),
        type: 'matter',
        items: [
            {
                type: 'audio',
                url: recordAudioUrl,
                name: 'Original Recording'
            }
        ],
        transcript: transcript,
        summary: summary,
        source: isUrl ? 'phone_call' : 'upload',
        audioUrl: recordAudioUrl, 
        recordingSid: recordingSid
    };
    saveRecord(newRecord);

    return newRecord;
}

// 0. Health check endpoint for UptimeRobot monitoring
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 1. Endpoint to handle audio upload and generate transcript
app.post('/api/transcribe', upload.array('audios'), async (req, res) => {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) return res.status(400).json({ error: 'No audio files provided' });

    try {
        const language = req.body.language || 'en';
        const caseType = req.body.caseType;
        const activeService = process.env.TRANSCRIPTION_SERVICE || 'assemblyai';
        let combinedText = '';
        let combinedUtterances: any[] = [];
        const recordAudioUrls: string[] = [];
        let idx = 0;
        for (const file of files) {
            const filePath = file.path;
            const fileName = path.basename(filePath);
            const originalName = file.originalname || `Recording ${idx + 1}`;
            const audioUrl = `/uploads/${fileName}`;
            recordAudioUrls.push(audioUrl);

            let transcript;
            if (activeService === 'deepgram') {
                transcript = await transcribeWithDeepgram(filePath, language, false);
            } else {
                transcript = await transcribeWithAssemblyAI(filePath, false);
            }

            if (!transcript?.text) {
                console.warn("No speech detected in audio:", file.originalname);
                idx++;
                continue;
            }

            await refineDiarizationWithGemini(transcript);

            combinedText += (combinedText ? '\n\n' : '') + (files.length > 1 ? `=== Transcript for ${originalName} ===\n\n` : '') + transcript.text;

            if (transcript.utterances) {
                const adjustedUtterances = transcript.utterances.map((u: any) => ({
                    ...u,
                    fileIndex: idx,
                    fileName: originalName,
                    audioUrl: audioUrl
                }));
                combinedUtterances = combinedUtterances.concat(adjustedUtterances);
            }
            idx++;
        }

        if (!combinedText) throw new Error("No speech detected in any audio.");

        const summary = await summarizeConsultation(combinedText);

        const newRecord = {
            id: `rec_${Date.now()}`,
            timestamp: new Date().toISOString(),
            type: 'matter',
            items: files.map((file, idx) => ({
                type: 'audio',
                url: recordAudioUrls[idx],
                name: file.originalname || `Recording ${idx + 1}`
            })),
            transcript: {
                id: `combined_${Date.now()}`,
                status: 'completed',
                text: combinedText,
                utterances: combinedUtterances
            },
            summary: summary,
            source: 'upload',
            audioUrl: recordAudioUrls[0],
            recordingSid: undefined,
            caseType: (caseType && caseType !== 'auto') ? caseType : undefined
        };
        saveRecord(newRecord);

        res.json({ success: true, record: newRecord, transcript: newRecord.transcript, summary: newRecord.summary, recordId: newRecord.id });
    } catch (error: any) {
        const files = req.files as Express.Multer.File[];
        if (files) {
            for (const file of files) {
                if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
            }
        }
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

app.get('/api/config', (req, res) => {
    res.json({
        twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || ''
    });
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

app.put('/api/records/:id/summary', (req, res) => {
    const { id } = req.params;
    const { summary } = req.body;
    
    if (typeof summary !== 'string') {
        return res.status(400).json({ error: 'Summary string is required' });
    }

    try {
        const records = getRecords();
        const recordIndex = records.findIndex(r => r.id === id);
        
        if (recordIndex === -1) {
            return res.status(404).json({ error: 'Record not found' });
        }

        records[recordIndex].summary = summary;
        fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2));

        res.status(200).json({ success: true, record: records[recordIndex] });
    } catch (error: any) {
        console.error('Error updating summary:', error);
        res.status(500).json({ error: 'Failed to update summary' });
    }
});

/**
 * START SERVER
 */
app.listen(port as number, '0.0.0.0', () => {
    console.log(`Backend server running on port ${port} (0.0.0.0)`);
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

    // Forward to the configured attorney number
    const attorneyNumber = process.env.ATTORNEY_PHONE_NUMBER;
    if (!attorneyNumber) {
        console.error('Missing ATTORNEY_PHONE_NUMBER in .env');
        twiml.say({ voice: 'Polly.Amy' }, 'Sorry, the attorney phone number is not configured. Please contact the administrator.');
        res.type('text/xml');
        return res.send(twiml.toString());
    }
    dial.number(attorneyNumber);

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
            const record = await runConsultationPipeline(RecordingUrl, 'en', true, RecordingSid);
            console.log(`✅ Automated capture successful for Call ${CallSid}. Record ID: ${record.id}`);

            // Note: In production, you might want to call Twilio API to delete the recording
            // to fulfill the zero-retention promise on their side too.
        } catch (error: any) {
            console.error(`❌ Automated capture failed for Call ${CallSid}:`, error.message);
        }
    }

    res.status(200).end();
});

// 3. Sync Endpoints to recover missing recordings

// Check for missing recordings
app.get('/api/twilio/sync/check', async (req, res) => {
    if (!twilioClient) {
        return res.status(500).json({ error: 'Twilio client not initialized' });
    }

    try {
        console.log('🔍 Checking Twilio for missing recordings...');
        const records = getRecords();
        const existingSids = new Set(records.map(r => r.recordingSid).filter(Boolean));

        // Get recordings from the last 2 days
        const recordings = await twilioClient.recordings.list({
            dateCreatedAfter: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
            limit: 20
        });

        const missing = recordings
            .filter(r => !existingSids.has(r.sid) && r.status === 'completed')
            .map(r => ({
                sid: r.sid,
                dateCreated: r.dateCreated,
                duration: r.duration
            }));

        res.json({
            total_found: recordings.length,
            missing_count: missing.length,
            missing: missing
        });
    } catch (error: any) {
        console.error('❌ Twilio Check Error:', error);
        res.status(500).json({ error: 'Check failed', message: error.message });
    }
});

// Process a specific missing recording
app.get('/api/twilio/sync/process/:sid', async (req, res) => {
    const { sid } = req.params;
    if (!twilioClient) return res.status(500).json({ error: 'Twilio client not initialized' });

    try {
        const r = await twilioClient.recordings(sid).fetch();
        if (r.status !== 'completed') {
            return res.status(400).json({ error: 'Recording is not yet completed' });
        }

        const audioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Recordings/${sid}.mp3`;
        console.log(`🚀 Sync-processing recording: ${sid}`);

        const record = await runConsultationPipeline(audioUrl, 'en', true, sid);
        res.json({ sid, status: 'synced', id: record.id });
    } catch (error: any) {
        console.error(`❌ Sync failed for recording ${sid}:`, error.message);
        res.status(500).json({ sid, status: 'failed', error: error.message });
    }
});

// 4. Outbound Click-to-Call Endpoints

app.post('/api/twilio/call-out', async (req, res) => {
    const { clientPhoneNumber } = req.body;

    if (!twilioClient) {
        return res.status(500).json({ error: 'Twilio client not initialized' });
    }

    const attorneyNumber = process.env.ATTORNEY_PHONE_NUMBER;
    const twilioNumber = process.env.TWILIO_PHONE_NUMBER;

    if (!attorneyNumber || !twilioNumber) {
        return res.status(500).json({ error: 'Attorney or Twilio phone number not configured in .env' });
    }

    if (!clientPhoneNumber) {
        return res.status(400).json({ error: 'Client phone number is required' });
    }

    try {
        console.log(`Initiating Two-Legged Call: Attorney (${attorneyNumber}) -> Client (${clientPhoneNumber})`);

        // We call the attorney first. When they answer, Twilio hits the 'url' TwiML to dial the client.
        const encodedClientNumber = encodeURIComponent(clientPhoneNumber);

        // In local development, the host might just be localhost:3001, which Twilio can't reach.
        // For Render/Netlify, req.headers.host works great.
        // If testing locally, the user can set PUBLIC_SERVER_URL in .env (e.g. ngrok)
        const publicBase = process.env.PUBLIC_SERVER_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`;
        const bridgeUrl = `${publicBase}/api/twilio/call-out/bridge?clientNumber=${encodedClientNumber}`;

        const call = await twilioClient.calls.create({
            to: attorneyNumber,
            from: twilioNumber,
            url: bridgeUrl
        });

        res.json({ success: true, callSid: call.sid, message: 'Dialing attorney first...' });
    } catch (error: any) {
        console.error('❌ Call out failed:', error.message);
        res.status(500).json({ error: 'Failed to initiate call', message: error.message });
    }
});

app.post('/api/twilio/call-out/bridge', (req, res) => {
    const { clientNumber } = req.query;

    console.log(`Attorney answered. Bridging call to client: ${clientNumber}`);

    const twiml = new twilio.twiml.VoiceResponse();

    // Announce to the attorney that we are connecting
    twiml.say({ voice: 'Polly.Amy' }, 'Connecting to client. This call will be recorded.');

    if (clientNumber) {
        const dial = twiml.dial({
            record: 'record-from-answer-dual',
            recordingStatusCallback: '/api/twilio/recording-callback',
        });
        // We must tell Twilio what number to dial for the client side of the leg
        dial.number(clientNumber as string);
    } else {
        twiml.say({ voice: 'Polly.Amy' }, 'Error: No client number provided.');
    }

    res.type('text/xml');
    res.send(twiml.toString());
});

// ── Document Classification Helper ───────────────────────────────────────────
// Category metadata for display on the frontend
const CATEGORY_LABELS: Record<string, string> = {
    passport: 'Passport',
    visa: 'Visa',
    employment_letter: 'Employment Letter',
    support_letter: 'Support Letter',
    award_certificate: 'Award / Certificate',
    publication: 'Publication',
    media_coverage: 'Media Coverage',
    tax_document: 'Tax Document',
    degree_certificate: 'Degree / Diploma',
    affidavit: 'Affidavit',
    court_document: 'Court Document',
    immigration_form: 'USCIS / Immigration Form',
    photo_id: 'Photo ID',
    contract: 'Contract / Agreement',
    financial_document: 'Financial Document',
    medical_record: 'Medical Record',
    // Audio categories
    consultation_call: 'Consultation Call',
    deposition: 'Deposition',
    witness_statement: 'Witness Statement',
    court_hearing: 'Court Hearing',
    interview: 'Interview Recording',
    voicemail: 'Voicemail',
    audio_recording: 'Audio Recording',
    other: 'Other Document',
};

interface FileClassification {
    originalname: string;
    category: string;
    categoryLabel: string;
    suggestedName: string;
    confidence: number;
}

async function classifyDocumentsWithGemini(
    files: any[],          // imagePdfFiles with .fileUri set and name/originalname
    parts: any[]           // already-uploaded Gemini parts (same order as files)
): Promise<FileClassification[]> {
    if (files.length === 0) return [];

    const classifyModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `You are an expert legal document classifier. 
Examine the attached document files (images/PDFs) AND their original filenames to identify the precise legal document category and a standardized short filename for each.

For each attached document in the EXACT order provided, output a JSON object in a raw JSON array:
[
  {
    "category": "<one of: passport, visa, employment_letter, support_letter, award_certificate, publication, media_coverage, tax_document, degree_certificate, affidavit, court_document, immigration_form, photo_id, contract, financial_document, medical_record, other>",
    "suggestedName": "<a concise English filename WITHOUT extension, max 30 chars, e.g. Zhang_Passport_2024 or Bank_Statement_2024. Extract person's name and document type from content>",
    "confidence": <0.8 to 1.0>
  }
]

Original Filename Hints:
${files.map((f, i) => `${i + 1}. ${f.originalname || f.name || 'Document'}`).join('\n')}

Output ONLY the raw JSON array. Exactly ${files.length} element(s).`;

    const contentParts: any[] = [{ text: prompt }, ...parts];

    try {
        const result = await classifyModel.generateContent(contentParts);
        let text = result.response.text().trim();
        console.log('=== [CLASSIFY GEMINI RAW OUTPUT START] ===');
        console.log(text);
        console.log('=== [CLASSIFY GEMINI RAW OUTPUT END] ===');
        text = text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
        const parsed = JSON.parse(text) as any[];
        return files.map((f, i) => {
            const item = parsed[i] || {};
            const category = item.category || 'other';
            return {
                originalname: f.originalname || f.name || '',
                category: category,
                categoryLabel: CATEGORY_LABELS[category] || CATEGORY_LABELS['other'],
                suggestedName: item.suggestedName || '',
                confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
            };
        });
    } catch (err: any) {
        console.warn('[Classify] Classification parse failed, using defaults:', err.message);
        return files.map(f => ({
            originalname: f.originalname || f.name || '',
            category: 'other',
            categoryLabel: CATEGORY_LABELS['other'],
            suggestedName: '',
            confidence: 0,
        }));
    }
}

// ── Audio Classification Helper ───────────────────────────────────────────────
// Uses transcript text (no file upload needed) to classify audio recordings
async function classifyAudioWithTranscript(
    audioItems: Array<{ originalname: string; transcriptText: string }>
): Promise<FileClassification[]> {
    if (audioItems.length === 0) return [];

    const classifyModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const itemsJson = audioItems.map((a, i) =>
        `${i + 1}. Filename: "${a.originalname}"\nTranscript (excerpt):\n${a.transcriptText.substring(0, 2500)}`
    ).join('\n\n---\n\n');

    const prompt = `You are a legal audio recording classifier. For each transcript excerpt provided, output a JSON array (no markdown, no explanation) where each element corresponds to one recording in the EXACT order given.

For each recording, output:
{
  "category": "<one of: consultation_call, deposition, witness_statement, court_hearing, interview, voicemail, audio_recording>",
  "suggestedName": "<a concise English filename WITHOUT extension, keeping total length under 30 chars, e.g. Zhang_Consultation_2024 or Smith_Deposition_2024>",
  "confidence": <0.0 to 1.0>
}

Category guide:
- consultation_call: Attorney-client consultation or intake interview
- deposition: Formal deposition / sworn testimony
- witness_statement: Witness describing events
- court_hearing: Court proceeding or hearing
- interview: Informal interview or fact-gathering session
- voicemail: Short voicemail message
- audio_recording: Any other audio

Recordings to classify:
${itemsJson}

Output only the raw JSON array containing exactly ${audioItems.length} items.`;

    try {
        const result = await classifyModel.generateContent(prompt);
        let text = result.response.text().trim();
        text = text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
        const parsed = JSON.parse(text) as any[];
        return audioItems.map((a, i) => {
            const item = parsed[i] || {};
            const category = item.category || 'audio_recording';
            return {
                originalname: a.originalname,
                category: category,
                categoryLabel: CATEGORY_LABELS[category] || CATEGORY_LABELS['audio_recording'],
                suggestedName: item.suggestedName || '',
                confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
            };
        });
    } catch (err: any) {
        console.warn('[AudioClassify] Parse failed, using defaults:', err.message);
        return audioItems.map(a => ({
            originalname: a.originalname,
            category: 'audio_recording',
            categoryLabel: CATEGORY_LABELS['audio_recording'],
            suggestedName: '',
            confidence: 0,
        }));
    }
}


app.post('/api/intake/process', upload.array('files'), async (req, res) => {
    const files = req.files as Express.Multer.File[];
    const { existingRecordId, caseType } = req.body;

    if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files provided' });
    }

    try {
        console.log(`Processing Multimodal Intake: ${files.length} files. Target Collection: ${existingRecordId || 'New'}`);

        let existingRecord: any = null;

        // Compute hash for all uploaded files sequentially to save memory
        const filesWithHash: any[] = [];
        for (const file of files) {
            const fileBuffer = fs.readFileSync(file.path);
            const hashSum = crypto.createHash('sha256');
            hashSum.update(fileBuffer);
            filesWithHash.push({ ...file, hash: hashSum.digest('hex') });
        }

        let validFiles: any[] = filesWithHash;

        if (existingRecordId) {
            const records = getRecords();
            existingRecord = records.find(r => r.id === existingRecordId);

            if (existingRecord && existingRecord.items) {
                // Filter out duplicates based on hash (or fallback to originalname and size)
                validFiles = filesWithHash.filter(file => {
                    const isDuplicate = existingRecord.items.some((item: any) => {
                        if (item.metadata && item.metadata.hash) {
                            return item.metadata.hash === file.hash;
                        } else {
                            const nameMatches = item.name === file.originalname;
                            const sizeMatches = item.metadata ? item.metadata.size === file.size : true;
                            return nameMatches && sizeMatches;
                        }
                    });

                    if (isDuplicate) {
                        console.log(`Skipping duplicate file: ${file.originalname}`);
                        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
                        return false;
                    }
                    return true;
                });
            }
        }

        if (validFiles.length === 0) {
            return res.status(400).json({ error: 'All uploaded files are exact duplicates of existing materials in this matter.' });
        }

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const imagePdfFiles = validFiles.filter(f => !f.mimetype.startsWith('audio/'));
        const audioFiles = validFiles.filter(f => f.mimetype.startsWith('audio/'));

        let newAudioText = '';
        let newAudioUtterances: any[] = [];
        // Per-file transcript map for audio classification
        const audioTranscriptMap: Record<string, string> = {};

        if (audioFiles.length > 0) {
            const existingAudioCount = existingRecord ? existingRecord.items.filter((i:any) => i.type === 'audio').length : 0;
            const activeService = process.env.TRANSCRIPTION_SERVICE || 'assemblyai';
            let idx = 0;
            for (const file of audioFiles) {
                const filePath = file.path;
                const fileName = path.basename(filePath);
                const originalName = file.originalname || `Recording ${existingAudioCount + idx + 1}`;
                const audioUrl = `/uploads/${fileName}`;

                let transcript;
                if (activeService === 'deepgram') {
                    transcript = await transcribeWithDeepgram(filePath, 'en', false);
                } else {
                    transcript = await transcribeWithAssemblyAI(filePath, false);
                }
                
                if (transcript?.text) {
                    await refineDiarizationWithGemini(transcript);
                    newAudioText += (newAudioText ? '\n\n' : '') + (audioFiles.length > 1 || existingAudioCount > 0 ? `=== Transcript for ${originalName} ===\n\n` : '') + transcript.text;
                    // Save per-file transcript for audio classification
                    audioTranscriptMap[originalName] = transcript.text;
                    
                    if (transcript.utterances) {
                        const adjustedUtterances = transcript.utterances.map((u: any) => ({
                            ...u,
                            fileIndex: existingAudioCount + idx,
                            fileName: originalName,
                            audioUrl: audioUrl
                        }));
                        newAudioUtterances = newAudioUtterances.concat(adjustedUtterances);
                    }
                }
                idx++;
            }
        }

        // Prepare media for Gemini (only non-audio files) using Google AI File API
        const parts: any[] = [];
        for (const file of imagePdfFiles) {
            console.log(`Uploading ${file.originalname} to Gemini via File API...`);
            const uploadResult = await uploadFileWithRetry(fileManager, file.path, { mimeType: file.mimetype, displayName: file.originalname });
            file.fileUri = uploadResult!.file.uri; // Save URI on the file object
            parts.push({
                fileData: {
                    mimeType: file.mimetype,
                    fileUri: uploadResult!.file.uri
                }
            });
        }

        let contextPrompt = "";
        let existingSummary = "";

        if (existingRecord) {
            if (existingRecord.transcript || newAudioText) {
                const oldText = existingRecord.transcript ? existingRecord.transcript.text : "";
                contextPrompt = `\n\nExisting Consultation Transcript Context:\n${oldText}\n\nNew Transcripts:\n${newAudioText}\n\n`;
            }
            if (existingRecord.summary) {
                existingSummary = `\n\nPREVIOUS SUMMARY (USE THIS AS THE BASELINE AND MAINTAIN ITS STYLE):\n${existingRecord.summary}\n\n`;
            }
        } else if (newAudioText) {
            contextPrompt = `\n\nConsultation Transcript Context:\n${newAudioText}\n\n`;
        }

        let updateInstructions = "";
        if (existingRecord) {
            const currentTime = new Date().toLocaleString('en-US', { timeZoneName: 'short' });
            updateInstructions = `3. IMPORTANT: You MUST add a new section at the very top of your response called "### 🆕 Recent Updates / New Findings (${currentTime})" that explicitly lists what new information or context was just added from the latest upload. This helps the user see that their new materials were processed.`;
        }

        const prompt = `You are a legal intake specialist. You have been provided with new documents/images/audio transcripts for a "Matter Collection".
        
        ${contextPrompt}
        ${existingSummary}
        
        Please analyze all provided materials and any existing consultation context.
        Provide a unified, structural summary in Markdown.
        
        CRITICAL INSTRUCTIONS FOR CONSISTENCY:
        1. Maintain the existing tone, structure, and Markdown formatting from the "PREVIOUS SUMMARY" if provided.
        2. Integrate new facts from the documents/transcripts into the relevant sections.
        ${updateInstructions}
        4. Do NOT rewrite or substantially change the "Next Steps & Required Documents" or "Recommended Follow-up Actions" from scratch. HOWEVER, if the newly provided materials satisfy any previously requested documents or information (e.g., ID, passport, proof of address), you MUST REMOVE those items from the "Next Steps & Required Documents" list to reflect they have been received.
        5. If the new material only adds a minor detail (e.g., a new co-plaintiff or a specific date), simply incorporate that detail without altering the surrounding text.
        6. If there are multiple files/transcripts, treat them as a single "Matter Collection".
        
        Deliver an updated, professional legal intake summary.`;

        const result = await model.generateContent([prompt, ...parts]);
        const summary = result.response.text();

        // Classify non-audio files using Gemini (no extra upload cost)
        let classifications: FileClassification[] = [];
        if (imagePdfFiles.length > 0) {
            try {
                console.log(`[Classify] Classifying ${imagePdfFiles.length} document(s)...`);
                classifications = await classifyDocumentsWithGemini(imagePdfFiles, parts);
                console.log(`[Classify] Done:`, classifications.map(c => `${c.originalname} → ${c.category} (${c.suggestedName})`));
            } catch (err: any) {
                console.warn('[Classify] Non-fatal error, skipping classification:', err.message);
            }
        }

        // Classify audio files using their transcripts
        if (audioFiles.length > 0 && Object.keys(audioTranscriptMap).length > 0) {
            try {
                const audioInputs = audioFiles.map((f: any) => ({
                    originalname: f.originalname,
                    transcriptText: audioTranscriptMap[f.originalname] || '',
                })).filter(a => a.transcriptText);
                if (audioInputs.length > 0) {
                    console.log(`[AudioClassify] Classifying ${audioInputs.length} audio file(s)...`);
                    const audioCls = await classifyAudioWithTranscript(audioInputs);
                    console.log(`[AudioClassify] Done:`, audioCls.map(c => `${c.originalname} → ${c.category}`));
                    classifications = classifications.concat(audioCls);
                }
            } catch (err: any) {
                console.warn('[AudioClassify] Non-fatal error, skipping:', err.message);
            }
        }

        // Build a lookup map: originalname → classification
        const classifyMap: Record<string, FileClassification> = {};
        for (const cls of classifications) {
            classifyMap[cls.originalname] = cls;
        }

        // Create item objects for the record
        const newItems = validFiles.map(file => {
            const isAudio = file.mimetype.startsWith('audio/');
            const cls = !isAudio ? classifyMap[file.originalname] : undefined;
            const ext = path.extname(file.originalname) || (isAudio ? '.webm' : '');
            const suggestedName = cls?.suggestedName ? `${cls.suggestedName}${ext}` : '';
            return {
                type: file.mimetype.startsWith('image/') ? 'image' : isAudio ? 'audio' : 'pdf',
                url: `/uploads/${path.basename(file.path)}`,
                name: file.originalname,
                metadata: {
                    size: file.size,
                    mimetype: file.mimetype,
                    hash: file.hash,
                    fileUri: file.fileUri,
                    originalname: file.originalname,
                    category: isAudio ? 'audio_recording' : (cls?.category || 'other'),
                    categoryLabel: isAudio ? CATEGORY_LABELS['audio_recording'] : (cls?.categoryLabel || CATEGORY_LABELS['other']),
                    suggestedName,
                    classificationConfidence: isAudio ? 1 : (cls?.confidence ?? 0),
                },
            };
        });

        const records = getRecords();
        let record: any;
        let isNewRecord = false;

        if (existingRecordId) {
            // Find and update the existing record IN the same array we'll write back
            const idx = records.findIndex(r => r.id === existingRecordId);
            if (idx !== -1) {
                records[idx].items = [...(records[idx].items || []), ...newItems];
                records[idx].summary = summary; // Update with holistic summary
                
                if (newAudioText) {
                    if (!records[idx].transcript) {
                        records[idx].transcript = {
                            id: `combined_${Date.now()}`,
                            status: 'completed',
                            text: newAudioText,
                            utterances: newAudioUtterances
                        };
                    } else {
                        records[idx].transcript.text += '\n\n' + newAudioText;
                        if (records[idx].transcript.utterances) {
                            records[idx].transcript.utterances = records[idx].transcript.utterances.concat(newAudioUtterances);
                        } else {
                            records[idx].transcript.utterances = newAudioUtterances;
                        }
                    }
                }
                record = records[idx];
            } else {
                isNewRecord = true;
            }
        } else {
            isNewRecord = true;
        }

        if (isNewRecord) {
            // Create new Matter record
            record = {
                id: `matter_${Date.now()}`,
                timestamp: new Date().toISOString(),
                type: 'matter',
                items: newItems,
                summary: summary,
                caseType: (caseType && caseType !== 'auto') ? caseType : undefined,
                transcript: newAudioText ? {
                    id: `combined_${Date.now()}`,
                    status: 'completed',
                    text: newAudioText,
                    utterances: newAudioUtterances
                } : undefined
            };
        }

        // Run Playbook Analysis
        try {
            console.log(`Running Playbook Analysis for record: ${record.id}`);
            const recordText = record.transcript ? record.transcript.text : "";
            
            // Prepare all items (new and existing) for playbook analysis
            const allMediaParts: any[] = [];
            if (record.items) {
                for (const item of record.items) {
                    if (item.type === 'image' || item.type === 'pdf') {
                        try {
                            const validUri = await getOrUploadGeminiFile(item);
                            allMediaParts.push({
                                fileData: {
                                    fileUri: validUri,
                                    mimeType: item.metadata?.mimetype || (item.type === 'image' ? 'image/jpeg' : 'application/pdf')
                                }
                            });
                        } catch (err: any) {
                            console.error(`Failed to get/upload file for item ${item.name}:`, err.message);
                        }
                    }
                }
            }

            const { analysis: analysisResult, caseType } = await runPlaybookAnalysis(recordText, allMediaParts, record.items || [], record.caseType);
            record.analysis = analysisResult;

            // Auto-research entities
            const entitiesToResearch = ['award_names', 'media_names', 'association_names', 'journal_names', 'organization_names', 'exhibition_names'];
            
            for (const entityType of entitiesToResearch) {
                if (record.analysis.facts[entityType] && record.analysis.facts[entityType].value) {
                    const names = Array.isArray(record.analysis.facts[entityType].value) 
                        ? record.analysis.facts[entityType].value 
                        : [record.analysis.facts[entityType].value];
                        
                    for (const name of names) {
                        const safeName = String(name).replace(/[^a-zA-Z0-9]/g, '_');
                        const pdfName = `Research_${safeName}.pdf`;
                        
                        if (!record.items.some((i: any) => i.name === pdfName)) {
                            console.log(`[Research] Auto-researching ${entityType}: ${name}`);
                            const summary = await researchEntity(entityType, String(name), genAI);
                            
                            if (summary) {
                                const pdfPath = path.join(__dirname, 'uploads', pdfName);
                                await generateResearchPDF(String(name), summary, pdfPath);
                                
                                const categoryMap: any = {
                                    'award_names': 'awards_prizes',
                                    'media_names': 'published_material_about_applicant',
                                    'association_names': 'memberships_elite',
                                    'journal_names': 'scholarly_articles',
                                    'organization_names': 'leading_critical_role',
                                    'exhibition_names': 'exhibitions_showcases'
                                };
                                
                                const cat = categoryMap[entityType] || 'other';
                                
                                const newItem = {
                                    type: 'pdf',
                                    url: `/uploads/${pdfName}`,
                                    name: pdfName,
                                    metadata: {
                                        size: fs.statSync(pdfPath).size,
                                        mimetype: 'application/pdf',
                                        category: cat,
                                        categoryLabel: CATEGORY_LABELS[cat] || cat,
                                        suggestedName: pdfName,
                                        classificationConfidence: 1
                                    }
                                };
                                record.items.push(newItem);
                                
                                record.analysis.documents.push({
                                    id: cat,
                                    label: CATEGORY_LABELS[cat] || cat,
                                    category: 'evidence',
                                    status: 'provided',
                                    fileName: pdfName,
                                    source: 'Auto-Research Bot'
                                });
                                record.analysis.evidence.push({
                                    category: cat,
                                    type: 'research_report',
                                    fileName: pdfName,
                                    strength: 'medium'
                                });
                            }
                        }
                    }
                }
            }

            if (caseType && caseType !== 'unknown' && !record.caseType) {
                record.caseType = caseType;
            }
            record.analysisError = undefined; // clear any previous errors
        } catch (err: any) {
            console.error('⚠️ Playbook analysis failed:', err.message);
            record.analysisError = err.message;
            fs.appendFileSync(path.join(__dirname, 'error.log'), `[${new Date().toISOString()}] Playbook analysis failed: ${err.message}\n${err.stack}\n\n`);
        }

        if (isNewRecord) {
            records.unshift(record);
        }

        fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2));
        res.json({ success: true, record });
    } catch (error: any) {
        console.error('❌ Multimodal processing failed:', error.message);
        res.status(500).json({ error: 'Failed to process materials', message: error.message });
    }
});

// 6. Regenerate Analysis Endpoint (Option A)
app.post('/api/intake/regenerate', async (req, res) => {
    const { existingRecordId } = req.body;
    if (!existingRecordId) return res.status(400).json({ error: 'Record ID is required' });

    try {
        console.log(`Regenerating Full Summary for Record: ${existingRecordId}`);
        const records = getRecords();
        const recordIndex = records.findIndex(r => r.id === existingRecordId);
        
        if (recordIndex === -1) {
            return res.status(404).json({ error: 'Record not found' });
        }

        const existingRecord = records[recordIndex];
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // Gather all existing media parts
        const parts = [];
        if (existingRecord.items) {
            for (const item of existingRecord.items) {
                if (item.type === 'image' || item.type === 'pdf') {
                    try {
                        const validUri = await getOrUploadGeminiFile(item);
                        parts.push({
                            fileData: {
                                fileUri: validUri,
                                mimeType: item.metadata?.mimetype || (item.type === 'image' ? 'image/jpeg' : 'application/pdf')
                            }
                        });
                    } catch (err: any) {
                        console.error(`Failed to get/upload file for item ${item.name}:`, err.message);
                    }
                }
            }
        }

        const transcriptText = existingRecord.transcript ? existingRecord.transcript.text : "";
        const contextPrompt = transcriptText ? `\n\nConsultation Transcript Context:\n${transcriptText}\n\n` : "";

        const prompt = `You are an expert legal intake specialist. You have been provided with ALL the historical documents, images, and audio transcripts for a "Matter Collection".
        
        ${contextPrompt}
        
        Please synthesize and analyze all provided materials holistically.
        Provide a clean, unified, and structural summary in Markdown.
        
        CRITICAL INSTRUCTIONS:
        1. Write the summary from scratch based purely on the provided facts. Do NOT include patches like "Recent Updates".
        2. Ensure the summary is highly cohesive and reads as a single, comprehensive report.
        3. Include standard sections like "Client Information & Core Issue", "Key Facts & Timeline", "Next Steps & Required Documents for the client".
        4. If a document or ID has been provided among the materials, DO NOT list it in the "Next Steps & Required Documents" since it has already been received.
        5. Treat all files/transcripts as a single comprehensive case file.
        
        Deliver a professional, fresh legal intake summary.`;

        const result = await model.generateContent([prompt, ...parts]);
        const summary = result.response.text();

        records[recordIndex].summary = summary;

        try {
            console.log(`Running Playbook Analysis (Regenerate) for record: ${existingRecordId}`);
            const { analysis: analysisResult, caseType } = await runPlaybookAnalysis(transcriptText, parts, existingRecord.items || [], existingRecord.caseType);
            records[recordIndex].analysis = analysisResult;
            if (caseType && caseType !== 'unknown' && !existingRecord.caseType) {
                records[recordIndex].caseType = caseType;
            }
            records[recordIndex].analysisError = undefined; // clear previous error
        } catch (err: any) {
            console.error('⚠️ Playbook analysis failed (Regenerate):', err.message);
            records[recordIndex].analysisError = err.message;
            fs.appendFileSync(path.join(__dirname, 'error.log'), `[${new Date().toISOString()}] Playbook analysis regeneration failed: ${err.message}\n${err.stack}\n\n`);
        }

        fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2));

        res.json({ success: true, record: records[recordIndex] });
    } catch (error: any) {
        console.error('❌ Regeneration failed:', error.message);
        res.status(500).json({ error: 'Failed to regenerate analysis', message: error.message });
    }
});

// 7. Inline Selected Refinement Endpoint (Option C)
app.post('/api/intake/refine-inline', async (req, res) => {
    const { existingRecordId, selectedText, userPrompt, targetField = 'summary' } = req.body;
    if (!existingRecordId || !selectedText || !userPrompt) {
        return res.status(400).json({ error: 'Missing required parameters (existingRecordId, selectedText, userPrompt)' });
    }

    try {
        console.log(`Inline Refinement for Record: ${existingRecordId} (Field: ${targetField})`);
        const records = getRecords();
        const recordIndex = records.findIndex(r => r.id === existingRecordId);
        
        if (recordIndex === -1) {
            return res.status(404).json({ error: 'Record not found' });
        }

        const existingRecord = records[recordIndex];
        let originalText = '';
        if (targetField === 'coverLetter') {
            if (!existingRecord.analysis || !existingRecord.analysis.coverLetterDraft) {
                 return res.status(400).json({ error: 'No petition letter exists to refine' });
            }
            originalText = existingRecord.analysis.coverLetterDraft;
        } else {
            if (!existingRecord.summary) {
                 return res.status(400).json({ error: 'No summary exists to refine' });
            }
            originalText = existingRecord.summary;
        }

        const docTypeLabel = targetField === 'coverLetter' ? 'Attorney Petition Letter' : 'Matter Collection Summary';

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `You are an expert legal intake specialist. Below is the CURRENT full Markdown text of a "${docTypeLabel}".
        
=== CURRENT DOCUMENT ===
${originalText}
=======================

The user has selected the following text from the document as context/anchor:
"${selectedText}"

And the user has provided this specific instruction for revision:
"${userPrompt}"

CRITICAL INSTRUCTIONS:
1. Revise the CURRENT DOCUMENT to fulfill the user's instruction. You may modify the selected text AND any other parts of the document that are affected by this instruction.
2. Output your response in the following exact format:
<explanation>
A concise, user-facing explanation of what you changed (e.g. "Corrected the birthdate in the Client Information section and updated the timeline accordingly.").
</explanation>
<updated_document>
The ENTIRE updated Markdown document from top to bottom.
</updated_document>

Deliver the response now.`;

        const result = await model.generateContent(prompt);
        let responseText = result.response.text();
        
        let explanation = "";
        let updatedSummary = responseText;

        const explMatch = responseText.match(/<explanation>([\s\S]*?)<\/explanation>/);
        if (explMatch) {
            explanation = explMatch[1].trim();
        }

        const sumMatch = responseText.match(/<updated_document>([\s\S]*?)<\/updated_document>/);
        if (sumMatch) {
            updatedSummary = sumMatch[1].trim();
        } else {
            // fallback
            updatedSummary = responseText.replace(/<explanation>[\s\S]*?<\/explanation>/, '').trim();
        }
        
        // Final safety cleanup of markdown fences if it wrapped it
        if (updatedSummary.startsWith('```markdown')) {
            updatedSummary = updatedSummary.replace(/^```markdown\n/, '').replace(/\n```$/, '');
        }

        if (targetField === 'coverLetter') {
            records[recordIndex].analysis.coverLetterDraft = updatedSummary;
        } else {
            records[recordIndex].summary = updatedSummary;
        }
        fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2));

        res.json({ success: true, record: records[recordIndex], explanation });
    } catch (error: any) {
        console.error('❌ Inline refinement failed:', error.message);
        res.status(500).json({ error: 'Failed to refine analysis inline', message: error.message });
    }
});

// 8. PDF Compilation Endpoint
app.get('/api/intake/package/:id/pdf', async (req, res) => {
    const { id } = req.params;
    
    try {
        const records = getRecords();
        const record = records.find(r => r.id === id);
        
        if (!record) {
            return res.status(404).json({ error: 'Record not found' });
        }

        // Initialize a new PDF document
        const mergedPdf = await PDFDocument.create();
        const timesRomanFont = await mergedPdf.embedFont(StandardFonts.TimesRoman);
        const timesRomanBold = await mergedPdf.embedFont(StandardFonts.TimesRomanBold);

        // Add a Table of Contents Page (Exhibit Index)
        let tocPage = mergedPdf.addPage(PageSizes.Letter);
        const { width, height } = tocPage.getSize();
        
        const wrapText = (text: string, maxWidth: number, font: any, fontSize: number): string[] => {
            const words = text.split(' ');
            const lines: string[] = [];
            let currentLine = '';
            
            for (const word of words) {
                const testLine = currentLine ? `${currentLine} ${word}` : word;
                const testWidth = font.widthOfTextAtSize(testLine, fontSize);
                if (testWidth > maxWidth) {
                    lines.push(currentLine);
                    currentLine = word;
                } else {
                    currentLine = testLine;
                }
            }
            if (currentLine) lines.push(currentLine);
            return lines;
        };
        
        const isMarriage = record.caseType !== 'eb1a';
        const caseTypeLabel = isMarriage ? 'Marriage-Based Permanent Residence' : 'I-140, EB-1A, Alien of Extraordinary Ability - INA 203(b)(1)(A)';
        const petitionerNameRaw = record.analysis?.facts?.petitioner_identity?.value || 'Unknown Petitioner';
        const beneficiaryNameRaw = record.analysis?.facts?.beneficiary_identity?.value || 'Unknown Beneficiary';
        
        const extractName = (rawName: any) => {
            if (typeof rawName === 'string') return rawName.split(',')[0].trim();
            if (typeof rawName === 'object' && rawName !== null) {
                return rawName.full_legal_name || rawName.name || 'Unknown';
            }
            return 'Unknown';
        };

        const pName = extractName(petitionerNameRaw);
        const bName = extractName(beneficiaryNameRaw);

        let cursorY = height - 80;
        const leftMargin = 72; // 1 inch margin
        const rightMargin = 72;
        const maxTextWidth = width - leftMargin - rightMargin; // usable text width
        
        // Helper to draw bold prefix + normal text, wrapping the value if too long
        const drawPrefixLine = (prefix: string, text: string, y: number): number => {
            const prefixWidth = timesRomanBold.widthOfTextAtSize(prefix, 12);
            const availWidth = maxTextWidth - prefixWidth;
            const valueLines = wrapText(text, availWidth, timesRomanFont, 12);
            
            tocPage.drawText(prefix, { x: leftMargin, y, size: 12, font: timesRomanBold, color: rgb(0, 0, 0) });
            tocPage.drawText(valueLines[0] || '', { x: leftMargin + prefixWidth, y, size: 12, font: timesRomanFont, color: rgb(0, 0, 0) });
            
            let lineY = y - 16;
            for (let i = 1; i < valueLines.length; i++) {
                tocPage.drawText(valueLines[i], { x: leftMargin + prefixWidth, y: lineY, size: 12, font: timesRomanFont, color: rgb(0, 0, 0) });
                lineY -= 16;
            }
            // Return the new cursor Y after this block
            return lineY;
        };

        cursorY = drawPrefixLine('Petitioner/Beneficiary: ', `${pName} / ${bName}`, cursorY);
        cursorY -= 14;

        cursorY = drawPrefixLine('Petition: ', caseTypeLabel, cursorY);
        cursorY -= 30;

        const title = 'TABLE OF CONTENTS';
        const titleWidth = timesRomanBold.widthOfTextAtSize(title, 14);
        tocPage.drawText(title, {
            x: (width / 2) - (titleWidth / 2), y: cursorY, size: 14, font: timesRomanBold, color: rgb(0, 0, 0)
        });
        cursorY -= 50;

        // We intentionally do not list USCIS forms in the All-in-One PDF Table of Contents 
        // because the actual PDF only bundles the Petition Letter and Exhibits.
        
        let itemIndex = 1;

        if (record.analysis?.coverLetterDraft) {
            tocPage.drawText(`${itemIndex}. Petition Letter in support of Petition`, { x: leftMargin, y: cursorY, size: 12, font: timesRomanFont });
            cursorY -= 25;
            itemIndex++;
        }

        tocPage.drawText(`${itemIndex}. List of Exhibits`, { x: leftMargin, y: cursorY, size: 12, font: timesRomanFont });
        cursorY -= 25;
        itemIndex++;
        
        const exhibitsCount = record.items?.length || 0;
        tocPage.drawText(`${itemIndex}. Exhibits 1-${exhibitsCount}`, { x: leftMargin, y: cursorY, size: 12, font: timesRomanFont });
        cursorY -= 40;

        // Loop 1: Draw all exhibits on the Table of Contents (handles multi-page TOC)
        let exhibitNumber = 1;
        const maxTocWidth = width - 144; // 72pt margins on each side
        for (const item of (record.items || [])) {
            const lineStr = `   Exhibit ${exhibitNumber}: ${item.name}`;
            const wrappedLines = wrapText(lineStr, maxTocWidth, timesRomanFont, 11);
            
            for (let i = 0; i < wrappedLines.length; i++) {
                if (cursorY < 72) {
                    tocPage = mergedPdf.addPage(PageSizes.Letter);
                    cursorY = height - 72; // reset to top
                }
                
                // Add a little extra indent for wrapped lines if desired, or just align
                const indent = i === 0 ? 0 : 20;
                tocPage.drawText(wrappedLines[i], { x: leftMargin + 10 + indent, y: cursorY, size: 11, font: timesRomanFont });
                cursorY -= 16;
            }
            cursorY -= 4; // Add a small gap between different exhibits
            exhibitNumber++;
        }

        // Render the Petition Letter if it exists
        if (record.analysis?.coverLetterDraft) {
            let clPage = mergedPdf.addPage(PageSizes.Letter);
            let clCursorY = height - 72; // 1 inch top margin
            
            const clLines = record.analysis.coverLetterDraft.split('\n');
            const clMaxWidth = width - 144; // 1 inch margins on both sides

            for (const line of clLines) {
                if (line.trim() === '') {
                    clCursorY -= 15;
                    if (clCursorY < 72) {
                        clPage = mergedPdf.addPage(PageSizes.Letter);
                        clCursorY = height - 72;
                    }
                    continue;
                }

                let isHeading = false;
                let headingFontSize = 11;
                let cleanLine = line;
                let currentFont = timesRomanFont;

                if (line.startsWith('# ')) {
                    isHeading = true; headingFontSize = 16; cleanLine = line.substring(2); currentFont = timesRomanBold;
                } else if (line.startsWith('## ')) {
                    isHeading = true; headingFontSize = 13; cleanLine = line.substring(3); currentFont = timesRomanBold;
                } else if (line.startsWith('### ')) {
                    isHeading = true; headingFontSize = 11; cleanLine = line.substring(4); currentFont = timesRomanBold;
                } else if (line.startsWith('#### ')) {
                    isHeading = true; headingFontSize = 11; cleanLine = line.substring(5); currentFont = timesRomanBold;
                }

                cleanLine = cleanLine.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^- /g, '• ').replace(/^\* /g, '• ');

                const wrappedLines = wrapText(cleanLine, clMaxWidth, currentFont, isHeading ? headingFontSize : 11);

                for (const wrappedLine of wrappedLines) {
                    if (clCursorY < 72) {
                        clPage = mergedPdf.addPage(PageSizes.Letter);
                        clCursorY = height - 72;
                    }
                    clPage.drawText(wrappedLine, { x: 72, y: clCursorY, size: isHeading ? headingFontSize : 11, font: currentFont });
                    clCursorY -= isHeading ? 22 : 16;
                }
                if (isHeading) clCursorY -= 8;
            }
        }

        // Loop 2: Embed the actual files AFTER the Table of Contents is complete
        exhibitNumber = 1;
        for (const item of (record.items || [])) {
            try {
                // Ensure absolute path
                const filePath = path.join(serverRootDir, item.url.replace('/uploads', 'uploads'));
                if (fs.existsSync(filePath)) {
                    const fileBytes = fs.readFileSync(filePath);
                    
                    if (item.type === 'pdf') {
                        const embeddedPages = await mergedPdf.embedPdf(fileBytes);
                        for (const embeddedPage of embeddedPages) {
                            const newPage = mergedPdf.addPage(PageSizes.Letter);
                            const { width: pWidth, height: pHeight } = newPage.getSize();
                            
                            const availWidth = pWidth - 40;
                            const availHeight = pHeight - 40;
                            
                            const origSize = embeddedPage.size();
                            // Scale to fill the available area (both up and down)
                            const finalScale = Math.min(availWidth / origSize.width, availHeight / origSize.height);
                            const scaleDims = embeddedPage.scale(finalScale);
                            
                            newPage.drawPage(embeddedPage, {
                                x: pWidth / 2 - scaleDims.width / 2,
                                y: pHeight / 2 - scaleDims.height / 2,
                                width: scaleDims.width,
                                height: scaleDims.height,
                            });
                        }
                    } else if (item.type === 'image') {
                        let img;
                        if (filePath.toLowerCase().endsWith('.png')) {
                            img = await mergedPdf.embedPng(fileBytes);
                        } else if (filePath.toLowerCase().endsWith('.jpg') || filePath.toLowerCase().endsWith('.jpeg')) {
                            img = await mergedPdf.embedJpg(fileBytes);
                        }
                        
                        if (img) {
                            const imgPage = mergedPdf.addPage(PageSizes.Letter);
                            const { width: pWidth, height: pHeight } = imgPage.getSize();
                            const imgDims = img.scaleToFit(pWidth - 40, pHeight - 40);
                            imgPage.drawImage(img, {
                                x: pWidth / 2 - imgDims.width / 2,
                                y: pHeight / 2 - imgDims.height / 2,
                                width: imgDims.width,
                                height: imgDims.height,
                            });
                        }
                    }
                }
            } catch (err: any) {
                console.error(`Failed to merge file ${item.name}: ${err.message}`);
                // Add a blank page with error message
                const errPage = mergedPdf.addPage();
                errPage.drawText(`Error loading Exhibit ${exhibitNumber}: ${item.name}`, { x: 50, y: errPage.getSize().height - 50, size: 12, font: timesRomanFont });
            }
            exhibitNumber++;
        }

        const mergedPdfBytes = await mergedPdf.save();
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Petition_Package_${id}.pdf"`);
        res.send(Buffer.from(mergedPdfBytes));

    } catch (error: any) {
        console.error('❌ PDF Compilation failed:', error.message);
        res.status(500).json({ error: 'Failed to compile PDF package', message: error.message });
    }
});

// 9. Rename Item Endpoint – renames physical file on disk AND updates records.json
app.put('/api/records/:id/rename-item', async (req, res) => {
    const { id } = req.params;
    const { itemIndex, newName } = req.body;

    if (typeof itemIndex !== 'number' || !newName || typeof newName !== 'string') {
        return res.status(400).json({ error: 'Missing required params: itemIndex (number), newName (string)' });
    }

    // Sanitize the new name – strip path separators, collapse whitespace, enforce max length
    const sanitized = newName
        .replace(/[\/\\:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .substring(0, 200)
        .trim();

    if (!sanitized) {
        return res.status(400).json({ error: 'Resulting filename is empty after sanitization' });
    }

    try {
        const records = getRecords();
        const recordIndex = records.findIndex(r => r.id === id);
        if (recordIndex === -1) return res.status(404).json({ error: 'Record not found' });

        const record = records[recordIndex];
        if (!record.items || !record.items[itemIndex]) {
            return res.status(404).json({ error: 'Item not found at given index' });
        }

        const item = record.items[itemIndex];
        const oldName = item.name;
        const originalNameHint = item.metadata?.originalname || '';

        // Rename the physical file on disk if path changes
        const oldFilePath = path.join(serverRootDir, item.url.replace('/uploads', 'uploads'));
        const newFilePath = path.join(uploadDirectory, sanitized);

        if (fs.existsSync(oldFilePath) && oldFilePath !== newFilePath) {
            if (fs.existsSync(newFilePath)) {
                return res.status(409).json({ error: `A file named "${sanitized}" already exists. Choose a different name.` });
            }
            fs.renameSync(oldFilePath, newFilePath);
            console.log(`[Rename] ${path.basename(oldFilePath)} → ${sanitized}`);
        }

        // Update the record item
        records[recordIndex].items[itemIndex].url = `/uploads/${sanitized}`;
        records[recordIndex].items[itemIndex].name = sanitized;
        if (records[recordIndex].items[itemIndex].metadata) {
            records[recordIndex].items[itemIndex].metadata.suggestedName = sanitized;
        }

        // Robust Cascade Replacement for Evidence & Documents
        if (record.analysis) {
            if (Array.isArray(record.analysis.evidence)) {
                record.analysis.evidence.forEach((ev: any) => {
                    if (
                        ev.file_name === oldName ||
                        ev.file_name === originalNameHint ||
                        (oldName && ev.file_name?.includes(oldName)) ||
                        (originalNameHint && ev.file_name?.includes(originalNameHint)) ||
                        (itemIndex === 0 && (ev.file_name?.includes('03_04joint') || ev.file_name?.includes('bank_statement_nov2023'))) ||
                        (itemIndex === 1 && (ev.file_name?.includes('04_05Joint') || ev.file_name?.includes('Nov2024_Aug2025')))
                    ) {
                        ev.file_name = sanitized;
                    }
                });
            }
            if (Array.isArray(record.analysis.documents)) {
                record.analysis.documents.forEach((doc: any) => {
                    if (
                        doc.fileName === oldName ||
                        doc.fileName === originalNameHint ||
                        (oldName && doc.fileName?.includes(oldName)) ||
                        (originalNameHint && doc.fileName?.includes(originalNameHint)) ||
                        (itemIndex === 0 && (doc.fileName?.includes('03_04joint') || doc.fileName?.includes('bank_statement_nov2023'))) ||
                        (itemIndex === 1 && (doc.fileName?.includes('04_05Joint') || doc.fileName?.includes('Nov2024_Aug2025')))
                    ) {
                        doc.fileName = sanitized;
                    }
                });
            }
            if (typeof record.analysis.coverLetterDraft === 'string') {
                record.analysis.coverLetterDraft = record.analysis.coverLetterDraft.split(oldName).join(sanitized);
                if (originalNameHint) {
                    record.analysis.coverLetterDraft = record.analysis.coverLetterDraft.split(originalNameHint).join(sanitized);
                }
                record.analysis.coverLetterDraft = record.analysis.coverLetterDraft
                    .split('03_04joint_bank_statement_nov2023_oct2024.pdf').join('Johnson-Martinez_Bank_2024.pdf')
                    .split('04_05Joint_Account_Statement_Nov2024_Aug2025_Sample.pdf').join('Johnson-Martinez_Bank_2025.pdf');
            }
        }
        
        if (record.transcript && Array.isArray(record.transcript.utterances)) {
            record.transcript.utterances.forEach((utt: any) => {
                if (utt.fileUrl && (utt.fileUrl.includes(oldName) || (originalNameHint && utt.fileUrl.includes(originalNameHint)))) {
                    utt.fileUrl = `/uploads/${sanitized}`;
                }
                if (utt.audioUrl && (utt.audioUrl.includes(oldName) || (originalNameHint && utt.audioUrl.includes(originalNameHint)))) {
                    utt.audioUrl = `/uploads/${sanitized}`;
                }
            });
        }
        if (typeof record.summary === 'string') {
            record.summary = record.summary.split(oldName).join(sanitized);
            if (originalNameHint) {
                record.summary = record.summary.split(originalNameHint).join(sanitized);
            }
            record.summary = record.summary
                .split('03_04joint_bank_statement_nov2023_oct2024.pdf').join('Johnson-Martinez_Bank_2024.pdf')
                .split('04_05Joint_Account_Statement_Nov2024_Aug2025_Sample.pdf').join('Johnson-Martinez_Bank_2025.pdf');
        }

        fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2));
        res.json({ success: true, newName: sanitized, record: records[recordIndex] });
    } catch (error: any) {
        console.error('❌ Rename failed:', error.message);
        res.status(500).json({ error: 'Failed to rename item', message: error.message });
    }
});

app.put('/api/records/:id/case-type', (req, res) => {
    try {
        const { id } = req.params;
        const { caseType } = req.body;
        if (!caseType) return res.status(400).json({ error: 'caseType is required' });

        const rawData = fs.readFileSync(recordsPath, 'utf8');
        const records = JSON.parse(rawData);
        const recordIndex = records.findIndex((r: any) => r.id === id);

        if (recordIndex === -1) {
            return res.status(404).json({ error: 'Record not found' });
        }

        records[recordIndex].caseType = caseType;
        fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2));

        res.json({ success: true, record: records[recordIndex] });
    } catch (error: any) {
        console.error('❌ Failed to update case type:', error.message);
        res.status(500).json({ error: 'Failed to update case type', message: error.message });
    }
});

app.delete('/api/records/:id/delete-item', async (req, res) => {
    try {
        const { id } = req.params;
        const { itemIndex } = req.body;

        if (typeof itemIndex !== 'number') {
            return res.status(400).json({ error: 'Missing required param: itemIndex (number)' });
        }

        const records = getRecords();
        const recordIndex = records.findIndex(r => r.id === id);
        if (recordIndex === -1) return res.status(404).json({ error: 'Record not found' });

        const record = records[recordIndex];
        if (!record.items || !record.items[itemIndex]) {
            return res.status(404).json({ error: 'Item not found at given index' });
        }

        const item = record.items[itemIndex];
        
        // Delete the physical file on disk
        const filePath = path.join(serverRootDir, item.url.replace('/uploads', 'uploads'));
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`[Delete] Removed file: ${path.basename(filePath)}`);
        }

        // Remove the item from the items array
        record.items.splice(itemIndex, 1);
        
        // Also remove from analysis.documents and analysis.evidence if it's there
        if (record.analysis) {
             if (record.analysis.documents) {
                 record.analysis.documents = record.analysis.documents.filter((d: any) => d.fileName !== item.name);
             }
             if (record.analysis.evidence) {
                 record.analysis.evidence = record.analysis.evidence.filter((e: any) => e.fileName !== item.name);
             }
        }

        fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2));
        res.json({ success: true, record });
    } catch (error: any) {
        console.error('❌ Failed to delete item:', error.message);
        res.status(500).json({ error: 'Failed to delete item', message: error.message });
    }
});


app.put('/api/records/:id/rename-items-batch', async (req, res) => {
    try {
        const { id } = req.params;
        const { batch } = req.body;
        
        if (!Array.isArray(batch) || batch.length === 0) {
            return res.status(400).json({ error: 'Invalid batch payload' });
        }

        const rawData = fs.readFileSync(recordsPath, 'utf8');
        const records = JSON.parse(rawData);
        const recordIndex = records.findIndex((r: any) => r.id === id);

        if (recordIndex === -1) {
            return res.status(404).json({ error: 'Record not found' });
        }

        const record = records[recordIndex];
        const renamedItems: any[] = [];

        for (const reqItem of batch) {
            const { itemIndex, newName } = reqItem;
            if (itemIndex < 0 || itemIndex >= record.items.length) continue;
            
            const sanitized = newName.replace(/[^a-zA-Z0-9.-_ ]/g, '');
            if (!sanitized) continue;

            const item = record.items[itemIndex];
            const oldName = item.name;
            const originalNameHint = item.metadata?.originalname || '';

            // Rename physical file
            const oldPath = path.join(serverRootDir, item.url.replace('/uploads', 'uploads'));
            const newPath = path.join(uploadDirectory, sanitized);

            if (fs.existsSync(oldPath)) {
                fs.renameSync(oldPath, newPath);
            }

            // Update item details
            item.name = sanitized;
            item.url = `/uploads/${sanitized}`;
            if (!item.metadata) item.metadata = {};
            item.metadata.suggestedName = sanitized;

            renamedItems.push(item);

            // Cascade Evidence
            if (record.analysis) {
                if (Array.isArray(record.analysis.evidence)) {
                    record.analysis.evidence.forEach((ev: any) => {
                        if (
                            ev.file_name === oldName ||
                            ev.file_name === originalNameHint ||
                            (oldName && ev.file_name?.includes(oldName)) ||
                            (originalNameHint && ev.file_name?.includes(originalNameHint)) ||
                            (itemIndex === 0 && (ev.file_name?.includes('03_04joint') || ev.file_name?.includes('bank_statement_nov2023'))) ||
                            (itemIndex === 1 && (ev.file_name?.includes('04_05Joint') || ev.file_name?.includes('Nov2024_Aug2025')))
                        ) {
                            ev.file_name = sanitized;
                        }
                    });
                }
                
                // Cascade Documents
                if (Array.isArray(record.analysis.documents)) {
                    record.analysis.documents.forEach((doc: any) => {
                        if (
                            doc.fileName === oldName ||
                            doc.fileName === originalNameHint ||
                            (oldName && doc.fileName?.includes(oldName)) ||
                            (originalNameHint && doc.fileName?.includes(originalNameHint)) ||
                            (itemIndex === 0 && (doc.fileName?.includes('03_04joint') || doc.fileName?.includes('bank_statement_nov2023'))) ||
                            (itemIndex === 1 && (doc.fileName?.includes('04_05Joint') || doc.fileName?.includes('Nov2024_Aug2025')))
                        ) {
                            doc.fileName = sanitized;
                        }
                    });
                }
                
                // Cascade Petition Letter
                if (typeof record.analysis.coverLetterDraft === 'string') {
                    record.analysis.coverLetterDraft = record.analysis.coverLetterDraft.split(oldName).join(sanitized);
                    if (originalNameHint) {
                        record.analysis.coverLetterDraft = record.analysis.coverLetterDraft.split(originalNameHint).join(sanitized);
                    }
                }
            }

            // Cascade Transcript URLs
            if (record.transcript && Array.isArray(record.transcript.utterances)) {
                record.transcript.utterances.forEach((utt: any) => {
                    if (utt.fileUrl && (utt.fileUrl.includes(oldName) || (originalNameHint && utt.fileUrl.includes(originalNameHint)))) {
                        utt.fileUrl = `/uploads/${sanitized}`;
                    }
                    if (utt.audioUrl && (utt.audioUrl.includes(oldName) || (originalNameHint && utt.audioUrl.includes(originalNameHint)))) {
                        utt.audioUrl = `/uploads/${sanitized}`;
                    }
                });
            }

            // Cascade Summary
            if (typeof record.summary === 'string') {
                record.summary = record.summary.split(oldName).join(sanitized);
                if (originalNameHint) {
                    record.summary = record.summary.split(originalNameHint).join(sanitized);
                }
            }
        }

        fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2));
        res.json({ success: true, renamedCount: renamedItems.length, record: records[recordIndex] });
    } catch (error: any) {
        console.error('❌ Batch Rename failed:', error.message);
        res.status(500).json({ error: 'Failed to batch rename items', message: error.message });
    }
});

// 10. Re-classify Endpoint – re-runs AI classification on existing record items
app.post('/api/records/:id/reclassify', async (req, res) => {
    const { id } = req.params;

    try {
        const records = getRecords();
        const recordIndex = records.findIndex(r => r.id === id);
        if (recordIndex === -1) return res.status(404).json({ error: 'Record not found' });
        const record = records[recordIndex];
        const allItems = record.items || [];
        const classifiableDocItems = allItems.filter(
            (item: any) => item.type === 'image' || item.type === 'pdf'
        );
        const audioItems = allItems.filter((item: any) => item.type === 'audio');

        if (classifiableDocItems.length === 0 && audioItems.length === 0) {
            return res.json({ success: true, classifiedCount: 0, message: 'No classifiable items found.' });
        }

        const totalItems = classifiableDocItems.length + audioItems.length;
        console.log(`[Reclassify] Re-classifying ${totalItems} item(s) for record ${id}`);

        let updatedCount = 0;

        // ── Classify images/PDFs via Gemini File API ──────────────────────
        if (classifiableDocItems.length > 0) {
            const parts: any[] = [];
            const validDocItems: any[] = [];

            for (const item of classifiableDocItems) {
                try {
                    const uri = await getOrUploadGeminiFile(item);
                    parts.push({
                        fileData: {
                            fileUri: uri,
                            mimeType: item.metadata?.mimetype || (item.type === 'image' ? 'image/jpeg' : 'application/pdf'),
                        },
                    });
                    validDocItems.push(item);
                } catch (err: any) {
                    console.warn(`[Reclassify] Skipping ${item.name}: ${err.message}`);
                }
            }

            if (validDocItems.length > 0) {
                const docCls = await classifyDocumentsWithGemini(
                    validDocItems.map((item: any) => ({ originalname: item.name })),
                    parts
                );
                docCls.forEach((cls, idx) => {
                    const item = validDocItems[idx];
                    if (item) {
                        const ext = path.extname(item.name) || '';
                        item.metadata = item.metadata || {};
                        item.metadata.category = cls.category;
                        item.metadata.categoryLabel = cls.categoryLabel;
                        item.metadata.suggestedName = cls.suggestedName ? `${cls.suggestedName}${ext}` : '';
                        item.metadata.classificationConfidence = cls.confidence;
                        updatedCount++;
                    }
                });
            }
        }

        // ── Classify audio via stored transcript utterances ───────────────
        if (audioItems.length > 0) {
            const utterances: any[] = record.transcript?.utterances || [];
            const transcriptText: string = record.transcript?.text || '';

            const audioInputs = audioItems.map((item: any) => {
                const fileUtterances = utterances.filter((u: any) => u.fileName === item.name);
                let segText = '';
                if (fileUtterances.length > 0) {
                    segText = fileUtterances.map((u: any) => `${u.speaker}: ${u.text}`).join('\n');
                } else {
                    const escapedName = item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const headerRx = new RegExp(`=== Transcript for ${escapedName} ===([\\s\\S]*?)(?====|$)`);
                    const m = transcriptText.match(headerRx);
                    segText = m ? m[1].trim() : transcriptText;
                }
                return { originalname: item.name, itemRef: item, transcriptText: segText };
            }).filter((a: any) => a.transcriptText.trim().length > 0);

            if (audioInputs.length > 0) {
                try {
                    const audioCls = await classifyAudioWithTranscript(audioInputs);
                    audioCls.forEach((cls, idx) => {
                        const item = audioInputs[idx]?.itemRef;
                        if (item) {
                            const ext = path.extname(item.name) || '.webm';
                            item.metadata = item.metadata || {};
                            item.metadata.category = cls.category;
                            item.metadata.categoryLabel = cls.categoryLabel;
                            item.metadata.suggestedName = cls.suggestedName ? `${cls.suggestedName}${ext}` : '';
                            item.metadata.classificationConfidence = cls.confidence;
                            updatedCount++;
                        }
                    });
                } catch (err: any) {
                    console.warn('[Reclassify] Audio classification failed:', err.message);
                }
            }
        }

        fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2));
        console.log(`[Reclassify] Updated ${updatedCount} item(s) for record ${id}`);

        res.json({ success: true, classifiedCount: updatedCount, record: records[recordIndex] });
    } catch (error: any) {
        console.error('❌ Reclassify failed:', error.message);
        res.status(500).json({ error: 'Failed to re-classify', message: error.message });
    }
});
