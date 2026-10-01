// App entry: navigation between steps, sidebar status, start-up order.
import { $, $$, state, on, toast, activeTpl } from './core.js';
import { loadWorkspace, doneLoading } from './store.js';
import { initMentionMenu, insertInto } from './mention.js';
import { initAccount, loadConfig } from './account.js';
import { initPeople, applySheet, renderChips } from './people.js';
import { initCertificate, loadCertFromWorkspace, onShowCertificate, hasCert } from './certificate.js';
import { initCompose, onShowMessage } from './compose.js';
import { initSend, renderSendPage } from './send.js';

const PAGES = {
  account: () => {},
  people: () => {},
  message: onShowMessage,
  certificate: onShowCertificate,
  send: renderSendPage,
};

function goto(step) {
  if (step !== 'account' && !state.config?.verified) {
    toast('Connect your Gmail first (step 1).', 'err');
    step = 'account';
  }
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.step === step));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${step}`));
  window.scrollTo({ top: 0 });
  PAGES[step]?.();
  updateNav();
}

function updateNav() {
  const ok = !!state.config?.verified;
  const t = activeTpl();
  const n = state.people.length;
  const sel = state.people.filter((p) => p.selected).length;
  const certState = !t.includeCert ? 'Off for this template' : hasCert() ? 'Ready' : 'Upload certificate';
  const info = {
    account: [ok, ok ? state.config.email : 'Connect Gmail'],
    people: [n > 0, n ? `${n} people · ${state.ws.sheet?.fileName || ''}` : 'Upload sheet'],
    message: [!!t.subject?.trim() && ok, `${t.icon || ''} ${t.name}`],
    certificate: [t.includeCert && hasCert(), certState],
    send: [false, n ? `${sel} selected` : 'Test, then send'],
  };
  $$('#nav button').forEach((b) => {
    const s = b.dataset.step;
    b.classList.toggle('done', !!info[s][0]);
    b.classList.toggle('locked', s !== 'account' && !ok);
    b.classList.toggle('off', s === 'certificate' && !t.includeCert);
  });
  $('#navAccount').textContent = info.account[1];
  $('#navPeople').textContent = info.people[1];
  $('#navMessage').textContent = info.message[1];
  $('#navCert').textContent = info.certificate[1];
  $('#navSend').textContent = info.send[1];
}

/* chips insert into whichever field was used last */
let lastField = null;
function trackFields() {
  document.addEventListener('focusin', (e) => {
    if (e.target.matches('#subject, #filePattern, #pText') || e.target.id === 'rte') lastField = e.target;
  });
  document.addEventListener('mousedown', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    e.preventDefault();
    const field = lastField && lastField.offsetParent ? lastField : null;
    if (field) insertInto(field, chip.dataset.token);
    else {
      navigator.clipboard?.writeText(`{{${chip.dataset.token}}}`);
      toast(`Copied {{${chip.dataset.token}}}. Or just type @ in any text box.`, 'info', 2500);
    }
  });
}

async function boot() {
  initMentionMenu();
  initAccount();
  initPeople();
  initCertificate();
  trackFields();

  $$('#nav button').forEach((b) => b.addEventListener('click', () => goto(b.dataset.step)));
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-go]'); if (g) goto(g.dataset.go); });
  $('#msgNext').addEventListener('click', () => goto(activeTpl().includeCert ? 'certificate' : 'send'));

  await loadWorkspace();
  await loadCertFromWorkspace();
  applySheet();
  try { await loadConfig(); } catch (e) { toast('Server not reachable: ' + e.message, 'err'); }
  await initCompose();
  initSend();
  doneLoading();

  ['people', 'template', 'template-switched', 'cert', 'config', 'sent', 'vars'].forEach((ev) => on(ev, updateNav));
  on('vars', renderChips);
  on('goto', goto);
  goto(!state.config?.verified ? 'account' : state.people.length ? 'message' : 'people');
}

boot();
