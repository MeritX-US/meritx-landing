import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize Gemini (will pass the instance or use env)
let genAI: GoogleGenerativeAI | null = null;

export interface PlaybookAnalysis {
  playbookName: string;
  scenario: string;
  scenarioLabel: string;
  scores?: {
    intakeCompleteness?: { score: number; reasoning?: string };
    documentCompleteness?: { score: number; reasoning?: string };
    evidenceSufficiency?: { score: number; reasoning?: string };
    criterionCoverage?: { score: number; reasoning?: string };
    finalMeritsStrength?: { score: number; reasoning?: string };
    filingReadiness?: { score: number; reasoning?: string };
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

7. Calculate 6 specific Case Readiness Dimensions (0-100 scale) based on the provided materials and legal standards:
- intakeCompleteness: Are personal, immigration, and professional history facts collected?
- documentCompleteness: Are the core documents and translations provided?
- evidenceSufficiency: Is the evidence strong enough to prove the legal elements?
- criterionCoverage: How many of the 10 criteria are met?
- finalMeritsStrength: Does the evidence demonstrate sustained acclaim and top-of-field standing?
- filingReadiness: Overall readiness combining the above.

7. Generate specific Follow-Up Questions (Refinement Questions) for missing or weak evidence. 
${playbook.refinement_guidelines ? `Use the following guidelines to formulate targeted, professional questions to the client:\n\n${playbook.refinement_guidelines}` : `Ask questions for any missing documents or unclear facts.`}

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
  "scores": {
    "intakeCompleteness": { "score": 0, "reasoning": "string" },
    "documentCompleteness": { "score": 0, "reasoning": "string" },
    "evidenceSufficiency": { "score": 0, "reasoning": "string" },
    "criterionCoverage": { "score": 0, "reasoning": "string" },
    "finalMeritsStrength": { "score": 0, "reasoning": "string" },
    "filingReadiness": { "score": 0, "reasoning": "string" }
  },
  "refinement_questions": [
    { "question": "string", "reason": "string", "priority": "Critical | High | Medium | Low" }
  ]
}
`;

  const response = await jsonModel.generateContent([prompt, ...mediaParts]);
  const responseText = response.response.text();
  
  if (response.response.candidates && response.response.candidates[0].finishReason) {
    console.log('Gemini finishReason:', response.response.candidates[0].finishReason);
  }

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
          const isStr = typeof factVal === 'string';
          const lowerVal = isStr ? factVal.toLowerCase() : '';
          const present = factVal === true || (isStr && lowerVal !== 'none' && lowerVal !== 'no' && lowerVal !== 'false' && !lowerVal.includes("marked 'no'") && !lowerVal.includes("marked \"no\"") && !lowerVal.includes("no adverse"));
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
        source: sourceText,
        factValue: flag.trigger?.fact ? extractedFacts[flag.trigger.fact]?.value : undefined
      });
    }
  });

  // 6. Completeness Scoring Calculation (AI-driven 6 Dimensions)
  const scores = data.scores || {
    intakeCompleteness: { score: 0, reasoning: "Not provided" },
    documentCompleteness: { score: 0, reasoning: "Not provided" },
    evidenceSufficiency: { score: 0, reasoning: "Not provided" },
    criterionCoverage: { score: 0, reasoning: "Not provided" },
    finalMeritsStrength: { score: 0, reasoning: "Not provided" },
    filingReadiness: { score: 0, reasoning: "Not provided" }
  };

  // Append AI-generated refinement questions
  if (data.refinement_questions && Array.isArray(data.refinement_questions)) {
    data.refinement_questions.forEach((q: any) => {
      followUpQuestions.push({
        id: `refinement_${Math.random().toString(36).substring(7)}`,
        label: `${q.priority ? '[' + q.priority + '] ' : ''}${q.question} (Reason: ${q.reason})`,
        priority: q.priority === 'Critical' ? 1 : q.priority === 'High' ? 2 : 3
      });
    });
  }

  // --- Stage 2: Cover Letter Drafting ---
  let coverLetterDraft = '';
  if (playbook.cover_letter_template) {
    try {
      console.log('Initiating Stage 2: Cover Letter Drafting...');
      const textModel = genAI!.getGenerativeModel({
        model: "gemini-2.5-flash"
      });
      const draftPrompt = `You are an expert immigration attorney. Draft the Attorney Cover Letter in Markdown format using the provided template and extracted facts.

TEMPLATE:
${playbook.cover_letter_template}

EXTRACTED FACTS:
${JSON.stringify(extractedFacts, null, 2)}

EVIDENCE MAPPINGS:
${JSON.stringify(evidence, null, 2)}

Replace bracketed placeholders with actual extracted facts. DO NOT include boilerplate warnings or instructions from the template, just output the final drafted letter.`;
      
      const draftResponse = await textModel.generateContent(draftPrompt);
      coverLetterDraft = draftResponse.response.text();
    } catch (err: any) {
      console.error('Failed to draft cover letter in Stage 2:', err.message);
      coverLetterDraft = "Error generating draft: " + err.message;
    }
  }

  return {
    caseType: caseType,
    analysis: {
      playbookName: playbook.description || 'Intake Playbook',
      scenario,
      scenarioLabel,
      scores, // The new 6 dimensions
      facts: extractedFacts,
      documents,
      evidence,
      riskFlags,
      followUpQuestions,
      uscisFormMapping: data.uscis_form_mapping || formMappingTemplate,
      coverLetterDraft: coverLetterDraft
    }
  };
}
