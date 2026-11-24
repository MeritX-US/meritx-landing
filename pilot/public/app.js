// Minimal vanilla UI for the private pilot. All authorization is enforced server-side;
// this file only renders what the API returns for the signed-in role.
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => (k.startsWith('on') ? n.addEventListener(k.slice(2), v) : n.setAttribute(k, v)));
    kids.flat().forEach((k) => n.append(k instanceof Node ? k : document.createTextNode(String(k ?? ''))));
    return n;
  };
  async function api(method, url, body, isForm) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body && !isForm) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    if (isForm) opts.body = body;
    const r = await fetch(url, opts);
    const data = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
    if (!r.ok) throw Object.assign(new Error((data && data.error) || r.statusText), { status: r.status });
    return data;
  }
  const STATUSES = ['invited', 'intake', 'in_review', 'documents_needed', 'drafting', 'filed', 'closed'];
  const roleLabels = { enterprise: 'HR', lawyer: 'Attorney', employee: 'Employee', admin: 'Administrator' };
  const caseStatusLabels = {
    invited: 'Invitation pending', intake: 'Collecting information', in_review: 'Attorney review',
    documents_needed: 'Documents requested', drafting: 'Preparing application', filed: 'Filed', closed: 'Closed',
  };

  function questionnaireView(q, empty = 'No questionnaire answers yet.') {
    const titles = new Map(q.questions.map(question => [question.id, question.text]));
    const answers = Object.entries(q.answers).filter(([, answer]) => answer.trim());
    return el('div', {},
      el('p', { class: 'muted' }, q.submittedAt ? 'Submitted ' + new Date(q.submittedAt).toLocaleString() :
        answers.length ? 'Saved by the employee. Awaiting submission.' : empty),
      answers.length ? el('dl', { class: 'questionnaire-answers' }, answers.map(([id, answer]) =>
        el('div', {}, el('dt', {}, titles.get(id) || id.replace(/[_-]/g, ' ')), el('dd', {}, answer)))) :
        q.submittedAt ? el('p', { class: 'muted' }, 'No answers were provided.') : '');
  }

  function taskButton(text, run, feedback, attrs = {}) {
    const button = el('button', { type: 'button', ...attrs, onclick: async () => {
      button.disabled = true;
      feedback.textContent = '';
      try { await run(); }
      catch (error) { feedback.textContent = error.message; }
      finally { button.disabled = false; }
    } }, text);
    return button;
  }

  function consentPanel(base, consent, refresh) {
    const panel = el('section', { class: 'card' }, el('h3', {}, 'Case consent'));
    const document = consent.document;
    if (!document) {
      panel.append(el('p', { class: 'notice' }, 'Your attorney has not made the consent document available yet. Contact them to continue.'));
      return panel;
    }
    const feedback = el('p', { role: 'alert' });
    const agree = el('button', { class: 'button-primary', type: 'button', onclick: async () => {
      agree.disabled = true;
      try {
        await api('POST', base + '/consent', { agree: true, digest: document.digest });
        await refresh();
      } catch (error) { feedback.textContent = error.message; }
      finally { agree.disabled = false; }
    } }, 'I have read and agree');
    panel.append(el('p', { class: 'muted' }, document.preview ? 'Sample consent for the fictional preview' : 'Version ' + document.version),
      el('div', { class: 'consent-text' }, document.text), agree, feedback);
    return panel;
  }

  async function boot() {
    try {
      const me = await api('GET', '/api/me');
      $('#login').hidden = true; $('#app').hidden = false;
      $('#account').hidden = false;
      $('#synthetic-demo').hidden = !me.syntheticDemo;
      $('#who').textContent = `${me.name} · ${roleLabels[me.role] || me.role}`;
      try { await render(me); }
      catch (e) { $('#view').replaceChildren(el('p', { class: 'notice error', role: 'alert' }, e.message)); }
    } catch (e) {
      $('#app').hidden = true; $('#login').hidden = false;
      $('#account').hidden = true;
      $('#view').replaceChildren();
    }
  }

  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const submit = ev.target.querySelector('button[type=submit]');
    submit.disabled = true;
    $('#login-error').textContent = '';
    try { await api('POST', '/auth/login', { email: f.get('email'), password: f.get('password') }); ev.target.reset(); await boot(); }
    catch (e) { $('#login-error').textContent = e.status === 429 ? 'Too many attempts. Wait a moment and try again.' :
      e.status === 401 ? 'Check your email and password, then try again.' : 'Sign-in is unavailable. Try again in a moment.'; }
    finally { submit.disabled = false; }
  });
  $('#logout').addEventListener('click', async () => { await api('POST', '/auth/logout'); boot(); });

  function materialsTable(list, lawyer, base = '/api') {
    if (!list.length) return el('p', { class: 'muted' }, 'No materials uploaded.');
    const columns = lawyer ? ['File', 'Uploaded', 'Category', 'Download'] : ['File', 'Uploaded', 'Download'];
    const rows = list.map((m) => el('tr', {},
        el('td', {}, m.filename), el('td', {}, new Date(m.uploadedAt).toLocaleString()),
        lawyer ? [el('td', {}, el('input', { 'aria-label': `Category for ${m.filename}`, value: m.category || '', onchange: (e) => api('PUT', `/api/materials/${m.id}/category`, { category: e.target.value }) }))] : [],
        el('td', {}, el('button', { type: 'button', 'aria-label': 'Download ' + m.filename, onclick: async () => {
          // short-lived signed URL, bound to this session
          const { url } = await api('POST', `${base}/materials/${m.id}/download-url`); window.location.assign(url);
        } }, 'Download'))));
    return el('div', { class: 'table-scroll' }, el('table', {},
      el('thead', {}, el('tr', {}, columns.map(column => el('th', { scope: 'col' }, column)))), el('tbody', {}, rows)));
  }
  function uploadForm(after, base = '/api') {
    const input = el('input', { type: 'file', 'aria-label': 'File to upload' });
    const feedback = el('p', { role: 'status' });
    return el('div', {}, input, taskButton('Upload file', async () => {
      if (!input.files[0]) throw new Error('Choose a file to upload.');
      const fd = new FormData();
      fd.append('file', input.files[0]);
      await api('POST', base + '/materials', fd, true);
      const uploaded = input.files[0].name;
      input.value = '';
      await after();
      feedback.textContent = uploaded + ' uploaded.';
    }, feedback, { class: 'button-primary' }), feedback);
  }

  async function renderPlaybookChecklist(panel, base) {
    const url = base + '/playbook-checklist';
    panel.replaceChildren(el('h3', {}, 'Playbook checklist'),
      el('p', { class: 'muted' }, 'Choose a playbook and filing scenario to see which documents to collect.'));
    const feedback = el('p', { role: 'status' });
    panel.append(feedback);
    try {
      const { catalog, selection, documents, materials, classifyAvailable } = await api('GET', url);
      const playbook = el('select', { required: '' }, el('option', { value: '' }, 'Select a playbook'),
        catalog.map(p => el('option', { value: p.id }, p.caseType === 'unknown' ? 'General intake' : p.caseType)));
      const scenario = el('select', { required: '' });
      function updateScenarios() {
        const selected = catalog.find(p => p.id === playbook.value);
        scenario.replaceChildren(el('option', { value: '' }, 'Select a scenario'),
          ...Object.entries(selected?.scenarios || {}).map(([id, name]) => el('option', { value: id }, name)));
      }
      playbook.value = selection?.id || '';
      updateScenarios();
      scenario.value = selection?.scenario || '';
      playbook.addEventListener('change', updateScenarios);
      const save = el('button', {}, 'Apply playbook');
      panel.append(el('form', { onsubmit: async ev => {
        ev.preventDefault();
        save.disabled = true;
        try {
          await api('PUT', url, { id: playbook.value, scenario: scenario.value });
          await renderPlaybookChecklist(panel, base);
        } catch (e) { feedback.textContent = e.message; }
        finally { save.disabled = false; }
      } }, el('label', {}, 'Playbook', playbook), el('label', {}, 'Scenario', scenario), save));
      if (!selection || !documents.length) return;

      const outstanding = documents.filter(d => d.required && !materials.some(m => m.documentId === d.id)).length;
      panel.append(el('p', {}, outstanding + ' required checklist items awaiting a linked file.'),
        el('ul', {}, documents.map(d => {
          const linked = materials.filter(m => m.documentId === d.id).map(m => m.filename);
          return el('li', {}, d.label, ' (' + (d.required ? 'required' : 'optional') + ')',
            linked.length ? ' · ' + linked.join(', ') : ' · No file linked');
        })));
      if (!materials.length) return;
      const file = el('select', {}, materials.map(m => el('option', { value: m.id }, m.filename)));
      const item = el('select', {}, el('option', { value: '' }, 'No linked item'),
        documents.map(d => el('option', { value: d.id }, d.label)));
      function showLink() {
        item.value = materials.find(m => m.id === file.value).documentId || '';
        if (item.selectedIndex < 0) item.value = '';
      }
      file.addEventListener('change', showLink);
      showLink();
      const link = el('button', {}, 'Save file link');
      panel.append(el('form', { onsubmit: async ev => {
        ev.preventDefault();
        link.disabled = true;
        try {
          await api('PUT', url + '/materials/' + file.value, {
            playbookId: selection.id, scenario: selection.scenario, documentId: item.value || null,
          });
          await renderPlaybookChecklist(panel, base);
        } catch (e) { feedback.textContent = e.message; }
        finally { link.disabled = false; }
      } }, el('label', {}, 'Uploaded file', file), el('label', {}, 'Checklist item', item), link));
      if (classifyAvailable && materials.some(m => m.classifiable)) {
        const candidates = materials.filter(m => m.classifiable).map(m => {
          const input = el('input', { type: 'checkbox' });
          return { id: m.id, input, label: el('label', {}, input, ' ', m.filename) };
        });
        const suggestions = el('div');
        const classify = el('button', { type: 'button', onclick: async () => {
          classify.disabled = true;
          try {
            const materialIds = candidates.filter(candidate => candidate.input.checked).map(candidate => candidate.id);
            const result = await api('POST', base + '/case-tools/ai/classify', { materialIds });
            suggestions.replaceChildren(...result.links.map(proposal => {
              const material = materials.find(m => m.id === proposal.materialId);
              const doc = documents.find(d => d.id === proposal.documentId);
              const apply = el('button', { type: 'button', onclick: async () => {
                apply.disabled = true;
                try {
                  await api('PUT', url + '/materials/' + material.id, {
                    playbookId: selection.id, scenario: selection.scenario, documentId: doc.id,
                  });
                  apply.textContent = 'Applied';
                  refresh.disabled = false;
                } catch (error) { feedback.textContent = error.message; }
                finally { apply.disabled = apply.textContent === 'Applied'; }
              } }, 'Apply link');
              return el('p', {}, material.filename + ' → ' + doc.label, ' ', apply);
            }));
            if (!result.links.length) suggestions.textContent = 'No matching checklist items suggested.';
          } catch (error) { feedback.textContent = error.message; }
          finally { classify.disabled = false; }
        } }, 'Suggest file classifications');
        const refresh = el('button', { type: 'button', disabled: '', onclick: () => renderPlaybookChecklist(panel, base) }, 'Refresh checklist');
        panel.append(el('fieldset', {}, el('legend', {}, 'Files to send for classification'), candidates.map(candidate => candidate.label),
          classify, suggestions, refresh));
      }
    } catch (e) { feedback.textContent = e.message; }
  }

  async function openPetition(panel, base) {
    const url = base + '/petition';
    panel.replaceChildren(el('h3', {}, 'Petition preparation'));
    const feedback = el('p', { role: 'status' });
    panel.append(feedback);
    const reload = () => openPetition(panel, base);
    const action = (text, run) => {
      const button = el('button', { type: 'button', onclick: async () => {
        button.disabled = true;
        feedback.textContent = '';
        try { await run(); } catch (e) { feedback.textContent = e.message; }
        finally { button.disabled = false; }
      } }, text);
      return button;
    };
    try {
      const draft = await api('GET', url);
      const { questions } = await api('GET', base + '/questionnaire');
      const sources = [
        ...draft.materials.map(file => [file.id, file.filename]),
        ...questions.map(question => ['answer:' + question.id, 'Questionnaire: ' + question.text]),
        ['consultation', 'Consultation transcript'],
      ];
      const factInputs = Object.entries(draft.fields).map(([id, title]) => {
        const value = el('input', { value: draft.facts[id]?.value || '', maxlength: 2000 });
        const source = el('select', {}, el('option', { value: '' }, 'Attorney entry'),
          sources.map(([key, name]) => el('option', { value: key }, name)), el('option', { value: '__other' }, 'Other source'));
        const other = el('input', { maxlength: 300 });
        const otherLabel = el('label', { hidden: '' }, 'Describe the source', other);
        source.addEventListener('change', () => { otherLabel.hidden = source.value !== '__other'; });
        function setSource(reference) {
          const known = sources.some(([key]) => key === reference);
          source.value = known ? reference : reference && reference !== 'Attorney entry' ? '__other' : '';
          other.value = source.value === '__other' ? reference : '';
          otherLabel.hidden = source.value !== '__other';
        }
        setSource(draft.facts[id]?.source);
        const box = el('div', {}, el('label', {}, title, value), el('label', {}, 'Source for ' + title, source), otherLabel);
        return { id, value, setSource, getSource: () => (source.value === '__other' ? other.value.trim() : source.value) || 'Attorney entry', box };
      });
      const followUps = el('textarea', { rows: 4 }, draft.followUps.join('\n'));
      const letter = el('textarea', { rows: 12, maxlength: 50000 }, draft.letter);
      function choices(title, items, selected) {
        const inputs = items.map(m => {
          const input = el('input', { type: 'checkbox', value: m.id });
          input.checked = selected.includes(m.id);
          return { input, label: el('label', {}, input, ' ', m.filename) };
        });
        return { box: el('fieldset', {}, el('legend', {}, title), inputs.length ? inputs.map(row => row.label) :
          el('p', { class: 'muted' }, 'No supported files are available for selection.')),
          values: () => inputs.filter(row => row.input.checked).map(row => row.input.value) };
      }
      if (draft.aiAvailable) {
        const inputs = choices('Files to send to the configured AI provider',
          draft.materials.filter(m => m.packageSupported), []);
        const useTranscript = el('input', { type: 'checkbox' });
        panel.append(inputs.box, el('label', {}, useTranscript, ' Include saved consultation transcript'), action('Extract draft facts and letter', async () => {
          const result = await api('POST', url + '/extract', { materialIds: inputs.values(), includeTranscript: useTranscript.checked });
          for (const field of factInputs) {
            const fact = result.facts[field.id];
            if (!fact) continue;
            field.value.value = fact.value;
            field.setSource(fact.source);
          }
          followUps.value = result.followUps.join('\n');
          letter.value = result.letter;
          feedback.textContent = 'Draft populated. Review the sources and save the changes.';
        }));
      }
      const exhibits = choices('Exhibits in the package', draft.materials.filter(m => m.packageSupported), draft.exhibitIds);
      panel.append(el('details', {}, el('summary', {}, 'Facts and sources'),
        el('p', { class: 'muted' }, 'Choose a source for each fact you enter.'),
        factInputs.map(row => row.box)),
        el('label', {}, 'Follow-up questions, one per line', followUps),
        el('label', {}, 'Petition letter draft', letter), exhibits.box);
      if (draft.aiAvailable) {
        const instruction = el('input', { maxlength: 5000 });
        const tools = base + '/case-tools/ai/';
        panel.append(el('label', {}, 'AI revision instructions', instruction),
          action('Rewrite selected passage', async () => {
            const start = letter.selectionStart;
            const end = letter.selectionEnd;
            const original = letter.value;
            if (start === end) throw new Error('Select a passage in the petition letter first.');
            const result = await api('POST', tools + 'refine', { text: original.slice(start, end), instruction: instruction.value });
            if (letter.value !== original) throw new Error('The letter changed while the rewrite was running.');
            letter.setRangeText(result.text, start, end, 'select');
            feedback.textContent = 'Review the rewritten passage before saving.';
          }),
          action('Regenerate letter from saved facts', async () => {
            if (letter.value !== draft.letter && !window.confirm('Replace unsaved changes to the letter?')) return;
            const original = letter.value;
            const result = await api('POST', tools + 'regenerate', { instruction: instruction.value });
            if (letter.value !== original) throw new Error('The letter changed while regeneration was running.');
            letter.value = result.text;
            feedback.textContent = 'Review the replacement letter before saving.';
          }));
      }
      function edits() {
        const facts = Object.fromEntries(factInputs.filter(row => row.value.value.trim()).map(row =>
          [row.id, { value: row.value.value.trim(), source: row.getSource() }]));
        return { revision: draft.revision, facts, letter: letter.value,
          followUps: followUps.value.split('\n').map(line => line.trim()).filter(Boolean), exhibitIds: exhibits.values() };
      }
      const initialEdits = JSON.stringify(edits());
      panel.append(action('Save petition draft', async () => { await api('PUT', url, edits()); await reload(); }));
      if (draft.letter.trim()) panel.append(action('Sign off on saved package', async () => {
        if (JSON.stringify(edits()) !== initialEdits) throw new Error('Save your package edits before signing off.');
        await api('POST', url + '/review', { revision: draft.revision }); await reload();
      }));
      if (draft.reviewed) panel.append(el('a', { href: url + '/pdf' }, 'Download reviewed package PDF'));

      const formKey = el('select', { 'aria-label': 'USCIS form' }, draft.formKeys.map(key => el('option', { value: key }, key)));
      const formPanel = el('div');
      panel.append(el('h4', {}, 'USCIS forms'), formKey, action('Open form', () => showForm(formKey.value)), formPanel);
      let formRequest = 0;
      async function showForm(key) {
        const request = ++formRequest;
        const openGroups = new Set(Array.from(formPanel.querySelectorAll('details[open] summary'), node => node.textContent));
        const formUrl = url + '/forms/' + key;
        const data = await api('GET', formUrl);
        if (request !== formRequest) return;
        const fields = data.rows.map(row => {
          const options = row.type === 'toggle' ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] : row.options;
          const input = options
            ? el('select', {}, el('option', { value: '' }, 'Blank'), options.map(option => el('option', { value: option.value }, option.label)))
            : el('input', { maxlength: 2000 });
          input.value = row.value;
          if (row.required !== false) input.setAttribute('aria-required', 'true');
          return { row, input, label: el('label', {}, row.part + ' · ' + row.name + (row.required !== false ? ' *' : ''), input,
            row.source ? el('small', {}, row.source) : '') };
        });
        const groups = new Map();
        for (const field of fields) {
          const name = field.row.part.split(',')[0];
          if (!groups.has(name)) groups.set(name, []);
          groups.get(name).push(field.label);
        }
        const formFeedback = el('p', { role: 'alert' });
        const sections = Array.from(groups, ([name, rows]) => el('details',
          openGroups.has(name) ? { open: '' } : {}, el('summary', {}, name), rows));
        if (sections.length && !openGroups.size) sections[0].open = true;
        formPanel.replaceChildren(el('h4', {}, key), el('p', {}, 'Review all fields. An asterisk marks a field required for sign-off.'),
          ...sections,
          action('Save form edits', async () => {
            const changes = Object.fromEntries(fields.filter(({ row, input }) => row.value !== input.value).map(({ row, input }) => [row.fieldId, input.value]));
            await api('PUT', formUrl, { revision: data.revision, changes }); await showForm(key);
          }),
          action('Sign off on saved form', async () => {
            formFeedback.textContent = '';
            const missing = fields.find(({ row, input }) => row.required !== false && !input.value.trim());
            if (missing) {
              missing.input.closest('details').open = true;
              missing.input.setAttribute('aria-invalid', 'true');
              formFeedback.textContent = 'Complete the required form fields before sign-off. Start with ' + missing.row.name + '.';
              missing.input.focus();
              return;
            }
            if (fields.some(({ row, input }) => row.value !== input.value)) {
              formFeedback.textContent = 'Save your form edits before signing off.';
              return;
            }
            try { await api('POST', formUrl + '/review', { revision: data.revision }); await showForm(key); }
            catch (error) { formFeedback.textContent = error.message; }
          }),
          formFeedback,
          data.reviewed ? el('a', { href: formUrl + '/pdf' }, 'Download reviewed ' + key + ' PDF') : '');
      }
    } catch (e) { feedback.textContent = e.message; }
  }

  function petitionPanel(base) {
    const panel = el('section', { id: 'petition-tools', class: 'card', tabindex: '-1' });
    panel.append(el('h3', {}, 'Petition preparation'),
      el('button', { type: 'button', onclick: () => openPetition(panel, base) }, 'Open petition preparation'));
    return panel;
  }

  function playbookForm(book) {
    const id = el('input', { required: '', maxlength: 80, pattern: '[a-zA-Z0-9_][a-zA-Z0-9_\\-]{0,79}', value: book.id });
    const caseType = el('input', { required: '', maxlength: 500, value: book.caseType });
    const scenarios = Object.entries(book.scenarios).map(([key, name]) => ({ key, name }));
    const documents = book.documents.map(doc => ({ ...doc, scenarios: [...doc.scenarios] }));
    const facts = Object.entries(book.facts || {}).map(([key, name]) => ({ key, name }));
    const rules = el('textarea', { rows: 8, 'aria-label': 'Advanced rules JSON' }, JSON.stringify(book.rules || {}, null, 2));
    const scenarioRows = el('div');
    const documentRows = el('div');
    const factRows = el('div');
    const input = (value, save, maxlength = 500) => el('input', { value, maxlength, required: '', oninput: event => save(event.target.value) });
    const remove = callback => el('button', { type: 'button', onclick: callback }, 'Remove');
    function renderDocuments() {
      documentRows.replaceChildren(...documents.map((doc, index) => {
        const required = el('input', { type: 'checkbox', onchange: event => { doc.required = event.target.checked; } });
        required.checked = doc.required;
        const applicability = scenarios.map(entry => {
          const checked = el('input', { type: 'checkbox', onchange: event => {
            doc.scenarios = event.target.checked ? [...doc.scenarios, entry.key] : doc.scenarios.filter(key => key !== entry.key);
          } });
          checked.checked = doc.scenarios.includes(entry.key);
          return el('label', {}, checked, ' ', entry.name || entry.key);
        });
        return el('fieldset', { class: 'playbook-row' }, el('legend', {}, 'Document ' + (index + 1)),
          el('label', {}, 'Document name', input(doc.label, name => { doc.label = name; })),
          el('label', {}, 'Document ID', input(doc.id, value => { doc.id = value; }, 80)),
          el('label', {}, required, ' Required'), el('p', {}, 'Applies to'), applicability,
          remove(() => { documents.splice(index, 1); renderDocuments(); }));
      }));
    }
    function renderScenarios() {
      scenarioRows.replaceChildren(...scenarios.map((entry, index) => el('div', { class: 'playbook-inline' },
        el('label', {}, 'Scenario name', input(entry.name, name => { entry.name = name; })),
        remove(() => {
          scenarios.splice(index, 1);
          for (const doc of documents) doc.scenarios = doc.scenarios.filter(key => key !== entry.key);
          renderScenarios();
          renderDocuments();
        }))));
    }
    scenarioRows.addEventListener('change', renderDocuments);
    function renderFacts() {
      factRows.replaceChildren(...facts.map((entry, index) => el('div', { class: 'playbook-inline' },
        el('label', {}, 'Fact name', input(entry.name, name => { entry.name = name; })),
        el('label', {}, 'Fact ID', input(entry.key, key => { entry.key = key; }, 80)),
        remove(() => { facts.splice(index, 1); renderFacts(); }))));
    }
    const add = (text, run) => el('button', { type: 'button', onclick: run }, text);
    renderScenarios();
    renderDocuments();
    renderFacts();
    const view = el('form', { onsubmit: event => event.preventDefault() },
      el('label', {}, 'Playbook ID', id), el('label', {}, 'Case type', caseType),
      el('details', {}, el('summary', {}, 'Scenarios'), scenarioRows, add('Add scenario', () => {
        scenarios.push({ key: 'scenario_' + crypto.randomUUID().slice(0, 8), name: '' });
        renderScenarios();
        renderDocuments();
        scenarioRows.querySelector('div:last-child input')?.focus();
      })),
      el('details', {}, el('summary', {}, 'Document checklist'), documentRows, add('Add document', () => {
        documents.push({ id: 'document_' + crypto.randomUUID().slice(0, 8), label: '', required: true, scenarios: scenarios.map(entry => entry.key) });
        renderDocuments();
      })),
      el('details', {}, el('summary', {}, 'Facts to collect'), factRows, add('Add fact', () => {
        facts.push({ key: 'fact_' + crypto.randomUUID().slice(0, 8), name: '' });
        renderFacts();
      })),
      el('details', {}, el('summary', {}, 'Advanced rules'), el('label', {}, 'Rules JSON', rules)));
    function read() {
      const invalid = view.querySelector(':invalid');
      if (invalid instanceof HTMLInputElement) {
        const detail = invalid.closest('details');
        if (detail) detail.open = true;
        invalid.reportValidity();
        throw new Error('Complete the highlighted playbook field.');
      }
      if (!scenarios.length) throw new Error('Add at least one scenario.');
      if (new Set(documents.map(doc => doc.id)).size !== documents.length || new Set(facts.map(fact => fact.key)).size !== facts.length)
        throw new Error('Document and fact IDs must be unique.');
      const missing = documents.find(doc => !doc.scenarios.length);
      if (missing) throw new Error('Select at least one scenario for ' + missing.label + '.');
      return { id: id.value.trim(), caseType: caseType.value.trim(), scenarios: Object.fromEntries(scenarios.map(entry => [entry.key, entry.name.trim()])),
        documents: documents.map(doc => ({ ...doc, label: doc.label.trim() })),
        facts: Object.fromEntries(facts.map(entry => [entry.key.trim(), entry.name.trim()])), rules: JSON.parse(rules.value) };
    }
    return { view, read, focusId: () => id.focus() };
  }

  function caseToolsPanel(base, refreshChecklist) {
    const panel = el('section', { id: 'case-tools', class: 'card', tabindex: '-1' });
    panel.append(el('h3', {}, 'Consultation and playbooks'),
      el('button', { type: 'button', onclick: load }, 'Open consultation and playbook tools'));
    const url = base + '/case-tools';
    async function load() {
      const feedback = el('p', { role: 'status' });
      panel.replaceChildren(el('h3', {}, 'Consultation and playbook tools'), feedback);
      const button = (text, run) => {
        const control = el('button', { type: 'button', onclick: async () => {
          control.disabled = true;
          feedback.textContent = '';
          try { await run(); } catch (error) { feedback.textContent = error.message; }
          finally { control.disabled = false; }
        } }, text);
        return control;
      };
      const ai = (task, body) => api('POST', url + '/ai/' + task, body);
      try {
        const data = await api('GET', url);
        const transcript = el('textarea', { rows: 8, maxlength: 90000 }, data.consultation?.transcript || '');
        const summary = el('textarea', { rows: 4, maxlength: 20000 }, data.consultation?.summary || '');
        const audioFile = el('input', { type: 'file', accept: '.wav,.mp3' });
        const recordings = data.materials.filter(file => file.mimeType.startsWith('audio/'));
        const audio = el('select', {}, el('option', { value: '' }, 'Select a recording'),
          recordings.map(file => el('option', { value: file.id }, file.filename)));
        const consultation = el('details', {}, el('summary', {}, 'Consultation'),
          el('label', {}, 'Upload MP3 or WAV', audioFile), button('Save recording to case', async () => {
            if (!audioFile.files[0]) throw new Error('Select a recording.');
            const form = new FormData();
            form.append('audio', audioFile.files[0]);
            const uploaded = await api('POST', url + '/audio', form, true);
            audio.append(el('option', { value: uploaded.id }, audioFile.files[0].name));
            audio.value = uploaded.id;
            audioFile.value = '';
            refreshChecklist();
          }), el('label', {}, 'Saved recording', audio),
          el('label', {}, 'Transcript', transcript), el('label', {}, 'Summary', summary),
          button('Save consultation notes', async () => {
            const response = await api('PUT', url + '/consultation', { revision: data.revision, transcript: transcript.value, summary: summary.value });
            data.revision = response.revision;
            feedback.textContent = 'Consultation notes saved.';
          }));
        if (data.ai && data.consent) {
          if (data.audioAndSearch) consultation.append(button('Transcribe recording', async () => {
            if (!audio.value) throw new Error('Select a recording.');
            const result = await ai('transcribe', { materialIds: [audio.value] });
            transcript.value = result.text;
          }));
          consultation.append(button('Summarize transcript', async () => {
            if (!transcript.value.trim()) throw new Error('Provide a transcript.');
            summary.value = (await ai('summarize', { text: transcript.value })).text.slice(0, 20000);
          }));
        }
        if (data.phone) {
          const phone = el('input', { type: 'tel', placeholder: '+1…' });
          const agreed = el('input', { type: 'checkbox' });
          const calls = el('ul', {});
          function showCall(call) {
            const item = el('li', {}, new Date(call.startedAt).toLocaleString(), ' ');
            if (call.materialId) item.append('Recording imported');
            else if (call.queued) item.append(button('Import call recording', async () => {
              const result = await api('POST', url + '/calls/' + call.id + '/import');
              audio.append(el('option', { value: result.id }, 'Consultation call'));
              audio.value = result.id;
              item.replaceChildren('Recording imported');
              data.revision = (await api('GET', url)).revision;
              refreshChecklist();
            }));
            else item.append('Call unconfirmed');
            calls.append(item);
          }
          data.calls.forEach(showCall);
          consultation.append(el('label', {}, 'Client phone', phone),
            el('label', {}, agreed, ' All participants agreed to recording'),
            button('Call lawyer and connect client', async () => {
              if (!agreed.checked || !data.consent) throw new Error('Record case consent and confirm recording permission first.');
              const call = await api('POST', url + '/calls', { phone: phone.value.trim(), recordingAgreed: true });
              showCall({ ...call, queued: true, startedAt: new Date().toISOString() });
              data.revision = (await api('GET', url)).revision;
              agreed.checked = false;
            }), calls);
        }
        panel.append(consultation);

        const selected = el('select', {}, data.playbooks.map(book => el('option', { value: book.id }, book.caseType)));
        selected.value = data.selection?.id || selected.value;
        const editorPanel = el('div');
        let editor;
        function editBook(book) {
          editor = playbookForm(book);
          editorPanel.replaceChildren(editor.view);
        }
        const loadBook = () => editBook(data.playbooks.find(book => book.id === selected.value));
        selected.addEventListener('change', loadBook);
        loadBook();
        const playbook = el('details', {}, el('summary', {}, 'Playbook editor'),
          el('label', {}, 'Base playbook', selected),
          button('Create playbook from template', () => {
            const copy = editor.read();
            copy.id = copy.id.slice(0, 65) + '-copy-' + crypto.randomUUID().slice(0, 8);
            editBook(copy);
            editor.focusId();
            feedback.textContent = 'Review the copy and save it to this case.';
          }), editorPanel,
          button('Save playbook to case', async () => {
            const book = editor.read();
            const result = await api('PUT', url + '/playbook', { playbook: book, revision: data.revision });
            data.revision = result.revision;
            const index = data.playbooks.findIndex(entry => entry.id === book.id);
            if (index < 0) {
              data.playbooks.push(book);
              selected.append(el('option', { value: book.id }, book.caseType));
            } else {
              data.playbooks[index] = book;
              Array.from(selected.options).find(option => option.value === book.id).textContent = book.caseType;
            }
            selected.value = book.id;
            refreshChecklist();
            feedback.textContent = 'Playbook saved. Choose it in the checklist to use it.';
          }));
        if (data.ai) {
          const sample = el('textarea', { maxlength: 20000 });
          const request = el('input', { maxlength: 5000 });
          const preview = el('pre');
          playbook.append(el('label', {}, 'Synthetic facts for simulation', sample),
            button('Simulate playbook', async () => {
              preview.textContent = (await ai('simulate', { playbook: editor.read(), text: sample.value })).text;
            }), el('label', {}, 'Copilot instructions', request), button('Suggest playbook changes', async () => {
              const result = await ai('copilot', { playbook: editor.read(), instruction: request.value });
              editBook(result.playbook);
              feedback.textContent = 'Review suggested edits before saving.';
            }), preview);
        }
        panel.append(playbook);
        if (data.ai && data.audioAndSearch) {
          const topic = el('input', { maxlength: 2000 });
          const output = el('div');
          panel.append(el('details', {}, el('summary', {}, 'Public research'),
            el('label', {}, 'Public topic (exclude private case details)', topic),
            button('Search public sources', async () => {
              const result = await ai('research', { text: topic.value });
              output.replaceChildren(el('pre', {}, result.text), el('ul', {}, result.sources.map(source =>
                el('li', {}, el('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer' }, source.title)))));
            }), output));
        }
      } catch (error) { feedback.textContent = error.message; }
    }
    return panel;
  }

  function questionnaireEditor(q, base) {
    const feedback = el('p', { role: 'status' });
    const state = el('p', { class: 'muted' });
    const showState = () => {
      state.textContent = q.submittedAt ? 'Submitted to your attorney on ' + new Date(q.submittedAt).toLocaleString() + '.' :
        'Save your work and return later, or submit your answers to your attorney.';
      draftButton.hidden = !!q.submittedAt;
      submitButton.textContent = q.submittedAt ? 'Update submitted answers' : 'Submit to attorney';
    };
    const form = el('form', { onsubmit: event => event.preventDefault() }, q.questions.map(question =>
      el('label', {}, question.text, el('textarea', { name: question.id }, q.answers[question.id] || ''))));
    let saving = false;
    const save = submit => async () => {
      if (saving) return;
      saving = true;
      try {
        await api('PUT', base + '/questionnaire', { answers: Object.fromEntries(new FormData(form)), submit });
        const current = await api('GET', base + '/questionnaire');
        q.submittedAt = current.submittedAt;
        showState();
        feedback.textContent = submit ? 'Answers submitted.' : 'Answers saved.';
      } finally { saving = false; }
    };
    const draftButton = taskButton('Save draft', save(false), feedback);
    const submitButton = taskButton('Submit to attorney', save(true), feedback, { class: 'button-primary' });
    showState();
    return el('div', {}, state, form, draftButton, submitButton, feedback);
  }

  function documentRequestsPanel(base, lawyer, files) {
    const panel = el('section', { class: 'intake-section', id: 'document-requests', tabindex: '-1' });
    const endpoint = base + '/document-requests';
    const feedback = el('p', { role: 'status' });
    const list = el('div', { class: 'document-requests-list' });
    const chosen = new Map();
    panel.append(el('h2', {}, 'Document requests'), feedback, list);
    const statusText = { requested: 'Waiting for employee', submitted: 'Waiting for attorney review',
      returned: 'Needs replacement', accepted: 'Accepted', canceled: 'Canceled' };
    async function load() {
      try {
        const { requests, closed } = await api('GET', endpoint);
        const items = lawyer ? requests : requests.filter(item => item.status !== 'canceled');
        list.replaceChildren(...(items.length ? items.map(item => renderItem(item, closed)) :
          [el('p', { class: 'muted' }, 'No additional documents requested.')]));
        sendForm.hidden = !lawyer || closed;
        if (closed) feedback.textContent = 'This case is closed.';
      } catch (error) { feedback.textContent = error.message; }
    }
    function renderItem(item, closed) {
      const rowFeedback = el('p', { role: 'status' });
      const state = item.status;
      const card = el('article', { class: 'enterprise-request' },
        el('div', { class: 'enterprise-request-heading' }, el('h3', {}, item.title),
          el('span', { class: 'status-pill', 'data-status': state }, statusText[state])),
        item.instructions ? el('p', {}, item.instructions) : '',
        item.feedback ? el('p', { class: 'notice' }, 'Attorney feedback · ' + item.feedback) : '');
      const submitted = item.materialIds.map(id => files.find(file => file.id === id)).filter(Boolean);
      if (submitted.length) card.append(el('ul', {}, submitted.map(file =>
        el('li', {}, file.filename, ' ', taskButton('Download', async () => {
          const { url } = await api('POST', base + '/materials/' + file.id + '/download-url');
          window.location.assign(url);
        }, rowFeedback, { 'aria-label': 'Download ' + file.filename })))));
      const needsFile = state === 'requested' || state === 'returned';
      if (lawyer && !closed) {
        const note = el('textarea', { maxlength: 1000 });
        const review = (decision, text, attrs) => taskButton(text, async () => {
          if (decision === 'returned' && !note.value.trim()) { note.focus(); throw new Error('Enter a reason for returning these files.'); }
          await api('PUT', endpoint + '/' + item.id + '/review', { decision, feedback: note.value, revision: item.revision });
          await load();
          feedback.textContent = decision === 'accepted' ? 'Documents accepted.' :
            decision === 'returned' ? 'Request returned to the employee.' : 'Document request canceled.';
        }, rowFeedback, attrs);
        if (state === 'submitted') card.append(review('accepted', 'Accept documents', { class: 'button-primary' }),
          el('label', {}, 'Instructions if returning', note), review('returned', 'Return to employee'));
        else if (needsFile) card.append(review('canceled', 'Cancel request'));
      }
      if (!lawyer && needsFile && !closed) {
        card.append(el('p', {}, 'Select the files that answer this request. You can also ', el('a', { href: '#supporting-files' }, 'upload a new file'), '.'));
        if (files.length) {
          const selected = chosen.get(item.id) ?? new Set();
          chosen.set(item.id, selected);
          const checks = files.map(file => {
            const input = el('input', { type: 'checkbox', onchange: () => {
              if (input.checked) selected.add(file.id);
              else selected.delete(file.id);
            } });
            input.checked = selected.has(file.id);
            return el('label', {}, input, ' ', file.filename);
          });
          card.append(el('fieldset', {}, el('legend', {}, 'Files for ' + item.title), checks),
            taskButton('Submit selected files', async () => {
              if (!selected.size) throw new Error('Select at least one file to submit.');
              await api('PUT', endpoint + '/' + item.id + '/submit', { materialIds: [...selected], revision: item.revision });
              chosen.delete(item.id);
              await load();
              feedback.textContent = 'Files sent to your attorney.';
            }, rowFeedback, { class: 'button-primary' }));
        }
      }
      card.append(rowFeedback);
      return card;
    }
    const title = el('input', { maxlength: 120, required: '' });
    const instructions = el('textarea', { maxlength: 1000 });
    const sendForm = el('details', { hidden: '' }, el('summary', {}, 'Request a document'),
      el('label', {}, 'Document name', title), el('label', {}, 'Instructions for the employee', instructions),
      taskButton('Send document request', async () => {
        if (!title.value.trim()) { title.focus(); throw new Error('Enter a document name.'); }
        await api('POST', endpoint, { title: title.value, instructions: instructions.value });
        title.value = instructions.value = '';
        sendForm.open = false;
        await load();
        feedback.textContent = 'Document request sent to the employee.';
      }, feedback, { class: 'button-primary' }));
    panel.append(sendForm);
    return { panel, load, updateFiles: next => { files = next; return load(); } };
  }

  async function openIntake(me, row) {
    const base = '/api/draft-matters/' + row.id + '/intake';
    const panel = el('section', { class: 'card' });
    $('#view').replaceChildren(panel);
    panel.append(el('button', { onclick: () => me.role === 'lawyer' ? openDraftRegister(me, row.id) : render(me) },
      me.role === 'lawyer' ? 'All cases and requests' : 'Back to my cases'), el('h1', {}, row.label));
    if (me.role === 'lawyer') panel.append(workspaceTools(true));
    const refresh = () => openIntake(me, row);
    try {
      const consent = await api('GET', base + '/consent');
      if (me.role === 'employee' && !consent.signed) {
        panel.append(el('p', { class: 'muted' }, 'First, review the consent. Then answer the questionnaire and upload any supporting files.'));
        panel.append(consentPanel(base, consent, refresh));
        return;
      }
      const q = await api('GET', base + '/questionnaire');
      const files = await api('GET', base + '/materials');
      const isEmployee = me.role === 'employee';
      const documents = el('div', {}, materialsTable(files, false, base));
      const requests = documentRequestsPanel(base, !isEmployee, files);
      panel.append(requests.panel, el('section', { class: 'intake-section' },
        el('h2', {}, isEmployee ? 'Questionnaire' : 'Employee questionnaire'),
        isEmployee ? questionnaireEditor(q, base) : questionnaireView(q)),
        el('section', { class: 'intake-section', id: 'supporting-files', tabindex: '-1' }, el('h2', {}, 'Supporting files'),
          isEmployee ? el('p', { class: 'muted' }, 'Upload any files your attorney asked for.') : '', documents,
          isEmployee ? uploadForm(async () => {
            const updated = await api('GET', base + '/materials');
            documents.replaceChildren(materialsTable(updated, false, base));
            await requests.updateFiles(updated);
          }, base) : ''));
      await requests.load();
      if (me.role === 'lawyer') {
        const checklist = el('section', { id: 'playbook-tools', tabindex: '-1' });
        panel.append(checklist, petitionPanel(base), caseToolsPanel(base, () => renderPlaybookChecklist(checklist, base)));
        renderPlaybookChecklist(checklist, base);
      }
    } catch (e) { panel.append(el('p', { role: 'alert' }, e.message)); }
  }

  async function showInvitations(me, container) {
    try {
      const rows = await api('GET', '/api/matter-invitations');
      if (!rows.length) container.append(el('h3', {}, 'No case invitations yet'),
        el('p', { class: 'muted' }, 'When your attorney invites you, the case will appear here.'),
        el('button', { type: 'button', onclick: () => render(me) }, 'Check for invitations'));
      for (const row of rows.sort((a, b) => Number(a.accepted) - Number(b.accepted))) {
        const feedback = el('p', { role: 'status' });
        container.append(el('article', { class: 'enterprise-request' }, el('h3', {}, row.label),
          el('p', { class: row.pendingDocuments ? 'notice' : 'muted' }, row.pendingDocuments
            ? row.pendingDocuments + (row.pendingDocuments === 1 ? ' document request needs your response.' : ' document requests need your response.')
            : row.accepted ? 'Open the case to see your submitted answers and files.' : 'Your attorney invited you to complete the case questionnaire.'),
          taskButton(row.accepted ? 'Open ' + row.label : 'Accept invitation for ' + row.label, async () => {
            if (!row.accepted) await api('POST', '/api/matter-invitations/' + row.id + '/accept');
            await openIntake(me, row);
          }, feedback, row.accepted ? {} : { class: 'button-primary' }), feedback));
      }
    } catch (e) { container.textContent = e.message; }
  }

  const enterpriseStages = {
    awaiting_firm: ['Awaiting firm review', 'Review the request'],
    returned: ['Returned for changes', 'Update and resubmit the request'],
    accepted: ['Accepted by firm', 'Send the employee invitation'],
    invitation_sent: ['Invitation sent', 'Accept the invitation'],
    employee_intake: ['Employee completing intake', 'Complete the questionnaire and upload any supporting materials'],
    intake_submitted: ['Intake submitted', 'Review the submitted intake'],
    documents_needed: ['Additional documents requested', 'Follow the law firm’s instructions for supplying documents'],
    documents_submitted: ['Documents submitted', 'Review the additional documents'],
    in_review: ['In attorney review', 'Review the case'],
    drafting: ['Preparing application', 'Prepare the application'],
    filed: ['Filed', ''],
    closed: ['Closed', ''],
  };

  async function renderEnterprise() {
    const view = $('#view');
    const panel = el('section', { class: 'card', id: 'new-enterprise-request', hidden: '' });
    const requests = el('section', { class: 'card' }, el('h2', {}, 'Case progress'));
    const feedback = el('p', { role: 'status' });
    const title = el('h2', {}, 'New case request');
    const reference = el('input', { required: '', maxlength: 80 });
    const email = el('input', { type: 'email', required: '', maxlength: 254, autocomplete: 'off' });
    const summary = el('textarea', { required: '', maxlength: 1000 });
    const send = el('button', { class: 'button-primary' }, 'Send to law firm');
    const list = el('div', { class: 'enterprise-requests' });
    view.replaceChildren(el('header', { class: 'workspace-heading' }, el('h1', {}, 'Enterprise workspace'),
      el('button', { class: 'button-primary', type: 'button', onclick: () => panel.hidden ? edit() : reference.focus() }, 'Start a case')), feedback, requests, panel);
    let revise;
    function edit(row) {
      revise = row;
      panel.hidden = false;
      requests.before(panel);
      title.textContent = row ? 'Revise ' + row.reference : 'New case request';
      send.textContent = row ? 'Resubmit to law firm' : 'Send to law firm';
      reference.value = row?.reference ?? '';
      email.value = row?.email ?? '';
      summary.value = row?.summary ?? '';
      reference.focus();
    }
    function closeForm() {
      panel.hidden = true;
      requests.after(panel);
      revise = undefined;
    }
    const cancel = el('button', { type: 'button', onclick: closeForm }, 'Cancel');
    const endpoint = '/api/enterprise/requests';
    async function update() {
      const rows = await api('GET', endpoint);
      list.replaceChildren(...(rows.length ? rows.map(row => {
        const [stage, task] = enterpriseStages[row.stage];
        const body = el('article', { class: 'enterprise-request' },
          el('div', { class: 'enterprise-request-heading' }, el('h3', {}, row.reference),
            el('span', { class: 'status-pill', 'data-status': row.stage }, stage)),
          el('p', { class: 'muted' }, row.email),
          row.next ? el('p', {}, el('strong', {}, row.next + ' · '), task) : '',
          row.note ? el('p', { class: 'notice' }, el('strong', {}, 'Message from the law firm'), el('br'), row.note) : '',
          row.updatedAt ? el('small', { class: 'muted' }, 'Updated ' + new Date(row.updatedAt).toLocaleString()) : '');
        if (row.decision === 'returned') body.append(el('button', { type: 'button', onclick: () => {
          edit(row);
          reference.focus();
        } }, 'Revise request'));
        return body;
      }) : [el('p', { class: 'muted' }, 'No cases yet. Start a case to send a request to your law firm.')]));
    }
    panel.append(title, el('p', { class: 'muted' }, 'Send the employee’s work email and a short request to the law firm.'),
      el('form', { onsubmit: async event => {
        event.preventDefault();
        send.disabled = true;
        feedback.textContent = '';
        try {
          await api(revise ? 'PUT' : 'POST', revise ? endpoint + '/' + revise.id : endpoint,
            { reference: reference.value, email: email.value, summary: summary.value });
          closeForm();
          feedback.textContent = 'Request sent to the law firm.';
          await update();
        } catch (error) { feedback.textContent = error.message; }
        finally { send.disabled = false; }
      } }, el('label', {}, 'Internal case reference', reference), el('label', {}, 'Employee work email', email),
      el('label', {}, 'Brief request', summary), send, cancel));
    const refresh = el('button', { type: 'button', onclick: async () => {
      try { await update(); } catch (error) { feedback.textContent = error.message; }
    } }, 'Refresh progress');
    requests.append(refresh, list);
    await update();
  }

  async function openDraftRegister(me, matterId) {
    const panel = el('section', { class: 'card' });
    const error = el('p', { role: 'alert' });
    $('#view').replaceChildren(el('header', { class: 'workspace-heading' }, el('h1', {}, 'Attorney workspace'),
      el('button', { type: 'button', onclick: () => render(me, true) }, 'Open original case')), panel);
    panel.append(el('h2', {}, 'Cases and requests'), error);
    try {
      const rows = await api('GET', '/api/draft-matters');
      rows.sort((a, b) => Number(b.request?.decision === 'pending') - Number(a.request?.decision === 'pending'));
      const queue = el('p', { class: 'muted' });
      function showQueue() {
        const pending = rows.filter(row => row.request?.decision === 'pending').length;
        queue.textContent = pending ? pending + (pending === 1 ? ' request needs your review.' : ' requests need your review.') :
          rows.length ? 'No new employer requests. Select a case to continue.' : 'No cases yet. Start a case or wait for a request from HR.';
      }
      panel.append(queue);
      const select = el('select', { 'aria-label': 'Draft matter' });
      const status = el('select', { 'aria-label': 'Case status' }, STATUSES.map(s => el('option', { value: s }, caseStatusLabels[s])));
      const saveStatus = el('button', {}, 'Save status');
      const edit = el('form', { onsubmit: async ev => {
        ev.preventDefault();
        const row = rows.find(r => r.id === select.value);
        if (!row || saveStatus.hidden) return;
        try {
          const saved = await api('PUT', '/api/draft-matters/' + row.id + '/status', { status: status.value });
          row.status = saved.status;
          error.textContent = 'Status saved for ' + row.label + '.';
        } catch (e) { error.textContent = e.message; }
      } }, el('label', {}, 'Select a case', select), status, saveStatus);
      const optionLabel = row => row.label + (row.request?.decision === 'pending' ? ' · Request to review' : '');
      function addOption(row) { select.append(el('option', { value: row.id }, optionLabel(row))); }
      function showSelected() {
        error.textContent = '';
        actions.replaceChildren();
        const row = rows.find(r => r.id === select.value);
        edit.hidden = !row;
        const active = row && (!row.request || row.request.decision === 'accepted');
        status.hidden = saveStatus.hidden = !active;
        if (!row) return;
        if (active) status.value = row.status;
        if (row.request) {
          actions.append(el('h3', {}, 'Enterprise request'), el('p', {}, row.request.email), el('p', {}, row.request.summary));
          if (row.request.decision === 'returned') {
            actions.append(el('p', { class: 'notice' }, 'Returned to HR · ' + row.request.note));
            return;
          }
          if (row.request.decision === 'pending') {
            const reason = el('textarea', { maxlength: 500 });
            const decision = (value, text) => el('button', { type: 'button', onclick: async () => {
              try {
                const updated = await api('POST', '/api/draft-matters/' + row.id + '/decision', { decision: value, note: reason.value });
                Object.assign(row, updated);
                showQueue();
                Array.from(select.options).find(option => option.value === row.id).textContent = optionLabel(row);
                if (select.value === row.id) showSelected();
              } catch (e) { error.textContent = e.message; }
            } }, text);
            actions.append(decision('accepted', 'Accept enterprise request'),
              el('label', {}, 'Reason for returning to HR', reason), decision('returned', 'Return to HR'));
            return;
          }
          actions.append(el('p', { class: 'muted' }, 'Accepted by law firm'));
        }
        const open = el('button', { class: 'button-primary', onclick: () => openIntake(me, row) }, 'Open case');
        if (row.invitation) {
          const employee = me.invitees.find(person => person.id === row.invitation.employeeId);
          actions.append(el('p', {}, employee?.name || row.invitation.employeeId, ' · ',
            row.invitation.accepted ? 'Invitation accepted' : 'Invitation pending'));
          actions.append(open);
        } else if (row.request && !row.requestedEmployeeId) {
          actions.append(el('p', { class: 'notice' }, 'Ask your workspace administrator to add an employee account for this work email, then reopen the request.'));
        } else if (me.invitees.length) {
          const eligible = row.request ? me.invitees.filter(person => person.id === row.requestedEmployeeId) : me.invitees;
          const invitee = el('select', { required: '' }, el('option', { value: '' }, 'Select an employee'),
            eligible.map(person => el('option', { value: person.id }, person.name)));
          if (eligible.length === 1 && row.request) invitee.value = eligible[0].id;
          const send = el('button', {}, 'Send case invitation');
          actions.append(el('form', { onsubmit: async ev => {
            ev.preventDefault();
            send.disabled = true;
            try {
              const { invitation } = await api('POST', '/api/draft-matters/' + row.id + '/invite', { employeeId: invitee.value });
              row.invitation = invitation;
              showSelected();
            } catch (e) { error.textContent = e.message; }
            finally { send.disabled = false; }
          } }, el('label', {}, 'Employee to invite', invitee), send), open);
        } else {
          actions.append(open);
        }
      }
      const actions = el('div', {});
      rows.forEach(addOption);
      if (rows.some(row => row.id === matterId)) select.value = matterId;
      select.addEventListener('change', showSelected);
      showSelected();
      showQueue();
      const ref = el('input', { required: '', maxlength: 80 });
      const create = el('button', { class: 'button-primary' }, 'Create draft');
      const createForm = el('form', { onsubmit: async ev => {
        ev.preventDefault();
        create.disabled = true;
        try {
          const row = await api('POST', '/api/draft-matters', { label: ref.value });
          rows.push(row); addOption(row); select.value = row.id; ref.value = ''; showSelected(); showQueue();
        } catch (e) { error.textContent = e.message; }
        finally { create.disabled = false; }
      } }, el('label', {}, 'Internal case reference', ref), create);
      panel.append(edit, actions, el('details', {}, el('summary', {}, 'Start a case without an HR request'), createForm));
      if (me.workspaces?.length) $('#view').append(el('nav', { class: 'card', 'aria-label': 'Other case workspaces' },
        el('h3', {}, 'Other case workspaces'), el('ul', {}, me.workspaces.map(w => el('li', {}, el('a', { href: w.origin, rel: 'noreferrer' }, w.label))))));
    } catch (e) { error.textContent = e.message; }
  }

  function workspaceTools(withRequests = false) {
    return el('nav', { class: 'workspace-tools', 'aria-label': 'Lawyer tools' },
      [...(withRequests ? [['document-requests', 'Document requests']] : []),
        ['playbook-tools', 'Materials checklist'], ['petition-tools', 'Petition and USCIS forms'],
        ['case-tools', 'Consultation and playbooks']].map(([id, text]) =>
        el('a', { href: '#' + id }, text)));
  }

  async function render(me, originalCase = false) {
    const view = $('#view'); view.innerHTML = '';
    if (me.role === 'enterprise' && me.draftRegister) return renderEnterprise();
    if (me.role === 'lawyer' && me.draftRegister && !originalCase) return openDraftRegister(me);
    if (me.role === 'employee' && me.draftRegister && !originalCase) {
      const invitations = el('section', { class: 'card case-list' });
      const header = el('header', { class: 'workspace-heading' }, el('h1', {}, 'My cases'));
      if (me.originalCaseAccess !== false) header.append(el('button', { type: 'button', onclick: () => render(me, true) }, 'Open original case'));
      view.append(header, invitations);
      await showInvitations(me, invitations);
      return;
    }
    const c = await api('GET', '/api/case');
    view.append(el('header', { class: 'workspace-heading' },
      el('h1', {}, me.role === 'admin' ? 'Workspace administration' : me.draftRegister ? 'Original case' : 'Case workspace'),
      el('div', { class: 'case-meta' },
        el('span', { class: 'status-pill', 'data-status': c.status }, caseStatusLabels[c.status]),
        el('p', { class: 'muted' }, el('small', {}, `Updated ${new Date(c.updatedAt).toLocaleString()}`)))));
    const rerender = () => render(me, originalCase);

    if (me.role === 'employee') {
      if (me.draftRegister) {
        view.firstElementChild.append(el('button', { type: 'button', onclick: () => render(me) }, 'Back to my cases'));
      }
      view.append(el('p', { class: 'notice' }, c.disclaimer));
      if (!c.consentSigned) {
        view.append(consentPanel('/api', await api('GET', '/api/consent'), rerender));
        return;
      }
      view.append(el('div', { class: 'card' }, el('h3', {}, 'To do'), c.todos.length ? el('ul', {}, c.todos.map((t) => el('li', {}, t.text))) : el('p', { class: 'muted' }, 'Nothing requested right now.')));
      const q = await api('GET', '/api/questionnaire');
      view.append(el('div', { class: 'card' }, el('h3', {}, 'Background questionnaire'), questionnaireEditor(q, '/api')));
      const documents = el('div', {}, materialsTable(c.materials, false));
      view.append(el('div', { class: 'card' }, el('h3', {}, 'My materials'), documents,
        uploadForm(async () => documents.replaceChildren(materialsTable(await api('GET', '/api/materials'), false)))));
      if (c.assessment) view.append(el('div', { class: 'card' }, el('h3', {}, 'Assessment from your attorney'), el('p', {}, c.assessment.text), el('p', { class: 'muted' }, c.assessment.label)));
    }

    if (me.role === 'lawyer') {
      if (me.draftRegister) view.firstElementChild.append(el('button', { type: 'button', onclick: () => openDraftRegister(me) }, 'All cases and requests'));
      view.append(workspaceTools());
      if (me.workspaces?.length) {
        view.append(el('nav', { class: 'card', 'aria-label': 'Case workspaces' },
          el('h3', {}, 'Case workspaces'), el('ul', {}, me.workspaces.map(w =>
            el('li', {}, el('a', { href: w.origin, rel: 'noreferrer' }, w.label))))));
      }
      view.append(el('p', { class: 'notice' }, c.aiNotice));
      const sel = el('select', { onchange: async (e) => { await api('PUT', '/api/case/status', { status: e.target.value }); rerender(); } }, STATUSES.map(s => {
        const option = el('option', { value: s }, caseStatusLabels[s]);
        option.selected = s === c.status;
        return option;
      }));
      const visa = el('input', { value: c.visaType || '', placeholder: 'Visa type (set by attorney)' });
      view.append(el('div', { class: 'card' }, el('h3', {}, 'Case'), el('label', {}, 'Status', sel), el('label', {}, 'Visa type', visa),
        el('button', { type: 'button', onclick: async () => { await api('PUT', '/api/case/visa-type', { visaType: visa.value }); rerender(); } }, 'Save visa type'),
        el('p', { class: 'muted' }, `Consent: ${c.consent ? 'signed ' + new Date(c.consent.signedAt).toLocaleString() : 'not signed'}`)));
      const q = await api('GET', '/api/questionnaire');
      view.append(el('div', { class: 'card' }, el('h3', {}, 'Employee questionnaire'), questionnaireView(q)));
      view.append(el('div', { class: 'card' }, el('h3', {}, 'All materials'), materialsTable(c.materials, true), uploadForm(rerender)));
      const checklist = el('section', { id: 'playbook-tools', class: 'card', tabindex: '-1' });
      view.append(checklist);
      renderPlaybookChecklist(checklist, '/api');
      view.append(petitionPanel('/api'));
      view.append(caseToolsPanel('/api', () => renderPlaybookChecklist(checklist, '/api')));
      const todo = el('input', { 'aria-label': 'Requested material', placeholder: 'Shown to the employee after publishing' });
      view.append(el('div', { class: 'card' }, el('h3', {}, 'To-dos for employee'),
        el('ul', {}, c.todos.map((t) => el('li', {}, t.text, ' ', t.published ? '(published)' : el('button', { type: 'button', onclick: async () => { await api('PUT', `/api/todos/${t.id}/publish`, { published: true }); rerender(); } }, 'Publish')))),
        todo, el('button', { type: 'button', onclick: async () => { await api('POST', '/api/todos', { text: todo.value }); rerender(); } }, 'Add')));
      const a = c.assessment; const ta = el('textarea', { 'aria-label': 'Eligibility assessment draft' }, a ? a.text : '');
      view.append(el('div', { class: 'card' }, el('h3', {}, 'Eligibility assessment (attorney only until approved)'), ta,
        el('button', { type: 'button', onclick: async () => { await api('PUT', '/api/assessment', { text: ta.value }); rerender(); } }, 'Save (revokes approval)'),
        !me.syntheticDemo ? el('button', { type: 'button', onclick: async () => {
          try { await api('POST', '/api/assessment/generate', { materialIds: c.materials.map((m) => m.id) }); rerender(); }
          catch (e) { alert('AI draft failed: ' + e.message); }
        } }, 'Generate AI draft (attorney review only)') : '',
        a ? (a.approval ? el('button', { type: 'button', onclick: async () => { await api('POST', '/api/assessment/revoke'); rerender(); } }, 'Revoke approval')
                        : el('button', { type: 'button', onclick: async () => { await api('POST', '/api/assessment/approve'); rerender(); } }, 'Approve')) : '',
        el('p', { class: 'muted' }, !c.flags.lawyerApprovedPublish ? 'Assessment sharing is off. Only attorneys can see this draft.' :
          a?.approval ? 'Approved and visible to the employee.' : 'Private draft. Approve it when ready to share with the employee.')));
    }

    if (me.role === 'lawyer' || me.role === 'admin') {
      const feedback = el('p', { role: 'status' });
      const btn = taskButton('Show access log', async () => {
        const rows = await api('GET', '/api/access-log');
        const columns = ['Time', 'Account', 'Action', 'Reference', 'Result'];
        const events = rows.slice(-100).reverse().map(r => r.corrupted_or_tampered
          ? el('tr', { class: 'tampered' }, el('td', { colspan: '5' }, `Line ${r.line}: integrity check failed (${r.reason || 'unknown reason'})`))
          : el('tr', {}, el('td', {}, new Date(r.ts).toLocaleString()), el('td', {}, r.actor), el('td', {}, r.action),
            el('td', {}, r.resource || '—'), el('td', {}, r.outcome)));
        box.replaceChildren(events.length ? el('table', {}, el('thead', {}, el('tr', {},
          columns.map(column => el('th', { scope: 'col' }, column)))), el('tbody', {}, events)) :
          el('p', { class: 'muted' }, 'No activity recorded yet.'));
      }, feedback);
      const box = el('div', { class: 'table-scroll' });
      view.append(el('div', { class: 'card' }, el('h3', {}, 'Access log'), btn, feedback, box));
    }
  }
  boot();
  api('GET', '/healthz').then(status => {
    $('#demo-login-note').hidden = !status.syntheticDemo;
  }).catch(() => {});
})();
