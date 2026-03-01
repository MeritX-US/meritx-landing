import { useState, useRef, useEffect } from 'react';
import { Upload, Mic, AlertCircle, FileText, PlayCircle, Square, History, ArrowLeft, Trash2, Calendar } from 'lucide-react';
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
  const [language, setLanguage] = useState<string>('auto');
  const [processingError, setProcessingError] = useState<string | null>(null);

  const [records, setRecords] = useState<any[]>([]);
  const [view, setView] = useState<'home' | 'history' | 'results'>('home');
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);

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

  useEffect(() => {
    fetchRecords();
  }, []);

  const fetchRecords = async () => {
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/records`);
      if (response.ok) {
        const data = await response.json();
        setRecords(data);
      }
    } catch (err) {
      console.error('Failed to fetch records:', err);
    }
  };

  const deleteRecord = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger "view record"
    if (!window.confirm('Are you sure you want to delete this consultation record?')) return;

    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/records/${id}`, {
        method: 'DELETE'
      });
      if (response.ok) {
        setRecords(records.filter(r => r.id !== id));
        if (selectedRecordId === id) {
          setView('home');
          setTranscript(null);
          setSummary(null);
        }
      }
    } catch (err) {
      console.error('Failed to delete record:', err);
    }
  };

  const loadRecord = (record: any) => {
    setTranscript(record.transcript);
    setSummary(record.summary);
    setAudioUrl(null); // Previous audio url might not match
    setSelectedRecordId(record.id);
    setView('results');
  };

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
    setProcessingError(null);

    const formData = new FormData();
    // Using a default name for blobs
    formData.append('audio', audioFile, 'consultation.webm');
    formData.append('language', language);

    try {
      // 1. Transcribe
      const transResponse = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/transcribe`, {
        method: 'POST',
        body: formData,
      });

      if (!transResponse.ok) {
        const errorData = await transResponse.json().catch(() => ({}));
        throw new Error(errorData.error || 'Transcription failed');
      }

      const transData = await transResponse.json();
      console.log('Transcription result:', transData);

      if (!transData.transcript || !transData.transcript.text) {
        console.warn('Transcript text is missing!', transData.transcript);
      }

      setTranscript(transData.transcript);
      setSummary(transData.summary);
      setSelectedRecordId(transData.recordId);

      fetchRecords(); // Refresh history
      setView('results');

    } catch (error: any) {
      console.error('Processing error:', error);
      setProcessingError(error.message || 'An error occurred during processing.');
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

  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <div className="app-container">
      <header className="header">
        <div className="header-content">
          <div style={{ width: '44px', display: 'flex', justifyContent: 'flex-start' }}>
            {view !== 'home' && (
              <button
                className="btn-icon"
                onClick={() => setView('home')}
                title="Back to Start"
              >
                <ArrowLeft size={24} />
              </button>
            )}
          </div>
          <div className="header-center">
            <h1>MeritX Intake</h1>
            <p>AI-powered consultation workflow & extraction</p>
          </div>
          <div style={{ width: 'auto', display: 'flex', justifyContent: 'flex-end' }}>
            <button
              className={`btn-history ${view === 'history' ? 'active' : ''}`}
              onClick={() => setView(view === 'history' ? 'home' : 'history')}
            >
              <History size={20} />
              <span className="hide-mobile">History</span>
            </button>
          </div>
        </div>
      </header>

      {view === 'history' && (
        <main className="glass-card">
          <div className="section-title">
            <History size={24} className="icon-small" style={{ color: 'var(--accent-primary)' }} />
            Consultation History
          </div>

          <div className="history-list">
            {records.length === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem' }}>
                No past consultations found.
              </p>
            ) : (
              records.map((record) => (
                <div key={record.id} className="history-item" onClick={() => loadRecord(record)}>
                  <div className="history-info">
                    <div className="history-title">
                      <Calendar size={14} />
                      {new Date(record.timestamp).toLocaleDateString()} {new Date(record.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                    <div className="history-preview">
                      {record.transcript?.text?.substring(0, 100)}...
                    </div>
                  </div>
                  <button className="delete-btn" onClick={(e) => deleteRecord(record.id, e)} title="Delete Record">
                    <Trash2 size={18} />
                  </button>
                </div>
              ))
            )}
          </div>
        </main>
      )}

      {view === 'results' && transcript && summary && (
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

            {audioUrl ? (
              <div className="audio-player-container">
                <audio ref={audioRef} controls src={audioUrl} />
                <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem', textAlign: 'center' }}>
                  Click any word to jump to that timestamp
                </p>
              </div>
            ) : (
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1rem', fontStyle: 'italic' }}>
                Note: Audio playback is only available for the current session's recording.
              </p>
            )}

            <div className="transcript-card">
              {transcript.utterances ? (
                transcript.utterances.map((utt, i) => (
                  <div key={i} className="utterance">
                    <div className={`speaker-tag speaker-${utt.speaker}`}>
                      Speaker {utt.speaker} <span className="timestamp">{formatTime(utt.start)}</span>
                    </div>
                    <p>
                      {utt.words.map((word, j) => {
                        const isActive = currentTime >= word.start && currentTime <= word.end;
                        return (
                          <span
                            key={j}
                            className={`word ${isActive ? 'active' : ''}`}
                            onClick={() => audioUrl && handleWordClick(word.start)}
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

      {view === 'home' && !transcript && !isProcessing && (
        <main className="glass-card">
          <div className="section-title">
            <PlayCircle size={24} className="icon-small" style={{ color: 'var(--accent-primary)' }} />
            Start Consultation
          </div>

          {processingError && (
            <div className="error-message" style={{
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid var(--danger)',
              color: 'var(--danger)',
              padding: '1rem',
              borderRadius: '12px',
              marginBottom: '2rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              fontSize: '0.95rem',
              lineHeight: '1.4'
            }}>
              <AlertCircle size={20} style={{ flexShrink: 0 }} />
              <div>
                <strong>Error:</strong> {processingError}
              </div>
            </div>
          )}

          <div className="language-selector-container">
            <label htmlFor="language-select">Audio Language:</label>
            <select
              id="language-select"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option value="auto">Auto-detect</option>
              <option value="en">English (English)</option>
              <option value="zh">Chinese (中文)</option>
              <option value="es">Spanish (Español)</option>
              <option value="fr">French (Français)</option>
              <option value="de">German (Deutsch)</option>
              <option value="ja">Japanese (日本語)</option>
              <option value="ko">Korean (한국어)</option>
              <option value="pt">Portuguese (Português)</option>
              <option value="vi">Vietnamese (Tiếng Việt)</option>
              <option value="hi">Hindi (हिन्दी)</option>
              <option value="ru">Russian (Русский)</option>
            </select>
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
      )
      }

      {
        isProcessing && (
          <div className="glass-card processing-card">
            <div className="spinner"></div>
            <h3>Processing Consultation</h3>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>{processingStatus}</p>
          </div>
        )
      }

    </div >
  );
}

export default App;
