import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { PDFCheckBox, PDFDocument, PDFDropdown, StandardFonts, PageSizes } from 'pdf-lib';
import { AUTOFILL_FIELD_SEMANTIC_MAP, FORMS } from './formFields';
import type { Material, PilotState } from './store';
import factCatalog from './playbookFacts.json';
import { casePlaybooks } from './caseTools';

const identity: Record<string, string> = {
  familyName: 'beneficiary_family_name', givenName: 'beneficiary_given_name', dob: 'beneficiary_dob',
  nationality: 'beneficiary_nationality', aNumber: 'alien_registration_number', address: 'us_address',
  employer: 'employer_name', jobTitle: 'job_title', passportNo: 'passport_number',
  i94No: 'i94_number', status: 'current_nonimmigrant_status',
};
export const formKeys = Object.keys(FORMS) as (keyof typeof FORMS)[];
export type FormKey = keyof typeof FORMS;
export interface PetitionDraft {
  facts: Record<string, { value: string; source: string }>;
  followUps: string[];
  letter: string;
  exhibitIds: string[];
  overrides: Record<string, string>;
  formReviews: Partial<Record<FormKey, { digest: string; by: string; at: string }>>;
  packageReview?: { digest: string; by: string; at: string };
}

export function factDefinitions(state: PilotState) {
  const common = Object.fromEntries(Object.values(identity).map(key => [key, key.replaceAll('_', ' ')]));
  const selected = casePlaybooks(state).find(book => book.id === state.playbook?.id);
  return { ...common, ...(selected?.facts ?? (factCatalog as Record<string, Record<string, string>>)[state.playbook?.id ?? 'general_intake_v1']) };
}

export function petitionDraft(state: PilotState): PetitionDraft {
  return state.petition ?? { facts: {}, followUps: [], letter: '', exhibitIds: [], overrides: {}, formReviews: {} };
}

export function reviewForms(state: PilotState) {
  const draft = petitionDraft(state);
  const caseType = casePlaybooks(state).find(book => book.id === state.playbook?.id)?.caseType;
  const shared = new Map<string, { value: string; source: string }>();
  for (const [id, value] of Object.entries(draft.overrides)) {
    const semantic = AUTOFILL_FIELD_SEMANTIC_MAP[id];
    if (semantic) shared.set(semantic, { value, source: 'Attorney edit' });
  }
  return Object.fromEntries(formKeys.map(key => [key, FORMS[key].map(field => {
    const semantic = AUTOFILL_FIELD_SEMANTIC_MAP[field.fieldId];
    const factKey = identity[semantic];
    const fact = draft.facts[factKey];
    const answer = state.questionnaire.answers[factKey];
    let value = shared.get(semantic);
    if (!value && Object.hasOwn(draft.overrides, field.fieldId)) {
      value = { value: draft.overrides[field.fieldId], source: 'Attorney edit' };
    }
    if (!value && fact) value = fact;
    if (!value && answer) value = { value: answer, source: 'Questionnaire answer' };
    const derived = caseType ? field.caseTypeMap?.[caseType] : undefined;
    if (!value && derived) value = { value: derived, source: 'Selected playbook' };
    return { ...field, value: value?.value ?? '', source: value?.source ?? '' };
  })])) as Record<FormKey, Array<(typeof FORMS)[FormKey][number] & { value: string; source: string }>>;
}

export const fingerprint = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
export const formDigest = (rows: ReturnType<typeof reviewForms>[FormKey]) => fingerprint(rows.map(row => row.value));
export function packageDigest(state: PilotState) {
  const draft = petitionDraft(state);
  return fingerprint({
    letter: draft.letter, facts: draft.facts, followUps: draft.followUps,
    exhibits: draft.exhibitIds.map(id => state.materials.find(m => m.id === id)),
    playbook: state.playbook, questionnaire: state.questionnaire,
  });
}

const templateDir = [path.resolve(__dirname, '..', 'uscis-forms'), path.resolve(__dirname, '..', '..', 'uscis-forms')]
  .find(dir => fs.existsSync(dir));

export async function fillForm(key: FormKey, rows: ReturnType<typeof reviewForms>[FormKey]) {
  if (!templateDir) throw new Error('USCIS templates unavailable');
  const pdf = await PDFDocument.load(fs.readFileSync(path.join(templateDir, key.toLowerCase() + '.pdf')), { ignoreEncryption: true });
  const form = pdf.getForm();
  // The bundled templates have AcroForm fields alongside XFA data.
  if (form.hasXFA()) form.deleteXFA();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const row of rows) {
    if (!row.value) continue;
    try {
      if (row.type === 'text' && row.realField) {
        const field = form.getField(row.realField);
        if (field instanceof PDFDropdown) {
          const option = row.value.trim().toUpperCase();
          if (!field.getOptions().includes(option)) throw new Error('invalid dropdown option');
          field.select(option);
          field.updateAppearances(font);
          continue;
        }
        const text = form.getTextField(row.realField);
        text.setText(row.value);
        text.updateAppearances(font);
      } else if (row.type === 'select') {
        const option = row.options?.find(o => o.value === row.value);
        if (!option) throw new Error('invalid selection');
        form.getCheckBox(option.realField).check();
      } else if (row.type === 'toggle' && row.realField) {
        const yes = form.getCheckBox(row.realField);
        if (row.value === 'true') yes.check();
        else if (row.value === 'false') {
          yes.uncheck();
          const match = row.realField.match(/^(.*)\[(\d+)\]$/);
          if (match) {
            for (let index = 0; index <= 3; index++) {
              if (index === Number(match[2])) continue;
              const candidate = form.getFieldMaybe(match[1] + '[' + index + ']');
              if (candidate instanceof PDFCheckBox && candidate.acroField.getOnValue()?.toString() === '/N') {
                candidate.check();
                break;
              }
            }
          }
        } else throw new Error('invalid toggle');
      }
    } catch {
      throw new Error('Could not render form field ' + row.fieldId);
    }
  }
  return Buffer.from(await pdf.save({ updateFieldAppearances: false }));
}

export const packageTypes = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']);

export async function assemblePetition(letter: string, exhibits: { material: Material; bytes: Buffer }[]) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  function textPages(title: string, text: string) {
    let page = pdf.addPage(PageSizes.Letter);
    let y = 730;
    const add = (line: string) => {
      if (y < 54) { page = pdf.addPage(PageSizes.Letter); y = 730; }
      page.drawText(line, { x: 54, y, font, size: 11 });
      y -= 15;
    };
    add(title);
    add('');
    for (const paragraph of text.replaceAll('\r', '').split('\n')) {
      let line = '';
      for (const character of paragraph.replaceAll('\t', '    ')) {
        if (font.widthOfTextAtSize(line + character, 11) > 500) { add(line); line = ''; }
        line += character;
      }
      add(line);
    }
  }
  textPages('Attorney-reviewed petition package', ['Petition letter', ...exhibits.map(({ material }, i) =>
    'Exhibit ' + (i + 1) + ' - ' + material.filename)].join('\n'));
  const exhibitNumbers = new Map(exhibits.map(({ material }, i) => [material.id, i + 1]));
  const letterWithCitations = letter.replace(/\[([^\]]+)\]\(cite:([a-f0-9-]+)\)/g, (_match, label, id) => {
    const number = exhibitNumbers.get(id);
    if (!number) throw new Error('Letter cites an exhibit outside this package');
    return label + ' (Exhibit ' + number + ')';
  });
  textPages('Petition letter', letterWithCitations);
  for (const [index, { material, bytes }] of exhibits.entries()) {
    const title = 'Exhibit ' + (index + 1) + ' - ' + material.filename;
    if (material.mimeType === 'text/plain') { textPages(title, bytes.toString('utf8')); continue; }
    textPages(title, '');
    if (material.mimeType === 'application/pdf') {
      const source = await PDFDocument.load(bytes);
      for (const page of await pdf.copyPages(source, source.getPageIndices())) pdf.addPage(page);
    } else {
      const image = material.mimeType === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      const page = pdf.addPage(PageSizes.Letter);
      const size = image.scaleToFit(504, 684);
      page.drawImage(image, { x: 54, y: 738 - size.height, ...size });
    }
  }
  return Buffer.from(await pdf.save());
}
