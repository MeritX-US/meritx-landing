import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize Gemini (will pass the instance or use env)
let genAI: GoogleGenerativeAI | null = null;

export interface PlaybookAnalysis {
  scenario: string;
  scenarioLabel: string;
  completeness: {
    overall: number;
    dimensions: {
      identity: number;
      bona_fide: number;
      financial: number;
      admissibility: number;
    };
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
  };
  coverLetterDraft: string;
}

export function loadPlaybook(): any {
  const filePath = path.join(__dirname, 'playbooks/marriage_gc_v1.json');
  if (!fs.existsSync(filePath)) {
    throw new Error('Playbook file not found at: ' + filePath);
  }
  const data = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(data);
}

export async function runPlaybookAnalysis(
  recordText: string,
  mediaParts: any[],
  existingItems: any[] = []
): Promise<PlaybookAnalysis> {
  const playbook = loadPlaybook();

  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      genAI = new GoogleGenerativeAI(apiKey);
    } else {
      throw new Error('Gemini API key is not initialized in the playbook engine.');
    }
  }

  const model = genAI.getGenerativeModel({
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

  // Compile the prompt for LLM fact extraction and classification
  const prompt = `You are an expert legal case classifier and document analyst for an immigration law firm.
Your task is to analyze the provided consultation transcript and case files.
You must extract case facts, classify the uploaded files, and perform mapping to legal criteria as defined in the playbook.

Provided Case Materials:
--- TRANSCRIPT START ---
${recordText}
--- TRANSCRIPT END ---
Total Files in Matter: ${JSON.stringify(existingItems.map(i => ({ name: i.name, type: i.type, url: i.url })))}

Instructions:
1. Extract values for each of the following required facts.
${JSON.stringify(factsSchema, null, 2)}
For each fact, output:
- "value": The extracted value matching the type (string, number, boolean, array, or object) or null if not found.
- "confidence": "high", "medium", or "low".
- "source": A text description indicating where you found it (e.g. "Transcript at 04:25: '...'" or "File Sarah_Passport.pdf Page 1").

2. Map each file in the Matter (by its name) to one of these required document types if applicable:
- "beneficiary_passport" (Beneficiary passport biographic page)
- "beneficiary_birth_certificate" (Beneficiary birth certificate)
- "petitioner_status_proof" (Petitioner U.S. passport or green card)
- "marriage_certificate" (Marriage certificate)
- "prior_divorce_or_death_certs" (Divorce decrees or death certificates for prior marriages)
- "i94_record" (I-94 entry record)
- "current_visa_or_status_doc" (Current visa/status document)
- "petitioner_tax_return_recent" (Federal tax return/transcript)
- "petitioner_w2_or_paystub" (W-2 or recent pay stubs)
- "petitioner_employment_letter" (Employment verification letter)
- "i693_medical" (I-693 medical exam)
- "panel_physician_medical" (Panel physician medical exam)
- "police_certificates" (Police certificates from countries of residence)

3. Identify and classify files that serve as evidence categories. Specifically:
- "bona_fide_marriage" (joint lease, joint bank statement, joint tax return, joint insurance policy, photos over time, family affidavits, joint travel records, utility bills)
- "cohabitation" (joint lease, joint utility bills, shared mail, drivers license with shared address)
For each matched evidence item, specify:
- "category": "bona_fide_marriage" or "cohabitation"
- "type": the specific sub-type (e.g., "joint_lease_or_mortgage", "shared_photos_over_time", "joint_bank_statement")
- "file_name": name of the file
- "strength": "high", "medium", or "low" based on the playbook guidelines.

4. Evaluate petitioner income:
- "petitioner_income_amount": Number (extracted annual income).
- "household_size": Number (extracted household size, default to 2 if not found).
Note: If petitioner_income_amount is less than $25,550 for a household of 2 (add $6,400 per additional person), set "below_125pct_poverty" to true.

5. Check for timeline conflicts (e.g. different move-in dates on different docs, or marriage date conflicts).
- "timeline_conflict_detected": true/false
- "timeline_conflict_details": A description of the conflict or null.

6. Map extracted facts to Form I-130 and I-485 fields:
- "uscis_form_mapping": {
    "I-130": { "petitioner_first_name": "...", "petitioner_last_name": "...", "petitioner_dob": "...", "beneficiary_first_name": "...", "beneficiary_last_name": "...", "beneficiary_dob": "...", "marriage_date": "...", "marriage_place": "..." },
    "I-485": { "beneficiary_first_name": "...", "beneficiary_last_name": "...", "beneficiary_dob": "...", "beneficiary_pob": "...", "beneficiary_citizenship": "...", "beneficiary_latest_entry_date": "...", "beneficiary_latest_entry_place": "...", "beneficiary_lawful_entry": "..." }
  }

7. Draft the Attorney Cover Letter in Markdown format:
Include an Introduction, Factual Background, Eligibility Analysis matching the scenario, and an Exhibit List referencing the classified files.

You must return a valid JSON object matching the following structure:
{
  "facts": {
    "fact_id": { "value": any, "confidence": "high" | "medium" | "low", "source": "string" }
  },
  "document_classifications": [
    { "doc_type_id": "string", "file_name": "string", "status": "provided" | "needs_supplementation", "source": "string" }
  ],
  "evidence_mappings": [
    { "category": "string", "type": "string", "file_name": "string", "strength": "high" | "medium" | "low" }
  ],
  "income_details": {
    "petitioner_income_amount": number,
    "household_size": number,
    "below_125pct_poverty": boolean
  },
  "timeline_conflict_detected": boolean,
  "timeline_conflict_details": string | null,
  "uscis_form_mapping": {
    "I-130": {},
    "I-485": {}
  },
  "cover_letter_draft": "string"
}
`;

  const response = await model.generateContent([prompt, ...mediaParts]);
  const responseText = response.response.text();

  let data: any;
  try {
    data = JSON.parse(responseText);
  } catch (err) {
    console.error('Failed to parse Gemini json output:', responseText);
    throw new Error('Invalid JSON format returned by Gemini.');
  }

  // --- Layer B: Deterministic Validation (Code Layer) ---

  // 1. Resolve Scenario
  const extractedFacts = data.facts || {};
  const petitionerStatus = extractedFacts.petitioner_immigration_status?.value || 'USC';
  const beneficiaryLoc = extractedFacts.beneficiary_location?.value || 'inside_us';
  const lawfulEntry = extractedFacts.beneficiary_lawful_entry?.value === true;

  let scenario = 'USC_AOS';
  if (petitionerStatus === 'LPR') {
    scenario = 'LPR_petitioner';
  } else if (beneficiaryLoc === 'abroad') {
    scenario = 'consular_DS260';
  } else if (petitionerStatus === 'USC' && beneficiaryLoc === 'inside_us' && lawfulEntry) {
    scenario = 'USC_AOS';
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

  // Group all possible required documents from playbook
  Object.keys(playbook.required_documents).forEach((category) => {
    const list = playbook.required_documents[category];
    list.forEach((doc: any) => {
      if (doc.applies_to.includes(scenario)) {
        // Evaluate condition if conditional
        let isRequired = doc.required;
        if (doc.conditional) {
          if (doc.condition_fact === 'prior_marriages.count_gt_0') {
            const pm = extractedFacts.prior_marriages?.value;
            const count = typeof pm === 'number' ? pm : (pm && pm.count ? parseInt(pm.count) : 0);
            isRequired = count > 0;
          } else if (doc.condition_fact === 'income_below_guideline') {
            isRequired = data.income_details?.below_125pct_poverty === true;
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
  const bonaFideCount = evidence.filter((e: any) => e.category === 'bona_fide_marriage').length;
  const cohabitationCount = evidence.filter((e: any) => e.category === 'cohabitation').length;

  // 5. Evaluate escalation flags
  const riskFlags: any[] = [];
  let bonaFideWeak = false;

  playbook.escalation_flags.forEach((flag: any) => {
    let triggered = false;
    let sourceText = 'Rule evaluation';

    if (flag.id === 'conditional_residence') {
      const marriageDateVal = extractedFacts.marriage_date?.value;
      if (marriageDateVal) {
        const mDate = new Date(marriageDateVal);
        const diffYears = (Date.now() - mDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
        if (diffYears < 2) {
          triggered = true;
          sourceText = `Extracted Marriage Date: ${marriageDateVal} (${diffYears.toFixed(1)} years duration)`;
        }
      }
    } else if (flag.id === 'bona_fide_weak') {
      if (bonaFideCount < playbook.evidence_map.bona_fide_marriage.min_items) {
        triggered = true;
        bonaFideWeak = true;
        sourceText = `Only ${bonaFideCount} of ${playbook.evidence_map.bona_fide_marriage.min_items} minimum bona fide marriage evidence items uploaded.`;
      }
    } else if (flag.id === 'timeline_conflict') {
      if (data.timeline_conflict_detected) {
        triggered = true;
        sourceText = data.timeline_conflict_details || 'Conflicts found in address history timelines.';
      }
    } else if (flag.id === 'criminal_risk') {
      const crim = extractedFacts.criminal_history?.value;
      const crimPresent = crim === true || (typeof crim === 'string' && crim.toLowerCase() !== 'none' && crim.toLowerCase() !== 'no');
      if (crimPresent) {
        triggered = true;
        sourceText = extractedFacts.criminal_history?.source || 'Criminal record indicated in interview.';
      }
    } else if (flag.id === 'immigration_risk') {
      const imm = extractedFacts.immigration_history?.value;
      const immPresent = imm === true || (typeof imm === 'string' && imm.toLowerCase() !== 'none' && imm.toLowerCase() !== 'no');
      if (immPresent) {
        triggered = true;
        sourceText = extractedFacts.immigration_history?.source || 'Adverse immigration history indicated in files.';
      }
    } else if (flag.id === 'unlawful_entry_aos_bar') {
      if (scenario === 'USC_AOS' && extractedFacts.beneficiary_lawful_entry?.value === false) {
        triggered = true;
        sourceText = extractedFacts.beneficiary_lawful_entry?.source || 'Beneficiary entry manner marked as unauthorized.';
      }
    } else if (flag.id === 'income_below_guideline') {
      if (data.income_details?.below_125pct_poverty === true) {
        triggered = true;
        sourceText = `Petitioner annual income $${data.income_details?.petitioner_income_amount || 0} below threshold for household size ${data.income_details?.household_size || 2}.`;
      }
    } else if (flag.id === 'priority_date_not_current') {
      if (scenario === 'LPR_petitioner' && extractedFacts.priority_date_current?.value === false) {
        triggered = true;
        sourceText = 'F2A preference priority date is not marked as current.';
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

  // 6. Completeness Scoring Calculation
  // Dimension 1: Identity & Relationship (20% weight)
  const idFacts = ['petitioner_identity', 'beneficiary_identity', 'marriage_date', 'marriage_location'];
  const idDocs = ['beneficiary_passport', 'petitioner_status_proof', 'marriage_certificate'];

  const idFactsPresentCount = idFacts.filter(f => extractedFacts[f] && extractedFacts[f].value !== null && extractedFacts[f].value !== '').length;
  const idDocsProvidedCount = idDocs.filter(d => documents.find(doc => doc.id === d && doc.status === 'provided')).length;

  const idFactScore = idFactsPresentCount / idFacts.length;
  const idDocScore = idDocsProvidedCount / idDocs.length;
  const identityScore = (idFactScore * 0.5 + idDocScore * 0.5) * 100;

  // Dimension 2: Bona Fide Marriage (35% weight)
  const bfScore = Math.min(bonaFideCount / playbook.evidence_map.bona_fide_marriage.min_items, 1.0) * 100;
  const cohabitationScore = Math.min(cohabitationCount / playbook.evidence_map.cohabitation.min_items, 1.0) * 100;
  const bonaFideScore = bfScore * 0.7 + cohabitationScore * 0.3;

  // Dimension 3: Financial Support (20% weight)
  const finFacts = ['petitioner_income'];
  const finDocs = ['petitioner_tax_return_recent', 'petitioner_w2_or_paystub'];

  const finFactsPresentCount = finFacts.filter(f => extractedFacts[f] && extractedFacts[f].value !== null && extractedFacts[f].value !== '').length;
  const finDocsProvidedCount = finDocs.filter(d => documents.find(doc => doc.id === d && doc.status === 'provided')).length;

  const finFactScore = finFactsPresentCount / finFacts.length;
  const finDocScore = finDocsProvidedCount / finDocs.length;
  const financialScore = (finFactScore * 0.4 + finDocScore * 0.6) * 100;

  // Dimension 4: Admissibility & Status (25% weight)
  const admFacts = ['beneficiary_entry_record', 'immigration_history', 'criminal_history'];
  const admDocs = ['i94_record'];

  const admFactsPresentCount = admFacts.filter(f => extractedFacts[f] && extractedFacts[f].value !== null && extractedFacts[f].value !== '').length;
  const admDocsProvidedCount = admDocs.filter(d => documents.find(doc => doc.id === d && doc.status === 'provided')).length;

  const admFactScore = admFactsPresentCount / admFacts.length;
  const admDocScore = admDocsProvidedCount / admDocs.length;
  const admissibilityScore = (admFactScore * 0.6 + admDocScore * 0.4) * 100;

  // Weighted raw score
  const rawScore =
    identityScore * 0.20 +
    bonaFideScore * 0.35 +
    financialScore * 0.20 +
    admissibilityScore * 0.25;

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
    scenario,
    scenarioLabel,
    completeness: {
      overall: overallScore,
      dimensions: {
        identity: Math.round(identityScore),
        bona_fide: Math.round(bonaFideScore),
        financial: Math.round(financialScore),
        admissibility: Math.round(admissibilityScore),
      },
      penaltiesApplied
    },
    facts: extractedFacts,
    documents,
    evidence,
    riskFlags,
    followUpQuestions,
    uscisFormMapping: data.uscis_form_mapping || { 'I-130': {}, 'I-485': {} },
    coverLetterDraft: data.cover_letter_draft || ''
  };
}
