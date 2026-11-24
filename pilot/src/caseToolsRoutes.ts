import { randomUUID } from 'crypto';
import type { Response, Router } from 'express';
import multer from 'multer';
import { allow, type AuthedRequest } from './auth';
import type { AiAttachment, AiClient } from './ai/provider';
import { AUDIO_LIMIT, audioMime, casePlaybooks, validPlaybook } from './caseTools';
import type { PilotConfig } from './config';
import { hasCurrentConsent } from './consent';
import { fingerprint, petitionDraft } from './petition';
import type { Store } from './store';
import { phoneNumber, TwilioVoice } from './twilio';

const tasks = {
  transcribe: 'Transcribe the attached audio verbatim with speaker labels where distinguishable. Mark inaudible segments.',
  summarize: 'Summarize the supplied consultation transcript, distinguishing reported facts and open questions.',
  classify: 'Suggest the best checklist document for each attached file. Return JSON with links, an array of {materialId, documentId} objects. Use only supplied IDs. Omit uncertain links.',
  research: 'Use web search for the public topic supplied. Explain findings with citations. Prefer official or primary sources.',
  refine: 'Rewrite the supplied excerpt using the requested edits. Preserve existing source references. Return only replacement text.',
  regenerate: 'Draft a replacement petition letter using the supplied fact and exhibit IDs. Preserve or add citations as [description](cite:material-id). Do not invent facts.',
  simulate: 'Evaluate the supplied sample facts against the supplied playbook rules. Explain triggered flags, evidence gaps and proposed follow-up without stating that the case qualifies.',
  copilot: 'Return one complete updated playbook JSON object in the same format as the supplied playbook. Make only requested edits.',
} as const;
type Task = keyof typeof tasks;
function parseModelJson(text: string): unknown {
  return JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, ''));
}
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: AUDIO_LIMIT, files: 1, fields: 0 } });
const isText = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit;

export function mountCaseTools(router: Router, storeFor: (res: Response) => Store, ai: AiClient,
  cfg: PilotConfig, audit: (req: AuthedRequest, action: string, outcome?: 'ok' | 'error', resource?: string) => unknown,
  voiceFetch?: typeof fetch) {
  const lawyer = allow('lawyer');
  const voice = cfg.twilio && new TwilioVoice(cfg.twilio, voiceFetch);
  const system = cfg.ai.prompts?.petition?.system ?? cfg.ai.prompts?.assessment.system;
  router.get('/case-tools', lawyer, (_req, res) => {
    const state = storeFor(res).read();
    const data = state.caseTools;
    res.json({ playbooks: casePlaybooks(state), selection: state.playbook, consultation: data?.consultation,
      calls: data?.calls?.map(({ id, startedAt, sid, materialId }) => ({ id, startedAt, queued: !!sid, materialId })) ?? [],
      materials: state.materials.map(({ id, filename, mimeType }) => ({ id, filename, mimeType })),
      ai: ai.enabled && !!system, audioAndSearch: ai.supportsAudioAndSearch, phone: !!voice,
      consent: hasCurrentConsent(state, cfg.consentDocument),
      revision: fingerprint(data ?? null) });
  });

  router.put('/case-tools/playbook', lawyer, (req: AuthedRequest, res) => {
    const { playbook, revision } = req.body ?? {};
    if (!validPlaybook(playbook)) return res.status(400).json({ error: 'Invalid playbook' });
    const store = storeFor(res);
    const state = store.read();
    if (fingerprint(state.caseTools ?? null) !== revision) return res.status(409).json({ error: 'Reload before saving' });
    const custom = state.caseTools?.playbooks ?? [];
    if (custom.length >= 10 && !custom.some(book => book.id === playbook.id)) return res.status(409).json({ error: 'Playbook limit reached' });
    store.update(current => {
      const data = current.caseTools ??= {};
      data.playbooks = [...custom.filter(book => book.id !== playbook.id), playbook];
      if (current.playbook?.id === playbook.id && !Object.hasOwn(playbook.scenarios, current.playbook.scenario)) delete current.playbook;
    });
    audit(req, 'caseTools.playbook.save');
    res.json({ revision: fingerprint(store.read().caseTools ?? null) });
  });

  router.put('/case-tools/consultation', lawyer, (req: AuthedRequest, res) => {
    const { transcript, summary, revision } = req.body ?? {};
    if (!isText(transcript, 90000) || !isText(summary, 20000)) return res.status(400).json({ error: 'Invalid consultation notes' });
    const store = storeFor(res);
    if (fingerprint(store.read().caseTools ?? null) !== revision) return res.status(409).json({ error: 'Reload before saving' });
    store.update(state => { (state.caseTools ??= {}).consultation = { transcript, summary }; });
    audit(req, 'caseTools.consultation.save');
    res.json({ revision: fingerprint(store.read().caseTools ?? null) });
  });

  router.post('/case-tools/audio', lawyer, audioUpload.single('audio'), (req: AuthedRequest, res) => {
    const data = req.file?.buffer;
    const mime = data && audioMime(data);
    if (!data || !mime) return res.status(415).json({ error: 'Choose an MP3 or WAV recording' });
    const id = saveAudio(storeFor(res), req.account!.id, data, mime);
    audit(req, 'caseTools.audio.upload', 'ok', id);
    res.status(201).json({ id });
  });

  router.post('/case-tools/calls', lawyer, async (req: AuthedRequest, res, next) => {
    try {
      if (!voice) return res.status(503).json({ error: 'Phone integration is disabled' });
      const store = storeFor(res);
      const state = store.read();
      const { phone, recordingAgreed } = req.body ?? {};
      if (!hasCurrentConsent(state, cfg.consentDocument) || recordingAgreed !== true)
        return res.status(412).json({ error: 'Case consent and permission from all participants are required' });
      if (typeof phone !== 'string' || !phoneNumber.test(phone) || phone === cfg.twilio!.lawyerPhone || phone === cfg.twilio!.from)
        return res.status(400).json({ error: 'Enter the client phone number in international format' });
      const calls = state.caseTools?.calls ?? [];
      if (calls.length >= 50 || calls.some(call => Date.now() - Date.parse(call.startedAt) < 30000))
        return res.status(429).json({ error: 'Wait before requesting another call' });
      const call = { id: randomUUID(), startedAt: new Date().toISOString() };
      store.update(current => { (current.caseTools ??= {}).calls = [...calls, call]; });
      audit(req, 'caseTools.call.request', 'ok', call.id);
      let sid;
      try { sid = await voice.call(phone); }
      catch {
        audit(req, 'caseTools.call.connect', 'error', call.id);
        return res.status(502).json({ error: 'Phone provider did not confirm the call' });
      }
      store.update(current => { current.caseTools!.calls!.find(row => row.id === call.id)!.sid = sid; });
      audit(req, 'caseTools.call.connect', 'ok', call.id);
      res.status(201).json({ id: call.id });
    } catch (error) { next(error); }
  });

  router.post('/case-tools/calls/:id/import', lawyer, async (req: AuthedRequest, res, next) => {
    try {
      if (!voice) return res.status(503).json({ error: 'Phone integration is disabled' });
      const store = storeFor(res);
      const state = store.read();
      if (!hasCurrentConsent(state, cfg.consentDocument)) return res.status(412).json({ error: 'Case consent is required' });
      const call = state.caseTools?.calls?.find(row => row.id === req.params.id);
      if (!call?.sid) return res.status(404).json({ error: 'Call unavailable' });
      if (call.materialId) return res.json({ id: call.materialId });
      let bytes;
      try { bytes = await voice.recording(call.sid); }
      catch { return res.status(502).json({ error: 'Recording could not be downloaded' }); }
      if (!bytes) return res.status(409).json({ error: 'Recording is not ready' });
      const mime = audioMime(bytes);
      if (!mime) return res.status(502).json({ error: 'Invalid recording audio' });
      const existing = store.read().caseTools?.calls?.find(row => row.id === call.id)?.materialId;
      if (existing) return res.json({ id: existing });
      const id = saveAudio(store, req.account!.id, bytes, mime, call.id);
      audit(req, 'caseTools.call.import', 'ok', call.id);
      res.status(201).json({ id });
    } catch (error) { next(error); }
  });

  router.post('/case-tools/ai/:task', lawyer, async (req: AuthedRequest, res, next) => {
    try {
      if (!ai.enabled || !system) return res.status(503).json({ error: 'AI tools are disabled' });
      const task = req.params.task as Task;
      if (!Object.hasOwn(tasks, task)) return res.sendStatus(404);
      if ((task === 'research' || task === 'transcribe') && !ai.supportsAudioAndSearch)
        return res.status(503).json({ error: 'This tool requires a Gemini model with audio or search support' });
      const store = storeFor(res);
      const state = store.read();
      if (!hasCurrentConsent(state, cfg.consentDocument) && !['research', 'copilot', 'simulate'].includes(task))
        return res.status(412).json({ error: 'Case consent is required' });
      const { text = '', instruction = '', materialIds = [], playbook } = req.body ?? {};
      if (!isText(text, 90000) || !isText(instruction, 5000) || !Array.isArray(materialIds) || materialIds.length > 30 ||
          !materialIds.every(id => typeof id === 'string') || new Set(materialIds).size !== materialIds.length)
        return res.status(400).json({ error: 'Invalid AI input' });
      if (task === 'research' && (!text.trim() || text.length > 2000))
        return res.status(400).json({ error: 'Enter a public research topic of up to 2,000 characters' });
      if (['simulate', 'copilot'].includes(task) && !validPlaybook(playbook))
        return res.status(400).json({ error: 'Supply a valid playbook' });
      const attachments: AiAttachment[] = [];
      const book = casePlaybooks(state).find(entry => entry.id === state.playbook?.id);
      const docs = book?.documents.filter(doc => doc.scenarios.includes(state.playbook!.scenario)) ?? [];
      const inputs = task === 'transcribe' || task === 'classify' ? materialIds : [];
      let size = 0;
      for (const id of inputs) {
        const mat = state.materials.find(m => m.id === id);
        if (!mat) return res.status(404).json({ error: 'Material unavailable' });
        const isAudio = mat.mimeType === 'audio/wav' || mat.mimeType === 'audio/mp3';
        if (isAudio !== (task === 'transcribe')) return res.status(415).json({ error: 'Choose materials supported by this tool' });
        size += mat.size;
        if (size > AUDIO_LIMIT) return res.status(413).json({ error: 'Attachments exceed the tool size limit' });
        const data = store.getBlob(id);
        if (!data?.length) return res.status(409).json({ error: 'Material could not be read' });
        attachments.push({ filename: mat.id, mimeType: mat.mimeType, data });
      }
      if (ai.partition(attachments).skipped.length) return res.status(415).json({ error: 'Provider does not support a selected attachment' });
      if ((task === 'transcribe' && inputs.length !== 1) || (task === 'classify' && (!docs.length || !inputs.length)))
        return res.status(400).json({ error: 'Choose the required recording or checklist and documents' });
      const context = task === 'research' ? { topic: text } : task === 'classify' ? { ids: inputs, docs } :
        task === 'regenerate' ? { facts: petitionDraft(state).facts, exhibits: petitionDraft(state).exhibitIds, instruction } :
        task === 'simulate' || task === 'copilot' ? { playbook, text, instruction } : { text, instruction };
      audit(req, 'caseTools.ai.' + task, 'ok', ai.label + ':request:files=' + attachments.length);
      let result;
      try { result = await ai.generate({ system, prompt: tasks[task] + '\n' + JSON.stringify(context), attachments, webSearch: task === 'research' }); }
      catch {
        audit(req, 'caseTools.ai.' + task, 'error', ai.label);
        return res.status(502).json({ error: 'AI provider request failed' });
      }
      if (['classify', 'regenerate'].includes(task) && fingerprint(state) !== fingerprint(store.read()))
        return res.status(409).json({ error: 'Matter changed while the AI was running. Try again.' });
      if (task === 'research' && !result.sources?.length) return res.status(502).json({ error: 'Provider returned no verifiable sources' });
      if (!result.text.trim()) return res.status(502).json({ error: 'Provider returned no output' });
      if (task === 'classify' || task === 'copilot') {
        let output: unknown;
        try { output = parseModelJson(result.text); } catch { return res.status(502).json({ error: 'Provider returned invalid JSON' }); }
        if (task === 'copilot') {
          if (!validPlaybook(output)) return res.status(502).json({ error: 'Provider returned an invalid playbook' });
          return res.json({ playbook: output });
        }
        const links = (output as { links?: unknown })?.links;
        if (!Array.isArray(links)) return res.status(502).json({ error: 'Provider returned invalid classifications' });
        const suggestions = new Map<string, string>();
        for (const link of links) {
          if (inputs.includes(link?.materialId) && docs.some(doc => doc.id === link?.documentId) && !suggestions.has(link.materialId))
            suggestions.set(link.materialId, link.documentId);
        }
        return res.json({ links: [...suggestions].map(([materialId, documentId]) => ({ materialId, documentId })) });
      }
      res.json({ text: result.text.slice(0, 90000), sources: result.sources });
    } catch (error) { next(error); }
  });
}

function saveAudio(store: Store, ownerId: string, bytes: Buffer, mimeType: string, callId?: string) {
  const id = randomUUID();
  const filename = 'consultation-' + id.slice(0, 8) + (mimeType === 'audio/wav' ? '.wav' : '.mp3');
  store.putBlob(id, bytes);
  try {
    store.update(state => {
      if (callId) state.caseTools!.calls!.find(row => row.id === callId)!.materialId = id;
      state.materials.push({ id, ownerId, filename, mimeType, size: bytes.length, uploadedAt: new Date().toISOString(), category: null });
    });
  } catch (error) { store.deleteBlob(id); throw error; }
  return id;
}
