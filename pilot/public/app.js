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
  const label = (s) => s.replace(/_/g, ' ');

  async function boot() {
    try {
      const me = await api('GET', '/api/me');
      $('#login').hidden = true; $('#app').hidden = false;
      $('#who').textContent = `${me.name} (${me.role})`;
      render(me);
    } catch (e) {
      $('#app').hidden = true; $('#login').hidden = false;
    }
  }

  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    $('#login-error').textContent = '';
    try { await api('POST', '/auth/login', { email: f.get('email'), password: f.get('password') }); ev.target.reset(); boot(); }
    catch (e) { $('#login-error').textContent = e.status === 429 ? 'Too many attempts. Try later.' : 'Sign-in failed.'; }
  });
  $('#logout').addEventListener('click', async () => { await api('POST', '/auth/logout'); boot(); });

  function materialsTable(list, lawyer) {
    return el('table', {}, el('tr', {}, el('th', {}, 'File'), el('th', {}, 'Uploaded'), lawyer ? el('th', {}, 'Category') : '', el('th', {}, '')),
      list.map((m) => el('tr', {},
        el('td', {}, m.filename), el('td', {}, new Date(m.uploadedAt).toLocaleString()),
        lawyer ? el('td', {}, el('input', { value: m.category || '', onchange: (e) => api('PUT', `/api/materials/${m.id}/category`, { category: e.target.value }) })) : '',
        el('td', {}, el('a', { href: `/api/materials/${m.id}/download` }, 'Download')))));
  }
  function uploadForm(after) {
    const input = el('input', { type: 'file' });
    return el('div', {}, input, el('button', { type: 'button', onclick: async () => {
      if (!input.files[0]) return; const fd = new FormData(); fd.append('file', input.files[0]);
      try { await api('POST', '/api/materials', fd, true); after(); } catch (e) { alert('Upload failed: ' + e.message); }
    } }, 'Upload'));
  }

  async function render(me) {
    const view = $('#view'); view.innerHTML = '';
    const c = await api('GET', '/api/case');
    view.append(el('div', { class: 'card' }, el('strong', {}, 'Case status: '), label(c.status), el('span', { class: 'muted' }, ` (updated ${new Date(c.updatedAt).toLocaleString()})`)));
    const rerender = () => render(me);

    if (me.role === 'employee') {
      view.append(el('p', { class: 'notice' }, c.disclaimer));
      if (!c.consentSigned) {
        view.append(el('div', { class: 'card' }, el('h3', {}, 'Consent'),
          el('p', {}, 'Please read the privacy and AI processing consent provided by your attorney before continuing.'),
          el('button', { type: 'button', onclick: async () => { await api('POST', '/api/consent', { agree: true }); rerender(); } }, 'I have read and agree')));
        return;
      }
      view.append(el('div', { class: 'card' }, el('h3', {}, 'To do'), c.todos.length ? el('ul', {}, c.todos.map((t) => el('li', {}, t.text))) : el('p', { class: 'muted' }, 'Nothing requested right now.')));
      const q = await api('GET', '/api/questionnaire');
      const form = el('form', {}, q.questions.map((qq) => el('label', {}, qq.text, el('textarea', { name: qq.id }, q.answers[qq.id] || ''))));
      const save = (submit) => async () => { const answers = {}; new FormData(form).forEach((v, k) => (answers[k] = v)); await api('PUT', '/api/questionnaire', { answers, submit }); rerender(); };
      view.append(el('div', { class: 'card' }, el('h3', {}, 'Background questionnaire'), form,
        el('button', { type: 'button', onclick: save(false) }, 'Save'), el('button', { type: 'button', onclick: save(true) }, 'Submit')));
      view.append(el('div', { class: 'card' }, el('h3', {}, 'My materials'), materialsTable(c.materials, false), uploadForm(rerender)));
      if (c.assessment) view.append(el('div', { class: 'card' }, el('h3', {}, 'Assessment from your attorney'), el('p', {}, c.assessment.text), el('p', { class: 'muted' }, c.assessment.label)));
    }

    if (me.role === 'lawyer') {
      view.append(el('p', { class: 'notice' }, c.aiNotice));
      const sel = el('select', { onchange: async (e) => { await api('PUT', '/api/case/status', { status: e.target.value }); rerender(); } }, STATUSES.map((s) => { const o = el('option', { value: s }, label(s)); if (s === c.status) o.selected = true; return o; }));
      const visa = el('input', { value: c.visaType || '', placeholder: 'Visa type (set by attorney)' });
      view.append(el('div', { class: 'card' }, el('h3', {}, 'Case'), el('label', {}, 'Status', sel), el('label', {}, 'Visa type', visa),
        el('button', { type: 'button', onclick: async () => { await api('PUT', '/api/case/visa-type', { visaType: visa.value }); rerender(); } }, 'Save visa type'),
        el('p', { class: 'muted' }, `Consent: ${c.consent ? 'signed ' + new Date(c.consent.signedAt).toLocaleString() : 'not signed'}`)));
      view.append(el('div', { class: 'card' }, el('h3', {}, 'Questionnaire answers'), el('pre', {}, JSON.stringify(c.questionnaire.answers, null, 2))));
      view.append(el('div', { class: 'card' }, el('h3', {}, 'All materials'), materialsTable(c.materials, true), uploadForm(rerender)));
      const todo = el('input', { placeholder: 'Requested material (shown to employee only after you publish)' });
      view.append(el('div', { class: 'card' }, el('h3', {}, 'To-dos for employee'),
        el('ul', {}, c.todos.map((t) => el('li', {}, t.text, ' ', t.published ? '(published)' : el('button', { type: 'button', onclick: async () => { await api('PUT', `/api/todos/${t.id}/publish`, { published: true }); rerender(); } }, 'Publish')))),
        todo, el('button', { type: 'button', onclick: async () => { await api('POST', '/api/todos', { text: todo.value }); rerender(); } }, 'Add')));
      const a = c.assessment; const ta = el('textarea', {}, a ? a.text : '');
      view.append(el('div', { class: 'card' }, el('h3', {}, 'Eligibility assessment (attorney only until approved)'), ta,
        el('button', { type: 'button', onclick: async () => { await api('PUT', '/api/assessment', { text: ta.value }); rerender(); } }, 'Save (revokes approval)'),
        a ? (a.approval ? el('button', { type: 'button', onclick: async () => { await api('POST', '/api/assessment/revoke'); rerender(); } }, 'Revoke approval')
                        : el('button', { type: 'button', onclick: async () => { await api('POST', '/api/assessment/approve'); rerender(); } }, 'Approve')) : '',
        el('p', { class: 'muted' }, `Approved: ${a && a.approval ? 'yes' : 'no'}. Employee can see it only when approved AND LAWYER_APPROVED_PUBLISH is ${c.flags.lawyerApprovedPublish ? 'ON (currently on)' : 'on (currently OFF)'}.`)));
    }

    if (me.role === 'lawyer' || me.role === 'admin') {
      const btn = el('button', { type: 'button', onclick: async () => {
        const rows = await api('GET', '/api/access-log');
        box.replaceChildren(el('table', {}, rows.slice(-100).reverse().map((r) => el('tr', {}, el('td', {}, r.ts), el('td', {}, r.actor), el('td', {}, r.action), el('td', {}, r.resource || ''), el('td', {}, r.outcome)))));
      } }, 'Show access log');
      const box = el('div');
      view.append(el('div', { class: 'card' }, el('h3', {}, 'Access log'), btn, box));
    }
  }
  boot();
})();
