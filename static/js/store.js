// Loads / saves the whole workspace (templates, event details, certificate, last sheet) to data/template.json.
import { $, api, state, defaultWorkspace, defaultTemplates, newTemplate, esc } from './core.js';
import { serializeCert } from './certificate.js';

let loading = true;
let timer;

export function autosave() {
  if (loading) return;
  $('#saveState').textContent = 'Saving…';
  clearTimeout(timer);
  timer = setTimeout(saveNow, 700);
}

export async function saveNow() {
  clearTimeout(timer);
  try {
    if (state.ws.cert) state.ws.cert.canvas = serializeCert();
    await api('/api/template', state.ws);
    $('#saveState').textContent = '✓ All changes saved';
  } catch (e) {
    $('#saveState').textContent = '⚠ Not saved: ' + e.message;
  }
}

/** Converts the first version's single-template file into the new workspace format. */
function migrate(old) {
  const ws = defaultWorkspace();
  if (!old) return ws;
  if (old.version >= 2) return { ...ws, ...old, vars: old.vars || ws.vars, templates: old.templates?.length ? old.templates : ws.templates };
  ws.dateFmt = old.dateFmt || ws.dateFmt;
  ws.delay = old.delay ?? ws.delay;
  if (old.canvas?.backgroundImage) ws.cert = { W: old.W, H: old.H, canvas: old.canvas };
  const cert = defaultTemplates().find((t) => t.id === 'certificate');
  if (old.subject || old.body) {
    Object.assign(cert, {
      subject: old.subject || cert.subject,
      bodyHtml: esc(old.body || '').replace(/\n/g, '<br>'),
      filePattern: old.filePattern || cert.filePattern,
      fileFormat: old.fileFormat || cert.fileFormat,
    });
  }
  ws.templates = [defaultTemplates()[0], cert];
  return ws;
}

export async function loadWorkspace() {
  let saved = null;
  try { saved = await api('/api/template'); } catch { /* first run */ }
  state.ws = migrate(saved);
  if (!state.ws.templates.length) state.ws.templates = [newTemplate({ name: 'Email' })];
}

export function doneLoading() { loading = false; }
