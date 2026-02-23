# Requirements

## Functional requirements

The MVP will focus on the intake process, converting audio recording to transcripts

Users can rewind by timestamp, and review the summary.

Record should be easily taken for both phone calls and online meetings.

Transcript should be able to tell who is speaking, aka speaker diarization.

## Non-Functional requirements

1. Easy to use, no complex setup

2. Privacy compliance with zero-data-retention guarantees

3. Higher accuracy is more favored than speed

4. The model should deliver high accuracy on legal terminology, accents and background noise

# Technical decisions

Building a web app that takes/uploads recordings, converts to transcripts that can rewind by timestamp, and generates summary.

Focus on post call processing instead of real time in call processing.

Defer phone call recording and online meeting recording integration later, which could be implemented by leveraging [twilio](https://www.twilio.com) and [recall.ai](https://www.recall.ai)

Start with rapid MVP using cloud services:

- [Deepgram](https://deepgram.com)

- [Assembly AI](https://www.assemblyai.com)

- [OpenAI Whisper](https://openai.com/index/whisper)

- [Azure Speech](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/overview)

- [Google STT](https://cloud.google.com/speech-to-text)

[Azure Speech](https://azure.microsoft.com/en-us/pricing/details/speech/?msockid=1450673f81ff61f000a675c980b360cb) ($0.80/hr) and [Google STT](https://cloud.google.com/speech-to-text) ($0.96/hr) are more expensive and less accurate compared with others, [AssemblyAI](https://www.assemblyai.com/docs/getting-started/models#pricing) is $0.15/hr, [Deepgram](https://deepgram.com/pricing) is $0.462/hr for basic speech-to-text, and $0.12/hr for speaker diarization and $0.12/hr for redaction.

OpenAI Whisper can't handle accents well, doesn't support speaker diarization, and it may have hallucination sometimes which makes it inappropriate for legal use cases.

Deepgram has the lowest latency and highest accuracy among the evaluated services.

AssemblyAI is a good alternative to Deepgram, even though it has built-in summarization feature (LeMUR), but LeMUR will be deprecated on March 31st, 2026, and it's suggested to use general LLM to do summarization, which provides more flexibility. PII redaction and HIPAA BAA are also supported.

So we will use AssemblyAI for the MVP.

