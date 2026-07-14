import React, { useState, useRef, useEffect, useCallback } from 'react';
import JSZip from 'jszip';
import { Upload, Mic, AlertCircle, FileText, PlayCircle, Square, History, ArrowLeft, Trash2, Calendar, RefreshCw, X, CheckCircle, Plus, PhoneCall, Copy, FileIcon, ImageIcon, Edit3, Save, Wand2, Send, HelpCircle, Download } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import './App.css';

const generatePDFBlob = (textContent: string): Blob => {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'in',
    format: 'letter'
  });
  
  doc.setFont('times', 'normal');
  doc.setFontSize(11);
  
  const lines = textContent.split('\n');
  const margin = 1.0;
  const pageWidth = 8.5;
  const pageHeight = 11.0;
  const maxLineWidth = pageWidth - (margin * 2);
  const maxPageHeight = pageHeight - margin;
  let cursorY = margin;
  
  lines.forEach((line) => {
    if (line.trim() === '') {
      cursorY += 0.2;
      return;
    }
    
    let isHeading = false;
    let headingFontSize = 11;
    let cleanLine = line;
    
    if (line.startsWith('# ')) {
      isHeading = true;
      headingFontSize = 16;
      cleanLine = line.substring(2);
      doc.setFont('times', 'bold');
      doc.setFontSize(headingFontSize);
    } else if (line.startsWith('## ')) {
      isHeading = true;
      headingFontSize = 13;
      cleanLine = line.substring(3);
      doc.setFont('times', 'bold');
      doc.setFontSize(headingFontSize);
    } else if (line.startsWith('### ')) {
      isHeading = true;
      headingFontSize = 11;
      cleanLine = line.substring(4);
      doc.setFont('times', 'bold');
      doc.setFontSize(headingFontSize);
    } else if (line.startsWith('#### ')) {
      isHeading = true;
      headingFontSize = 11;
      cleanLine = line.substring(5);
      doc.setFont('times', 'bold');
      doc.setFontSize(headingFontSize);
    } else {
      doc.setFont('times', 'normal');
      doc.setFontSize(11);
    }
    
    cleanLine = cleanLine.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^- /g, '• ').replace(/^\* /g, '• ');
    
    const wrappedText = doc.splitTextToSize(cleanLine, maxLineWidth);
    
    wrappedText.forEach((wrappedLine: string) => {
      if (cursorY + 0.25 > maxPageHeight) {
        doc.addPage();
        cursorY = margin;
        if (isHeading) {
          doc.setFont('times', 'bold');
          doc.setFontSize(headingFontSize);
        } else {
          doc.setFont('times', 'normal');
          doc.setFontSize(11);
        }
      }
      
      doc.text(wrappedLine, margin, cursorY);
      cursorY += isHeading ? 0.3 : 0.22;
    });
    
    if (isHeading) {
      cursorY += 0.1;
    }
  });
  
  return doc.output('blob');
};

const generateExhibitIndexPDF = (documents: any[]): Blob => {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'in',
    format: 'letter'
  });
  
  doc.setFont('times', 'bold');
  doc.setFontSize(16);
  doc.text("EXHIBIT INDEX", 4.25, 1.0, { align: 'center' });
  
  doc.setFont('times', 'normal');
  doc.setFontSize(10);
  doc.text("In Support of Concurrent Filing of Form I-130 and Form I-485", 4.25, 1.3, { align: 'center' });
  
  const head = [['Exhibit', 'Document Description', 'Status', 'Linked File']];
  const body = documents.map((docItem: any, idx: number) => {
    const letter = String.fromCharCode(65 + idx);
    const isProvided = docItem.status === 'provided';
    return [
      `Exhibit ${letter}`,
      docItem.label,
      isProvided ? 'MATCHED' : 'MISSING',
      isProvided ? (docItem.fileName || 'Provided') : 'Not Provided'
    ];
  });
  
  autoTable(doc, {
    startY: 1.6,
    margin: { left: 1.0, right: 1.0 },
    head: head,
    body: body,
    theme: 'striped',
    headStyles: {
      fillColor: [71, 85, 105],
      textColor: 255,
      font: 'times',
      fontStyle: 'bold',
      fontSize: 10
    },
    bodyStyles: {
      font: 'times',
      fontSize: 9,
      textColor: [15, 23, 42]
    },
    columnStyles: {
      0: { cellWidth: 1.0, fontStyle: 'bold' },
      1: { cellWidth: 3.0 },
      2: { cellWidth: 1.0 },
      3: { cellWidth: 1.5 }
    },
    didParseCell: (data) => {
      if (data.column.index === 2 && data.section === 'body') {
        const statusText = data.cell.text[0];
        if (statusText === 'MATCHED') {
          data.cell.styles.textColor = [22, 163, 74];
          data.cell.styles.fontStyle = 'bold';
        } else if (statusText === 'MISSING') {
          data.cell.styles.textColor = [220, 38, 38];
          data.cell.styles.fontStyle = 'bold';
        }
      }
    }
  });
  
  return doc.output('blob');
};

const generateFormMappingPDF = (uscisFormMapping: any, facts: any): Blob => {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'in',
    format: 'letter'
  });
  
  doc.setFont('times', 'bold');
  doc.setFontSize(16);
  doc.text("USCIS FORM FIELD MAPPINGS", 4.25, 1.0, { align: 'center' });
  
  let currentY = 1.3;
  
  const forms = Object.keys(uscisFormMapping || {});
  if (forms.length === 0) {
    doc.setFont('times', 'normal');
    doc.setFontSize(11);
    doc.text("No Form Mappings found in the analysis payload.", 1.0, currentY);
    return doc.output('blob');
  }
  
  forms.forEach((formName, formIdx) => {
    const fields = uscisFormMapping[formName] || {};
    const fieldKeys = Object.keys(fields);
    
    if (fieldKeys.length === 0) return;
    
    if (formIdx > 0) {
      currentY += 0.3;
    }
    
    if (currentY > 9.5) {
      doc.addPage();
      currentY = 1.0;
    }
    
    doc.setFont('times', 'bold');
    doc.setFontSize(12);
    doc.text(`Form ${formName} Mappings`, 1.0, currentY);
    currentY += 0.15;
    
    const head = [['Field Name', 'Mapped Value', 'Source Audit Trail']];
    const body = fieldKeys.map((fieldName) => {
      const matchingFactKey = Object.keys(facts || {}).find(k => k === fieldName || fieldName.includes(k));
      const sourceText = matchingFactKey ? facts[matchingFactKey]?.source : 'Extracted from intake';
      const cleanFieldName = fieldName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      return [
        cleanFieldName,
        String(fields[fieldName] || ''),
        sourceText
      ];
    });
    
    autoTable(doc, {
      startY: currentY,
      margin: { left: 1.0, right: 1.0 },
      head: head,
      body: body,
      theme: 'striped',
      headStyles: {
        fillColor: [71, 85, 105],
        textColor: 255,
        font: 'times',
        fontStyle: 'bold',
        fontSize: 9
      },
      bodyStyles: {
        font: 'times',
        fontSize: 8.5,
        textColor: [15, 23, 42]
      },
      columnStyles: {
        0: { cellWidth: 1.8, fontStyle: 'bold' },
        1: { cellWidth: 2.0 },
        2: { cellWidth: 2.7 }
      },
      didDrawPage: (data) => {
        currentY = data.cursor ? data.cursor.y + 0.3 : 1.0;
      }
    });
  });
  
  return doc.output('blob');
};

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
  const [activeResultTab, setActiveResultTab] = useState<'package' | 'completeness' | 'evidence' | 'transcript' | 'assembly'>('package');
  const [selectedAssemblyDocId, setSelectedAssemblyDocId] = useState<string>('cover-sheet');
  const [isAssembling, setIsAssembling] = useState(false);
  const [showAssemblySuccessModal, setShowAssemblySuccessModal] = useState(false);
  const [assemblyCheckedItems, setAssemblyCheckedItems] = useState<string[]>([]);

  const [clientPhone, setClientPhone] = useState('');
  const [isCallingOut, setIsCallingOut] = useState(false);
  const [twilioNumber, setTwilioNumber] = useState('');

  const [isAnalyzingFiles, setIsAnalyzingFiles] = useState(false);
  const [analyzingStatus, setAnalyzingStatus] = useState<string>('Processing files and incorporating new insights...');
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [isSavingSummary, setIsSavingSummary] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [selectionRect, setSelectionRect] = useState<{ top: number, left: number } | null>(null);
  const [showRefineInput, setShowRefineInput] = useState(false);
  const [refinePrompt, setRefinePrompt] = useState('');
  const [isRefining, setIsRefining] = useState(false);
  const [refinementFeedback, setRefinementFeedback] = useState<string | null>(null);
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

    // Check if any audio files are uploaded
    const hasAudio = Array.from(files).some(f => f.type.startsWith('audio/'));
    const message = hasAudio 
      ? "Transcribing audio files and incorporating new insights into the case analysis... Please wait, this may take a moment."
      : "Analyzing documents and images, extracting facts, and mapping evidence under your playbook rules... Please wait.";
    
    setAnalyzingStatus(message);
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

  const handleAssemblePackage = async () => {
    setIsAssembling(true);
    showNotification('Assembling Package', 'Generating Cover Letter, Form Mappings, and downloading files...', 'info');
    try {
      const record = records.find(r => r.id === selectedRecordId);
      if (!record || !record.analysis) return;
      
      const zip = new JSZip();
      
      // 1. Add Cover Letter
      const coverLetterPdf = generatePDFBlob(record.analysis.coverLetterDraft);
      zip.file("01_Cover_Letter.pdf", coverLetterPdf);
      
      // 2. Add Exhibit Index
      const exhibitIndexPdf = generateExhibitIndexPDF(record.analysis.documents);
      zip.file("02_Exhibit_Index.pdf", exhibitIndexPdf);
      
      // 3. Add USCIS Form Field Mappings
      const formMappingPdf = generateFormMappingPDF(record.analysis.uscisFormMapping, record.analysis.facts);
      zip.file("03_Form_Field_Mappings.pdf", formMappingPdf);
      
      // 4. Download and add uploaded files to exhibits/ folder
      const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      
      const downloadPromises = record.analysis.documents.map(async (doc: any, idx: number) => {
        if (doc.status === 'provided' && doc.fileName) {
          const item = record.items?.find((i: any) => i.name === doc.fileName);
          if (item && item.url) {
            try {
              const fileUrl = item.url.startsWith('http') ? item.url : `${baseUrl}${item.url}`;
              const res = await fetch(fileUrl);
              if (res.ok) {
                const blob = await res.blob();
                const letter = String.fromCharCode(65 + idx);
                const fileExt = doc.fileName.split('.').pop() || 'png';
                const cleanDocLabel = doc.label.replace(/[^a-zA-Z0-9]/g, '_');
                zip.file(`exhibits/Exhibit_${letter}_${cleanDocLabel}.${fileExt}`, blob);
              }
            } catch (e) {
              console.error(`Failed to download ${doc.fileName} for ZIP assembly:`, e);
            }
          }
        }
      });
      
      await Promise.all(downloadPromises);
      
      // Generate ZIP
      const content = await zip.generateAsync({ type: "blob" });
      
      // Download ZIP file
      const link = document.createElement('a');
      link.href = URL.createObjectURL(content);
      link.download = `Petition_Package_${record.id}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      setShowAssemblySuccessModal(true);
      showNotification('Package Assembled', 'ZIP package downloaded successfully.', 'success');
    } catch (error: any) {
      showNotification('Assembly Failed', error.message, 'error');
    } finally {
      setIsAssembling(false);
    }
  };

  const handleSaveSummary = async () => {
    if (!selectedRecordId) return;
    
    setIsSavingSummary(true);
    
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/records/${selectedRecordId}/summary`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: editContent }),
      });

      const data = await response.json();
      if (response.ok) {
        showNotification('Saved', 'Matter analysis updated successfully.', 'success');
        setSummary(editContent);
        setIsEditing(false);
        await fetchRecords();
      } else {
        showNotification('Save Failed', data.error || 'Unknown error', 'error');
      }
    } catch (error: any) {
      showNotification('Save Failed', error.message, 'error');
    } finally {
      setIsSavingSummary(false);
    }
  };

  const handleSelection = useCallback(() => {
    if (isEditing || isRefining || isRegenerating || isAnalyzingFiles) return;
    
    setTimeout(() => {
      const selection = window.getSelection();
      if (selection && selection.toString().trim().length > 0) {
        // Only trigger if selection is inside the markdown body
        const anchorNode = selection.anchorNode;
        if (anchorNode && anchorNode.parentElement && anchorNode.parentElement.closest('.markdown-body')) {
          const text = selection.toString().trim();
          setSelectedText(text);
          const range = selection.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          
          setSelectionRect({
            top: rect.top - 50,
            left: rect.left + (rect.width / 2)
          });
        }
      } else {
        if (!showRefineInput) {
          setSelectionRect(null);
          setSelectedText('');
        }
      }
    }, 50);
  }, [isEditing, isRefining, isRegenerating, isAnalyzingFiles, showRefineInput]);

  useEffect(() => {
    document.addEventListener('selectionchange', handleSelection);
    return () => {
      document.removeEventListener('selectionchange', handleSelection);
    };
  }, [handleSelection]);

  const handleInlineRefine = async () => {
    if (!selectedRecordId || !selectedText || !refinePrompt.trim()) return;
    
    setIsRefining(true);
    setShowRefineInput(false);
    setSelectionRect(null);
    showNotification('Refining Selection', 'Applying your instructions to the selected text...', 'info');
    
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/intake/refine-inline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          existingRecordId: selectedRecordId,
          selectedText,
          userPrompt: refinePrompt
        }),
      });

      const data = await response.json();
      if (response.ok) {
        showNotification('Refinement Complete', 'The summary has been updated inline.', 'success');
        if (data.explanation) {
          setRefinementFeedback(data.explanation);
        }
        await fetchRecords();
        loadRecord(data.record);
        setRefinePrompt('');
      } else {
        showNotification('Refinement Failed', data.error || 'Unknown error', 'error');
      }
    } catch (error: any) {
      showNotification('Refinement Failed', error.message, 'error');
    } finally {
      setIsRefining(false);
      setSelectedText('');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    showNotification('Copied', 'Phone number copied to clipboard', 'success');
  };

  const loadRecord = (record: any) => {
    setActiveResultTab('package');
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

  const renderLinkedMaterials = () => {
    const record = records.find(r => r.id === selectedRecordId);
    if (!record?.items || record.items.length === 0) return null;
    
    return (
      <div className="linked-items-section" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
        <div className="section-title-small" style={{ marginBottom: '1rem' }}>Linked Materials</div>
        <div className="items-grid" style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.75rem' }}>
          {record.items.map((item: any, idx: number) => (
            <div 
              key={idx} 
              className="linked-item-card" 
              onClick={() => {
                if (item.type === 'audio') {
                  const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
                  const fullUrl = item.url.startsWith('http') ? item.url : `${baseUrl}${item.url}`;
                  if (audioUrl !== fullUrl) {
                    setAudioUrl(fullUrl);
                    if (audioRef.current) {
                      audioRef.current.src = fullUrl;
                      audioRef.current.load();
                    }
                  }
                  setActiveResultTab('transcript');
                  setTimeout(() => {
                    audioRef.current?.play().catch(e => console.error(e));
                  }, 100);
                } else {
                  // Open images and PDFs in a new tab
                  const base = import.meta.env.VITE_API_URL || 'http://localhost:3001';
                  window.open(`${base}${item.url}`, '_blank');
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.75rem',
                borderRadius: '8px',
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid var(--border-color)',
                cursor: 'pointer',
                transition: 'all 0.2s',
                overflow: 'hidden'
              }}
            >
              {item.type === 'image' ? <ImageIcon size={20} style={{ color: 'var(--accent-primary)' }} /> : item.type === 'audio' ? <PlayCircle size={20} style={{ color: 'var(--accent-primary)' }} /> : <FileIcon size={20} style={{ color: 'var(--accent-primary)' }} />}
              <div className="item-meta" style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                <span className="item-name" title={item.name || `Item ${idx + 1}`} style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name || `Item ${idx + 1}`}</span>
                <span className="item-type" style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{item.type.toUpperCase()}</span>
              </div>
            </div>
          ))}
        </div>
        <button 
          className="btn-add-more" 
          onClick={() => docInputRef.current?.click()} 
          disabled={isAnalyzingFiles}
          style={{
            marginTop: '1.25rem',
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
            padding: '0.6rem',
            background: 'none',
            border: '1px dashed var(--border-color)',
            borderRadius: '8px',
            color: 'var(--text-primary)',
            fontSize: '0.85rem',
            cursor: 'pointer',
            transition: 'all 0.2s'
          }}
        >
          <Plus size={16} /> {isAnalyzingFiles ? 'Analyzing...' : 'Add More Materials'}
        </button>
        <input
          type="file"
          className="file-input"
          ref={docInputRef}
          accept="audio/*,image/*,application/pdf,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          multiple
          onChange={(e) => handleMultimodalUpload(e)}
          style={{ display: 'none' }}
        />
      </div>
    );
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
        view === 'results' && transcript && (summary || records.find(r => r.id === selectedRecordId)?.items?.length > 0) && (() => {
          const record = records.find(r => r.id === selectedRecordId);
          const analysis = record?.analysis;
          
          return (
            <div className="results-container">
              {/* Tabs Nav bar */}
              <div className="results-tab-bar-container" style={{
                gridColumn: '1 / -1',
                width: '100%',
                marginBottom: '1.25rem',
                borderBottom: '1px solid var(--border-color)'
              }}>
                <div className="results-tab-bar" style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                  width: '100%',
                  paddingBottom: '0.75rem',
                  marginBottom: '-1px'
                }}>
                  <button
                    className={`btn-tab ${activeResultTab === 'package' ? 'active' : ''}`}
                    onClick={() => setActiveResultTab('package')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      padding: '0.5rem 1rem',
                      background: activeResultTab === 'package' ? 'rgba(59, 130, 246, 0.15)' : 'none',
                      border: activeResultTab === 'package' ? '1px solid var(--accent-primary)' : '1px solid transparent',
                      color: activeResultTab === 'package' ? 'var(--text-primary)' : 'var(--text-secondary)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                      transition: 'all 0.2s',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    <FileText size={16} />
                    <span className="hide-mobile">Intake Package</span>
                    <span className="show-mobile-inline">Intake</span>
                  </button>
                  <button
                    className={`btn-tab ${activeResultTab === 'completeness' ? 'active' : ''}`}
                    onClick={() => setActiveResultTab('completeness')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      padding: '0.5rem 1rem',
                      background: activeResultTab === 'completeness' ? 'rgba(59, 130, 246, 0.15)' : 'none',
                      border: activeResultTab === 'completeness' ? '1px solid var(--accent-primary)' : '1px solid transparent',
                      color: activeResultTab === 'completeness' ? 'var(--text-primary)' : 'var(--text-secondary)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                      transition: 'all 0.2s',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    <AlertCircle size={16} />
                    <span className="hide-mobile">Completeness & Risk Flags</span>
                    <span className="show-mobile-inline">Completeness</span>
                  </button>
                  <button
                    className={`btn-tab ${activeResultTab === 'evidence' ? 'active' : ''}`}
                    onClick={() => setActiveResultTab('evidence')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      padding: '0.5rem 1rem',
                      background: activeResultTab === 'evidence' ? 'rgba(59, 130, 246, 0.15)' : 'none',
                      border: activeResultTab === 'evidence' ? '1px solid var(--accent-primary)' : '1px solid transparent',
                      color: activeResultTab === 'evidence' ? 'var(--text-primary)' : 'var(--text-secondary)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                      transition: 'all 0.2s',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    <Upload size={16} />
                    <span className="hide-mobile">Evidence Mapping</span>
                    <span className="show-mobile-inline">Evidence</span>
                  </button>
                  <button
                    className={`btn-tab ${activeResultTab === 'transcript' ? 'active' : ''}`}
                    onClick={() => setActiveResultTab('transcript')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      padding: '0.5rem 1rem',
                      background: activeResultTab === 'transcript' ? 'rgba(59, 130, 246, 0.15)' : 'none',
                      border: activeResultTab === 'transcript' ? '1px solid var(--accent-primary)' : '1px solid transparent',
                      color: activeResultTab === 'transcript' ? 'var(--text-primary)' : 'var(--text-secondary)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                      transition: 'all 0.2s',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    <PlayCircle size={16} />
                    <span className="hide-mobile">Audio Transcript</span>
                    <span className="show-mobile-inline">Transcript</span>
                  </button>
                  <button
                    className={`btn-tab ${activeResultTab === 'assembly' ? 'active' : ''}`}
                    onClick={() => setActiveResultTab('assembly')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      padding: '0.5rem 1rem',
                      background: activeResultTab === 'assembly' ? 'rgba(59, 130, 246, 0.15)' : 'none',
                      border: activeResultTab === 'assembly' ? '1px solid var(--accent-primary)' : '1px solid transparent',
                      color: activeResultTab === 'assembly' ? 'var(--text-primary)' : 'var(--text-secondary)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                      transition: 'all 0.2s',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    <CheckCircle size={16} />
                    <span className="hide-mobile">Petition Package</span>
                    <span className="show-mobile-inline">Package</span>
                  </button>
                </div>
              </div>

              {/* 1. Intake Package Tab */}
              {activeResultTab === 'package' && (
                <>
                  <div className="glass-card summary-card">
                    <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <FileText size={24} style={{ color: 'var(--success)' }} />
                        {record?.items ? 'Intake Summary Package' : 'Structured Intake Record'}
                      </div>
                      {record?.items && (
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          {isEditing ? (
                            <>
                              <button 
                                onClick={() => setIsEditing(false)} 
                                disabled={isSavingSummary}
                                title="Cancel Editing"
                                style={{
                                  background: 'none', border: '1px solid var(--border-color)', borderRadius: '8px',
                                  padding: '0.4rem 0.6rem', color: 'var(--text-secondary)', cursor: 'pointer',
                                  display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem'
                                }}
                              >
                                <X size={14} />
                                <span className="hide-mobile">Cancel</span>
                              </button>
                              <button 
                                onClick={handleSaveSummary} 
                                disabled={isSavingSummary}
                                title="Save Summary"
                                style={{
                                  background: 'var(--primary)', border: 'none', borderRadius: '8px',
                                  padding: '0.4rem 0.6rem', color: 'white', cursor: 'pointer',
                                  display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem',
                                  opacity: isSavingSummary ? 0.5 : 1
                                }}
                              >
                                <Save size={14} className={isSavingSummary ? 'spin' : ''} />
                                <span className="hide-mobile">Save</span>
                              </button>
                            </>
                          ) : (
                            <>
                              <button 
                                onClick={() => {
                                  setEditContent(summary || '');
                                  setIsEditing(true);
                                }} 
                                disabled={isRegenerating}
                                title="Edit Summary"
                                style={{
                                  background: 'none', border: '1px solid var(--border-color)', borderRadius: '8px',
                                  padding: '0.4rem 0.6rem', color: 'var(--text-secondary)', cursor: 'pointer',
                                  display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem'
                                }}
                              >
                                <Edit3 size={14} />
                                <span className="hide-mobile">Edit</span>
                              </button>
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
                            </>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="markdown-body" onMouseUp={handleSelection} onTouchEnd={handleSelection} onKeyUp={handleSelection}>
                      {refinementFeedback && !isEditing && (
                        <div style={{
                          background: 'rgba(139, 92, 246, 0.15)',
                          border: '1px solid var(--primary)',
                          borderRadius: '8px',
                          padding: '1rem',
                          marginBottom: '1rem',
                          display: 'flex',
                          gap: '0.8rem',
                          alignItems: 'flex-start'
                        }}>
                          <Wand2 size={20} color="var(--primary)" style={{ flexShrink: 0, marginTop: '2px' }} />
                          <div style={{ flex: 1 }}>
                            <h4 style={{ margin: '0 0 0.4rem 0', color: 'var(--text-primary)', fontSize: '0.95rem' }}>✨ AI Refinement Complete</h4>
                            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: '1.5' }}>{refinementFeedback}</p>
                          </div>
                          <button 
                            onClick={() => setRefinementFeedback(null)}
                            style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.2rem' }}
                          >
                            <X size={16} />
                          </button>
                        </div>
                      )}
                      {isEditing ? (
                        <textarea 
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          style={{
                            width: '100%', minHeight: '400px', padding: '1rem', 
                            borderRadius: '8px', border: '1px solid var(--border-color)',
                            background: 'var(--card-bg)', color: 'var(--text-primary)',
                            fontFamily: 'inherit', fontSize: '0.95rem', lineHeight: '1.6',
                            resize: 'vertical', outline: 'none'
                          }}
                        />
                      ) : (
                        <ReactMarkdown>{summary}</ReactMarkdown>
                      )}
                    </div>
                  </div>

                  {/* Checklist sidebar */}
                  <div className="glass-card checklist-sidebar-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                    <div>
                      <div className="section-title-small" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '1rem' }}>
                        <CheckCircle size={18} style={{ color: 'var(--accent-primary)' }} />
                        Required Documents Checklist
                      </div>
                      {analysis ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxHeight: '320px', overflowY: 'auto', paddingRight: '0.25rem' }}>
                          {analysis.documents.map((doc: any) => {
                            const isProvided = doc.status === 'provided';
                            return (
                              <div key={doc.id} style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: '0.6rem',
                                padding: '0.6rem',
                                borderRadius: '6px',
                                background: isProvided ? 'rgba(34, 197, 94, 0.05)' : 'rgba(239, 68, 68, 0.05)',
                                border: `1px solid ${isProvided ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)'}`
                              }}>
                                <span style={{
                                  color: isProvided ? 'var(--success)' : 'var(--danger)',
                                  fontWeight: 'bold',
                                  marginTop: '1px',
                                  fontSize: '0.85rem'
                                }}>
                                  {isProvided ? '✓' : '⚠️'}
                                </span>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div title={doc.label} style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.label}</div>
                                  <div title={isProvided ? `File: ${doc.fileName}` : 'Missing / Required'} style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {isProvided ? `File: ${doc.fileName}` : 'Missing / Required'}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div style={{ padding: '1rem', borderRadius: '8px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', textAlign: 'center' }}>
                          {record?.analysisError ? (
                            <>
                              <p style={{ color: 'var(--danger)', fontSize: '0.8rem', marginBottom: '0.75rem', fontWeight: 600 }}>Analysis Failed</p>
                              <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginBottom: '0.75rem', background: 'rgba(239, 68, 68, 0.05)', padding: '0.5rem', borderRadius: '4px', textAlign: 'left' }}>
                                {record.analysisError}
                              </p>
                            </>
                          ) : (
                            <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: '0.75rem' }}>No Playbook analysis found.</p>
                          )}
                          <button className="btn-history" onClick={handleRegenerateSummary} disabled={isRegenerating} style={{ fontSize: '0.75rem', padding: '0.4rem 0.6rem' }}>
                            <RefreshCw size={12} className={isRegenerating ? 'spin' : ''} /> Run Analysis
                          </button>
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="section-title-small" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '1rem' }}>
                        <HelpCircle size={18} style={{ color: 'var(--accent-primary)' }} />
                        Follow-up Questions
                      </div>
                      {analysis ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', maxHeight: '250px', overflowY: 'auto', paddingRight: '0.25rem' }}>
                          {analysis.followUpQuestions.length === 0 ? (
                            <p style={{ color: 'var(--success)', fontSize: '0.8rem' }}>✓ All required facts extracted successfully!</p>
                          ) : (
                            analysis.followUpQuestions.map((q: any) => (
                              <div key={q.id} style={{
                                padding: '0.6rem',
                                borderRadius: '6px',
                                background: 'rgba(255, 255, 255, 0.02)',
                                border: '1px solid var(--border-color)',
                                fontSize: '0.75rem',
                                color: 'var(--text-secondary)'
                              }}>
                                <strong>Q:</strong> {q.label}
                              </div>
                            ))
                          )}
                        </div>
                      ) : (
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Run Playbook Analysis to extract questions.</p>
                      )}
                    </div>

                    {/* Linked Materials inside Checklist Sidebar Card */}
                    <div style={{ borderTop: '1px solid var(--border-color)', marginTop: '0.5rem', paddingTop: '1.5rem' }}>
                      {renderLinkedMaterials()}
                    </div>
                  </div>
                </>
              )}

              {/* 2. Completeness & Risk Flags Tab */}
              {activeResultTab === 'completeness' && (
                <>
                  <div className="glass-card completeness-dashboard-card" style={{ gridColumn: analysis?.coverLetterDraft ? 'auto' : '1 / -1' }}>
                    <div className="section-title">Case Completeness Dashboard</div>
                    {analysis ? (
                      <div>
                        {/* Overall Score Section */}
                        <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '2rem' }}>
                          <div className="completeness-ring-container" style={{ position: 'relative', width: '120px', height: '120px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <svg width="120" height="120" viewBox="0 0 120 120">
                              <circle cx="60" cy="60" r="50" stroke="rgba(255,255,255,0.05)" strokeWidth="8" fill="transparent" />
                              <circle cx="60" cy="60" r="50" stroke="var(--success)" strokeWidth="8" fill="transparent"
                                strokeDasharray={2 * Math.PI * 50}
                                strokeDashoffset={2 * Math.PI * 50 * (1 - analysis.completeness.overall / 100)}
                                strokeLinecap="round"
                                transform="rotate(-90 60 60)"
                                style={{ transition: 'stroke-dashoffset 0.5s ease-in-out' }}
                              />
                            </svg>
                            <div style={{ position: 'absolute', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                              <span style={{ fontSize: '1.75rem', fontWeight: 'bold', color: 'var(--text-primary)' }}>{analysis.completeness.overall}%</span>
                              <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Score</span>
                            </div>
                          </div>

                          <div style={{ flex: 1, minWidth: '220px', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                            <div style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                              Scenario: <span style={{ color: 'var(--accent-primary)' }}>{analysis.scenarioLabel}</span>
                            </div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                              Applied rules: <strong>{analysis.playbookName || 'Intake Playbook'}</strong>
                              {record?.caseType && (
                                <span style={{ marginLeft: '10px', padding: '2px 8px', background: 'var(--accent-primary)', color: 'white', borderRadius: '12px', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase' }}>
                                  Type: {record.caseType}
                                </span>
                              )}
                            </div>
                            {analysis.completeness.penaltiesApplied > 0 && (
                              <div style={{ fontSize: '0.8rem', color: 'var(--danger)', background: 'rgba(239, 68, 68, 0.05)', padding: '0.4rem 0.6rem', borderRadius: '6px', border: '1px solid rgba(239, 68, 68, 0.15)', display: 'inline-block', width: 'fit-content' }}>
                                ⚠️ Penalty Deductions: <strong>-{analysis.completeness.penaltiesApplied}%</strong> (from active risk flags)
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Dimension Progress Bars */}
                        <h3 style={{ fontSize: '0.95rem', color: 'var(--text-primary)', marginBottom: '0.8rem', fontWeight: 600 }}>Dimension Breakdown</h3>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '2rem' }}>
                          {Object.entries(analysis.completeness.dimensions).map(([key, score], idx) => {
                            const colors = ['var(--accent-primary)', 'var(--success)', '#F59E0B', '#EF4444', '#8B5CF6'];
                            const color = colors[idx % colors.length];
                            const label = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                            return (
                            <div key={idx} style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.4rem' }}>
                                <span style={{ color: 'var(--text-primary)', fontWeight: 550 }}>{label}</span>
                                <span style={{ color: color, fontWeight: 'bold' }}>{score as number}%</span>
                              </div>
                              <div style={{ height: '6px', background: 'rgba(255,255,255,0.05)', borderRadius: '3px', overflow: 'hidden' }}>
                                <div style={{ width: `${score}%`, height: '100%', background: color, borderRadius: '3px', transition: 'width 0.5s ease-in-out' }} />
                              </div>
                            </div>
                            );
                          })}
                        </div>

                        {/* Active Warning / Critical Banners */}
                        <h3 style={{ fontSize: '0.95rem', color: 'var(--text-primary)', marginBottom: '0.8rem', fontWeight: 600 }}>Active Risk Flags ({analysis.riskFlags.length})</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                          {analysis.riskFlags.length === 0 ? (
                            <div style={{ padding: '1rem', textAlign: 'center', background: 'rgba(34, 197, 94, 0.05)', border: '1px solid rgba(34, 197, 94, 0.15)', borderRadius: '8px', color: 'var(--success)', fontSize: '0.85rem' }}>
                              ✓ No risk flags or escalation conditions detected in this matter.
                            </div>
                          ) : (
                            analysis.riskFlags.map((flag: any) => {
                              const isCritical = flag.severity === 'critical';
                              const isHigh = flag.severity === 'high';
                              const severityColor = isCritical ? 'var(--danger)' : isHigh ? '#F59E0B' : 'var(--accent-primary)';
                              const severityBg = isCritical ? 'rgba(239, 68, 68, 0.08)' : isHigh ? 'rgba(245, 158, 11, 0.08)' : 'rgba(59, 130, 246, 0.08)';
                              const severityBorder = isCritical ? 'rgba(239, 68, 68, 0.2)' : isHigh ? 'rgba(245, 158, 11, 0.2)' : 'rgba(59, 130, 246, 0.2)';

                              return (
                                <div key={flag.id} style={{
                                  background: severityBg,
                                  border: `1px solid ${severityBorder}`,
                                  borderRadius: '8px',
                                  padding: '0.75rem 1rem',
                                  display: 'flex',
                                  gap: '0.75rem',
                                  alignItems: 'flex-start'
                                }}>
                                  <AlertCircle size={18} color={severityColor} style={{ flexShrink: 0, marginTop: '2px' }} />
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.25rem', alignItems: 'center' }}>
                                      <h4 style={{ margin: 0, fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>{flag.label}</h4>
                                      <span style={{ fontSize: '0.65rem', fontWeight: 'bold', textTransform: 'uppercase', color: severityColor, background: `rgba(255,255,255,0.05)`, padding: '0.1rem 0.3rem', borderRadius: '4px' }}>
                                        {flag.severity}
                                      </span>
                                    </div>
                                    <p style={{ margin: '0 0 0.4rem 0', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>{flag.message}</p>
                                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '0.3rem', marginTop: '0.3rem' }}>
                                      <strong>Source Trace:</strong> {flag.source}
                                    </div>
                                    {flag.action && (
                                      <div style={{ fontSize: '0.75rem', color: 'var(--text-primary)', marginTop: '0.3rem' }}>
                                        <strong>Action Required:</strong> {flag.action}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    ) : (
                      <div style={{ padding: '2rem', textAlign: 'center', background: 'rgba(255, 255, 255, 0.01)', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                        <AlertCircle size={36} style={{ opacity: 0.2, marginBottom: '0.75rem' }} />
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1.25rem' }}>No Playbook Analysis has been run for this case yet.</p>
                        <button className="btn-history" onClick={handleRegenerateSummary} disabled={isRegenerating}>
                          <RefreshCw size={12} className={isRegenerating ? 'spin' : ''} /> Run Playbook Analysis
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Right Column: Draft Cover Letter if available */}
                  {analysis?.coverLetterDraft && (
                    <div className="glass-card cover-letter-card" style={{ display: 'flex', flexDirection: 'column' }}>
                      <div className="section-title-small" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
                        <FileText size={18} style={{ color: 'var(--accent-primary)' }} />
                        Draft Cover Letter Review
                      </div>
                      <div className="cover-letter-letterhead" style={{
                        maxHeight: '480px', overflowY: 'auto', padding: '1.5rem',
                        background: '#ffffff', color: '#1e293b', fontFamily: '"Georgia", serif',
                        fontSize: '0.85rem', lineHeight: '1.6', borderRadius: '6px', border: '1px solid var(--border-color)',
                        boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), inset 0 2px 4px rgba(0,0,0,0.06)'
                      }}>
                        <ReactMarkdown>{analysis.coverLetterDraft}</ReactMarkdown>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* 3. Evidence Mapping Tab */}
              {activeResultTab === 'evidence' && (
                <>
                  <div className="glass-card evidence-mapping-card">
                    <div className="section-title">Evidence & Document Mapping</div>
                    {analysis ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
                        
                        {/* Core Documents */}
                        <div>
                          <h3 style={{ fontSize: '0.95rem', color: 'var(--text-primary)', marginBottom: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600 }}>
                            <CheckCircle size={16} style={{ color: 'var(--success)' }} />
                            Core Filing Checklists
                          </h3>
                          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0 0 1rem 0' }}>
                            Mandatory immigration items mapped directly to scenario guidelines.
                          </p>
                          <div style={{ overflowX: 'auto' }}>
                            <table className="evidence-table" style={{ width: '100%', minWidth: '600px', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                              <thead>
                                <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                                  <th style={{ padding: '0.5rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Requirement</th>
                                  <th style={{ padding: '0.5rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Category</th>
                                  <th style={{ padding: '0.5rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Status</th>
                                  <th style={{ padding: '0.5rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Matched Source File</th>
                                </tr>
                              </thead>
                              <tbody>
                                {analysis.documents.map((doc: any) => {
                                  const isProvided = doc.status === 'provided';
                                  const statusColor = isProvided ? 'var(--success)' : doc.status === 'needs_supplementation' ? '#F59E0B' : 'var(--danger)';
                                  const statusLabel = doc.status.toUpperCase().replace(/_/g, ' ');

                                  return (
                                    <tr key={doc.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                                      <td style={{ padding: '0.6rem 0.5rem', color: 'var(--text-primary)', fontWeight: 550 }}>{doc.label}</td>
                                      <td style={{ padding: '0.6rem 0.5rem', color: 'var(--text-secondary)', textTransform: 'capitalize' }}>{doc.category.replace(/_/g, ' ')}</td>
                                      <td style={{ padding: '0.6rem 0.5rem', color: statusColor, fontWeight: 'bold', fontSize: '0.75rem' }}>{statusLabel}</td>
                                      <td style={{ padding: '0.6rem 0.5rem', color: isProvided ? 'var(--text-primary)' : 'var(--text-secondary)', fontStyle: isProvided ? 'normal' : 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '180px' }}>
                                        {isProvided ? doc.fileName : 'Not Provided'}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>

                        {/* Bona Fide Supporting Evidence */}
                        <div>
                          <h3 style={{ fontSize: '0.95rem', color: 'var(--text-primary)', marginBottom: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600 }}>
                            <FileText size={16} style={{ color: 'var(--accent-primary)' }} />
                            Relationship Evidence & Strength Map
                          </h3>
                          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0 0 1rem 0' }}>
                            Bona fide relationship files classified and graded by weight strength.
                          </p>
                          {analysis.evidence.length === 0 ? (
                            <div style={{ padding: '1.5rem', textAlign: 'center', background: 'rgba(255, 255, 255, 0.01)', border: '1px dashed var(--border-color)', borderRadius: '8px', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                              No relationship evidence found in case files yet.
                            </div>
                          ) : (
                            <div style={{ overflowX: 'auto' }}>
                              <table className="evidence-table" style={{ width: '100%', minWidth: '600px', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                                <thead>
                                  <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                                    <th style={{ padding: '0.5rem', color: 'var(--text-secondary)', fontWeight: 600 }}>File Name</th>
                                    <th style={{ padding: '0.5rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Evidence Sub-type</th>
                                    <th style={{ padding: '0.5rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Category</th>
                                    <th style={{ padding: '0.5rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Strength</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {analysis.evidence.map((ev: any, idx: number) => {
                                    const strengthColor = ev.strength === 'high' ? 'var(--success)' : ev.strength === 'medium' ? '#F59E0B' : 'var(--danger)';
                                    
                                    return (
                                      <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                                        <td style={{ padding: '0.6rem 0.5rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '180px' }}>{ev.fileName}</td>
                                        <td style={{ padding: '0.6rem 0.5rem', color: 'var(--text-secondary)', textTransform: 'capitalize' }}>
                                          {ev.type.replace(/_/g, ' ')}
                                        </td>
                                        <td style={{ padding: '0.6rem 0.5rem', color: 'var(--text-secondary)', textTransform: 'capitalize' }}>
                                          {ev.category.replace(/_/g, ' ')}
                                        </td>
                                        <td style={{ padding: '0.6rem 0.5rem' }}>
                                          <span style={{
                                            color: strengthColor,
                                            background: `${strengthColor}15`,
                                            border: `1px solid ${strengthColor}25`,
                                            padding: '0.1rem 0.3rem',
                                            borderRadius: '4px',
                                            fontSize: '0.7rem',
                                            fontWeight: 'bold',
                                            textTransform: 'uppercase'
                                          }}>
                                            {ev.strength}
                                          </span>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>

                      </div>
                    ) : (
                      <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem', fontSize: '0.85rem' }}>No Playbook Analysis. Run analysis to display evidence mapping.</p>
                    )}
                  </div>

                  {/* Right Column: Linked Materials */}
                  <div className="glass-card linked-materials-sidebar">
                    {renderLinkedMaterials()}
                  </div>
                </>
              )}

              {/* 4. Audio Transcript Tab */}
              {activeResultTab === 'transcript' && (
                <>
                  <div className="glass-card transcript-left-card" style={{ gridColumn: record?.items?.some((i: any) => i.type === 'audio') || transcript.utterances ? 'auto' : '1 / -1' }}>
                    <div className="section-title">
                      Consultation Audio Transcript
                    </div>

                    {audioUrl && (
                      <div className="audio-player-container" style={{ margin: '1rem 0', background: 'rgba(255,255,255,0.02)', padding: '1rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                        <audio 
                          ref={audioRef} 
                          controls 
                          src={audioUrl} 
                          style={{ width: '100%' }}
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
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.5rem', textAlign: 'center' }}>
                          Click any word to jump to that timestamp in the recording
                        </p>
                      </div>
                    )}

                    <div className="transcript-card" style={{ maxHeight: '420px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '1rem', background: 'rgba(0,0,0,0.1)' }}>
                      {record?.items?.filter((i: any) => i.type === 'audio').length > 0 || transcript.utterances ? (
                        transcript.utterances ? (
                          (() => {
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
                                      <div className="utterance" key={i} style={{ marginBottom: '1.25rem' }}>
                                        <div className={`speaker-tag speaker-${utt.speaker}`} style={{
                                          fontSize: '0.75rem',
                                          fontWeight: 'bold',
                                          color: utt.speaker === '1' ? 'var(--accent-primary)' : 'var(--accent-secondary)',
                                          marginBottom: '0.25rem',
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: '0.5rem'
                                        }}>
                                          Speaker {utt.speaker} <span className="timestamp" style={{ fontWeight: 'normal', color: 'var(--text-secondary)' }}>{formatTime(utt.start)}</span>
                                        </div>
                                        <p style={{ margin: 0, fontSize: '0.85rem', lineHeight: '1.5' }}>
                                          {utt.words.map((word: any, wordIndex: number) => (
                                            <span
                                              key={wordIndex}
                                              className={`transcript-word ${isActiveWord(utt, word) ? 'active' : ''}`}
                                              onClick={() => handleWordClick(utt, word.start)}
                                              style={{
                                                cursor: 'pointer',
                                                borderRadius: '2px',
                                                padding: '0 2px',
                                                background: isActiveWord(utt, word) ? 'rgba(59, 130, 246, 0.3)' : 'transparent',
                                                color: isActiveWord(utt, word) ? 'var(--text-primary)' : 'inherit',
                                                transition: 'background 0.1s'
                                              }}
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
                        <div className="no-transcript-placeholder" style={{ textAlign: 'center', padding: '2rem' }}>
                          <FileText size={48} style={{ opacity: 0.1, marginBottom: '1rem' }} />
                          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>This matter collection focuses on document/image analysis.</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Right Column: Linked Materials */}
                  {record?.items && record.items.length > 0 && (
                    <div className="glass-card linked-materials-sidebar">
                      {renderLinkedMaterials()}
                    </div>
                  )}
                </>
              )}

              {activeResultTab === 'assembly' && (
                <>
                  {/* Left Column: Sheet Document Preview */}
                  <div className="glass-card assembly-preview-card" style={{ display: 'flex', flexDirection: 'column', minHeight: '520px' }}>
                    {(() => {
                      const record = records.find(r => r.id === selectedRecordId);
                      const analysis = record?.analysis;

                      if (!analysis) {
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, padding: '3rem', color: 'var(--text-secondary)' }}>
                            <AlertCircle size={48} style={{ opacity: 0.2, marginBottom: '1rem' }} />
                            <p style={{ fontSize: '0.9rem', marginBottom: '1rem' }}>No Playbook Analysis has been run for this case yet.</p>
                            <button className="btn-history" onClick={handleRegenerateSummary} disabled={isRegenerating}>
                              <RefreshCw size={12} className={isRegenerating ? 'spin' : ''} /> Run Playbook Analysis
                            </button>
                          </div>
                        );
                      }

                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                          {/* Toolbar */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem', marginBottom: '1.25rem' }}>
                            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                              Format: <strong style={{ color: 'var(--text-primary)' }}>Georgia / Legal Letterhead</strong>
                            </span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                              <button 
                                onClick={handleAssemblePackage}
                                disabled={isAssembling}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.4rem',
                                  padding: '0.4rem 0.75rem',
                                  background: 'var(--accent-primary)',
                                  border: 'none',
                                  borderRadius: '6px',
                                  color: 'white',
                                  fontSize: '0.75rem',
                                  fontWeight: 'bold',
                                  cursor: 'pointer',
                                  boxShadow: '0 2px 8px rgba(59, 130, 246, 0.3)',
                                  opacity: isAssembling ? 0.7 : 1
                                }}
                              >
                                {isAssembling ? (
                                  <>
                                    <RefreshCw size={12} className="spin" /> Assembling...
                                  </>
                                ) : (
                                  <>
                                    <Download size={12} /> Download ZIP
                                  </>
                                )}
                              </button>
                              <button 
                                onClick={() => {
                                  const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
                                  window.open(`${baseUrl}/api/intake/package/${selectedRecordId}/pdf`, '_blank');
                                }}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.4rem',
                                  padding: '0.4rem 0.75rem',
                                  background: '#16a34a',
                                  border: 'none',
                                  borderRadius: '6px',
                                  color: 'white',
                                  fontSize: '0.75rem',
                                  fontWeight: 'bold',
                                  cursor: 'pointer',
                                  boxShadow: '0 2px 8px rgba(22, 163, 74, 0.3)'
                                }}
                              >
                                <Download size={12} /> All-in-One PDF
                              </button>
                            </div>
                          </div>

                          {/* Mobile Document Selector */}
                          <div className="assembly-mobile-selector">
                            <div className="assembly-index-list">
                              {[
                                { id: 'cover-sheet', label: '1. Cover Sheet', icon: <FileText size={14} /> },
                                { id: 'cover-letter', label: '2. Cover Letter', icon: <FileText size={14} /> },
                                { id: 'form-mapping', label: '3. Forms Map', icon: <FileText size={14} /> },
                                { id: 'exhibit-index', label: '4. Table of Contents', icon: <FileText size={14} /> },
                                { id: 'checklist', label: '5. Sign-off', icon: <CheckCircle size={14} /> },
                              ].map((doc) => {
                                const isSelected = selectedAssemblyDocId === doc.id;
                                return (
                                  <button
                                    key={doc.id}
                                    onClick={() => setSelectedAssemblyDocId(doc.id)}
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '0.4rem',
                                      padding: '0.5rem 0.8rem',
                                      background: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'rgba(255, 255, 255, 0.02)',
                                      border: `1px solid ${isSelected ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                                      color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                                      borderRadius: '8px',
                                      cursor: 'pointer',
                                      fontSize: '0.75rem',
                                      fontWeight: isSelected ? 600 : 500,
                                      transition: 'all 0.2s',
                                      whiteSpace: 'nowrap'
                                    }}
                                  >
                                    {doc.icon}
                                    {doc.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          {/* Paper Sheet Document Preview */}
                          <div className="assembly-paper-sheet">
                            {/* Page 1: Filing Cover Sheet */}
                            {selectedAssemblyDocId === 'cover-sheet' && (() => {
                              const docs = analysis?.documents || [];
                              const missingDocs = docs.filter((d: any) => d && (d.status === 'missing' || d.status === 'needs_supplementation'));
                              const isComplete = missingDocs.length === 0;

                              const hasCoverLetter = !!analysis?.coverLetterDraft && analysis.coverLetterDraft.trim().length > 0;
                              const hasFormMapping = !!analysis?.uscisFormMapping && typeof analysis.uscisFormMapping === 'object' && Object.keys(analysis.uscisFormMapping).length > 0;

                              const civilDocs = docs.filter((d: any) => d && d.category && ['identity', 'marriage', 'entry_status', 'medical', 'civil_documents_consular'].includes(d.category));
                              const missingCivilDocs = civilDocs.filter((d: any) => d && (d.status === 'missing' || d.status === 'needs_supplementation'));
                              const isCivilComplete = missingCivilDocs.length === 0;

                              const finDocs = docs.filter((d: any) => d && d.category === 'financial_support');
                              const missingFinDocs = finDocs.filter((d: any) => d && (d.status === 'missing' || d.status === 'needs_supplementation'));
                              const isFinComplete = missingFinDocs.length === 0;

                              const getDisplayName = (val: any, fallback: string): string => {
                                if (!val) return fallback;
                                if (typeof val === 'string') return val;
                                if (typeof val === 'object') {
                                  return val.full_name || val.name || JSON.stringify(val);
                                }
                                return String(val);
                              };

                              return (
                                <div>
                                  <div style={{ textAlign: 'center', borderBottom: '3px double #1e293b', paddingBottom: '1.5rem', marginBottom: '2rem' }}>
                                    <h2 style={{ margin: 0, fontSize: '1.5rem', letterSpacing: '0.05em', color: '#0f172a' }}>USCIS IMMIGRATION FILING PACKAGE</h2>
                                    <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: '#64748b', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
                                      PREPARED FOR ATTORNEY REVIEW & SIGN-OFF
                                    </div>
                                  </div>

                                  <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: '0.75rem 1rem', marginBottom: '2rem', fontSize: '0.85rem' }}>
                                    <div style={{ fontWeight: 'bold', color: '#475569' }}>CASE TYPE:</div>
                                    <div>{analysis?.playbookName || (record?.caseType === 'eb1a' ? 'EB-1A Extraordinary Ability' : 'Marriage-Based Permanent Residence')} {analysis?.scenarioLabel ? `(${analysis.scenarioLabel})` : ''}</div>
                                    
                                    {analysis?.facts?.petitioner_identity?.value && record?.caseType !== 'eb1a' && (
                                      <>
                                        <div style={{ fontWeight: 'bold', color: '#475569' }}>PETITIONER:</div>
                                        <div>{getDisplayName(analysis?.facts?.petitioner_identity?.value, 'Unknown')} {analysis?.facts?.petitioner_status?.value ? `(${analysis.facts.petitioner_status.value})` : ''}</div>
                                      </>
                                    )}
                                    
                                    <div style={{ fontWeight: 'bold', color: '#475569' }}>BENEFICIARY:</div>
                                    <div>{getDisplayName(analysis?.facts?.beneficiary_identity?.value, 'Unknown')}</div>

                                    <div style={{ fontWeight: 'bold', color: '#475569' }}>FORMS INCLUDED:</div>
                                    <div>{analysis?.uscisFormMapping && typeof analysis.uscisFormMapping === 'object' && !Array.isArray(analysis.uscisFormMapping) ? Object.keys(analysis.uscisFormMapping).join(', ') : 'N/A'}</div>

                                    <div style={{ fontWeight: 'bold', color: '#475569' }}>PREPARED BY:</div>
                                    <div>MeritX Legal Petition Assembly Engine</div>

                                    <div style={{ fontWeight: 'bold', color: '#475569' }}>STATUS:</div>
                                    <div>
                                      {isComplete ? (
                                        <span style={{ display: 'inline-block', padding: '0.15rem 0.4rem', borderRadius: '4px', background: 'rgba(34, 197, 94, 0.1)', color: '#16a34a', fontSize: '0.75rem', fontWeight: 600 }}>
                                          READY FOR ASSEMBLY (COMPLETE)
                                        </span>
                                      ) : (
                                        <span style={{ display: 'inline-block', padding: '0.15rem 0.4rem', borderRadius: '4px', background: 'rgba(239, 68, 68, 0.1)', color: '#dc2626', fontSize: '0.75rem', fontWeight: 600 }}>
                                          INCOMPLETE ({missingDocs.length} MISSING MATERIAL{missingDocs.length > 1 ? 'S' : ''})
                                        </span>
                                      )}
                                    </div>
                                  </div>

                                  <h3 style={{ borderBottom: '1px solid #cbd5e1', paddingBottom: '0.4rem', fontSize: '1.05rem', color: '#0f172a', marginTop: '2rem' }}>Package Checklist Summary</h3>
                                  <ul style={{ paddingLeft: '1.25rem', margin: '0.75rem 0 0 0', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                    <li><strong>Filing Cover Letter:</strong> {hasCoverLetter ? 'Drafted and matching case facts (✓)' : <span style={{ color: '#dc2626' }}>Pending draft generation (⚠️)</span>}</li>
                                    <li><strong>USCIS Forms Mapping:</strong> {hasFormMapping ? 'Mapped and ready for field entry (✓)' : <span style={{ color: '#dc2626' }}>Pending USCIS mapping (⚠️)</span>}</li>
                                    <li><strong>Primary Civil Documents:</strong> {isCivilComplete ? (
                                      'All required primary civil documents uploaded & verified (✓)'
                                    ) : (
                                      <span style={{ color: '#dc2626' }}>
                                        Missing: {missingCivilDocs.map((d: any) => d.label).join(', ')} (⚠️)
                                      </span>
                                    )}</li>
                                    <li><strong>Financial Sponsorship:</strong> {isFinComplete ? (
                                      'Petitioner W-2 paystubs and tax returns matched (✓)'
                                    ) : (
                                      <span style={{ color: '#dc2626' }}>
                                        Missing: {missingFinDocs.map((d: any) => d.label).join(', ')} (⚠️)
                                      </span>
                                    )}</li>
                                    <li><strong>Escalation Risk Check:</strong> Checked against playbook criteria ({analysis?.riskFlags?.length || 0} active flag(s) {analysis?.riskFlags?.length > 0 ? '⚠️' : '✓'})</li>
                                  </ul>
                                </div>
                              );
                            })()}

                            {/* Page 2: Attorney Cover Letter */}
                            {selectedAssemblyDocId === 'cover-letter' && (
                              <div className="legal-markdown-preview">
                                {analysis.coverLetterDraft ? (
                                  <ReactMarkdown>{analysis.coverLetterDraft}</ReactMarkdown>
                                ) : (
                                  'No cover letter draft generated.'
                                )}
                              </div>
                            )}

                            {/* Page 3: USCIS Form Mapping */}
                            {selectedAssemblyDocId === 'form-mapping' && (
                              <div>
                                <h3 style={{ margin: '0 0 1.5rem 0', fontSize: '1.2rem', borderBottom: '2px solid #1e293b', paddingBottom: '0.5rem' }}>USCIS Form Field Mappings</h3>
                                
                                {Object.keys(analysis.uscisFormMapping || {}).length > 0 ? (
                                  Object.keys(analysis.uscisFormMapping || {}).map((formName) => {
                                    const fields = (analysis.uscisFormMapping || {})[formName] || {};
                                    return (
                                      <div key={formName} style={{ marginBottom: '2rem' }}>
                                        <h4 style={{ color: '#0f172a', borderBottom: '1px solid #cbd5e1', paddingBottom: '0.25rem', marginBottom: '0.75rem', fontSize: '1rem', fontWeight: 'bold' }}>
                                          Form {formName} Field Data
                                        </h4>
                                        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                                          <table style={{ width: '100%', minWidth: '500px', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                                            <thead>
                                              <tr style={{ borderBottom: '1px solid #94a3b8', textAlign: 'left' }}>
                                                <th style={{ padding: '0.4rem', fontWeight: 'bold' }}>Field Name</th>
                                                <th style={{ padding: '0.4rem', fontWeight: 'bold' }}>Mapped Value</th>
                                                <th style={{ padding: '0.4rem', fontWeight: 'bold' }}>Source Record</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {Object.keys(fields).map((fieldName) => {
                                                const matchingFactKey = Object.keys(analysis?.facts || {}).find(k => k === fieldName || fieldName.includes(k));
                                                const sourceText = matchingFactKey ? (analysis?.facts || {})[matchingFactKey]?.source : 'Extracted from intake';
                                                return (
                                                  <tr key={fieldName} style={{ borderBottom: '1px solid #e2e8f0' }}>
                                                    <td style={{ padding: '0.4rem', fontWeight: 600, color: '#334155' }}>
                                                      {fieldName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                                                    </td>
                                                    <td style={{ padding: '0.4rem', color: '#0f172a' }}>
                                                      {typeof fields[fieldName] === 'object' && fields[fieldName] !== null 
                                                        ? JSON.stringify(fields[fieldName]) 
                                                        : String(fields[fieldName] || '')}
                                                    </td>
                                                    <td style={{ padding: '0.4rem', color: '#64748b', fontStyle: 'italic', fontSize: '0.75rem' }}>{sourceText}</td>
                                                  </tr>
                                                );
                                              })}
                                            </tbody>
                                          </table>
                                        </div>
                                      </div>
                                    );
                                  })
                                ) : (
                                  <p style={{ color: '#64748b', fontSize: '0.85rem' }}>No Form Mappings found in the analysis payload.</p>
                                )}
                              </div>
                            )}

                            {/* Page 4: Table of Contents */}
                            {selectedAssemblyDocId === 'exhibit-index' && (() => {
                              const caseTypeLabel = analysis?.playbookName || (record?.caseType === 'eb1a' ? 'EB-1A, Alien of Extraordinary Ability - INA 203(b)(1)(A)' : 'Marriage-Based Permanent Residence');
                              const petitionerName = analysis?.facts?.petitioner_identity?.value || 'Unknown Petitioner';
                              const beneficiaryName = analysis?.facts?.beneficiary_identity?.value || 'Unknown Beneficiary';
                              const formNames = Object.keys(analysis?.uscisFormMapping || {}).filter(f => !f.includes('_by_location'));
                              let itemIndex = 1;

                              return (
                              <div style={{ padding: '2rem 1rem', maxWidth: '800px', margin: '0 auto', fontFamily: '"Times New Roman", Times, serif' }}>
                                <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
                                  <h3 style={{ margin: '0 0 1rem 0', fontSize: '1.2rem', fontWeight: 'bold' }}>
                                    Petitioner/Beneficiary: {petitionerName} {petitionerName !== beneficiaryName ? `/ ${beneficiaryName}` : ''}
                                  </h3>
                                  <p style={{ fontSize: '1.1rem', margin: '0 0 3rem 0' }}>
                                    Petition: {caseTypeLabel}
                                  </p>
                                  <h2 style={{ fontSize: '1.3rem', fontWeight: 'bold', letterSpacing: '0.05em' }}>
                                    TABLE OF CONTENTS
                                  </h2>
                                </div>
                                
                                <div style={{ fontSize: '1.1rem', lineHeight: '1.8' }}>
                                  {formNames.map((form) => (
                                    <div key={form} style={{ display: 'flex', marginBottom: '0.5rem' }}>
                                      <span style={{ width: '30px' }}>{itemIndex++}.</span>
                                      <span>Form {form}</span>
                                    </div>
                                  ))}
                                  
                                  {analysis?.coverLetterDraft && (
                                    <div style={{ display: 'flex', marginBottom: '0.5rem' }}>
                                      <span style={{ width: '30px' }}>{itemIndex++}.</span>
                                      <span>Cover Letter in support of Petition</span>
                                    </div>
                                  )}

                                  <div style={{ display: 'flex', marginBottom: '0.5rem' }}>
                                    <span style={{ width: '30px' }}>{itemIndex++}.</span>
                                    <span>List of Exhibits</span>
                                  </div>

                                  <div style={{ display: 'flex', marginBottom: '0.5rem' }}>
                                    <span style={{ width: '30px' }}>{itemIndex++}.</span>
                                    <span>Exhibits 1-{record?.items?.length || 0}</span>
                                  </div>

                                  <div style={{ paddingLeft: '40px', marginTop: '1rem', fontSize: '1rem' }}>
                                    {(record?.items || []).map((item: any, i: number) => (
                                      <div key={i} style={{ marginBottom: '0.4rem', color: '#334155' }}>
                                        Exhibit {i + 1}: {item.name}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                              );
                            })()}


                            {/* Page 5: Attorney Review Checklist */}
                            {selectedAssemblyDocId === 'checklist' && (
                              <div>
                                <h3 style={{ margin: '0 0 1.5rem 0', fontSize: '1.2rem', borderBottom: '2px solid #1e293b', paddingBottom: '0.5rem' }}>Attorney Review & Sign-Off</h3>
                                
                                <p style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: '1.5rem', lineHeight: '1.4' }}>
                                  Review the extracted facts and draft documents. Check all items below to authorize and assemble the final filing package.
                                </p>

                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '2.5rem' }}>
                                  {[
                                    'Verify that petitioner and beneficiary legal names match biological passport pages.',
                                    'Review and reconcile any date gaps or address conflicts in address history timeline.',
                                    'Confirm that petitioner income meets or exceeds the required 125% Federal Poverty Line for sponsorship.',
                                    'Approve draft Cover Letter and Exhibit List mappings.',
                                    'Authorize MeritX to compile all verified exhibit files and drafts into a single ZIP archive.'
                                  ].map((checkText, idx) => {
                                    const isChecked = assemblyCheckedItems.includes(String(idx));
                                    return (
                                      <label key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', cursor: 'pointer', userSelect: 'none', fontSize: '0.85rem' }}>
                                        <input
                                          type="checkbox"
                                          checked={isChecked}
                                          onChange={() => {
                                            if (isChecked) {
                                              setAssemblyCheckedItems(prev => prev.filter(i => i !== String(idx)));
                                            } else {
                                              setAssemblyCheckedItems(prev => [...prev, String(idx)]);
                                            }
                                          }}
                                          style={{ marginTop: '4px', cursor: 'pointer' }}
                                        />
                                        <span style={{ color: isChecked ? '#0f172a' : '#475569', fontWeight: isChecked ? 550 : 400 }}>{checkText}</span>
                                      </label>
                                    );
                                  })}
                                </div>

                                <div style={{ textAlign: 'center' }}>
                                  <button
                                    onClick={handleAssemblePackage}
                                    disabled={assemblyCheckedItems.length < 5 || isAssembling}
                                    style={{
                                      padding: '0.75rem 2rem',
                                      background: assemblyCheckedItems.length === 5 ? 'var(--accent-primary)' : 'rgba(255,255,255,0.05)',
                                      color: assemblyCheckedItems.length === 5 ? 'white' : 'var(--text-secondary)',
                                      border: assemblyCheckedItems.length === 5 ? 'none' : '1px solid var(--border-color)',
                                      borderRadius: '8px',
                                      fontSize: '0.9rem',
                                      fontWeight: 'bold',
                                      cursor: assemblyCheckedItems.length === 5 ? 'pointer' : 'not-allowed',
                                      transition: 'all 0.2s',
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '0.5rem',
                                      boxShadow: assemblyCheckedItems.length === 5 ? '0 4px 15px rgba(59, 130, 246, 0.4)' : 'none'
                                    }}
                                  >
                                    {isAssembling ? (
                                      <>
                                        <RefreshCw size={16} className="spin" /> Assembling Package...
                                      </>
                                    ) : (
                                      <>
                                        <CheckCircle size={16} /> Approve & Assemble Package
                                      </>
                                    )}
                                  </button>
                                </div>
                              </div>
                            )}

                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Right Column: Index of Documents */}
                  <div className="glass-card assembly-index-card">
                    <div className="section-title-small" style={{ marginBottom: '1.25rem' }}>Index of Documents</div>
                    <div className="assembly-index-list">
                      {[
                        { id: 'cover-sheet', label: '1. Filing Cover Sheet', icon: <FileText size={16} /> },
                        { id: 'cover-letter', label: '2. Attorney Cover Letter', icon: <FileText size={16} /> },
                        { id: 'form-mapping', label: '3. USCIS Form Mapping', icon: <FileText size={16} /> },
                        { id: 'exhibit-index', label: '4. Exhibit Index', icon: <FileText size={16} /> },
                        { id: 'checklist', label: '5. Attorney Sign-off & Export', icon: <CheckCircle size={16} /> },
                      ].map((doc) => {
                        const isSelected = selectedAssemblyDocId === doc.id;
                        return (
                          <button
                            key={doc.id}
                            onClick={() => setSelectedAssemblyDocId(doc.id)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.6rem',
                              padding: '0.75rem 1rem',
                              background: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'rgba(255, 255, 255, 0.02)',
                              border: `1px solid ${isSelected ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                              color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                              borderRadius: '8px',
                              cursor: 'pointer',
                              textAlign: 'left',
                              fontSize: '0.85rem',
                              fontWeight: isSelected ? 600 : 500,
                              transition: 'all 0.2s'
                            }}
                          >
                            {doc.icon}
                            {doc.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          );
        })()
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
                {analyzingStatus}
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
        isRefining && (
          <div className="loading-overlay">
            <div className="glass-card loading-card" style={{ maxWidth: '480px', width: '90%', padding: '3rem 2rem', textAlign: 'center', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3)' }}>
              <div className="spinner" style={{ width: '48px', height: '48px', borderWidth: '5px' }}></div>
              <h3 style={{ fontSize: '1.5rem', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '0.75rem' }}>Refining Selection</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginTop: '0.5rem', lineHeight: '1.5' }}>
                Applying your instructions to update the selected text...
              </p>
            </div>
          </div>
        )
      }

      {
        isAssembling && (
          <div className="loading-overlay" style={{ zIndex: 2000 }}>
            <div className="glass-card loading-card" style={{ maxWidth: '480px', width: '90%', padding: '3rem 2rem', textAlign: 'center', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3)' }}>
              <div className="spinner" style={{ width: '48px', height: '48px', borderWidth: '5px' }}></div>
              <h3 style={{ fontSize: '1.5rem', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '0.75rem' }}>Assembling Package</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginTop: '0.5rem', lineHeight: '1.5' }}>
                Compiling Cover Letter, Form Mappings, Exhibit Index, and downloading matched PDF/image attachments into a ZIP bundle...
              </p>
            </div>
          </div>
        )
      }

      {
        showAssemblySuccessModal && (
          <div className="loading-overlay" style={{ zIndex: 2000 }}>
            <div className="glass-card loading-card" style={{ maxWidth: '540px', width: '95%', padding: '2.5rem 2rem', textAlign: 'center', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)' }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(34, 197, 94, 0.1)', color: '#22c55e' }}>
                  <CheckCircle size={36} />
                </div>
              </div>
              <h3 style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--text-primary)', marginBottom: '0.75rem' }}>
                Petition Package Assembled!
              </h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1.75rem', lineHeight: '1.5' }}>
                MeritX has successfully compiled the Filing Cover Letter, official Form Mappings, and all matching evidentiary exhibits into a single, structured zip archive.
              </p>
              
              {(() => {
                const record = records.find(r => r.id === selectedRecordId);
                const documentCount = record?.analysis?.documents?.filter((d: any) => d.status === 'provided').length || 0;
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.75rem', textAlign: 'left', background: 'rgba(0,0,0,0.15)', padding: '1rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.8rem', fontWeight: 'bold', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.4rem', marginBottom: '0.4rem' }}>
                      ARCHIVE CONTENTS:
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      📄 <strong>01_Cover_Letter.pdf</strong> - Drafted Attorney Letter
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      📑 <strong>02_Exhibit_Index.pdf</strong> - Mapped Exhibit List
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      📝 <strong>03_Form_Field_Mappings.pdf</strong> - USCIS Mapped Fields
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      📁 <strong>exhibits/</strong> - folder containing {documentCount} matched files
                    </div>
                  </div>
                );
              })()}

              <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
                <button
                  className="btn-history"
                  onClick={() => setShowAssemblySuccessModal(false)}
                  style={{ padding: '0.6rem 1.5rem', fontSize: '0.85rem' }}
                >
                  Close
                </button>
              </div>
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

      {selectionRect && selectedText && !isEditing && (
        <div 
          className="glass-card"
          style={{
            position: 'fixed',
            top: window.innerWidth < 768 ? 'auto' : selectionRect.top,
            bottom: window.innerWidth < 768 ? '80px' : 'auto',
            left: window.innerWidth < 768 ? '50%' : selectionRect.left,
            transform: window.innerWidth < 768 ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
            zIndex: 1000,
            padding: '0.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.3)',
            minWidth: showRefineInput ? '300px' : 'auto',
            border: '1px solid var(--border-color)',
          }}
        >
          {!showRefineInput ? (
            <button 
              onClick={(e) => { e.stopPropagation(); setShowRefineInput(true); }}
              style={{
                background: 'linear-gradient(135deg, #8b5cf6, #d946ef)', 
                border: 'none', borderRadius: '20px',
                padding: '0.6rem 1.2rem', color: 'white', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.9rem',
                fontWeight: 600,
                boxShadow: '0 4px 15px rgba(139, 92, 246, 0.4)'
              }}
            >
              <Wand2 size={14} /> Refine Selection
            </button>
          ) : (
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }} onClick={e => e.stopPropagation()}>
              <input 
                autoFocus
                type="text"
                value={refinePrompt}
                onChange={(e) => setRefinePrompt(e.target.value)}
                placeholder="e.g. Make this more formal..."
                onKeyDown={(e) => { if (e.key === 'Enter') handleInlineRefine(); }}
                style={{
                  flex: 1, padding: '0.5rem', borderRadius: '6px',
                  border: '1px solid var(--border-color)', background: 'var(--card-bg)',
                  color: 'var(--text-primary)', outline: 'none', fontSize: '0.85rem'
                }}
              />
              <button 
                onClick={handleInlineRefine}
                style={{
                  background: 'var(--primary)', border: 'none', borderRadius: '6px',
                  padding: '0.5rem', color: 'white', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}
              >
                <Send size={14} />
              </button>
              <button 
                onClick={() => { setShowRefineInput(false); setSelectionRect(null); }}
                style={{
                  background: 'none', border: '1px solid var(--border-color)', borderRadius: '6px',
                  padding: '0.5rem', color: 'var(--text-secondary)', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}
              >
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      )}
    </div >
  );
}

export default App;
