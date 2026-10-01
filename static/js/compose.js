// Step 3: email templates, event details, rich-text editor, attachments, live preview.
import {
  $, $$, esc, state, emit, on, toast, api, activeTpl, newTemplate, uid, isVar, tokenList,
  TOKEN_RE, previewPerson, setPreviewIdx, unknownTokens, emptyVarsUsed, fmtBytes, readAsDataURL, wireDrop, fileType, debounce,
} from './core.js';
import { autosave } from './store.js';
import { attachMention, attachRichMention, openRichMenu, makeChip } from './mention.js';
import { renderMail, templateDocs } from './preview.js';
import { hasCert, certTexts, setTemplateImage } from './certificate.js';

const GMAIL_LIMIT = 25 * 1024 * 1024;
const rte = () => $('#rte');
let savedRange = null;

/* ---------------- templates ---------------- */
function renderTabs() {
  $('#tplTabs').innerHTML = state.ws.templates.map((t) => `
    <button class="tpl-tab ${t.id === state.ws.activeId ? 'on' : ''}" data-id="${t.id}">
      <span>${esc(t.icon || '✉️')}</span>${esc(t.name)}${t.includeCert ? '<small>🎓 certificate</small>' : ''}
    </button>`).join('');
}

export function switchTemplate(id) {
  state.ws.activeId = id;
  loadTemplateIntoUI();
  autosave();
  emit('template-switched');
  emit('template');
}

function loadTemplateIntoUI() {
  const t = activeTpl();
  renderTabs();
  $('#subject').value = t.subject || '';
  setEditorHtml(t.bodyHtml || '');
  $('#incCert').checked = !!t.includeCert;
  renderDocs();
  refreshPreview();
}

function templateAction(act) {
  const t = activeTpl();
  if (act === 'rename') {
    const name = prompt('Template name:', t.name);
    if (name?.trim()) { t.name = name.trim(); renderTabs(); autosave(); emit('template'); }
  } else if (act === 'duplicate') {
    const copy = { ...structuredClone(t), id: uid(), name: t.name + ' (copy)' };
    state.ws.templates.push(copy);
    switchTemplate(copy.id);
  } else if (act === 'delete') {
    if (state.ws.templates.length === 1) return toast('You need at least one template.', 'err');
    if (!confirm(`Delete the template "${t.name}"?`)) return;
    state.ws.templates = state.ws.templates.filter((x) => x.id !== t.id);
    switchTemplate(state.ws.templates[0].id);
  }
}

/* ---------------- event details (global variables) ---------------- */
function renderVars() {
  $('#varsList').innerHTML = state.ws.vars.map((v, i) => `
    <div class="var" data-i="${i}">
      <input class="k" value="${esc(v.key)}" placeholder="Detail name" title="Name used with @">
      <input class="v" value="${esc(v.value)}" placeholder="Value, e.g. https://meet.google.com/abc-defg-hij">
      <button title="Remove">✕</button>
    </div>`).join('');
}

function renameTokenEverywhere(oldK, newK) {
  if (!oldK || !newK || oldK === newK) return;
  const re = new RegExp(`\\{\\{\\s*${oldK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g');
  for (const t of state.ws.templates) {
    t.subject = (t.subject || '').replace(re, `{{${newK}}}`);
    t.bodyHtml = (t.bodyHtml || '').replace(re, `{{${newK}}}`);
    t.filePattern = (t.filePattern || '').replace(re, `{{${newK}}}`);
  }
  loadTemplateIntoUI();
}

/* ---------------- rich text editor ---------------- */
function chipKind(token) {
  if (!tokenList().includes(token)) return 'bad';
  return isVar(token) ? 'var' : '';
}

/** Puts template HTML in the editor, showing {{tokens}} as chips. */
function setEditorHtml(html) {
  const el = rte();
  el.innerHTML = html;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (/\{\{[^{}]+\}\}/.test(walker.currentNode.data)) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    n.data.replace(TOKEN_RE, (m, k, idx) => {
      frag.append(n.data.slice(last, idx), makeChip(k, chipKind(k)));
      last = idx + m.length;
      return m;
    });
    frag.append(n.data.slice(last));
    n.replaceWith(frag);
  }
}

/** Editor HTML back to template HTML with {{tokens}}. */
function editorToTemplate() {
  const clone = rte().cloneNode(true);
  clone.querySelectorAll('.tok').forEach((t) => t.replaceWith(`{{${t.dataset.token}}}`));
  return clone.innerHTML.replace(/<div><br><\/div>/g, '<br>');
}

function refreshChips() {
  rte().querySelectorAll('.tok').forEach((t) => { t.className = 'tok ' + chipKind(t.dataset.token); });
}

function restoreSelection() {
  const el = rte();
  el.focus();
  if (savedRange) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
}

/* Field chips are non-editable, so browsers skip them when bolding. We style them ourselves. */
const WRAP = { bold: ['B', 'STRONG'], italic: ['I', 'EM'], underline: ['U'], strikeThrough: ['S', 'STRIKE'] };
const STYLE_TAGS = ['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'FONT', 'SPAN'];

function chipsInSelection() {
  const s = window.getSelection();
  if (!s.rangeCount) return [];
  const r = s.getRangeAt(0);
  return [...rte().querySelectorAll('.tok')].filter((c) => r.intersectsNode(c));
}

function wrapperOf(chip, tags) {
  for (let n = chip.parentElement; n && n !== rte(); n = n.parentElement) if (tags.includes(n.tagName)) return n;
  return null;
}

function wrapChip(chip, el) { chip.replaceWith(el); el.appendChild(chip); }

function styleChips(chips, cmd, val, turnOff) {
  if (!chips.length) return;
  if (WRAP[cmd]) {
    for (const c of chips) {
      const w = wrapperOf(c, WRAP[cmd]);
      if (turnOff && w) {
        if (w.textContent.trim() === c.textContent.trim()) w.replaceWith(...w.childNodes);
        else { const n = document.createElement('span'); n.style[{ bold: 'fontWeight', italic: 'fontStyle' }[cmd] || 'textDecoration'] = 'normal'; wrapChip(c, n); }
      } else if (!turnOff && !w) wrapChip(c, document.createElement(WRAP[cmd][0].toLowerCase()));
    }
  } else if (cmd === 'foreColor' || cmd === 'fontSize') {
    for (const c of chips) {
      const f = document.createElement('font');
      if (cmd === 'foreColor') f.color = val; else f.size = val;
      wrapChip(c, f);
    }
  } else if (cmd === 'removeFormat') {
    for (const c of chips) {
      let w = c.parentElement;
      while (w && w !== rte() && STYLE_TAGS.includes(w.tagName) && w.textContent.trim() === c.textContent.trim()) {
        const up = w.parentElement; w.replaceWith(...w.childNodes); w = up;
      }
    }
  }
  const r = document.createRange();
  r.setStartBefore(chips[0]); r.setEndAfter(chips[chips.length - 1]);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  savedRange = r.cloneRange();
}

function exec(cmd, val = null) {
  restoreSelection();
  const chips = chipsInSelection();
  const turnOff = WRAP[cmd] ? chips.length > 0 && chips.every((c) => wrapperOf(c, WRAP[cmd])) : false;
  if (cmd === 'createLink') {
    const sel = window.getSelection();
    const url = prompt('Link address (you can also type {{Meeting Link}}):', 'https://');
    if (!url || url === 'https://') return;
    if (sel.isCollapsed) document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(url)}</a>`);
    else document.execCommand('createLink', false, url);
  } else if (cmd === 'insertField') {
    return openRichMenu(rte());
  } else {
    document.execCommand('styleWithCSS', false, false);
    const onlyChips = chips.length && window.getSelection().toString().replace(/[\s ]/g, '') === chips.map((c) => c.textContent).join('').replace(/\s/g, '');
    if (!onlyChips) document.execCommand(cmd, false, val);
    styleChips(chips, cmd, val, turnOff);
  }
  onEditorInput();
  updateToolbarState();
}

function updateChipPick() {
  const chips = new Set(document.activeElement === rte() ? chipsInSelection() : []);
  rte().querySelectorAll('.tok').forEach((c) => c.classList.toggle('picked', chips.has(c)));
}

function updateToolbarState() {
  if (!rte().contains(window.getSelection().anchorNode)) return;
  $$('#rteBar button[data-cmd]').forEach((b) => {
    try { b.classList.toggle('on', document.queryCommandState(b.dataset.cmd)); } catch { /* not a state command */ }
  });
  const size = document.queryCommandValue('fontSize');
  if (size) $('#rteBar select[data-cmd=fontSize]').value = size;
}

const onEditorInput = () => {
  activeTpl().bodyHtml = editorToTemplate();
  autosave();
  refreshPreview();
};

/* ---------------- attachments ---------------- */
async function loadAttachments() {
  try { state.attachments = await api('/api/attachments'); } catch { state.attachments = []; }
}

function renderDocs() {
  const t = activeTpl();
  const docs = templateDocs(t);
  $('#docList').innerHTML = docs.map((d) => {
    const ft = fileType(d.filename);
    return `<div class="att-row" data-id="${d.id}"><div class="att-ico"><span class="ft ${ft.cls}">${esc(ft.ext.toUpperCase().slice(0, 4))}</span></div>
      <div class="grow"><b>${esc(d.filename)}</b><div class="muted small">${fmtBytes(d.size)} · sent to everyone</div></div>
      <button class="x" title="Remove">✕</button></div>`;
  }).join('');
  const total = docs.reduce((a, d) => a + d.size, 0) + (t.includeCert ? 400 * 1024 : 0);
  $('#attSize').textContent = `≈ ${fmtBytes(total)} per email · Gmail limit 25 MB`;
  $('#attSize').style.color = total > GMAIL_LIMIT * 0.9 ? 'var(--bad)' : '';
  const needCert = t.includeCert && !hasCert();
  $('#certAsk').classList.toggle('hidden', !needCert);
  $('#certDesignBtn').textContent = hasCert() ? 'Edit design →' : 'Design →';
  $('#certDesignBtn').className = 'btn sm ' + (t.includeCert && hasCert() ? 'primary' : 'ghost');
  $('#certDesignBtn').classList.toggle('hidden', needCert);
}

async function uploadDocs(files) {
  const t = activeTpl();
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024) { toast(`"${f.name}" is too big for email (max ~20 MB).`, 'err'); continue; }
    try {
      const data = (await readAsDataURL(f)).split(',')[1];
      const saved = await api('/api/attachments', { filename: f.name, data });
      state.attachments.push(saved);
      t.attachments = [...(t.attachments || []), saved.id];
      toast(`Attached "${f.name}"`, 'ok', 2500);
    } catch (e) { toast(e.message, 'err'); }
  }
  renderDocs(); autosave(); refreshPreview(); emit('template');
}

async function removeDoc(id) {
  const t = activeTpl();
  t.attachments = (t.attachments || []).filter((x) => x !== id);
  if (!state.ws.templates.some((x) => (x.attachments || []).includes(id))) {
    await api('/api/attachments/delete', { id }).catch(() => {});
    state.attachments = state.attachments.filter((a) => a.id !== id);
  }
  renderDocs(); autosave(); refreshPreview(); emit('template');
}

/* ---------------- preview & warnings ---------------- */
export function templateTexts(t = activeTpl()) {
  return [t.subject, t.bodyHtml, ...(t.includeCert ? [t.filePattern, ...certTexts()] : [])];
}

export function templateWarnings(t = activeTpl()) {
  const out = [];
  const texts = templateTexts(t);
  const unk = unknownTokens(texts);
  if (unk.length && state.columns.length) out.push(`These fields don't exist: ${unk.map((u) => `@${u}`).join(', ')}. Fix the spelling or remove them.`);
  else if (unk.length) out.push(`Fields ${unk.map((u) => `@${u}`).join(', ')} come from your sheet. Upload it in step 2 to fill them.`);
  const empty = emptyVarsUsed(texts);
  if (empty.length) out.push(`Event details used but empty: ${empty.join(', ')}. Fill them in above.`);
  if (t.includeCert && !hasCert()) out.push('Certificate is on but no certificate image is uploaded yet (step 4).');
  return out;
}

const refreshPreview = debounce(() => {
  if (!$('#page-message').classList.contains('active')) return;
  const n = state.people.length;
  const p = previewPerson();
  $('#mPagerLabel').textContent = n ? `${state.previewIdx + 1} / ${n}` : 'Sample person';
  renderMail($('#mailPreview'), p);
  const w = templateWarnings();
  $('#msgWarn').classList.toggle('hidden', !w.length);
  $('#msgWarn').innerHTML = w.map((x) => `⚠ ${esc(x)}`).join('<br>');
}, 250);

/* ---------------- Ollama (optional) ---------------- */
async function writeWithOllama() {
  const btn = $('#ollamaBtn');
  const t = activeTpl();
  const fields = tokenList().map((k) => `{{${k}}}`).join(', ');
  const draft = rte().innerText.trim();
  const prompt = `Write a short, warm, professional email for this purpose: "${t.name}"${t.includeCert ? ' (their participation certificate is attached)' : ''}. `
    + `Address the person with the placeholder {{Name}} exactly. You may use these placeholders: ${fields}. Do not invent other placeholders. `
    + 'Use **double asterisks** for words that should be bold. Under 130 words. Return ONLY the email body (no subject line, no explanations).'
    + (draft ? `\n\nImprove this current draft:\n${draft}` : '');
  btn.disabled = true; btn.textContent = '✨ Writing…';
  try {
    const { text } = await api('/api/ollama/generate', { prompt });
    const html = esc(text.replace(/^subject:.*\n+/i, '').trim()).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
    setEditorHtml(html);
    onEditorInput();
  } catch (e) {
    toast(e.message + '\nStart Ollama, or set its URL in Step 1 › Advanced.', 'err', 7000);
  } finally {
    btn.disabled = false; btn.textContent = '✨ Write with Ollama';
  }
}

/* ---------------- init ---------------- */
export function onShowMessage() { renderVars(); loadTemplateIntoUI(); }

export async function initCompose() {
  await loadAttachments();

  $('#tplTabs').addEventListener('click', (e) => { const b = e.target.closest('.tpl-tab'); if (b) switchTemplate(b.dataset.id); });
  $('#tplNew').addEventListener('click', () => {
    const name = prompt('Name for the new template (e.g. "Reminder", "Feedback request"):', 'New template');
    if (!name?.trim()) return;
    const t = newTemplate({ name: name.trim(), subject: '{{Event Name}}: ', bodyHtml: 'Hi <b>{{Name}}</b>,<br><br><br><br>Regards,<br>{{Organizer}}' });
    state.ws.templates.push(t);
    switchTemplate(t.id);
  });
  $('#tplMore').addEventListener('click', (e) => { e.stopPropagation(); $('#tplMenu').classList.toggle('hidden'); });
  document.addEventListener('click', () => $('#tplMenu').classList.add('hidden'));
  $('#tplMenu').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) templateAction(b.dataset.act); });

  // event details
  $('#varAdd').addEventListener('click', () => {
    state.ws.vars.push({ key: '', value: '' });
    renderVars();
    $('#varsList .var:last-child .k').focus();
  });
  $('#varsList').addEventListener('input', (e) => {
    const row = e.target.closest('.var');
    const v = state.ws.vars[+row.dataset.i];
    if (e.target.classList.contains('v')) v.value = e.target.value;
    autosave(); emit('vars'); refreshPreview();
  });
  $('#varsList').addEventListener('change', (e) => {
    if (!e.target.classList.contains('k')) return;
    const v = state.ws.vars[+e.target.closest('.var').dataset.i];
    const newK = e.target.value.trim().replace(/[{}@]/g, '');
    const oldK = v.key;
    v.key = newK;
    renameTokenEverywhere(oldK, newK);
    autosave(); emit('vars'); refreshChips(); refreshPreview();
  });
  $('#varsList').addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    state.ws.vars.splice(+e.target.closest('.var').dataset.i, 1);
    renderVars(); autosave(); emit('vars'); refreshChips(); refreshPreview();
  });

  // subject
  attachMention($('#subject'));
  $('#subject').addEventListener('input', (e) => { activeTpl().subject = e.target.value; autosave(); refreshPreview(); emit('template'); });

  // rich editor
  attachRichMention(rte(), chipKind);
  rte().addEventListener('input', onEditorInput);
  rte().addEventListener('keydown', (e) => {
    const cmd = (e.ctrlKey || e.metaKey) && { b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()];
    if (cmd) { e.preventDefault(); exec(cmd); }
  });
  // clicking a field selects it, so it can be bolded / coloured like normal text
  rte().addEventListener('mousedown', (e) => {
    const chip = e.target.closest('.tok');
    if (!chip) return;
    e.preventDefault();
    rte().focus();
    const r = document.createRange(); r.selectNode(chip);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    savedRange = r.cloneRange();
    updateChipPick();
  });
  document.addEventListener('selectionchange', updateChipPick);
  rte().addEventListener('paste', (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });
  document.addEventListener('selectionchange', () => {
    const s = window.getSelection();
    if (s.rangeCount && rte().contains(s.anchorNode)) { savedRange = s.getRangeAt(0).cloneRange(); updateToolbarState(); }
  });
  $('#rteBar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  $('#rteBar').addEventListener('click', (e) => { const b = e.target.closest('button[data-cmd]'); if (b) exec(b.dataset.cmd); });
  $('#rteBar select[data-cmd=fontSize]').addEventListener('change', (e) => exec('fontSize', e.target.value));
  $('#rteBar input[data-cmd=foreColor]').addEventListener('input', (e) => exec('foreColor', e.target.value));

  // attachments
  $('#incCert').addEventListener('change', (e) => {
    activeTpl().includeCert = e.target.checked;
    renderTabs(); renderDocs(); autosave(); refreshPreview(); emit('template');
    if (e.target.checked && !hasCert()) $('#certAskFile').click(); // ask for the certificate straight away
  });
  wireDrop($('#certAsk'), $('#certAskFile'), async (file) => {
    if (await setTemplateImage(file)) toast('Certificate uploaded! Click "Edit design" to place the name, date and signature.', 'ok', 6000);
    renderDocs();
  });
  wireDrop($('#docDrop'), $('#docFile'), uploadDocs, true);
  $('#docList').addEventListener('click', (e) => { const b = e.target.closest('.x'); if (b) removeDoc(b.closest('.att-row').dataset.id); });

  $('#ollamaBtn').addEventListener('click', writeWithOllama);
  $('#mPrev').addEventListener('click', () => setPreviewIdx(state.previewIdx - 1));
  $('#mNext').addEventListener('click', () => setPreviewIdx(state.previewIdx + 1));

  on('preview-person', refreshPreview);
  on('people', () => { refreshChips(); refreshPreview(); });
  on('cert', () => { renderDocs(); refreshPreview(); });
  on('template', () => { $('#incCert').checked = !!activeTpl().includeCert; renderTabs(); renderDocs(); refreshPreview(); });
  on('template-switched', () => { if (!$('#page-message').classList.contains('active')) loadTemplateIntoUI(); });
  on('config', refreshPreview);
  loadTemplateIntoUI();
  renderVars();
}

export { refreshPreview as refreshMessagePreview };
