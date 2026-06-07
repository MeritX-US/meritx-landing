import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { AssemblyAI } from 'assemblyai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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
            recordingSid: undefined
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

/**
 * START SERVER
 */
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

// 5. Multimodal Matter Ingestion Endpoint

app.post('/api/intake/process', upload.array('files'), async (req, res) => {
    const files = req.files as Express.Multer.File[];
    const { existingRecordId } = req.body;

    if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files provided' });
    }

    try {
        console.log(`Processing Multimodal Intake: ${files.length} files. Target Collection: ${existingRecordId || 'New'}`);

        let existingRecord: any = null;

        // Compute hash for all uploaded files
        const filesWithHash = files.map(file => {
            const fileBuffer = fs.readFileSync(file.path);
            const hashSum = crypto.createHash('sha256');
            hashSum.update(fileBuffer);
            const hash = hashSum.digest('hex');
            return { ...file, hash };
        });

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

        // Prepare media for Gemini (only non-audio files)
        const parts = await Promise.all(imagePdfFiles.map(async (file) => {
            const data = fs.readFileSync(file.path);
            const mimeType = file.mimetype;

            return {
                inlineData: {
                    data: data.toString('base64'),
                    mimeType
                }
            };
        }));

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

        // Create item objects for the record
        const newItems = validFiles.map(file => ({
            type: file.mimetype.startsWith('image/') ? 'image' : file.mimetype.startsWith('audio/') ? 'audio' : 'pdf',
            url: `/uploads/${path.basename(file.path)}`,
            name: file.originalname,
            metadata: { size: file.size, mimetype: file.mimetype, hash: file.hash }
        }));

        const records = getRecords();
        let record;

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
                
                fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2));
                record = records[idx];
            } else {
                // Fallback: record not found, create new
                record = {
                    id: `matter_${Date.now()}`,
                    timestamp: new Date().toISOString(),
                    type: 'matter',
                    items: newItems,
                    summary: summary,
                    transcript: newAudioText ? {
                        id: `combined_${Date.now()}`,
                        status: 'completed',
                        text: newAudioText,
                        utterances: newAudioUtterances
                    } : undefined
                };
                saveRecord(record);
            }
        } else {
            // Create new Matter record
            record = {
                id: `matter_${Date.now()}`,
                timestamp: new Date().toISOString(),
                type: 'matter',
                items: newItems,
                summary: summary,
                transcript: newAudioText ? {
                    id: `combined_${Date.now()}`,
                    status: 'completed',
                    text: newAudioText,
                    utterances: newAudioUtterances
                } : undefined
            };
            saveRecord(record);
        }

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
                    const filePath = path.join(__dirname, item.url.replace('/uploads', 'uploads'));
                    if (fs.existsSync(filePath)) {
                        const data = fs.readFileSync(filePath);
                        parts.push({
                            inlineData: {
                                data: data.toString('base64'),
                                mimeType: item.metadata?.mimetype || (item.type === 'image' ? 'image/jpeg' : 'application/pdf')
                            }
                        });
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
        fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2));

        res.json({ success: true, record: records[recordIndex] });
    } catch (error: any) {
        console.error('❌ Regeneration failed:', error.message);
        res.status(500).json({ error: 'Failed to regenerate analysis', message: error.message });
    }
});
