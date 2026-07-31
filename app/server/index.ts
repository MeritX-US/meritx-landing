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

async function runAutoResearchForRecord(record: any, targetEntities: { type: string, name: string }[], genAI: any) {
    if (!record.analysis || !record.analysis.facts) return;
    
    for (const target of targetEntities) {
        const entityType = target.type;
        const name = target.name;
        
        const safeName = String(name).replace(/[^a-zA-Z0-9]/g, '_');
        const pdfName = `Research_${safeName}.pdf`;
        
        if (!record.items.some((i: any) => i.name === pdfName)) {
            console.log(`[Research] Auto-researching ${entityType}: ${name}`);
            const summary = await researchEntity(entityType, String(name), genAI);
            
            if (summary) {
                const pdfPath = path.join(uploadDirectory, pdfName);
                await generateResearchPDF(String(name), summary, pdfPath);
                
                const categoryMap: any = {
                    'award_names': 'awards_prizes',
                    'media_names': 'published_material_about_applicant',
                    'association_names': 'memberships_elite',
                    'journal_names': 'scholarly_articles',
                    'organization_names': 'leading_critical_role',
                    'exhibition_names': 'exhibitions_showcases',
                    'paper_names': 'scholarly_articles'
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
                
                if (!record.analysis.documents) record.analysis.documents = [];
                record.analysis.documents.push({
                    id: cat,
                    label: CATEGORY_LABELS[cat] || cat,
                    category: 'evidence',
                    status: 'provided',
                    fileName: pdfName,
                    source: 'Auto-Research Bot'
                });
                
                if (!record.analysis.evidence) record.analysis.evidence = [];
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

// records.json is multiple MB (grows with every uploaded transcript/analysis) - re-reading and
// JSON.parse-ing it from disk on every single request (which is what happened before this cache)
// cost ~45ms per call before any actual work started, on top of the same cost again on every
// save. Since every getRecords() caller already mutates objects from the returned array in place
// and then persists that same array, keeping one cached array in memory for the process lifetime
// is safe: in-place mutations are visible to every other caller immediately, with no risk of the
// cache drifting from what callers already hold a reference to.
let recordsCache: any[] | null = null;

const getRecords = (): any[] => {
    if (recordsCache) return recordsCache;
    try {
        if (!fs.existsSync(recordsPath)) {
            recordsCache = [];
            fs.writeFileSync(recordsPath, JSON.stringify([]));
            return recordsCache;
        }
        const data = fs.readFileSync(recordsPath, 'utf8');
        recordsCache = JSON.parse(data);
        return recordsCache!;
    } catch (err) {
        console.error('Error reading records.json:', err);
        return [];
    }
};

// Updates the in-memory cache synchronously (so subsequent getRecords() calls in the same or a
// later request see the change immediately) and writes to disk in the background. The write no
// longer blocks the Node event loop - previously every save (including a single Yes/No toggle
// click on the autofill review table) did a synchronous multi-MB file write that stalled every
// other in-flight request on the server until it finished.
const saveRecords = (records: any[]) => {
    recordsCache = records;
    fs.writeFile(recordsPath, JSON.stringify(records, null, 2), (err) => {
        if (err) console.error('Error saving records.json:', err);
    });
};

const saveRecord = (record: any) => {
    try {
        const records = getRecords();
        records.unshift(record); // Add to beginning
        saveRecords(records);
    } catch (err) {
        console.error('Error saving record:', err);
    }
};

const deleteRecord = (id: string) => {
    try {
        const records = getRecords();
        const filtered = records.filter(r => r.id !== id);
        saveRecords(filtered);
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
 * PLAYBOOK CONFIGURATION ENDPOINTS
 */
app.get('/api/playbooks', (req, res) => {
    try {
        const playbooksDir = path.join(serverRootDir, 'playbooks');
        if (!fs.existsSync(playbooksDir)) {
            return res.json([]);
        }
        const files = fs.readdirSync(playbooksDir).filter(f => f.endsWith('.json'));
        const playbooks = files.map(file => {
            const content = fs.readFileSync(path.join(playbooksDir, file), 'utf8');
            const data = JSON.parse(content);
            return {
                id: file.replace('.json', ''),
                name: data.metadata?.title || file,
                description: data.metadata?.description || '',
                case_type: data.case_type || 'eb1a'
            };
        });
        res.json(playbooks);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to list playbooks' });
    }
});

app.get('/api/playbook/:id', (req, res) => {
    try {
        const playbooksDir = path.join(serverRootDir, 'playbooks');
        const filePath = path.join(playbooksDir, `${req.params.id}.json`);
        // Basic path traversal prevention
        if (filePath.indexOf(playbooksDir) !== 0 || !fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Playbook not found' });
        }
        const content = fs.readFileSync(filePath, 'utf8');
        res.json(JSON.parse(content));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to read playbook' });
    }
});

app.put('/api/playbook/:id', (req, res) => {
    try {
        const playbooksDir = path.join(serverRootDir, 'playbooks');
        const filePath = path.join(playbooksDir, `${req.params.id}.json`);
        if (filePath.indexOf(playbooksDir) !== 0) {
            return res.status(403).json({ error: 'Invalid path' });
        }
        
        const updatedData = req.body;

        // If setting this playbook as default, unset is_default on all other playbooks of the same case_type
        if (updatedData.is_default && updatedData.case_type) {
            const targetCaseType = (updatedData.case_type || '').toLowerCase();
            const files = fs.readdirSync(playbooksDir).filter(f => f.endsWith('.json') && f !== `${req.params.id}.json`);
            files.forEach(file => {
                try {
                    const fileP = path.join(playbooksDir, file);
                    const content = fs.readFileSync(fileP, 'utf8');
                    const parsed = JSON.parse(content);
                    if ((parsed.case_type || '').toLowerCase() === targetCaseType && parsed.is_default) {
                        parsed.is_default = false;
                        fs.writeFileSync(fileP, JSON.stringify(parsed, null, 2), 'utf8');
                    }
                } catch (e) {
                    // ignore
                }
            });
        }

        fs.writeFileSync(filePath, JSON.stringify(updatedData, null, 2), 'utf8');
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update playbook' });
    }
});

app.delete('/api/playbook/:id', (req, res) => {
    try {
        const playbooksDir = path.join(serverRootDir, 'playbooks');
        const filePath = path.join(playbooksDir, `${req.params.id}.json`);
        if (filePath.indexOf(playbooksDir) !== 0) {
            return res.status(403).json({ error: 'Invalid path' });
        }
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Playbook not found' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete playbook' });
    }
});

app.post('/api/playbook/create', async (req, res) => {
    try {
        const { id, title, cloneFromId, prompt } = req.body;
        const playbooksDir = path.join(serverRootDir, 'playbooks');
        
        let cleanId = id ? String(id).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') : '';
        if (!cleanId) {
            cleanId = cloneFromId ? `${cloneFromId}_copy_${Date.now()}` : `custom_pb_${Date.now()}`;
        }

        let newPlaybook: any = {};

        if (cloneFromId) {
            const sourcePath = path.join(playbooksDir, `${cloneFromId}.json`);
            if (fs.existsSync(sourcePath)) {
                const sourceContent = fs.readFileSync(sourcePath, 'utf8');
                newPlaybook = JSON.parse(sourceContent);
            }
            newPlaybook.playbook_id = cleanId;
            newPlaybook.is_default = false;
            newPlaybook.metadata = {
                title: title || `${newPlaybook.metadata?.title || cloneFromId} (Copy)`,
                description: `Playbook cloned from ${cloneFromId}`
            };
        } else if (prompt) {
            console.log("=== [Create Playbook AI] Start ===");
            console.log("[Create Playbook AI] User Prompt:", prompt);
            
            const baseTemplatePath = path.join(playbooksDir, 'eb1a_v1.json');
            let baseData: any = {};
            if (fs.existsSync(baseTemplatePath)) {
                baseData = JSON.parse(fs.readFileSync(baseTemplatePath, 'utf8'));
            }

            const systemInstruction = `You are an AI Playbook creator for immigration lawyers.
Receiving a user prompt to create a new Playbook for a specific visa type or case category.
Generate a JSON object containing:
1. "playbook_id": clean snake_case ID (e.g. "o1a_v1" or "h1b_v1")
2. "metadata": { "title": "Display Title", "description": "Short description" }
3. "case_type": "Visa Category Code"
4. "evidence_map": Relevant criteria/category structure tailored to this visa
5. "escalation_flags": Critical & Warning risk flags tailored to this visa

Return ONLY raw JSON object. Do not include markdown code blocks.`;

            console.log("[Create Playbook AI] Calling Gemini 2.5 Flash...");
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction });
            const result = await model.generateContent(`User Request: ${prompt}\n\nReference Structure:\n${JSON.stringify({ case_type: 'EB-1A', evidence_map: baseData.evidence_map, escalation_flags: baseData.escalation_flags }, null, 2)}`);
            
            console.log("[Create Playbook AI] Gemini responded successfully.");
            const rawText = result.response.text();
            const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
            
            try {
                const aiGenerated = JSON.parse(cleanJson);
                newPlaybook = { ...baseData, ...aiGenerated };
                if (aiGenerated.playbook_id) cleanId = aiGenerated.playbook_id;
                newPlaybook.playbook_id = cleanId;
            } catch (pErr) {
                console.error("[Create Playbook AI] JSON Parse error, falling back to base template");
                newPlaybook = { ...baseData, playbook_id: cleanId, metadata: { title: prompt, description: prompt } };
            }
        }

        const finalPath = path.join(playbooksDir, `${cleanId}.json`);
        fs.writeFileSync(finalPath, JSON.stringify(newPlaybook, null, 2), 'utf8');
        res.json({ success: true, id: cleanId, playbook: newPlaybook });
    } catch (err: any) {
        console.error("Create Playbook Error:", err);
        res.status(500).json({ error: 'Failed to create playbook', details: err?.message });
    }
});

app.post('/api/playbook/simulate', async (req, res) => {
    try {
        const { playbook, sampleFacts } = req.body;
        console.log("=== [Simulate Playbook] Start ===");
        console.log("[Simulate Playbook] Client Facts:", sampleFacts);

        const systemInstruction = `You are an AI Immigration Case Audit Engine.
Analyze the provided client facts against the provided Playbook rules (evidence_map, escalation_flags, cover_letter_template).
Generate a JSON object with:
1. "triggered_flags": array of objects [{ "severity": "critical"|"warning", "rule": "short reason why triggered" }]
2. "evidence_passed": array of satisfied category names
3. "petition_draft_preview": a realistic 2-paragraph excerpt of the legal argument Cover Letter for this client.

Return ONLY valid raw JSON object. Do not include markdown code blocks.`;

        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction });
        const result = await model.generateContent(`Playbook Title: ${playbook.metadata?.title || playbook.playbook_id}\nPlaybook Subset: ${JSON.stringify({ evidence_map: playbook.evidence_map, escalation_flags: playbook.escalation_flags, cover_letter_template: playbook.cover_letter_template?.slice(0, 500) })}\n\nClient Facts: ${JSON.stringify(sampleFacts)}`);
        const rawText = result.response.text();
        const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        const simData = JSON.parse(cleanJson);
        res.json({ success: true, ...simData });
    } catch (err: any) {
        console.error("Simulation error:", err);
        res.status(500).json({ error: "Failed simulation", details: err?.message });
    }
});

app.post('/api/playbook/copilot', async (req, res) => {
    console.log("=== [Copilot] Received request ===");
    try {
        const { prompt, currentPlaybook } = req.body;
        console.log("[Copilot] User Prompt:", prompt);
        console.log("[Copilot] Playbook ID:", currentPlaybook?.playbook_id);
        
        const systemInstruction = `You are an AI Playbook configuration assistant for immigration lawyers. 
You will receive a JSON playbook and a user request. 
Determine which top-level keys in the Playbook JSON need to be modified to fulfill the request.
Return ONLY a JSON object containing the modified keys and their full updated values. 
For example, if adding a risk flag, return { "escalation_flags": [ ...all existing flags + new flag... ] }.
If modifying evidence, return { "evidence_map": { ...all existing evidence + modified... } }.
Do not return the entire playbook, only the keys that changed.
Do not include markdown code blocks, just the raw JSON object string.`;
        
        console.log("[Copilot] Preparing slim context (evidence_map & escalation_flags)...");
        const slimContext = {
            playbook_id: currentPlaybook.playbook_id,
            case_type: currentPlaybook.case_type,
            evidence_map: currentPlaybook.evidence_map,
            escalation_flags: currentPlaybook.escalation_flags
        };

        console.log("[Copilot] Calling Gemini 2.5 Flash...");
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction });
        const result = await model.generateContent(`User Request: ${prompt}\n\nCurrent Playbook Subset:\n${JSON.stringify(slimContext, null, 2)}`);
        
        console.log("[Copilot] Gemini responded.");
        const rawText = result.response.text();
        console.log("[Copilot] Raw response snippet:", rawText.slice(0, 100));
        const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        
        const partialUpdate = JSON.parse(cleanJson);
        const updatedPlaybook = { ...currentPlaybook, ...partialUpdate };
        console.log("[Copilot] Successfully merged update.");
        res.json({ updatedPlaybook });
    } catch (err: any) {
        console.error("=== [Copilot Error] ===", err);
        res.status(500).json({ error: 'Failed to process copilot request', details: err?.message });
    }
});

app.post('/api/playbook/feedback-loop', async (req, res) => {
    console.log("=== [Feedback Loop] Received request ===");
    try {
        const { playbookId, refinePrompt, caseFacts, editedText, rfeText } = req.body;
        console.log("[Feedback Loop] Target Playbook ID:", playbookId);
        console.log("[Feedback Loop] Refine Prompt / Notes:", refinePrompt);

        const playbooksDir = path.join(serverRootDir, 'playbooks');
        let targetFile = `${playbookId || 'eb1a_v1'}.json`;
        let filePath = path.join(playbooksDir, targetFile);

        if (!fs.existsSync(filePath)) {
            const files = fs.readdirSync(playbooksDir).filter(f => f.endsWith('.json'));
            const matched = files.find(f => f.toLowerCase().includes((playbookId || '').toLowerCase()));
            if (matched) {
                filePath = path.join(playbooksDir, matched);
            } else {
                filePath = path.join(playbooksDir, 'eb1a_v1.json');
            }
        }

        const currentPlaybook = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        const systemInstruction = `You are an AI Immigration Playbook Optimizer.
Translate attorney feedback into JSON updates for:
- 'evidence_map': missing docs/criteria
- 'escalation_flags': risk flags
- 'required_facts': intake facts
Return JSON: { "summary": "1 sentence explanation", "suggested_changes": { modified keys only } }`;

        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction, generationConfig: { responseMimeType: "application/json" } });
        const slimContext = {
            playbook_id: currentPlaybook.playbook_id,
            case_type: currentPlaybook.case_type,
            evidence_categories: Object.keys(currentPlaybook.evidence_map || {}),
            existing_flags: (currentPlaybook.escalation_flags || []).map((f: any) => f.id || f.label)
        };

        const result = await model.generateContent(`Playbook: ${currentPlaybook.playbook_id}\nFeedback: ${refinePrompt}\nContext: ${JSON.stringify(slimContext)}`);
        const rawText = result.response.text();
        const parsed = JSON.parse(rawText);

        const updatedPlaybook = {
            ...currentPlaybook,
            ...(parsed.suggested_changes || parsed.updated_playbook || {})
        };

        fs.writeFileSync(filePath, JSON.stringify(updatedPlaybook, null, 2), 'utf8');

        res.json({
            success: true,
            summary: parsed.summary || 'Playbook updated with case feedback learning.',
            suggestedChanges: parsed.suggested_changes || {},
            updatedPlaybook
        });
    } catch (err: any) {
        console.error("Feedback Loop error:", err);
        res.status(500).json({ error: "Failed to process feedback loop", details: err?.message });
    }
});

// A field edited on any one form (e.g. the family name on I-140) represents the same
// underlying person attribute on every other form. This map lets an attorney override
// entered against any fieldId propagate to every other field that represents the same fact.
// Maps each full-coverage field's fieldId to the semantic key it should feed when an attorney
// edits it directly (see getValue()'s semanticOverrides lookup below), so an edit made while
// looking at one form's field is reflected on every other form's same field too - and, just as
// importantly, so the edit doesn't get silently discarded. Every fieldId here MUST exactly match
// a fieldId actually used with that semanticKey in G28_FIELD_DEFS / I140_FIELD_DEFS /
// I765_FIELD_DEFS / I485_FIELD_DEFS: buildDefinedFields() resolves a field's semanticKey to
// canonicalValues[semanticKey] *before* ever looking at the field's own raw override, so a
// fieldId missing from this map means a direct edit to that specific field is silently ignored
// (this happened for real: the map went stale relative to the field defs after they were
// rewritten for full coverage, and this list was rebuilt from every semanticKey actually in use).
const AUTOFILL_FIELD_SEMANTIC_MAP: Record<string, string> = {
    G28_ClientLastName: 'familyName', I140_BeneFamilyName: 'familyName', I765_FamilyName: 'familyName', I485_FamilyName: 'familyName',
    G28_ClientFirstName: 'givenName', I140_BeneGivenName: 'givenName', I765_GivenName: 'givenName', I485_GivenName: 'givenName',
    I140_BeneDOB: 'dob', I765_DOB: 'dob', I485_DOB: 'dob',
    I140_BeneNationality: 'nationality', I765_Nationality: 'nationality', I485_Nationality: 'nationality',
    G28_ClientANumber: 'aNumber', I140_BeneANumber: 'aNumber', I765_ANumber: 'aNumber', I485_ANumber: 'aNumber',
    I140_CompanyName: 'employer',
    I140_JobTitle: 'jobTitle',
    I140_PassportNo: 'passportNo', I765_Passport: 'passportNo', I485_PassportNo: 'passportNo',
    I140_I94Number: 'i94No', I765_I94: 'i94No', I485_I94Number: 'i94No',
    I140_I94Status: 'status', I765_CurrentStatus: 'status', I485_CurrentStatus: 'status',
    G28_AttyLastName: 'attorneyFamilyName', I140_PreparerFamilyName: 'attorneyFamilyName', I765_PreparerFamilyName: 'attorneyFamilyName', I485_PreparerFamilyName: 'attorneyFamilyName',
    G28_AttyFirstName: 'attorneyGivenName', I140_PreparerGivenName: 'attorneyGivenName', I765_PreparerGivenName: 'attorneyGivenName', I485_PreparerGivenName: 'attorneyGivenName',
    G28_LawFirm: 'lawFirm', I140_PreparerOrgName: 'lawFirm', I765_PreparerOrgName: 'lawFirm', I485_PreparerOrgName: 'lawFirm',
};

// Single-attorney firm setting (this deployment serves one law firm). Not derived from
// case data, so kept as a shared constant rather than duplicated per form definition.
const FIRM_ATTORNEY_FAMILY_NAME = 'Miao';
const FIRM_ATTORNEY_GIVEN_NAME = 'Attorney Miao';
const FIRM_LAW_FIRM_NAME = 'Miao & Associates, P.C.';

// Full-field-coverage form definitions (as opposed to the hand-picked ~10-field lists above).
// Every fillable item on the real official PDF that a human would actually need to answer is
// listed here, so the on-screen review table and the exported PDF can never drift apart - both
// are generated from this same list. Real field names and their checkbox on-values were reverse
// engineered from the actual template (rendering the blank form and probing marker text into
// each field - internal AcroForm names are frequently misleading, e.g. this G-28's own
// "Line6_EMail"/"Line7_MobileTelephoneNumber" fields are swapped relative to what they render as).
// Mutually-exclusive checkbox clusters (e.g. "select only one box") are collapsed into a single
// `select` field so the review table shows one answerable row instead of N raw checkboxes.
type UscisFieldType = 'text' | 'toggle' | 'select';
interface UscisFieldOption { value: string; label: string; realField: string; }
interface UscisFieldDef {
    fieldId: string;
    part: string;
    name: string;
    type: UscisFieldType;
    semanticKey?: string;
    realField?: string; // text/toggle
    onValue?: string;   // toggle's checkbox on-value (from the template; pdf-lib's .check() applies it automatically)
    options?: UscisFieldOption[]; // select
    caseTypeMap?: Record<string, string>; // select fields only: derive a default option from record.caseType
    // Defaults to true (G-28's whole list is required). Forms with a long tail of fields we have
    // no data source for (business financials, additional dependents beyond the first, interpreter/
    // preparer contact numbers) mark those `false` so they're still shown and exportable, but don't
    // block sign-off the way the identity/eligibility fields we can actually expect data for do.
    required?: boolean;
}

const G28_FIELD_DEFS: UscisFieldDef[] = [
    { fieldId: 'G28_AttyUscisAcct', part: 'Part 1, Item 1', name: 'Attorney USCIS Online Account Number', type: 'text', realField: 'form1[0].#subform[0].#area[0].Pt1Line1_USCISOnlineAcctNumber[0]' },
    { fieldId: 'G28_AttyLastName', part: 'Part 1, Item 2.a', name: 'Attorney Family Name', type: 'text', semanticKey: 'attorneyFamilyName', realField: 'form1[0].#subform[0].Pt1Line2a_FamilyName[0]' },
    { fieldId: 'G28_AttyFirstName', part: 'Part 1, Item 2.b', name: 'Attorney Given Name', type: 'text', semanticKey: 'attorneyGivenName', realField: 'form1[0].#subform[0].Pt1Line2b_GivenName[0]' },
    { fieldId: 'G28_AttyMiddleName', part: 'Part 1, Item 2.c', name: 'Attorney Middle Name', type: 'text', realField: 'form1[0].#subform[0].Pt1Line2c_MiddleName[0]' },
    { fieldId: 'G28_AttyStreet', part: 'Part 1, Item 3.a', name: 'Attorney Street Number and Name', type: 'text', realField: 'form1[0].#subform[0].Line3a_StreetNumber[0]' },
    { fieldId: 'G28_AttyUnitType', part: 'Part 1, Item 3.b', name: 'Attorney Address Unit Type', type: 'select', options: [
        { value: 'apt', label: 'Apt.', realField: 'form1[0].#subform[0].Line3b_Unit[2]' },
        { value: 'ste', label: 'Ste.', realField: 'form1[0].#subform[0].Line3b_Unit[0]' },
        { value: 'flr', label: 'Flr.', realField: 'form1[0].#subform[0].Line3b_Unit[1]' },
        { value: 'na', label: 'Not Applicable', realField: '' },
    ] },
    { fieldId: 'G28_AttyUnitNumber', part: 'Part 1, Item 3.b', name: 'Attorney Apt/Ste/Flr Number', type: 'text', realField: 'form1[0].#subform[0].Line3b_AptSteFlrNumber[0]' },
    { fieldId: 'G28_AttyCity', part: 'Part 1, Item 3.c', name: 'Attorney City or Town', type: 'text', realField: 'form1[0].#subform[0].Line3c_CityOrTown[0]' },
    { fieldId: 'G28_AttyState', part: 'Part 1, Item 3.d', name: 'Attorney State', type: 'text', realField: 'form1[0].#subform[0].Line3d_State[0]' },
    { fieldId: 'G28_AttyZip', part: 'Part 1, Item 3.e', name: 'Attorney ZIP Code', type: 'text', realField: 'form1[0].#subform[0].Line3e_ZipCode[0]' },
    { fieldId: 'G28_AttyProvince', part: 'Part 1, Item 3.f', name: 'Attorney Province', type: 'text', realField: 'form1[0].#subform[0].Line3f_Province[0]' },
    { fieldId: 'G28_AttyPostalCode', part: 'Part 1, Item 3.g', name: 'Attorney Postal Code', type: 'text', realField: 'form1[0].#subform[0].Line3g_PostalCode[0]' },
    { fieldId: 'G28_AttyCountry', part: 'Part 1, Item 3.h', name: 'Attorney Country', type: 'text', realField: 'form1[0].#subform[0].Line3h_Country[0]' },
    { fieldId: 'G28_AttyDaytimePhone', part: 'Part 1, Item 4', name: 'Attorney Daytime Telephone Number', type: 'text', realField: 'form1[0].#subform[0].Line4_DaytimeTelephoneNumber[0]' },
    // Real field names are swapped for these two on the actual template - confirmed by probing marker text and rendering.
    { fieldId: 'G28_AttyMobilePhone', part: 'Part 1, Item 5', name: 'Attorney Mobile Telephone Number', type: 'text', realField: 'form1[0].#subform[0].Line6_EMail[0]' },
    { fieldId: 'G28_AttyEmail', part: 'Part 1, Item 6', name: 'Attorney Email Address', type: 'text', realField: 'form1[0].#subform[0].Line7_MobileTelephoneNumber[0]' },
    { fieldId: 'G28_AttyFax', part: 'Part 1, Item 7', name: 'Attorney Fax Number', type: 'text', realField: 'form1[0].#subform[0].Pt1ItemNumber7_FaxNumber[0]' },
    { fieldId: 'G28_AttyEligible', part: 'Part 2, Item 1.a', name: 'Attorney Eligible to Practice Law & Member in Good Standing', type: 'toggle', realField: 'form1[0].#subform[0].CheckBox1[0]' },
    { fieldId: 'G28_LicensingAuthority', part: 'Part 2, Item 1.a', name: 'Licensing Authority', type: 'text', realField: 'form1[0].#subform[0].Pt2Line1a_LicensingAuthority[0]' },
    { fieldId: 'G28_BarNumber', part: 'Part 2, Item 1.b', name: 'Bar Number (if applicable)', type: 'text', realField: 'form1[0].#subform[0].Pt2Line1b_BarNumber[0]' },
    { fieldId: 'G28_SuspensionStatus', part: 'Part 2, Item 1.c', name: 'Subject to Any Order Suspending/Restricting Practice of Law', type: 'select', options: [
        { value: 'am_not', label: 'Am NOT subject to suspension/restriction', realField: 'form1[0].#subform[0].Checkbox1dAmNot[0]' },
        { value: 'am', label: 'AM subject to suspension/restriction', realField: 'form1[0].#subform[0].Checkbox1dAm[0]' },
    ] },
    { fieldId: 'G28_LawFirm', part: 'Part 2, Item 1.d', name: 'Name of Law Firm or Organization', type: 'text', semanticKey: 'lawFirm', realField: 'form1[0].#subform[0].Pt2Line1d_NameofFirmOrOrganization[0]' },
    { fieldId: 'G28_AccreditedRep', part: 'Part 2, Item 2.a', name: 'Accredited Representative of Recognized Organization', type: 'toggle', realField: 'form1[0].#subform[0].CheckBox2[0]' },
    { fieldId: 'G28_RecognizedOrgName', part: 'Part 2, Item 2.b', name: 'Name of Recognized Organization', type: 'text', realField: 'form1[0].#subform[0].Line2b_NameofOrganization[0]' },
    { fieldId: 'G28_AccreditationDate', part: 'Part 2, Item 2.c', name: 'Date of Accreditation', type: 'text', realField: 'form1[0].#subform[0].Line2c_DateExpires[0]' },
    { fieldId: 'G28_AssociatedWith', part: 'Part 2, Item 3', name: 'Associated With Attorney/Rep of Record', type: 'toggle', realField: 'form1[0].#subform[0].CheckBox3[0]' },
    { fieldId: 'G28_AssociatedAttyName', part: 'Part 2, Item 3', name: 'Name of Attorney/Rep of Record (if associated)', type: 'text', realField: 'form1[0].#subform[0].Line3_NameofAttorneyOrRep[0]' },
    { fieldId: 'G28_LawStudent', part: 'Part 2, Item 4.a', name: 'Law Student or Law Graduate', type: 'toggle', realField: 'form1[0].#subform[0].CheckBox4[0]' },
    { fieldId: 'G28_LawStudentName', part: 'Part 2, Item 4.b', name: 'Name of Law Student or Law Graduate', type: 'text', realField: 'form1[0].#subform[0].Line4b_LawStudent[0]' },
    { fieldId: 'G28_AppearanceBefore', part: 'Part 3, Item 1-3', name: 'Appearance Relates to Matters Before', type: 'select', options: [
        { value: 'uscis', label: 'USCIS', realField: 'form1[0].#subform[1].Line1a_USCIS[0]' },
        { value: 'ice', label: 'ICE', realField: 'form1[0].#subform[1].Line2a_ICE[0]' },
        { value: 'cbp', label: 'CBP', realField: 'form1[0].#subform[1].Line3a_CBP[0]' },
        { value: 'na', label: 'Not Applicable', realField: '' },
    ] },
    { fieldId: 'G28_FormNumbers', part: 'Part 3, Item 1.b', name: 'Form Numbers or Specific Matter (USCIS)', type: 'text', realField: 'form1[0].#subform[1].Line1b_ListFormNumber[0]' },
    { fieldId: 'G28_ICEMatter', part: 'Part 3, Item 2.b', name: 'Specific Matter (ICE)', type: 'text', realField: 'form1[0].#subform[1].Line2b_ListMatter[0]' },
    { fieldId: 'G28_CBPMatter', part: 'Part 3, Item 3.b', name: 'Specific Matter (CBP)', type: 'text', realField: 'form1[0].#subform[1].Line3b_ListSpecificMatter[0]' },
    { fieldId: 'G28_ReceiptNumber', part: 'Part 3, Item 4', name: 'Receipt Number (if any)', type: 'text', realField: 'form1[0].#subform[1].Pt3Line4_ReceiptNumber[0]' },
    { fieldId: 'G28_AppearanceRole', part: 'Part 3, Item 5', name: 'Appearance Entered at the Request of the', type: 'select', options: [
        { value: 'applicant', label: 'Applicant', realField: 'form1[0].#subform[1].Line4_Checkbox[1]' },
        { value: 'petitioner', label: 'Petitioner', realField: 'form1[0].#subform[1].Line4_Checkbox[3]' },
        { value: 'requestor', label: 'Requestor', realField: 'form1[0].#subform[1].Line4_Checkbox[0]' },
        { value: 'beneficiary', label: 'Beneficiary/Derivative', realField: 'form1[0].#subform[1].Line4_Checkbox[4]' },
        { value: 'respondent', label: 'Respondent (ICE, CBP)', realField: 'form1[0].#subform[1].Line4_Checkbox[2]' },
    ] },
    { fieldId: 'G28_ClientLastName', part: 'Part 3, Item 6.a', name: 'Client Family Name', type: 'text', semanticKey: 'familyName', realField: 'form1[0].#subform[1].Pt3Line5a_FamilyName[0]' },
    { fieldId: 'G28_ClientFirstName', part: 'Part 3, Item 6.b', name: 'Client Given Name', type: 'text', semanticKey: 'givenName', realField: 'form1[0].#subform[1].Pt3Line5b_GivenName[0]' },
    { fieldId: 'G28_ClientMiddleName', part: 'Part 3, Item 6.c', name: 'Client Middle Name', type: 'text', realField: 'form1[0].#subform[1].Pt3Line5c_MiddleName[0]' },
    { fieldId: 'G28_EntityName', part: 'Part 3, Item 7.a', name: 'Name of Entity (if applicable)', type: 'text', realField: 'form1[0].#subform[1].Pt3Line7a_NameOfEntity[0]' },
    { fieldId: 'G28_EntityTitle', part: 'Part 3, Item 7.b', name: 'Title of Authorized Signatory for Entity', type: 'text', realField: 'form1[0].#subform[1].Pt3Line7b_TitleofEntity[0]' },
    { fieldId: 'G28_ClientUscisAcct', part: 'Part 3, Item 8', name: "Client's USCIS Online Account Number", type: 'text', realField: 'form1[0].#subform[1].#area[1].Pt3Line8_USCISOnlineAcctNumber[0]' },
    { fieldId: 'G28_ClientANumber', part: 'Part 3, Item 9', name: "Client's Alien Registration Number (A-Number)", type: 'text', semanticKey: 'aNumber', realField: 'form1[0].#subform[1].Pt3Line9_ANumber[0]' },
    { fieldId: 'G28_ClientDaytimePhone', part: 'Part 3, Item 10', name: 'Client Daytime Telephone Number', type: 'text', realField: 'form1[0].#subform[1].Line9_DaytimeTelephoneNumber[0]' },
    { fieldId: 'G28_ClientMobilePhone', part: 'Part 3, Item 11', name: 'Client Mobile Telephone Number', type: 'text', realField: 'form1[0].#subform[1].Line10_MobileTelephoneNumber[0]' },
    { fieldId: 'G28_ClientEmail', part: 'Part 3, Item 12', name: 'Client Email Address', type: 'text', realField: 'form1[0].#subform[1].Line11_EMail[0]' },
    { fieldId: 'G28_ClientStreet', part: 'Part 3, Item 13.a', name: 'Client Street Number and Name', type: 'text', realField: 'form1[0].#subform[1].Line12a_StreetNumberName[0]' },
    { fieldId: 'G28_ClientUnitType', part: 'Part 3, Item 13.b', name: 'Client Address Unit Type', type: 'select', options: [
        { value: 'apt', label: 'Apt.', realField: 'form1[0].#subform[1].Line12b_Unit[2]' },
        { value: 'ste', label: 'Ste.', realField: 'form1[0].#subform[1].Line12b_Unit[0]' },
        { value: 'flr', label: 'Flr.', realField: 'form1[0].#subform[1].Line12b_Unit[1]' },
        { value: 'na', label: 'Not Applicable', realField: '' },
    ] },
    { fieldId: 'G28_ClientUnitNumber', part: 'Part 3, Item 13.b', name: 'Client Apt/Ste/Flr Number', type: 'text', realField: 'form1[0].#subform[1].Line12b_AptSteFlrNumber[0]' },
    { fieldId: 'G28_ClientCity', part: 'Part 3, Item 13.c', name: 'Client City or Town', type: 'text', realField: 'form1[0].#subform[1].Line12c_CityOrTown[0]' },
    { fieldId: 'G28_ClientState', part: 'Part 3, Item 13.d', name: 'Client State', type: 'text', realField: 'form1[0].#subform[1].Line12d_State[0]' },
    { fieldId: 'G28_ClientZip', part: 'Part 3, Item 13.e', name: 'Client ZIP Code', type: 'text', realField: 'form1[0].#subform[1].Line12e_ZipCode[0]' },
    { fieldId: 'G28_ClientProvince', part: 'Part 3, Item 13.f', name: 'Client Province', type: 'text', realField: 'form1[0].#subform[1].Line12f_Province[0]' },
    { fieldId: 'G28_ClientPostalCode', part: 'Part 3, Item 13.g', name: 'Client Postal Code', type: 'text', realField: 'form1[0].#subform[1].Line12g_PostalCode[0]' },
    { fieldId: 'G28_ClientCountry', part: 'Part 3, Item 13.h', name: 'Client Country', type: 'text', realField: 'form1[0].#subform[1].Line12h_Country[0]' },
    { fieldId: 'G28_NoticeToAttyAddress', part: 'Part 4, Item 1.a', name: 'Send Original Notices to Attorney Business Address', type: 'toggle', realField: 'form1[0].#subform[2].Pt4Line2a_CheckBox2a[0]' },
    { fieldId: 'G28_NoticeSecureDocsToAtty', part: 'Part 4, Item 1.b', name: 'Send Secure Identity Documents to Attorney', type: 'toggle', realField: 'form1[0].#subform[2].Pt4Line2b_CheckBox2b[0]' },
    { fieldId: 'G28_NoticeI94ToClient', part: 'Part 4, Item 1.c', name: "Send Notice Containing Form I-94 to Client's Mailing Address", type: 'toggle', realField: 'form1[0].#subform[2].Pt4Line2c_CheckBox2c[0]' },
];

// The "For USCIS Use Only" block (Classification, Certification, Fee Stamp, Priority Date,
// Consulate, Action Block) at the top of page 1 is adjudicator-only - never petitioner-fillable -
// so it's excluded entirely, same as signatures and the Part 11 "Additional Information" overflow
// page. Persons 3-6 in Part 7 (fields exist for up to 6 dependents) and secondary business/labor
// certification/interpreter/preparer-contact fields are included (full coverage) but marked
// `required: false` - most petitions don't have 6 dependents or labor-cert data on file, and
// forcing every one of those blank would make sign-off impossible for a normal case.
const I140_FIELD_DEFS: UscisFieldDef[] = [
    { fieldId: 'I140_PetitionerFamilyName', part: 'Part 1, Item 1.a', name: 'Petitioner Family Name (if individual)', type: 'text', realField: 'form1[0].#subform[0].Pt1Line1a_FamilyName[0]', required: false },
    { fieldId: 'I140_PetitionerGivenName', part: 'Part 1, Item 1.b', name: 'Petitioner Given Name (if individual)', type: 'text', realField: 'form1[0].#subform[0].Pt1Line1b_GivenName[0]', required: false },
    { fieldId: 'I140_PetitionerMiddleName', part: 'Part 1, Item 1.c', name: 'Petitioner Middle Name', type: 'text', realField: 'form1[0].#subform[0].Pt1Line1c_MiddleName[0]', required: false },
    { fieldId: 'I140_CompanyName', part: 'Part 1, Item 2', name: 'Company or Organization Name (if entity is filing)', type: 'text', semanticKey: 'employer', realField: 'form1[0].#subform[0].Line2_CompanyName[0]' },
    { fieldId: 'I140_G28Attached', part: 'Attorney Block', name: 'Form G-28 or G-28I is Attached', type: 'toggle', realField: 'form1[0].#subform[0].G28CheckBox[0]', required: false },
    { fieldId: 'I140_AttyBarNumber', part: 'Attorney Block', name: 'Attorney State Bar Number', type: 'text', realField: 'form1[0].#subform[0].attyStateBarNumber[0]', required: false },
    { fieldId: 'I140_AttyUscisAcct', part: 'Attorney Block', name: 'Attorney/Rep USCIS Online Account Number', type: 'text', realField: 'form1[0].#subform[0].attyUSCISOnlineNum[0]', required: false },
    { fieldId: 'I140_PetitionerUscisAcct', part: 'Part 1, Item 8', name: 'Petitioner USCIS Online Account Number', type: 'text', realField: 'form1[0].#subform[0].#area[1].Pt1Line8_USCISOnlineActNumber[0]', required: false },
    { fieldId: 'I140_EIN', part: 'Part 1, Item 4', name: 'IRS Employer Identification Number (EIN)', type: 'text', realField: 'form1[0].#subform[0].Pt1Line3_TaxNumber[0]', required: false },
    { fieldId: 'I140_PetitionerSSN', part: 'Part 1, Item 7', name: 'Petitioner U.S. Social Security Number (SSN)', type: 'text', realField: 'form1[0].#subform[0].Line7_SSN[0]', required: false },
    { fieldId: 'I140_MailInCareOf', part: 'Part 1, Item 3.a', name: 'Petitioner Mailing Address - In Care Of Name', type: 'text', realField: 'form1[0].#subform[0].Line6a_InCareofName[0]', required: false },
    { fieldId: 'I140_MailStreet', part: 'Part 1, Item 3.b', name: 'Petitioner Mailing Address - Street Number and Name', type: 'text', realField: 'form1[0].#subform[0].Line6b_StreetNumberName[0]', required: false },
    { fieldId: 'I140_MailUnitType', part: 'Part 1, Item 3.c', name: 'Petitioner Mailing Address - Unit Type', type: 'select', required: false, options: [
        { value: 'apt', label: 'Apt.', realField: 'form1[0].#subform[0].Line6c_Unit[2]' },
        { value: 'ste', label: 'Ste.', realField: 'form1[0].#subform[0].Line6c_Unit[0]' },
        { value: 'flr', label: 'Flr.', realField: 'form1[0].#subform[0].Line6c_Unit[1]' },
        { value: 'na', label: 'Not Applicable', realField: '' },
    ] },
    { fieldId: 'I140_MailUnitNumber', part: 'Part 1, Item 3.c', name: 'Petitioner Mailing Address - Apt/Ste/Flr Number', type: 'text', realField: 'form1[0].#subform[0].Line6c_AptSteFlrNumber[0]', required: false },
    { fieldId: 'I140_MailCity', part: 'Part 1, Item 3.d', name: 'Petitioner Mailing Address - City or Town', type: 'text', realField: 'form1[0].#subform[0].Line6d_CityOrTown[0]', required: false },
    { fieldId: 'I140_MailState', part: 'Part 1, Item 3.e', name: 'Petitioner Mailing Address - State', type: 'text', realField: 'form1[0].#subform[0].Line6e_State[0]', required: false },
    { fieldId: 'I140_MailZip', part: 'Part 1, Item 3.f', name: 'Petitioner Mailing Address - ZIP Code', type: 'text', realField: 'form1[0].#subform[0].Line6f_ZipCode[0]', required: false },
    { fieldId: 'I140_MailProvince', part: 'Part 1, Item 3.g', name: 'Petitioner Mailing Address - Province', type: 'text', realField: 'form1[0].#subform[0].Line6h_Province[0]', required: false },
    { fieldId: 'I140_MailPostalCode', part: 'Part 1, Item 3.h', name: 'Petitioner Mailing Address - Postal Code', type: 'text', realField: 'form1[0].#subform[0].Line6g_PostalCode[0]', required: false },
    { fieldId: 'I140_MailCountry', part: 'Part 1, Item 3.i', name: 'Petitioner Mailing Address - Country', type: 'text', realField: 'form1[0].#subform[0].Line6i_Country[0]', required: false },
    { fieldId: 'I140_NonprofitTaxExempt', part: 'Part 1, Item 5', name: 'Are You a Nonprofit Organized as Tax Exempt or Governmental Research Org?', type: 'toggle', realField: 'form1[0].#subform[0].P1_Line5_Checkbox[1]', required: false },
    { fieldId: 'I140_FewerThan25Employees', part: 'Part 1, Item 6', name: 'Do You Currently Employ 25 or Fewer Full-Time Equivalent Employees?', type: 'toggle', realField: 'form1[0].#subform[0].P1_Line6_Checkbox[1]', required: false },
    // Petition Type spans pages 1-2 of the real form (options a-e on pg1, f-h on pg2) but is one
    // "select only one box" group - case type is a real structured fact about this specific case,
    // not a guess, so this is safely derivable the same way the old (unmapped) display-only
    // "Petition Category Requested" text used to be.
    { fieldId: 'I140_PetitionType', part: 'Part 2, Item 1', name: 'Petition Type (select only one box)', type: 'select', caseTypeMap: { eb1a: 'a', eb2_niw: 'h' }, options: [
        { value: 'a', label: 'An alien of extraordinary ability', realField: 'form1[0].#subform[0].prt2PetitionType[1]' },
        { value: 'b', label: 'An outstanding professor or researcher', realField: 'form1[0].#subform[0].prt2PetitionType[2]' },
        { value: 'c', label: 'A multinational executive or manager', realField: 'form1[0].#subform[0].prt2PetitionType[3]' },
        { value: 'd', label: 'Member of professions w/ advanced degree or exceptional ability (NOT seeking NIW)', realField: 'form1[0].#subform[0].prt2PetitionType[4]' },
        { value: 'e', label: 'A professional', realField: 'form1[0].#subform[0].prt2PetitionType[0]' },
        { value: 'f', label: 'A skilled worker', realField: 'form1[0].#subform[1].prt2PetitionType[7]' },
        { value: 'g', label: 'Any other worker', realField: 'form1[0].#subform[1].prt2PetitionType[5]' },
        { value: 'h', label: 'An alien applying for an NIW', realField: 'form1[0].#subform[1].prt2PetitionType[6]' },
    ] },
    { fieldId: 'I140_AmendPrevious', part: 'Part 2, Item 2', name: 'This Petition Is Being Filed To (select only one box)', type: 'select', required: false, options: [
        { value: 'amend', label: 'To amend a previously filed petition', realField: 'form1[0].#subform[1].Line2_Petition[0]' },
        { value: 'schedule_a', label: 'For the Schedule A, Group I or II designation', realField: 'form1[0].#subform[1].Line2_Petition[1]' },
        { value: 'na', label: 'Not Applicable', realField: '' },
    ] },
    { fieldId: 'I140_PreviousReceiptNumber', part: 'Part 2, Item 2.a', name: 'Previous Petition Receipt Number', type: 'text', realField: 'form1[0].#subform[1].Line2aReceipt[0].Line2a_ReceiptNumber[0]', required: false },
    { fieldId: 'I140_BeneFamilyName', part: 'Part 3, Item 1.a', name: 'Beneficiary Family Name', type: 'text', semanticKey: 'familyName', realField: 'form1[0].#subform[1].Pt3Line1a_FamilyName[0]' },
    { fieldId: 'I140_BeneGivenName', part: 'Part 3, Item 1.b', name: 'Beneficiary Given Name', type: 'text', semanticKey: 'givenName', realField: 'form1[0].#subform[1].Pt3Line1b_GivenName[0]' },
    { fieldId: 'I140_BeneMiddleName', part: 'Part 3, Item 1.c', name: 'Beneficiary Middle Name', type: 'text', realField: 'form1[0].#subform[1].Pt3Line1c_MiddleName[0]', required: false },
    { fieldId: 'I140_BeneMailInCareOf', part: 'Part 3, Item 2.a', name: 'Beneficiary Mailing Address - In Care Of Name', type: 'text', realField: 'form1[0].#subform[1].Line2a_InCareofName[0]', required: false },
    { fieldId: 'I140_BeneMailStreet', part: 'Part 3, Item 2.b', name: 'Beneficiary Mailing Address - Street Number and Name', type: 'text', realField: 'form1[0].#subform[1].Line2b_StreetNumberName[0]', required: false },
    { fieldId: 'I140_BeneMailUnitType', part: 'Part 3, Item 2.c', name: 'Beneficiary Mailing Address - Unit Type', type: 'select', required: false, options: [
        { value: 'apt', label: 'Apt.', realField: 'form1[0].#subform[1].Line2c_Unit[2]' },
        { value: 'ste', label: 'Ste.', realField: 'form1[0].#subform[1].Line2c_Unit[0]' },
        { value: 'flr', label: 'Flr.', realField: 'form1[0].#subform[1].Line2c_Unit[1]' },
        { value: 'na', label: 'Not Applicable', realField: '' },
    ] },
    { fieldId: 'I140_BeneMailUnitNumber', part: 'Part 3, Item 2.c', name: 'Beneficiary Mailing Address - Apt/Ste/Flr Number', type: 'text', realField: 'form1[0].#subform[1].Line2c_AptSteFlrNumber[0]', required: false },
    { fieldId: 'I140_BeneMailCity', part: 'Part 3, Item 2.d', name: 'Beneficiary Mailing Address - City or Town', type: 'text', realField: 'form1[0].#subform[1].Line2d_CityOrTown[0]', required: false },
    { fieldId: 'I140_BeneMailState', part: 'Part 3, Item 2.e', name: 'Beneficiary Mailing Address - State', type: 'text', realField: 'form1[0].#subform[1].Line2e_State[0]', required: false },
    { fieldId: 'I140_BeneMailZip', part: 'Part 3, Item 2.f', name: 'Beneficiary Mailing Address - ZIP Code', type: 'text', realField: 'form1[0].#subform[1].Line2f_ZipCode[0]', required: false },
    { fieldId: 'I140_BeneMailProvince', part: 'Part 3, Item 2.h', name: 'Beneficiary Mailing Address - Province', type: 'text', realField: 'form1[0].#subform[1].Line2h_Province[0]', required: false },
    { fieldId: 'I140_BeneMailPostalCode', part: 'Part 3, Item 2.g', name: 'Beneficiary Mailing Address - Postal Code', type: 'text', realField: 'form1[0].#subform[1].Line2g_PostalCode[0]', required: false },
    { fieldId: 'I140_BeneMailCountry', part: 'Part 3, Item 2.i', name: 'Beneficiary Mailing Address - Country', type: 'text', realField: 'form1[0].#subform[1].Line2i_Country[0]', required: false },
    { fieldId: 'I140_BeneDOB', part: 'Part 3, Item 3', name: 'Beneficiary Date of Birth', type: 'text', semanticKey: 'dob', realField: 'form1[0].#subform[1].Line5_DateOfBirth[0]' },
    { fieldId: 'I140_BeneCityOfBirth', part: 'Part 3, Item 4', name: 'Beneficiary City/Town/Village of Birth', type: 'text', realField: 'form1[0].#subform[1].Line6_CityTownOfBirth[0]', required: false },
    { fieldId: 'I140_BeneStateProvinceOfBirth', part: 'Part 3, Item 5', name: 'Beneficiary State or Province of Birth', type: 'text', realField: 'form1[0].#subform[1].Line7_StateProvinceOfBirth[0]', required: false },
    { fieldId: 'I140_BeneCountryOfBirth', part: 'Part 3, Item 6', name: 'Beneficiary Country of Birth', type: 'text', realField: 'form1[0].#subform[1].Line8_Country[0]', required: false },
    { fieldId: 'I140_BeneNationality', part: 'Part 3, Item 7', name: 'Beneficiary Country of Citizenship or Nationality', type: 'text', semanticKey: 'nationality', realField: 'form1[0].#subform[1].Line9_Country[0]' },
    { fieldId: 'I140_BeneANumber', part: 'Part 3, Item 8', name: 'Beneficiary Alien Registration Number (A-Number)', type: 'text', semanticKey: 'aNumber', realField: 'form1[0].#subform[1].Line11_Alien[0].Pt3Line8_AlienNumber[0]' },
    { fieldId: 'I140_BeneSSN', part: 'Part 3, Item 9', name: 'Beneficiary U.S. SSN (if any)', type: 'text', realField: 'form1[0].#subform[1].Line12_SSN[0]', required: false },
    { fieldId: 'I140_DateOfLastArrival', part: 'Part 3, Item 10', name: 'Date of Last Arrival Into the U.S.', type: 'text', realField: 'form1[0].#subform[1].Line13_DateOArrival[0]', required: false },
    { fieldId: 'I140_I94Number', part: 'Part 3, Item 11.a', name: 'Form I-94 Arrival-Departure Record Number', type: 'text', semanticKey: 'i94No', realField: 'form1[0].#subform[1].Line14_I94Number[0].Line14a_ArrivalDeparture[0]' },
    { fieldId: 'I140_I94ExpDate', part: 'Part 3, Item 11.b', name: 'Expiration Date of Authorized Stay Shown on Form I-94', type: 'text', realField: 'form1[0].#subform[1].Line14e_ExpDate[1]', required: false },
    { fieldId: 'I140_I94Status', part: 'Part 3, Item 11.c / 15', name: 'Current Nonimmigrant Status', type: 'text', semanticKey: 'status', realField: 'form1[0].#subform[1].Line15_CurrentNon[0]' },
    { fieldId: 'I140_PassportNo', part: 'Part 3, Item 12', name: 'Beneficiary Passport Number', type: 'text', semanticKey: 'passportNo', realField: 'form1[0].#subform[1].Line14b_Passport[0]' },
    { fieldId: 'I140_TravelDocNo', part: 'Part 3, Item 13', name: 'Beneficiary Travel Document Number', type: 'text', realField: 'form1[0].#subform[1].Line14c_TravelDoc[0]', required: false },
    { fieldId: 'I140_PassportCountryIssuance', part: 'Part 3, Item 14', name: 'Country of Issuance for Passport or Travel Document', type: 'text', realField: 'form1[0].#subform[1].Line14d_CountryOfIssuance[0]', required: false },
    { fieldId: 'I140_PassportExpDate', part: 'Part 3, Item 15', name: 'Expiration Date for Passport or Travel Document', type: 'text', realField: 'form1[0].#subform[1].Line14e_ExpDate[0]', required: false },
    { fieldId: 'I140_ProcessingMethod', part: 'Part 4, Item 1-2', name: 'Beneficiary Will Apply For (select only one box)', type: 'select', required: false, options: [
        { value: 'visa_abroad', label: 'Visa Abroad at a U.S. Embassy or Consulate', realField: 'form1[0].#subform[1].Line1a_Visa[0]' },
        { value: 'adjustment', label: 'Adjustment of Status in the U.S.', realField: 'form1[0].#subform[1].Line1b_Status[0]' },
        { value: 'na', label: 'Not Applicable / Unknown', realField: '' },
    ] },
    { fieldId: 'I140_ConsulateCity', part: 'Part 4, Item 1.b', name: 'Consulate/Embassy City or Town', type: 'text', realField: 'form1[0].#subform[1].Line1a_CityorTown[0]', required: false },
    { fieldId: 'I140_ConsulateCountry', part: 'Part 4, Item 1.c', name: 'Consulate/Embassy Country', type: 'text', realField: 'form1[0].#subform[2].Line1b_Country[0]', required: false },
    { fieldId: 'I140_ForeignResidenceCountry', part: 'Part 4, Item 2.b', name: "Alien's Current Country of Residence (or last country of permanent residence abroad)", type: 'text', realField: 'form1[0].#subform[2].Line2a_StreetNumberName[0]', required: false },
    { fieldId: 'I140_ForeignAddressUnitType', part: 'Part 4, Item 3', name: 'Foreign Address - Unit Type', type: 'select', required: false, options: [
        { value: 'apt', label: 'Apt.', realField: 'form1[0].#subform[2].Line2b_Unit[2]' },
        { value: 'ste', label: 'Ste.', realField: 'form1[0].#subform[2].Line2b_Unit[0]' },
        { value: 'flr', label: 'Flr.', realField: 'form1[0].#subform[2].Line2b_Unit[1]' },
        { value: 'na', label: 'Not Applicable', realField: '' },
    ] },
    { fieldId: 'I140_ForeignAddressUnitNumber', part: 'Part 4, Item 3', name: 'Foreign Address - Apt/Ste/Flr Number', type: 'text', realField: 'form1[0].#subform[2].Line2b_AptSteFlrNumber[0]', required: false },
    { fieldId: 'I140_ForeignAddressCity', part: 'Part 4, Item 3', name: 'Foreign Address - City or Town', type: 'text', realField: 'form1[0].#subform[2].Line2c_CityOrTown[0]', required: false },
    { fieldId: 'I140_ForeignAddressProvince', part: 'Part 4, Item 3', name: 'Foreign Address - Province', type: 'text', realField: 'form1[0].#subform[2].Line2e_Province[0]', required: false },
    { fieldId: 'I140_ForeignAddressPostalCode', part: 'Part 4, Item 3', name: 'Foreign Address - Postal Code', type: 'text', realField: 'form1[0].#subform[2].Line2d_PostalCode[0]', required: false },
    { fieldId: 'I140_ForeignAddressCountry', part: 'Part 4, Item 3', name: 'Foreign Address - Country', type: 'text', realField: 'form1[0].#subform[2].Line2f_Country[0]', required: false },
    { fieldId: 'I140_NativeFamilyName', part: 'Part 4, Item 4.a', name: "Beneficiary Name in Native Alphabet - Family Name", type: 'text', realField: 'form1[0].#subform[2].Line3a_FamilyName2[0]', required: false },
    { fieldId: 'I140_NativeGivenName', part: 'Part 4, Item 4.b', name: "Beneficiary Name in Native Alphabet - Given Name", type: 'text', realField: 'form1[0].#subform[2].Line3b_GivenName2[0]', required: false },
    { fieldId: 'I140_NativeMiddleName', part: 'Part 4, Item 4.c', name: "Beneficiary Name in Native Alphabet - Middle Name", type: 'text', realField: 'form1[0].#subform[2].Line3c_MiddleName2[0]', required: false },
    { fieldId: 'I140_NativeMailInCareOf', part: 'Part 4, Item 5.a', name: 'Native Alphabet Mailing Address - In Care Of Name', type: 'text', realField: 'form1[0].#subform[2].Line2a_InCareofName[1]', required: false },
    { fieldId: 'I140_NativeMailStreet', part: 'Part 4, Item 5.b', name: 'Native Alphabet Mailing Address - Street Number and Name', type: 'text', realField: 'form1[0].#subform[2].Line3d_StreetNumberName[0]', required: false },
    { fieldId: 'I140_NativeMailUnitType', part: 'Part 4, Item 5.c', name: 'Native Alphabet Mailing Address - Unit Type', type: 'select', required: false, options: [
        { value: 'apt', label: 'Apt.', realField: 'form1[0].#subform[2].Line3e_Unit[2]' },
        { value: 'ste', label: 'Ste.', realField: 'form1[0].#subform[2].Line3e_Unit[0]' },
        { value: 'flr', label: 'Flr.', realField: 'form1[0].#subform[2].Line3e_Unit[1]' },
        { value: 'na', label: 'Not Applicable', realField: '' },
    ] },
    { fieldId: 'I140_NativeMailUnitNumber', part: 'Part 4, Item 5.c', name: 'Native Alphabet Mailing Address - Apt/Ste/Flr Number', type: 'text', realField: 'form1[0].#subform[2].Line3e_AptSteFlrNumber[0]', required: false },
    { fieldId: 'I140_NativeMailCity', part: 'Part 4, Item 5.d', name: 'Native Alphabet Mailing Address - City or Town', type: 'text', realField: 'form1[0].#subform[2].Line3f_CityOrTown[0]', required: false },
    { fieldId: 'I140_NativeMailProvince', part: 'Part 4, Item 5.e', name: 'Native Alphabet Mailing Address - Province', type: 'text', realField: 'form1[0].#subform[2].Line3h_Province[0]', required: false },
    { fieldId: 'I140_NativeMailPostalCode', part: 'Part 4, Item 5.f', name: 'Native Alphabet Mailing Address - Postal Code', type: 'text', realField: 'form1[0].#subform[2].Line3g_PostalCode[0]', required: false },
    { fieldId: 'I140_NativeMailCountry', part: 'Part 4, Item 5.g', name: 'Native Alphabet Mailing Address - Country', type: 'text', realField: 'form1[0].#subform[2].Line3i_Country[0]', required: false },
    { fieldId: 'I140_ConcurrentI485', part: 'Part 4, Item 6.b', name: 'Filing Concurrently With Form I-485', type: 'toggle', realField: 'form1[0].#subform[2].Line4_Form485[0]', required: false },
    { fieldId: 'I140_ConcurrentI131', part: 'Part 4, Item 6.b', name: 'Filing Concurrently With Form I-131', type: 'toggle', realField: 'form1[0].#subform[2].Line4_Form131[0]', required: false },
    { fieldId: 'I140_ConcurrentI765', part: 'Part 4, Item 6.b', name: 'Filing Concurrently With Form I-765', type: 'toggle', realField: 'form1[0].#subform[2].Line4_Form765[0]', required: false },
    { fieldId: 'I140_ConcurrentOther', part: 'Part 4, Item 6.b', name: 'Filing Concurrently With Other Form (explain in Additional Info)', type: 'toggle', realField: 'form1[0].#subform[2].Line4_OtherAttach[0]', required: false },
    { fieldId: 'I140_RemovalProceedings', part: 'Part 4, Item 7', name: 'Is the Beneficiary in Removal Proceedings?', type: 'toggle', realField: 'form1[0].#subform[2].Line7_Yes[0]', required: false },
    { fieldId: 'I140_PriorImmigrantPetition', part: 'Part 4, Item 8', name: 'Has Any Immigrant Visa Petition Ever Been Filed by/on Behalf of This Person?', type: 'toggle', realField: 'form1[0].#subform[2].Line5_Yes[0]', required: false },
    { fieldId: 'I140_NoOriginalLaborCert', part: 'Part 4, Item 9', name: 'Filing Without Original Labor Certification (previously submitted with another I-140)?', type: 'toggle', realField: 'form1[0].#subform[2].Line6_Yes[0]', required: false },
    { fieldId: 'I140_RequestDuplicateLaborCert', part: 'Part 4, Item 10', name: 'Requesting USCIS Obtain Duplicate Labor Certification from DOL?', type: 'toggle', realField: 'form1[0].#subform[2].Line8_Yes[0]', required: false },
    { fieldId: 'I140_PetitionerType', part: 'Part 5, Item 1', name: 'Type of Petitioner (select only one box)', type: 'select', caseTypeMap: { eb1a: 'self', eb2_niw: 'self', l1a: 'employer' }, options: [
        { value: 'employer', label: 'Employer', realField: 'form1[0].#subform[2].Line1a_Employer[0]' },
        { value: 'self', label: 'Self', realField: 'form1[0].#subform[2].Line1b_Self[0]' },
        { value: 'other', label: 'Other', realField: 'form1[0].#subform[2].Line1c_Other[0]' },
    ] },
    { fieldId: 'I140_PetitionerTypeOtherExplain', part: 'Part 5, Item 1.c', name: 'Petitioner Type "Other" - Explanation', type: 'text', realField: 'form1[0].#subform[2].Line1c_Explain[0]', required: false },
    { fieldId: 'I140_TypeOfBusiness', part: 'Part 5, Item 2', name: 'Type of Business', type: 'text', realField: 'form1[0].#subform[2].Line2a_TypeofBusiness[0]', required: false },
    { fieldId: 'I140_DateEstablished', part: 'Part 5, Item 3', name: 'Date Business Established', type: 'text', realField: 'form1[0].#subform[2].Line2b_DateEstablished[0]', required: false },
    { fieldId: 'I140_CurrentNumEmployees', part: 'Part 5, Item 4', name: 'Current Number of U.S. Employees', type: 'text', realField: 'form1[0].#subform[2].Line2c_NumberofEmployees[0]', required: false },
    { fieldId: 'I140_GrossAnnualIncome', part: 'Part 5, Item 5', name: 'Gross Annual Income', type: 'text', realField: 'form1[0].#subform[2].Line2d_GrossAnnualIncome[0]', required: false },
    { fieldId: 'I140_NetAnnualIncome', part: 'Part 5, Item 6', name: 'Net Annual Income', type: 'text', realField: 'form1[0].#subform[2].Line2e_NetAnnualIncome[0]', required: false },
    { fieldId: 'I140_NAICSCode', part: 'Part 5, Item 7', name: 'NAICS Code', type: 'text', realField: 'form1[0].#subform[2].Line2f[0].Line2f_NAICSCode[0]', required: false },
    { fieldId: 'I140_LaborCertDOLCaseNumber', part: 'Part 5, Item 8', name: 'Labor Certification DOL Case Number', type: 'text', realField: 'form1[0].#subform[2].Line2g_LaborCertification[0]', required: false },
    { fieldId: 'I140_LaborCertFilingDate', part: 'Part 5, Item 9', name: 'Labor Certification DOL Filing Date', type: 'text', realField: 'form1[0].#subform[3].Line2h_LaborCertification[0]', required: false },
    { fieldId: 'I140_LaborCertExpDate', part: 'Part 5, Item 10', name: 'Labor Certification Expiration Date', type: 'text', realField: 'form1[0].#subform[3].Line2i_LaborCertificationDate[0]', required: false },
    { fieldId: 'I140_PetitionerOccupation', part: 'Part 5, Item 11', name: 'Petitioner Occupation (if individual is filing)', type: 'text', realField: 'form1[0].#subform[3].Line3a_Occupation[0]', required: false },
    { fieldId: 'I140_PetitionerAnnualIncome', part: 'Part 5, Item 12', name: 'Petitioner Annual Income (if individual is filing)', type: 'text', realField: 'form1[0].#subform[3].Line3b_AnnualIncome[0]', required: false },
    { fieldId: 'I140_JobTitle', part: 'Part 6, Item 1', name: 'Job Title', type: 'text', semanticKey: 'jobTitle', realField: 'form1[0].#subform[3].Line1_JobTitle[0]' },
    { fieldId: 'I140_SOCCode1', part: 'Part 6, Item 2', name: 'SOC Code (prefix)', type: 'text', realField: 'form1[0].#subform[3].Line2_SOCCode1[0]', required: false },
    { fieldId: 'I140_SOCCode2', part: 'Part 6, Item 2', name: 'SOC Code (suffix)', type: 'text', realField: 'form1[0].#subform[3].Line2_SOCCode2[0]', required: false },
    { fieldId: 'I140_JobDescription', part: 'Part 6, Item 3', name: 'Nontechnical Job Description', type: 'text', realField: 'form1[0].#subform[3].Line3_JobDescription[0]', required: false },
    { fieldId: 'I140_FullTimePosition', part: 'Part 6, Item 4', name: 'Is This a Full-Time Position?', type: 'toggle', realField: 'form1[0].#subform[3].Line4_Yes1[0]', required: false },
    { fieldId: 'I140_HoursPerWeek', part: 'Part 6, Item 5', name: 'Hours Per Week (if not full-time)', type: 'text', realField: 'form1[0].#subform[3].Line5_Hours[0]', required: false },
    { fieldId: 'I140_PermanentPosition', part: 'Part 6, Item 6', name: 'Is This a Permanent Position?', type: 'toggle', realField: 'form1[0].#subform[3].Line6_Yes1[0]', required: false },
    { fieldId: 'I140_NewPosition', part: 'Part 6, Item 7', name: 'Is This a New Position?', type: 'toggle', realField: 'form1[0].#subform[3].Line7_Yes1[0]', required: false },
    { fieldId: 'I140_Wages', part: 'Part 6, Item 8', name: 'Wages', type: 'text', realField: 'form1[0].#subform[3].Line8_Wages[0]', required: false },
    { fieldId: 'I140_WagesPer', part: 'Part 6, Item 8', name: 'Wages Per (hour/week/month/year)', type: 'text', realField: 'form1[0].#subform[3].Line8_Per[0]', required: false },
    { fieldId: 'I140_WorksiteStreet', part: 'Part 6, Item 9.a', name: 'Worksite Location - Street Number and Name', type: 'text', realField: 'form1[0].#subform[3].Line9a_StreetNumberName[0]', required: false },
    { fieldId: 'I140_WorksiteUnitType', part: 'Part 6, Item 9.b', name: 'Worksite Location - Unit Type', type: 'select', required: false, options: [
        { value: 'apt', label: 'Apt.', realField: 'form1[0].#subform[3].Line9b_Unit[2]' },
        { value: 'ste', label: 'Ste.', realField: 'form1[0].#subform[3].Line9b_Unit[0]' },
        { value: 'flr', label: 'Flr.', realField: 'form1[0].#subform[3].Line9b_Unit[1]' },
        { value: 'na', label: 'Not Applicable', realField: '' },
    ] },
    { fieldId: 'I140_WorksiteUnitNumber', part: 'Part 6, Item 9.b', name: 'Worksite Location - Apt/Ste/Flr Number', type: 'text', realField: 'form1[0].#subform[3].Line9b_AptSteFlrNumber[0]', required: false },
    { fieldId: 'I140_WorksiteCity', part: 'Part 6, Item 9.c', name: 'Worksite Location - City or Town', type: 'text', realField: 'form1[0].#subform[3].Line9c_CityOrTown[0]', required: false },
    { fieldId: 'I140_WorksiteState', part: 'Part 6, Item 9.d', name: 'Worksite Location - State', type: 'text', realField: 'form1[0].#subform[3].Line9d_State[0]', required: false },
    { fieldId: 'I140_WorksiteZip', part: 'Part 6, Item 9.e', name: 'Worksite Location - ZIP Code', type: 'text', realField: 'form1[0].#subform[3].Line9e_ZipCode[0]', required: false },
    // Part 7 - Spouse and children. Person 1/2 are the common case (spouse + one child); Persons
    // 3-6 exist on the real form for large families but are marked optional (see note above).
    { fieldId: 'I140_P1FamilyName', part: 'Part 7, Item 1.a', name: 'Person 1 (Spouse/Child) - Family Name', type: 'text', realField: 'form1[0].#subform[3].Line1a_Person1FamilyName[0]', required: false },
    { fieldId: 'I140_P1GivenName', part: 'Part 7, Item 1.b', name: 'Person 1 (Spouse/Child) - Given Name', type: 'text', realField: 'form1[0].#subform[3].Line1b_Person1GivenName[0]', required: false },
    { fieldId: 'I140_P1MiddleName', part: 'Part 7, Item 1.c', name: 'Person 1 (Spouse/Child) - Middle Name', type: 'text', realField: 'form1[0].#subform[3].Line1c_Person1MiddleName[0]', required: false },
    { fieldId: 'I140_P1DOB', part: 'Part 7, Item 2', name: 'Person 1 - Date of Birth', type: 'text', realField: 'form1[0].#subform[3].Line1d_Person1DateOfBirth[0]', required: false },
    { fieldId: 'I140_P1CountryOfBirth', part: 'Part 7, Item 3', name: 'Person 1 - Country of Birth', type: 'text', realField: 'form1[0].#subform[3].Line1e_CountryOfBirth[0]', required: false },
    { fieldId: 'I140_P1Relationship', part: 'Part 7, Item 4', name: 'Person 1 - Relationship', type: 'text', realField: 'form1[0].#subform[3].Line1f_Relationship[0]', required: false },
    { fieldId: 'I140_P1Adjustment', part: 'Part 7, Item 5', name: 'Person 1 - Applying for Adjustment of Status?', type: 'toggle', realField: 'form1[0].#subform[3].Pt7ItemNumber5_CheckboxYes[0]', required: false },
    { fieldId: 'I140_P1VisaAbroad', part: 'Part 7, Item 6', name: 'Person 1 - Applying for a Visa Abroad?', type: 'toggle', realField: 'form1[0].#subform[3].Pt7ItemNumber6_CheckboxYes[0]', required: false },
    { fieldId: 'I140_P2FamilyName', part: 'Part 7, Item 7.a', name: 'Person 2 (Spouse/Child) - Family Name', type: 'text', realField: 'form1[0].#subform[3].Line2a_Person2FamilyName[0]', required: false },
    { fieldId: 'I140_P2GivenName', part: 'Part 7, Item 7.b', name: 'Person 2 (Spouse/Child) - Given Name', type: 'text', realField: 'form1[0].#subform[3].Line2b_Person2GivenName[0]', required: false },
    { fieldId: 'I140_P2MiddleName', part: 'Part 7, Item 7.c', name: 'Person 2 (Spouse/Child) - Middle Name', type: 'text', realField: 'form1[0].#subform[3].Line2c_Person2MiddleName[0]', required: false },
    { fieldId: 'I140_P2DOB', part: 'Part 7, Item 8', name: 'Person 2 - Date of Birth', type: 'text', realField: 'form1[0].#subform[3].Line2d_DateOfBirth[0]', required: false },
    { fieldId: 'I140_P2CountryOfBirth', part: 'Part 7, Item 9', name: 'Person 2 - Country of Birth', type: 'text', realField: 'form1[0].#subform[3].Line2e_CountryOfBirth[0]', required: false },
    { fieldId: 'I140_P2Relationship', part: 'Part 7, Item 10', name: 'Person 2 - Relationship', type: 'text', realField: 'form1[0].#subform[3].Line2f_Relationship[0]', required: false },
    { fieldId: 'I140_P2Adjustment', part: 'Part 7, Item 11', name: 'Person 2 - Applying for Adjustment of Status?', type: 'toggle', realField: 'form1[0].#subform[3].Pt7ItemNumber11_CheckboxYes[0]', required: false },
    { fieldId: 'I140_P2VisaAbroad', part: 'Part 7, Item 12', name: 'Person 2 - Applying for a Visa Abroad?', type: 'toggle', realField: 'form1[0].#subform[3].Pt7ItemNumber12_CheckboxYes[0]', required: false },
    { fieldId: 'I140_P3FamilyName', part: 'Part 7, Item 13.a', name: 'Person 3 (Spouse/Child) - Family Name', type: 'text', realField: 'form1[0].#subform[4].Line2a_Person2FamilyName[1]', required: false },
    { fieldId: 'I140_P3GivenName', part: 'Part 7, Item 13.b', name: 'Person 3 (Spouse/Child) - Given Name', type: 'text', realField: 'form1[0].#subform[4].Line2b_Person2GivenName[1]', required: false },
    { fieldId: 'I140_P3MiddleName', part: 'Part 7, Item 13.c', name: 'Person 3 (Spouse/Child) - Middle Name', type: 'text', realField: 'form1[0].#subform[4].Line2c_Person2MiddleName[1]', required: false },
    { fieldId: 'I140_P3DOB', part: 'Part 7, Item 14', name: 'Person 3 - Date of Birth', type: 'text', realField: 'form1[0].#subform[4].Line2d_DateOfBirth[1]', required: false },
    { fieldId: 'I140_P3CountryOfBirth', part: 'Part 7, Item 15', name: 'Person 3 - Country of Birth', type: 'text', realField: 'form1[0].#subform[4].Line2e_CountryOfBirth[1]', required: false },
    { fieldId: 'I140_P3Relationship', part: 'Part 7, Item 16', name: 'Person 3 - Relationship', type: 'text', realField: 'form1[0].#subform[4].Line2f_Relationship[1]', required: false },
    { fieldId: 'I140_P3Adjustment', part: 'Part 7, Item 17', name: 'Person 3 - Applying for Adjustment of Status?', type: 'toggle', realField: 'form1[0].#subform[4].Pt7ItemNumber17_CheckboxYes[0]', required: false },
    { fieldId: 'I140_P3VisaAbroad', part: 'Part 7, Item 18', name: 'Person 3 - Applying for a Visa Abroad?', type: 'toggle', realField: 'form1[0].#subform[4].Pt7ItemNumber18_CheckboxYes[0]', required: false },
    { fieldId: 'I140_P4FamilyName', part: 'Part 7, Item 19.a', name: 'Person 4 (Spouse/Child) - Family Name', type: 'text', realField: 'form1[0].#subform[4].Line2a_Person2FamilyName[2]', required: false },
    { fieldId: 'I140_P4GivenName', part: 'Part 7, Item 19.b', name: 'Person 4 (Spouse/Child) - Given Name', type: 'text', realField: 'form1[0].#subform[4].Line2b_Person2GivenName[2]', required: false },
    { fieldId: 'I140_P4MiddleName', part: 'Part 7, Item 19.c', name: 'Person 4 (Spouse/Child) - Middle Name', type: 'text', realField: 'form1[0].#subform[4].Line2c_Person2MiddleName[2]', required: false },
    { fieldId: 'I140_P4DOB', part: 'Part 7, Item 20', name: 'Person 4 - Date of Birth', type: 'text', realField: 'form1[0].#subform[4].Line2d_DateOfBirth[2]', required: false },
    { fieldId: 'I140_P4CountryOfBirth', part: 'Part 7, Item 21', name: 'Person 4 - Country of Birth', type: 'text', realField: 'form1[0].#subform[4].Line2e_CountryOfBirth[2]', required: false },
    { fieldId: 'I140_P4Relationship', part: 'Part 7, Item 22', name: 'Person 4 - Relationship', type: 'text', realField: 'form1[0].#subform[4].Line2f_Relationship[2]', required: false },
    { fieldId: 'I140_P4Adjustment', part: 'Part 7, Item 23', name: 'Person 4 - Applying for Adjustment of Status?', type: 'toggle', realField: 'form1[0].#subform[4].Pt7ItemNumber23_CheckboxYes[0]', required: false },
    { fieldId: 'I140_P4VisaAbroad', part: 'Part 7, Item 24', name: 'Person 4 - Applying for a Visa Abroad?', type: 'toggle', realField: 'form1[0].#subform[4].Pt7ItemNumber24_CheckboxYes[0]', required: false },
    { fieldId: 'I140_P5FamilyName', part: 'Part 7, Item 25.a', name: 'Person 5 (Spouse/Child) - Family Name', type: 'text', realField: 'form1[0].#subform[4].Line2a_Person2FamilyName[3]', required: false },
    { fieldId: 'I140_P5GivenName', part: 'Part 7, Item 25.b', name: 'Person 5 (Spouse/Child) - Given Name', type: 'text', realField: 'form1[0].#subform[4].Line2b_Person2GivenName[3]', required: false },
    { fieldId: 'I140_P5MiddleName', part: 'Part 7, Item 25.c', name: 'Person 5 (Spouse/Child) - Middle Name', type: 'text', realField: 'form1[0].#subform[4].Line2c_Person2MiddleName[3]', required: false },
    { fieldId: 'I140_P5DOB', part: 'Part 7, Item 26', name: 'Person 5 - Date of Birth', type: 'text', realField: 'form1[0].#subform[4].Line2d_DateOfBirth[3]', required: false },
    { fieldId: 'I140_P5CountryOfBirth', part: 'Part 7, Item 27', name: 'Person 5 - Country of Birth', type: 'text', realField: 'form1[0].#subform[4].Line2e_CountryOfBirth[3]', required: false },
    { fieldId: 'I140_P5Relationship', part: 'Part 7, Item 28', name: 'Person 5 - Relationship', type: 'text', realField: 'form1[0].#subform[4].Line2f_Relationship[3]', required: false },
    { fieldId: 'I140_P5Adjustment', part: 'Part 7, Item 29', name: 'Person 5 - Applying for Adjustment of Status?', type: 'toggle', realField: 'form1[0].#subform[4].Pt7ItemNumber29_CheckboxYes[0]', required: false },
    { fieldId: 'I140_P5VisaAbroad', part: 'Part 7, Item 30', name: 'Person 5 - Applying for a Visa Abroad?', type: 'toggle', realField: 'form1[0].#subform[4].Pt7ItemNumber30_CheckboxYes[0]', required: false },
    { fieldId: 'I140_P6FamilyName', part: 'Part 7, Item 31.a', name: 'Person 6 (Spouse/Child) - Family Name', type: 'text', realField: 'form1[0].#subform[4].Line2a_Person2FamilyName[4]', required: false },
    { fieldId: 'I140_P6GivenName', part: 'Part 7, Item 31.b', name: 'Person 6 (Spouse/Child) - Given Name', type: 'text', realField: 'form1[0].#subform[4].Line2b_Person2GivenName[4]', required: false },
    { fieldId: 'I140_P6MiddleName', part: 'Part 7, Item 31.c', name: 'Person 6 (Spouse/Child) - Middle Name', type: 'text', realField: 'form1[0].#subform[4].Line2c_Person2MiddleName[4]', required: false },
    { fieldId: 'I140_P6DOB', part: 'Part 7, Item 32', name: 'Person 6 - Date of Birth', type: 'text', realField: 'form1[0].#subform[4].Line2d_DateOfBirth[4]', required: false },
    { fieldId: 'I140_P6CountryOfBirth', part: 'Part 7, Item 33', name: 'Person 6 - Country of Birth', type: 'text', realField: 'form1[0].#subform[4].Line2e_CountryOfBirth[4]', required: false },
    { fieldId: 'I140_P6Relationship', part: 'Part 7, Item 34', name: 'Person 6 - Relationship', type: 'text', realField: 'form1[0].#subform[4].Line2f_Relationship[4]', required: false },
    { fieldId: 'I140_P6Adjustment', part: 'Part 7, Item 35', name: 'Person 6 - Applying for Adjustment of Status?', type: 'toggle', realField: 'form1[0].#subform[4].Pt7ItemNumber35_CheckboxYes[0]', required: false },
    { fieldId: 'I140_P6VisaAbroad', part: 'Part 7, Item 36', name: 'Person 6 - Applying for a Visa Abroad?', type: 'toggle', realField: 'form1[0].#subform[4].Pt7ItemNumber36_CheckboxYes[0]', required: false },
    // Part 8 - Petitioner/Authorized Signatory contact info. Distinct from the beneficiary and
    // from the attorney - could be an HR contact, so not semantically prefilled.
    { fieldId: 'I140_SignatoryFamilyName', part: 'Part 8, Item 1.a', name: "Petitioner/Authorized Signatory's Family Name", type: 'text', realField: 'form1[0].#subform[5].Part7_Item3a_FamilyName[0]', required: false },
    { fieldId: 'I140_SignatoryGivenName', part: 'Part 8, Item 1.b', name: "Petitioner/Authorized Signatory's Given Name", type: 'text', realField: 'form1[0].#subform[5].Part7_Item3b_GivenName[0]', required: false },
    { fieldId: 'I140_SignatoryTitle', part: 'Part 8, Item 2', name: "Petitioner/Authorized Signatory's Title", type: 'text', realField: 'form1[0].#subform[5].Part7_Item4_Title[0]', required: false },
    { fieldId: 'I140_SignatoryDayPhone', part: 'Part 8, Item 3', name: "Petitioner/Authorized Signatory's Daytime Telephone Number", type: 'text', realField: 'form1[0].#subform[5].Part7_Item5_DayPhone[0]', required: false },
    { fieldId: 'I140_SignatoryMobilePhone', part: 'Part 8, Item 4', name: "Petitioner/Authorized Signatory's Mobile Telephone Number", type: 'text', realField: 'form1[0].#subform[5].Part7_Item6_MobilePhone[0]', required: false },
    { fieldId: 'I140_SignatoryEmail', part: 'Part 8, Item 5', name: "Petitioner/Authorized Signatory's Email Address", type: 'text', realField: 'form1[0].#subform[5].Part7_Item7_Email[0]', required: false },
    // Part 9 - Interpreter. Only applies if an interpreter was used - most filings have none.
    { fieldId: 'I140_InterpreterFamilyName', part: 'Part 9, Item 1.a', name: "Interpreter's Family Name", type: 'text', realField: 'form1[0].#subform[5].Part8_Item1a_FamilyName[0]', required: false },
    { fieldId: 'I140_InterpreterGivenName', part: 'Part 9, Item 1.b', name: "Interpreter's Given Name", type: 'text', realField: 'form1[0].#subform[5].Part8_Item1b_GivenName[0]', required: false },
    { fieldId: 'I140_InterpreterOrgName', part: 'Part 9, Item 2', name: "Interpreter's Business or Organization Name", type: 'text', realField: 'form1[0].#subform[5].Part8_Item2_OrgName[0]', required: false },
    { fieldId: 'I140_InterpreterDayPhone', part: 'Part 9, Item 3', name: "Interpreter's Daytime Telephone Number", type: 'text', realField: 'form1[0].#subform[5].Part8_Item4_DayPhone[0]', required: false },
    { fieldId: 'I140_InterpreterMobilePhone', part: 'Part 9, Item 4', name: "Interpreter's Mobile Telephone Number", type: 'text', realField: 'form1[0].#subform[5].Part8_Item5_MobilePhone[0]', required: false },
    { fieldId: 'I140_InterpreterEmail', part: 'Part 9, Item 5', name: "Interpreter's Email Address", type: 'text', realField: 'form1[0].#subform[5].Part8_Item6_Email[0]', required: false },
    { fieldId: 'I140_InterpreterLanguage', part: 'Part 9, Certification', name: 'Language Interpreted', type: 'text', realField: 'form1[0].#subform[5].Part8_Item6_Language[0]', required: false },
    // Part 10 - Preparer, if other than the petitioner/signatory. The attorney is almost always
    // the preparer in this practice, so name/firm are safely semantic-prefilled; the rest isn't.
    { fieldId: 'I140_PreparerFamilyName', part: 'Part 10, Item 1', name: "Preparer's Family Name", type: 'text', semanticKey: 'attorneyFamilyName', realField: 'form1[0].#subform[6].Part10_Item1_FamilyName[0]' },
    { fieldId: 'I140_PreparerGivenName', part: 'Part 10, Item 1', name: "Preparer's Given Name", type: 'text', semanticKey: 'attorneyGivenName', realField: 'form1[0].#subform[6].Part10_Item1_GivenName[0]' },
    { fieldId: 'I140_PreparerOrgName', part: 'Part 10, Item 2', name: "Preparer's Business or Organization Name", type: 'text', semanticKey: 'lawFirm', realField: 'form1[0].#subform[6].Part10_Item2_OrgName[0]' },
    { fieldId: 'I140_PreparerDayPhone', part: 'Part 10, Item 3', name: "Preparer's Daytime Telephone Number", type: 'text', realField: 'form1[0].#subform[6].Part10_Item3_DayPhone[0]', required: false },
    { fieldId: 'I140_PreparerMobilePhone', part: 'Part 10, Item 4', name: "Preparer's Mobile Telephone Number", type: 'text', realField: 'form1[0].#subform[6].Part10_Item4_MobilePhone[0]', required: false },
    { fieldId: 'I140_PreparerEmail', part: 'Part 10, Item 5', name: "Preparer's Email Address", type: 'text', realField: 'form1[0].#subform[6].Part10_Item5_Email[0]', required: false },
];

// I-765's own internal field-name numbering drifts from the current printed item numbers in
// several spots (already caught once: "Line6_EMail"/"Line7_MobileTelephoneNumber" earlier in this
// file were actually swapped on G-28; here e.g. "Pt6Line3*" on page 5 is really Part 5 Preparer's
// address, not Part 6). Every mapping below was resolved by rect position against the rendered
// blank template, not by trusting the internal name. Eligibility Category (Part 2, Item 27) and
// Reason for Applying (Part 1, Item 1) are per-case legal judgment calls with no reliable
// caseType-based default (unlike I-140's petition type) - required, but never auto-derived.
const I765_FIELD_DEFS: UscisFieldDef[] = [
    { fieldId: 'I765_G28Attached', part: 'Attorney Block', name: 'Form G-28 is Attached', type: 'toggle', realField: 'form1[0].Page1[0].Attorney-Rep[0].CheckBox1[0]', required: false },
    { fieldId: 'I765_AttyBarNumber', part: 'Attorney Block', name: 'Attorney State Bar Number', type: 'text', realField: 'form1[0].Page1[0].Attorney-Rep[0].attorneyBarNumber[0]', required: false },
    { fieldId: 'I765_AttyUscisAcct', part: 'Attorney Block', name: 'Attorney/Rep USCIS Online Account Number', type: 'text', realField: 'form1[0].Page1[0].Attorney-Rep[0].USCISELISAcctNumber[0]', required: false },
    { fieldId: 'I765_Reason', part: 'Part 1, Item 1', name: 'Reason for Applying (select only one box)', type: 'select', options: [
        { value: 'initial', label: 'Initial permission to accept employment', realField: 'form1[0].Page1[0].Part1_Checkbox[0]' },
        { value: 'replacement', label: 'Replacement of lost/stolen/damaged EAD, or correction NOT due to USCIS error', realField: 'form1[0].Page1[0].Part1_Checkbox[1]' },
        { value: 'renewal', label: 'Renewal of my permission to accept employment', realField: 'form1[0].Page1[0].Part1_Checkbox[2]' },
    ] },
    { fieldId: 'I765_FamilyName', part: 'Part 2, Item 1.a', name: 'Family Name', type: 'text', semanticKey: 'familyName', realField: 'form1[0].Page1[0].Line1a_FamilyName[0]' },
    { fieldId: 'I765_GivenName', part: 'Part 2, Item 1.b', name: 'Given Name', type: 'text', semanticKey: 'givenName', realField: 'form1[0].Page1[0].Line1b_GivenName[0]' },
    { fieldId: 'I765_MiddleName', part: 'Part 2, Item 1.c', name: 'Middle Name', type: 'text', realField: 'form1[0].Page1[0].Line1c_MiddleName[0]', required: false },
    { fieldId: 'I765_OtherName2Family', part: 'Other Names Used, Item 2.a', name: 'Other Name Used #1 - Family Name', type: 'text', realField: 'form1[0].Page1[0].Line2a_FamilyName[0]', required: false },
    { fieldId: 'I765_OtherName2Given', part: 'Other Names Used, Item 2.b', name: 'Other Name Used #1 - Given Name', type: 'text', realField: 'form1[0].Page1[0].Line2b_GivenName[0]', required: false },
    { fieldId: 'I765_OtherName2Middle', part: 'Other Names Used, Item 2.c', name: 'Other Name Used #1 - Middle Name', type: 'text', realField: 'form1[0].Page1[0].Line2c_MiddleName[0]', required: false },
    { fieldId: 'I765_OtherName3Family', part: 'Other Names Used, Item 3.a', name: 'Other Name Used #2 - Family Name', type: 'text', realField: 'form1[0].Page1[0].Line3a_FamilyName[1]', required: false },
    { fieldId: 'I765_OtherName3Given', part: 'Other Names Used, Item 3.b', name: 'Other Name Used #2 - Given Name', type: 'text', realField: 'form1[0].Page1[0].Line3b_GivenName[1]', required: false },
    { fieldId: 'I765_OtherName3Middle', part: 'Other Names Used, Item 3.c', name: 'Other Name Used #2 - Middle Name', type: 'text', realField: 'form1[0].Page1[0].Line3c_MiddleName[1]', required: false },
    { fieldId: 'I765_OtherName4Family', part: 'Other Names Used, Item 4.a', name: 'Other Name Used #3 - Family Name', type: 'text', realField: 'form1[0].Page1[0].Line3a_FamilyName[0]', required: false },
    { fieldId: 'I765_OtherName4Given', part: 'Other Names Used, Item 4.b', name: 'Other Name Used #3 - Given Name', type: 'text', realField: 'form1[0].Page1[0].Line3b_GivenName[0]', required: false },
    { fieldId: 'I765_OtherName4Middle', part: 'Other Names Used, Item 4.c', name: 'Other Name Used #3 - Middle Name', type: 'text', realField: 'form1[0].Page1[0].Line3c_MiddleName[0]', required: false },
    { fieldId: 'I765_MailInCareOf', part: 'Part 2, Item 5.a', name: 'Mailing Address - In Care Of Name', type: 'text', realField: 'form1[0].Page2[0].Line4a_InCareofName[0]', required: false },
    { fieldId: 'I765_MailStreet', part: 'Part 2, Item 5.b', name: 'Mailing Address - Street Number and Name', type: 'text', realField: 'form1[0].Page2[0].Line4b_StreetNumberName[0]', required: false },
    { fieldId: 'I765_MailUnitType', part: 'Part 2, Item 5.c', name: 'Mailing Address - Unit Type', type: 'select', required: false, options: [
        { value: 'apt', label: 'Apt.', realField: 'form1[0].Page2[0].Pt2Line5_Unit[2]' },
        { value: 'ste', label: 'Ste.', realField: 'form1[0].Page2[0].Pt2Line5_Unit[0]' },
        { value: 'flr', label: 'Flr.', realField: 'form1[0].Page2[0].Pt2Line5_Unit[1]' },
        { value: 'na', label: 'Not Applicable', realField: '' },
    ] },
    { fieldId: 'I765_MailUnitNumber', part: 'Part 2, Item 5.c', name: 'Mailing Address - Apt/Ste/Flr Number', type: 'text', realField: 'form1[0].Page2[0].Pt2Line5_AptSteFlrNumber[0]', required: false },
    { fieldId: 'I765_MailCity', part: 'Part 2, Item 5.d', name: 'Mailing Address - City or Town', type: 'text', realField: 'form1[0].Page2[0].Pt2Line5_CityOrTown[0]', required: false },
    { fieldId: 'I765_MailState', part: 'Part 2, Item 5.e', name: 'Mailing Address - State', type: 'text', realField: 'form1[0].Page2[0].Pt2Line5_State[0]', required: false },
    { fieldId: 'I765_MailZip', part: 'Part 2, Item 5.f', name: 'Mailing Address - ZIP Code', type: 'text', realField: 'form1[0].Page2[0].Pt2Line5_ZipCode[0]', required: false },
    { fieldId: 'I765_MailSameAsPhysical', part: 'Part 2, Item 6', name: 'Is Mailing Address Same as Physical Address?', type: 'select', required: false, options: [
        { value: 'yes', label: 'Yes', realField: 'form1[0].Page2[0].Part2Line5_Checkbox[1]' },
        { value: 'no', label: 'No', realField: 'form1[0].Page2[0].Part2Line5_Checkbox[0]' },
    ] },
    { fieldId: 'I765_PhysicalStreet', part: 'Part 2, Item 7.a', name: 'Physical Address - Street Number and Name', type: 'text', realField: 'form1[0].Page2[0].Pt2Line7_StreetNumberName[0]', required: false },
    { fieldId: 'I765_PhysicalUnitType', part: 'Part 2, Item 7.b', name: 'Physical Address - Unit Type', type: 'select', required: false, options: [
        { value: 'apt', label: 'Apt.', realField: 'form1[0].Page2[0].Pt2Line7_Unit[2]' },
        { value: 'ste', label: 'Ste.', realField: 'form1[0].Page2[0].Pt2Line7_Unit[0]' },
        { value: 'flr', label: 'Flr.', realField: 'form1[0].Page2[0].Pt2Line7_Unit[1]' },
        { value: 'na', label: 'Not Applicable', realField: '' },
    ] },
    { fieldId: 'I765_PhysicalUnitNumber', part: 'Part 2, Item 7.b', name: 'Physical Address - Apt/Ste/Flr Number', type: 'text', realField: 'form1[0].Page2[0].Pt2Line7_AptSteFlrNumber[0]', required: false },
    { fieldId: 'I765_PhysicalCity', part: 'Part 2, Item 7.c', name: 'Physical Address - City or Town', type: 'text', realField: 'form1[0].Page2[0].Pt2Line7_CityOrTown[0]', required: false },
    { fieldId: 'I765_PhysicalState', part: 'Part 2, Item 7.d', name: 'Physical Address - State', type: 'text', realField: 'form1[0].Page2[0].Pt2Line7_State[0]', required: false },
    { fieldId: 'I765_PhysicalZip', part: 'Part 2, Item 7.e', name: 'Physical Address - ZIP Code', type: 'text', realField: 'form1[0].Page2[0].Pt2Line7_ZipCode[0]', required: false },
    { fieldId: 'I765_ANumber', part: 'Part 2, Item 8', name: 'Alien Registration Number (A-Number)', type: 'text', semanticKey: 'aNumber', realField: 'form1[0].Page2[0].Line7_AlienNumber[0]' },
    { fieldId: 'I765_UscisAcct', part: 'Part 2, Item 9', name: 'USCIS Online Account Number', type: 'text', realField: 'form1[0].Page2[0].Line8_ElisAccountNumber[0]', required: false },
    { fieldId: 'I765_Sex', part: 'Part 2, Item 10', name: 'Sex', type: 'select', required: false, options: [
        { value: 'male', label: 'Male', realField: 'form1[0].Page2[0].Line9_Checkbox[1]' },
        { value: 'female', label: 'Female', realField: 'form1[0].Page2[0].Line9_Checkbox[0]' },
    ] },
    { fieldId: 'I765_MaritalStatus', part: 'Part 2, Item 11', name: 'Marital Status', type: 'select', required: false, options: [
        { value: 'single', label: 'Single', realField: 'form1[0].Page2[0].Line10_Checkbox[2]' },
        { value: 'married', label: 'Married', realField: 'form1[0].Page2[0].Line10_Checkbox[3]' },
        { value: 'divorced', label: 'Divorced', realField: 'form1[0].Page2[0].Line10_Checkbox[1]' },
        { value: 'widowed', label: 'Widowed', realField: 'form1[0].Page2[0].Line10_Checkbox[0]' },
    ] },
    { fieldId: 'I765_PreviouslyFiled', part: 'Part 2, Item 12', name: 'Have You Previously Filed Form I-765?', type: 'toggle', realField: 'form1[0].Page2[0].Line19_Checkbox[1]', required: false },
    { fieldId: 'I765_SSN', part: 'Part 2, Item 13', name: 'Social Security Number (if known)', type: 'text', realField: 'form1[0].Page2[0].Line12b_SSN[0]', required: false },
    { fieldId: 'I765_Nationality', part: 'Part 2, Item 14.a', name: 'Country of Citizenship or Nationality', type: 'text', semanticKey: 'nationality', realField: 'form1[0].Page2[0].Line17a_CountryOfBirth[0]' },
    { fieldId: 'I765_Nationality2', part: 'Part 2, Item 14.b', name: 'Country of Citizenship or Nationality (2nd, if dual national)', type: 'text', realField: 'form1[0].Page2[0].Line17b_CountryOfBirth[0]', required: false },
    { fieldId: 'I765_CityOfBirth', part: 'Part 2, Item 15.a', name: 'City/Town/Village of Birth', type: 'text', realField: 'form1[0].Page3[0].Line18a_CityTownOfBirth[0]', required: false },
    { fieldId: 'I765_StateProvinceOfBirth', part: 'Part 2, Item 15.b', name: 'State/Province of Birth', type: 'text', realField: 'form1[0].Page3[0].Line18b_CityTownOfBirth[0]', required: false },
    { fieldId: 'I765_CountryOfBirth', part: 'Part 2, Item 15.c', name: 'Country of Birth', type: 'text', realField: 'form1[0].Page3[0].Line18c_CountryOfBirth[0]', required: false },
    { fieldId: 'I765_DOB', part: 'Part 2, Item 16', name: 'Date of Birth', type: 'text', semanticKey: 'dob', realField: 'form1[0].Page3[0].Line19_DOB[0]' },
    { fieldId: 'I765_I94', part: 'Part 2, Item 17', name: 'Form I-94 Arrival-Departure Record Number', type: 'text', semanticKey: 'i94No', realField: 'form1[0].Page3[0].Line20a_I94Number[0]' },
    { fieldId: 'I765_Passport', part: 'Part 2, Item 18', name: 'Passport Number of Your Most Recently Issued Passport', type: 'text', semanticKey: 'passportNo', realField: 'form1[0].Page3[0].Line20b_Passport[0]' },
    { fieldId: 'I765_TravelDoc', part: 'Part 2, Item 19', name: 'Travel Document Number (if any)', type: 'text', realField: 'form1[0].Page3[0].Line20c_TravelDoc[0]', required: false },
    { fieldId: 'I765_PassportCountryIssuance', part: 'Part 2, Item 20', name: 'Country That Issued Your Passport or Travel Document', type: 'text', realField: 'form1[0].Page3[0].Line20d_CountryOfIssuance[0]', required: false },
    { fieldId: 'I765_PassportExpDate', part: 'Part 2, Item 21', name: 'Expiration Date for Passport or Travel Document', type: 'text', realField: 'form1[0].Page3[0].Line20e_ExpDate[0]', required: false },
    { fieldId: 'I765_DateOfLastEntry', part: 'Part 2, Item 22', name: 'Date of Your Last Arrival Into the U.S.', type: 'text', realField: 'form1[0].Page3[0].Line21_DateOfLastEntry[0]', required: false },
    { fieldId: 'I765_PlaceOfLastEntry', part: 'Part 2, Item 23', name: 'Place of Your Last Arrival Into the U.S.', type: 'text', realField: 'form1[0].Page3[0].place_entry[0]', required: false },
    { fieldId: 'I765_StatusAtLastEntry', part: 'Part 2, Item 24', name: 'Immigration Status at Your Last Arrival', type: 'text', realField: 'form1[0].Page3[0].Line23_StatusLastEntry[0]', required: false },
    { fieldId: 'I765_CurrentStatus', part: 'Part 2, Item 25', name: 'Your Current Immigration Status or Category', type: 'text', semanticKey: 'status', realField: 'form1[0].Page3[0].Line24_CurrentStatus[0]' },
    { fieldId: 'I765_SEVIS', part: 'Part 2, Item 26', name: 'SEVIS Number (if any)', type: 'text', realField: 'form1[0].Page3[0].Line26_SEVISnumber[0]', required: false },
    // Eligibility category format is "(a)(#)" / "(c)(#)(roman numeral)" - three boxes, one per
    // bracketed segment. Not case-type-derivable (unrelated to the I-140 EB category system this
    // app tracks), so always left for the attorney - but still required, since every I-765 needs one.
    { fieldId: 'I765_EligCategory1', part: 'Part 2, Item 27', name: 'Eligibility Category - Letter (e.g. "c")', type: 'text', realField: 'form1[0].Page3[0].#area[1].section_1[0]' },
    { fieldId: 'I765_EligCategory2', part: 'Part 2, Item 27', name: 'Eligibility Category - Number (e.g. "9")', type: 'text', realField: 'form1[0].Page3[0].#area[1].section_2[0]' },
    { fieldId: 'I765_EligCategory3', part: 'Part 2, Item 27', name: 'Eligibility Category - Sub-item (if any)', type: 'text', realField: 'form1[0].Page3[0].#area[1].section_3[0]', required: false },
    { fieldId: 'I765_STEMDegree', part: 'Part 2, Item 28.a', name: '(c)(3)(C) STEM OPT - Degree', type: 'text', realField: 'form1[0].Page3[0].Line27a_Degree[0]', required: false },
    { fieldId: 'I765_STEMEverifyEmployer', part: 'Part 2, Item 28.b', name: "(c)(3)(C) STEM OPT - Employer's Name as Listed in E-Verify", type: 'text', realField: 'form1[0].Page3[0].Line27b_Everify[0]', required: false },
    { fieldId: 'I765_STEMEverifyID', part: 'Part 2, Item 28.c', name: '(c)(3)(C) STEM OPT - E-Verify Company ID Number', type: 'text', realField: 'form1[0].Page3[0].Line27c_EverifyIDNumber[0]', required: false },
    { fieldId: 'I765_C26ReceiptNumber', part: 'Part 2, Item 29', name: '(c)(26) Eligibility - H-1B Spouse Form I-797 Receipt Number', type: 'text', realField: 'form1[0].Page3[0].Line28_ReceiptNumber[0]', required: false },
    { fieldId: 'I765_C26EverArrested', part: 'Part 2, Item 30', name: '(c)(8) Eligibility - Have You EVER Been Arrested/Convicted?', type: 'toggle', realField: 'form1[0].Page3[0].PtLine29_YesNo[0]', required: false },
    { fieldId: 'I765_C35C36ReceiptNumber', part: 'Part 2, Item 31.a', name: '(c)(35)/(c)(36) Eligibility - Form I-140 or Spouse/Parent I-797 Receipt Number', type: 'text', realField: 'form1[0].Page3[0].Line18a_Receipt[0].Line30a_ReceiptNumber[0]', required: false },
    { fieldId: 'I765_C35C36EverArrested', part: 'Part 2, Item 31.b', name: '(c)(35)/(c)(36) Eligibility - Have You EVER Been Arrested/Convicted?', type: 'toggle', realField: 'form1[0].Page3[0].PtLine30b_YesNo[0]', required: false },
    // Part 3 - Applicant's Statement/Contact/Certification. Signature fields are excluded.
    { fieldId: 'I765_StatementChoice', part: 'Part 3, Item 1', name: "Applicant's Statement (select only one box)", type: 'select', required: false, options: [
        { value: 'read_english', label: 'I can read and understand English', realField: 'form1[0].Page4[0].Pt3Line1Checkbox[1]' },
        { value: 'interpreter_read', label: 'The interpreter named in Part 4 read every question to me', realField: 'form1[0].Page4[0].Pt3Line1Checkbox[0]' },
    ] },
    { fieldId: 'I765_StatementLanguage', part: 'Part 3, Item 1.b', name: 'Language Interpreter Read To Me In', type: 'text', realField: 'form1[0].Page4[0].Pt3Line1b_Language[0]', required: false },
    { fieldId: 'I765_PreparerUsedCheckbox', part: 'Part 3, Item 2', name: 'Preparer Named in Part 5 Prepared This on My Behalf', type: 'toggle', realField: 'form1[0].Page4[0].Part3_Checkbox[0]', required: false },
    { fieldId: 'I765_PreparerUsedName', part: 'Part 3, Item 2', name: 'Preparer Name Reference (if Item 2 checked)', type: 'text', realField: 'form1[0].Page4[0].Pt3Line2_RepresentativeName[0]', required: false },
    { fieldId: 'I765_ApplicantDayPhone', part: 'Part 3, Item 3', name: "Applicant's Daytime Telephone Number", type: 'text', realField: 'form1[0].Page4[0].Pt3Line3_DaytimePhoneNumber1[0]', required: false },
    { fieldId: 'I765_ApplicantMobilePhone', part: 'Part 3, Item 4', name: "Applicant's Mobile Telephone Number", type: 'text', realField: 'form1[0].Page4[0].Pt3Line4_MobileNumber1[0]', required: false },
    { fieldId: 'I765_ApplicantEmail', part: 'Part 3, Item 5', name: "Applicant's Email Address", type: 'text', realField: 'form1[0].Page4[0].Pt3Line5_Email[0]', required: false },
    { fieldId: 'I765_ABCSettlement', part: 'Part 3, Item 6', name: 'Salvadoran/Guatemalan National Eligible Under ABC Settlement', type: 'toggle', realField: 'form1[0].Page4[0].Pt4Line6_Checkbox[0]', required: false },
    // Part 4 - Interpreter. Only applies if an interpreter was used - most filings have none.
    { fieldId: 'I765_InterpreterFamilyName', part: 'Part 4, Item 1.a', name: "Interpreter's Family Name", type: 'text', realField: 'form1[0].Page4[0].Pt4Line1a_InterpreterFamilyName[0]', required: false },
    { fieldId: 'I765_InterpreterGivenName', part: 'Part 4, Item 1.b', name: "Interpreter's Given Name", type: 'text', realField: 'form1[0].Page4[0].Pt4Line1b_InterpreterGivenName[0]', required: false },
    { fieldId: 'I765_InterpreterOrgName', part: 'Part 4, Item 2', name: "Interpreter's Business or Organization Name", type: 'text', realField: 'form1[0].Page4[0].Pt4Line2_InterpreterBusinessorOrg[0]', required: false },
    { fieldId: 'I765_InterpreterStreet', part: 'Part 4, Item 3.a', name: "Interpreter's Mailing Address - Street Number and Name", type: 'text', realField: 'form1[0].Page5[0].Pt5Line3a_StreetNumberName[0]', required: false },
    { fieldId: 'I765_InterpreterUnitType', part: 'Part 4, Item 3.b', name: "Interpreter's Mailing Address - Unit Type", type: 'select', required: false, options: [
        { value: 'apt', label: 'Apt.', realField: 'form1[0].Page5[0].Pt5Line3b_Unit[2]' },
        { value: 'ste', label: 'Ste.', realField: 'form1[0].Page5[0].Pt5Line3b_Unit[0]' },
        { value: 'flr', label: 'Flr.', realField: 'form1[0].Page5[0].Pt5Line3b_Unit[1]' },
        { value: 'na', label: 'Not Applicable', realField: '' },
    ] },
    { fieldId: 'I765_InterpreterUnitNumber', part: 'Part 4, Item 3.b', name: "Interpreter's Mailing Address - Apt/Ste/Flr Number", type: 'text', realField: 'form1[0].Page5[0].Pt5Line3b_AptSteFlrNumber[0]', required: false },
    { fieldId: 'I765_InterpreterCity', part: 'Part 4, Item 3.c', name: "Interpreter's Mailing Address - City or Town", type: 'text', realField: 'form1[0].Page5[0].Pt5Line3c_CityOrTown[0]', required: false },
    { fieldId: 'I765_InterpreterState', part: 'Part 4, Item 3.d', name: "Interpreter's Mailing Address - State", type: 'text', realField: 'form1[0].Page5[0].Pt5Line3d_State[0]', required: false },
    { fieldId: 'I765_InterpreterZip', part: 'Part 4, Item 3.e', name: "Interpreter's Mailing Address - ZIP Code", type: 'text', realField: 'form1[0].Page5[0].Pt5Line3e_ZipCode[0]', required: false },
    { fieldId: 'I765_InterpreterProvince', part: 'Part 4, Item 3.f', name: "Interpreter's Mailing Address - Province", type: 'text', realField: 'form1[0].Page5[0].Pt5Line3f_Province[0]', required: false },
    { fieldId: 'I765_InterpreterPostalCode', part: 'Part 4, Item 3.g', name: "Interpreter's Mailing Address - Postal Code", type: 'text', realField: 'form1[0].Page5[0].Pt5Line3g_PostalCode[0]', required: false },
    { fieldId: 'I765_InterpreterCountry', part: 'Part 4, Item 3.h', name: "Interpreter's Mailing Address - Country", type: 'text', realField: 'form1[0].Page5[0].Pt5Line3h_Country[0]', required: false },
    { fieldId: 'I765_InterpreterDayPhone', part: 'Part 4, Item 4', name: "Interpreter's Daytime Telephone Number", type: 'text', realField: 'form1[0].Page5[0].Pt4Line4_InterpreterDaytimeTelephone[0]', required: false },
    { fieldId: 'I765_InterpreterMobilePhone', part: 'Part 4, Item 5', name: "Interpreter's Mobile Telephone Number", type: 'text', realField: 'form1[0].Page5[0].Pt4Line5_MobileNumber[0]', required: false },
    { fieldId: 'I765_InterpreterEmail', part: 'Part 4, Item 6', name: "Interpreter's Email Address", type: 'text', realField: 'form1[0].Page5[0].Pt4Line6_Email[0]', required: false },
    { fieldId: 'I765_InterpreterLanguage', part: 'Part 4, Certification', name: 'Language Interpreted', type: 'text', realField: 'form1[0].Page5[0].Part4_NameofLanguage[0]', required: false },
    // Part 5 - Preparer, if other than the applicant. The attorney is almost always the preparer
    // in this practice, so name/firm are safely semantic-prefilled; the rest isn't.
    { fieldId: 'I765_PreparerFamilyName', part: 'Part 5, Item 1.a', name: "Preparer's Family Name", type: 'text', semanticKey: 'attorneyFamilyName', realField: 'form1[0].Page5[0].Pt5Line1a_PreparerFamilyName[0]' },
    { fieldId: 'I765_PreparerGivenName', part: 'Part 5, Item 1.b', name: "Preparer's Given Name", type: 'text', semanticKey: 'attorneyGivenName', realField: 'form1[0].Page5[0].Pt5Line1b_PreparerGivenName[0]' },
    { fieldId: 'I765_PreparerOrgName', part: 'Part 5, Item 2', name: "Preparer's Business or Organization Name", type: 'text', semanticKey: 'lawFirm', realField: 'form1[0].Page5[0].Pt5Line2_BusinessName[0]' },
    { fieldId: 'I765_PreparerStreet', part: 'Part 5, Item 3.a', name: "Preparer's Mailing Address - Street Number and Name", type: 'text', realField: 'form1[0].Page5[0].Pt6Line3a_StreetNumberName[0]', required: false },
    { fieldId: 'I765_PreparerUnitType', part: 'Part 5, Item 3.b', name: "Preparer's Mailing Address - Unit Type", type: 'select', required: false, options: [
        { value: 'apt', label: 'Apt.', realField: 'form1[0].Page5[0].Pt6Line3b_Unit[2]' },
        { value: 'ste', label: 'Ste.', realField: 'form1[0].Page5[0].Pt6Line3b_Unit[0]' },
        { value: 'flr', label: 'Flr.', realField: 'form1[0].Page5[0].Pt6Line3b_Unit[1]' },
        { value: 'na', label: 'Not Applicable', realField: '' },
    ] },
    { fieldId: 'I765_PreparerUnitNumber', part: 'Part 5, Item 3.b', name: "Preparer's Mailing Address - Apt/Ste/Flr Number", type: 'text', realField: 'form1[0].Page5[0].Pt6Line3b_AptSteFlrNumber[0]', required: false },
    { fieldId: 'I765_PreparerCity', part: 'Part 5, Item 3.c', name: "Preparer's Mailing Address - City or Town", type: 'text', realField: 'form1[0].Page5[0].Pt6Line3c_CityOrTown[0]', required: false },
    { fieldId: 'I765_PreparerState', part: 'Part 5, Item 3.d', name: "Preparer's Mailing Address - State", type: 'text', realField: 'form1[0].Page5[0].Pt6Line3d_State[0]', required: false },
    { fieldId: 'I765_PreparerZip', part: 'Part 5, Item 3.e', name: "Preparer's Mailing Address - ZIP Code", type: 'text', realField: 'form1[0].Page5[0].Pt6Line3e_ZipCode[0]', required: false },
    { fieldId: 'I765_PreparerProvince', part: 'Part 5, Item 3.f', name: "Preparer's Mailing Address - Province", type: 'text', realField: 'form1[0].Page5[0].Pt6Line3f_Province[0]', required: false },
    { fieldId: 'I765_PreparerPostalCode', part: 'Part 5, Item 3.g', name: "Preparer's Mailing Address - Postal Code", type: 'text', realField: 'form1[0].Page5[0].Pt6Line3g_PostalCode[0]', required: false },
    { fieldId: 'I765_PreparerCountry', part: 'Part 5, Item 3.h', name: "Preparer's Mailing Address - Country", type: 'text', realField: 'form1[0].Page5[0].Pt6Line3h_Country[0]', required: false },
    { fieldId: 'I765_PreparerDayPhone', part: 'Part 5, Item 4', name: "Preparer's Daytime Telephone Number", type: 'text', realField: 'form1[0].Page5[0].Pt5Line4_DaytimePhoneNumber1[0]', required: false },
    { fieldId: 'I765_PreparerFax', part: 'Part 5, Item 5', name: "Preparer's Fax Number", type: 'text', realField: 'form1[0].Page5[0].Pt5Line5_PreparerFaxNumber[0]', required: false },
    { fieldId: 'I765_PreparerEmail', part: 'Part 5, Item 6', name: "Preparer's Email Address", type: 'text', realField: 'form1[0].Page5[0].Pt5Line6_Email[0]', required: false },
    { fieldId: 'I765_PreparerStatement', part: 'Part 5, Item 7', name: "Preparer's Statement (select only one box)", type: 'select', required: false, options: [
        { value: 'not_attorney', label: 'I am not an attorney/accredited rep but prepared this with consent', realField: 'form1[0].Page6[0].Part5Line7_Checkbox[0]' },
        { value: 'is_attorney', label: 'I am an attorney/accredited representative', realField: 'form1[0].Page6[0].Part5Line7_Checkbox[1]' },
    ] },
    { fieldId: 'I765_PreparerRepExtends', part: 'Part 5, Item 7.b', name: "If Attorney/Rep - Representation Extends Beyond This Application?", type: 'select', required: false, options: [
        { value: 'extends', label: 'Extends beyond the preparation of this application', realField: 'form1[0].Page6[0].Part5Line7b_Checkbox[0]' },
        { value: 'does_not_extend', label: 'Does not extend beyond the preparation of this application', realField: 'form1[0].Page6[0].Part5Line7b_Checkbox[1]' },
    ] },
];

// I-485 is 24 pages / ~720 raw fields - by far the largest of the four forms, and the only one
// with a block (Part 9, "General Eligibility and Inadmissibility Grounds") of ~85 individual
// legal yes/no questions where a wrong answer is a real accusation of criminal/immigration
// misconduct, not a cosmetic mistake. Given that scale, coverage here is intentionally narrower
// than the other three forms: full rigor (real field verified by rendering the template, exact
// question text) for identity, the immigrant category, and every Part 9 question - which is what
// actually carries legal risk - but the large secondary sections (parents, marital history,
// children, employment/address history, biographic detail) are left for the attorney to complete
// directly on the real PDF via the "Open Official Blank PDF" link, rather than surfaced here.
// Internal field names drift from current item numbers in the same way as the other 3 forms
// (e.g. "Pt8LineNN" fields are frequently Part 9 questions, not Part 8) - every mapping below was
// resolved by rect position against the rendered template, not by trusting the internal name.
const I485_PART9_ITEMS: [string, string, string][] = [
    ['1', 'Have you EVER been a member of, involved in, or in any way associated with any organization, association, fund, foundation, party, club, society, or similar group in the United States or in any other location in the world?', 'form1[0].#subform[12].Pt8Line1_YesNo[1]'],
    ['10', 'Have you EVER been denied admission to the United States?', 'form1[0].#subform[13].Pt9Line10_YesNo[1]'],
    ['11', 'Have you EVER been denied a visa to the United States?', 'form1[0].#subform[13].Pt9Line11_YesNo[0]'],
    ['12', 'Have you EVER worked in the United States without authorization?', 'form1[0].#subform[13].Pt9Line12_YesNo[0]'],
    ['13', 'Have you EVER violated the terms or conditions of your nonimmigrant status?', 'form1[0].#subform[13].Pt8Line13_YesNo[1]'],
    ['14', 'Are you presently or have you EVER been in removal, exclusion, rescission, or deportation proceedings, including expedited removal proceedings?', 'form1[0].#subform[13].Pt8Line18_YesNo[0]'],
    ['15', 'Have you EVER been issued a final order of exclusion, deportation, or removal?', 'form1[0].#subform[13].Pt8Line19_YesNo[1]'],
    ['16', 'Have you EVER had a prior final order of exclusion, deportation, or removal reinstated?', 'form1[0].#subform[13].Pt8Line20_YesNo[0]'],
    ['17', 'Have you EVER been granted voluntary departure by an immigration officer or an immigration judge but failed to depart within the allotted time?', 'form1[0].#subform[13].Pt8Line17_YesNo[0]'],
    ['18', 'Have you EVER applied for any kind of relief or protection from removal, exclusion, or deportation?', 'form1[0].#subform[13].Pt8Line23_YesNo[1]'],
    ['19', 'Have you EVER been a J nonimmigrant exchange visitor who was subject to the two-year foreign residence requirement?', 'form1[0].#subform[13].Pt8Line24a_YesNo[0]'],
    ['20', 'If you answered "Yes" to Item Number 19, have you complied with the foreign residence requirement?', 'form1[0].#subform[13].Pt8Line24b_YesNo[1]'],
    ['21', 'If you answered "Yes" to Item Number 19 and "No" to Item Number 20, have you been granted a waiver or has Department of State issued a favorable waiver recommendation letter for you?', 'form1[0].#subform[13].Pt8Line24c_YesNo[0]'],
    ['22', 'Have you EVER been arrested, cited, charged, or permitted to participate in a diversion program, or detained for any reason by any law enforcement official?', 'form1[0].#subform[13].Pt8Line22_YesNo[0]'],
    ['23', 'Have you EVER committed a crime of any kind (even if you were not arrested, cited, charged with, or tried for that crime, or convicted)?', 'form1[0].#subform[14].Pt9Line23_YesNo[1]'],
    ['24', 'Have you EVER pled guilty to or been convicted of a crime or offense (even if the violation was subsequently expunged or sealed, or you were granted a pardon, amnesty, rehabilitation decree, or other act of clemency)?', 'form1[0].#subform[14].Pt9Line24_YesNo[0]'],
    ['25', 'Have you EVER been ordered punished by a judge or had conditions imposed on you that restrained your liberty (prison sentence, suspended sentence, house arrest, parole, alternative sentencing, drug/alcohol treatment, probation, or community service)?', 'form1[0].#subform[14].Pt8Line25_YesNo[1]'],
    ['26', 'Have you EVER violated (or attempted or conspired to violate) any controlled substance law or regulation of a state, the United States, or a foreign country?', 'form1[0].#subform[14].Pt8Line26_YesNo[1]'],
    ['27', 'Have you EVER trafficked in or benefited from, or knowingly aided, abetted, assisted, conspired, or colluded in the illegal trafficking of any controlled substances?', 'form1[0].#subform[14].Pt8Line27_YesNo[1]'],
    ['28', 'Are you the spouse, son, or daughter of an alien who illicitly trafficked a controlled substance and you obtained, within the last 5 years, any financial or other benefit from that activity?', 'form1[0].#subform[14].Pt8Line28_YesNo[1]'],
    ['29', 'If your answer to Item Number 28 is "Yes," did you know or should you have reasonably known that the financial or other benefit resulted from that activity?', 'form1[0].#subform[14].Pt8Line29_YesNo[1]'],
    ['30', 'Have you EVER engaged in prostitution or are you coming to the United States to engage in prostitution?', 'form1[0].#subform[14].Pt8Line30_YesNo[1]'],
    ['31', 'Have you EVER directly or indirectly procured or attempted to procure, or imported prostitutes or persons for the purpose of prostitution?', 'form1[0].#subform[14].Pt8Line31_YesNo[0]'],
    ['32', 'Have you EVER received any proceeds or money from prostitution?', 'form1[0].#subform[14].Pt8Line32_YesNo[0]'],
    ['33', 'Do you intend to engage in illegal gambling or any other form of commercialized vice, such as prostitution, bootlegging, or the sale of child pornography, while in the United States?', 'form1[0].#subform[14].Pt8Line33_YesNo[0]'],
    ['34', 'Have you EVER exercised immunity (diplomatic or otherwise) to avoid being prosecuted for a criminal offense in the United States?', 'form1[0].#subform[14].Pt8Line34_YesNo[1]'],
    ['35.a', 'Have you EVER served as a foreign government official?', 'form1[0].#subform[14].Pt8Line35a_YesNo[0]'],
    ['35.b', 'If your answer to Item Number 35.a. is "Yes," have you EVER been responsible for, enforced, or directly carried out violations of religious freedoms?', 'form1[0].#subform[14].Pt8Line35b_YesNo[1]'],
    ['36', 'Have you EVER induced by force, fraud, or coercion (or otherwise been involved in) the trafficking of another person for commercial sex acts (sex trafficking)?', 'form1[0].#subform[14].Pt8Line36_YesNo[1]'],
    ['37', 'Have you EVER trafficked a person into involuntary servitude, peonage, debt bondage, or slavery?', 'form1[0].#subform[14].Pt8Line37_YesNo[1]'],
    ['38', 'Have you EVER knowingly aided, abetted, assisted, conspired, or colluded with others in trafficking in persons for commercial sex acts or involuntary servitude, peonage, debt bondage, or slavery?', 'form1[0].#subform[15].Pt8Line38_YesNo[0]'],
    ['39', 'Are you the spouse, son, or daughter of an alien who engaged in trafficking in persons and have received or obtained, within the last 5 years, any financial or other benefits from this activity of your spouse or parent?', 'form1[0].#subform[15].Pt9Line39_YesNo[1]'],
    ['40', 'If your answer is "Yes" to Item Number 39, did you know or reasonably should have known that this benefit resulted from this activity of your spouse or parent?', 'form1[0].#subform[15].Pt8Line40_YesNo[1]'],
    ['41', 'Have you EVER engaged in money laundering, knowingly aided/assisted/abetted/conspired/colluded with others in money laundering, or do you seek to enter the U.S. to engage in such activity?', 'form1[0].#subform[15].Pt8Line41_YesNo[0]'],
    ['42.a', 'Do you intend to engage in any activity that violates or evades any law relating to espionage (including spying) or sabotage in the United States?', 'form1[0].#subform[15].Pt8Line42\\.a_YesNo[0]'],
    ['42.b', 'Do you intend to engage in any activity in the United States that violates or evades any law prohibiting the export from the United States of goods, technology, or sensitive information?', 'form1[0].#subform[15].Pt8Line42\\.b_YesNo[1]'],
    ['42.c', 'Do you intend to engage in any activity whose purpose includes opposing, controlling, or overthrowing the U.S. Government by force, violence, or other unlawful means while in the United States?', 'form1[0].#subform[15].Pt8Line42c_YesNo[1]'],
    ['42.d', 'Do you intend to engage in any other unlawful activity?', 'form1[0].#subform[15].Pt8Line42d_YesNo[0]'],
    ['43.a', 'Have you EVER received any weapons training, paramilitary training, or other military-type training?', 'form1[0].#subform[15].Pt8Line43a_YesNo[1]'],
    ['43.b', 'Have you EVER committed kidnapping, assassination, or hijacking or sabotage of a conveyance (including an aircraft, vessel, vehicle, or train)?', 'form1[0].#subform[15].Pt8Line43b_YesNo[0]'],
    ['43.c', 'Have you EVER used a weapon or explosive or any dangerous device with the intent to endanger the safety of another person or people or cause damage to property?', 'form1[0].#subform[15].Pt8Line43c_YesNo[0]'],
    ['43.d', 'Have you EVER threatened, attempted, conspired, prepared, or planned to do any of the things described in Item Numbers 43.b. - 43.c.?', 'form1[0].#subform[15].Pt8Line43d_YesNo[0]'],
    ['43.e', 'Have you EVER incited, under circumstances indicating an intention to cause death or serious bodily harm/injury, any of the activities described in Item Numbers 43.b. - 43.c.?', 'form1[0].#subform[15].Pt8Line43e_YesNo[0]'],
    ['43.f', 'Have you EVER participated in, or been a member of, a group or organization that did any of the activities described in Item Numbers 43.b. - 43.e.?', 'form1[0].#subform[15].Pt8Line43fYesNo[0]'],
    ['43.g', 'Have you EVER recruited members or asked for money or things of value for a group or organization that did any of the activities described in Item Numbers 43.b. - 43.e.?', 'form1[0].#subform[15].Pt8Line43g_YesNo[0]'],
    ['43.h', 'Have you EVER provided money, a thing of value, services or labor, or any other assistance or support for any of the activities described in Item Numbers 43.b. - 43.e.?', 'form1[0].#subform[15].Pt8Line43h_YesNo[1]'],
    ['43.i', 'Have you EVER provided money, a thing of value, services or labor, or any other assistance or support for an individual, group, or organization who did any of the activities described in Item Numbers 43.b. - 43.e.?', 'form1[0].#subform[15].Pt8Line43i_YesNo[1]'],
    ['44', 'Do you intend to engage in any of the activities listed in any part of Item Numbers 43.b. - 43.e.?', 'form1[0].#subform[15].Pt8Line44_YesNo[0]'],
    ['45', 'Do you intend to engage in any activity that could endanger the welfare, safety, or security of the United States?', 'form1[0].#subform[15].Pt8Line45_YesNo[1]'],
    ['46', 'Are you the spouse or child of an individual who EVER engaged in any of the activities listed in Item Numbers 43.b. - 43.i.?', 'form1[0].#subform[16].Pt8Line46_YesNo[0]'],
    ['47', 'Have you EVER sold, provided, or transported weapons, or assisted any person in selling, providing, or transporting weapons, which you knew or believed would be used against another person?', 'form1[0].#subform[16].Pt8Line47_YesNo[1]'],
    ['48', 'Have you EVER worked, volunteered, or otherwise served in any prison, jail, prison camp, detention facility, labor camp, or any other place where people were detained, or directed/participated in any activity that involved detaining people?', 'form1[0].#subform[16].Pt8Line48_YesNo[1]'],
    ['49', 'Have you EVER been a member of, assisted, or participated in any group, unit, or organization of any kind in which you or other persons used any type of weapon against any person or threatened to do so?', 'form1[0].#subform[16].Pt8Line49_YesNo[0]'],
    ['50', 'Have you EVER served in, been a member of, assisted (helped), or participated in any military or police unit?', 'form1[0].#subform[16].Pt8Line50_YesNo[1]'],
    ['51', 'Have you EVER served in, been a member of, assisted (helped), or participated in any armed group (paramilitary unit, self-defense unit, vigilante unit, rebel group, or guerrilla group)?', 'form1[0].#subform[16].Pt8Line51_YesNo[0]'],
    ['52', 'Have you EVER been a member of, or in any way affiliated with, the Communist Party or any totalitarian party (in the United States or abroad)?', 'form1[0].#subform[16].Pt8Line52_YesNo[1]'],
    ['53.a', 'Have you EVER ordered, incited, called for, committed, assisted, helped with, or otherwise participated in Torture?', 'form1[0].#subform[16].Pt8Line53a_YesNo[0]'],
    ['53.b', 'Have you EVER ordered, incited, called for, committed, assisted, helped with, or otherwise participated in Genocide?', 'form1[0].#subform[16].Pt8Line53b_YesNo[0]'],
    ['53.c', 'Have you EVER ordered, incited, called for, committed, assisted, helped with, or otherwise participated in killing, or trying to kill, any person?', 'form1[0].#subform[16].Pt8Line53c_YesNo[0]'],
    ['53.d', 'Have you EVER ordered, incited, called for, committed, assisted, helped with, or otherwise participated in intentionally and severely injuring or trying to injure any person?', 'form1[0].#subform[16].Pt8Line53d_YesNo[1]'],
    ['54', 'Have you EVER recruited, enlisted, conscripted, or used any person under 15 years of age to take part in hostilities or to serve in or help an armed force or group, or attempted or worked with others to do so?', 'form1[0].#subform[16].Pt8Line54_YesNo[1]'],
    ['55', 'Have you EVER used any person under 15 years of age to take part in hostilities (combat, sabotage, courier, transporting supplies), or attempted or worked with others to do so?', 'form1[0].#subform[16].Pt8Line55_YesNo[0]'],
    ['63', 'Have you ever received Supplemental Security Income (SSI), Temporary Assistance for Needy Families (TANF), or state/Tribal/territorial/local cash benefit programs for income maintenance?', 'form1[0].#subform[18].Pt9Line63_YesNo[0]'],
    ['64', 'Have you ever received long-term institutionalization at government expense?', 'form1[0].#subform[18].Pt9Line64_YesNo[0]'],
    ['67', 'Have you EVER failed or refused to attend or to remain in attendance at any removal proceeding filed against you on or after April 1, 1997?', 'form1[0].#subform[20].Pt9Line67_YesNo[1]'],
    ['68', 'Have you EVER submitted altered, fraudulent, or counterfeit documentation to any U.S. Government official to obtain or attempt to obtain any immigration benefit?', 'form1[0].#subform[20].Pt9Line68_YesNo[0]'],
    ['69', 'Have you EVER lied about, concealed, or misrepresented any information on an application or petition to obtain a visa, other documentation, admission to the United States, or any other immigration benefit?', 'form1[0].#subform[20].Pt9Line69_YesNo[1]'],
    ['70', 'Have you EVER falsely claimed to be a U.S. citizen (in writing or any other way)?', 'form1[0].#subform[20].Pt9Line70_YesNo[0]'],
    ['71', 'Have you EVER been a stowaway on a vessel or aircraft arriving in the United States?', 'form1[0].#subform[20].Pt9Line71_YesNo[1]'],
    ['72', 'Have you EVER knowingly encouraged, induced, assisted, abetted, or aided any alien to enter or to try to enter the United States illegally (alien smuggling)?', 'form1[0].#subform[20].Pt9Line72_YesNo[0]'],
    ['73', 'Are you under a final order of civil penalty for violating INA section 274C for use of fraudulent documents?', 'form1[0].#subform[20].Pt9Line73_YesNo[1]'],
    ['74', 'Have you EVER been excluded, deported, or removed from the United States, or ever departed the United States on your own after having been ordered excluded, deported, or removed?', 'form1[0].#subform[20].Pt9Line74_YesNo[1]'],
    ['75', 'Have you EVER entered the United States without being inspected and admitted or paroled?', 'form1[0].#subform[20].Pt9Line75_YesNo[0]'],
    ['76', 'Since April 1, 1997, have you been unlawfully present in the United States (present after expiration of authorized stay, or present without being admitted or paroled)?', 'form1[0].#subform[21].Pt9Line76_YesNo[1]'],
    ['77', 'If you answered "Yes" to Item Number 76, was a severe form of trafficking in persons at least one central reason for your unlawful presence in the United States?', 'form1[0].#subform[21].Pt9Line77_YesNo[0]'],
    ['78.a', 'Since April 1, 1997, have you EVER reentered or attempted to reenter the United States without being inspected and admitted or paroled, after having been unlawfully present for more than one year in the aggregate on or after April 1, 1997?', 'form1[0].#subform[21].Pt9Line78a_YesNo[1]'],
    ['78.b', 'Since April 1, 1997, have you EVER reentered or attempted to reenter the United States without being inspected and admitted or paroled, after having been deported, excluded, or removed from the United States?', 'form1[0].#subform[21].Pt9Line78b_YesNo[0]'],
    ['79', 'Do you plan to practice polygamy in the United States?', 'form1[0].#subform[21].Pt9Line79_YesNo[0]'],
    ['80', 'Are you accompanying an alien who is inadmissible and who has been certified by a medical officer as helpless from sickness, mental or physical disability, or infancy, and who requires your protection or guardianship?', 'form1[0].#subform[21].Pt9Line80_YesNo[1]'],
    ['81', 'Have you EVER assisted in detaining, retaining, or withholding custody of a U.S. citizen child outside the United States from a person who has been granted custody of the child?', 'form1[0].#subform[21].Pt9Line81_YesNo[0]'],
    ['82', 'Have you EVER voted in violation of any Federal, state, or local constitutional provision, statute, ordinance, or regulation in the United States?', 'form1[0].#subform[21].Pt9Line82_YesNo[1]'],
    ['83', 'Have you EVER renounced U.S. citizenship to avoid being taxed by the United States?', 'form1[0].#subform[21].Pt9Line83_YesNo[0]'],
    ['84.a', 'Have you EVER applied for exemption or discharge from training or service in the U.S. armed forces or in the U.S. National Security Training Corps on the ground that you are an alien?', 'form1[0].#subform[21].Pt9Line84a_YesNo[1]'],
    ['84.b', 'Have you EVER been relieved or discharged from such training or service on the ground that you are an alien?', 'form1[0].#subform[21].Pt9Line84b_YesNo[1]'],
    ['84.c', 'Have you EVER been convicted of desertion from the U.S. armed forces?', 'form1[0].#subform[21].Pt9Line84c_YesNo[1]'],
    ['85', 'Have you EVER left or remained outside the United States to avoid or evade training or service in the U.S. armed forces in time of war or a period declared by the President to be a national emergency?', 'form1[0].#subform[21].Pt9Line85_YesNo[1]'],
];

const I485_FIELD_DEFS: UscisFieldDef[] = [
    { fieldId: 'I485_G28Attached', part: 'Attorney Block', name: 'Form G-28 is Attached', type: 'toggle', realField: 'form1[0].#subform[0].CheckBox1[0]', required: false },
    { fieldId: 'I485_VolagNumber', part: 'Attorney Block', name: 'Volag Number', type: 'text', realField: 'form1[0].#subform[0].VolagNumber[0]', required: false },
    { fieldId: 'I485_AttyBarNumber', part: 'Attorney Block', name: 'Attorney State Bar Number', type: 'text', realField: 'form1[0].#subform[0].AttorneyStateBarNumber[0]', required: false },
    { fieldId: 'I485_AttyUscisAcct', part: 'Attorney Block', name: 'Attorney/Rep USCIS Online Account Number', type: 'text', realField: 'form1[0].#subform[0].USCISOnlineAcctNumber[0]', required: false },
    { fieldId: 'I485_FamilyName', part: 'Part 1, Item 1', name: 'Family Name', type: 'text', semanticKey: 'familyName', realField: 'form1[0].#subform[0].Pt1Line1_FamilyName[0]' },
    { fieldId: 'I485_GivenName', part: 'Part 1, Item 1', name: 'Given Name', type: 'text', semanticKey: 'givenName', realField: 'form1[0].#subform[0].Pt1Line1_GivenName[0]' },
    { fieldId: 'I485_MiddleName', part: 'Part 1, Item 1', name: 'Middle Name', type: 'text', realField: 'form1[0].#subform[0].Pt1Line1_MiddleName[0]', required: false },
    { fieldId: 'I485_DOB', part: 'Part 1, Item 3', name: 'Date of Birth', type: 'text', semanticKey: 'dob', realField: 'form1[0].#subform[0].Pt1Line3_DOB[0]' },
    { fieldId: 'I485_HaveANumber', part: 'Part 1, Item 4', name: 'Do You Have an Alien Registration Number (A-Number)?', type: 'toggle', realField: 'form1[0].#subform[1].Pt1Line4_YN[0]', required: false },
    { fieldId: 'I485_ANumber', part: 'Part 1, Item 4', name: 'Alien Registration Number (A-Number)', type: 'text', semanticKey: 'aNumber', realField: 'form1[0].#subform[1].Pt1Line4_AlienNumber[0]' },
    { fieldId: 'I485_Sex', part: 'Part 1, Item 6', name: 'Sex', type: 'select', required: false, options: [
        { value: 'male', label: 'Male', realField: 'form1[0].#subform[1].Pt1Line6_CB_Sex[1]' },
        { value: 'female', label: 'Female', realField: 'form1[0].#subform[1].Pt1Line6_CB_Sex[0]' },
    ] },
    { fieldId: 'I485_CityOfBirth', part: 'Part 1, Item 7', name: 'City or Town of Birth', type: 'text', realField: 'form1[0].#subform[1].Pt1Line7_CityTownOfBirth[0]', required: false },
    { fieldId: 'I485_CountryOfBirth', part: 'Part 1, Item 7', name: 'Country of Birth', type: 'text', realField: 'form1[0].#subform[1].Pt1Line7_CountryOfBirth[0]', required: false },
    { fieldId: 'I485_Nationality', part: 'Part 1, Item 8', name: 'Country of Citizenship or Nationality', type: 'text', semanticKey: 'nationality', realField: 'form1[0].#subform[1].Pt1Line8_CountryofCitizenshipNationality[0]' },
    { fieldId: 'I485_UscisAcct', part: 'Part 1, Item 9', name: 'USCIS Online Account Number', type: 'text', realField: 'form1[0].#subform[1].Pt1Line9_USCISAccountNumber[0]', required: false },
    { fieldId: 'I485_PassportNo', part: 'Part 1, Item 10', name: 'Passport or Travel Document Number Used at Last Arrival', type: 'text', semanticKey: 'passportNo', realField: 'form1[0].#subform[1].Pt1Line10_PassportNum[0]' },
    { fieldId: 'I485_PassportExpDate', part: 'Part 1, Item 10', name: 'Expiration Date of Passport or Travel Document', type: 'text', realField: 'form1[0].#subform[1].Pt1Line10_ExpDate[0]', required: false },
    { fieldId: 'I485_PassportCountry', part: 'Part 1, Item 10', name: 'Country That Issued Passport or Travel Document', type: 'text', realField: 'form1[0].#subform[1].Pt1Line10_Passport[0]', required: false },
    { fieldId: 'I485_ArrivalCity', part: 'Part 1, Item 10', name: 'City or Town of Last Arrival', type: 'text', realField: 'form1[0].#subform[1].Pt1Line10_CityTown[0]', required: false },
    { fieldId: 'I485_ArrivalDate', part: 'Part 1, Item 10', name: 'Date of Last Arrival', type: 'text', realField: 'form1[0].#subform[1].Pt1Line10_DateofArrival[0]', required: false },
    { fieldId: 'I485_LastEntryManner', part: 'Part 1, Item 11', name: 'When I Last Arrived in the United States (select only one)', type: 'select', required: false, options: [
        { value: 'admitted', label: 'Inspected at a Port of Entry and admitted as', realField: 'form1[0].#subform[1].Pt2Line11_CB[0]' },
        { value: 'paroled', label: 'Inspected at a Port of Entry and paroled as', realField: 'form1[0].#subform[1].Pt2Line11_CB[1]' },
        { value: 'no_admission', label: 'Came into the United States without admission or parole', realField: 'form1[0].#subform[1].Pt2Line11_CB[2]' },
        { value: 'other', label: 'Other', realField: 'form1[0].#subform[1].Pt2Line11_CB[3]' },
    ] },
    { fieldId: 'I485_I94Number', part: 'Part 1, Item 12', name: 'Form I-94 Arrival-Departure Record Number', type: 'text', semanticKey: 'i94No', realField: 'form1[0].#subform[2].P1Line12_I94[0]' },
    { fieldId: 'I485_I94Status', part: 'Part 1, Item 12', name: 'Immigration Status on Form I-94', type: 'text', realField: 'form1[0].#subform[2].Pt1Line12_Status[0]', required: false },
    { fieldId: 'I485_CurrentStatus', part: 'Part 1, Item 14', name: 'Current Immigration Status (if changed since last arrival)', type: 'text', semanticKey: 'status', realField: 'form1[0].#subform[2].Pt1Line14_Status[0]' },
    { fieldId: 'I485_PhysicalStreet', part: 'Part 1, Item 18', name: 'Current U.S. Physical Address - Street Number and Name', type: 'text', realField: 'form1[0].#subform[2].Pt1Line18_StreetNumberName[0]', required: false },
    { fieldId: 'I485_PhysicalCity', part: 'Part 1, Item 18', name: 'Current U.S. Physical Address - City or Town', type: 'text', realField: 'form1[0].#subform[2].Pt1Line18_CityOrTown[0]', required: false },
    { fieldId: 'I485_PhysicalState', part: 'Part 1, Item 18', name: 'Current U.S. Physical Address - State', type: 'text', realField: 'form1[0].#subform[2].Pt1Line18_State[0]', required: false },
    { fieldId: 'I485_PhysicalZip', part: 'Part 1, Item 18', name: 'Current U.S. Physical Address - ZIP Code', type: 'text', realField: 'form1[0].#subform[2].Pt1Line18_ZipCode[0]', required: false },
    // Part 2 - Application Type/Filing Category. This app's supported case types (eb1a/eb2_niw/
    // l1a) are all in the Employment-based sub-list (Item 3.b) - the much larger family-based /
    // special-immigrant / asylee / diversity-visa option lists (Items 3.a, 3.c-3.g, ~30 more
    // checkboxes) aren't modeled since this practice doesn't file those categories.
    { fieldId: 'I485_ImmigrantCategory', part: 'Part 2, Item 3.b', name: 'Immigrant Category (Employment-Based) - select only one', type: 'select', caseTypeMap: { eb1a: 'extraordinary', l1a: 'multinational', eb2_niw: 'niw' }, options: [
        { value: 'extraordinary', label: 'Alien of Extraordinary Ability', realField: 'form1[0].#subform[5].Pt2Line3b_CB140[0]' },
        { value: 'professor', label: 'Outstanding Professor or Researcher', realField: 'form1[0].#subform[5].Pt2Line3b_CB140[1]' },
        { value: 'multinational', label: 'Multinational Executive or Manager', realField: 'form1[0].#subform[5].Pt2Line3b_CB140[2]' },
        { value: 'advanced_degree', label: 'Member of Professions w/ Advanced Degree or Exceptional Ability (NOT seeking NIW)', realField: 'form1[0].#subform[5].Pt2Line3b_CB140[3]' },
        { value: 'professional', label: 'A Professional', realField: 'form1[0].#subform[5].Pt2Line3b_CB140[4]' },
        { value: 'skilled', label: 'A Skilled Worker', realField: 'form1[0].#subform[5].Pt2Line3b_CB140[5]' },
        { value: 'other_worker', label: 'Any Other Worker', realField: 'form1[0].#subform[5].Pt2Line3b_CB140[6]' },
        { value: 'niw', label: 'An Alien Applying For a National Interest Waiver', realField: 'form1[0].#subform[5].Pt2Line3b_CB140[7]' },
    ] },
    { fieldId: 'I485_245i', part: 'Part 2, Item 4', name: 'Applying for Adjustment Based on INA Section 245(i)?', type: 'toggle', realField: 'form1[0].#subform[6].Pt2Line4_CB[1]', required: false },
    { fieldId: 'I485_CSPA', part: 'Part 2, Item 5', name: 'Applying for Adjustment Based on Child Status Protection Act (CSPA)?', type: 'toggle', realField: 'form1[0].#subform[6].Pt2Line5_CB[1]', required: false },
    // Part 8 - Biographic Information (ethnicity/race/eye-hair color/height/weight). Not
    // case-derivable and low legal stakes compared to Part 9, so optional rather than required.
    { fieldId: 'I485_Ethnicity', part: 'Part 8, Item 1', name: 'Ethnicity', type: 'select', required: false, options: [
        { value: 'hispanic', label: 'Hispanic or Latino', realField: 'form1[0].#subform[12].Pt7Line1_Ethnicity[0]' },
        { value: 'not_hispanic', label: 'Not Hispanic or Latino', realField: 'form1[0].#subform[12].Pt7Line1_Ethnicity[1]' },
    ] },
    { fieldId: 'I485_EyeColor', part: 'Part 8, Item 5', name: 'Eye Color', type: 'select', required: false, options: [
        { value: 'black', label: 'Black', realField: 'form1[0].#subform[12].Pt7Line5_Eyecolor[1]' },
        { value: 'blue', label: 'Blue', realField: 'form1[0].#subform[12].Pt7Line5_Eyecolor[0]' },
        { value: 'brown', label: 'Brown', realField: 'form1[0].#subform[12].Pt7Line5_Eyecolor[2]' },
        { value: 'gray', label: 'Gray', realField: 'form1[0].#subform[12].Pt7Line5_Eyecolor[3]' },
        { value: 'green', label: 'Green', realField: 'form1[0].#subform[12].Pt7Line5_Eyecolor[4]' },
        { value: 'hazel', label: 'Hazel', realField: 'form1[0].#subform[12].Pt7Line5_Eyecolor[5]' },
        { value: 'maroon', label: 'Maroon', realField: 'form1[0].#subform[12].Pt7Line5_Eyecolor[6]' },
        { value: 'pink', label: 'Pink', realField: 'form1[0].#subform[12].Pt7Line5_Eyecolor[7]' },
        { value: 'unknown', label: 'Unknown/Other', realField: 'form1[0].#subform[12].Pt7Line5_Eyecolor[8]' },
    ] },
    { fieldId: 'I485_HairColor', part: 'Part 8, Item 6', name: 'Hair Color', type: 'select', required: false, options: [
        { value: 'bald', label: 'Bald (No hair)', realField: 'form1[0].#subform[12].Pt7Line6_Haircolor[0]' },
        { value: 'black', label: 'Black', realField: 'form1[0].#subform[12].Pt7Line6_Haircolor[1]' },
        { value: 'blond', label: 'Blond', realField: 'form1[0].#subform[12].Pt7Line6_Haircolor[2]' },
        { value: 'brown', label: 'Brown', realField: 'form1[0].#subform[12].Pt7Line6_Haircolor[3]' },
        { value: 'gray', label: 'Gray', realField: 'form1[0].#subform[12].Pt7Line6_Haircolor[4]' },
        { value: 'red', label: 'Red', realField: 'form1[0].#subform[12].Pt7Line6_Haircolor[5]' },
        { value: 'sandy', label: 'Sandy', realField: 'form1[0].#subform[12].Pt7Line6_Haircolor[6]' },
        { value: 'white', label: 'White', realField: 'form1[0].#subform[12].Pt7Line6_Haircolor[7]' },
        { value: 'other', label: 'Unknown/Other', realField: 'form1[0].#subform[12].Pt7Line6_Haircolor[8]' },
    ] },
    // Part 9 - General Eligibility and Inadmissibility Grounds. Every item here is required:
    // these are exactly the ~85 legal yes/no questions that make I-485 legally risky to guess at,
    // so none are auto-derived and none are skippable - the attorney must answer every one.
    ...I485_PART9_ITEMS.map(([item, question, realField]): UscisFieldDef => ({
        fieldId: `I485_Pt9_${item.replace('.', '')}`,
        part: `Part 9, Item ${item}`,
        name: question,
        type: 'toggle',
        realField,
        required: true,
    })),
    // Part 12 - Preparer (attorney is almost always the preparer in this practice).
    { fieldId: 'I485_PreparerFamilyName', part: 'Part 12, Item 1', name: "Preparer's Family Name", type: 'text', semanticKey: 'attorneyFamilyName', realField: 'form1[0].#subform[23].Pt12Line1_PreparerFamilyName[0]' },
    { fieldId: 'I485_PreparerGivenName', part: 'Part 12, Item 1', name: "Preparer's Given Name", type: 'text', semanticKey: 'attorneyGivenName', realField: 'form1[0].#subform[23].Pt12Line1a_PreparerGivenName[0]' },
    { fieldId: 'I485_PreparerOrgName', part: 'Part 12, Item 2', name: "Preparer's Business or Organization Name", type: 'text', semanticKey: 'lawFirm', realField: 'form1[0].#subform[23].Pt12Line2_BusinessName[0]' },
];

// Builds review-table rows for a manifest-driven (full-coverage) form. Every row must end up
// with a non-empty `value` before sign-off is allowed (see the sign-off endpoint below) - for
// `toggle`/`select` fields that means the attorney must make an explicit choice, not just leave
// the default unchecked state, so there is no ambiguity between "answered no" and "never reviewed".
const buildDefinedFields = (defs: UscisFieldDef[], canonicalValues: Record<string, { value: string; source: string; confidence: string }>, mergedOverrides: Record<string, string>, caseType?: string) => {
    return defs.map((def) => {
        if (def.semanticKey && canonicalValues[def.semanticKey]) {
            return { ...def, ...canonicalValues[def.semanticKey] };
        }
        const overrideVal = mergedOverrides[def.fieldId];
        if (overrideVal !== undefined && overrideVal !== '') {
            const label = def.type === 'select' ? (def.options?.find(o => o.value === overrideVal)?.label || overrideVal)
                : def.type === 'toggle' ? (overrideVal === 'true' ? 'Yes' : 'No')
                : overrideVal;
            // Source is set to the same sentinel the generic cross-form override pass (below,
            // in buildAutofillFormsData) checks for, so it doesn't re-clobber this already-formatted
            // label with the raw stored override string (e.g. 'true'/'apt' instead of 'Yes'/'Apt.').
            return { ...def, value: label, source: 'Attorney Override (Verified)', confidence: 'verified' };
        }
        // Some `select` fields (petition type, petitioner type) are safely derivable from the
        // case's own playbook scenario, same as the legacy caseType-based text used to be - not a
        // guess, since the case type is already a structured fact about this specific case.
        if (def.type === 'select' && def.caseTypeMap && caseType && def.caseTypeMap[caseType]) {
            const derivedVal = def.caseTypeMap[caseType];
            const label = def.options?.find(o => o.value === derivedVal)?.label || derivedVal;
            return { ...def, value: label, source: 'Case Type (Derived)', confidence: 'high' };
        }
        return { ...def, value: '', source: 'Missing', confidence: 'low' };
    });
};

const buildAutofillFormsData = (record: any, mergedOverrides: Record<string, string>) => {
    const facts = record.analysis?.facts || {};
    const answers = record.answers || {};
    const caseType = record.caseType || 'eb1a';

    // Collapse fieldId-keyed overrides down to the semantic person-attribute they represent,
    // so an edit made while looking at one form is reflected on every other form too.
    const semanticOverrides: Record<string, string> = {};
    Object.entries(mergedOverrides || {}).forEach(([fieldId, value]) => {
        const semanticKey = AUTOFILL_FIELD_SEMANTIC_MAP[fieldId];
        if (semanticKey && value !== undefined && value !== '') {
            semanticOverrides[semanticKey] = value;
        }
    });

    const getValue = (keys: string[], defaultVal: string = '', semanticKey?: string) => {
        if (semanticKey && semanticOverrides[semanticKey] !== undefined) {
            return { value: semanticOverrides[semanticKey], source: 'Attorney Override (Verified)', confidence: 'verified' };
        }
        for (const k of keys) {
            if (facts[k]?.value) return { value: facts[k].value, source: facts[k].source || 'Extracted Fact', confidence: facts[k].confidence || 'high' };
            if (answers[k]) return { value: answers[k], source: 'Questionnaire Answer', confidence: 'high' };
        }
        return { value: defaultVal, source: 'Missing', confidence: 'low' };
    };

    // Older analyses (run before COMMON_IDENTITY_FACTS existed) only captured identity as a single
    // bundled "entity" fact (e.g. beneficiary_identity: {full_legal_name, dob}) rather than the flat
    // keys getValue() looks for below. Best-effort unpack that shape as a fallback so those
    // already-analyzed cases populate immediately, without needing to re-run analysis.
    const identityFallback = (() => {
        for (const key of ['beneficiary_identity', 'client_identity']) {
            const fact = facts[key];
            const v = fact?.value;
            if (v && typeof v === 'object' && v.full_legal_name) {
                const parts = String(v.full_legal_name).trim().split(/\s+/);
                return {
                    familyName: parts.length > 1 ? parts[parts.length - 1] : '',
                    givenName: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0] || '',
                    dob: v.dob || '',
                    source: (fact.source || 'Extracted Fact') + ' (name split from full legal name)',
                    confidence: fact.confidence === 'high' ? 'medium' : (fact.confidence || 'medium')
                };
            }
        }
        return null;
    })();

    let familyName = getValue(['beneficiary_family_name', 'family_name', 'last_name', 'applicant_name'], '', 'familyName');
    if (familyName.source === 'Missing' && identityFallback?.familyName) {
        familyName = { value: identityFallback.familyName, source: identityFallback.source, confidence: identityFallback.confidence };
    }
    let givenName = getValue(['beneficiary_given_name', 'given_name', 'first_name'], '', 'givenName');
    if (givenName.source === 'Missing' && identityFallback?.givenName) {
        givenName = { value: identityFallback.givenName, source: identityFallback.source, confidence: identityFallback.confidence };
    }
    let dob = getValue(['beneficiary_dob', 'dob', 'date_of_birth'], '', 'dob');
    if (dob.source === 'Missing' && identityFallback?.dob) {
        dob = { value: identityFallback.dob, source: identityFallback.source, confidence: identityFallback.confidence };
    }
    const nationality = getValue(['beneficiary_nationality', 'nationality', 'country_of_citizenship'], '', 'nationality');
    const aNumber = getValue(['alien_registration_number', 'a_number', 'u_s_social_security_number'], '', 'aNumber');
    const address = getValue(['us_address', 'address', 'current_address'], '', 'address');
    // No fallback placeholder here (e.g. the old 'Self-Petitioned' default) - this value gets
    // written verbatim into the real "Company or Organization Name" / "Employer Name" box on the
    // official PDF, where a placeholder string would look like real data to a USCIS reviewer.
    // "Petitioner Type" (I-140 Part 5) and similar select fields capture self-petition status
    // correctly instead, via their own case-type-derived options.
    const employer = getValue(['petitioner_name', 'company_name', 'employer_name'], '', 'employer');
    const jobTitle = getValue(['proposed_employment_title', 'job_title', 'position'], '', 'jobTitle');
    const passportNo = getValue(['passport_number', 'passport_no'], '', 'passportNo');
    const i94No = getValue(['i94_number', 'i94_no'], '', 'i94No');
    const status = getValue(['current_nonimmigrant_status', 'visa_status'], '', 'status');

    const attorneyFamilyName = semanticOverrides['attorneyFamilyName'] !== undefined
        ? { value: semanticOverrides['attorneyFamilyName'], source: 'Attorney Override (Verified)', confidence: 'verified' }
        : { value: FIRM_ATTORNEY_FAMILY_NAME, source: 'Law Firm Setting', confidence: 'high' };
    const attorneyGivenName = semanticOverrides['attorneyGivenName'] !== undefined
        ? { value: semanticOverrides['attorneyGivenName'], source: 'Attorney Override (Verified)', confidence: 'verified' }
        : { value: FIRM_ATTORNEY_GIVEN_NAME, source: 'Law Firm Setting', confidence: 'high' };
    const lawFirm = semanticOverrides['lawFirm'] !== undefined
        ? { value: semanticOverrides['lawFirm'], source: 'Attorney Override (Verified)', confidence: 'verified' }
        : { value: FIRM_LAW_FIRM_NAME, source: 'Law Firm Setting', confidence: 'high' };

    const canonicalValuesForDefs = { familyName, givenName, dob, nationality, aNumber, address, employer, jobTitle, passportNo, i94No, status, attorneyFamilyName, attorneyGivenName, lawFirm };

    const formsData: Record<string, any> = {
            'I-140': {
                formTitle: 'Immigrant Petition for Alien Workers (Form I-140)',
                fullCoverage: true,
                fields: buildDefinedFields(I140_FIELD_DEFS, canonicalValuesForDefs, mergedOverrides, caseType)
            },
            'I-485': {
                formTitle: 'Application to Register Permanent Residence or Adjust Status (Form I-485)',
                fullCoverage: true,
                fields: buildDefinedFields(I485_FIELD_DEFS, canonicalValuesForDefs, mergedOverrides, caseType)
            },
            'G-28': {
                formTitle: 'Notice of Entry of Appearance as Attorney or Accredited Representative (Form G-28)',
                // Full field coverage (see G28_FIELD_DEFS) - every item the attorney would need to
                // complete on the real form is a row here, not just the handful of identity fields.
                fullCoverage: true,
                fields: buildDefinedFields(G28_FIELD_DEFS, canonicalValuesForDefs, mergedOverrides)
            },
            'I-765': {
                formTitle: 'Application for Employment Authorization (Form I-765)',
                fullCoverage: true,
                fields: buildDefinedFields(I765_FIELD_DEFS, canonicalValuesForDefs, mergedOverrides, caseType)
            }
        };

    // Fields without a shared semantic key (EIN, category/reason text, firm settings) are only
    // overridable directly by their own fieldId.
    Object.keys(formsData).forEach(formKey => {
        formsData[formKey].fields.forEach((field: any) => {
            if (mergedOverrides[field.fieldId] !== undefined && field.source !== 'Attorney Override (Verified)') {
                field.value = mergedOverrides[field.fieldId];
                field.source = 'Attorney Override (Verified)';
                field.confidence = 'verified';
            }
        });
    });

    let totalFields = 0;
    let autoFilledCount = 0;
    let needsReviewCount = 0;
    let missingCount = 0;
    let missingRequiredCount = 0;

    Object.values(formsData).forEach((f: any) => {
        let formTotal = 0, formAuto = 0, formReview = 0, formMissing = 0, formMissingRequired = 0;
        f.fields.forEach((field: any) => {
            formTotal++;
            const isMissing = !field.value || field.value === 'N/A' || field.source === 'Missing';
            if (isMissing) {
                formMissing++;
                if (field.required !== false) formMissingRequired++;
            } else if (field.confidence === 'low' || field.confidence === 'medium') {
                formReview++;
            } else {
                formAuto++;
            }
        });
        // missingRequiredCount gates sign-off (see the sign-off endpoint below); missingCount is
        // purely informational so the attorney can still see everything left on the real form.
        f.formMetrics = { totalFields: formTotal, autoFilledCount: formAuto, needsReviewCount: formReview, missingCount: formMissing, missingRequiredCount: formMissingRequired };
        totalFields += formTotal;
        autoFilledCount += formAuto;
        needsReviewCount += formReview;
        missingCount += formMissing;
        missingRequiredCount += formMissingRequired;
    });

    return {
        formsData,
        caseType,
        metrics: {
            totalFields,
            autoFilledCount,
            needsReviewCount,
            missingCount,
            // Distinct from missingCount: I-485 alone has ~400 optional secondary fields (address
            // detail, family history, etc.) we don't have data for and don't require - showing
            // raw missingCount as "action needed" would read as a much bigger problem than it is.
            missingRequiredCount,
            completionRate: Math.round(((autoFilledCount) / (totalFields || 1)) * 100)
        },
        // Raw values keyed by canonical person-attribute, for filling the real official
        // USCIS PDF templates directly (as opposed to formsData, which is keyed per-form/per-fieldId
        // for the on-screen review table).
        canonicalValues: { familyName, givenName, dob, nationality, aNumber, address, employer, jobTitle, passportNo, i94No, status }
    };
};

// Every full-coverage field def's fieldId is prefixed with its owning form (G28_, I140_, I765_,
// I485_) - used to figure out which form's sign-off to invalidate when a specific field changes.
const formKeyForFieldId = (fieldId: string): string | null => {
    if (fieldId.startsWith('G28_')) return 'G-28';
    if (fieldId.startsWith('I140_')) return 'I-140';
    if (fieldId.startsWith('I765_')) return 'I-765';
    if (fieldId.startsWith('I485_')) return 'I-485';
    return null;
};

app.post('/api/intake/autofill-forms', (req, res) => {
    try {
        const { recordId, customOverrides, persist } = req.body;
        const records = getRecords();
        const recordIndex = records.findIndex(r => r.id === recordId);
        const record = records[recordIndex];

        if (!record) {
            return res.status(404).json({ error: 'Record not found' });
        }

        // Session edits (customOverrides, not yet saved) take priority over what was
        // previously persisted, but persisted overrides survive a page reload either way.
        const mergedOverrides: Record<string, string> = { ...(record.formOverrides || {}), ...(customOverrides || {}) };

        if (persist && customOverrides && typeof customOverrides === 'object') {
            // A sign-off is the attorney certifying the data was correct at that moment. If a
            // field on an already-signed-off form actually changes value afterward (not just
            // re-saved unchanged), that certification no longer reflects what's on screen, so it
            // must be invalidated rather than silently keep showing "Signed Off" against stale data.
            const previousOverrides = record.formOverrides || {};
            const changedFieldIds = Object.keys(customOverrides).filter(
                (fieldId) => customOverrides[fieldId] !== previousOverrides[fieldId]
            );
            if (changedFieldIds.length > 0 && record.formSignOff) {
                const affectedFormKeys = new Set(changedFieldIds.map(formKeyForFieldId).filter(Boolean));
                affectedFormKeys.forEach((formKey) => {
                    if (formKey && record.formSignOff[formKey as string]) {
                        delete record.formSignOff[formKey as string];
                    }
                });
            }

            record.formOverrides = mergedOverrides;
            saveRecords(records);
        }

        const { formsData, caseType, metrics } = buildAutofillFormsData(record, mergedOverrides);

        res.json({
            success: true,
            recordId,
            caseType,
            metrics,
            formsData,
            signOff: record.formSignOff || {}
        });
    } catch (err: any) {
        console.error("Autofill Forms Error:", err);
        res.status(500).json({ error: "Failed to autofill forms", details: err?.message });
    }
});

app.post('/api/intake/autofill-forms/sign-off', (req, res) => {
    try {
        const { recordId, formKey } = req.body;
        if (!formKey) return res.status(400).json({ error: 'formKey is required' });

        const records = getRecords();
        const record = records.find(r => r.id === recordId);
        if (!record) return res.status(404).json({ error: 'Record not found' });

        const mergedOverrides: Record<string, string> = { ...(record.formOverrides || {}) };
        const { formsData } = buildAutofillFormsData(record, mergedOverrides);
        const targetForm = formsData[formKey];
        if (!targetForm) return res.status(404).json({ error: `Unknown form ${formKey}` });

        const missingFields = targetForm.fields.filter((f: any) => f.required !== false && (!f.value || f.source === 'Missing')).map((f: any) => f.name);
        if (missingFields.length > 0) {
            return res.status(400).json({ error: 'Form has missing required fields and cannot be signed off yet', missingFields });
        }

        record.formSignOff = { ...(record.formSignOff || {}), [formKey]: { approvedAt: new Date().toISOString() } };
        saveRecords(records);

        res.json({ success: true, formKey, signOff: record.formSignOff });
    } catch (err: any) {
        console.error("Autofill Sign-Off Error:", err);
        res.status(500).json({ error: "Failed to sign off form", details: err?.message });
    }
});

// Real official USCIS PDF templates (downloaded from uscis.gov, repaired with pikepdf so
// pdf-lib can parse their cross-reference tables) live in server/uscis-forms/.
const USCIS_TEMPLATE_FILES: Record<string, string> = {
    'I-140': 'i-140.pdf',
    'I-485': 'i-485.pdf',
    'G-28': 'g-28.pdf',
    'I-765': 'i-765.pdf',
};

// Many `toggle` fields aren't a single attestation checkbox (checked = yes, blank = unanswered) -
// they're a genuine Yes/No PAIR of independent checkboxes on the real form (confirmed by
// inspecting the template: e.g. I-485 Part 9's ~85 legal-history questions are each two separate
// fields sharing a base name, `..._YesNo[0]`/`..._YesNo[1]`, one with onValue /Y and the other /N).
// def.realField only ever records the Yes box. Answering "No" on the review table used to leave
// BOTH boxes unchecked on the exported PDF - indistinguishable from "never answered" on an actual
// USCIS filing, which is a real problem specifically for Part 9's inadmissibility questions. This
// looks up the sibling by trying nearby indices at export time (rather than hardcoding ~94 pairs
// in the field defs) and checks it only if it's confirmed to be the /N counterpart; fields that
// are genuinely standalone (no sibling with onValue /N exists) are left exactly as before.
const findNoCheckboxSibling = (form: any, yesFieldName: string): string | null => {
    const m = yesFieldName.match(/^(.*)\[(\d+)\]$/);
    if (!m) return null;
    const base = m[1];
    const yesIdx = parseInt(m[2], 10);
    for (let i = 0; i <= 3; i++) {
        if (i === yesIdx) continue;
        const candidate = `${base}[${i}]`;
        try {
            const cb = form.getCheckBox(candidate);
            if (cb.acroField.getOnValue()?.toString() === '/N') return candidate;
        } catch (e) {
            // no field at this index - not a pair, or not this shape
        }
    }
    return null;
};

app.post('/api/intake/generate-filled-pdf', async (req, res) => {
    try {
        const { recordId, formKey, customOverrides } = req.body;
        const records = getRecords();
        const record = records.find(r => r.id === recordId);

        if (!record) {
            return res.status(404).json({ error: 'Record not found' });
        }

        const targetFormKey = formKey || 'I-140';
        const templateFile = USCIS_TEMPLATE_FILES[targetFormKey];
        if (!templateFile) {
            return res.status(400).json({ error: `Unknown form ${targetFormKey}` });
        }

        // Enforced server-side, not just by disabling the button client-side: the official PDF
        // must not be producible for a form the attorney hasn't certified via sign-off (and
        // sign-off itself already requires every required field to be filled - see the sign-off
        // endpoint above). This also means editing a field after sign-off (which revokes it, see
        // the invalidation logic in the autofill-forms endpoint above) immediately re-blocks export.
        if (!record.formSignOff?.[targetFormKey]) {
            return res.status(403).json({ error: `${targetFormKey} has not been signed off by the attorney yet. Sign off on the review table before exporting the official PDF.` });
        }

        // Reuse the exact same field resolution (persisted overrides + cross-form semantic
        // propagation) that the on-screen review table uses, so the official PDF export can
        // never drift from what the attorney reviewed on screen.
        const mergedOverrides: Record<string, string> = { ...(record.formOverrides || {}), ...(customOverrides || {}) };
        const { formsData } = buildAutofillFormsData(record, mergedOverrides);

        const templatePath = path.join(serverRootDir, 'uscis-forms', templateFile);
        const templateBytes = fs.readFileSync(templatePath);
        const pdfDoc = await PDFDocument.load(templateBytes, { ignoreEncryption: true });
        const form = pdfDoc.getForm();
        const fillFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

        // All 4 forms are manifest-driven ("full coverage"): write every row the attorney
        // reviewed on screen directly to its real PDF field. The same field list drives both
        // the review table and this export, so there is no separate mapping layer that can
        // silently drift out of sync with what's shown on screen.
        const defs = targetFormKey === 'G-28' ? G28_FIELD_DEFS : targetFormKey === 'I-140' ? I140_FIELD_DEFS : targetFormKey === 'I-765' ? I765_FIELD_DEFS : targetFormKey === 'I-485' ? I485_FIELD_DEFS : [];
        if (!defs.length) {
            return res.status(400).json({ error: `Unknown form ${targetFormKey}` });
        }
        const rowsByFieldId: Record<string, any> = {};
        (formsData[targetFormKey]?.fields || []).forEach((f: any) => { rowsByFieldId[f.fieldId] = f; });

        defs.forEach((def) => {
            const row = rowsByFieldId[def.fieldId];
            if (!row || !row.value) return;
            try {
                if (def.type === 'text' && def.realField) {
                    const field = form.getTextField(def.realField);
                    const maxLen = field.getMaxLength();
                    const value = typeof maxLen === 'number' && row.value.length > maxLen ? row.value.slice(0, maxLen) : row.value;
                    field.setText(value);
                    // Many viewers (Chrome/PDF.js in particular) don't honor the template's
                    // NeedAppearances flag and show filled values as blank without a cached
                    // appearance stream, so we render each touched field's appearance ourselves
                    // (not form.updateFieldAppearances(), which walks every field in the form and
                    // crashes on unrelated rich-text fields elsewhere that pdf-lib cannot read).
                    field.updateAppearances(fillFont);
                } else if (def.type === 'toggle' && def.realField) {
                    if (row.value === 'Yes') {
                        form.getCheckBox(def.realField).check();
                    } else if (row.value === 'No') {
                        const noField = findNoCheckboxSibling(form, def.realField);
                        if (noField) form.getCheckBox(noField).check();
                    }
                } else if (def.type === 'select' && def.options) {
                    const chosen = def.options.find(o => o.label === row.value);
                    if (chosen?.realField) form.getCheckBox(chosen.realField).check();
                }
            } catch (e: any) {
                console.warn(`generate-filled-pdf: could not set ${targetFormKey}.${def.fieldId}:`, e?.message);
            }
        });

        const pdfBytes = await pdfDoc.save({ updateFieldAppearances: false });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${targetFormKey}_Official_Filled.pdf"`);
        res.send(Buffer.from(pdfBytes));
    } catch (err: any) {
        console.error("Generate Filled PDF Error:", err);
        res.status(500).json({ error: "Failed to generate prefilled PDF", details: err?.message });
    }
});


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
        saveRecords(records);

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
            // We no longer trigger automatic research here. The user triggers it via a dedicated endpoint.

            if (caseType && caseType !== 'unknown') {
                record.caseType = caseType;
            }
            record.analysisError = undefined; // clear any previous errors
        } catch (err: any) {
            console.error('⚠️ Playbook analysis failed:', err.message);
            record.analysisError = err.message;
            fs.appendFileSync(path.join(serverRootDir, 'error.log'), `[${new Date().toISOString()}] Playbook analysis failed: ${err.message}\n${err.stack}\n\n`);
        }

        if (isNewRecord) {
            records.unshift(record);
        }

        saveRecords(records);
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
        let contextPrompt = transcriptText ? `\n\nConsultation Transcript Context:\n${transcriptText}\n\n` : "";

        if (existingRecord.answers) {
            contextPrompt += `\n\nClient Questionnaire Answers:\n${JSON.stringify(existingRecord.answers, null, 2)}\n\n`;
        }

        const prompt = `You are an expert legal intake specialist. You have been provided with ALL the historical documents, images, audio transcripts, and structured questionnaire answers for a "Matter Collection".
        
        ${contextPrompt}
        
        Please synthesize and analyze all provided materials holistically.
        If there are Client Questionnaire Answers provided, treat them as the primary source of truth for structured data (like name, immigration status, facts). 
        Use the uploaded documents to verify and enrich the claims made in the questionnaire.
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
            if (caseType && caseType !== 'unknown') {
                records[recordIndex].caseType = caseType;
            }
            records[recordIndex].analysisError = undefined; // clear previous error

            // Trigger background research based on the newly regenerated analysis
            // We no longer trigger automatic research here.

        } catch (err: any) {
            console.error('⚠️ Playbook analysis failed (Regenerate):', err.message);
            records[recordIndex].analysisError = err.message;
            fs.appendFileSync(path.join(serverRootDir, 'error.log'), `[${new Date().toISOString()}] Playbook analysis regeneration failed: ${err.message}\n${err.stack}\n\n`);
        }

        saveRecords(records);

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
        saveRecords(records);

        res.json({ success: true, record: records[recordIndex], explanation });
    } catch (error: any) {
        console.error('❌ Inline refinement failed:', error.message);
        res.status(500).json({ error: 'Failed to refine analysis inline', message: error.message });
    }
});

// Helper to get consistent Exhibit numbering across Frontend and Backend
const getExhibitMapping = (record: any) => {
  if (!record || !record.analysis) return [];
  const allDocs = [
    ...(record.analysis.documents || []),
    ...(record.analysis.evidence || []).map((e: any, idx: number) => {
       const targetFileName = e.file_name || e.fileName || e.filename || e.name || e.source;
       const matchedItem = record.items?.find((it: any) => {
         if (!targetFileName) return false;
         const itName = it.name || '';
         const itOrig = it.metadata?.originalname || '';
         return itName === targetFileName || 
                itOrig === targetFileName ||
                itName.includes(targetFileName.substring(0, 10)) ||
                (itOrig && targetFileName.includes(itOrig.substring(0, 10)));
       }) || record.items?.[idx % (record.items?.length || 1)];
       
       const resolvedFileName = matchedItem?.name || targetFileName;

       return {
         ...e,
         label: e.type || resolvedFileName,
         fileName: resolvedFileName,
         status: 'provided' // evidence is inherently provided if it's found
       };
    })
  ];

  const categoryToLetter = new Map<string, string>();
  const categoryCounters = new Map<string, number>();
  let currentLetterCode = 65; // 'A'
  
  const assignedExhibitNumbers = new Map<string, { letter: string, number: string }>();

  return allDocs.map((doc: any) => {
    if (doc.fileName && assignedExhibitNumbers.has(doc.fileName)) {
        const assigned = assignedExhibitNumbers.get(doc.fileName)!;
        return {
            ...doc,
            exhibitLetter: assigned.letter,
            exhibitNumber: assigned.number
        };
    }

    const cat = doc.category || 'uncategorized';
    if (!categoryToLetter.has(cat)) {
      categoryToLetter.set(cat, String.fromCharCode(currentLetterCode));
      currentLetterCode++;
    }
    const letter = categoryToLetter.get(cat)!;
    const count = (categoryCounters.get(cat) || 0) + 1;
    categoryCounters.set(cat, count);
    
    const exLetter = letter;
    const exNumber = `Exhibit ${letter}-${count}`;
    
    if (doc.fileName) {
        assignedExhibitNumbers.set(doc.fileName, { letter: exLetter, number: exNumber });
    }

    return {
      ...doc,
      exhibitLetter: exLetter,
      exhibitNumber: exNumber
    };
  });
};

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

        const mappedExhibits = getExhibitMapping(record);

        // Loop 1: Draw all exhibits on the Table of Contents (handles multi-page TOC)
        let exhibitNumber = 1;
        const maxTocWidth = width - 144; // 72pt margins on each side
        for (const item of (record.items || [])) {
            const mappedEx = mappedExhibits.find(e => {
                if (!e.fileName) return false;
                const eName = e.fileName;
                const origHint = item.metadata?.originalname;
                const sugHint = item.metadata?.suggestedName;
                return eName === item.name || 
                       eName === item.file_name || 
                       eName === origHint ||
                       eName === sugHint ||
                       (item.name && eName.includes(item.name)) ||
                       (origHint && eName.includes(origHint)) ||
                       (sugHint && eName.includes(sugHint));
            });
            const exName = mappedEx ? mappedEx.exhibitNumber : `Exhibit ${exhibitNumber}`;
            
            const lineStr = `   ${exName}: ${item.name}`;
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
            
            let processedDraft = record.analysis.coverLetterDraft;
            
            if (mappedExhibits && mappedExhibits.length > 0) {
                processedDraft = processedDraft.replace(/\[([^\]]+)\]\(cite:([^\)]+)\)/g, (match: string, linkText: string, citedFile: string) => {
                    const decodedCitedFile = decodeURIComponent(citedFile).trim();
                    const ex = mappedExhibits.find((e: any) => {
                        if (!e.fileName) return false;
                        const eName = e.fileName;
                        const fName = decodedCitedFile;
                        const eBase = eName.split(/[\/\\]/).pop() || eName;
                        const fBase = fName.split(/[\/\\]/).pop() || fName;
                        return eName === fName || eName.includes(fName) || fName.includes(eName) || eBase === fBase;
                    });
                    if (ex) {
                        return ex.exhibitNumber;
                    }
                    return match;
                });
                
                mappedExhibits.forEach((ex: any) => {
                    if (ex.fileName) {
                        const baseName = ex.fileName.split(/[\/\\]/).pop() || ex.fileName;
                        const safeFileName = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        try {
                            const rawRegex = new RegExp(`(?<!cite:)${safeFileName}`, 'g');
                            processedDraft = processedDraft.replace(rawRegex, `${ex.exhibitNumber}`);
                        } catch (e) {
                            processedDraft = processedDraft.split(baseName).join(`${ex.exhibitNumber}`);
                        }
                    }
                });
            }

            // Clean up any remaining markdown cite links so they don't print raw in the PDF
            processedDraft = processedDraft.replace(/\[([^\]]+)\]\(cite:[^\)]+\)/g, '$1');
            const clLines = processedDraft.split('\n');
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

        saveRecords(records);
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
        saveRecords(records);

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

        saveRecords(records);
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

        saveRecords(records);
        res.json({ success: true, renamedCount: renamedItems.length, record: records[recordIndex] });
    } catch (error: any) {
        console.error('❌ Batch Rename failed:', error.message);
        res.status(500).json({ error: 'Failed to batch rename items', message: error.message });
    }
});

// 10. Questionnaire Endpoints
app.post('/api/records/:id/upload', upload.array('files'), async (req, res) => {
    const { id } = req.params;
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files provided' });
    }

    try {
        const records = getRecords();
        const recordIndex = records.findIndex(r => r.id === id);
        if (recordIndex === -1) {
            return res.status(404).json({ error: 'Record not found' });
        }

        const existingRecord = records[recordIndex];
        if (!existingRecord.items) {
            existingRecord.items = [];
        }

        for (const file of files) {
            // Note: In production you would do more robust type checking
            const isAudio = file.mimetype.startsWith('audio/');
            const type = isAudio ? 'audio' : (file.mimetype === 'application/pdf' ? 'pdf' : 'image');
            
            existingRecord.items.push({
                id: `item_${Date.now()}_${Math.random().toString(36).substring(7)}`,
                type: type,
                url: `/uploads/${file.filename}`,
                name: file.originalname,
                metadata: {
                    mimetype: file.mimetype,
                    size: file.size,
                    hash: crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex')
                }
            });
        }

        saveRecords(records);
        res.json({ success: true, record: existingRecord });
    } catch (error: any) {
        console.error('❌ Failed to upload files to record:', error.message);
        res.status(500).json({ error: 'Failed to upload files', message: error.message });
    }
});
app.post('/api/records/questionnaire', async (req, res) => {
    try {
        const { playbookId, playbookName, answers } = req.body;
        const newRecord = {
            id: `q_${Date.now()}`,
            type: 'questionnaire',
            timestamp: new Date().toISOString(),
            playbookId,
            playbookName,
            answers
        };
        saveRecord(newRecord);
        res.json({ success: true, record: newRecord });
    } catch (error: any) {
        console.error('❌ Failed to save questionnaire:', error.message);
        res.status(500).json({ error: 'Failed to save questionnaire', message: error.message });
    }
});

app.put('/api/records/questionnaire/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { answers, playbookId, playbookName } = req.body;
        
        const records = getRecords();
        const recordIndex = records.findIndex(r => r.id === id);
        if (recordIndex === -1) {
            return res.status(404).json({ error: 'Record not found' });
        }
        
        records[recordIndex] = {
            ...records[recordIndex],
            answers,
            ...(playbookId && { playbookId }),
            ...(playbookName && { playbookName })
        };
        
        saveRecords(records);
        res.json({ success: true, record: records[recordIndex] });
    } catch (error: any) {
        console.error('❌ Failed to update questionnaire:', error.message);
        res.status(500).json({ error: 'Failed to update questionnaire', message: error.message });
    }
});

// 11. Re-classify Endpoint – re-runs AI classification on existing record items
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

        saveRecords(records);
        console.log(`[Reclassify] Updated ${updatedCount} item(s) for record ${id}`);

        res.json({ success: true, classifiedCount: updatedCount, record: records[recordIndex] });
    } catch (error: any) {
        console.error('Failed to re-classify:', error);
        res.status(500).json({ error: 'Failed to re-classify', message: error.message });
    }
});

app.post('/api/records/:id/auto-research', async (req, res) => {
    try {
        const { id } = req.params;
        const { targetEntities } = req.body;
        
        if (!targetEntities || !Array.isArray(targetEntities)) {
            return res.status(400).json({ error: 'targetEntities array is required' });
        }
        
        const records = getRecords();
        const recordIndex = records.findIndex((r: any) => r.id === id);
        
        if (recordIndex === -1) {
            return res.status(404).json({ error: 'Record not found' });
        }
        
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
        
        await runAutoResearchForRecord(records[recordIndex], targetEntities, genAI);
        
        saveRecords(records);
        
        res.json({ success: true, record: records[recordIndex] });
    } catch (error: any) {
        console.error('Failed to run auto-research:', error);
        res.status(500).json({ error: 'Failed to run auto-research', message: error.message });
    }
});
