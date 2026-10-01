// Step 5: final preview, test email, recipient selection, sending with progress.
import { $, $$, esc, state, on, emit, api, toast, sleep, pad, activeTpl, previewPerson, setPreviewIdx, EMAIL_RE, fmtBytes, debounce } from './core.js';
import { autosave } from './store.js';
import { renderCertificate, ensureAllFonts, hasCert } from './certificate.js';
import { buildEmail, renderMail, templateDocs } from './preview.js';
import { templateWarnings } from './compose.js';
import { saveSelection } from './people.js';

let filter = 'all';
const LABEL = { pending: 'Waiting', sending: 'Sending…', sent: '✓ Sent', failed: '✕ Failed', skipped: 'Skipped · already sent today' };

/* ---------------- checks ---------------- */
export function problems() {
  const t = activeTpl();
  const out = [];
  if (!state.config?.verified) out.push(['Connect your Gmail', 'account']);
  if (!state.people.length) out.push(['Upload the participants sheet', 'people']);
  else if (!state.ws.sheet?.nameCol && /\{\{\s*Name\s*\}\}/.test(t.subject + t.bodyHtml)) out.push(['Choose the Name column', 'people']);
  if (state.people.length && !selected().length) out.push(['Select at least one person in the list below', null]);
  if (!t.subject?.trim()) out.push(['Write an email subject', 'message']);
  for (const w of templateWarnings(t)) out.push([w, t.includeCert && /certificate/i.test(w) ? 'certificate' : 'message']);
  const size = templateDocs(t).reduce((a, d) => a + d.size, 0);
  if (size > 20 * 1024 * 1024) out.push([`Attachments are ${fmtBytes(size)}; Gmail allows about 25 MB per email`, 'message']);
  return out;
}

const selected = () => state.people.filter((p) => p.selected);

/* ---------------- render ---------------- */
function renderSummary() {
  const t = activeTpl();
  const n = selected().length;
  const docs = templateDocs(t);
  const att = [t.includeCert ? 'Certificate' : null, docs.length ? `${docs.length} document${docs.length > 1 ? 's' : ''}` : null].filter(Boolean).join(' + ') || 'None';
  const secs = Math.round(n * (1.5 + (+state.ws.delay || 0)));
  $('#summary').innerHTML = [
    ['📨', `${t.icon || ''} ${t.name}`, 'Template'],
    ['👥', `${n} of ${state.people.length}`, 'Recipients selected'],
    ['📎', att, 'Attachments'],
    ['⏱', secs < 60 ? `~${secs} sec` : `~${Math.ceil(secs / 60)} min`, 'Estimated time'],
  ].map(([i, b, s]) => `<div class="sum"><div class="ico">${i}</div><div><b title="${esc(b)}">${esc(b)}</b><span>${s}</span></div></div>`).join('');
}

function renderChecklist() {
  const pr = problems();
  const t = activeTpl();
  const tested = state.testPassed[t.id];
  const n = selected().length;
  const items = pr.map(([m, step]) => `<div class="ck bad">✕ <span>${esc(m)}${step ? ` · <a data-go="${step}">fix</a>` : ''}</span></div>`);
  if (!tested) items.push('<div class="ck bad">✕ <span>Send yourself a test first (A) and check it looks right</span></div>');
  $('#checklist').innerHTML = items.length ? items.join('') : `<div class="ck ok">✓ Ready to send ${n} personalised email${n === 1 ? '' : 's'}</div>`;
  $('#sendBtn').textContent = `Send to ${n} ${n === 1 ? 'person' : 'people'}`;
  $('#sendBtn').disabled = !!items.length || state.sending;
  $('#testBtn').disabled = pr.some(([m]) => !/Select at least/.test(m)) || state.sending;
}

const renderFinal = debounce(() => {
  if (!$('#page-send').classList.contains('active')) return;
  const n = state.people.length;
  const p = previewPerson();
  $('#sPagerLabel').textContent = n ? `${state.previewIdx + 1} / ${n} · ${p.name}` : 'Sample person';
  renderMail($('#finalPreview'), p);
}, 200);

function visibleRows() {
  const q = $('#rSearch').value.trim().toLowerCase();
  return state.people.filter((p) => {
    if (q && !(`${p.name} ${p.email}`.toLowerCase().includes(q))) return false;
    if (filter === 'selected') return p.selected;
    if (filter === 'unselected') return !p.selected;
    if (filter === 'sent') return p.status === 'sent';
    if (filter === 'failed') return p.status === 'failed';
    return true;
  });
}

function renderTable() {
  const rows = visibleRows();
  const allOn = rows.length && rows.every((p) => p.selected);
  $('#sendTable').innerHTML = `<thead><tr><th class="cb"><input type="checkbox" id="cbAll" ${allOn ? 'checked' : ''} title="Select all shown"></th><th>#</th><th>Name</th><th>Email</th><th>Status</th></tr></thead><tbody>`
    + rows.map((p) => {
      const i = state.people.indexOf(p);
      return `<tr data-i="${i}" class="${p.selected ? '' : 'unsel'} ${i === state.previewIdx ? 'focus' : ''}">
        <td class="cb"><input type="checkbox" ${p.selected ? 'checked' : ''}></td><td>${i + 1}</td><td>${esc(p.name) || '<span class="muted">(no name)</span>'}</td><td>${esc(p.email)}</td>
        <td><span class="badge ${p.status}" title="${esc(p.error)}">${LABEL[p.status]}${p.status === 'failed' ? ': ' + esc(p.error.split('\n')[0]).slice(0, 70) : ''}</span></td></tr>`;
    }).join('') + '</tbody>';
  if (!state.people.length) $('#sendTable').innerHTML = '<tbody><tr><td class="muted" style="padding:30px;text-align:center">Upload participants in step 2.</td></tr></tbody>';
  updateProgress();
}

function setRowStatus(p, status, error = '') {
  p.status = status; p.error = error;
  const tr = $(`#sendTable tr[data-i="${state.people.indexOf(p)}"]`);
  if (tr) {
    tr.lastElementChild.innerHTML = `<span class="badge ${status}" title="${esc(error)}">${LABEL[status]}${status === 'failed' ? ': ' + esc(error.split('\n')[0]).slice(0, 70) : ''}</span>`;
    if (status === 'sending') tr.scrollIntoView({ block: 'nearest' });
  }
  updateProgress();
}

function updateProgress() {
  const sel = state.people.filter((p) => p.selected || p.status !== 'pending');
  const c = { pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
  sel.forEach((p) => c[p.status]++);
  const done = c.sent + c.failed + c.skipped;
  $('#progBar').style.width = sel.length ? `${(done / sel.length) * 100}%` : '0';
  $('#progText').textContent = done || state.sending ? `${c.sent} sent · ${c.failed} failed · ${c.skipped} skipped · ${c.pending + c.sending} remaining` : '';
  $('#retryBtn').classList.toggle('hidden', !c.failed || state.sending);
  $('#reportBtn').classList.toggle('hidden', !(c.sent + c.failed));
}

export function renderSendPage() {
  renderSummary();
  renderChecklist();
  renderTable();
  renderFinal();
  $('#delay').value = state.ws.delay;
}

/* ---------------- sending ---------------- */
async function sendOne(p, to, test) {
  const t = activeTpl();
  const mail = buildEmail(p, t);
  await api('/api/send', {
    to, name: p.name, test, template: t.id,
    subject: (test ? '[TEST] ' : '') + mail.subject,
    text: mail.text, html: mail.html,
    certificate: t.includeCert && hasCert() ? await renderCertificate(p, { tpl: t }) : null,
    attachments: t.attachments || [],
  });
}

async function sendTest() {
  const to = $('#testTo').value.trim();
  const st = $('#testStatus');
  if (!EMAIL_RE.test(to)) return toast('Enter a valid email for the test.', 'err');
  const p = previewPerson();
  st.className = 'status busy';
  st.classList.remove('hidden');
  st.textContent = `Sending the email for "${p.name}" to ${to}…`;
  $('#testBtn').disabled = true;
  try {
    await ensureAllFonts();
    await sendOne(p, to, true);
    state.testPassed[activeTpl().id] = true;
    st.className = 'status ok';
    st.textContent = `✔ Test sent to ${to}. Open your inbox (check spam too) and make sure everything looks right.\n"Send" is now unlocked.`;
  } catch (e) {
    st.className = 'status bad';
    st.textContent = '✕ ' + e.message;
  }
  renderChecklist();
}

async function sendAll(onlyFailed = false) {
  const t = activeTpl();
  const targets = state.people.filter((p) => p.selected && (onlyFailed ? p.status === 'failed' : p.status !== 'sent'));
  if (!targets.length) return toast('Everyone selected has already been sent this email.', 'ok');
  if (!onlyFailed && !confirm(`Send "${t.name}" to ${targets.length} ${targets.length === 1 ? 'person' : 'people'} now?`)) return;

  let already = new Set();
  if ($('#skipSent').checked) {
    const d = new Date();
    already = new Set(await api(`/api/sent?date=${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}&template=${encodeURIComponent(t.id)}`).catch(() => []));
  }
  await ensureAllFonts();
  state.sending = true; state.stopReq = false; state.paused = false;
  toggleButtons();
  targets.forEach((p) => p.status !== 'sent' && setRowStatus(p, 'pending'));
  const delay = Math.max(0, +state.ws.delay || 0) * 1000;

  for (const p of targets) {
    if (state.stopReq) break;
    while (state.paused && !state.stopReq) await sleep(300);
    if (state.stopReq) break;
    if (already.has(p.email.toLowerCase())) { setRowStatus(p, 'skipped'); continue; }
    setRowStatus(p, 'sending');
    try {
      await sendOne(p, p.email, false);
      setRowStatus(p, 'sent');
    } catch (e) {
      setRowStatus(p, 'failed', e.message);
      if (/rejected the login|daily limit/i.test(e.message)) { toast(e.message, 'err', 9000); break; }
    }
    if (delay) await sleep(delay);
  }
  state.sending = false;
  toggleButtons();
  renderChecklist();
  const failed = targets.filter((p) => p.status === 'failed').length;
  const sent = targets.filter((p) => p.status === 'sent').length;
  toast(failed ? `Finished: ${sent} sent, ${failed} failed. Use "Retry failed".` : `All done! ${sent} emails sent 🎉`, failed ? 'err' : 'ok', 7000);
  emit('sent');
}

function toggleButtons() {
  $('#sendBtn').disabled = state.sending;
  $('#testBtn').disabled = state.sending;
  $('#pauseBtn').classList.toggle('hidden', !state.sending);
  $('#stopBtn').classList.toggle('hidden', !state.sending);
  $('#pauseBtn').textContent = state.paused ? 'Resume' : 'Pause';
  updateProgress();
}

function downloadReport() {
  const rows = [['Name', 'Email', 'Selected', 'Status', 'Error'], ...state.people.map((p) => [p.name, p.email, p.selected ? 'yes' : 'no', p.status, p.error])];
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = `${activeTpl().name} - report ${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

/* ---------------- selection ---------------- */
function selectionChanged() { saveSelection(); renderTable(); renderSummary(); renderChecklist(); }

export function initSend() {
  $('#testBtn').addEventListener('click', sendTest);
  $('#sendBtn').addEventListener('click', () => sendAll(false));
  $('#retryBtn').addEventListener('click', () => sendAll(true));
  $('#pauseBtn').addEventListener('click', () => { state.paused = !state.paused; toggleButtons(); });
  $('#stopBtn').addEventListener('click', () => { state.stopReq = true; });
  $('#reportBtn').addEventListener('click', downloadReport);
  $('#delay').addEventListener('input', (e) => { state.ws.delay = +e.target.value; autosave(); renderSummary(); });
  $('#sPrev').addEventListener('click', () => setPreviewIdx(state.previewIdx - 1));
  $('#sNext').addEventListener('click', () => setPreviewIdx(state.previewIdx + 1));

  $('#rSearch').addEventListener('input', renderTable);
  $('#rFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filter = b.dataset.f;
    $$('#rFilter button').forEach((x) => x.classList.toggle('on', x === b));
    renderTable();
  });
  const bulk = (fn) => () => { visibleRows().forEach(fn); selectionChanged(); };
  $('#rAll').addEventListener('click', bulk((p) => { p.selected = true; }));
  $('#rNone').addEventListener('click', bulk((p) => { p.selected = false; }));
  $('#rInvert').addEventListener('click', bulk((p) => { p.selected = !p.selected; }));
  $('#rUnsent').addEventListener('click', () => { state.people.forEach((p) => { p.selected = p.status !== 'sent' && p.status !== 'skipped'; }); selectionChanged(); });

  $('#sendTable').addEventListener('click', (e) => {
    if (e.target.id === 'cbAll') { const v = e.target.checked; visibleRows().forEach((p) => { p.selected = v; }); return selectionChanged(); }
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    const p = state.people[+tr.dataset.i];
    if (e.target.type === 'checkbox') { p.selected = e.target.checked; return selectionChanged(); }
    setPreviewIdx(+tr.dataset.i);
  });
  window.addEventListener('beforeunload', (e) => { if (state.sending) { e.preventDefault(); e.returnValue = ''; } });

  const refresh = () => $('#page-send').classList.contains('active') && renderSendPage();
  on('preview-person', () => { renderFinal(); $$('#sendTable tr.focus').forEach((r) => r.classList.remove('focus')); $(`#sendTable tr[data-i="${state.previewIdx}"]`)?.classList.add('focus'); });
  on('people', refresh);
  on('template', () => { refresh(); });
  on('template-switched', () => {
    if (!state.sending) state.people.forEach((p) => { p.status = 'pending'; p.error = ''; });
    $('#testStatus').classList.add('hidden');
    refresh();
  });
  on('config', refresh);
}
