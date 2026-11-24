import { randomUUID } from 'crypto';
import type { Response, Router } from 'express';
import { allow, type AuthedRequest } from './auth';
import { hasCurrentConsent, type ConsentDocument } from './consent';
import type { DocumentRequest, Store } from './store';

export function mountDocumentRequests(router: Router, storeFor: (res: Response) => Store,
  consent: ConsentDocument | undefined, audit: (req: AuthedRequest, action: string, outcome?: 'ok', resource?: string) => unknown) {
  router.get('/document-requests', allow('lawyer', 'employee'), (_req, res) => {
    res.json({ requests: storeFor(res).read().documentRequests ?? [], closed: res.locals.matterStatus === 'closed' });
  });

  router.post('/document-requests', allow('lawyer'), (req: AuthedRequest, res) => {
    if (res.locals.matterStatus === 'closed') return res.status(409).json({ error: 'This case is closed' });
    const { title, instructions } = req.body ?? {};
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 120 ||
        typeof instructions !== 'string' || instructions.trim().length > 1000)
      return res.status(400).json({ error: 'Enter a document name and brief instructions' });
    const store = storeFor(res);
    if ((store.read().documentRequests?.length ?? 0) >= 100)
      return res.status(409).json({ error: 'This case has reached its document request limit' });
    const row: DocumentRequest = { id: randomUUID(), title: title.trim(), instructions: instructions.trim(),
      status: 'requested', materialIds: [], revision: randomUUID(), updatedAt: new Date().toISOString() };
    store.update(state => { (state.documentRequests ??= []).push(row); });
    audit(req, 'document.request.send', 'ok', row.id);
    res.status(201).json(row);
  });

  router.put('/document-requests/:id/submit', allow('employee'), (req: AuthedRequest, res) => {
    if (res.locals.matterStatus === 'closed') return res.status(409).json({ error: 'This case is closed' });
    const { materialIds, revision } = req.body ?? {};
    if (!Array.isArray(materialIds) || !materialIds.length || materialIds.length > 10 ||
        !materialIds.every(id => typeof id === 'string') || new Set(materialIds).size !== materialIds.length)
      return res.status(400).json({ error: 'Select between 1 and 10 of your uploaded files' });
    const store = storeFor(res);
    const state = store.read();
    const employee = req.account!.id;
    if (!hasCurrentConsent(state, consent, employee)) return res.status(412).json({ error: 'Review the case consent before submitting files' });
    const row = state.documentRequests?.find(request => request.id === req.params.id);
    if (!row) return res.status(404).json({ error: 'Document request unavailable' });
    if (row.revision !== revision || !['requested', 'returned'].includes(row.status))
      return res.status(409).json({ error: 'This request changed. Refresh the document requests and try again.' });
    if (!materialIds.every(id => state.materials.some(file => file.id === id && file.ownerId === employee)))
      return res.status(400).json({ error: 'Select files you uploaded to this case' });
    const updated: DocumentRequest = { ...row, status: 'submitted', materialIds, revision: randomUUID(), updatedAt: new Date().toISOString() };
    store.update(current => {
      current.documentRequests = current.documentRequests!.map(request => request.id === row.id ? updated : request);
    });
    audit(req, 'document.request.submit', 'ok', row.id);
    res.json(updated);
  });

  router.put('/document-requests/:id/review', allow('lawyer'), (req: AuthedRequest, res) => {
    if (res.locals.matterStatus === 'closed') return res.status(409).json({ error: 'This case is closed' });
    const { decision, feedback, revision } = req.body ?? {};
    if (decision !== 'accepted' && decision !== 'returned' && decision !== 'canceled')
      return res.status(400).json({ error: 'Choose accept, return or cancel' });
    if (decision === 'returned' && (typeof feedback !== 'string' || !feedback.trim() || feedback.trim().length > 1000))
      return res.status(400).json({ error: 'Explain what the employee should change' });
    const store = storeFor(res);
    const state = store.read();
    const row = state.documentRequests?.find(request => request.id === req.params.id);
    if (!row) return res.status(404).json({ error: 'Document request unavailable' });
    const allowed = decision === 'canceled' ? row.status === 'requested' || row.status === 'returned' : row.status === 'submitted';
    if (!allowed || row.revision !== revision)
      return res.status(409).json({ error: 'This request changed. Refresh the document requests and try again.' });
    const updated: DocumentRequest = { ...row, status: decision,
      feedback: decision === 'returned' ? feedback.trim() : undefined, revision: randomUUID(), updatedAt: new Date().toISOString() };
    store.update(current => {
      current.documentRequests = current.documentRequests!.map(request => request.id === row.id ? updated : request);
    });
    audit(req, 'document.request.' + decision, 'ok', row.id);
    res.json(updated);
  });
}
