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

Start with rapid MVP using cloud services (to be evaluated):

- [deepgram](https://deepgram.com)

- [Assembly AI](https://www.assemblyai.com)

- [OpenAI Whisper](https://openai.com/index/whisper)

- [Azure Speech](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/overview)

- [Speech-to-Text](https://cloud.google.com/speech-to-text)

Focus on post call processing instead of real time in call processing.

Defer phone call recording and online meeting recording integration later, which could be implemented by leveraging [twilio](https://www.twilio.com) and [recall.ai](https://www.recall.ai)
