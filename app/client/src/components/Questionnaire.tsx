import React, { useState, useEffect } from 'react';
import { Save, CheckCircle, ChevronRight, ChevronLeft, Check } from 'lucide-react';
import pbEb1a from '../data/playbook_eb1a.json';
import pbNiw from '../data/playbook_niw.json';
import pbO1 from '../data/playbook_o1.json';
import pbMarriage from '../data/playbook_marriage.json';

const playbooksMap: Record<string, any> = {
  'pb_eb1a_001': pbEb1a,
  'pb_niw_001': pbNiw,
  'pb_o1_001': pbO1,
  'pb_marriage_001': pbMarriage
};

interface PlaybookQuestion {
  id: string;
  type: 'text' | 'date' | 'select' | 'boolean' | 'number' | 'textarea';
  label: string;
  options?: string[];
  required: boolean;
  condition?: {
    dependsOn: string;
    expectedValue: any;
  };
}

interface PlaybookCategory {
  id: string;
  title: string;
  order: number;
  questions: PlaybookQuestion[];
}

interface Playbook {
  id: string;
  name: string;
  version: string;
  description: string;
  categories: PlaybookCategory[];
}

interface QuestionnaireProps {
  initialRecord?: any;
  onSaveComplete?: () => void;
}

const Questionnaire: React.FC<QuestionnaireProps> = ({ initialRecord, onSaveComplete }) => {
  const [selectedPlaybookId, setSelectedPlaybookId] = useState<string | null>(null);
  const [playbook, setPlaybook] = useState<Playbook | null>(null);
  const [activeCategoryIndex, setActiveCategoryIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Record<string, any>>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    if (initialRecord && initialRecord.playbookId) {
      setSelectedPlaybookId(initialRecord.playbookId);
    }
  }, [initialRecord]);

  useEffect(() => {
    if (selectedPlaybookId) {
      const loadedPlaybook = playbooksMap[selectedPlaybookId] as Playbook;
      setPlaybook(loadedPlaybook);
      
      if (initialRecord && initialRecord.answers && initialRecord.playbookId === selectedPlaybookId) {
        setAnswers(initialRecord.answers);
      } else {
        const initialAnswers: Record<string, Record<string, any>> = {};
        loadedPlaybook.categories.forEach(cat => {
          initialAnswers[cat.id] = {};
        });
        setAnswers(initialAnswers);
      }
    }
  }, [selectedPlaybookId, initialRecord]);

  if (!selectedPlaybookId) {
    return (
      <div className="glass-card" style={{ 
        display: 'flex', flexDirection: 'column', height: '100%', 
        borderRadius: '16px', overflow: 'hidden', border: '1px solid var(--border-color)',
        background: 'var(--bg-card)', padding: '3rem'
      }}>
        <h2 style={{ fontSize: '1.8rem', fontWeight: 'bold', marginBottom: '2rem', textAlign: 'center', background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          Select Intake Type (选择案件类型)
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1.5rem', overflowY: 'auto' }}>
          {Object.values(playbooksMap).map((pb: any) => (
            <div 
              key={pb.id}
              onClick={() => setSelectedPlaybookId(pb.id)}
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid var(--border-color)',
                borderRadius: '12px',
                padding: '1.5rem',
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                flexDirection: 'column'
              }}
              onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent-primary)'}
              onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-color)'}
            >
              <h3 style={{ fontSize: '1.2rem', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{pb.name}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', flex: 1 }}>{pb.description}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!playbook) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading playbook...</div>;
  }

  const activeCategory = playbook.categories[activeCategoryIndex];

  const handleAnswerChange = (categoryId: string, questionId: string, value: any) => {
    setAnswers(prev => ({
      ...prev,
      [categoryId]: {
        ...prev[categoryId],
        [questionId]: value
      }
    }));
  };

  const checkCondition = (condition?: { dependsOn: string; expectedValue: any }, categoryId?: string) => {
    if (!condition || !categoryId) return true;
    const { dependsOn, expectedValue } = condition;
    return answers[categoryId]?.[dependsOn] === expectedValue;
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const url = initialRecord?.id 
        ? `${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/records/questionnaire/${initialRecord.id}`
        : `${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/records/questionnaire`;
      
      const method = initialRecord?.id ? 'PUT' : 'POST';
      
      const payload = {
        playbookId: playbook?.id,
        playbookName: playbook?.name,
        answers
      };

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        setSaveSuccess(true);
        setTimeout(() => {
          setSaveSuccess(false);
          if (onSaveComplete) onSaveComplete();
        }, 1500);
      } else {
        console.error('Failed to save questionnaire');
      }
    } catch (err) {
      console.error('Network error saving questionnaire:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const isLastCategory = activeCategoryIndex === playbook.categories.length - 1;

  return (
    <div className="glass-card" style={{ 
      display: 'flex', 
      flexDirection: 'column', 
      height: '100%', 
      borderRadius: '16px', 
      overflow: 'hidden',
      border: '1px solid var(--border-color)',
      background: 'var(--bg-card)',
      boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
    }}>
      {/* Header */}
      <div style={{ padding: '2rem', borderBottom: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.2)' }}>
        <h2 style={{ fontSize: '1.8rem', fontWeight: 'bold', margin: '0 0 0.5rem 0', background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          {playbook.name}
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', margin: 0 }}>{playbook.description}</p>
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Sidebar */}
        <div style={{ 
          width: '280px', 
          borderRight: '1px solid var(--border-color)', 
          overflowY: 'auto',
          background: 'rgba(0,0,0,0.1)' 
        }}>
          <ul style={{ listStyle: 'none', padding: '1rem 0', margin: 0 }}>
            {playbook.categories.map((cat, index) => {
              const isActive = activeCategoryIndex === index;
              return (
                <li key={cat.id} style={{ margin: '0 0.5rem 0.5rem 0.5rem' }}>
                  <button
                    onClick={() => setActiveCategoryIndex(index)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '1rem',
                      borderRadius: '12px',
                      background: isActive ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                      border: `1px solid ${isActive ? 'rgba(59, 130, 246, 0.3)' : 'transparent'}`,
                      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontWeight: isActive ? 600 : 400,
                      transition: 'all 0.2s ease',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between'
                    }}
                  >
                    <span>{cat.order}. {cat.title}</span>
                    {isActive && <ChevronRight size={16} color="var(--accent-primary)" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '3rem' }}>
            <h3 style={{ fontSize: '1.5rem', marginBottom: '2rem', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
              {activeCategory.title}
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
              {activeCategory.questions.map(q => {
                if (!checkCondition(q.condition, activeCategory.id)) return null;

                const inputStyle = {
                  width: '100%',
                  padding: '1rem',
                  borderRadius: '12px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  fontSize: '1rem',
                  fontFamily: 'inherit',
                  outline: 'none',
                  transition: 'all 0.2s ease',
                  marginTop: '0.5rem'
                };

                return (
                  <div key={q.id} style={{ display: 'flex', flexDirection: 'column' }}>
                    <label style={{ fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                      {q.label} {q.required && <span style={{ color: 'var(--danger)' }}>*</span>}
                    </label>

                    {(q.type === 'text' || q.type === 'number' || q.type === 'date') && (
                      <input
                        type={q.type}
                        style={inputStyle}
                        value={answers[activeCategory.id]?.[q.id] || ''}
                        onChange={e => handleAnswerChange(activeCategory.id, q.id, q.type === 'number' ? parseInt(e.target.value) : e.target.value)}
                        onFocus={e => (e.target.style.borderColor = 'var(--accent-primary)')}
                        onBlur={e => (e.target.style.borderColor = 'var(--border-color)')}
                      />
                    )}

                    {q.type === 'select' && (
                      <select
                        style={{ ...inputStyle, appearance: 'none', cursor: 'pointer' }}
                        value={answers[activeCategory.id]?.[q.id] || ''}
                        onChange={e => handleAnswerChange(activeCategory.id, q.id, e.target.value)}
                        onFocus={e => (e.target.style.borderColor = 'var(--accent-primary)')}
                        onBlur={e => (e.target.style.borderColor = 'var(--border-color)')}
                      >
                        <option value="" disabled>Select an option...</option>
                        {q.options?.map(opt => (
                          <option key={opt} value={opt} style={{ background: 'var(--bg-dark)' }}>{opt}</option>
                        ))}
                      </select>
                    )}

                    {q.type === 'boolean' && (
                      <div style={{ display: 'flex', gap: '2rem', marginTop: '1rem' }}>
                        {[true, false].map((val) => {
                          const isSelected = answers[activeCategory.id]?.[q.id] === val;
                          return (
                            <label 
                              key={val.toString()} 
                              onClick={() => handleAnswerChange(activeCategory.id, q.id, val)}
                              style={{
                                display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer',
                                padding: '0.75rem 1.5rem', borderRadius: '8px',
                                background: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'rgba(255,255,255,0.03)',
                                border: `1px solid ${isSelected ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                                transition: 'all 0.2s ease'
                              }}
                            >
                              <div style={{
                                width: '18px', height: '18px', borderRadius: '50%',
                                border: `2px solid ${isSelected ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                                display: 'flex', alignItems: 'center', justifyContent: 'center'
                              }}>
                                {isSelected && <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--accent-primary)' }} />}
                              </div>
                              <span style={{ color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                                {val ? 'Yes (是)' : 'No (否)'}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}

                    {q.type === 'textarea' && (
                      <textarea
                        rows={5}
                        style={{ ...inputStyle, resize: 'vertical' }}
                        value={answers[activeCategory.id]?.[q.id] || ''}
                        onChange={e => handleAnswerChange(activeCategory.id, q.id, e.target.value)}
                        onFocus={e => (e.target.style.borderColor = 'var(--accent-primary)')}
                        onBlur={e => (e.target.style.borderColor = 'var(--border-color)')}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          
          {/* Action Bar */}
          <div style={{ 
            padding: '1.5rem 2rem', 
            borderTop: '1px solid var(--border-color)', 
            background: 'rgba(0,0,0,0.2)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <button
              onClick={() => setActiveCategoryIndex(Math.max(0, activeCategoryIndex - 1))}
              disabled={activeCategoryIndex === 0}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.75rem 1.25rem', borderRadius: '8px',
                background: 'rgba(255,255,255,0.05)',
                color: activeCategoryIndex === 0 ? 'rgba(255,255,255,0.2)' : 'var(--text-primary)',
                cursor: activeCategoryIndex === 0 ? 'not-allowed' : 'pointer',
                border: '1px solid var(--border-color)'
              }}
            >
              <ChevronLeft size={18} /> Previous
            </button>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {saveSuccess && (
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--success)', fontSize: '0.9rem' }}>
                  <CheckCircle size={16} /> Saved Successfully
                </span>
              )}
              
              <button
                onClick={handleSave}
                disabled={isSaving}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  padding: '0.75rem 1.5rem', borderRadius: '8px',
                  background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)', cursor: isSaving ? 'wait' : 'pointer',
                  transition: 'background 0.2s'
                }}
              >
                <Save size={18} /> {isSaving ? 'Saving...' : 'Save Progress'}
              </button>

              {!isLastCategory && (
                <button
                  onClick={() => setActiveCategoryIndex(Math.min(playbook.categories.length - 1, activeCategoryIndex + 1))}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.75rem 1.5rem', borderRadius: '8px',
                    background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                    color: 'white', border: 'none', cursor: 'pointer',
                    fontWeight: 500, boxShadow: '0 4px 14px rgba(59, 130, 246, 0.4)'
                  }}
                >
                  Next <ChevronRight size={18} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Questionnaire;
