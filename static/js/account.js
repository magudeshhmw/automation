// Step 1: connect the Gmail account (SMTP + App Password) and verify it.
import { $, api, esc, state, emit, EMAIL_RE } from './core.js';

function setStatus(kind, msg) {
  const st = $('#cfgStatus');
  st.className = 'status ' + kind;
  st.textContent = msg;
}

export async function loadConfig() {
  const c = await api('/api/config');
  state.config = c;
  $('#cfgEmail').value = c.email;
  $('#cfgName').value = c.from_name;
  $('#cfgHost').value = c.smtp_host;
  $('#cfgPort').value = c.smtp_port;
  $('#cfgOllamaUrl').value = c.ollama_url;
  $('#cfgOllamaModel').value = c.ollama_model;
  $('#cfgPass').placeholder = c.has_password ? '•••• saved (leave blank to keep it)' : 'abcd efgh ijkl mnop';
  $('#cfgOllamaKey').placeholder = c.has_ollama_key ? 'saved' : '';
  if (!$('#testTo').value) $('#testTo').value = c.email;
  renderAccount();
  api('/api/ollama/models').then((r) => { $('#ollamaModels').innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join(''); }).catch(() => {});
  emit('config');
}

function renderAccount() {
  const c = state.config;
  const ok = !!c?.verified;
  $('#acctConnected').classList.toggle('hidden', !ok);
  $('#acctForm').classList.toggle('hidden', ok);
  $('#acctConnectedText').textContent = ok ? `Emails will be sent from ${c.from_name ? c.from_name + ' · ' : ''}${c.email}` : '';
  $('#acctChip').innerHTML = ok
    ? `<div class="avatar">${esc((c.from_name || c.email)[0].toUpperCase())}</div><div class="who"><b>${esc(c.email)}</b><small>● Connected</small></div>`
    : '';
}

/** Catches the common mistakes before talking to Gmail. */
function checkForm() {
  const email = $('#cfgEmail').value.trim();
  const pass = $('#cfgPass').value.replace(/\s+/g, '');
  const host = $('#cfgHost').value.trim() || 'smtp.gmail.com';
  if (!email) return 'Type your Gmail address.';
  if (/@(gmail|gmial|gmai|gamil)(com|\.co|\.con|\.cm)?$/i.test(email) && !/@gmail\.com$/i.test(email)) {
    return `"${email}" looks mistyped. Did you mean ${email.split('@')[0]}@gmail.com ?`;
  }
  if (!EMAIL_RE.test(email)) return `"${email}" is not a valid email address.`;
  if (!pass && !state.config?.has_password) return 'Paste the 16-letter App Password.';
  if (pass && host === 'smtp.gmail.com' && !/^[a-z]{16}$/i.test(pass)) {
    return `The App Password must be exactly 16 letters (you entered ${pass.length} characters).\nIt is NOT your normal Gmail password. Create one at myaccount.google.com/apppasswords.`;
  }
  return '';
}

async function connect() {
  const bad = checkForm();
  if (bad) return setStatus('bad', '✖ ' + bad);
  setStatus('busy', 'Checking with Gmail…');
  $('#cfgSave').disabled = true;
  try {
    await api('/api/config', {
      email: $('#cfgEmail').value.trim(), password: $('#cfgPass').value.replace(/\s+/g, ''), from_name: $('#cfgName').value.trim(),
      smtp_host: $('#cfgHost').value.trim() || 'smtp.gmail.com', smtp_port: +$('#cfgPort').value || 465,
      ollama_url: $('#cfgOllamaUrl').value.trim(), ollama_model: $('#cfgOllamaModel').value.trim(), ollama_key: $('#cfgOllamaKey').value,
    });
    $('#cfgPass').value = ''; $('#cfgOllamaKey').value = '';
    let err = null;
    try { await api('/api/verify', {}); } catch (e) { err = e; }
    await loadConfig();
    if (err) throw err;
    setStatus('ok', `✔ Connected! Emails will be sent from ${state.config.email}.`);
    emit('goto', 'people');
  } catch (e) {
    setStatus('bad', '✖ ' + e.message);
  } finally {
    $('#cfgSave').disabled = false;
  }
}

export function initAccount() {
  $('#cfgSave').addEventListener('click', connect);
  ['#cfgEmail', '#cfgPass', '#cfgName'].forEach((s) => $(s).addEventListener('keydown', (e) => e.key === 'Enter' && connect()));
  $('#cfgPassShow').addEventListener('click', () => {
    const i = $('#cfgPass');
    i.type = i.type === 'password' ? 'text' : 'password';
    $('#cfgPassShow').textContent = i.type === 'password' ? 'Show' : 'Hide';
  });
  $('#acctChange').addEventListener('click', () => {
    $('#acctConnected').classList.add('hidden');
    $('#acctForm').classList.remove('hidden');
    $('#cfgStatus').classList.add('hidden');
  });
}
