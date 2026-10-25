/* BGone — js/app.js
   UI wiring and orchestration. The pixel maths lives in removal.js; the AI
   model is lazy-loaded from a pinned CDN build only when the user actually
   asks for AI removal, so opening the page costs nothing. */

import {
  sampleBackgroundColor,
  removeBackgroundByColor,
  countTransparent,
  solidBackground,
  gradientBackground,
  compositeOver,
  parseHex,
} from './removal.js';

const AI_CDN = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.5.5/+esm';
const MAX_ITEMS = 10;
const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $('dropzone'),
  fileInput: $('fileInput'),
  sampleBtn: $('sampleBtn'),
  modeAi: $('modeAi'),
  modeColor: $('modeColor'),
  colorControls: $('colorControls'),
  toleranceRange: $('toleranceRange'),
  toleranceValue: $('toleranceValue'),
  featherRange: $('featherRange'),
  featherValue: $('featherValue'),
  pickedSwatch: $('pickedSwatch'),
  pickedLabel: $('pickedLabel'),
  clearPickedBtn: $('clearPickedBtn'),
  bgMode: $('bgMode'),
  solidRow: $('solidRow'),
  gradientRow: $('gradientRow'),
  blurRow: $('blurRow'),
  customRow: $('customRow'),
  gradientSelect: $('gradientSelect'),
  customSolid: $('customSolid'),
  blurRange: $('blurRange'),
  blurValue: $('blurValue'),
  customBgInput: $('customBgInput'),
  customBgName: $('customBgName'),
  processAllBtn: $('processAllBtn'),
  clearAllBtn: $('clearAllBtn'),
  downloadAllBtn: $('downloadAllBtn'),
  stats: $('stats'),
  resultsGrid: $('resultsGrid'),
  emptyState: $('emptyState'),
  progressWrap: $('progressWrap'),
  progressBar: $('progressBar'),
  progressText: $('progressText'),
  toastRegion: $('toastRegion'),
};

const modal = {
  root: $('compareModal'),
  title: document.querySelector('[data-modal-title]'),
  sub: document.querySelector('[data-modal-sub]'),
  wrap: document.querySelector('[data-compare-wrap]'),
  original: document.querySelector('[data-compare-original]'),
  compressed: document.querySelector('[data-compare-compressed]'),
  divider: document.querySelector('[data-compare-divider]'),
  handle: document.querySelector('[data-compare-handle]'),
  range: document.querySelector('[data-compare-range]'),
  download: $('modalDownloadBtn'),
};

let items = [];
let nextId = 1;
let pickedBg = null; // [r, g, b] sampled by clicking a photo, or null = auto
let customBgUrl = null;
let customBgName = '';
let aiRemove = null;
let aiLoadFailed = false;
let currentModalItem = null;

const GRADIENTS = {
  sunset: ['#E5484D', '#F5A524'],
  ocean: ['#1E6FD9', '#0B0B0F'],
  violet: ['#7C5CFF', '#E5484D'],
  mint: ['#30A46C', '#0B0B0F'],
  blush: ['#F76B8A', '#F5F5F7'],
  mono: ['#23232E', '#F5F5F7'],
};

function toast(message, ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  els.toastRegion.appendChild(el);
  window.setTimeout(() => el.remove(), ms);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function setProgress(text, percent) {
  els.progressWrap.hidden = !text;
  els.progressText.textContent = text || '';
  els.progressBar.value = percent == null ? 0 : percent;
  els.progressBar.classList.toggle('is-indeterminate', percent == null);
}

function currentMode() {
  return els.modeColor.checked ? 'color' : 'ai';
}

function currentBgMode() {
  return els.bgMode.value;
}

function hexOf([r, g, b]) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/* ---------- intake ---------- */

function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/'));
  if (files.length !== fileList.length) {
    toast('Only image files are accepted — other files were skipped.');
  }
  const room = MAX_ITEMS - items.length;
  if (files.length > room) {
    toast(`BGone handles up to ${MAX_ITEMS} images at a time — the first ${Math.max(room, 0)} were kept.`);
  }
  for (const file of files.slice(0, Math.max(room, 0))) {
    items.push({
      id: nextId,
      name: file.name.replace(/\.[^.]+$/, '') || `image-${nextId}`,
      file,
      originalUrl: URL.createObjectURL(file),
      status: 'ready',
      result: null, // { imageData, width, height, blob, mode }
      originalImage: null,
      originalImageData: null,
    });
    nextId += 1;
  }
  render();
}

function makeSampleFile() {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 360;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2fbf71';
  ctx.fillRect(0, 0, 480, 360);
  // Subject: a red disc with a blue bar — plus a small green patch inside
  // the disc, which the flood-fill keyer deliberately keeps.
  ctx.fillStyle = '#E5484D';
  ctx.beginPath();
  ctx.arc(240, 170, 110, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1E6FD9';
  ctx.fillRect(150, 250, 180, 40);
  ctx.fillStyle = '#2fbf71';
  ctx.fillRect(225, 150, 30, 30);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(new File([blob], 'bgone-sample.png', { type: 'image/png' })), 'image/png');
  });
}

async function addSample() {
  setProgress('Building a sample photo…', null);
  try {
    const file = await makeSampleFile();
    addFiles([file]);
    toast('Sample photo added — try Colour mode on it: the green goes away, the subject stays.');
  } finally {
    setProgress('', null);
  }
}

/* ---------- decoding ---------- */

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode this image.'));
    img.src = url;
  });
}

function imageDataOf(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { canvas, ctx, imageData: ctx.getImageData(0, 0, canvas.width, canvas.height) };
}

async function ensureOriginal(item) {
  if (!item.originalImage) {
    item.originalImage = await loadImage(item.originalUrl);
    const decoded = imageDataOf(item.originalImage);
    item.originalCanvas = decoded.canvas;
    item.originalImageData = decoded.imageData;
  }
  return item;
}

/* ---------- AI path ---------- */

async function loadAiLibrary() {
  if (aiRemove) return aiRemove;
  if (aiLoadFailed) throw new Error('AI library failed to load earlier — try Colour mode instead.');
  setProgress('Downloading the AI model (first run only, about 40 MB)…', null);
  try {
    const mod = await import(/* webpackIgnore: true */ AI_CDN);
    aiRemove = mod.removeBackground;
    if (typeof aiRemove !== 'function') throw new Error('AI library loaded but has no removeBackground export.');
    return aiRemove;
  } catch (err) {
    aiLoadFailed = true;
    throw err;
  }
}

async function removeWithAi(item) {
  const removeBackground = await loadAiLibrary();
  const blob = await removeBackground(item.file, {
    output: { format: 'image/png' },
    progress: (key, current, total) => {
      if (total > 0) {
        setProgress(`Downloading ${key} — ${Math.round((current / total) * 100)}%`, Math.round((current / total) * 100));
      } else {
        setProgress(`Loading ${key}…`, null);
      }
    },
  });
  const url = URL.createObjectURL(blob);
  const img = await loadImage(url);
  const decoded = imageDataOf(img);
  URL.revokeObjectURL(url);
  return { imageData: decoded.imageData, width: decoded.canvas.width, height: decoded.canvas.height, blob, mode: 'ai' };
}

/* ---------- colour path ---------- */

async function removeWithColor(item) {
  await ensureOriginal(item);
  const { imageData } = item;
  const bg = pickedBg || sampleBackgroundColor(imageData.data, imageData.width, imageData.height);
  const tolerance = Number(els.toleranceRange.value);
  const feather = Number(els.featherRange.value);
  const out = removeBackgroundByColor(imageData.data, imageData.width, imageData.height, { bg, tolerance, feather });
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d');
  const resultData = new ImageData(new Uint8ClampedArray(out), imageData.width, imageData.height);
  ctx.putImageData(resultData, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return { imageData: resultData, width: imageData.width, height: imageData.height, blob, mode: 'color', bgUsed: bg };
}

/* ---------- processing ---------- */

async function processItem(item) {
  if (item.status === 'working') return;
  item.status = 'working';
  render();
  try {
    if (currentMode() === 'ai') {
      item.result = await removeWithAi(item);
      item.status = 'done';
      toast(`${item.name}: background removed with AI.`);
    } else {
      item.result = await removeWithColor(item);
      const removed = countTransparent(item.result.imageData.data);
      const total = item.result.width * item.result.height;
      item.status = 'done';
      toast(`${item.name}: colour key removed ${Math.round((removed / total) * 100)}% of pixels.`);
    }
  } catch (err) {
    item.status = 'error';
    item.error = err && err.message ? err.message : 'Processing failed.';
    toast(`${item.name}: ${item.error} Colour mode works without any download.`);
  } finally {
    setProgress('', null);
    render();
  }
}

async function processAll() {
  const pending = items.filter((i) => i.status !== 'done' && i.status !== 'working');
  if (pending.length === 0) {
    toast('Nothing left to process — add images or clear the list first.');
    return;
  }
  for (const item of pending) {
    // Sequential on purpose: the AI model is heavy, and parallel runs
    // would fight over memory and make progress unreadable.
    await processItem(item);
  }
}

/* ---------- compositing & export ---------- */

function renderFinalCanvas(item) {
  const { imageData, width, height } = item.result;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const mode = currentBgMode();
  if (mode === 'transparent') {
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }
  if (mode === 'blur') {
    const blurPx = Number(els.blurRange.value);
    const tmp = document.createElement('canvas');
    tmp.width = width;
    tmp.height = height;
    const tctx = tmp.getContext('2d');
    tctx.filter = `blur(${blurPx}px)`;
    tctx.drawImage(item.originalCanvas, 0, 0, width, height);
    ctx.drawImage(tmp, 0, 0);
  } else if (mode === 'custom' && customBgUrl) {
    // Custom backgrounds are drawn by renderFinalCanvasAsync; this sync
    // path is never reached with a custom image set.
    throw new Error('Custom background rendering needs the async path.');
  } else if (mode === 'gradient') {
    const [from, to] = GRADIENTS[els.gradientSelect.value] || GRADIENTS.sunset;
    const bgFn = gradientBackground(from, to, 135);
    const flat = compositeOver(imageData.data, width, height, bgFn);
    ctx.putImageData(new ImageData(flat, width, height), 0, 0);
    return canvas;
  } else {
    const hex = document.querySelector('.swatch.is-active')?.dataset.color || els.customSolid.value;
    const rgb = parseHex(hex) || [245, 245, 247];
    const flat = compositeOver(imageData.data, width, height, solidBackground(rgb[0], rgb[1], rgb[2]));
    ctx.putImageData(new ImageData(flat, width, height), 0, 0);
    return canvas;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function renderFinalCanvasAsync(item) {
  if (currentBgMode() === 'blur') {
    // Blur needs the original pixels; the AI path never decoded them.
    await ensureOriginal(item);
  }
  if (currentBgMode() === 'custom' && customBgUrl) {
    const { imageData, width, height } = item.result;
    const bgImg = await loadImage(customBgUrl);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    // Cover-fit the custom background.
    const scale = Math.max(width / bgImg.naturalWidth, height / bgImg.naturalHeight);
    const dw = bgImg.naturalWidth * scale;
    const dh = bgImg.naturalHeight * scale;
    ctx.drawImage(bgImg, (width - dw) / 2, (height - dh) / 2, dw, dh);
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }
  return renderFinalCanvas(item);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function downloadItem(item) {
  if (!item.result) return;
  const canvas = await renderFinalCanvasAsync(item);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const suffix = currentBgMode() === 'transparent' ? 'transparent' : currentBgMode();
  downloadBlob(blob, `${item.name}-bgone-${suffix}.png`);
}

async function downloadAll() {
  const done = items.filter((i) => i.result);
  if (done.length === 0) {
    toast('Process at least one image before downloading.');
    return;
  }
  if (done.length === 1) {
    await downloadItem(done[0]);
    return;
  }
  if (typeof window.JSZip === 'undefined') {
    toast('ZIP library is unreachable — downloading files one by one instead.');
    for (const item of done) await downloadItem(item);
    return;
  }
  setProgress('Building your ZIP…', null);
  try {
    const zip = new window.JSZip();
    for (const item of done) {
      const canvas = await renderFinalCanvasAsync(item);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      zip.file(`${item.name}-bgone.png`, blob);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(zipBlob, 'bgone-results.zip');
  } finally {
    setProgress('', null);
  }
}

/* ---------- compare modal ---------- */

function setComparePercent(percent) {
  modal.wrap.style.setProperty('--compare-pct', `${percent}%`);
  modal.divider.style.left = `${percent}%`;
  modal.handle.style.left = `${percent}%`;
  modal.range.value = String(percent);
}

function openCompare(item) {
  currentModalItem = item;
  modal.title.textContent = item.name;
  modal.sub.textContent = item.result.mode === 'ai'
    ? 'AI removal · left: result, right: original'
    : 'Colour-key removal · left: result, right: original';
  modal.original.src = item.originalUrl;
  modal.compressed.src = item.result.blob ? URL.createObjectURL(item.result.blob) : '';
  modal.root.classList.add('is-open');
  modal.root.setAttribute('aria-hidden', 'false');
  setComparePercent(50);
}

function closeCompare() {
  modal.root.classList.remove('is-open');
  modal.root.setAttribute('aria-hidden', 'true');
  currentModalItem = null;
}

function onCompareDrag(event) {
  const rect = modal.wrap.getBoundingClientRect();
  const clientX = event.touches ? event.touches[0].clientX : event.clientX;
  const percent = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
  setComparePercent(percent);
}

/* ---------- rendering ---------- */

function statusText(item) {
  if (item.status === 'working') return 'Working…';
  if (item.status === 'done') return item.result.mode === 'ai' ? 'Done · AI' : 'Done · Colour key';
  if (item.status === 'error') return `Failed — ${item.error || 'unknown error'}`;
  return 'Ready';
}

function render() {
  const done = items.filter((i) => i.result).length;
  els.stats.textContent = items.length === 0
    ? ''
    : `${items.length} image${items.length > 1 ? 's' : ''} · ${done} processed`;
  els.emptyState.hidden = items.length !== 0;
  els.downloadAllBtn.disabled = done === 0;
  els.processAllBtn.disabled = items.length === 0;

  els.resultsGrid.innerHTML = '';
  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-images">
        <div class="card-thumb">
          <span class="thumb-label">Original</span>
          <img src="${item.originalUrl}" alt="Original: ${item.name}" data-original-thumb />
        </div>
        <div class="card-thumb is-result">
          <span class="thumb-label">Result</span>
          ${item.result
            ? `<img src="" alt="Background removed: ${item.name}" data-result-thumb />`
            : '<div class="thumb-empty">Not processed yet</div>'}
        </div>
      </div>
      <div class="card-body">
        <h3 class="card-name">${item.name}</h3>
        <p class="card-status" data-status>${statusText(item)}</p>
        <div class="card-actions">
          <button class="btn btn-primary btn-small" type="button" data-process ${item.status === 'working' ? 'disabled' : ''}>${item.result ? 'Re-run' : 'Remove background'}</button>
          <button class="btn btn-secondary btn-small" type="button" data-compare ${item.result ? '' : 'disabled'}>Compare</button>
          <button class="btn btn-secondary btn-small" type="button" data-download ${item.result ? '' : 'disabled'}>Download PNG</button>
          <button class="btn btn-ghost btn-small" type="button" data-remove>Remove</button>
        </div>
      </div>`;
    const resultThumb = card.querySelector('[data-result-thumb]');
    if (resultThumb && item.result) {
      resultThumb.src = URL.createObjectURL(item.result.blob);
    }
    card.querySelector('[data-process]').addEventListener('click', () => processItem(item));
    card.querySelector('[data-compare]').addEventListener('click', () => openCompare(item));
    card.querySelector('[data-download]').addEventListener('click', () => downloadItem(item));
    card.querySelector('[data-remove]').addEventListener('click', () => {
      items = items.filter((i) => i !== item);
      render();
    });
    // Colour picking: in Colour mode, clicking the original samples the
    // background colour at that point.
    card.querySelector('[data-original-thumb]').addEventListener('click', async (event) => {
      if (currentMode() !== 'color') return;
      await ensureOriginal(item);
      const rect = event.currentTarget.getBoundingClientRect();
      const px = Math.floor(((event.clientX - rect.left) / rect.width) * item.originalImageData.width);
      const py = Math.floor(((event.clientY - rect.top) / rect.height) * item.originalImageData.height);
      const i = (py * item.originalImageData.width + px) * 4;
      const d = item.originalImageData.data;
      pickedBg = [d[i], d[i + 1], d[i + 2]];
      els.pickedSwatch.style.background = hexOf(pickedBg);
      els.pickedLabel.textContent = `Picked ${hexOf(pickedBg)} — click another photo to re-pick, or use Auto.`;
      toast(`Background colour picked: ${hexOf(pickedBg)}. Re-run to apply it.`);
    });
    els.resultsGrid.appendChild(card);
  }
}

/* ---------- control visibility ---------- */

function refreshControlVisibility() {
  const color = currentMode() === 'color';
  els.colorControls.hidden = !color;
  const bg = currentBgMode();
  els.solidRow.hidden = bg !== 'solid';
  els.gradientRow.hidden = bg !== 'gradient';
  els.blurRow.hidden = bg !== 'blur';
  els.customRow.hidden = bg !== 'custom';
}

/* ---------- wiring ---------- */

function init() {
  els.dropzone.addEventListener('click', () => els.fileInput.click());
  els.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener('change', () => {
    addFiles(els.fileInput.files);
    els.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((type) => {
    els.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropzone.classList.add('is-dragover');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    els.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropzone.classList.remove('is-dragover');
    });
  });
  els.dropzone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));
  document.addEventListener('paste', (event) => {
    const images = [...(event.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (images.length > 0) addFiles(images);
  });

  els.sampleBtn.addEventListener('click', addSample);
  els.modeAi.addEventListener('change', refreshControlVisibility);
  els.modeColor.addEventListener('change', refreshControlVisibility);
  els.clearPickedBtn.addEventListener('click', () => {
    pickedBg = null;
    els.pickedSwatch.style.background = 'transparent';
    els.pickedLabel.textContent = 'Auto: the background colour is sampled from the photo corners.';
  });
  els.bgMode.addEventListener('change', refreshControlVisibility);

  els.toleranceRange.addEventListener('input', () => {
    els.toleranceValue.textContent = els.toleranceRange.value;
  });
  els.featherRange.addEventListener('input', () => {
    els.featherValue.textContent = els.featherRange.value;
  });
  els.blurRange.addEventListener('input', () => {
    els.blurValue.textContent = `${els.blurRange.value}px`;
  });
  els.customBgInput.addEventListener('change', () => {
    const file = els.customBgInput.files[0];
    if (!file) return;
    if (customBgUrl) URL.revokeObjectURL(customBgUrl);
    customBgUrl = URL.createObjectURL(file);
    customBgName = file.name;
    els.customBgName.textContent = `Using ${customBgName} as the background.`;
  });

  document.querySelectorAll('.swatch').forEach((swatch) => {
    swatch.addEventListener('click', () => {
      document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('is-active'));
      swatch.classList.add('is-active');
      els.customSolid.value = swatch.dataset.color;
    });
  });

  els.processAllBtn.addEventListener('click', processAll);
  els.clearAllBtn.addEventListener('click', () => {
    items = [];
    render();
  });
  els.downloadAllBtn.addEventListener('click', downloadAll);

  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', closeCompare);
  });
  modal.root.addEventListener('click', (event) => {
    if (event.target === modal.root) closeCompare();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCompare();
  });
  modal.range.addEventListener('input', () => setComparePercent(Number(modal.range.value)));
  let dragging = false;
  modal.handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    modal.handle.setPointerCapture(event.pointerId);
    onCompareDrag(event);
  });
  modal.handle.addEventListener('pointermove', (event) => {
    if (dragging) onCompareDrag(event);
  });
  modal.handle.addEventListener('pointerup', () => {
    dragging = false;
  });
  modal.wrap.addEventListener('click', onCompareDrag);
  modal.download.addEventListener('click', () => {
    if (currentModalItem) downloadItem(currentModalItem);
  });

  refreshControlVisibility();
  render();
}

init();
