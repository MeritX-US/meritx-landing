import React, { useState, useRef, useEffect } from 'react';
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
  fileName?: string;
  audioUrl?: string;
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
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [pendingSeek, setPendingSeek] = useState<number | null>(null);
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
  const [isRegenerating, setIsRegenerating] = useState(false);
  const docInputRef = useRef<HTMLInputElement>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedFilesRef = useRef<HTMLDivElement>(null);
  const recordedPlayerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (uploadFiles.length > 0 && selectedFilesRef.current) {
      setTimeout(() => {
        selectedFilesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
    }
  }, [uploadFiles.length]);

  useEffect(() => {
    if (audioUrl && recordedPlayerRef.current) {
      setTimeout(() => {
        recordedPlayerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
    }
  }, [audioUrl]);

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

  const handleRegenerateSummary = async () => {
    if (!selectedRecordId) return;
    
    setIsRegenerating(true);
    showNotification('Regenerating Analysis', 'Re-analyzing all materials to generate a clean summary...', 'info');
    
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/intake/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ existingRecordId: selectedRecordId }),
      });

      const data = await response.json();
      if (response.ok) {
        showNotification('Analysis Complete', 'A fresh, clean summary has been generated.', 'success');
        await fetchRecords();
        loadRecord(data.record);
      } else {
        showNotification('Regeneration Failed', data.error || 'Unknown error', 'error');
      }
    } catch (error: any) {
      showNotification('Regeneration Failed', error.message, 'error');
    } finally {
      setIsRegenerating(false);
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
        setUploadFiles([]);
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
    const files = Array.from(event.target.files || []);
    if (files.length > 0) {
      setUploadFiles(prev => [...prev, ...files]);
      setAudioFile(null);
      setAudioUrl(null);
      setTranscript(null);
      setSummary(null);
      
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const moveFileUp = (index: number) => {
    if (index === 0) return;
    const newFiles = [...uploadFiles];
    const temp = newFiles[index - 1];
    newFiles[index - 1] = newFiles[index];
    newFiles[index] = temp;
    setUploadFiles(newFiles);
  };

  const moveFileDown = (index: number) => {
    if (index === uploadFiles.length - 1) return;
    const newFiles = [...uploadFiles];
    const temp = newFiles[index + 1];
    newFiles[index + 1] = newFiles[index];
    newFiles[index] = temp;
    setUploadFiles(newFiles);
  };
  
  const removeFile = (index: number) => {
    const newFiles = [...uploadFiles];
    newFiles.splice(index, 1);
    setUploadFiles(newFiles);
  };

  const processAudio = async () => {
    if (!audioFile && uploadFiles.length === 0) return;

    setIsProcessing(true);
    setProcessingStatus('Transcribing audio (this may take a minute)...');
    setProcessingError(null);

    const formData = new FormData();
    if (audioFile) {
        formData.append('audios', audioFile, 'consultation.webm');
    } else {
        uploadFiles.forEach(file => {
            formData.append('audios', file);
        });
    }
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

      if (transData.record) {
        loadRecord(transData.record);
      } else {
        setTranscript(transData.transcript);
        setSummary(transData.summary);
        setSelectedRecordId(transData.recordId);
        setView('results');
      }

      fetchRecords(); // Refresh history

    } catch (error: any) {
      console.error('Processing error:', error);
      setProcessingError(error.message || 'An error occurred during processing.');
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  const handleWordClick = (utt: any, startTimeMs: number) => {
    if (audioRef.current) {
      const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const record = records.find(r => r.id === selectedRecordId);
      const audioItems = record?.items?.filter((i: any) => i.type === 'audio') || [];
      const firstAudioUrl = audioItems[0]?.url;
      const targetUrl = utt.audioUrl || utt.fileUrl || firstAudioUrl;
      const fullUrl = targetUrl ? (targetUrl.startsWith('http') ? targetUrl : `${baseUrl}${targetUrl}`) : null;

      if (fullUrl && audioUrl !== fullUrl) {
        // Register play in user gesture context before changing the src via state
        audioRef.current.play().catch(() => {});
        setAudioUrl(fullUrl);
        setPendingSeek(startTimeMs / 1000);
      } else {
        const seekTime = startTimeMs / 1000;
        if (audioRef.current.readyState < 1) {
          setPendingSeek(seekTime);
        } else {
          audioRef.current.currentTime = seekTime;
        }
        audioRef.current.play().catch(err => {
          console.warn("Audio play failed:", err);
        });
      }
    }
  };

  const isActiveWord = (utt: any, word: any) => {
    const record = records.find(r => r.id === selectedRecordId);
    const audioItems = record?.items?.filter((i: any) => i.type === 'audio') || [];
    const firstAudioUrl = audioItems[0]?.url;
    const targetUrl = utt.audioUrl || utt.fileUrl || firstAudioUrl;
    const isSameAudio = !targetUrl || (audioUrl && audioUrl.endsWith(targetUrl));
    return isSameAudio && currentTime >= word.start && currentTime <= word.end;
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
              onClick={() => {
                if (view === 'history') {
                  setTranscript(null);
                  setSummary(null);
                  setAudioUrl(null);
                  setAudioFile(null);
                  setUploadFiles([]);
                  setSelectedRecordId(null);
                  setView('home');
                } else {
                  setView('history');
                }
              }}
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
              <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <FileText size={24} style={{ color: 'var(--success)' }} />
                  {records.find(r => r.id === selectedRecordId)?.items ? 'Matter Analysis' : 'Structured Intake Record'}
                </div>
                {records.find(r => r.id === selectedRecordId)?.items && (
                  <button 
                    onClick={handleRegenerateSummary} 
                    disabled={isRegenerating}
                    title="Regenerate Full Summary"
                    style={{
                      background: 'none', border: '1px solid var(--border-color)', borderRadius: '8px',
                      padding: '0.4rem 0.6rem', color: 'var(--text-secondary)', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem',
                      opacity: isRegenerating ? 0.5 : 1
                    }}
                  >
                    <RefreshCw size={14} className={isRegenerating ? 'spin' : ''} />
                    <span className="hide-mobile">Regenerate</span>
                  </button>
                )}
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
                  <audio 
                    ref={audioRef} 
                    controls 
                    src={audioUrl} 
                    onLoadedMetadata={() => {
                      if (pendingSeek !== null && audioRef.current) {
                        const seekTime = pendingSeek;
                        setPendingSeek(null);
                        setTimeout(() => {
                          if (audioRef.current) {
                            audioRef.current.currentTime = seekTime;
                            audioRef.current.play().catch(() => {});
                          }
                        }, 50);
                      }
                    }}
                  />
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem', textAlign: 'center' }}>
                    Click any word to jump to that timestamp
                  </p>
                </div>
              )}

              <div className="transcript-card">
                {records.find(r => r.id === selectedRecordId)?.items?.filter((i: any) => i.type === 'audio').length > 0 || transcript.utterances ? (
                  transcript.utterances ? (
                    (() => {
                      const record = records.find(r => r.id === selectedRecordId);
                      const audioItems = record?.items?.filter((i: any) => i.type === 'audio') || [];
                      const hasAudioUrls = transcript.utterances.some((u: any) => u.audioUrl || u.fileUrl);
                      
                      const activeUtterances = (hasAudioUrls && audioUrl)
                        ? transcript.utterances.filter((utt: any) => {
                            const targetUrl = utt.audioUrl || utt.fileUrl || audioItems[0]?.url;
                            return targetUrl && audioUrl.endsWith(targetUrl);
                          })
                        : transcript.utterances;

                      return (
                        <>
                          {audioItems.length > 1 && (
                            <div className="audio-tabs" style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem', flexWrap: 'wrap' }}>
                              {audioItems.map((item: any, idx: number) => {
                                const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
                                const fullUrl = item.url.startsWith('http') ? item.url : `${baseUrl}${item.url}`;
                                const isActive = audioUrl === fullUrl;
                                return (
                                  <button
                                    key={idx}
                                    className={`btn-tab ${isActive ? 'active' : ''}`}
                                    onClick={() => {
                                      setAudioUrl(fullUrl);
                                      if (audioRef.current) {
                                        audioRef.current.src = fullUrl;
                                        audioRef.current.load();
                                        audioRef.current.play().catch(e => console.error(e));
                                      }
                                    }}
                                    style={{
                                      padding: '0.4rem 0.8rem',
                                      borderRadius: '16px',
                                      border: '1px solid',
                                      borderColor: isActive ? 'var(--accent-primary)' : 'var(--border-color)',
                                      background: isActive ? 'rgba(59, 130, 246, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                                      color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                      fontWeight: isActive ? '600' : 'normal',
                                      cursor: 'pointer',
                                      fontSize: '0.8rem',
                                      transition: 'all 0.2s',
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '0.3rem'
                                    }}
                                  >
                                    <PhoneCall size={12} />
                                    {item.name || `Recording ${idx + 1}`}
                                  </button>
                                );
                              })}
                            </div>
                          )}

                          {activeUtterances.length === 0 ? (
                            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                              No transcript text for this clip.
                            </div>
                          ) : (
                            activeUtterances.map((utt: any, i: number) => {
                              return (
                                <div className="utterance" key={i}>
                                  <div className={`speaker-tag speaker-${utt.speaker}`}>
                                    Speaker {utt.speaker} <span className="timestamp">{formatTime(utt.start)}</span>
                                  </div>
                                  <p>
                                    {utt.words.map((word: any, wordIndex: number) => (
                                      <span
                                        key={wordIndex}
                                        className={`transcript-word ${isActiveWord(utt, word) ? 'active' : ''}`}
                                        onClick={() => handleWordClick(utt, word.start)}
                                      >
                                        {word.text}{' '}
                                      </span>
                                    ))}
                                  </p>
                                </div>
                              );
                            })
                          )}
                        </>
                      );
                    })()
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
                          const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
                          const fullUrl = item.url.startsWith('http') ? item.url : `${baseUrl}${item.url}`;
                          if (audioUrl !== fullUrl) {
                            audioRef.current?.play().catch(() => {});
                            setAudioUrl(fullUrl);
                          } else {
                            audioRef.current?.play().catch(e => console.error(e));
                          }
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
                    accept="audio/*,image/*,application/pdf,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
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
        view === 'home' && !isProcessing && (
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
                  multiple
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
                <p className="text-secondary">Upload images, PDFs, or Word docs</p>
                <input
                  type="file"
                  className="file-input"
                  ref={docInputRef}
                  accept="audio/*,image/*,application/pdf,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
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
              <div ref={recordedPlayerRef} style={{ marginTop: '2rem', textAlign: 'center' }}>
                <div className="audio-player-container">
                  <audio controls src={audioUrl}></audio>
                </div>
                <button className="btn btn-primary" onClick={processAudio}>
                  <FileText size={20} />
                  Generate Intake Record
                </button>
              </div>
            )}
            
            {uploadFiles.length > 0 && !isRecording && (
              <div ref={selectedFilesRef} className="glass-card selected-files-card" style={{ marginTop: '2.5rem', maxWidth: '600px', margin: '2.5rem auto 0', padding: '1.5rem', border: '1px solid rgba(59, 130, 246, 0.3)', background: 'rgba(30, 41, 59, 0.4)', boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.2)', borderRadius: '16px' }}>
                <h4 style={{ marginBottom: '1.2rem', color: 'var(--accent-primary)', fontSize: '1.1rem', fontWeight: '600', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                  <FileText size={18} />
                  Selected Audio Files ({uploadFiles.length})
                </h4>
                <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1.5rem 0', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {uploadFiles.map((file, idx) => (
                    <li key={idx} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', background: 'rgba(255, 255, 255, 0.03)', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.05)', transition: 'background 0.2s' }}>
                      <span style={{ fontSize: '0.95rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '350px', fontWeight: '500' }}>
                         {idx + 1}. {file.name}
                      </span>
                      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                        <button onClick={() => moveFileUp(idx)} disabled={idx === 0} title="Move Up" style={{ background: 'rgba(255,255,255,0.05)', border: 'none', borderRadius: '4px', width: '28px', height: '28px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: idx === 0 ? 'var(--text-muted)' : 'var(--text-secondary)' }}>↑</button>
                        <button onClick={() => moveFileDown(idx)} disabled={idx === uploadFiles.length - 1} title="Move Down" style={{ background: 'rgba(255,255,255,0.05)', border: 'none', borderRadius: '4px', width: '28px', height: '28px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: idx === uploadFiles.length - 1 ? 'var(--text-muted)' : 'var(--text-secondary)' }}>↓</button>
                        <button onClick={() => removeFile(idx)} title="Remove" style={{ background: 'rgba(239, 68, 68, 0.1)', border: 'none', borderRadius: '4px', width: '28px', height: '28px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--danger)' }}>✕</button>
                      </div>
                    </li>
                  ))}
                </ul>
                <div style={{ display: 'flex', gap: '1rem' }}>
                  <button className="btn" onClick={() => fileInputRef.current?.click()} style={{ flex: 1, justifyContent: 'center', padding: '0.8rem', background: 'rgba(255, 255, 255, 0.05)', color: 'var(--text-primary)', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
                    <Upload size={20} />
                    Add MORE Materials
                  </button>
                  <button className="btn btn-primary" onClick={processAudio} style={{ flex: 2, justifyContent: 'center', padding: '0.8rem' }}>
                    <FileText size={20} />
                    Generate Intake Record
                  </button>
                </div>
              </div>
            )}
          </main>
        )
      }

      {
        isProcessing && (
          <div className="loading-overlay">
            <div className="glass-card loading-card" style={{ maxWidth: '480px', width: '90%', padding: '3rem 2rem', textAlign: 'center', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3)' }}>
              <div className="spinner" style={{ width: '48px', height: '48px', borderWidth: '5px' }}></div>
              <h3 style={{ fontSize: '1.5rem', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '0.75rem' }}>Processing Consultation</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginTop: '0.5rem', lineHeight: '1.5' }}>{processingStatus}</p>
            </div>
          </div>
        )
      }

      {
        isAnalyzingFiles && (
          <div className="loading-overlay">
            <div className="glass-card loading-card" style={{ maxWidth: '480px', width: '90%', padding: '3rem 2rem', textAlign: 'center', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3)' }}>
              <div className="spinner" style={{ width: '48px', height: '48px', borderWidth: '5px' }}></div>
              <h3 style={{ fontSize: '1.5rem', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '0.75rem' }}>Analyzing Materials</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginTop: '0.5rem', lineHeight: '1.5' }}>
                Transcribing audio files and incorporating new insights into the intake summary... Please wait, this may take a moment.
              </p>
            </div>
          </div>
        )
      }

      {
        isRegenerating && (
          <div className="loading-overlay">
            <div className="glass-card loading-card" style={{ maxWidth: '480px', width: '90%', padding: '3rem 2rem', textAlign: 'center', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3)' }}>
              <div className="spinner" style={{ width: '48px', height: '48px', borderWidth: '5px' }}></div>
              <h3 style={{ fontSize: '1.5rem', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '0.75rem' }}>Regenerating Summary</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginTop: '0.5rem', lineHeight: '1.5' }}>
                Re-analyzing all transcripts and documents to build a fresh, cohesive report...
              </p>
            </div>
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
