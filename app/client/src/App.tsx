import { useState, useRef, useEffect } from 'react';
import { Upload, Mic, Square, FileText, PlayCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import './App.css';

// Types for AssemblyAI responses
interface TranscriptWord {
  text: string;
  start: number;
  end: number;
  confidence: number;
  speaker: string;
}

interface Utterance {
  speaker: string;
  text: string;
  start: number;
  end: number;
  words: TranscriptWord[];
}

interface Transcript {
  id: string;
  status: string;
  text: string;
  utterances?: Utterance[];
}

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioFile, setAudioFile] = useState<File | Blob | null>(null);
  const audioChunks = useRef<Blob[]>([]);

  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStatus, setProcessingStatus] = useState<string>('');

  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const audioEl = audioRef.current;
    if (!audioEl) return;

    const handleTimeUpdate = () => {
      setCurrentTime(audioEl.currentTime * 1000); // Convert to ms for AssemblyAI timestamps
    };

    audioEl.addEventListener('timeupdate', handleTimeUpdate);
    return () => audioEl.removeEventListener('timeupdate', handleTimeUpdate);
  }, [audioUrl]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunks.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(audioChunks.current, { type: 'audio/webm' });
        const url = URL.createObjectURL(audioBlob);
        setAudioUrl(url);
        setAudioFile(audioBlob);
        stream.getTracks().forEach(track => track.stop());
      };

      recorder.start();
      setMediaRecorder(recorder);
      setIsRecording(true);

      // Reset previous results
      setTranscript(null);
      setSummary(null);
    } catch (error) {
      console.error('Error accessing microphone:', error);
      alert('Could not access microphone. Please check permissions.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      setIsRecording(false);
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setAudioUrl(url);
      setAudioFile(file);

      // Reset previous results
      setTranscript(null);
      setSummary(null);
    }
  };

  const processAudio = async () => {
    if (!audioFile) return;

    setIsProcessing(true);
    setProcessingStatus('Transcribing audio (this may take a minute)...');

    const formData = new FormData();
    // Using a default name for blobs
    formData.append('audio', audioFile, 'consultation.webm');

    try {
      // 1. Transcribe
      const transResponse = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/transcribe`, {
        method: 'POST',
        body: formData,
      });

      if (!transResponse.ok) throw new Error('Transcription failed');

      const transData = await transResponse.json();
      const transcriptId = transData.transcript.id;

      // We would ideally poll here if using the async AssemblyAI API, 
      // but assuming the backend waits for completion if we used `.transcribe()`
      // Actually, `.transcribe()` in the SDK handles waiting.
      setTranscript(transData.transcript);

      setProcessingStatus('Generating legal summary...');

      // 2. Summarize
      const sumResponse = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcriptIds: [transcriptId] }),
      });

      if (!sumResponse.ok) throw new Error('Summarization failed');

      const sumData = await sumResponse.json();
      setSummary(sumData.summary);

    } catch (error) {
      console.error('Processing error:', error);
      alert('An error occurred during processing. Is the backend running?');
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  const handleWordClick = (startTimeMs: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = startTimeMs / 1000;
      audioRef.current.play();
    }
  };

  // Replaced custom renderSummary with react-markdown in the return block

  return (
    <div className="app-container">
      <header className="header">
        <h1>MeritX Intake</h1>
        <p>AI-powered consultation workflow & extraction</p>
      </header>

      {!transcript && !isProcessing && (
        <main className="glass-card">
          <div className="section-title">
            <PlayCircle size={24} className="icon-small" style={{ color: 'var(--accent-primary)' }} />
            Start Consultation
          </div>

          <div className="upload-section">
            <div
              className={`action-card ${isRecording ? 'recording' : ''}`}
              onClick={isRecording ? stopRecording : startRecording}
            >
              {isRecording ? (
                <>
                  <Square className="icon" />
                  <h3>Stop Recording</h3>
                  <p className="text-secondary">Recording in progress...</p>
                </>
              ) : (
                <>
                  <Mic className="icon" />
                  <h3>Record Audio</h3>
                  <p className="text-secondary">Record client consultation directly</p>
                </>
              )}
            </div>

            <div
              className="action-card"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="icon" />
              <h3>Upload File</h3>
              <p className="text-secondary">MP3, WAV, or WebM</p>
              <input
                type="file"
                className="file-input"
                ref={fileInputRef}
                accept="audio/*"
                onChange={handleFileUpload}
              />
            </div>
          </div>

          {audioUrl && !isRecording && (
            <div style={{ marginTop: '2rem', textAlign: 'center' }}>
              <div className="audio-player-container">
                <audio controls src={audioUrl}></audio>
              </div>
              <button className="btn btn-primary" onClick={processAudio}>
                <FileText size={20} />
                Generate Intake Record
              </button>
            </div>
          )}
        </main>
      )}

      {isProcessing && (
        <div className="glass-card processing-card">
          <div className="spinner"></div>
          <h3>Processing Consultation</h3>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>{processingStatus}</p>
        </div>
      )}

      {transcript && summary && (
        <div className="results-container">
          <div className="glass-card summary-card">
            <div className="section-title">
              <FileText size={24} style={{ color: 'var(--success)' }} />
              Structured Intake Record
            </div>
            <div className="markdown-body">
              <ReactMarkdown>{summary}</ReactMarkdown>
            </div>
          </div>

          <div className="glass-card transcript-card-wrapper">
            <div className="section-title">
              Transcript
            </div>

            <div className="audio-player-container">
              <audio ref={audioRef} controls src={audioUrl || ''} />
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem', textAlign: 'center' }}>
                Click any word to jump to that timestamp
              </p>
            </div>

            <div className="transcript-card">
              {transcript.utterances ? (
                transcript.utterances.map((utt, i) => (
                  <div key={i} className="utterance">
                    <div className={`speaker-tag speaker-${utt.speaker}`}>Speaker {utt.speaker}</div>
                    <p>
                      {utt.words.map((word, j) => {
                        const isActive = currentTime >= word.start && currentTime <= word.end;
                        return (
                          <span
                            key={j}
                            className={`word ${isActive ? 'active' : ''}`}
                            onClick={() => handleWordClick(word.start)}
                            title={`Confidence: ${Math.round(word.confidence * 100)}%`}
                          >
                            {word.text}{' '}
                          </span>
                        );
                      })}
                    </p>
                  </div>
                ))
              ) : (
                <p>{transcript.text}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
