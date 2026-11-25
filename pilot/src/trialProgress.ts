import { hasCurrentConsent, type ConsentDocument } from './consent';
import type { DraftRegister } from './draftRegister';

export type TrialRole = 'enterprise' | 'lawyer' | 'employee';
export interface TrialStep { id: string; role: TrialRole; title: string; done: boolean }
export interface TrialProgress { steps: TrialStep[]; next: { role: TrialRole; title: string } | null }

const step = (id: string, role: TrialRole, title: string, done: boolean): TrialStep => ({ id, role, title, done });

/**
 * Guided-trial checklist derived from the latest case HR started in the trial workspace.
 * Every flag is computed from the stored case state, so the guide can never drift from what
 * the roles actually see. `hrChecked` is the only step that is not case state: it records that
 * HR opened case progress after the attorney accepted the documents.
 */
export function trialProgress(register: DraftRegister, lawyerId: string, employeeId: string,
  consent: ConsentDocument | undefined, hrChecked: boolean): TrialProgress {
  const row = register.list(lawyerId).filter(entry => entry.request?.by === 'enterprise').at(-1);
  const decision = row?.request?.decision;
  const invitation = row?.invitation?.employeeId === employeeId ? row.invitation : undefined;
  const state = row ? register.intakeState(row) : null;
  const documents = (state?.documentRequests ?? []).filter(item => item.status !== 'canceled');
  const steps = [
    step('hr_request', 'enterprise', 'Start a case request for the sample employee', !!row),
    step('attorney_accept', 'lawyer', 'Accept the HR request', decision === 'accepted'),
    step('attorney_invite', 'lawyer', 'Invite the sample employee to the case', !!invitation),
    step('employee_accept', 'employee', 'Accept the case invitation', !!invitation?.accepted),
    step('employee_consent', 'employee', 'Review and agree to the sample consent',
      !!state && hasCurrentConsent(state, consent, employeeId)),
    step('employee_questionnaire', 'employee', 'Submit the questionnaire',
      !!state && state.questionnaire.ownerId === employeeId && !!state.questionnaire.submittedAt),
    step('attorney_documents', 'lawyer', 'Request a sample document', documents.length > 0),
    step('employee_documents', 'employee', 'Upload a sample file and submit it for the request',
      documents.some(item => item.status === 'submitted' || item.status === 'accepted')),
    step('attorney_review', 'lawyer', 'Accept the submitted document', documents.some(item => item.status === 'accepted')),
  ];
  steps.push(step('hr_progress', 'enterprise', 'Check case progress as HR', steps.every(item => item.done) && hrChecked));
  // A returned item hands the case back to an earlier role; point there instead of at the unchecked step.
  if (decision === 'returned') return { steps, next: { role: 'enterprise', title: 'Revise the returned request and resubmit it' } };
  if (documents.some(item => item.status === 'returned'))
    return { steps, next: { role: 'employee', title: 'Replace the returned files and resubmit them' } };
  const pending = steps.find(item => !item.done);
  return { steps, next: pending ? { role: pending.role, title: pending.title } : null };
}
