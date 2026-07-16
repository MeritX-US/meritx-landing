import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize Gemini (will pass the instance or use env)
let genAI: GoogleGenerativeAI | null = null;

export interface PlaybookAnalysis {
  playbookName: string;
  scenario: string;
  scenarioLabel: string;
  completeness: {
    overall: number;
    dimensions: Record<string, number>;
    penaltiesApplied: number;
  };
  facts: Record<string, {
    value: any;
    confidence: 'high' | 'medium' | 'low';
    source: string;
  }>;
  documents: Array<{
    id: string;
    label: string;
    category: string;
    status: 'provided' | 'missing' | 'needs_supplementation';
    fileName?: string;
    source?: string;
  }>;
  evidence: Array<{
    category: string;
    type: string;
    fileName: string;
    strength: 'high' | 'medium' | 'low';
  }>;
  riskFlags: Array<{
    id: string;
    label: string;
    severity: 'info' | 'high' | 'critical';
    action: string;
    message: string;
    source: string;
  }>;
  followUpQuestions: Array<{
    id: string;
    label: string;
    priority: number;
  }>;
  uscisFormMapping: {
    'I-130': Record<string, string>;
    'I-485': Record<string, string>;
    'I-140'?: Record<string, string>;
  };
  coverLetterDraft: string;
}

export function loadPlaybook(caseType: string = 'unknown'): any {
  let fileName = 'general_intake_v1.json';
  if (caseType === 'eb1a') {
    fileName = 'eb1a_v1.json';
  } else if (caseType === 'marriage_green_card') {
    fileName = 'marriage_gc_v1.json';
  }
  const filePath = path.join(__dirname, `playbooks/${fileName}`);
  if (!fs.existsSync(filePath)) {
    throw new Error('Playbook file not found at: ' + filePath);
  }
  const data = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(data);
}

export async function runPlaybookAnalysis(
  recordText: string,
  mediaParts: any[],
  existingItems: any[] = [],
  providedCaseType?: string
): Promise<{ analysis: PlaybookAnalysis, caseType: string }> {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      genAI = new GoogleGenerativeAI(apiKey);
    } else {
      throw new Error('Gemini API key is not initialized in the playbook engine.');
    }
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash"
  });

  let caseType = providedCaseType;
  if (!caseType) {
    // Detect case type
    const detectPrompt = `Analyze the following case materials and determine if it is a 'marriage_green_card' case or an 'eb1a' case.
If there is not enough context to determine the case type, you MUST default to 'unknown'.
Return EXACTLY the string 'eb1a', 'marriage_green_card', or 'unknown' and nothing else.
Files: ${JSON.stringify(existingItems.map(i => i.name))}
Transcript: ${recordText.substring(0, 1500)}`;
    const result = await model.generateContent(detectPrompt);
    const text = result.response.text().toLowerCase().trim();
    caseType = text === 'eb1a' ? 'eb1a' : (text === 'marriage_green_card' ? 'marriage_green_card' : 'unknown');
    console.log(`Detected Case Type: ${caseType} (Model returned: ${text})`);
  }

  const playbook = loadPlaybook(caseType);

  const jsonModel = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      responseMimeType: "application/json"
    }
  });

  // Prepare required facts schema
  const factsSchema = playbook.required_facts.map((f: any) => ({
    id: f.id,
    label: f.label,
    type: f.type,
    values: f.values || null
  }));

  const docSchema: string[] = [];
  for (const [cat, docs] of Object.entries(playbook.required_documents)) {
    (docs as any[]).forEach((d: any) => docSchema.push(`- "${d.id}" (${d.label})`));
  }

  const evidenceSchema: string[] = [];
  for (const [cat, ev] of Object.entries(playbook.evidence_map)) {
    let pref = '';
    if ((ev as any).preferred) {
      pref = (ev as any).preferred.map((p: any) => p.id).join(', ');
    } else if ((ev as any).requires_all) {
      pref = (ev as any).requires_all.join(', ');
    }
    evidenceSchema.push(`- "${cat}" (${(ev as any).label})${pref ? `: Examples include ${pref}` : ''}`);
  }

  const allForms = new Set<string>();
  Object.values(playbook.scenarios).forEach((scn: any) => {
    (scn.forms || []).forEach((f: string) => allForms.add(f));
  });
  const formMappingTemplate: Record<string, any> = {};
  allForms.forEach(f => {
    if (f.startsWith('I-') || f.startsWith('DS-') || f.startsWith('ETA-')) {
      formMappingTemplate[f] = {};
    }
  });
  const formMappingJsonStr = JSON.stringify(formMappingTemplate, null, 4);

  // Compile the prompt for LLM fact extraction and classification
  const prompt = `You are an expert legal case classifier and document analyst for an immigration law firm.
Your task is to analyze the provided consultation transcript and case files.
You must extract case facts, classify the uploaded files, and perform mapping to legal criteria as defined in the playbook.

Provided Case Materials:
--- TRANSCRIPT START ---
${recordText}
--- TRANSCRIPT END ---
Total Files in Matter: ${JSON.stringify(existingItems.map(i => ({ name: i.name, type: i.type, url: i.url })))}

CRITICAL RULES:
- ONLY extract facts explicitly stated in the materials. DO NOT hallucinate names, nationalities, or dates.
- For self-petitioned cases (e.g. EB-1A), the petitioner and beneficiary are often the same person. Do not invent a separate petitioner entity unless one explicitly exists in the materials.

Instructions:
1. Extract values for each of the following required facts.
${JSON.stringify(factsSchema, null, 2)}
For each fact, output:
- "value": The extracted value matching the type (string, number, boolean, array, or object) or null if not found.
- "confidence": "high", "medium", or "low".
- "source": A text description indicating where you found it (e.g. "Transcript at 04:25: '...'" or "File Sarah_Passport.pdf Page 1").

2. Map each file in the Matter (by its name) to one of these required document types if applicable:
${docSchema.join('\n')}

3. Identify and classify files that serve as evidence categories. Specifically:
${evidenceSchema.join('\n')}
For each matched evidence item, specify:
- "category": the category id (e.g. "bona_fide_marriage", "eb1a_criteria")
- "type": the specific sub-type from the examples
- "file_name": name of the file
- "strength": "high", "medium", or "low" based on the playbook guidelines.

4. Check for timeline conflicts (e.g. different move-in dates on different docs, or marriage date conflicts).
- "timeline_conflict_detected": true/false
- "timeline_conflict_details": A description of the conflict or null.

5. Map extracted facts to relevant forms:
- "uscis_form_mapping": ${formMappingJsonStr}

6. Draft the Attorney Cover Letter in Markdown format:
${playbook.cover_letter_template ? `Use the following structure and template as a strict guide for drafting the cover letter:\n\n${playbook.cover_letter_template}\n\nReplace bracketed placeholders with actual extracted facts. DO NOT include boilerplate warnings or instructions from the template, just output the final drafted letter.` : `Include an Introduction, Factual Background, Eligibility Analysis matching the scenario, and an Exhibit List referencing the classified files.`}

You must return a valid JSON object matching the following structure:
{
  "facts": {
    "fact_id": { "value": "any", "confidence": "high | medium | low", "source": "string" }
  },
  "document_classifications": [
    { "doc_type_id": "string", "file_name": "string", "status": "provided | needs_supplementation", "source": "string" }
  ],
  "evidence_mappings": [
    { "category": "string", "type": "string", "file_name": "string", "strength": "high | medium | low" }
  ],
  "timeline_conflict_detected": false,
  "timeline_conflict_details": null,
  "uscis_form_mapping": ${formMappingJsonStr},
  "cover_letter_draft": "string"
}
`;

  const response = await jsonModel.generateContent([prompt, ...mediaParts]);
  const responseText = response.response.text();

  let data: any;
  try {
    data = JSON.parse(responseText);
  } catch (err) {
    console.error('Failed to parse Gemini json output:', responseText);
    throw new Error('Invalid JSON format returned by Gemini.');
  }

  // --- Layer B: Deterministic Validation (Code Layer) ---

  const extractedFacts = data.facts || {};
  
  // 1. Resolve Scenario Dynamically
  let scenario = Object.keys(playbook.scenarios)[0]; // fallback to first
  for (const [key, scn] of Object.entries(playbook.scenarios)) {
    const resolver = (scn as any).resolve_when;
    if (resolver) {
      let matches = true;
      for (const [rFact, rVal] of Object.entries(resolver)) {
        if (extractedFacts[rFact]?.value !== rVal) {
          matches = false;
          break;
        }
      }
      if (matches) {
        scenario = key;
        break;
      }
    }
  }

  const scenarioConfig = playbook.scenarios[scenario];
  const scenarioLabel = scenarioConfig.label;

  // 2. Identify missing facts and populate follow-up questions
  const followUpQuestions: any[] = [];
  playbook.required_facts.forEach((fact: any) => {
    if (fact.applies_to.includes(scenario)) {
      const isMissing = !extractedFacts[fact.id] || extractedFacts[fact.id].value === null || extractedFacts[fact.id].value === undefined || extractedFacts[fact.id].value === '';
      if (isMissing) {
        followUpQuestions.push({
          id: fact.id,
          label: fact.label,
          priority: fact.priority
        });
      }
    }
  });
  followUpQuestions.sort((a, b) => a.priority - b.priority);

  // 3. Document checklist verification
  const documents: any[] = [];
  const classifiedDocs = data.document_classifications || [];

  Object.keys(playbook.required_documents).forEach((category) => {
    const list = playbook.required_documents[category];
    list.forEach((doc: any) => {
      if (doc.applies_to.includes(scenario)) {
        let isRequired = doc.required;
        if (doc.conditional) {
          if (doc.condition_fact === 'prior_marriages.count_gt_0') {
            const pm = extractedFacts.prior_marriages?.value;
            const count = typeof pm === 'number' ? pm : (pm && pm.count ? parseInt(pm.count) : 0);
            isRequired = count > 0;
          }
        }
        if (isRequired) {
          const matched = classifiedDocs.find((d: any) => d.doc_type_id === doc.id);
          documents.push({
            id: doc.id,
            label: doc.label,
            category: category,
            status: matched ? matched.status || 'provided' : 'missing',
            fileName: matched ? matched.file_name : undefined,
            source: matched ? matched.source : undefined
          });
        }
      }
    });
  });

  // 4. Evidence count checking
  const evidence = data.evidence_mappings || [];
  const evidenceCounts: Record<string, number> = {};
  evidence.forEach((e: any) => {
    evidenceCounts[e.category] = (evidenceCounts[e.category] || 0) + 1;
  });

  // 5. Evaluate escalation flags dynamically
  const riskFlags: any[] = [];
  playbook.escalation_flags.forEach((flag: any) => {
    let triggered = false;
    let sourceText = 'Rule evaluation';

    if (flag.trigger) {
      if (flag.trigger.evidence_category) {
        const count = evidenceCounts[flag.trigger.evidence_category] || 0;
        const minItems = playbook.evidence_map[flag.trigger.evidence_category]?.min_items || 1;
        if (flag.trigger.condition === 'count_lt_min_items' && count < minItems) {
          triggered = true;
          sourceText = `Only ${count} of ${minItems} minimum items provided for ${flag.trigger.evidence_category}.`;
        }
      } else if (flag.trigger.fact) {
        const factVal = extractedFacts[flag.trigger.fact]?.value;
        if (flag.trigger.condition === 'is_present') {
          const present = factVal === true || (typeof factVal === 'string' && factVal.toLowerCase() !== 'none' && factVal.toLowerCase() !== 'no');
          if (present) { triggered = true; sourceText = extractedFacts[flag.trigger.fact]?.source || 'Extracted from transcript.'; }
        } else if (flag.trigger.condition === 'any_adverse_present') {
          const present = factVal === true || (typeof factVal === 'string' && factVal.toLowerCase() !== 'none' && factVal.toLowerCase() !== 'no');
          if (present) { triggered = true; sourceText = extractedFacts[flag.trigger.fact]?.source || 'Adverse history found.'; }
        } else if (flag.trigger.condition === 'is_false') {
          if (factVal === false) {
            if (!flag.trigger.and_scenario_in || flag.trigger.and_scenario_in.includes(scenario)) {
               triggered = true; sourceText = extractedFacts[flag.trigger.fact]?.source || 'Condition evaluates to false.';
            }
          }
        }
      }
    }

    if (triggered) {
      riskFlags.push({
        id: flag.id,
        label: flag.label,
        severity: flag.severity,
        action: flag.action,
        message: flag.message,
        source: sourceText
      });
    }
  });

  // 6. Completeness Scoring Calculation (Dynamic from JSON)
  const dimensionScores: Record<string, number> = {};
  let rawScore = 0;

  playbook.scoring.dimensions.forEach((dim: any) => {
    let dimScore = 0;
    dim.components.forEach((comp: any) => {
      let compScore = 0;
      if (comp.type === 'facts_present') {
        const present = comp.facts.filter((f: string) => extractedFacts[f] && extractedFacts[f].value !== null && extractedFacts[f].value !== '').length;
        compScore = comp.facts.length > 0 ? present / comp.facts.length : 0;
      } else if (comp.type === 'documents_present') {
        const present = comp.docs.filter((d: string) => documents.find(doc => doc.id === d && doc.status === 'provided')).length;
        compScore = comp.docs.length > 0 ? present / comp.docs.length : 0;
      } else if (comp.type === 'evidence_threshold') {
        const count = evidenceCounts[comp.category] || 0;
        const min = playbook.evidence_map[comp.category]?.min_items || 1;
        compScore = Math.min(count / min, 1.0);
      }
      dimScore += compScore * comp.share;
    });
    
    dimensionScores[dim.id] = Math.round(dimScore * 100);
    rawScore += dimScore * 100 * dim.weight;
  });

  // Calculate penalties from active flags
  let penaltiesApplied = 0;
  riskFlags.forEach((flag) => {
    const penaltyDef = playbook.scoring.penalties.find((p: any) => p.flag === flag.id);
    if (penaltyDef) {
      penaltiesApplied += penaltyDef.deduct;
    }
  });

  const overallScore = Math.max(0, Math.min(100, Math.round(rawScore - penaltiesApplied)));

  return {
    caseType: caseType,
    analysis: {
      playbookName: playbook.description || 'Intake Playbook',
      scenario,
      scenarioLabel,
      completeness: {
        overall: overallScore,
        dimensions: dimensionScores,
        penaltiesApplied
      },
      facts: extractedFacts,
      documents,
      evidence,
      riskFlags,
      followUpQuestions,
      uscisFormMapping: data.uscis_form_mapping || formMappingTemplate,
      coverLetterDraft: data.cover_letter_draft || ''
    }
  };
}
