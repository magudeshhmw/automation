// "@" autocomplete for inputs, textareas and the rich email editor (LinkedIn-style mentions).
import { $, esc, tokenGroups, valueFor, previewPerson } from './core.js';

const AT_RE = /(^|[^\w.])@([^\s@{}]*)$/;
const m = { el: null, items: [], sel: 0, rich: false, range: null, onPick: null };
const menu = () => $('#mentionMenu');

function filtered(q) {
  q = q.toLowerCase();
  return tokenGroups().map((g) => ({ ...g, items: g.items.filter((t) => t.toLowerCase().includes(q)) })).filter((g) => g.items.length);
}

function show(groups, rect) {
  m.items = groups.flatMap((g) => g.items);
  if (!m.items.length) return hide();
  m.sel = 0;
  const p = previewPerson();
  let i = 0;
  menu().innerHTML = groups.map((g) => `<div class="grp">${esc(g.label)}</div>`
    + g.items.map((t) => {
      const v = valueFor(p, t);
      return `<div class="it" data-i="${i++}" title="${esc(t)}"><span>${esc(t)}</span><small>${esc(v ?? '')}</small></div>`;
    }).join('')).join('');
  const mm = menu();
  mm.classList.remove('hidden');
  const left = Math.min(rect.left + window.scrollX, window.scrollX + window.innerWidth - 350);
  let top = rect.bottom + window.scrollY + 6;
  if (rect.bottom + 290 > window.innerHeight) top = rect.top + window.scrollY - Math.min(290, mm.offsetHeight) - 6;
  mm.style.left = `${Math.max(8, left)}px`;
  mm.style.top = `${top}px`;
  highlight();
}

function highlight() {
  menu().querySelectorAll('.it').forEach((d) => d.classList.toggle('sel', +d.dataset.i === m.sel));
  menu().querySelector('.it.sel')?.scrollIntoView({ block: 'nearest' });
}

export function hide() { menu().classList.add('hidden'); m.el = null; }
const isOpenFor = (el) => m.el === el && !menu().classList.contains('hidden');

function keyNav(e, el) {
  if (!isOpenFor(el)) return;
  if (e.key === 'ArrowDown') { m.sel = (m.sel + 1) % m.items.length; highlight(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { m.sel = (m.sel - 1 + m.items.length) % m.items.length; highlight(); e.preventDefault(); }
  else if (e.key === 'Enter' || e.key === 'Tab') { pick(m.items[m.sel]); e.preventDefault(); }
  else if (e.key === 'Escape') { hide(); e.preventDefault(); }
}

function pick(token) {
  const el = m.el;
  if (!el) return;
  if (m.rich) insertRich(el, token);
  else insertPlain(el, token);
  hide();
}

/* ---------- plain inputs ---------- */
function caretRect(el, pos) {
  const cs = getComputedStyle(el);
  const div = document.createElement('div');
  for (const p of ['boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'borderTopWidth', 'borderLeftWidth', 'wordSpacing']) div.style[p] = cs[p];
  Object.assign(div.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: el.tagName === 'TEXTAREA' ? 'pre-wrap' : 'pre', wordWrap: 'break-word' });
  div.textContent = el.value.slice(0, pos);
  const span = document.createElement('span');
  span.textContent = '​';
  div.appendChild(span);
  document.body.appendChild(div);
  const r = el.getBoundingClientRect();
  const x = r.left + Math.min(span.offsetLeft - el.scrollLeft, r.width - 40);
  const y = r.top + span.offsetTop - el.scrollTop;
  div.remove();
  return { left: x, top: y, bottom: y + span.offsetHeight };
}

function insertPlain(el, token, replaceAt = true) {
  const pos = el.selectionStart ?? el.value.length;
  const mt = replaceAt ? el.value.slice(0, pos).match(/@([^\s@{}]*)$/) : null;
  el.setRangeText(`{{${token}}}`, mt ? pos - mt[0].length : pos, pos, 'end');
  el.focus();
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function attachMention(el) {
  el.addEventListener('input', () => {
    const mt = el.value.slice(0, el.selectionStart).match(AT_RE);
    if (!mt) return hide();
    m.el = el; m.rich = false;
    show(filtered(mt[2]), caretRect(el, el.selectionStart));
  });
  el.addEventListener('keydown', (e) => keyNav(e, el));
  el.addEventListener('blur', () => setTimeout(() => m.el === el && hide(), 160));
}

/* ---------- rich editor ---------- */
export function makeChip(token, kind) {
  const s = document.createElement('span');
  s.className = 'tok' + (kind ? ' ' + kind : '');
  s.contentEditable = 'false';
  s.dataset.token = token;
  s.textContent = token;
  return s;
}

function richContext() {
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  if (r.startContainer.nodeType !== Node.TEXT_NODE) return { range: r, q: null };
  const before = r.startContainer.data.slice(0, r.startOffset);
  const mt = before.match(AT_RE);
  return { range: r, q: mt ? mt[2] : null, len: mt ? mt[2].length + 1 : 0 };
}

let richKind = () => '';
function insertRich(el, token) {
  el.focus();
  const sel = window.getSelection();
  let r = m.range;
  if (!r) { r = document.createRange(); r.selectNodeContents(el); r.collapse(false); }
  if (m.replaceLen) {
    r = r.cloneRange();
    r.setStart(r.startContainer, Math.max(0, r.startOffset - m.replaceLen));
    r.deleteContents();
  }
  const chip = makeChip(token, richKind(token));
  const space = document.createTextNode(' ');
  r.insertNode(space);
  r.insertNode(chip);
  const after = document.createRange();
  after.setStartAfter(space); after.collapse(true);
  sel.removeAllRanges(); sel.addRange(after);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function attachRichMention(el, kindFn) {
  richKind = kindFn || richKind;
  el.addEventListener('input', (e) => {
    if (e.inputType === undefined && m.el === null) return; // our own synthetic event
    const ctx = richContext();
    if (!ctx || ctx.q == null) return hide();
    const rect = ctx.range.getBoundingClientRect();
    m.el = el; m.rich = true; m.range = ctx.range.cloneRange(); m.replaceLen = ctx.len;
    show(filtered(ctx.q), rect.height ? rect : el.getBoundingClientRect());
  });
  el.addEventListener('keydown', (e) => keyNav(e, el));
  el.addEventListener('blur', () => setTimeout(() => m.el === el && hide(), 160));
}

/** Opens the field menu at the caret without typing "@" (toolbar button). */
export function openRichMenu(el) {
  el.focus();
  const sel = window.getSelection();
  let r = sel.rangeCount && el.contains(sel.anchorNode) ? sel.getRangeAt(0) : null;
  if (!r) { r = document.createRange(); r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
  m.el = el; m.rich = true; m.range = r.cloneRange(); m.replaceLen = 0;
  const rect = r.getBoundingClientRect();
  show(filtered(''), rect.height ? rect : el.getBoundingClientRect());
}

/** Insert a token into whichever field last had focus (used by chips). */
export function insertInto(el, token) {
  if (el.isContentEditable) { m.el = el; m.rich = true; m.replaceLen = 0; const s = window.getSelection(); m.range = s.rangeCount && el.contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null; insertRich(el, token); }
  else insertPlain(el, token, false);
}

export function initMentionMenu() {
  menu().addEventListener('mousedown', (e) => {
    const d = e.target.closest('[data-i]');
    if (d) { e.preventDefault(); m.sel = +d.dataset.i; pick(m.items[m.sel]); }
  });
}
