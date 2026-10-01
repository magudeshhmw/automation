// Step 2: read the Google Form export, detect name/email columns, build the participant list.
import { $, esc, state, emit, toast, EMAIL_RE, tokenGroups, wireDrop } from './core.js';
import { autosave } from './store.js';

export async function loadSheetFile(file) {
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
    if (!json.length) throw new Error('The sheet looks empty.');
    const columns = Object.keys(json[0]).map((k) => k.trim()).filter((k) => k && !/^__EMPTY/.test(k));
    const rows = json.map((r) => {
      const o = {};
      for (const k in r) o[k.trim()] = String(r[k] ?? '').trim();
      return o;
    }).filter((r) => Object.values(r).some(Boolean));
    state.ws.sheet = { fileName: file.name, loadedAt: new Date().toISOString(), columns, rows, nameCol: '', emailCol: '', excluded: [] };
    applySheet(true);
    autosave();
    toast(`Loaded ${rows.length} responses from "${file.name}"`, 'ok');
  } catch (e) {
    toast('Could not read that file: ' + e.message, 'err');
  }
}

function detect(columns, rows) {
  const sample = rows.slice(0, 100);
  const score = (c) => sample.filter((r) => EMAIL_RE.test(r[c] || '')).length / Math.max(1, sample.length);
  const emailCol = columns.find((c) => /e-?mail/i.test(c) && score(c) > 0.5)
    || [...columns].sort((a, b) => score(b) - score(a)).find((c) => score(c) > 0.5) || '';
  const names = columns.filter((c) => c !== emailCol && /name/i.test(c)
    && !/e-?mail|user\s*name|file|company|college|school|organi[sz]ation|institut|team|event/i.test(c));
  const nameCol = names.find((c) => /certificate/i.test(c)) || names.find((c) => /full\s*name/i.test(c))
    || names.find((c) => /^\s*(your\s+)?name\s*$/i.test(c)) || names[0] || '';
  return { nameCol, emailCol };
}

/** Rebuilds state.people from the saved sheet. */
export function applySheet(redetect = false) {
  const sh = state.ws.sheet;
  if (!sh) {
    Object.assign(state, { columns: [], rows: [], people: [], stats: {} });
    render(); emit('people'); return;
  }
  if (redetect || (!sh.nameCol && !sh.emailCol)) Object.assign(sh, detect(sh.columns, sh.rows));
  state.columns = sh.columns;
  state.rows = sh.rows;
  const old = new Map(state.people.map((p) => [p.key, p]));
  const excluded = new Set(sh.excluded || []);
  const seen = new Map();
  let invalid = 0, dup = 0, noName = 0;
  for (const row of sh.rows) {
    const email = (row[sh.emailCol] || '').trim();
    if (!EMAIL_RE.test(email)) { invalid++; continue; }
    const key = email.toLowerCase();
    if (seen.has(key)) dup++;
    const name = (row[sh.nameCol] || '').replace(/\s+/g, ' ').trim();
    const prev = old.get(key);
    seen.set(key, { key, row, email, name, selected: !excluded.has(key), status: prev?.status || 'pending', error: prev?.error || '' });
  }
  state.people = [...seen.values()];
  state.people.forEach((p) => { if (!p.name) noName++; });
  state.stats = { total: sh.rows.length, ok: state.people.length, invalid, dup, noName };
  state.previewIdx = Math.min(state.previewIdx, Math.max(0, state.people.length - 1));
  render();
  emit('people');
}

export function saveSelection() {
  if (!state.ws.sheet) return;
  state.ws.sheet.excluded = state.people.filter((p) => !p.selected).map((p) => p.key);
  autosave();
}

function render() {
  const sh = state.ws.sheet;
  $('#sheetDrop').classList.toggle('hidden', !!sh);
  $('#sheetLoaded').classList.toggle('hidden', !sh);
  if (!sh) return;
  $('#sheetName').textContent = sh.fileName;
  $('#sheetMeta').textContent = `${sh.rows.length} rows · ${sh.columns.length} columns · loaded ${new Date(sh.loadedAt || Date.now()).toLocaleString()}`;
  const opts = (sel) => '<option value="">— choose —</option>' + sh.columns.map((c) => `<option ${c === sel ? 'selected' : ''}>${esc(c)}</option>`).join('');
  $('#nameCol').innerHTML = opts(sh.nameCol);
  $('#emailCol').innerHTML = opts(sh.emailCol);
  const s = state.stats;
  $('#stats').innerHTML = [
    ['', s.total, 'Form responses'],
    ['good', s.ok, 'Ready to email'],
    [s.dup ? 'warn' : '', s.dup, 'Duplicate emails merged'],
    [s.invalid || s.noName ? 'bad' : '', s.invalid + s.noName, `Problems${s.invalid ? ` · ${s.invalid} bad email` : ''}${s.noName ? ` · ${s.noName} no name` : ''}`],
  ].map(([c, n, l]) => `<div class="stat ${c}"><b>${n}</b><span>${l}</span></div>`).join('');
  renderChips();
  renderTable();
}

export function renderChips() {
  const html = tokenGroups().flatMap((g) => g.items.map((t) => `<span class="chip ${g.kind || ''}" data-token="${esc(t)}" title="${esc(t)}">@${esc(t)}</span>`)).join('');
  $('#colChips').innerHTML = html;
}

function renderTable() {
  const sh = state.ws.sheet;
  const q = $('#peopleSearch').value.trim().toLowerCase();
  const list = state.people.filter((p) => !q || Object.values(p.row).join(' ').toLowerCase().includes(q));
  const cols = sh.columns;
  const hl = (c) => (c === sh.nameCol || c === sh.emailCol ? 'hl' : '');
  $('#peopleTable').innerHTML = `<thead><tr><th>#</th>${cols.map((c) => `<th class="${hl(c)}" title="${esc(c)}">${esc(c)}</th>`).join('')}</tr></thead><tbody>`
    + list.slice(0, 500).map((p) => `<tr><td>${state.people.indexOf(p) + 1}</td>${cols.map((c) => `<td class="${hl(c)}" title="${esc(p.row[c])}">${esc(p.row[c])}</td>`).join('')}</tr>`).join('') + '</tbody>';
  $('#peopleCount').textContent = q ? `${list.length} of ${state.people.length}` : `${state.people.length} participants`;
}

export function initPeople() {
  wireDrop($('#sheetDrop'), $('#sheetFile'), loadSheetFile);
  $('#sheetFile2').addEventListener('change', (e) => { if (e.target.files[0]) loadSheetFile(e.target.files[0]); e.target.value = ''; });
  $('#sheetClear').addEventListener('click', () => { state.ws.sheet = null; state.people = []; applySheet(); autosave(); });
  $('#nameCol').addEventListener('change', (e) => { state.ws.sheet.nameCol = e.target.value; applySheet(); autosave(); });
  $('#emailCol').addEventListener('change', (e) => { state.ws.sheet.emailCol = e.target.value; applySheet(); autosave(); });
  $('#peopleSearch').addEventListener('input', renderTable);
}
