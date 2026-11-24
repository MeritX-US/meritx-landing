import defaultCatalog from './playbookCatalog.json';
import defaultFacts from './playbookFacts.json';
import defaultRules from './playbookRules.json';
import type { PilotState } from './store';

export interface ChecklistDocument { id: string; label: string; required: boolean; scenarios: string[] }
export interface CasePlaybook {
  id: string;
  caseType: string;
  scenarios: Record<string, string>;
  documents: ChecklistDocument[];
  facts?: Record<string, string>;
  rules?: Record<string, unknown>;
}
export interface CaseToolsState {
  playbooks?: CasePlaybook[];
  consultation?: { transcript: string; summary: string };
  calls?: { id: string; startedAt: string; sid?: string; materialId?: string }[];
}

export function casePlaybooks(state: PilotState): CasePlaybook[] {
  const custom = state.caseTools?.playbooks ?? [];
  const builtIn = defaultCatalog.filter(book => !custom.some(entry => entry.id === book.id)).map(book => ({
    ...book,
    scenarios: Object.fromEntries(Object.entries(book.scenarios).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    facts: (defaultFacts as Record<string, Record<string, string>>)[book.id],
    rules: (defaultRules as Record<string, Record<string, unknown>>)[book.id],
  }));
  return [...builtIn, ...custom];
}

const identifier = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,79}$/;
const safeKey = (id: string) => identifier.test(id) && !Object.hasOwn(Object.prototype, id);
const isObject = (input: unknown): input is Record<string, unknown> => !!input && typeof input === 'object' && !Array.isArray(input);
const isLabel = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 500;
const labels = (input: unknown) =>
  isObject(input) && Object.keys(input).length <= 100 && Object.entries(input).every(([key, value]) => safeKey(key) && isLabel(value));

export function validPlaybook(value: unknown): value is CasePlaybook {
  if (!isObject(value) || typeof value.id !== 'string' || !safeKey(value.id) || !isLabel(value.caseType) ||
      !labels(value.scenarios) || !Object.keys(value.scenarios as object).length ||
      (value.facts !== undefined && !labels(value.facts)) ||
      (value.rules !== undefined && (!isObject(value.rules) || JSON.stringify(value.rules).length > 60000)) ||
      !Array.isArray(value.documents) || value.documents.length > 100) return false;
  const ids = new Set();
  return value.documents.every(doc => {
    if (!isObject(doc) || typeof doc.id !== 'string' || !safeKey(doc.id) || !isLabel(doc.label) ||
        typeof doc.required !== 'boolean' || !Array.isArray(doc.scenarios) || !doc.scenarios.length ||
        !doc.scenarios.every(scenario => typeof scenario === 'string' && Object.hasOwn(value.scenarios as object, scenario)) ||
        ids.has(doc.id)) return false;
    ids.add(doc.id);
    return true;
  });
}

export function audioMime(bytes: Buffer) {
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'audio/mp3';
  return null;
}

export const AUDIO_LIMIT = 14 * 1024 * 1024;
