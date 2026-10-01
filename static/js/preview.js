// Builds the final email for a person and renders it like an inbox would show it.
import { esc, state, activeTpl, fill, fileNameFor, fmtBytes, fileType } from './core.js';
import { renderCertificate, hasCert } from './certificate.js';

const URL_IN_TEXT = /\b(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;

const HAS_URL = /\b(https?:\/\/|www\.)\S/i;

/** Turns bare URLs in text into links (skips text that is already inside a link). */
function linkify(html) {
  const box = document.createElement('div');
  box.innerHTML = html;
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (!walker.currentNode.parentElement.closest('a') && HAS_URL.test(walker.currentNode.data)) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const span = document.createElement('span');
    span.innerHTML = esc(n.data).replace(URL_IN_TEXT, (u) => `<a href="${u.startsWith('www.') ? 'https://' + u : u}" target="_blank">${u}</a>`);
    n.replaceWith(...span.childNodes);
  }
  box.querySelectorAll('a').forEach((a) => a.setAttribute('target', '_blank'));
  return box.innerHTML;
}

export function htmlToText(html) {
  const box = document.createElement('div');
  box.innerHTML = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(div|h\d|ul|ol)[^>]*>/gi, '\n') // a block starts on a new line
    .replace(/<\/(div|h\d)>/gi, '')
    .replace(/<\/(ul|ol)>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n• ');
  box.querySelectorAll('a').forEach((a) => { if (a.href && a.textContent.trim() !== a.getAttribute('href')) a.textContent += ` (${a.getAttribute('href')})`; });
  return box.textContent.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function buildEmail(p, tpl = activeTpl()) {
  const html = linkify(fill(tpl.bodyHtml || '', p, true));
  return { subject: fill(tpl.subject || '', p), html, text: htmlToText(html) };
}

/** Documents attached to a template, resolved against the server's file list. */
export function templateDocs(tpl = activeTpl()) {
  return (tpl.attachments || []).map((id) => state.attachments.find((a) => a.id === id)).filter(Boolean);
}

/** Renders an inbox-style preview into `box`. */
export async function renderMail(box, p, tpl = activeTpl()) {
  const seq = String((+box.dataset.seq || 0) + 1);
  box.dataset.seq = seq;
  const mail = buildEmail(p, tpl);
  const c = state.config || {};
  const from = c.from_name || c.email || 'You';
  const certOn = tpl.includeCert;
  const ext = { pdf: 'pdf', png: 'png', jpg: 'jpg' }[tpl.fileFormat || 'pdf'];
  const docs = templateDocs(tpl);
  box.innerHTML = `
    <div class="mail">
      <div class="mail-top">
        <div class="mail-subject">${esc(mail.subject) || '<span class="muted">(no subject)</span>'}</div>
        <div class="mail-from"><div class="avatar">${esc(from[0].toUpperCase())}</div>
          <div><b>${esc(from)}</b> <small>${c.email ? '&lt;' + esc(c.email) + '&gt;' : ''}</small>
          <small>to ${esc(p.name || '')} &lt;${esc(p.email)}&gt;</small></div></div>
      </div>
      <div class="mail-body">${mail.html}</div>
      <div class="mail-atts">
        ${certOn ? `<div class="mail-att cert"><div class="cert-img">${hasCert() ? '<div class="muted small" style="padding:30px;text-align:center">Rendering certificate…</div>' : '<div class="alert warn" style="margin:0">Certificate is switched on but no certificate image is uploaded yet (step 4).</div>'}</div>
          <div class="cap"><span class="ft ${ext === 'pdf' ? '' : 'png'}">${ext.toUpperCase()}</span><b>${esc(fileNameFor(p, ext, tpl))}</b></div></div>` : ''}
        ${docs.map((d) => { const t = fileType(d.filename); return `<div class="mail-att"><span class="ft ${t.cls}">${esc(t.ext.toUpperCase().slice(0, 4))}</span><div><b>${esc(d.filename)}</b><small>${fmtBytes(d.size)}</small></div></div>`; }).join('')}
      </div>
    </div>`;
  if (certOn && hasCert()) {
    try {
      const url = await renderCertificate(p, { thumb: true, tpl });
      if (box.dataset.seq === seq) {
        const slot = box.querySelector('.cert-img');
        if (slot) slot.innerHTML = `<img alt="certificate preview" src="${url}">`;
      }
    } catch (e) {
      const slot = box.querySelector('.cert-img');
      if (slot) slot.innerHTML = `<div class="alert warn" style="margin:0">${esc(e.message)}</div>`;
    }
  }
}
