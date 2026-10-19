import type { Account, PilotConfig } from './config';
import type { PilotState, Material } from './store';

/**
 * Role-scoped projections of the single case. Every API response that carries
 * case data goes through one of these, so a role can never receive a field it
 * is not entitled to even if a route forgets to filter.
 */

export const EMPLOYEE_DISCLAIMER =
  'MeritX provides software only and is not a law firm. Nothing in this workspace is legal advice ' +
  'or a determination of your eligibility for any visa. Only your attorney can advise you.';

export function statusView(s: PilotState) {
  return { status: s.case.status, updatedAt: s.case.updatedAt };
}

export function materialMeta(m: Material) {
  return { id: m.id, filename: m.filename, mimeType: m.mimeType, size: m.size, uploadedAt: m.uploadedAt };
}

export function visibleMaterials(acct: Account, s: PilotState): Material[] {
  if (acct.role === 'lawyer') return s.materials;
  if (acct.role === 'employee') return s.materials.filter(m => m.ownerId === acct.id);
  return [];
}

/**
 * The AI eligibility assessment is visible to the employee ONLY when
 *   (a) LAWYER_APPROVED_PUBLISH is on, AND
 *   (b) the lawyer has approved the current text.
 * It is then shown under the lawyer's name. Enterprise/admin never see it.
 */
export function employeeAssessment(cfg: PilotConfig, s: PilotState) {
  if (!cfg.lawyerApprovedPublish) return null;
  const a = s.assessment;
  if (!a || !a.approval) return null;
  const lawyer = cfg.accounts.find(x => x.id === a.approval!.by && x.role === 'lawyer');
  if (!lawyer) return null;
  return {
    text: a.text,
    approvedBy: lawyer.name,
    approvedAt: a.approval.at,
    label: `Reviewed and approved by your attorney, ${lawyer.name}. This is your attorney's assessment, not an automated determination.`,
  };
}

export function caseViewFor(acct: Account, cfg: PilotConfig, s: PilotState) {
  switch (acct.role) {
    case 'lawyer':
      return {
        role: 'lawyer',
        ...statusView(s),
        visaType: s.case.visaType,
        visaTypeSetAt: s.case.visaTypeSetAt,
        consent: s.consent,
        questionnaire: s.questionnaire,
        materials: s.materials.map(m => ({ ...materialMeta(m), ownerId: m.ownerId, category: m.category })),
        todos: s.todos,
        assessment: s.assessment,
        flags: { lawyerApprovedPublish: cfg.lawyerApprovedPublish },
        aiNotice: 'AI output is for attorney review only and is not legal advice.',
      };
    case 'employee':
      return {
        role: 'employee',
        ...statusView(s),
        consentSigned: !!(s.consent && s.consent.accountId === acct.id),
        questionnaire: s.questionnaire.ownerId === acct.id || s.questionnaire.ownerId === null
          ? { answers: s.questionnaire.answers, updatedAt: s.questionnaire.updatedAt, submittedAt: s.questionnaire.submittedAt }
          : null,
        materials: visibleMaterials(acct, s).map(materialMeta),
        todos: s.todos.filter(t => t.published).map(t => ({ id: t.id, text: t.text })),
        assessment: employeeAssessment(cfg, s),
        disclaimer: EMPLOYEE_DISCLAIMER,
      };
    case 'enterprise':
      // Enterprise contact: progress/status ONLY.
      return { role: 'enterprise', ...statusView(s) };
    case 'admin':
      // MeritX operator: operational status only; no case materials (access log via /api/access-log).
      return { role: 'admin', ...statusView(s) };
  }
}
