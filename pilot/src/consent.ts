import { createHash } from 'crypto';
import fs from 'fs';
import type { PilotState } from './store';

export interface ConsentDocument {
  version: string;
  text: string;
  digest: string;
  preview: boolean;
}

export function loadConsentDocument(env: NodeJS.ProcessEnv): ConsentDocument | undefined {
  const file = env.PILOT_CONSENT_FILE;
  const version = env.PILOT_CONSENT_VERSION?.trim();
  if (!file && !version && env.NODE_ENV === 'production') return undefined;
  if (!!file !== !!version || (version && !/^[a-zA-Z0-9._-]{1,80}$/.test(version))) {
    throw new Error('Configure PILOT_CONSENT_FILE and PILOT_CONSENT_VERSION together, with a stable version ID');
  }
  const text = file ? fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') :
    'This preview is for testing with fictional case information. Use only made-up answers and sample files.\n\n' +
    'Pilot saves the sample information in this demo workspace so you can try the questionnaire and upload flow. ' +
    'This example does not authorize processing of a real case or the sending of real materials to an AI provider.';
  if (!text.trim() || Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('Consent document must contain up to 64 KB of text');
  return { version: version || 'draft-lawyer-review-required', text, digest: createHash('sha256').update(text).digest('hex'), preview: !file };
}

export function hasCurrentConsent(state: PilotState, document: ConsentDocument | undefined, employeeId?: string) {
  const signed = state.consent;
  if (!document || !signed || (employeeId !== undefined && signed.accountId !== employeeId)) return false;
  return document.preview || (signed.version === document.version && signed.digest === document.digest);
}
