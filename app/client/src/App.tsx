import { useState, useRef, useEffect } from 'react';
import { Upload, Mic, AlertCircle, FileText, PlayCircle, Square, History, ArrowLeft, Trash2, Calendar, RefreshCw, X, CheckCircle, Plus, PhoneCall, Copy, FileIcon, ImageIcon } from 'lucide-react';
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
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);
  const [syncStatus, setSyncStatus] = useState('');
  const [notification, setNotification] = useState<{ title: string, message: string, type: 'success' | 'error' | 'info' } | null>(null);
  const [processingStatus, setProcessingStatus] = useState<string>('');

  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [language, setLanguage] = useState<string>('auto');
  const [processingError, setProcessingError] = useState<string | null>(null);

  const [records, setRecords] = useState<any[]>([]);
  const [view, setView] = useState<'home' | 'history' | 'results'>('history');
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);

  const [clientPhone, setClientPhone] = useState('');
  const [isCallingOut, setIsCallingOut] = useState(false);
  const [twilioNumber, setTwilioNumber] = useState('');

  const [isAnalyzingFiles, setIsAnalyzingFiles] = useState(false);
  const docInputRef = useRef<HTMLInputElement>(null);

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
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/config`);
      if (response.ok) {
        const data = await response.json();
        setTwilioNumber(data.twilioPhoneNumber);
      }
    } catch (err) {
      console.error('Failed to fetch config:', err);
    }
  };

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
          setView('history');
          setTranscript(null);
          setSummary(null);
        }
      }
    } catch (err) {
      console.error('Failed to delete record:', err);
    }
  };

  const showNotification = (title: string, message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setNotification({ title, message, type });
    setTimeout(() => setNotification(null), 5000);
  };

  const syncFromTwilio = async () => {
    setIsSyncing(true);
    setSyncProgress(0);
    setSyncStatus('Checking Twilio...');

    try {
      const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';

      // 1. Check for missing recordings
      const checkRes = await fetch(`${baseUrl}/api/twilio/sync/check`);
      if (!checkRes.ok) throw new Error('Failed to check Twilio recordings');
      const { missing } = await checkRes.json();

      if (!missing || missing.length === 0) {
        showNotification('Sync Complete', 'History is already up to date!', 'success');
        setIsSyncing(false);
        return;
      }

      showNotification('Sync Started', `Found ${missing.length} missing records. Processing...`, 'info');

      let syncedCount = 0;
      // 2. Process each SID sequentially to show progress
      for (let i = 0; i < missing.length; i++) {
        const record = missing[i];
        setSyncStatus(`Syncing ${i + 1} of ${missing.length}...`);

        try {
          const procRes = await fetch(`${baseUrl}/api/twilio/sync/process/${record.sid}`);
          if (procRes.ok) {
            syncedCount++;
          } else {
            console.error(`Failed to process SID ${record.sid}`);
          }
        } catch (e) {
          console.error(`Network error for SID ${record.sid}`, e);
        }

        // Update progress bar
        setSyncProgress(((i + 1) / missing.length) * 100);
      }

      await fetchRecords();
      showNotification('Sync Finished', `Successfully recovered ${syncedCount} new records.`, 'success');
    } catch (error: any) {
      console.error('Sync error:', error);
      showNotification('Sync Failed', error.message || 'An error occurred during synchronization.', 'error');
    } finally {
      setIsSyncing(false);
      setSyncStatus('');
      setSyncProgress(0);
    }
  };

  const formatPhoneNumber = (value: string) => {
    if (!value) return value;
    const phoneNumber = value.replace(/[^\d]/g, '');
    const phoneNumberLength = phoneNumber.length;
    if (phoneNumberLength < 4) return phoneNumber;
    if (phoneNumberLength < 7) {
      return `(${phoneNumber.slice(0, 3)}) ${phoneNumber.slice(3)}`;
    }
    return `(${phoneNumber.slice(0, 3)}) ${phoneNumber.slice(3, 6)}-${phoneNumber.slice(6, 10)}`;
  };

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const formattedValue = formatPhoneNumber(e.target.value);
    setClientPhone(formattedValue);
  };

  const initiateCallOut = async () => {
    const cleanNumber = clientPhone.replace(/\D/g, '');

    if (cleanNumber.length !== 10) {
      showNotification('Invalid Number', 'Please enter a 10-digit US phone number.', 'error');
      return;
    }

    const e164Number = `+1${cleanNumber}`;
    setIsCallingOut(true);
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/twilio/call-out`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientPhoneNumber: e164Number }),
      });
      const data = await response.json();
      if (response.ok) {
        showNotification('Calling Attorney', 'Please answer your phone. Twilio will bridge to the client.', 'info');
        setClientPhone('');
      } else {
        showNotification('Call Failed', data.error || 'Unknown error', 'error');
      }
    } catch (error: any) {
      showNotification('Call Failed', error.message, 'error');
    } finally {
      setIsCallingOut(false);
    }
  };

  const handleMultimodalUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setIsAnalyzingFiles(true);
    showNotification('Analyzing Materials', `Processing ${files.length} file(s) with Gemini...`, 'info');

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }

    // If we are currently in "results" view, we can link these to the current record
    if (view === 'results' && selectedRecordId) {
      formData.append('existingRecordId', selectedRecordId);
    }

    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/intake/process`, {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();
      if (response.ok) {
        showNotification('Analysis Complete', 'Materials successfully added to the matter.', 'success');
        await fetchRecords();
        // Load the updated/new record
        loadRecord(data.record);
      } else {
        showNotification('Analysis Failed', data.error || 'Unknown error', 'error');
      }
    } catch (error: any) {
      showNotification('Analysis Failed', error.message, 'error');
    } finally {
      setIsAnalyzingFiles(false);
      if (docInputRef.current) docInputRef.current.value = '';
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    showNotification('Copied', 'Phone number copied to clipboard', 'success');
  };

  const loadRecord = (record: any) => {
    // For matter collections without audio, create a placeholder transcript
    if (record.transcript) {
      setTranscript(record.transcript);
    } else {
      // Placeholder so the results view renders
      setTranscript({ id: record.id, status: 'completed', text: '' });
    }
    setSummary(record.summary);

    // Resolve audio URL — check both legacy field and items array
    let resolvedAudioUrl = record.audioUrl;
    if (!resolvedAudioUrl && record.items) {
      const audioItem = record.items.find((i: any) => i.type === 'audio');
      if (audioItem) resolvedAudioUrl = audioItem.url;
    }

    if (resolvedAudioUrl) {
      if (resolvedAudioUrl.startsWith('http')) {
        setAudioUrl(resolvedAudioUrl);
      } else {
        const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
        setAudioUrl(`${baseUrl}${resolvedAudioUrl}`);
      }
    } else {
      setAudioUrl(null);
    }

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
            {view !== 'history' && (
              <button
                className="btn-icon"
                onClick={() => setView('history')}
                title="Back to History"
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
              {view === 'history' ? (
                <>
                  <Plus size={20} />
                  <span className="hide-mobile">New Intake</span>
                </>
              ) : (
                <>
                  <History size={20} />
                  <span className="hide-mobile">History</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      {view === 'history' && (
        <main className="glass-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
            <div className="section-title" style={{ marginBottom: 0 }}>
              <History size={24} className="icon-small" style={{ color: 'var(--accent-primary)' }} />
              Consultation History
            </div>
            <button
              className={`btn-history ${isSyncing ? 'loading' : ''}`}
              onClick={syncFromTwilio}
              disabled={isSyncing}
              style={{ fontSize: '0.8rem', padding: '0.5rem 0.8rem' }}
            >
              <RefreshCw size={14} className={isSyncing ? 'spin' : ''} />
              {isSyncing ? 'Syncing...' : 'Sync Twilio'}
            </button>
          </div>

          {isSyncing && (
            <div className="sync-status-bar">
              <div className="sync-info">
                <span>{syncStatus}</span>
                <span>{Math.round(syncProgress)}%</span>
              </div>
              <div className="sync-progress-container">
                <div className="progress-fill" style={{ width: `${syncProgress}%` }}></div>
              </div>
            </div>
          )}

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
                      <div className="matter-badge-group">
                        {record.items?.some((i: any) => i.type === 'audio') && <PhoneCall size={12} className="badge-icon" />}
                        {record.items?.filter((i: any) => i.type === 'image').length > 0 && <span><ImageIcon size={12} /> {record.items.filter((i: any) => i.type === 'image').length}</span>}
                        {record.items?.filter((i: any) => i.type === 'pdf').length > 0 && <span><FileIcon size={12} /> {record.items.filter((i: any) => i.type === 'pdf').length}</span>}
                      </div>
                    </div>
                    <div className="history-preview">
                      {record.summary ? record.summary.substring(0, 80) + '...' : (record.transcript?.text?.substring(0, 80) || 'Processing...')}
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
      )
      }

      {
        view === 'results' && transcript && (summary || records.find(r => r.id === selectedRecordId)?.items?.length > 0) && (
          <div className="results-container">
            <div className="glass-card summary-card">
              <div className="section-title">
                <FileText size={24} style={{ color: 'var(--success)' }} />
                {records.find(r => r.id === selectedRecordId)?.items ? 'Matter Analysis' : 'Structured Intake Record'}
              </div>
              <div className="markdown-body">
                <ReactMarkdown>{summary}</ReactMarkdown>
              </div>
            </div>

            <div className="glass-card transcript-card-wrapper">
              <div className="section-title">
                Transcript
              </div>

              {audioUrl && (
                <div className="audio-player-container">
                  <audio ref={audioRef} controls src={audioUrl} />
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem', textAlign: 'center' }}>
                    Click any word to jump to that timestamp
                  </p>
                </div>
              )}

              <div className="transcript-card">
                {records.find(r => r.id === selectedRecordId)?.items?.filter((i: any) => i.type === 'audio').length > 0 || transcript.utterances ? (
                  transcript.utterances ? (
                    transcript.utterances.map((utt, i) => (
                      <div key={i} className="utterance">
                        <div className={`speaker-tag speaker-${utt.speaker}`}>
                          Speaker {utt.speaker} <span className="timestamp">{formatTime(utt.start)}</span>
                        </div>
                        <p>
                          {utt.words.map((word, wordIndex) => (
                            <span
                              key={wordIndex}
                              className={`transcript-word ${currentTime >= word.start && currentTime <= word.end ? 'active' : ''}`}
                              onClick={() => handleWordClick(word.start)}
                            >
                              {word.text}{' '}
                            </span>
                          ))}
                        </p>
                      </div>
                    ))
                  ) : (
                    <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                      No detailed transcript available for this audio.
                    </div>
                  )
                ) : (
                  <div className="no-transcript-placeholder">
                    <FileText size={48} style={{ opacity: 0.1, marginBottom: '1rem' }} />
                    <p>This matter collection focuses on document/image analysis.</p>
                  </div>
                )}
              </div>

              {records.find(r => r.id === selectedRecordId)?.items && records.find(r => r.id === selectedRecordId)?.items.length > 0 && (
                <div className="linked-items-section">
                  <div className="section-title-small">Linked Materials</div>
                  <div className="items-grid">
                    {records.find(r => r.id === selectedRecordId).items.map((item: any, idx: number) => (
                      <div key={idx} className="linked-item-card" onClick={() => {
                        if (item.type === 'audio') {
                          // Scroll to audio player
                          audioRef.current?.scrollIntoView({ behavior: 'smooth' });
                          audioRef.current?.focus();
                        } else {
                          // Open images and PDFs in a new tab
                          const base = import.meta.env.VITE_API_URL || 'http://localhost:3001';
                          window.open(`${base}${item.url}`, '_blank');
                        }
                      }}>
                        {item.type === 'image' ? <ImageIcon size={20} /> : item.type === 'audio' ? <PlayCircle size={20} /> : <FileIcon size={20} />}
                        <div className="item-meta">
                          <span className="item-name">{item.name || `Item ${idx + 1}`}</span>
                          <span className="item-type">{item.type.toUpperCase()}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button className="btn-add-more" onClick={() => docInputRef.current?.click()} disabled={isAnalyzingFiles}>
                    <Plus size={16} /> {isAnalyzingFiles ? 'Analyzing...' : 'Add More Materials'}
                  </button>
                  <input
                    type="file"
                    className="file-input"
                    ref={docInputRef}
                    accept="image/*,application/pdf"
                    multiple
                    onChange={(e) => handleMultimodalUpload(e)}
                  />
                </div>
              )}
            </div>
          </div>
        )
      }

      {
        view === 'home' && !transcript && !isProcessing && (
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

              <div className="action-card call-card">
                <PhoneCall className="icon" />
                <h3>Call Client</h3>
                <p className="text-secondary">Two-legged dial via Twilio</p>
                <div className="call-input-group" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="tel"
                    placeholder="(555) 000-0000"
                    value={clientPhone}
                    onChange={handlePhoneChange}
                    className="call-input"
                  />
                  <button
                    className="btn-dial"
                    onClick={initiateCallOut}
                    disabled={isCallingOut}
                  >
                    {isCallingOut ? <RefreshCw className="spin" size={16} /> : 'Dial'}
                  </button>
                </div>
              </div>

              <div
                className={`action-card ${isAnalyzingFiles ? 'processing' : ''}`}
                onClick={() => docInputRef.current?.click()}
              >
                {isAnalyzingFiles ? (
                  <RefreshCw className="icon spin" />
                ) : (
                  <FileIcon className="icon" />
                )}
                <h3>Analyze Matters</h3>
                <p className="text-secondary">Upload images or PDFs for analysis</p>
                <input
                  type="file"
                  className="file-input"
                  ref={docInputRef}
                  accept="image/*,application/pdf"
                  multiple
                  onChange={(e) => handleMultimodalUpload(e)}
                />
              </div>

              {twilioNumber && (
                <div className="action-card info-card">
                  <div className="icon-container">
                    <PhoneCall className="icon" />
                  </div>
                  <h3>Client Call-In</h3>
                  <p className="text-secondary">Give this number to your client</p>
                  <div className="phone-display" onClick={() => copyToClipboard(twilioNumber)}>
                    <span className="phone-text">{twilioNumber}</span>
                    <Copy size={16} className="copy-icon" />
                  </div>
                </div>
              )}
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

      {
        notification && (
          <div className="toast-container">
            <div className={`toast ${notification.type}`}>
              <div className="toast-content">
                <div className="toast-title">
                  {notification.type === 'success' && <CheckCircle size={16} style={{ verticalAlign: 'middle', marginRight: '0.5rem', color: '#22c55e' }} />}
                  {notification.type === 'error' && <AlertCircle size={16} style={{ verticalAlign: 'middle', marginRight: '0.5rem', color: '#ef4444' }} />}
                  {notification.title}
                </div>
                <div className="toast-message">{notification.message}</div>
              </div>
              <button className="toast-close" onClick={() => setNotification(null)}>
                <X size={18} />
              </button>
            </div>
          </div>
        )
      }
    </div >
  );
}

export default App;
