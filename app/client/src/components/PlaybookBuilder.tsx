import { useState, useEffect } from 'react';
import { Save, AlertTriangle, Settings, ShieldCheck, AlertCircle, FileText, Code, Wand2, Loader2, Send, X, Trash2, Plus, Maximize2, Minimize2, HelpCircle, Info, Download, Upload, Play } from 'lucide-react';

interface PlaybookBuilderProps {
  onBack?: () => void;
}

function JsonIDEEditor({ 
  value, 
  onChange,
  isFullscreen = false,
  onToggleFullscreen
}: { 
  value: string; 
  onChange: (val: string) => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}) {
  const [foldedLines, setFoldedLines] = useState<Set<number>>(new Set());
  const [isEditing, setIsEditing] = useState(false);
  const [rawText, setRawText] = useState(value);
  const [isValid, setIsValid] = useState(true);

  useEffect(() => {
    try {
      const parsed = JSON.parse(value);
      const formatted = JSON.stringify(parsed, null, 2);
      setRawText(formatted);
    } catch {
      setRawText(value);
    }
  }, [value]);

  // Format / Beautify JSON
  const handleBeautify = () => {
    try {
      const parsed = JSON.parse(rawText);
      const formatted = JSON.stringify(parsed, null, 2);
      setRawText(formatted);
      onChange(formatted);
      setIsValid(true);
    } catch (err) {
      setIsValid(false);
    }
  };

  // Compute fold ranges for braces
  const lines = rawText.split('\n');
  const foldMap: Record<number, number> = {};
  const stack: { line: number }[] = [];

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    const opens = (trimmed.endsWith('{') || trimmed.endsWith('[') || trimmed.endsWith(':{') || trimmed.endsWith('=[')) && !trimmed.endsWith('}') && !trimmed.endsWith(']');
    const closes = trimmed.startsWith('}') || trimmed.startsWith(']') || trimmed.startsWith('},') || trimmed.startsWith('],');

    if (opens) {
      stack.push({ line: idx });
    } else if (closes && stack.length > 0) {
      const top = stack.pop();
      if (top) {
        foldMap[top.line] = idx;
      }
    }
  });

  const toggleFold = (lineIdx: number) => {
    const next = new Set(foldedLines);
    if (next.has(lineIdx)) {
      next.delete(lineIdx);
    } else {
      next.add(lineIdx);
    }
    setFoldedLines(next);
  };

  const hiddenLines = new Set<number>();
  foldedLines.forEach(startLine => {
    const endLine = foldMap[startLine];
    if (endLine !== undefined) {
      for (let i = startLine + 1; i <= endLine; i++) {
        hiddenLines.add(i);
      }
    }
  });

  const editorContent = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#090d16', borderRadius: isFullscreen ? '0' : '10px', border: isFullscreen ? 'none' : `1px solid ${isValid ? 'var(--border-color)' : '#A23C3C'}`, overflow: 'hidden' }}>
      {/* Editor Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1.25rem', background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--border-color)' }}>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button
            onClick={() => setIsEditing(!isEditing)}
            style={{ padding: '0.4rem 0.85rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: isEditing ? '#C9A227' : 'rgba(255,255,255,0.05)', color: 'white', fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
          >
            {isEditing ? '👁 View Folded IDE' : '✏️ Raw Edit Mode'}
          </button>
          
          <button
            onClick={handleBeautify}
            style={{ padding: '0.4rem 0.85rem', borderRadius: '6px', border: '1px solid rgba(126, 154, 109, 0.3)', background: 'rgba(126, 154, 109, 0.15)', color: '#9DBB8A', fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
            title="Auto-indent and format JSON code"
          >
            ✨ Format / Beautify JSON
          </button>
        </div>

        {onToggleFullscreen && (
          <button
            onClick={onToggleFullscreen}
            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.45rem 0.9rem', background: isFullscreen ? '#C9A227' : 'rgba(255, 255, 255, 0.05)', color: isFullscreen ? 'white' : 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '0.82rem' }}
          >
            {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen Editor'}
          </button>
        )}
      </div>

      {!isValid && (
        <div style={{ background: 'rgba(162,60,60,0.15)', color: '#D9A3A3', padding: '0.5rem 1rem', fontSize: '0.82rem', borderBottom: '1px solid #A23C3C', fontFamily: 'monospace' }}>
          ⚠️ Invalid JSON Syntax. Format or fix line errors before saving.
        </div>
      )}

      {/* Code Editor Body */}
      {isEditing ? (
        <textarea
          value={rawText}
          onChange={(e) => {
            const val = e.target.value;
            setRawText(val);
            onChange(val);
            try {
              JSON.parse(val);
              setIsValid(true);
            } catch (err) {
              setIsValid(false);
            }
          }}
          spellCheck={false}
          style={{
            flexGrow: 1,
            width: '100%',
            padding: '1.25rem',
            background: '#12151C',
            color: '#e2e8f0',
            fontFamily: 'Consolas, Monaco, monospace',
            fontSize: isFullscreen ? '15px' : '13.5px',
            border: 'none',
            outline: 'none',
            lineHeight: 1.6,
            whiteSpace: 'pre',
            resize: 'none'
          }}
        />
      ) : (
        <div style={{ flexGrow: 1, overflowY: 'auto', padding: '1rem 0', fontFamily: 'Consolas, Monaco, monospace', fontSize: isFullscreen ? '15px' : '13.5px', lineHeight: 1.6 }}>
          {lines.map((lineText, idx) => {
            if (hiddenLines.has(idx)) return null;

            const isFoldable = foldMap[idx] !== undefined;
            const isFolded = foldedLines.has(idx);

            let lineElement = <span style={{ color: '#cbd5e1' }}>{lineText}</span>;
            const keyMatch = lineText.match(/^(\s*)("[\w_]+")(\s*:\s*)(.*)$/);

            if (keyMatch) {
              const [, indent, keyStr, colon, valStr] = keyMatch;
              let valStyled = <span style={{ color: '#e2e8f0' }}>{valStr}</span>;

              if (valStr.startsWith('"')) valStyled = <span style={{ color: '#7E9A6D' }}>{valStr}</span>;
              else if (valStr === 'true' || valStr === 'false' || !isNaN(Number(valStr.replace(',', '')))) valStyled = <span style={{ color: '#D9B84A' }}>{valStr}</span>;

              lineElement = (
                <span>
                  {indent}
                  <span style={{ color: '#D9B84A', fontWeight: 600 }}>{keyStr}</span>
                  <span style={{ color: '#94a3b8' }}>{colon}</span>
                  {valStyled}
                </span>
              );
            }

            return (
              <div 
                key={idx} 
                style={{ display: 'flex', alignItems: 'center', padding: '0 1.25rem', background: isFolded ? 'rgba(201, 162, 39, 0.08)' : 'transparent' }}
              >
                <span style={{ width: '40px', flexShrink: 0, color: '#475569', fontSize: '0.8rem', userSelect: 'none', textAlign: 'right', paddingRight: '0.85rem' }}>
                  {idx + 1}
                </span>

                <span 
                  onClick={() => isFoldable && toggleFold(idx)}
                  style={{ width: '18px', flexShrink: 0, color: '#94a3b8', fontSize: '0.8rem', cursor: isFoldable ? 'pointer' : 'default', userSelect: 'none' }}
                >
                  {isFoldable ? (isFolded ? '▶' : '▼') : ''}
                </span>

                <div style={{ whiteSpace: 'pre', flexGrow: 1 }}>
                  {lineElement}
                  {isFolded && (
                    <span 
                      onClick={() => toggleFold(idx)}
                      style={{ background: 'rgba(201, 162, 39, 0.25)', color: '#E8D48A', padding: '0.1rem 0.4rem', borderRadius: '4px', fontSize: '0.75rem', marginLeft: '0.5rem', cursor: 'pointer', border: '1px solid rgba(201, 162, 39, 0.4)' }}
                    >
                      {foldMap[idx] - idx} lines folded {"{...}"}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  if (isFullscreen) {
    return (
      <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 999999, background: '#070a12', display: 'flex', flexDirection: 'column', padding: '1rem 1.5rem', boxSizing: 'border-box' }}>
        {editorContent}
      </div>
    );
  }

  return editorContent;
}

export default function PlaybookBuilder({ onBack }: PlaybookBuilderProps) {
  const [playbooks, setPlaybooks] = useState<{id: string, name: string, description: string}[]>([]);
  const [selectedPlaybook, setSelectedPlaybook] = useState<string>('');
  const [playbookData, setPlaybookData] = useState<any>(null);
  const [playbookContent, setPlaybookContent] = useState<string>('');
  
  const [activeTab, setActiveTab] = useState<'general' | 'scenarios' | 'facts' | 'evidence' | 'risk' | 'templates' | 'advanced'>('general');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isJsonValid, setIsJsonValid] = useState(true);
  const [copilotPrompt, setCopilotPrompt] = useState('');
  const [isCopilotLoading, setIsCopilotLoading] = useState(false);



  // Add Category Modal State
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [newCatWeight, setNewCatWeight] = useState('high');
  const [newCatMin, setNewCatMin] = useState(1);

  // Add Evidence Type Modal State
  const [showEvidenceModal, setShowEvidenceModal] = useState(false);
  const [targetCatKey, setTargetCatKey] = useState('');
  const [newEvidenceName, setNewEvidenceName] = useState('');
  const [newEvidenceStrength, setNewEvidenceStrength] = useState('high');

  // Fullscreen & Variable Guide State
  const [isTemplateFullscreen, setIsTemplateFullscreen] = useState(false);
  const [isJsonFullscreen, setIsJsonFullscreen] = useState(false);
  const [showVarGuide, setShowVarGuide] = useState(false);

  // Zen Mode Customization State
  const [zenFontSize, setZenFontSize] = useState(18);
  const [showZenVarBar, setShowZenVarBar] = useState(false);

  // Create New Playbook Modal State
  const [showNewPlaybookModal, setShowNewPlaybookModal] = useState(false);
  const [newPbTitle, setNewPbTitle] = useState('');
  const [creationMode, setCreationMode] = useState<'clone' | 'ai'>('clone');
  const [cloneSourceId, setCloneSourceId] = useState('eb1a_v1');
  const [newPbAiPrompt, setNewPbAiPrompt] = useState('');
  const [isCreatingPb, setIsCreatingPb] = useState(false);

  // Delete Playbook Modal State
  const [playbookToDelete, setPlaybookToDelete] = useState<{ id: string; name: string } | null>(null);
  const [isDeletingPb, setIsDeletingPb] = useState(false);

  // Playbook Simulator State
  const [showSimulatorModal, setShowSimulatorModal] = useState(false);
  const [simDegree, setSimDegree] = useState<'phd' | 'bachelors' | 'none'>('phd');
  const [simCitations, setSimCitations] = useState(450);
  const [simResult, setSimResult] = useState<{ triggeredFlags: any[]; evidenceCount: number; passedCategories?: any[]; petitionPreview?: string } | null>(null);

  const handleExport = () => {
    if (!playbookData) return;
    const jsonStr = JSON.stringify(playbookData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${playbookData.playbook_id || 'playbook'}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setSuccess(`Exported '${playbookData.playbook_id}.json' successfully.`);
    setTimeout(() => setSuccess(null), 3000);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const content = event.target?.result as string;
        const importedJson = JSON.parse(content);
        if (!importedJson.playbook_id) {
          throw new Error('Invalid Playbook format');
        }
        
        const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
        await fetch(`${baseUrl}/api/playbook/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: importedJson.playbook_id,
            title: importedJson.metadata?.title || importedJson.playbook_id,
            prompt: null
          })
        });
        await fetch(`${baseUrl}/api/playbook/${importedJson.playbook_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(importedJson)
        });
        
        fetchPlaybooks();
        handleSelectPlaybook(importedJson.playbook_id);
        setSuccess(`Imported '${importedJson.playbook_id}' successfully!`);
        setTimeout(() => setSuccess(null), 3000);
      } catch (err) {
        console.error(err);
        setError('Failed to import playbook. Invalid JSON.');
        setTimeout(() => setError(null), 3000);
      }
    };
    reader.readAsText(file);
  };

  const VARIABLE_DICT: Record<string, { label: string; desc: string }> = {
    '{{BENEFICIARY_NAME}}': { label: 'Beneficiary Full Name', desc: 'Auto-replaced with client\'s legal name extracted from passport/intake.' },
    '{{PETITIONER_NAME}}': { label: 'Petitioner / Sponsor', desc: 'Auto-replaced with sponsoring company name or self-petitioner.' },
    '{{FIELD_OF_EXPERTISE}}': { label: 'Field of Expertise', desc: 'Endeavor specialty area (e.g., Artificial Intelligence & Computer Vision).' },
    '{{ADVANCED_DEGREE_QUALIFICATION}}': { label: 'EB-2 Threshold Degree', desc: 'Summary of Master\'s/PhD degree or Bachelor\'s + 5 years experience.' },
    '{{EVIDENCE_SECTIONS_BREAKDOWN}}': { label: 'EB-1A Criteria Arguments', desc: 'Auto-generated arguments for each satisfied EB-1A regulatory criterion.' },
    '{{FINAL_MERITS_ARGUMENT}}': { label: 'Kazarian Final Merits', desc: 'Kazarian framework synthesis of overall sustained national/int\'l acclaim.' },
    '{{DHANASAR_PRONG_1_ARGUMENT}}': { label: 'Dhanasar Prong 1', desc: 'Substantial Merit & National Importance legal argument section.' },
    '{{DHANASAR_PRONG_2_ARGUMENT}}': { label: 'Dhanasar Prong 2', desc: 'Well-Positioned to Advance Endeavor legal argument section.' },
    '{{DHANASAR_PRONG_3_ARGUMENT}}': { label: 'Dhanasar Prong 3', desc: 'Balancing Waiver Benefit to US legal argument section.' },
    '{{ATTORNEY_NAME}}': { label: 'Attorney Name', desc: 'Full legal name and title of the assigned attorney.' },
    '{{LAW_FIRM_NAME}}': { label: 'Law Firm Name', desc: 'Header title of the law firm submitting the petition.' }
  };

  const handleCopilotSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!copilotPrompt.trim() || !playbookData) return;
    
    setIsCopilotLoading(true);
    try {
      const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const response = await fetch(`${baseUrl}/api/playbook/copilot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: copilotPrompt, currentPlaybook: playbookData })
      });
      if (!response.ok) throw new Error('Copilot request failed');
      const data = await response.json();
      
      setPlaybookData(data.updatedPlaybook);
      setPlaybookContent(JSON.stringify(data.updatedPlaybook, null, 2));
      
      const lowerPrompt = copilotPrompt.toLowerCase();
      if (lowerPrompt.includes('flag') || lowerPrompt.includes('risk') || lowerPrompt.includes('red') || lowerPrompt.includes('degree')) {
        setActiveTab('risk');
      } else if (lowerPrompt.includes('evidence') || lowerPrompt.includes('criteria') || lowerPrompt.includes('award') || lowerPrompt.includes('patent')) {
        setActiveTab('evidence');
      }

      setCopilotPrompt('');
      setSuccess('AI changes applied successfully! Switched to target tab.');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      console.error(err);
      setError('Failed to apply AI changes. Please try again.');
      setTimeout(() => setError(null), 3000);
    } finally {
      setIsCopilotLoading(false);
    }
  };

  useEffect(() => {
    fetchPlaybooks();
  }, []);

  const fetchPlaybooks = async () => {
    try {
      const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const res = await fetch(`${baseUrl}/api/playbooks`);
      const data = await res.json();
      setPlaybooks(data);
      if (data.length > 0) {
        handleSelectPlaybook(data[0].id);
      }
    } catch (err) {
      console.error(err);
      setError('Failed to load playbooks');
    }
  };

  const handleSelectPlaybook = async (id: string) => {
    setSelectedPlaybook(id);
    setError(null);
    setSuccess(null);
    try {
      const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const res = await fetch(`${baseUrl}/api/playbook/${id}`);
      if (!res.ok) throw new Error('Failed to load playbook');
      const data = await res.json();
      setPlaybookData(data);
      setPlaybookContent(JSON.stringify(data, null, 2));
      setIsJsonValid(true);
    } catch (err) {
      console.error(err);
      setError('Failed to load playbook content');
    }
  };

  // Sync data to raw JSON when switching to advanced tab or before saving
  const syncDataToContent = () => {
    if (playbookData) {
      setPlaybookContent(JSON.stringify(playbookData, null, 2));
      setIsJsonValid(true);
    }
  };

  // Sync raw JSON to data when switching away from advanced tab
  const syncContentToData = () => {
    try {
      const parsed = JSON.parse(playbookContent);
      setPlaybookData(parsed);
      setIsJsonValid(true);
      setError(null);
      return true;
    } catch (err) {
      setIsJsonValid(false);
      setError('Invalid JSON formatting in Advanced Tab. Please fix before switching tabs.');
      return false;
    }
  };

  const handleTabChange = (tab: typeof activeTab) => {
    if (activeTab === 'advanced' && tab !== 'advanced') {
      if (!syncContentToData()) return;
    } else if (tab === 'advanced' && activeTab !== 'advanced') {
      syncDataToContent();
    }
    setActiveTab(tab);
  };

  const handleSave = async () => {
    if (activeTab === 'advanced' && !isJsonValid) return;
    if (!selectedPlaybook) return;
    
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    
    try {
      const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      let payload = playbookData;
      
      // If saving from advanced tab, use the raw text if valid
      if (activeTab === 'advanced') {
         payload = JSON.parse(playbookContent);
         setPlaybookData(payload);
      }
      
      const res = await fetch(`${baseUrl}/api/playbook/${selectedPlaybook}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      if (!res.ok) throw new Error('Save failed');
      
      // Also update string content just in case
      setPlaybookContent(JSON.stringify(payload, null, 2));
      
      setSuccess('Playbook saved successfully!');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      console.error(err);
      setError('Failed to save playbook');
    } finally {
      setIsSaving(false);
    }
  };

  const updateData = (path: string[], value: any) => {
    setPlaybookData((prev: any) => {
      const newData = { ...prev };
      let current = newData;
      for (let i = 0; i < path.length - 1; i++) {
        current[path[i]] = { ...current[path[i]] };
        current = current[path[i]];
      }
      current[path[path.length - 1]] = value;
      return newData;
    });
  };

  if (isTemplateFullscreen && playbookData) {
    return (
      <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 999999, background: '#070a12', display: 'flex', flexDirection: 'column', padding: '1.5rem 2rem', boxSizing: 'border-box' }}>
        {/* Fullscreen Zen Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <FileText size={24} style={{ color: '#D9B84A' }} />
            <h2 style={{ margin: 0, fontSize: '1.4rem', color: '#f8fafc' }}>
              Cover Letter Zen Editor — {playbookData.metadata?.title || playbookData.playbook_id}
            </h2>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            {/* Font Size Controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', background: 'rgba(255, 255, 255, 0.05)', padding: '0.3rem 0.6rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginRight: '0.2rem' }}>Font Size:</span>
              <button onClick={() => setZenFontSize(Math.max(12, zenFontSize - 2))} style={{ background: 'transparent', border: 'none', color: '#D9B84A', cursor: 'pointer', fontWeight: 'bold', padding: '0.2rem 0.5rem', fontSize: '1rem' }}>A-</button>
              <span style={{ fontSize: '0.9rem', color: '#e2e8f0', minWidth: '40px', textAlign: 'center', fontWeight: 'bold' }}>{zenFontSize}px</span>
              <button onClick={() => setZenFontSize(Math.min(32, zenFontSize + 2))} style={{ background: 'transparent', border: 'none', color: '#D9B84A', cursor: 'pointer', fontWeight: 'bold', padding: '0.2rem 0.5rem', fontSize: '1rem' }}>A+</button>
            </div>

            {/* Variable Bar Toggle */}
            <button
              onClick={() => setShowZenVarBar(!showZenVarBar)}
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 1rem', background: showZenVarBar ? 'rgba(169, 135, 31, 0.25)' : 'rgba(255, 255, 255, 0.05)', color: showZenVarBar ? '#D9B84A' : 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px', cursor: 'pointer', fontSize: '0.9rem', fontWeight: 600 }}
            >
              📌 Insert Variables ({Object.keys(VARIABLE_DICT).length})
            </button>

            {/* Exit Button */}
            <button
              onClick={() => setIsTemplateFullscreen(false)}
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1.25rem', background: '#C9A227', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.95rem' }}
            >
              <Minimize2 size={18} /> Exit Fullscreen
            </button>
          </div>
        </div>

        {/* Optional Collapsible Variable Bar */}
        {showZenVarBar && (
          <div style={{ marginBottom: '1rem', background: 'rgba(169, 135, 31, 0.08)', padding: '0.75rem 1.25rem', borderRadius: '10px', border: '1px solid rgba(169, 135, 31, 0.3)', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#D9B84A' }}>Click tag to insert:</span>
            {Object.entries(VARIABLE_DICT).map(([variable, info], vIdx) => (
              <button
                key={vIdx}
                title={`${info.label}: ${info.desc}`}
                onClick={() => {
                  const currentText = playbookData.cover_letter_template || '';
                  updateData(['cover_letter_template'], currentText + ' ' + variable);
                }}
                style={{
                  padding: '0.3rem 0.6rem',
                  fontSize: '0.8rem',
                  background: 'rgba(169, 135, 31, 0.2)',
                  color: '#E8D48A',
                  border: '1px solid rgba(169, 135, 31, 0.4)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontFamily: 'monospace'
                }}
              >
                + {variable}
              </button>
            ))}
          </div>
        )}

        {/* True 100vw x 100vh Fullscreen Textarea */}
        <textarea
          value={playbookData.cover_letter_template || ''}
          onChange={(e) => updateData(['cover_letter_template'], e.target.value)}
          spellCheck={false}
          placeholder="Write your legal cover letter template here in Markdown..."
          style={{
            flexGrow: 1,
            width: '100%',
            height: '100%',
            padding: '2rem',
            background: '#0d1322',
            color: '#f8fafc',
            fontFamily: 'Consolas, Monaco, "Courier New", monospace',
            fontSize: `${zenFontSize}px`,
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '12px',
            resize: 'none',
            outline: 'none',
            lineHeight: 1.8,
            whiteSpace: 'pre-wrap',
            boxShadow: 'inset 0 4px 12px 0 rgba(0, 0, 0, 0.6)',
            boxSizing: 'border-box'
          }}
        />
      </div>
    );
  }

  if (isJsonFullscreen && playbookData) {
    return (
      <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 999999, background: '#070a12', display: 'flex', flexDirection: 'column', padding: '1.25rem 1.75rem', boxSizing: 'border-box' }}>
        {/* Fullscreen JSON Zen Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Code size={24} style={{ color: '#D9B84A' }} />
            <h2 style={{ margin: 0, fontSize: '1.4rem', color: '#f8fafc' }}>
              Advanced JSON Zen Editor — {playbookData.metadata?.title || playbookData.playbook_id}
            </h2>
          </div>
          
          <button
            onClick={() => setIsJsonFullscreen(false)}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1.25rem', background: '#C9A227', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.95rem' }}
          >
            <Minimize2 size={18} /> Exit Fullscreen
          </button>
        </div>

        {/* Fullscreen JSON Editor Body */}
        <div style={{ flexGrow: 1, overflow: 'hidden' }}>
          <JsonIDEEditor
            value={playbookContent}
            isFullscreen={true}
            onToggleFullscreen={() => setIsJsonFullscreen(false)}
            onChange={(newVal) => {
              setPlaybookContent(newVal);
              try {
                const parsed = JSON.parse(newVal);
                setIsJsonValid(true);
                setError(null);
                setPlaybookData(parsed);
              } catch (err) {
                setIsJsonValid(false);
                setError('Invalid JSON syntax formatting.');
              }
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.8rem', color: 'var(--text-primary)' }}>Playbook Builder</h1>
          <p style={{ margin: '0.5rem 0 0 0', color: 'var(--text-secondary)' }}>
            Attorney-friendly editor for automated petition generation rules.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          {/* Export & Import Controls */}
          {playbookData && (
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <button
                onClick={handleExport}
                style={{ height: '40px', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0 1rem', background: 'rgba(255, 255, 255, 0.05)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px', cursor: 'pointer', fontWeight: 500, fontSize: '0.88rem', whiteSpace: 'nowrap', boxSizing: 'border-box' }}
                title="Export Playbook as JSON file"
              >
                <Download size={15} /> Export
              </button>

              <label
                style={{ height: '40px', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0 1rem', background: 'rgba(255, 255, 255, 0.05)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px', cursor: 'pointer', fontWeight: 500, fontSize: '0.88rem', whiteSpace: 'nowrap', boxSizing: 'border-box' }}
                title="Import Playbook JSON file"
              >
                <Upload size={15} /> Import
                <input type="file" accept=".json" onChange={handleImport} style={{ display: 'none' }} />
              </label>
            </div>
          )}

          <button
            onClick={handleSave}
            disabled={(activeTab === 'advanced' && !isJsonValid) || isSaving}
            style={{
              height: '40px',
              display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
              padding: '0 1.25rem',
              background: 'var(--accent-primary)',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              fontWeight: 'bold',
              fontSize: '0.88rem',
              whiteSpace: 'nowrap',
              boxSizing: 'border-box',
              cursor: isSaving ? 'wait' : ((activeTab === 'advanced' && !isJsonValid) ? 'not-allowed' : 'pointer'),
              opacity: ((activeTab === 'advanced' && !isJsonValid) || isSaving) ? 0.7 : 1
            }}
          >
            {isSaving ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={16} />}
            {isSaving ? 'Saving...' : 'Save Playbook'}
          </button>
          {onBack && (
            <button 
              onClick={onBack}
              style={{ height: '40px', display: 'inline-flex', alignItems: 'center', padding: '0 1.1rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontWeight: 500, fontSize: '0.88rem', whiteSpace: 'nowrap', boxSizing: 'border-box' }}
            >
              Back to Dashboard
            </button>
          )}
        </div>
      </div>

      {/* Inline Status Alert Banner */}
      {(success || error) && (
        <div 
          style={{ 
            marginBottom: '1.25rem', 
            padding: '0.75rem 1.25rem', 
            borderRadius: '10px', 
            background: error ? 'rgba(162, 60, 60, 0.12)' : 'rgba(126, 154, 109, 0.12)', 
            border: `1px solid ${error ? 'rgba(162, 60, 60, 0.3)' : 'rgba(126, 154, 109, 0.3)'}`, 
            color: error ? '#D9A3A3' : '#9DBB8A',
            fontSize: '0.9rem',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem'
          }}
        >
          {error ? <AlertTriangle size={18} style={{ color: '#A23C3C' }} /> : <ShieldCheck size={18} style={{ color: '#7E9A6D' }} />}
          <span>{error || success}</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: '2rem', height: 'calc(100vh - 180px)' }}>
        {/* Sidebar */}
        <div style={{ width: '280px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div className="glass-card" style={{ padding: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1rem' }}>Select Playbook</h3>
              <button
                onClick={() => {
                  setNewPbTitle('');
                  setCreationMode('clone');
                  setCloneSourceId(selectedPlaybook || 'eb1a_v1');
                  setNewPbAiPrompt('');
                  setShowNewPlaybookModal(true);
                }}
                style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.3rem 0.6rem', fontSize: '0.8rem', background: 'rgba(201, 162, 39, 0.15)', color: '#D9B84A', border: '1px solid rgba(201, 162, 39, 0.3)', borderRadius: '4px', cursor: 'pointer', fontWeight: 600 }}
              >
                <Plus size={12} /> New
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {playbooks.map(pb => (
                <div
                  key={pb.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.6rem 0.75rem',
                    background: selectedPlaybook === pb.id ? 'rgba(201, 162, 39, 0.1)' : 'transparent',
                    border: `1px solid ${selectedPlaybook === pb.id ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                    borderRadius: '6px',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                  onClick={() => handleSelectPlaybook(pb.id)}
                >
                  <div style={{ fontWeight: 'bold', fontSize: '0.88rem', color: selectedPlaybook === pb.id ? 'var(--accent-primary)' : 'var(--text-primary)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', flex: 1, paddingRight: '0.5rem' }}>
                    {pb.name}
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setPlaybookToDelete({ id: pb.id, name: pb.name });
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#A23C3C',
                      cursor: 'pointer',
                      padding: '0.2rem',
                      display: 'flex',
                      alignItems: 'center',
                      opacity: 0.6,
                      transition: 'opacity 0.2s'
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.6')}
                    title="Delete Playbook"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
          
          <div className="glass-card" style={{ padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            {[
              { id: 'general', icon: <Settings size={16} />, label: 'General Info' },
              { id: 'scenarios', icon: <FileText size={16} />, label: 'Filing Scenarios' },
              { id: 'facts', icon: <HelpCircle size={16} />, label: 'Required Facts' },
              { id: 'evidence', icon: <ShieldCheck size={16} />, label: 'Evidence Rules' },
              { id: 'risk', icon: <AlertCircle size={16} />, label: 'Risk Flags' },
              { id: 'templates', icon: <FileText size={16} />, label: 'Cover Letter' },
              { id: 'advanced', icon: <Code size={16} />, label: 'Advanced JSON' },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id as any)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                  padding: '0.75rem 1rem',
                  textAlign: 'left',
                  background: activeTab === tab.id ? 'rgba(201, 162, 39, 0.1)' : 'transparent',
                  border: 'none',
                  borderRadius: '6px',
                  color: activeTab === tab.id ? 'var(--accent-primary)' : 'var(--text-secondary)',
                  fontWeight: activeTab === tab.id ? 600 : 500,
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Editor Area */}
        <div className="glass-card" style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          
          {activeTab === 'general' && playbookData && (
            <div style={{ padding: '2rem', overflowY: 'auto' }}>
              <h2 style={{ marginTop: 0, marginBottom: '2rem' }}>General Information</h2>
              
              <div style={{ display: 'grid', gap: '1.5rem', maxWidth: '600px' }}>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Playbook ID (Read Only)</label>
                  <input type="text" value={playbookData.playbook_id || ''} readOnly style={{ width: '100%', padding: '0.75rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }} />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Associated Visa / Case Category</label>
                  <select
                    value={playbookData.case_type || 'eb1a'}
                    onChange={e => updateData(['case_type'], e.target.value)}
                    style={{ width: '100%', padding: '0.75rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: '#12151C', color: 'var(--text-primary)', fontSize: '0.9rem' }}
                  >
                    <option value="eb1a">EB-1A (Extraordinary Ability)</option>
                    <option value="eb2_niw">EB-2 NIW (National Interest Waiver)</option>
                    <option value="L-1A Visa">L-1A (Multinational Executive / Manager)</option>
                    <option value="marriage_green_card">Marriage Green Card (I-130 / I-485)</option>
                    <option value="o1a">O-1A (Extraordinary Ability Sciences/Biz)</option>
                    <option value="h1b">H-1B (Specialty Occupation)</option>
                    <option value="general_intake">General Intake / Custom</option>
                  </select>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.6rem 0.8rem', background: 'rgba(201, 162, 39, 0.08)', borderRadius: '6px', border: '1px solid rgba(201, 162, 39, 0.25)' }}>
                  <input
                    type="checkbox"
                    id="is_default_checkbox"
                    checked={!!playbookData.is_default}
                    onChange={e => updateData(['is_default'], e.target.checked)}
                    style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                  />
                  <label htmlFor="is_default_checkbox" style={{ fontSize: '0.85rem', color: '#E8D48A', cursor: 'pointer', fontWeight: 600 }}>
                    Set as Default Playbook for this Case Category (Auto-loaded when AI detects case)
                  </label>
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Target Audience</label>
                  <input 
                    type="text" 
                    value={playbookData.audience || ''} 
                    onChange={e => updateData(['audience'], e.target.value)}
                    style={{ width: '100%', padding: '0.75rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)' }} 
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Description</label>
                  <textarea 
                    value={playbookData.description || ''} 
                    onChange={e => updateData(['description'], e.target.value)}
                    rows={4}
                    style={{ width: '100%', padding: '0.75rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)', resize: 'vertical' }} 
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'scenarios' && playbookData && (
            <div style={{ padding: '2rem', overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                <div>
                  <h2 style={{ margin: 0 }}>Filing Scenarios & Required USCIS Forms</h2>
                  <p style={{ margin: '0.25rem 0 0 0', color: 'var(--text-secondary)', fontSize: '0.88rem' }}>
                    Configure filing pathways (e.g. I-140 Petition Only, Concurrent AOS) and required form packages.
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                {Object.entries(playbookData.scenarios || {}).map(([scenKey, scenVal]: [string, any]) => (
                  <div key={scenKey} className="glass-card" style={{ padding: '1.25rem', border: '1px solid var(--border-color)', borderRadius: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '0.75rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ fontWeight: 'bold', color: '#D9B84A', fontSize: '1rem' }}>{scenVal.label || scenKey}</span>
                        <span style={{ fontSize: '0.78rem', background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)', padding: '0.15rem 0.5rem', borderRadius: '4px', fontFamily: 'monospace' }}>Key: {scenKey}</span>
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>Scenario Display Label</label>
                        <input
                          type="text"
                          value={scenVal.label || ''}
                          onChange={(e) => updateData(['scenarios', scenKey, 'label'], e.target.value)}
                          style={{ width: '100%', padding: '0.6rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: '#12151C', color: '#e2e8f0', fontSize: '0.88rem' }}
                        />
                      </div>

                      <div>
                        <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>Filing Notes / Strategy</label>
                        <input
                          type="text"
                          value={scenVal.notes || ''}
                          onChange={(e) => updateData(['scenarios', scenKey, 'notes'], e.target.value)}
                          style={{ width: '100%', padding: '0.6rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: '#12151C', color: '#e2e8f0', fontSize: '0.88rem' }}
                        />
                      </div>
                    </div>

                    <div style={{ marginTop: '1rem' }}>
                      <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>Required Forms (comma-separated)</label>
                      <input
                        type="text"
                        value={Array.isArray(scenVal.forms) ? scenVal.forms.join(', ') : ''}
                        onChange={(e) => {
                          const formsArr = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                          updateData(['scenarios', scenKey, 'forms'], formsArr);
                        }}
                        placeholder="e.g. I-140, I-485, I-765, I-131"
                        style={{ width: '100%', padding: '0.6rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: '#12151C', color: '#9DBB8A', fontFamily: 'monospace', fontSize: '0.88rem' }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'facts' && playbookData && (
            <div style={{ padding: '2rem', overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                <div>
                  <h2 style={{ margin: 0 }}>Required Intake Facts</h2>
                  <p style={{ margin: '0.25rem 0 0 0', color: 'var(--text-secondary)', fontSize: '0.88rem' }}>
                    Define the fact fields requested during case intake to satisfy criteria rules.
                  </p>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
                {(playbookData.required_facts || []).map((fact: any, fIdx: number) => (
                  <div key={fact.id || fIdx} className="glass-card" style={{ padding: '1rem', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                    <div style={{ fontWeight: 'bold', color: '#D9B84A', marginBottom: '0.5rem', fontSize: '0.92rem' }}>
                      {fact.label || fact.id}
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', fontFamily: 'monospace' }}>
                      ID: {fact.id} | Type: {fact.type || 'string'}
                    </div>
                    <input
                      type="text"
                      value={fact.label || ''}
                      onChange={(e) => {
                        const updated = [...(playbookData.required_facts || [])];
                        updated[fIdx] = { ...updated[fIdx], label: e.target.value };
                        updateData(['required_facts'], updated);
                      }}
                      placeholder="Fact prompt label..."
                      style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: '#12151C', color: '#e2e8f0', fontSize: '0.84rem' }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'evidence' && playbookData && playbookData.evidence_map && (
            <div style={{ padding: '2rem', overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
                <div>
                  <h2 style={{ margin: 0 }}>Evidence Rules (Evidence Map)</h2>
                  <p style={{ color: 'var(--text-secondary)', margin: '0.5rem 0 0 0' }}>Set the minimum required items and thresholds for each evidentiary category.</p>
                </div>
                <button
                  onClick={() => {
                    setNewCatName('');
                    setNewCatWeight('high');
                    setNewCatMin(1);
                    setShowCategoryModal(true);
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 1rem', background: 'rgba(201, 162, 39, 0.15)', color: '#D9B84A', border: '1px solid rgba(201, 162, 39, 0.4)', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}
                >
                  <Plus size={16} /> Add Category
                </button>
              </div>
              
              <div style={{ display: 'grid', gap: '2rem' }}>
                {Object.entries(playbookData.evidence_map).map(([key, category]: [string, any]) => (
                  <div key={key} style={{ padding: '1.5rem', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'rgba(255,255,255,0.02)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                      <h3 style={{ margin: 0, color: 'var(--accent-primary)' }}>{category.label || key}</h3>
                      <span style={{ fontSize: '0.8rem', padding: '0.2rem 0.6rem', background: 'rgba(255,255,255,0.1)', borderRadius: '99px' }}>{key}</span>
                    </div>
                    
                    <div style={{ display: 'flex', gap: '2rem', marginBottom: '1.5rem' }}>
                      <div>
                        <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Minimum Required Items</label>
                        <input 
                          type="number" 
                          min={0}
                          value={category.min_items || 0}
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10);
                            if (!isNaN(val)) updateData(['evidence_map', key, 'min_items'], val);
                          }}
                          style={{ width: '120px', padding: '0.5rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)' }}
                        />
                      </div>
                      <div>
                        <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Category Weight</label>
                        <select
                          value={category.weight || 'medium'}
                          onChange={(e) => updateData(['evidence_map', key, 'weight'], e.target.value)}
                          style={{ padding: '0.5rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: '#12151C', color: 'var(--text-primary)' }}
                        >
                          <option value="critical">Critical</option>
                          <option value="high">High</option>
                          <option value="medium">Medium</option>
                          <option value="low">Low</option>
                        </select>
                      </div>
                    </div>
                    
                    <div>
                      <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Preferred Evidence Types ({category.preferred?.length || 0})</label>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                        {category.preferred?.map((pref: any, idx: number) => (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', padding: '0.3rem 0.6rem', fontSize: '0.8rem', background: 'rgba(201, 162, 39, 0.1)', color: 'var(--text-primary)', borderRadius: '4px', border: '1px solid rgba(201, 162, 39, 0.3)' }}>
                            {pref.id} <span style={{ opacity: 0.5, margin: '0 0.3rem' }}>({pref.strength})</span>
                            <button 
                              onClick={() => {
                                const newPref = [...category.preferred];
                                newPref.splice(idx, 1);
                                updateData(['evidence_map', key, 'preferred'], newPref);
                              }}
                              style={{ background: 'transparent', border: 'none', color: '#A23C3C', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}
                              title="Remove"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ))}
                        
                        <button
                          onClick={() => {
                            setTargetCatKey(key);
                            setNewEvidenceName('');
                            setNewEvidenceStrength('high');
                            setShowEvidenceModal(true);
                          }}
                          style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.6rem', fontSize: '0.8rem', background: 'rgba(255, 255, 255, 0.05)', color: 'var(--text-secondary)', borderRadius: '4px', border: '1px dashed rgba(255, 255, 255, 0.3)', cursor: 'pointer' }}
                        >
                          <Plus size={12} /> Add Evidence
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'risk' && playbookData && playbookData.escalation_flags && (
            <div style={{ padding: '2rem', overflowY: 'auto' }}>
              <h2 style={{ marginTop: 0, marginBottom: '2rem' }}>Risk & Escalation Flags</h2>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                {playbookData.escalation_flags.map((flag: any, index: number) => {
                  const triggerType = flag.trigger?.evidence_category ? 'evidence' : 'fact';
                  const triggerTarget = flag.trigger?.evidence_category || flag.trigger?.fact || '';
                  
                  return (
                  <div key={index} style={{ padding: '1.5rem', border: '1px solid var(--border-color)', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <input 
                        type="text" 
                        value={flag.label || ''} 
                        onChange={(e) => updateData(['escalation_flags', String(index), 'label'], e.target.value)}
                        placeholder="Rule Name"
                        style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', fontSize: '1.1rem', fontWeight: 'bold', outline: 'none', width: '100%' }}
                      />
                      <button
                        onClick={() => {
                          const newFlags = [...playbookData.escalation_flags];
                          newFlags.splice(index, 1);
                          updateData(['escalation_flags'], newFlags);
                        }}
                        style={{ background: 'transparent', border: 'none', color: '#A23C3C', cursor: 'pointer', padding: '0.2rem', display: 'flex', alignItems: 'center', opacity: 0.7 }}
                        title="Delete Rule"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    
                    {/* IF Block */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', background: 'rgba(201, 162, 39, 0.05)', padding: '0.75rem 1rem', borderRadius: '8px', borderLeft: '3px solid #C9A227' }}>
                      <strong style={{ color: '#C9A227', marginRight: '0.5rem' }}>IF</strong>
                      
                      <select
                        value={triggerType}
                        onChange={(e) => {
                          const newType = e.target.value;
                          const newTrigger = newType === 'evidence' ? { evidence_category: 'eb1a_criteria', condition: 'count_lt_min_items' } : { fact: 'criminal_history', condition: 'is_present' };
                          updateData(['escalation_flags', String(index), 'trigger'], newTrigger);
                        }}
                        className="builder-select"
                        style={{ padding: '0.4rem 0.8rem', borderRadius: '99px', border: '1px solid rgba(201,162,39,0.3)', backgroundColor: 'rgba(201,162,39,0.1)', color: '#D9B84A', fontWeight: 600, outline: 'none', cursor: 'pointer', appearance: 'none' }}
                      >
                        <option value="evidence">Evidence Category</option>
                        <option value="fact">Specific Fact</option>
                      </select>
                      
                      <span style={{ color: 'var(--text-secondary)' }}>:</span>
                      
                      <select
                        value={triggerTarget}
                        onChange={(e) => {
                          const key = triggerType === 'evidence' ? 'evidence_category' : 'fact';
                          updateData(['escalation_flags', String(index), 'trigger', key], e.target.value);
                        }}
                        className="builder-select"
                        style={{ padding: '0.4rem 0.8rem', borderRadius: '99px', border: '1px solid rgba(255,255,255,0.2)', backgroundColor: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)', fontWeight: 600, outline: 'none', cursor: 'pointer', appearance: 'none' }}
                      >
                        {triggerType === 'evidence' ? (
                          <>
                            <option value="eb1a_criteria">EB-1A Criteria</option>
                            <option value="sustained_acclaim">Sustained Acclaim</option>
                            {triggerTarget && triggerTarget !== 'eb1a_criteria' && triggerTarget !== 'sustained_acclaim' && (
                              <option value={triggerTarget}>{triggerTarget}</option>
                            )}
                          </>
                        ) : (
                          <>
                            <option value="criminal_history">Criminal History</option>
                            <option value="immigration_history">Immigration History</option>
                            <option value="beneficiary_lawful_entry">Lawful Entry</option>
                            {triggerTarget && !['criminal_history', 'immigration_history', 'beneficiary_lawful_entry'].includes(triggerTarget) && (
                              <option value={triggerTarget}>{triggerTarget.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())}</option>
                            )}
                          </>
                        )}
                      </select>
                      
                      <select
                        value={flag.trigger?.condition || ''}
                        onChange={(e) => updateData(['escalation_flags', String(index), 'trigger', 'condition'], e.target.value)}
                        className="builder-select"
                        style={{ padding: '0.4rem 0.8rem', borderRadius: '99px', border: '1px solid rgba(255,255,255,0.2)', backgroundColor: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)', fontWeight: 600, outline: 'none', cursor: 'pointer', appearance: 'none' }}
                      >
                        {triggerType === 'evidence' ? (
                          <option value="count_lt_min_items">is less than minimum required</option>
                        ) : (
                          <>
                            <option value="is_present">is present</option>
                            <option value="any_adverse_present">has any adverse record</option>
                            <option value="is_false">evaluates to false</option>
                          </>
                        )}
                      </select>
                    </div>

                    {/* THEN Block */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', background: 'rgba(189, 123, 44, 0.05)', padding: '0.75rem 1rem', borderRadius: '8px', borderLeft: '3px solid #BD7B2C' }}>
                      <strong style={{ color: '#BD7B2C', marginRight: '0.5rem' }}>THEN</strong>
                      
                      <select
                        value={flag.action || 'notify_attorney'}
                        onChange={(e) => updateData(['escalation_flags', String(index), 'action'], e.target.value)}
                        className="builder-select"
                        style={{ padding: '0.4rem 0.8rem', borderRadius: '99px', border: '1px solid rgba(189, 123, 44, 0.3)', backgroundColor: 'rgba(189, 123, 44, 0.1)', color: '#E0B96A', fontWeight: 600, outline: 'none', cursor: 'pointer', appearance: 'none' }}
                      >
                        <option value="block_petition_assembly">Block Petition Assembly</option>
                        <option value="attorney_review_required">Require Attorney Review</option>
                        <option value="notify_attorney">Notify Attorney Only</option>
                      </select>
                      
                      <span style={{ color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>with severity:</span>
                      
                      <select
                        value={flag.severity || 'info'}
                        onChange={(e) => updateData(['escalation_flags', String(index), 'severity'], e.target.value)}
                        className="builder-select"
                        style={{ 
                          padding: '0.4rem 0.8rem', borderRadius: '99px', fontWeight: 'bold',
                          border: 'none', outline: 'none', cursor: 'pointer', appearance: 'none',
                          backgroundColor: flag.severity === 'critical' ? 'rgba(162, 60, 60, 0.2)' : flag.severity === 'high' ? 'rgba(189, 123, 44, 0.2)' : 'rgba(201, 162, 39, 0.2)',
                          color: flag.severity === 'critical' ? '#A23C3C' : flag.severity === 'high' ? '#BD7B2C' : '#C9A227'
                        }}
                      >
                        <option value="critical">🔴 CRITICAL</option>
                        <option value="high">🟠 HIGH</option>
                        <option value="info">🔵 INFO</option>
                      </select>
                    </div>

                    {/* MESSAGE Block */}
                    <div style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '1rem', borderRadius: '8px', border: '1px dashed var(--border-color)' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        <AlertCircle size={14} /> Message displayed to Attorney
                      </label>
                      <textarea
                        value={flag.message || ''}
                        onChange={(e) => updateData(['escalation_flags', String(index), 'message'], e.target.value)}
                        rows={2}
                        placeholder="Type warning message here..."
                        style={{ width: '100%', padding: '0.75rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: '#12151C', color: 'var(--text-primary)', resize: 'vertical' }}
                      />
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === 'templates' && playbookData && (
            <div style={{ padding: '2rem', display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <div>
                  <h2 style={{ marginTop: 0, marginBottom: '0.5rem' }}>Cover Letter Template Editor</h2>
                  <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.9rem' }}>
                    Configure the exact Markdown format and placeholders used by the AI when generating legal Petition Cover Letters.
                  </p>
                </div>
                
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <button
                    onClick={() => setShowVarGuide(!showVarGuide)}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 0.9rem', background: showVarGuide ? 'rgba(201, 162, 39, 0.25)' : 'rgba(255, 255, 255, 0.05)', color: showVarGuide ? '#D9B84A' : 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px', cursor: 'pointer', fontSize: '0.85rem' }}
                  >
                    <HelpCircle size={15} /> Attorney Guide
                  </button>

                  <button
                    onClick={() => setIsTemplateFullscreen(true)}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 0.9rem', background: '#C9A227', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem' }}
                  >
                    <Maximize2 size={15} /> Fullscreen Zen Mode
                  </button>
                </div>
              </div>

              {/* How Variables Work Guide Banner */}
              {showVarGuide && (
                <div style={{ marginBottom: '1.5rem', background: 'rgba(201, 162, 39, 0.08)', padding: '1.25rem', borderRadius: '12px', border: '1px solid rgba(201, 162, 39, 0.3)', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#D9B84A', fontWeight: 'bold', fontSize: '0.95rem' }}>
                    <Info size={18} /> How AI Template Variables Work (Attorney Reference Guide)
                  </div>
                  <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--text-primary)', lineHeight: 1.6 }}>
                    Placeholders enclosed in double curly braces (e.g. <code style={{ color: '#D9B84A', background: 'rgba(0,0,0,0.3)', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>{"{{BENEFICIARY_NAME}}"}</code>) represent <strong>dynamic AI slots</strong>. 
                    When a client case is processed, the system automatically pulls extracted intake facts and AI-generated legal arguments, substituting them directly into your template. 
                    You can freely arrange, reword surrounding legal boilerplate, or add your firm's standard disclaimer text around these variables.
                  </p>
                </div>
              )}

              {/* Dynamic Variable Chips Bar with Tooltips */}
              <div style={{ marginBottom: '1.5rem', background: 'rgba(169, 135, 31, 0.05)', padding: '1.25rem', borderRadius: '12px', border: '1px solid rgba(169, 135, 31, 0.2)' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#D9B84A', marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>📌 Hover for description / Click to insert variable:</span>
                  <span style={{ fontSize: '0.75rem', opacity: 0.7, fontWeight: 'normal' }}>Hover over any tag to see how AI replaces it</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
                  {Object.entries(VARIABLE_DICT).map(([variable, info], vIdx) => (
                    <button
                      key={vIdx}
                      title={`${info.label}: ${info.desc}`}
                      onClick={() => {
                        const currentText = playbookData.cover_letter_template || '';
                        updateData(['cover_letter_template'], currentText + ' ' + variable);
                      }}
                      style={{
                        padding: '0.35rem 0.7rem',
                        fontSize: '0.8rem',
                        background: 'rgba(169, 135, 31, 0.15)',
                        color: '#E8D48A',
                        border: '1px solid rgba(169, 135, 31, 0.35)',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontWeight: 600,
                        fontFamily: 'monospace',
                        transition: 'all 0.15s'
                      }}
                    >
                      + {variable}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: '350px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <label style={{ fontSize: '0.9rem', color: 'var(--text-primary)', fontWeight: 'bold' }}>
                    Markdown Template Content (`cover_letter_template`)
                  </label>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Supports GitHub Flavored Markdown & Dynamic Tags</span>
                </div>
                <textarea
                  value={playbookData.cover_letter_template || ''}
                  onChange={(e) => updateData(['cover_letter_template'], e.target.value)}
                  placeholder="Paste or write your firm's custom Cover Letter template in Markdown format here..."
                  spellCheck={false}
                  style={{
                    flexGrow: 1,
                    minHeight: '350px',
                    width: '100%',
                    padding: '1.25rem',
                    background: '#12151C',
                    color: '#e2e8f0',
                    fontFamily: 'monospace',
                    fontSize: '14px',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    resize: 'vertical',
                    outline: 'none',
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap'
                  }}
                />
              </div>
            </div>
          )}

          {activeTab === 'advanced' && (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '1rem' }}>
              <JsonIDEEditor
                value={playbookContent}
                isFullscreen={false}
                onToggleFullscreen={() => setIsJsonFullscreen(true)}
                onChange={(newVal) => {
                  setPlaybookContent(newVal);
                  try {
                    const parsed = JSON.parse(newVal);
                    setIsJsonValid(true);
                    setError(null);
                    setPlaybookData(parsed);
                  } catch (err) {
                    setIsJsonValid(false);
                    setError('Invalid JSON syntax formatting.');
                  }
                }}
              />
            </div>
          )}

          {/* AI Copilot Bar */}
          {playbookData && (
            <div style={{ marginTop: 'auto', padding: '1.5rem', background: 'rgba(255,255,255,0.02)', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#A9871F', fontWeight: 600, fontSize: '0.9rem' }}>
                <Wand2 size={16} /> AI Playbook Assistant
              </div>
              <form onSubmit={handleCopilotSubmit} style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="text"
                  value={copilotPrompt}
                  onChange={(e) => setCopilotPrompt(e.target.value)}
                  placeholder="e.g., 'Add a critical risk flag if they have no degree' or 'Add Patent Citations as preferred evidence'"
                  disabled={isCopilotLoading}
                  style={{ flexGrow: 1, padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: '#12151C', color: 'var(--text-primary)', outline: 'none' }}
                />
                <button 
                  type="submit" 
                  disabled={isCopilotLoading || !copilotPrompt.trim()}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 1.25rem', background: '#A9871F', color: 'white', border: 'none', borderRadius: '8px', cursor: isCopilotLoading ? 'wait' : (!copilotPrompt.trim() ? 'default' : 'pointer'), opacity: (isCopilotLoading || !copilotPrompt.trim()) ? 0.6 : 1, transition: 'all 0.2s' }}
                  title={isCopilotLoading ? 'Gemini AI is updating playbook...' : 'Send prompt to AI Assistant'}
                >
                  {isCopilotLoading ? <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={18} />}
                </button>
              </form>
            </div>
          )}

      {/* Sleek Modal for Create New Playbook */}
      {showNewPlaybookModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0, 0, 0, 0.75)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div style={{ background: '#1A1E27', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '2rem', width: '100%', maxWidth: '520px', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: '1.25rem', color: 'var(--text-primary)' }}>Create New Playbook</h3>
              <button onClick={() => setShowNewPlaybookModal(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={18} /></button>
            </div>

            {/* Mode Switcher Tabs */}
            <div style={{ display: 'flex', gap: '0.5rem', background: 'rgba(0,0,0,0.3)', padding: '0.25rem', borderRadius: '8px' }}>
              <button
                onClick={() => setCreationMode('clone')}
                style={{ flex: 1, padding: '0.5rem', borderRadius: '6px', border: 'none', background: creationMode === 'clone' ? '#C9A227' : 'transparent', color: creationMode === 'clone' ? 'white' : 'var(--text-secondary)', fontWeight: 600, cursor: 'pointer', fontSize: '0.85rem' }}
              >
                📋 Clone Existing Template
              </button>
              <button
                onClick={() => setCreationMode('ai')}
                style={{ flex: 1, padding: '0.5rem', borderRadius: '6px', border: 'none', background: creationMode === 'ai' ? '#A9871F' : 'transparent', color: creationMode === 'ai' ? 'white' : 'var(--text-secondary)', fontWeight: 600, cursor: 'pointer', fontSize: '0.85rem' }}
              >
                ✨ AI Auto-Generate
              </button>
            </div>
            
            {creationMode === 'clone' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Base Template to Clone From</label>
                  <select
                    value={cloneSourceId}
                    onChange={(e) => {
                      setCloneSourceId(e.target.value);
                      const sourcePb = playbooks.find(p => p.id === e.target.value);
                      if (sourcePb) setNewPbTitle(`${sourcePb.name} (Copy)`);
                    }}
                    style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: '#12151C', color: 'var(--text-primary)', outline: 'none' }}
                  >
                    {playbooks.map(pb => (
                      <option key={pb.id} value={pb.id}>{pb.name} ({pb.id})</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>New Playbook Title (Optional)</label>
                  <input 
                    type="text" 
                    placeholder="e.g. O-1A Extraordinary Ability (Firm Custom)" 
                    value={newPbTitle} 
                    onChange={(e) => setNewPbTitle(e.target.value)} 
                    style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: '#12151C', color: 'var(--text-primary)', outline: 'none' }}
                  />
                  <p style={{ margin: '0.4rem 0 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    Copies all Evidence Map rules, Risk Flags, and Cover Letter formatting so you never start from zero.
                  </p>
                </div>
              </div>
            ) : (
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.85rem', color: '#D9B84A', fontWeight: 'bold' }}>
                  AI Generation Prompt (Describe your visa/case requirements)
                </label>
                <textarea
                  rows={4}
                  placeholder="e.g., 'Create an O-1A Extraordinary Ability playbook focusing on 8 criteria and critical risk flags for low peer-reviewed citations and salary requirement'"
                  value={newPbAiPrompt}
                  onChange={(e) => setNewPbAiPrompt(e.target.value)}
                  style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: '#12151C', color: 'var(--text-primary)', outline: 'none', resize: 'vertical', lineHeight: 1.5 }}
                />
                <p style={{ margin: '0.4rem 0 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  ✨ AI will automatically deduce the title, structure the evidence criteria, and write the risk flags.
                </p>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
              <button onClick={() => setShowNewPlaybookModal(false)} style={{ padding: '0.6rem 1.25rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
              <button 
                disabled={isCreatingPb || (creationMode === 'ai' && !newPbAiPrompt.trim())}
                onClick={async () => {
                  if (creationMode === 'ai' && !newPbAiPrompt.trim()) return;
                  setIsCreatingPb(true);
                  try {
                    const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
                    const res = await fetch(`${baseUrl}/api/playbook/create`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        title: newPbTitle,
                        cloneFromId: creationMode === 'clone' ? cloneSourceId : null,
                        prompt: creationMode === 'ai' ? newPbAiPrompt : null
                      })
                    });
                    if (!res.ok) throw new Error('Failed to create playbook');
                    const data = await res.json();
                    
                    fetchPlaybooks();
                    handleSelectPlaybook(data.id);
                    setShowNewPlaybookModal(false);
                    setSuccess(`Playbook created successfully!`);
                    setTimeout(() => setSuccess(null), 3000);
                  } catch (err) {
                    console.error(err);
                    setError('Failed to create new playbook.');
                    setTimeout(() => setError(null), 3000);
                  } finally {
                    setIsCreatingPb(false);
                  }
                }} 
                style={{ padding: '0.6rem 1.25rem', borderRadius: '8px', border: 'none', background: creationMode === 'ai' ? '#A9871F' : '#C9A227', color: 'white', fontWeight: 600, cursor: isCreatingPb ? 'wait' : ((creationMode === 'ai' && !newPbAiPrompt.trim()) ? 'default' : 'pointer'), opacity: (isCreatingPb || (creationMode === 'ai' && !newPbAiPrompt.trim())) ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: '0.5rem' }}
              >
                {isCreatingPb ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : creationMode === 'ai' ? <Wand2 size={16} /> : <Plus size={16} />}
                {isCreatingPb ? (creationMode === 'ai' ? '✨ AI Generating Playbook...' : 'Cloning Template...') : creationMode === 'ai' ? 'Generate Playbook' : 'Create Playbook'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Sleek Delete Confirmation Modal */}
      {playbookToDelete && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0, 0, 0, 0.75)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div style={{ background: '#1A1E27', border: '1px solid rgba(162, 60, 60, 0.3)', borderRadius: '16px', padding: '2rem', width: '100%', maxWidth: '440px', boxShadow: '0 25px 50px -12px rgba(162, 60, 60, 0.25)', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div style={{ background: 'rgba(162, 60, 60, 0.15)', padding: '0.6rem', borderRadius: '12px', border: '1px solid rgba(162, 60, 60, 0.3)' }}>
                <Trash2 size={24} style={{ color: '#A23C3C' }} />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.2rem', color: '#f8fafc' }}>Delete Playbook</h3>
                <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>This action cannot be undone.</p>
              </div>
            </div>

            <div style={{ background: 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Are you sure you want to permanently delete:</span>
              <div style={{ fontWeight: 'bold', fontSize: '1rem', color: '#A23C3C', marginTop: '0.4rem', wordBreak: 'break-word' }}>
                {playbookToDelete.name}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.25rem' }}>
              <button 
                onClick={() => setPlaybookToDelete(null)} 
                disabled={isDeletingPb}
                style={{ padding: '0.6rem 1.25rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', cursor: isDeletingPb ? 'wait' : 'pointer' }}
              >
                Cancel
              </button>
              <button 
                disabled={isDeletingPb}
                onClick={async () => {
                  setIsDeletingPb(true);
                  try {
                    const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
                    const res = await fetch(`${baseUrl}/api/playbook/${playbookToDelete.id}`, { method: 'DELETE' });
                    if (res.ok) {
                      setSuccess(`Playbook '${playbookToDelete.name}' deleted successfully.`);
                      setTimeout(() => setSuccess(null), 3000);
                      const updated = playbooks.filter(p => p.id !== playbookToDelete.id);
                      setPlaybooks(updated);
                      if (selectedPlaybook === playbookToDelete.id && updated.length > 0) {
                        handleSelectPlaybook(updated[0].id);
                      }
                      setPlaybookToDelete(null);
                    } else {
                      setError('Failed to delete playbook.');
                      setTimeout(() => setError(null), 3000);
                    }
                  } catch (err) {
                    console.error(err);
                    setError('Error deleting playbook.');
                    setTimeout(() => setError(null), 3000);
                  } finally {
                    setIsDeletingPb(false);
                  }
                }} 
                style={{ padding: '0.6rem 1.25rem', borderRadius: '8px', border: 'none', background: '#A23C3C', color: 'white', fontWeight: 600, cursor: isDeletingPb ? 'wait' : 'pointer', opacity: isDeletingPb ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: '0.5rem' }}
              >
                {isDeletingPb ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Trash2 size={16} />}
                {isDeletingPb ? 'Deleting...' : 'Delete Playbook'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sleek Modal for Add Category */}
      {showCategoryModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0, 0, 0, 0.75)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div style={{ background: '#1A1E27', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '2rem', width: '100%', maxWidth: '480px', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: '1.25rem', color: 'var(--text-primary)' }}>Add Evidence Category</h3>
              <button onClick={() => setShowCategoryModal(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={18} /></button>
            </div>
            
            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Category Name</label>
              <input 
                type="text" 
                placeholder="e.g. Scholarly Articles & Citations" 
                value={newCatName} 
                onChange={(e) => setNewCatName(e.target.value)} 
                style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: '#12151C', color: 'var(--text-primary)', outline: 'none' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Min Required Items</label>
                <input 
                  type="number" 
                  min={1}
                  value={newCatMin} 
                  onChange={(e) => setNewCatMin(parseInt(e.target.value) || 1)} 
                  style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: '#12151C', color: 'var(--text-primary)', outline: 'none' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Category Weight</label>
                <select 
                  value={newCatWeight} 
                  onChange={(e) => setNewCatWeight(e.target.value)} 
                  style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: '#12151C', color: 'var(--text-primary)', outline: 'none' }}
                >
                  <option value="critical">Critical</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
              <button onClick={() => setShowCategoryModal(false)} style={{ padding: '0.6rem 1.25rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
              <button 
                disabled={!newCatName.trim()}
                onClick={() => {
                  if (!newCatName.trim()) return;
                  const cleanKey = newCatName.trim().toLowerCase().replace(/\s+/g, '_');
                  updateData(['evidence_map', cleanKey], {
                    label: newCatName.trim(),
                    min_items: newCatMin,
                    weight: newCatWeight,
                    preferred: []
                  });
                  setShowCategoryModal(false);
                }} 
                style={{ padding: '0.6rem 1.25rem', borderRadius: '8px', border: 'none', background: '#C9A227', color: 'white', fontWeight: 600, cursor: !newCatName.trim() ? 'default' : 'pointer', opacity: !newCatName.trim() ? 0.6 : 1 }}
              >
                Create Category
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sleek Modal for Add Evidence Type */}
      {showEvidenceModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0, 0, 0, 0.75)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div style={{ background: '#1A1E27', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '2rem', width: '100%', maxWidth: '440px', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: '1.25rem', color: 'var(--text-primary)' }}>Add Evidence Type</h3>
              <button onClick={() => setShowEvidenceModal(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={18} /></button>
            </div>
            
            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Evidence Identifier / Name</label>
              <input 
                type="text" 
                placeholder="e.g. patent_citations" 
                value={newEvidenceName} 
                onChange={(e) => setNewEvidenceName(e.target.value)} 
                style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: '#12151C', color: 'var(--text-primary)', outline: 'none' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Evidence Strength</label>
              <select 
                value={newEvidenceStrength} 
                onChange={(e) => setNewEvidenceStrength(e.target.value)} 
                style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: '#12151C', color: 'var(--text-primary)', outline: 'none' }}
              >
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
              <button onClick={() => setShowEvidenceModal(false)} style={{ padding: '0.6rem 1.25rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
              <button 
                disabled={!newEvidenceName.trim()}
                onClick={() => {
                  if (!newEvidenceName.trim() || !targetCatKey) return;
                  const cleanId = newEvidenceName.trim().toLowerCase().replace(/\s+/g, '_');
                  const currentPref = playbookData?.evidence_map?.[targetCatKey]?.preferred || [];
                  const newPref = [...currentPref, { id: cleanId, strength: newEvidenceStrength }];
                  updateData(['evidence_map', targetCatKey, 'preferred'], newPref);
                  setShowEvidenceModal(false);
                }} 
                style={{ padding: '0.6rem 1.25rem', borderRadius: '8px', border: 'none', background: '#C9A227', color: 'white', fontWeight: 600, cursor: !newEvidenceName.trim() ? 'default' : 'pointer', opacity: !newEvidenceName.trim() ? 0.6 : 1 }}
              >
                Add Evidence
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Playbook Dry-Run Simulator Modal */}
      {showSimulatorModal && playbookData && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0, 0, 0, 0.8)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div style={{ background: '#1A1E27', border: '1px solid rgba(169, 135, 31, 0.35)', borderRadius: '16px', padding: '2rem', width: '100%', maxWidth: '680px', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 25px 50px -12px rgba(169, 135, 31, 0.3)', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <div style={{ background: 'rgba(169, 135, 31, 0.2)', padding: '0.6rem', borderRadius: '12px', color: '#D9B84A' }}>
                  <Play size={24} />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.25rem', color: '#f8fafc' }}>AI Playbook Audit Simulator</h3>
                  <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    Test how rules in '{playbookData.metadata?.title || playbookData.playbook_id}' audit real client profiles.
                  </p>
                </div>
              </div>
              <button onClick={() => setShowSimulatorModal(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={18} /></button>
            </div>

            {/* Client Profile Presets */}
            <div style={{ background: 'rgba(0,0,0,0.2)', padding: '1.25rem', borderRadius: '12px', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#D9B84A' }}>1. Select a Sample Client Profile:</span>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
                <button
                  onClick={() => {
                    setSimDegree('phd');
                    setSimCitations(450);
                  }}
                  style={{ padding: '0.6rem', borderRadius: '8px', border: `1px solid ${simDegree === 'phd' ? '#A9871F' : 'var(--border-color)'}`, background: simDegree === 'phd' ? 'rgba(169,135,31,0.15)' : '#12151C', color: '#f8fafc', fontSize: '0.8rem', textAlign: 'left', cursor: 'pointer' }}
                >
                  <div style={{ fontWeight: 'bold', color: '#D9B84A' }}>👨‍🔬 Star Researcher</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>PhD Degree • 450 Citations • 8 Patents</div>
                </button>

                <button
                  onClick={() => {
                    setSimDegree('bachelors');
                    setSimCitations(2);
                  }}
                  style={{ padding: '0.6rem', borderRadius: '8px', border: `1px solid ${simDegree === 'bachelors' ? '#A9871F' : 'var(--border-color)'}`, background: simDegree === 'bachelors' ? 'rgba(169,135,31,0.15)' : '#12151C', color: '#f8fafc', fontSize: '0.8rem', textAlign: 'left', cursor: 'pointer' }}
                >
                  <div style={{ fontWeight: 'bold', color: '#BD7B2C' }}>💼 Junior Engineer</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>Bachelor's Only • 2 Citations • No Degree Eval</div>
                </button>

                <button
                  onClick={() => {
                    setSimDegree('none');
                    setSimCitations(0);
                  }}
                  style={{ padding: '0.6rem', borderRadius: '8px', border: `1px solid ${simDegree === 'none' ? '#A9871F' : 'var(--border-color)'}`, background: simDegree === 'none' ? 'rgba(169,135,31,0.15)' : '#12151C', color: '#f8fafc', fontSize: '0.8rem', textAlign: 'left', cursor: 'pointer' }}
                >
                  <div style={{ fontWeight: 'bold', color: '#A23C3C' }}>🎨 Non-Degree Applicant</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>No Degree • High Salary • 10 Industry Awards</div>
                </button>
              </div>
            </div>

            {/* Run Real-Time AI Simulation */}
            <button
              disabled={isCopilotLoading}
              onClick={async () => {
                setIsCopilotLoading(true);
                try {
                  const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
                  const res = await fetch(`${baseUrl}/api/playbook/simulate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      playbook: playbookData,
                      sampleFacts: {
                        highest_degree: simDegree === 'phd' ? "Doctor of Philosophy (PhD) in Computer Science" : (simDegree === 'bachelors' ? "Bachelor of Science (B.S.)" : "High School Diploma Only"),
                        google_citations: simCitations,
                        peer_reviewed_papers: simCitations > 100 ? 14 : 1,
                        patents_granted: simDegree === 'phd' ? 8 : 0,
                        annual_compensation: simDegree === 'none' ? "$320,000 USD" : "$140,000 USD"
                      }
                    })
                  });
                  const data = await res.json();
                  setSimResult({
                    triggeredFlags: data.triggered_flags || [],
                    evidenceCount: data.evidence_passed?.length || 0,
                    passedCategories: data.evidence_passed || [],
                    petitionPreview: data.petition_draft_preview || ''
                  });
                } catch (err) {
                  console.error(err);
                } finally {
                  setIsCopilotLoading(false);
                }
              }}
              style={{ width: '100%', padding: '0.85rem', borderRadius: '10px', border: 'none', background: 'linear-gradient(90deg, #8a6d1a, #C9A227)', color: 'white', fontWeight: 600, fontSize: '0.95rem', cursor: isCopilotLoading ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', boxShadow: '0 4px 14px 0 rgba(147, 51, 234, 0.39)' }}
            >
              {isCopilotLoading ? <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={18} />}
              {isCopilotLoading ? '✨ Gemini AI Auditing Case & Draft Preview...' : 'Run Real-Time AI Playbook Audit'}
            </button>

            {/* Simulation Results & Petition Preview */}
            {simResult && (
              <div style={{ background: '#12151C', padding: '1.25rem', borderRadius: '12px', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 'bold', color: '#f8fafc', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>🎯 AI Audit Diagnostic Results:</span>
                  <span style={{ color: '#7E9A6D', fontSize: '0.85rem' }}>✓ {simResult.evidenceCount} Categories Qualified</span>
                </div>

                {/* Risk Flags Section */}
                <div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', fontWeight: 600 }}>1. Audited Risk Flags:</div>
                  {simResult.triggeredFlags.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {simResult.triggeredFlags.map((tf: any, i: number) => (
                        <div key={i} style={{ background: tf.severity === 'critical' ? 'rgba(162,60,60,0.15)' : 'rgba(189,123,44,0.15)', border: `1px solid ${tf.severity === 'critical' ? '#A23C3C' : '#BD7B2C'}`, padding: '0.6rem 0.8rem', borderRadius: '8px', color: tf.severity === 'critical' ? '#D9A3A3' : '#E0B96A', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <AlertTriangle size={16} />
                          <div>
                            <strong>[{tf.severity?.toUpperCase() || 'RISK'}]</strong> {tf.rule || tf.description || 'Risk threshold identified'}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ background: 'rgba(126, 154, 109, 0.15)', border: '1px solid #7E9A6D', padding: '0.75rem', borderRadius: '8px', color: '#9DBB8A', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <ShieldCheck size={18} /> No Risk Flags Triggered! Case satisfies all Playbook criteria.
                    </div>
                  )}
                </div>

                {/* Generated Petition Excerpt */}
                {(simResult as any).petitionPreview && (
                  <div>
                    <div style={{ fontSize: '0.8rem', color: '#D9B84A', marginBottom: '0.5rem', fontWeight: 600 }}>2. Live Auto-Generated Petition Excerpt:</div>
                    <div style={{ background: 'rgba(0,0,0,0.3)', padding: '1rem', borderRadius: '8px', border: '1px solid rgba(169, 135, 31, 0.3)', color: '#e2e8f0', fontSize: '0.85rem', fontFamily: 'monospace', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                      {(simResult as any).petitionPreview}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

        </div>
      </div>
    </div>
  );
}
