import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { AssemblyAI } from 'assemblyai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

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
    console.error("Missing AssemblyAI API Key in .env file");
    process.exit(1);
}
const client = new AssemblyAI({ apiKey });

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

    try {
        // Create a transcript with speaker diarization and PII redaction enabled
        const transcript = await client.transcripts.transcribe({
            audio: filePath,
            speaker_labels: true,
            speech_models: ["universal-2" as any], // Bypass TS definition error for newer models
            redact_pii: true,
            pii_policies: [
                "blood_type", "credit_card_cvv", "credit_card_expiration", "credit_card_number",
                "date_of_birth", "drivers_license", "email_address", "injury", "medical_condition",
                "medical_process", "person_age", "person_name", "phone_number", "political_affiliation",
                "religion", "ssn", "us_social_security_number", "banking_information", "credentials"
            ],
            pii_redaction_policies: ["banking_information", "credit_card_number", "credit_card_expiration", "credit_card_cvv", "ssn", "us_social_security_number"] // Only strictly mask banking and SSNs to not ruin the legal transcript context initially
        } as any); // cast as any to bypass SDK limitations regarding PII types sometimes

        // Cleanup: Remove the file locally after uploading to AssemblyAI keeping zero-data-retention promise locally
        fs.unlinkSync(filePath);

        res.json({ transcript });
    } catch (error) {
        console.error('Transcription error:', error);
        // Attempt cleanup if it failed during processing
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        res.status(500).json({ error: 'Transcription failed' });
    }
});

// 2. Endpoint to summarize the resulting transcript using Gemini
app.post('/api/summarize', async (req, res) => {
    const { transcriptIds } = req.body;

    if (!transcriptIds || !Array.isArray(transcriptIds) || transcriptIds.length === 0) {
        return res.status(400).json({ error: 'Valid transcriptIds array is required' });
    }

    try {
        // Fetch the transcript text from AssemblyAI first
        const transcriptData = await client.transcripts.get(transcriptIds[0]);
        const textToSummarize = transcriptData.text;

        if (!textToSummarize) {
            return res.status(400).json({ error: 'Transcript contains no text to summarize' });
        }

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
${textToSummarize}`;

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
