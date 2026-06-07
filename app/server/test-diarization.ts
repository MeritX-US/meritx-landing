import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '.env') });

const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
    console.error("Missing Gemini API Key in .env file");
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(geminiApiKey);

const mockTranscriptText = "And your conditional green card expired on November 28, 2025, correct? Good. That means your 90 days filing window opens on August 28, 2025 and intended filing date we are working with is September 15, 2025. That put us safely with the filing window which exactly where we want to be.";
const words = mockTranscriptText.split(' ').map((w, idx) => ({
    text: w,
    start: idx * 500,
    end: (idx + 1) * 500,
    confidence: 0.99,
    speaker: "A"
}));

const mockTranscript = {
    utterances: [
        {
            speaker: "A",
            text: mockTranscriptText,
            start: 0,
            end: words.length * 500,
            words: words
        }
    ]
};

async function refineDiarizationWithGemini(transcript: any) {
    if (!transcript.utterances || transcript.utterances.length === 0) return;

    try {
        console.log("Running Diarization Refinement with Gemini...");
        const refineModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        const simplified = transcript.utterances.map((u: any, i: number) => ({
            u_idx: i,
            speaker: u.speaker,
            words: (u.words || []).map((w: any, w_idx: number) => ({
                w_idx: w_idx,
                text: w.text
            }))
        }));

        const prompt = `You are a legal transcription editor. The ASR model may have failed to separate speakers correctly in the following transcript. Sometimes a single utterance contains speech from two different speakers.

CRITICAL PATTERN TO FIX:
ASR models often hallucinate punctuation and merge short affirmations from the listener. For example, if Speaker A says "...expires on November 28?" and Speaker B replies "Correct.", the ASR might merge it into a single utterance for Speaker A as "...expired on November 28, correct?". 
Look VERY closely for words like "correct?", "right?", "okay", "yes" embedded in what looks like a continuous sentence. If the context implies it's actually an answer or acknowledgment from the other speaker, YOU MUST split it out!

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
${JSON.stringify(simplified, null, 2)}
`;

        console.log("Sending prompt to Gemini...\n");
        const refineResult = await refineModel.generateContent(prompt);
        const refineText = refineResult.response.text();
        console.log("--- Gemini Raw Response ---\n", refineText, "\n--------------------------\n");
        
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
            }
        }
    } catch (e) {
        console.error("Diarization refinement failed:", e);
    }
}

async function runTest() {
    console.log("Original Utterances:", JSON.stringify(mockTranscript.utterances.map(u => ({ speaker: u.speaker, text: u.text })), null, 2));
    
    await refineDiarizationWithGemini(mockTranscript);
    
    console.log("\nFinal Utterances:");
    mockTranscript.utterances.forEach(u => {
        console.log(`[Speaker ${u.speaker}]: ${u.text}`);
    });
}

runTest();
