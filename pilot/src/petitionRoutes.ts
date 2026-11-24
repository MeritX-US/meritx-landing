import type { Router, Response } from 'express';
import { allow, type AuthedRequest } from './auth';
import { AiClient, fillTemplate, type AiAttachment } from './ai/provider';
import type { AiConfig } from './config';
import { hasCurrentConsent, type ConsentDocument } from './consent';
import type { PilotState, Store } from './store';
import { FORMS } from './formFields';
import { assemblePetition, factDefinitions, fillForm, fingerprint, formDigest, formKeys, packageDigest,
  packageTypes, petitionDraft, reviewForms, type FormKey, type PetitionDraft } from './petition';

const listOfIds = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 50 && value.every(id => typeof id === 'string') && new Set(value).size === value.length;
const sourceDigest = (store: Store) => fingerprint(store.read());
const draftRevision = (state: PilotState) => fingerprint([packageDigest(state), state.materials]);

export function mountPetition(router: Router, storeFor: (res: Response) => Store, ai: AiClient,
  prompts: NonNullable<AiConfig['prompts']>['petition'],
  consentDocument: ConsentDocument | undefined,
  audit: (req: AuthedRequest, action: string, outcome?: 'ok' | 'error', resource?: string) => unknown) {
  const lawyer = allow('lawyer');
  router.get('/petition', lawyer, (req: AuthedRequest, res) => {
    const state = storeFor(res).read();
    const draft = petitionDraft(state);
    audit(req, 'petition.view');
    res.json({ facts: draft.facts, fields: { ...Object.fromEntries(Object.keys(draft.facts).map(key => [key, key.replaceAll('_', ' ')])), ...factDefinitions(state) },
      followUps: draft.followUps, letter: draft.letter, exhibitIds: draft.exhibitIds,
      materials: state.materials.map(({ id, filename, mimeType }) => ({ id, filename, packageSupported: packageTypes.has(mimeType) })),
      aiAvailable: ai.enabled && !!prompts && hasCurrentConsent(state, consentDocument), revision: draftRevision(state),
      reviewed: draft.packageReview?.digest === packageDigest(state), formKeys });
  });

  router.post('/petition/extract', lawyer, async (req: AuthedRequest, res, next) => {
    try {
      if (!ai.enabled || !prompts) return res.status(503).json({ error: 'Petition AI is disabled' });
      const store = storeFor(res);
      const state = store.read();
      if (!hasCurrentConsent(state, consentDocument)) return res.status(412).json({ error: 'Consent required for this matter' });
      const { materialIds, includeTranscript } = req.body ?? {};
      if (!listOfIds(materialIds)) return res.status(400).json({ error: 'Select up to 50 materials' });
      const attachments: AiAttachment[] = [];
      const sources = new Set<string>();
      let total = 0;
      for (const id of materialIds) {
        const material = state.materials.find(m => m.id === id);
        if (!material) return res.status(404).json({ error: 'Material unavailable' });
        total += material.size;
        if (total > 15 * 1024 * 1024) return res.status(413).json({ error: 'Choose at most 15 MB of attachments' });
        const data = store.getBlob(id);
        if (!data?.length) return res.status(409).json({ error: 'A selected material could not be read' });
        attachments.push({ mimeType: material.mimeType, filename: id, data });
        sources.add(id);
      }
      if (ai.partition(attachments).skipped.length) return res.status(415).json({ error: 'Deselect unsupported AI attachments' });
      const questions = state.questionnaire.answers;
      for (const key of Object.keys(questions)) sources.add('answer:' + key);
      const transcript = includeTranscript === true ? state.caseTools?.consultation?.transcript ?? '' : '';
      if (transcript) sources.add('consultation');
      if (!sources.size) return res.status(409).json({ error: 'Add questionnaire answers or select materials first' });
      const fields = factDefinitions(state);
      const vars = { fields: JSON.stringify(fields), answers: JSON.stringify(questions),
        materials: JSON.stringify(materialIds), playbook: JSON.stringify(state.playbook ?? null), transcript };
      const prompt = fillTemplate(prompts.user, vars) + '\nInputs: ' + JSON.stringify(vars) +
        '\nReturn only JSON with facts (field ID to {value,source}), followUps (strings) and letter (string). ' +
        'Use only listed field IDs. Each fact source must be an attachment ID, answer:<question ID>, or consultation if a transcript is included. Omit unsupported facts. ' +
        'In the letter, cite any referenced attachment as [description](cite:attachment-id).';
      audit(req, 'ai.petition.request', 'ok', ai.label + ':files=' + attachments.length);
      let result;
      try { result = await ai.generate({ system: prompts.system, prompt, attachments }); }
      catch { audit(req, 'ai.petition.extract', 'error', ai.label); return res.status(502).json({ error: 'AI extraction failed' }); }
      audit(req, 'ai.petition.extract', 'ok', result.provider + ':' + result.model);
      if (fingerprint(state) !== sourceDigest(store)) return res.status(409).json({ error: 'Matter changed during extraction. Try again.' });
      let data;
      try { data = JSON.parse(result.text.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, '')); }
      catch { return res.status(502).json({ error: 'AI returned invalid JSON' }); }
      if (!data?.facts || typeof data.facts !== 'object' || Array.isArray(data.facts))
        return res.status(502).json({ error: 'AI returned an invalid fact list' });
      const facts: PetitionDraft['facts'] = {};
      for (const [key, fact] of Object.entries(data.facts) as [string, { value?: unknown; source?: unknown }][]) {
        if (Object.hasOwn(fields, key) && typeof fact?.value === 'string' && typeof fact.source === 'string' && sources.has(fact.source))
          facts[key] = { value: fact.value.slice(0, 2000), source: fact.source };
      }
      const followUps = Array.isArray(data.followUps) ? data.followUps.filter((line: unknown) => typeof line === 'string').slice(0, 50).map((line: string) => line.slice(0, 500)) : [];
      res.json({ facts, followUps, letter: typeof data.letter === 'string' ? data.letter.slice(0, 50000) : '' });
    } catch (error) { next(error); }
  });

  router.put('/petition', lawyer, (req: AuthedRequest, res) => {
    const store = storeFor(res);
    const state = store.read();
    const { revision, facts, followUps, letter, exhibitIds } = req.body ?? {};
    if (revision !== draftRevision(state)) return res.status(409).json({ error: 'Matter changed. Reload before saving.' });
    if (!facts || typeof facts !== 'object' || Array.isArray(facts) || !Array.isArray(followUps) ||
        followUps.length > 50 || !followUps.every(s => typeof s === 'string' && s.length <= 500) ||
        typeof letter !== 'string' || letter.length > 50000 || !listOfIds(exhibitIds))
      return res.status(400).json({ error: 'Invalid petition draft' });
    const fields = factDefinitions(state);
    const cleanFacts: PetitionDraft['facts'] = {};
    for (const [key, fact] of Object.entries(facts) as [string, { value?: unknown; source?: unknown }][]) {
      if ((!Object.hasOwn(fields, key) && !Object.hasOwn(petitionDraft(state).facts, key)) || typeof fact?.value !== 'string' || fact.value.length > 2000 ||
          typeof fact.source !== 'string' || fact.source.length > 300)
        return res.status(400).json({ error: 'Invalid fact or source' });
      cleanFacts[key] = { value: fact.value, source: fact.source };
    }
    if (exhibitIds.some(id => !state.materials.some(m => m.id === id && packageTypes.has(m.mimeType))))
      return res.status(400).json({ error: 'Choose exhibits from supported materials in this case' });
    store.update(current => { current.petition = { ...petitionDraft(current), facts: cleanFacts, followUps, letter, exhibitIds }; });
    audit(req, 'petition.save');
    res.json({ ok: true });
  });

  router.get('/petition/forms/:key', lawyer, (req: AuthedRequest, res) => {
    const key = req.params.key as FormKey;
    if (!formKeys.includes(key)) return res.sendStatus(404);
    const state = storeFor(res).read();
    const rows = reviewForms(state)[key];
    audit(req, 'petition.form.view', 'ok', key);
    res.json({ rows, revision: fingerprint(state), reviewed: petitionDraft(state).formReviews[key]?.digest === formDigest(rows) });
  });

  router.put('/petition/forms/:key', lawyer, (req: AuthedRequest, res) => {
    const key = req.params.key as FormKey;
    if (!formKeys.includes(key)) return res.sendStatus(404);
    const store = storeFor(res);
    const state = store.read();
    const { revision, changes } = req.body ?? {};
    if (revision !== fingerprint(state)) return res.status(409).json({ error: 'Matter changed. Reload before saving.' });
    if (!changes || typeof changes !== 'object' || Array.isArray(changes))
      return res.status(400).json({ error: 'Invalid form changes' });
    const clean: Record<string, string> = {};
    for (const [id, value] of Object.entries(changes)) {
      const field = FORMS[key].find(f => f.fieldId === id);
      if (!field || typeof value !== 'string' || value.length > 2000 ||
          (value && field.type === 'toggle' && !['true', 'false'].includes(value)) ||
          (value && field.type === 'select' && !field.options?.some(o => o.value === value)))
        return res.status(400).json({ error: 'Invalid form field value' });
      clean[id] = value;
    }
    store.update(current => {
      const draft = petitionDraft(current);
      for (const [id, value] of Object.entries(clean)) {
        delete draft.overrides[id];
        draft.overrides[id] = value;
      }
      current.petition = draft;
    });
    audit(req, 'petition.form.save', 'ok', key);
    res.json({ ok: true });
  });

  router.post('/petition/forms/:key/review', lawyer, async (req: AuthedRequest, res, next) => {
    try {
      const key = req.params.key as FormKey;
      if (!formKeys.includes(key)) return res.sendStatus(404);
      const store = storeFor(res);
      const state = store.read();
      const rows = reviewForms(state)[key];
      if (req.body?.revision !== fingerprint(state)) return res.status(409).json({ error: 'Reload the form before review' });
      if (rows.some(row => row.required !== false && !row.value.trim()))
        return res.status(409).json({ error: 'Complete the required form fields before sign-off' });
      try { await fillForm(key, rows); }
      catch (error) { return res.status(422).json({ error: (error as Error).message }); }
      if (fingerprint(state) !== sourceDigest(store)) return res.status(409).json({ error: 'Matter changed during review' });
      store.update(current => {
        const draft = petitionDraft(current);
        draft.formReviews[key] = { digest: formDigest(rows), by: req.account!.id, at: new Date().toISOString() };
        current.petition = draft;
      });
      audit(req, 'petition.form.review', 'ok', key);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  router.get('/petition/forms/:key/pdf', lawyer, async (req: AuthedRequest, res, next) => {
    try {
      const key = req.params.key as FormKey;
      if (!formKeys.includes(key)) return res.sendStatus(404);
      const store = storeFor(res);
      const state = store.read();
      const rows = reviewForms(state)[key];
      if (petitionDraft(state).formReviews[key]?.digest !== formDigest(rows)) return res.status(409).json({ error: 'Sign off on the current form first' });
      const pdf = await fillForm(key, rows);
      if (fingerprint(state) !== sourceDigest(store)) return res.status(409).json({ error: 'Matter changed during export' });
      audit(req, 'petition.form.export', 'ok', key);
      res.type('pdf').attachment(key + '-reviewed.pdf').send(pdf);
    } catch (error) { next(error); }
  });

  router.post('/petition/review', lawyer, (req: AuthedRequest, res) => {
    const store = storeFor(res);
    const state = store.read();
    const draft = petitionDraft(state);
    if (req.body?.revision !== draftRevision(state)) return res.status(409).json({ error: 'Reload the package before review' });
    if (!draft.letter.trim() || draft.exhibitIds.some(id => !state.materials.some(m => m.id === id)))
      return res.status(409).json({ error: 'Save a letter and verify the selected exhibits first' });
    store.update(current => {
      draft.packageReview = { digest: packageDigest(state), by: req.account!.id, at: new Date().toISOString() };
      current.petition = draft;
    });
    audit(req, 'petition.review');
    res.json({ ok: true });
  });

  router.get('/petition/pdf', lawyer, async (req: AuthedRequest, res, next) => {
    try {
      const store = storeFor(res);
      const state = store.read();
      const draft = petitionDraft(state);
      if (draft.packageReview?.digest !== packageDigest(state)) return res.status(409).json({ error: 'Sign off on the current package first' });
      let size = 0;
      const exhibits = [];
      for (const id of draft.exhibitIds) {
        const material = state.materials.find(m => m.id === id);
        if (!material || !packageTypes.has(material.mimeType)) return res.status(409).json({ error: 'Exhibit unavailable' });
        size += material.size;
        if (size > 30 * 1024 * 1024) return res.status(413).json({ error: 'Choose at most 30 MB of exhibits' });
        const bytes = store.getBlob(id);
        if (!bytes?.length) return res.status(409).json({ error: 'Exhibit unavailable' });
        exhibits.push({ material, bytes });
      }
      let pdf;
      try { pdf = await assemblePetition(draft.letter, exhibits); }
      catch { return res.status(422).json({ error: 'A selected exhibit or letter could not be rendered as PDF' }); }
      if (fingerprint(state) !== sourceDigest(store)) return res.status(409).json({ error: 'Matter changed during export' });
      audit(req, 'petition.export');
      res.type('pdf').attachment('petition-package.pdf').send(pdf);
    } catch (error) { next(error); }
  });
}
