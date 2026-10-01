// Step 4: certificate designer (Fabric.js canvas) + rendering a certificate for one person.
import {
  $, $$, esc, state, emit, on, toast, activeTpl, fill, applyCase, previewPerson, setPreviewIdx,
  fileNameFor, readAsDataURL, DATE_FORMATS, wireDrop, tokenGroups,
} from './core.js';
import { autosave } from './store.js';
import { attachMention } from './mention.js';

const FONTS = ['Great Vibes', 'Pinyon Script', 'Dancing Script', 'Playfair Display', 'Cinzel', 'Lora', 'Merriweather', 'Montserrat', 'Poppins', 'Roboto', 'Inter', 'Arial', 'Georgia', 'Times New Roman'];
const SYSTEM_FONTS = ['Arial', 'Georgia', 'Times New Roman'];
const CUSTOM_PROPS = ['fieldFit', 'fitPct', 'caseMode', 'removeWhite'];
const TEXT_CONTROLS = ['#fFont', '#fSize', '#fGrow', '#fShrink', '#fBold', '#fItalic', '#fUnder', '#fColor', '#fLine', '#fCase'];

let canvas;
let zoom = 1;
let previewOn = false;
const cert = () => state.ws.cert;
const isText = (o) => o && ['i-text', 'text', 'textbox'].includes(o.type);

/* ---------------- canvas setup ---------------- */
export function hasCert() { return !!state.ws?.cert; }

function fitCanvas() {
  if (!cert()) return;
  const wrap = $('#canvasWrap');
  const avail = Math.max(300, (wrap.clientWidth || 960) - 56);
  const maxH = Math.max(320, window.innerHeight * 0.7);
  zoom = Math.min(avail / cert().W, maxH / cert().H);
  canvas.setDimensions({ width: Math.round(cert().W * zoom), height: Math.round(cert().H * zoom) });
  canvas.setZoom(zoom);
  canvas.requestRenderAll();
}

function loadImage(url) {
  return new Promise((res, rej) => fabric.Image.fromURL(url, (img, err) => (err || !img ? rej(new Error('Image could not be loaded')) : res(img))));
}

async function pdfToImage(file) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: 3 });
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  return c.toDataURL('image/png');
}

export async function setTemplateImage(file) {
  try {
    const url = file.type === 'application/pdf' ? await pdfToImage(file) : await readAsDataURL(file);
    const img = await loadImage(url);
    const oldW = cert()?.W;
    state.ws.cert = { W: img.width, H: img.height, canvas: null };
    if (oldW && oldW !== img.width) { // keep elements in roughly the same place on a different-size image
      const k = img.width / oldW;
      canvas.getObjects().forEach((o) => { o.set({ left: o.left * k, top: o.top * k, scaleX: o.scaleX * k, scaleY: o.scaleY * k }); o.setCoords(); });
    }
    canvas.setBackgroundImage(img, () => {}, { originX: 'left', originY: 'top' });
    renderState();
    fitCanvas();
    autosave();
    emit('cert');
    return true;
  } catch (e) {
    toast('Could not load the certificate: ' + e.message, 'err');
  }
}

export async function loadCertFromWorkspace() {
  const c = cert();
  if (!c?.canvas?.backgroundImage) { if (c) state.ws.cert = null; renderState(); return; }
  const fams = [...new Set((c.canvas.objects || []).map((o) => o.fontFamily).filter(Boolean))];
  await Promise.all(fams.map((f) => document.fonts.load(`40px "${f}"`).catch(() => {})));
  await new Promise((res) => canvas.loadFromJSON(c.canvas, res));
  canvas.getObjects().forEach((o) => isText(o) && (o.initDimensions(), o.setCoords()));
  renderState();
  fitCanvas();
}

export function serializeCert() {
  if (!canvas || !cert()) return null;
  if (previewOn) restoreTemplate();
  const json = canvas.toJSON(CUSTOM_PROPS);
  if (previewOn) applyPerson(previewPerson());
  return json;
}

async function ensureFont(family) {
  if (SYSTEM_FONTS.includes(family)) return;
  try {
    await Promise.all(['', 'bold ', 'italic ', 'italic bold '].map((s) => document.fonts.load(`${s}40px "${family}"`)));
    fabric.util.clearFabricFontCache(family);
    canvas.getObjects().forEach((o) => o.fontFamily === family && o.initDimensions && (o.initDimensions(), o.setCoords()));
    canvas.requestRenderAll();
  } catch { /* offline: system fallback */ }
}

export async function ensureAllFonts() {
  await Promise.all([...new Set(canvas.getObjects().filter(isText).map((o) => o.fontFamily))].map(ensureFont));
}

/* ---------------- elements ---------------- */
function addText(text, opts = {}) {
  if (!cert()) return toast('Upload the certificate image first.', 'err');
  if (previewOn) setPreview(false);
  const H = cert().H;
  const t = new fabric.IText(text, {
    left: cert().W / 2, top: H / 2, originX: 'center', originY: 'center', textAlign: 'center',
    fontFamily: 'Playfair Display', fontSize: Math.round(H * 0.045), fill: '#1f2937', lineHeight: 1.16,
    fieldFit: false, fitPct: 70, caseMode: 'none', ...opts,
  });
  canvas.add(t);
  canvas.setActiveObject(t);
  ensureFont(t.fontFamily);
  changed();
}

async function addImage(file) {
  if (previewOn) setPreview(false);
  const img = await loadImage(await readAsDataURL(file));
  img.scaleToWidth(cert().W * 0.18);
  img.set({ left: cert().W * 0.7, top: cert().H * 0.76, originX: 'center', originY: 'center', removeWhite: false });
  canvas.add(img);
  canvas.setActiveObject(img);
  changed();
}

function setRemoveWhite(img, on) {
  img.removeWhite = on;
  img.filters = on ? [new fabric.Image.filters.RemoveColor({ color: '#ffffff', distance: 0.15 })] : [];
  img.applyFilters();
  canvas.requestRenderAll();
}

function changed() { syncUI(); renderLayers(); autosave(); emit('cert'); }

/* ---------------- preview / personalisation ---------------- */
function applyPerson(p) {
  canvas.getObjects().forEach((o) => {
    if (!isText(o)) return;
    o._tpl = o.text; o._base = o.fontSize;
    o.set({ text: applyCase(fill(o.text, p), o.caseMode) });
    if (o.fieldFit) {
      const max = (cert().W * (o.fitPct || 70)) / 100 / (o.scaleX || 1);
      if (o.width > max) o.set({ fontSize: Math.max(4, (o._base * max) / o.width) });
    }
    o.setCoords();
  });
}

function restoreTemplate() {
  canvas.getObjects().forEach((o) => {
    if (o._tpl === undefined) return;
    o.set({ text: o._tpl, fontSize: o._base });
    delete o._tpl; delete o._base;
    o.setCoords();
  });
}

function setPreview(onFlag) {
  canvas.discardActiveObject();
  if (previewOn) restoreTemplate();
  previewOn = onFlag;
  $('#previewToggle').checked = onFlag;
  if (onFlag) applyPerson(previewPerson());
  canvas.getObjects().forEach((o) => { o.selectable = !onFlag; o.evented = !onFlag; });
  canvas.requestRenderAll();
  syncUI();
}

function refreshPreview() {
  if (!previewOn) return;
  restoreTemplate();
  applyPerson(previewPerson());
  canvas.requestRenderAll();
}

export function certTexts() {
  if (!canvas) return [];
  return canvas.getObjects().filter(isText).map((o) => o._tpl ?? o.text);
}

/**
 * Renders the certificate for one person.
 * thumb=true returns a small JPEG data URL for previews; otherwise a full-resolution attachment.
 */
export async function renderCertificate(p, { thumb = false, tpl = activeTpl() } = {}) {
  if (!cert()) throw new Error('No certificate uploaded');
  if (!canvas.width || canvas.width < 20) fitCanvas();
  const wasPreview = previewOn;
  const active = canvas.getActiveObject();
  if (active?.isEditing) active.exitEditing();
  canvas.discardActiveObject();
  if (wasPreview) restoreTemplate();
  applyPerson(p);
  try {
    if (thumb) {
      const mult = Math.min(1, 1100 / cert().W) / zoom;
      return canvas.toDataURL({ format: 'jpeg', quality: 0.85, multiplier: mult });
    }
    const fmt = tpl.fileFormat || 'pdf';
    const mult = 1 / zoom;
    let out;
    if (fmt === 'png') {
      out = { data: canvas.toDataURL({ format: 'png', multiplier: mult }), mime: 'image/png', ext: 'png' };
    } else {
      const jpg = canvas.toDataURL({ format: 'jpeg', quality: 0.92, multiplier: mult });
      if (fmt === 'jpg') out = { data: jpg, mime: 'image/jpeg', ext: 'jpg' };
      else {
        const w = cert().W * 0.75, h = cert().H * 0.75; // px -> pt
        const pdf = new jspdf.jsPDF({ orientation: w > h ? 'landscape' : 'portrait', unit: 'pt', format: [w, h], compress: true });
        pdf.addImage(jpg, 'JPEG', 0, 0, w, h);
        out = { data: pdf.output('datauristring'), mime: 'application/pdf', ext: 'pdf' };
      }
    }
    return { filename: fileNameFor(p, out.ext, tpl), mime: out.mime, data: out.data.slice(out.data.indexOf(',') + 1) };
  } finally {
    restoreTemplate();
    if (wasPreview) applyPerson(previewPerson());
    canvas.requestRenderAll();
  }
}

/* ---------------- UI sync ---------------- */
function renderState() {
  const has = !!cert();
  $('#certDrop').classList.toggle('hidden', has);
  $('#certEditor').classList.toggle('hidden', !has);
  $('#replaceTop').classList.toggle('hidden', !has);
  syncTemplateUI();
  renderLayers();
}

export function syncTemplateUI() {
  const t = activeTpl();
  $('#certTplName').textContent = t.name;
  $('#incCert2').checked = !!t.includeCert;
  $('#certOffBanner').classList.toggle('hidden', !!t.includeCert);
  if (document.activeElement !== $('#filePattern')) $('#filePattern').value = t.filePattern || '';
  $('#fileFormat').value = t.fileFormat || 'pdf';
  $('#dateFmt').value = state.ws.dateFmt;
  updatePager();
}

function updatePager() {
  const n = state.people.length;
  const p = previewPerson();
  $('#pagerLabel').textContent = n ? `${state.previewIdx + 1}/${n} · ${p.name || '(no name)'}` : `Sample · ${p.name}`;
}

function syncUI() {
  const o = canvas.getActiveObject();
  const text = isText(o) && !previewOn;
  TEXT_CONTROLS.forEach((s) => { $(s).disabled = !text; });
  $$('[data-align]').forEach((b) => { b.disabled = !text; b.classList.toggle('on', text && o.textAlign === b.dataset.align); });
  $('#inspEmpty').classList.toggle('hidden', !!o);
  $('#inspText').classList.toggle('hidden', !text);
  $('#inspImage').classList.toggle('hidden', !(o && o.type === 'image'));
  $('#inspArrange').classList.toggle('hidden', !o);
  if (text) {
    if (document.activeElement !== $('#pText')) $('#pText').value = o.text;
    $('#fFont').value = o.fontFamily;
    if (document.activeElement !== $('#fSize')) $('#fSize').value = Math.round(o.fontSize);
    $('#fColor').value = typeof o.fill === 'string' && o.fill.startsWith('#') ? o.fill : '#000000';
    $('#fBold').classList.toggle('on', o.fontWeight === 'bold');
    $('#fItalic').classList.toggle('on', o.fontStyle === 'italic');
    $('#fUnder').classList.toggle('on', !!o.underline);
    $('#fLine').value = String(o.lineHeight || 1.16);
    $('#fCase').value = o.caseMode || 'none';
    $('#pFit').checked = !!o.fieldFit;
    $('#pFitPct').value = o.fitPct || 70;
    $('#pFitVal').textContent = o.fitPct || 70;
    $('#pFitRow').classList.toggle('hidden', !o.fieldFit);
  } else if (o?.type === 'image') {
    $('#pRemoveWhite').checked = !!o.removeWhite;
    $('#pOpacity').value = Math.round((o.opacity ?? 1) * 100);
  }
  $$('.layer').forEach((l) => l.classList.toggle('on', canvas.getObjects()[+l.dataset.i] === o));
}

function renderLayers() {
  if (!canvas) return;
  const objs = canvas.getObjects();
  $('#layers').innerHTML = objs.map((o, i) => ({ o, i })).reverse().map(({ o, i }) => {
    const label = isText(o) ? (o._tpl ?? o.text).replace(/\s+/g, ' ') : 'Image';
    return `<div class="layer" data-i="${i}"><b>${isText(o) ? 'T' : '🖼'}</b><span>${esc(label)}</span></div>`;
  }).join('') || '<div class="muted small">Nothing added yet.</div>';
}

function setProp(props) {
  const o = canvas.getActiveObject();
  if (!o) return;
  o.set(props);
  if (o.initDimensions) o.initDimensions();
  o.setCoords();
  canvas.requestRenderAll();
  changed();
}

function deleteSelected() {
  const objs = canvas.getActiveObjects();
  if (!objs.length) return;
  objs.forEach((o) => canvas.remove(o));
  canvas.discardActiveObject();
  canvas.requestRenderAll();
  changed();
}

function renderAddFields() {
  const items = tokenGroups().filter((g) => g.label !== 'Automatic').flatMap((g) => g.items).filter((t) => t !== 'Name');
  $('#addFieldList').innerHTML = items.map((c) => `<button data-field="${esc(c)}"><span>${esc(c)}</span></button>`).join('')
    || '<div class="muted small" style="padding:6px 10px">Upload the sheet to list its columns.</div>';
}

/* ---------------- init ---------------- */
export function onShowCertificate() {
  syncTemplateUI();
  requestAnimationFrame(() => { fitCanvas(); refreshPreview(); });
}

export function initCertificate() {
  canvas = new fabric.Canvas('cert', { preserveObjectStacking: true, backgroundColor: '#ffffff', width: 10, height: 10 });
  canvas.on('selection:created', syncUI);
  canvas.on('selection:updated', syncUI);
  canvas.on('selection:cleared', syncUI);
  canvas.on('object:modified', changed);
  canvas.on('text:changed', changed);
  window.addEventListener('resize', () => $('#page-certificate').classList.contains('active') && fitCanvas());

  $('#fFont').innerHTML = FONTS.map((f) => `<option style="font-family:'${f}'" value="${f}">${f}</option>`).join('');
  $('#dateFmt').innerHTML = Object.entries(DATE_FORMATS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');

  wireDrop($('#certDrop'), $('#tplFile'), setTemplateImage);
  $('#replaceTop').addEventListener('click', () => $('#tplFile2').click());
  $('#tplFile2').addEventListener('change', (e) => { if (e.target.files[0]) setTemplateImage(e.target.files[0]); e.target.value = ''; });

  // + Add menu
  $('#addBtn').addEventListener('click', (e) => { e.stopPropagation(); renderAddFields(); $('#addMenu').classList.toggle('hidden'); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#addMenu') && !e.target.closest('#addBtn')) $('#addMenu').classList.add('hidden'); });
  $('#addMenu').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('#addMenu').classList.add('hidden');
    const H = cert()?.H || 1000;
    if (b.dataset.add === 'name') addText('{{Name}}', { fontFamily: 'Great Vibes', fontSize: Math.round(H * 0.08), fieldFit: true });
    else if (b.dataset.add === 'date') addText('{{Today}}', { fontFamily: 'Montserrat', fontSize: Math.round(H * 0.025), left: cert().W * 0.3, top: H * 0.78 });
    else if (b.dataset.add === 'text') addText('Your text here', { fontFamily: 'Lora', fontSize: Math.round(H * 0.03), top: H * 0.62 });
    else if (b.dataset.add === 'image') $('#imgFile').click();
    else if (b.dataset.field) addText(`{{${b.dataset.field}}}`, { fontFamily: 'Montserrat', fontSize: Math.round(H * 0.032), fieldFit: true, top: H * 0.62 });
  });
  $('#imgFile').addEventListener('change', (e) => { if (e.target.files[0]) addImage(e.target.files[0]); e.target.value = ''; });

  // Word-style ribbon
  $('#fFont').addEventListener('change', (e) => { setProp({ fontFamily: e.target.value }); ensureFont(e.target.value); });
  $('#fSize').addEventListener('input', (e) => +e.target.value >= 4 && setProp({ fontSize: +e.target.value }));
  $('#fGrow').addEventListener('click', () => { const o = canvas.getActiveObject(); if (isText(o)) setProp({ fontSize: Math.round(o.fontSize * 1.1) + 1 }); });
  $('#fShrink').addEventListener('click', () => { const o = canvas.getActiveObject(); if (isText(o)) setProp({ fontSize: Math.max(4, Math.round(o.fontSize / 1.1) - 1) }); });
  $('#fBold').addEventListener('click', () => setProp({ fontWeight: canvas.getActiveObject()?.fontWeight === 'bold' ? 'normal' : 'bold' }));
  $('#fItalic').addEventListener('click', () => setProp({ fontStyle: canvas.getActiveObject()?.fontStyle === 'italic' ? 'normal' : 'italic' }));
  $('#fUnder').addEventListener('click', () => setProp({ underline: !canvas.getActiveObject()?.underline }));
  $('#fColor').addEventListener('input', (e) => setProp({ fill: e.target.value }));
  $$('[data-align]').forEach((b) => b.addEventListener('click', () => setProp({ textAlign: b.dataset.align })));
  $('#fLine').addEventListener('change', (e) => setProp({ lineHeight: +e.target.value }));
  $('#fCase').addEventListener('change', (e) => setProp({ caseMode: e.target.value }));

  // inspector
  attachMention($('#pText'));
  $('#pText').addEventListener('input', (e) => setProp({ text: e.target.value }));
  $('#pFit').addEventListener('change', (e) => setProp({ fieldFit: e.target.checked }));
  $('#pFitPct').addEventListener('input', (e) => setProp({ fitPct: +e.target.value }));
  $('#pOpacity').addEventListener('input', (e) => setProp({ opacity: +e.target.value / 100 }));
  $('#pRemoveWhite').addEventListener('change', (e) => { const o = canvas.getActiveObject(); if (o?.type === 'image') { setRemoveWhite(o, e.target.checked); changed(); } });
  $('#pCenterH').addEventListener('click', () => { const o = canvas.getActiveObject(); if (o) { o.set({ originX: 'center', left: cert().W / 2 }); o.setCoords(); canvas.requestRenderAll(); changed(); } });
  $('#pCenterV').addEventListener('click', () => { const o = canvas.getActiveObject(); if (o) { o.set({ originY: 'center', top: cert().H / 2 }); o.setCoords(); canvas.requestRenderAll(); changed(); } });
  $('#pFront').addEventListener('click', () => { canvas.getActiveObject()?.bringForward(); changed(); });
  $('#pBack').addEventListener('click', () => { canvas.getActiveObject()?.sendBackwards(); changed(); });
  $('#pDup').addEventListener('click', () => {
    const o = canvas.getActiveObject();
    o?.clone((c) => { c.set({ left: o.left + 40, top: o.top + 40 }); canvas.add(c); canvas.setActiveObject(c); changed(); }, CUSTOM_PROPS);
  });
  $('#pDelete').addEventListener('click', deleteSelected);
  $('#layers').addEventListener('click', (e) => {
    const l = e.target.closest('.layer');
    if (!l || previewOn) return;
    canvas.setActiveObject(canvas.getObjects()[+l.dataset.i]);
    canvas.requestRenderAll();
    syncUI();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && $('#page-certificate').classList.contains('active')
      && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !document.activeElement.isContentEditable
      && !canvas.getActiveObject()?.isEditing) deleteSelected();
  });

  // preview
  $('#previewToggle').addEventListener('change', (e) => setPreview(e.target.checked));
  $('#prevRow').addEventListener('click', () => setPreviewIdx(state.previewIdx - 1));
  $('#nextRow').addEventListener('click', () => setPreviewIdx(state.previewIdx + 1));

  // per-template output settings
  attachMention($('#filePattern'));
  $('#filePattern').addEventListener('input', (e) => { activeTpl().filePattern = e.target.value; autosave(); emit('template'); });
  $('#fileFormat').addEventListener('change', (e) => { activeTpl().fileFormat = e.target.value; autosave(); emit('template'); });
  $('#dateFmt').addEventListener('change', (e) => { state.ws.dateFmt = e.target.value; refreshPreview(); autosave(); emit('template'); });
  $('#incCert2').addEventListener('change', (e) => { activeTpl().includeCert = e.target.checked; syncTemplateUI(); autosave(); emit('template'); });

  on('preview-person', () => { updatePager(); refreshPreview(); });
  on('people', () => { updatePager(); refreshPreview(); });
  on('vars', refreshPreview);
  on('template-switched', syncTemplateUI);
  syncUI();
}
