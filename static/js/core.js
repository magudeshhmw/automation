// Shared state, helpers and the tiny event bus every module talks through.

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uid = () => Math.random().toString(36).slice(2, 10);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const pad = (n) => String(n).padStart(2, '0');

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
export const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
export const BUILTIN = ['Name', 'Email', 'Today'];

/* ---------------- event bus ---------------- */
const listeners = {};
export function on(evt, fn) { (listeners[evt] ||= []).push(fn); }
export function emit(evt, data) { (listeners[evt] || []).forEach((fn) => fn(data)); }

/* ---------------- state ---------------- */
export const state = {
  config: null,          // public SMTP config from the server
  ws: null,              // persisted workspace (see defaultWorkspace)
  columns: [], rows: [], people: [], stats: {},
  previewIdx: 0,
  attachments: [],       // documents stored on the server
  testPassed: {},        // templateId -> true once a test went out this session
  sending: false, paused: false, stopReq: false,
};

export const DATE_FORMATS = {
  long: { label: '01 October 2026', fn: (d) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) },
  us: { label: 'October 1, 2026', fn: (d) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) },
  day: { label: 'Thursday, 1 October 2026', fn: (d) => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) },
  dmy: { label: '01/10/2026', fn: (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` },
  iso: { label: '2026-10-01', fn: (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` },
};

/* ---------------- workspace defaults ---------------- */
export function newTemplate(over = {}) {
  return {
    id: uid(), name: 'New template', icon: '✉️',
    subject: '', bodyHtml: '',
    includeCert: false, filePattern: 'Certificate - {{Name}}', fileFormat: 'pdf',
    attachments: [],
    ...over,
  };
}

export function defaultTemplates() {
  return [
    newTemplate({
      id: 'invite', name: 'Invitation', icon: '📨',
      subject: "You're invited: {{Event Name}} on {{Event Date}}",
      bodyHtml: 'Hi <b>{{Name}}</b>,<br><br>Thank you for registering for <b>{{Event Name}}</b>! Here are your joining details:<br><br>'
        + '📅 <b>Date:</b> {{Event Date}}<br>⏰ <b>Time:</b> {{Event Time}}<br>🔗 <b>Join link:</b> {{Meeting Link}}<br><br>'
        + 'Please join 5 minutes early. See you there!<br><br>Warm regards,<br><b>{{Organizer}}</b>',
    }),
    newTemplate({
      id: 'certificate', name: 'Thank you + Certificate', icon: '🎓', includeCert: true,
      subject: 'Thank you for joining {{Event Name}}, {{Name}}!',
      bodyHtml: 'Dear <b>{{Name}}</b>,<br><br>Thank you for joining <b>{{Event Name}}</b> today! We truly appreciate your time and participation.<br><br>'
        + 'Please find your <b>participation certificate</b> attached. 🎉<br><br>Warm regards,<br><b>{{Organizer}}</b>',
    }),
  ];
}

export function defaultWorkspace() {
  return {
    version: 2,
    dateFmt: 'long',
    delay: 1,
    vars: [
      { key: 'Event Name', value: 'Daily Meetup' },
      { key: 'Event Date', value: DATE_FORMATS.long.fn(new Date()) },
      { key: 'Event Time', value: '7:00 PM IST' },
      { key: 'Meeting Link', value: 'https://meet.google.com/' },
      { key: 'Organizer', value: '' },
    ],
    templates: defaultTemplates(),
    activeId: 'certificate',
    cert: null,          // { W, H, canvas } once a certificate image is uploaded
    sheet: null,         // { fileName, rows, columns, nameCol, emailCol, excluded: [] }
  };
}

export function activeTpl() {
  const ws = state.ws;
  return ws.templates.find((t) => t.id === ws.activeId) || ws.templates[0];
}

/* ---------------- fields / tokens ---------------- */
export function fmtToday() {
  return (DATE_FORMATS[state.ws?.dateFmt] || DATE_FORMATS.long).fn(new Date());
}

export function varKeys() { return (state.ws?.vars || []).map((v) => v.key.trim()).filter(Boolean); }

/** Groups shown in the @ menu. */
export function tokenGroups() {
  const vars = varKeys();
  const cols = state.columns.filter((c) => !BUILTIN.includes(c));
  return [
    { label: 'Participant', items: ['Name', 'Email', ...cols.filter((c) => !vars.includes(c))] },
    { label: 'Event details', items: vars, kind: 'var' },
    { label: 'Automatic', items: ['Today'] },
  ].filter((g) => g.items.length);
}

export function tokenList() { return [...new Set(tokenGroups().flatMap((g) => g.items))]; }
export function isVar(k) { return varKeys().includes(k) && !state.columns.includes(k); }

export function valueFor(p, key) {
  if (key === 'Today') return fmtToday();
  if (p && key === 'Name') return p.name;
  if (p && key === 'Email') return p.email;
  if (p && p.row && key in p.row) return p.row[key];
  const v = (state.ws?.vars || []).find((x) => x.key.trim() === key);
  if (v) return v.value;
  return null;
}

/** Replace {{tokens}}. In html mode values are escaped. Unknown tokens are left as-is. */
export function fill(text, p, html = false) {
  return String(text ?? '').replace(TOKEN_RE, (m, k) => {
    const v = valueFor(p, k);
    if (v == null) return m;
    return html ? esc(v).replace(/\n/g, '<br>') : v;
  });
}

export function tokensIn(text) { return [...String(text ?? '').matchAll(TOKEN_RE)].map((m) => m[1]); }

export function unknownTokens(texts) {
  const known = new Set([...tokenList(), ...state.columns]);
  return [...new Set(texts.flatMap(tokensIn).filter((k) => !known.has(k)))];
}

export function emptyVarsUsed(texts) {
  const used = new Set(texts.flatMap(tokensIn));
  return (state.ws?.vars || []).filter((v) => used.has(v.key.trim()) && !String(v.value).trim() && !state.columns.includes(v.key.trim())).map((v) => v.key);
}

export function applyCase(s, mode) {
  if (mode === 'upper') return s.toUpperCase();
  if (mode === 'title') return s.toLowerCase().replace(/(^|[\s\-'.(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  return s;
}

/* ---------------- people ---------------- */
const DEMO = { key: 'demo', name: 'Priya Sharma', email: 'priya.sharma@example.com', row: {}, demo: true };
export function currentPerson() { return state.people[state.previewIdx] || null; }
export function previewPerson() { return currentPerson() || DEMO; }
export function setPreviewIdx(i) {
  const n = state.people.length;
  if (!n) return;
  state.previewIdx = ((i % n) + n) % n;
  emit('preview-person');
}

export function fileNameFor(p, ext, tpl = activeTpl()) {
  const base = fill(tpl.filePattern || 'Certificate', p).replace(/[\\/:*?"<>|\r\n]+/g, '').replace(/\s+/g, ' ').trim() || 'Certificate';
  return `${base}.${ext}`;
}

/* ---------------- misc helpers ---------------- */
export async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function toast(msg, kind = 'info', ms = 4000) {
  const t = document.createElement('div');
  t.className = 'toast ' + (kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function readAsDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function wireDrop(zone, input, handler, multiple = false) {
  input.addEventListener('change', () => { if (input.files.length) handler(multiple ? [...input.files] : input.files[0]); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); zone.classList.remove('over');
    if (e.dataTransfer.files.length) handler(multiple ? [...e.dataTransfer.files] : e.dataTransfer.files[0]);
  });
}

export function fileType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return { ext, cls: ext === 'pdf' ? '' : ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext) ? 'png' : 'doc' };
}
