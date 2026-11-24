import type { Response, Router } from 'express';
import { allow, type AuthedRequest } from './auth';
import type { DraftMatter, DraftRegister } from './draftRegister';

function progress(row: DraftMatter, drafts: DraftRegister) {
  const request = row.request!;
  if (request.decision === 'returned') return { stage: 'returned', next: 'HR', updatedAt: row.updatedAt };
  if (request.decision === 'pending') return { stage: 'awaiting_firm', next: 'Law firm', updatedAt: row.updatedAt };
  if (row.status === 'closed' || row.status === 'filed') return { stage: row.status, next: null, updatedAt: row.updatedAt };
  if (!row.invitation) return { stage: 'accepted', next: 'Law firm', updatedAt: row.updatedAt };
  if (!row.invitation.accepted) return { stage: 'invitation_sent', next: 'Employee', updatedAt: row.updatedAt };
  if (row.status === 'documents_needed') return { stage: row.status, next: 'Employee', updatedAt: row.updatedAt };
  if (row.status === 'in_review' || row.status === 'drafting') return { stage: row.status, next: 'Law firm', updatedAt: row.updatedAt };
  const submitted = drafts.submissionTime(row);
  if (submitted) return {
    stage: 'intake_submitted', next: 'Law firm',
    updatedAt: row.updatedAt && row.updatedAt > submitted ? row.updatedAt : submitted,
  };
  return { stage: 'employee_intake', next: 'Employee', updatedAt: row.updatedAt };
}

function enterpriseView(row: DraftMatter, drafts: DraftRegister) {
  const { email, summary, decision, note } = row.request!;
  return { id: row.id, reference: row.label, email, summary, decision, note, ...progress(row, drafts) };
}

export function mountEnterpriseCases(api: Router, drafts: DraftRegister, lawyerId: string,
  audit: (req: AuthedRequest, action: string, outcome?: 'ok' | 'error', resource?: string) => unknown) {
  const enterprise = allow('enterprise');
  api.get('/enterprise/requests', enterprise, (req: AuthedRequest, res) => {
    const rows = drafts.list(lawyerId).filter(row => row.request?.by === req.account!.id);
    audit(req, 'enterprise.requests.view');
    res.json(rows.map(row => enterpriseView(row, drafts)).reverse());
  });

  function submit(req: AuthedRequest, res: Response) {
    const { reference, email, summary } = req.body ?? {};
    if (typeof reference !== 'string' || !reference.trim() || reference.trim().length > 80 ||
        typeof email !== 'string' || email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
        typeof summary !== 'string' || !summary.trim() || summary.trim().length > 1000)
      return res.status(400).json({ error: 'Enter a reference, work email and brief request' });
    const row = drafts.submit(lawyerId, reference.trim(), { by: req.account!.id, email: email.trim().toLowerCase(), summary: summary.trim() },
      req.params.id);
    if (row === 'missing') return res.status(404).json({ error: 'Request unavailable' });
    if (row === 'conflict') return res.status(409).json({ error: 'Only a returned request can be revised' });
    audit(req, req.params.id ? 'enterprise.request.resubmit' : 'enterprise.request.submit', 'ok', row.id);
    return res.status(req.params.id ? 200 : 201).json(enterpriseView(row, drafts));
  }
  api.post('/enterprise/requests', enterprise, submit);
  api.put('/enterprise/requests/:id', enterprise, submit);

  api.post('/draft-matters/:id/decision', allow('lawyer'), (req: AuthedRequest, res) => {
    const { decision, note } = req.body ?? {};
    if (decision !== 'accepted' && decision !== 'returned') return res.status(400).json({ error: 'Choose accept or return' });
    if (decision === 'returned' && (typeof note !== 'string' || !note.trim() || note.trim().length > 500))
      return res.status(400).json({ error: 'Enter a short reason for HR' });
    const row = drafts.decide(req.account!.id, req.params.id, decision, decision === 'returned' ? note.trim() : undefined);
    if (row === 'missing') return res.status(404).json({ error: 'Request unavailable' });
    if (row === 'conflict') return res.status(409).json({ error: 'Request already reviewed' });
    audit(req, decision === 'accepted' ? 'enterprise.request.accept' : 'enterprise.request.return', 'ok', row.id);
    res.json(row);
  });
}
