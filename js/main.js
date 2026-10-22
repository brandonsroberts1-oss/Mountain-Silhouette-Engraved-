// App wiring: state, controls, live preview and export.

import { search, loadArea } from './data/index.js';
import { buildScene, uphillBearing } from './render/scene.js';
import { composeDesign } from './render/compose.js';
import { TEMPLATES, getTemplate } from './render/templates.js';
import { buildSvg, MATERIALS, usedLayers } from './render/svg.js';
import { buildContent, defaultTexts, STAT_DEFS } from './content.js';
import { FONTS, TITLE_FONT_IDS, BODY_FONT_IDS, BOLD_FOR, loadFont, browserLoader } from './fonts.js';
import {
  formatElevation, formatCoords, difficultyInfo, slugify, DIFFICULTY_ORDER, placeLabel, FT_PER_M, withCommas,
} from './format.js';

// Shown in the footer so a stale cached copy is easy to spot.
export const APP_VERSION = '1.3.0';

const QUICK_PICKS = ['Mount Snow', 'Killington', 'Stowe', 'Vail', 'Jackson Hole', 'Whistler Blackcomb', 'Zermatt', 'Niseko'];
const STORAGE_KEY = 'fall-line-studio:v2';
const LEGACY_KEYS = ['fall-line-studio:v1'];

const DEFAULTS = {
  template: 'summit',
  sizeId: 'sq4',
  customW: 101.6,
  customH: 101.6,
  view: { mode: '3d', terrain: 'ridges', azimuthOffset: 0, pitch: 24, exaggeration: 1.7, ridgeCount: 48, isolate: true, smooth: 2, contourInterval: 0 },
  art: { liftStyle: 'dashed', zoom: 1, offsetY: 0, highlightMarker: 'star', trailStyle: 'bold', trailWidth: 0.4, taper: true, knockout: true },
  text: { titleFont: 'cinzel', bodyFont: 'montserrat', titleScale: 1, smallCaps: true, border: true, dividers: true },
  stats: { summit: true, base: false, vertical: true, trails: true, lifts: false, difficulty: true },
  units: 'ft',
  showCoords: true,
  showSerial: true,
  coordStyle: 'decimal',
  coordSource: 'center',
  export: { lineWidth: 0.25, colorMode: 'layers', layerByDifficulty: false, includeCut: false },
  material: 'slate',
};

const $ = (id) => document.getElementById(id);

function loadSettings() {
  try {
    let saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved) {
      // Older versions: keep the user's choices and last mountain, but adopt
      // the new trail rendering and the 3D ridgeline default.
      for (const key of LEGACY_KEYS) {
        const old = JSON.parse(localStorage.getItem(key) || 'null');
        if (old && old.settings) {
          delete old.settings.art?.trailStyle;
          if (old.settings.view) {
            delete old.settings.view.smooth;
            if (old.settings.view.mode !== 'map') old.settings.view.terrain = 'ridges';
          }
          saved = old;
          break;
        }
      }
    }
    if (saved && saved.settings) {
      const s = structuredClone(DEFAULTS);
      for (const k of Object.keys(s)) {
        if (saved.settings[k] === undefined) continue;
        s[k] = typeof s[k] === 'object' ? { ...s[k], ...saved.settings[k] } : saved.settings[k];
      }
      return { settings: s, lastArea: saved.lastArea || null };
    }
  } catch {
    // Storage unavailable or corrupt: fall back to defaults.
  }
  return { settings: structuredClone(DEFAULTS), lastArea: null };
}

const boot = loadSettings();
const settings = boot.settings;

// Per-area state (reset when a new area loads).
let current = null; // { area, model, dem, stats, autoAzimuth, texts, overrides, convention, highlight, source }
let sceneCache = { key: '', scene: null };
let lastDoc = null;
let searchCtl = null;
let loadCtl = null;
const fontSets = {};

function save() {
  try {
    let lastArea = current ? current.area : null;
    if (lastArea && JSON.stringify(lastArea).length > 150000) {
      lastArea = { ...lastArea, geometry: { type: 'Point', coordinates: lastArea.center } };
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, lastArea }));
  } catch {
    // Ignore quota / privacy-mode errors.
  }
}

// ---------------------------------------------------------------------------
// Fonts

async function ensureFonts() {
  const ids = new Set([settings.text.titleFont, settings.text.bodyFont, BOLD_FOR[settings.text.bodyFont] || settings.text.bodyFont, 'great-vibes']);
  await Promise.all(
    [...ids].map(async (id) => {
      if (!fontSets[id]) fontSets[id] = await loadFont(id, browserLoader);
    })
  );
  return {
    title: fontSets[settings.text.titleFont],
    body: fontSets[settings.text.bodyFont],
    bold: fontSets[BOLD_FOR[settings.text.bodyFont] || settings.text.bodyFont],
    script: fontSets['great-vibes'],
  };
}

// ---------------------------------------------------------------------------
// Rendering

function sizeOf(tpl) {
  if (settings.sizeId === 'custom') {
    const w = clamp(+settings.customW || 100, 20, 600);
    const h = tpl.shape === 'circle' ? w : clamp(+settings.customH || 100, 20, 600);
    return { w, h, label: 'Custom' };
  }
  return tpl.sizes.find((s) => s.id === settings.sizeId) || tpl.sizes[0];
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function viewParams() {
  const v = settings.view;
  const az = (((current ? current.autoAzimuth : 0) + v.azimuthOffset) % 360 + 360) % 360;
  return {
    mode: v.mode,
    terrain: v.terrain,
    azimuth: az,
    pitch: v.pitch,
    exaggeration: v.exaggeration,
    ridgeCount: v.ridgeCount,
    isolate: v.isolate,
    smooth: v.smooth,
    contourInterval: v.contourInterval,
    showLifts: settings.art.liftStyle !== 'none',
  };
}

function getScene() {
  const view = viewParams();
  const key = JSON.stringify(view);
  if (sceneCache.key !== key || !sceneCache.scene) {
    sceneCache = { key, scene: buildScene(current.model, current.dem, view) };
  }
  return sceneCache.scene;
}

let raf = 0;
function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    renderNow().catch((err) => {
      console.error(err);
      setStatus(`Render failed: ${err.message}`, true);
    });
  });
}

function contentSettings() {
  return {
    texts: current.texts,
    stats: settings.stats,
    overrides: current.overrides,
    units: settings.units,
    coordStyle: settings.coordStyle,
    coordSource: settings.coordSource,
    showCoords: settings.showCoords,
    showSerial: settings.showSerial,
    convention: current.convention,
  };
}

async function renderNow() {
  syncVisibility();
  const tpl = getTemplate(settings.template);
  const size = sizeOf(tpl);
  $('dims').textContent = `${(size.w / 25.4).toFixed(2)} × ${(size.h / 25.4).toFixed(2)} in · ${size.w.toFixed(1)} × ${size.h.toFixed(1)} mm`;
  if (!current) {
    $('preview').innerHTML = '';
    $('empty').classList.remove('hidden');
    $('btn-export-svg').disabled = true;
    $('btn-export-png').disabled = true;
    renderLegend(null);
    return;
  }
  $('empty').classList.add('hidden');
  const fonts = await ensureFonts();
  const scene = getScene();
  const content = buildContent(current.stats, contentSettings());
  if (settings.view.mode === 'map') content.northAngle = -viewParams().azimuth;
  const doc = composeDesign({
    template: tpl,
    W: size.w,
    H: size.h,
    scene,
    content,
    fonts,
    options: {
      titleScale: settings.text.titleScale,
      smallCaps: settings.text.smallCaps,
      border: settings.text.border,
      dividers: settings.text.dividers,
      cornerRadius: 3,
      lineWidth: settings.export.lineWidth,
    },
    artOptions: {
      zoom: settings.art.zoom,
      offsetY: settings.art.offsetY,
      liftStyle: settings.art.liftStyle,
      highlight: current.highlight,
      highlightMarker: settings.art.highlightMarker,
      layerByDifficulty: settings.export.layerByDifficulty,
      trailStyle: settings.art.trailStyle,
      trailWidth: settings.art.trailWidth,
      taper: settings.art.taper,
      knockout: settings.art.knockout,
    },
  });
  lastDoc = doc;
  const preview = buildSvg(doc, {
    mode: 'preview',
    material: settings.material,
    colorMode: settings.export.colorMode,
    includeCut: settings.export.includeCut || settings.material === 'layers',
    blank: doc.cut,
    title: current.texts.title,
  });
  $('preview').innerHTML = preview;
  $('btn-export-svg').disabled = false;
  $('btn-export-png').disabled = false;
  renderLegend(doc);
  save();
}

function renderLegend(doc) {
  const ul = $('legend');
  ul.innerHTML = '';
  if (!doc) return;
  for (const l of usedLayers(doc, settings.export.includeCut)) {
    const color = settings.export.colorMode === 'mono' && l.id !== 'cut' ? '#000000' : l.color;
    const li = document.createElement('li');
    li.innerHTML = `<i style="background:${color}"></i>${l.name}<span>${l.op}</span>`;
    ul.append(li);
  }
}

// ---------------------------------------------------------------------------
// Export

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function fileBase() {
  const tpl = getTemplate(settings.template);
  const size = sizeOf(tpl);
  return `${slugify(current.texts.title || current.area.name)}-${tpl.id}-${Math.round(size.w)}x${Math.round(size.h)}mm`;
}

async function exportSvg() {
  if (!lastDoc) return;
  // Outlining every line can take a moment on dense designs.
  setBusy('Preparing engrave-ready SVG…');
  await new Promise((r) => setTimeout(r, 30));
  try {
    const svg = buildSvg(lastDoc, {
      mode: 'export',
      colorMode: settings.export.colorMode,
      includeCut: settings.export.includeCut,
      title: current.texts.title,
    });
    download(new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}`], { type: 'image/svg+xml' }), `${fileBase()}.svg`);
  } finally {
    setBusy('');
  }
}

async function exportPng() {
  if (!lastDoc) return;
  const material = settings.material === 'layers' ? 'slate' : settings.material;
  const svg = buildSvg(lastDoc, { mode: 'preview', material, blank: lastDoc.cut });
  const pxPerMm = 2400 / Math.max(lastDoc.W, lastDoc.H);
  const w = Math.round(lastDoc.W * pxPerMm);
  const h = Math.round(lastDoc.H * pxPerMm);
  const sized = svg.replace(/width="[\d.]+mm" height="[\d.]+mm"/, `width="${w}" height="${h}"`);
  const url = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    download(blob, `${fileBase()}-${material}.png`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// Search & load

function setStatus(msg, isError = false) {
  const el = $('search-status');
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
}

function setBusy(msg) {
  $('busy').classList.toggle('hidden', !msg);
  $('busy-text').textContent = msg || '';
}

async function runSearch(query, { autoPick = false } = {}) {
  query = query.trim();
  if (!query) return;
  searchCtl?.abort();
  searchCtl = new AbortController();
  setStatus('Searching…');
  $('search-results').innerHTML = '';
  try {
    const { results, source, warning } = await search(query, { signal: searchCtl.signal });
    if (!results.length) {
      setStatus(`No ski areas found for “${query}”. Try the resort's official name.`, true);
      return;
    }
    setStatus(`${results.length} result${results.length > 1 ? 's' : ''} from ${source}${warning ? ` · ${warning}` : ''}`);
    renderResults(results);
    const strong = results.find((r) => r.name.toLowerCase().includes(query.toLowerCase()));
    if (autoPick && strong) selectArea(strong);
  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus(`Search failed: ${err.message}`, true);
  }
}

function renderResults(results) {
  const ul = $('search-results');
  ul.innerHTML = '';
  for (const r of results) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const where = [r.place?.locality, r.place?.region, r.place?.country].filter(Boolean).join(', ');
    b.innerHTML = `<b></b><small></small>`;
    b.querySelector('b').textContent = r.name;
    b.querySelector('small').textContent = where || `${r.center[1].toFixed(3)}, ${r.center[0].toFixed(3)}`;
    b.addEventListener('click', () => {
      ul.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      selectArea(r);
    });
    li.append(b);
    ul.append(li);
  }
}

async function selectArea(area) {
  loadCtl?.abort();
  loadCtl = new AbortController();
  setBusy(`Loading ${area.name}…`);
  try {
    const data = await loadArea(area, { signal: loadCtl.signal, onProgress: (m) => setBusy(m) });
    current = {
      ...data,
      autoAzimuth: uphillBearing(data.model, data.dem),
      texts: defaultTexts(data.area, data.stats),
      overrides: {},
      convention: data.area.convention || 'north_america',
      highlight: '',
    };
    sceneCache = { key: '', scene: null };
    settings.view.azimuthOffset = 0;
    setStatus(`Loaded ${data.model.runs.length} run segments and ${data.model.lifts.length} lifts from ${data.features.source}.${data.notes.length ? ' ' + data.notes.join(' ') : ''}`);
    hydrateAreaControls();
    syncControls();
    schedule();
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    setStatus(`Couldn't load ${area.name}: ${err.message}`, true);
  } finally {
    setBusy('');
  }
}

// ---------------------------------------------------------------------------
// Controls

function templateIcon(id) {
  const icons = {
    summit: '<svg viewBox="0 0 60 46"><rect x="12" y="2" width="36" height="42" rx="3"/><path d="M17 20l8-10 5 6 3-3 10 7"/><path d="M19 28h22M22 33h16M18 39h4M28 39h4M38 39h4"/></svg>',
    topo: '<svg viewBox="0 0 60 46"><rect x="12" y="2" width="36" height="42"/><rect x="15" y="5" width="30" height="36"/><path d="M19 14c6-6 16-6 22 0M21 19c5-4 13-4 18 0M23 24c4-2 10-2 14 0"/><rect x="19" y="30" width="22" height="8"/></svg>',
    badge: '<svg viewBox="0 0 60 46"><circle cx="30" cy="23" r="20"/><circle cx="30" cy="23" r="14"/><path d="M21 27l6-8 4 5 3-3 6 6"/></svg>',
    ticket: '<svg viewBox="0 0 60 46"><path d="M6 8h12a3 3 0 0 0 6 0h30v30H24a3 3 0 0 0-6 0H6z"/><path d="M21 13v20" stroke-dasharray="2 2"/><path d="M28 16h20M28 21h12M38 33l5-7 4 4 3-2"/></svg>',
  };
  return icons[id] || '';
}

function buildStaticControls() {
  // Quick picks
  for (const name of QUICK_PICKS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = name;
    b.addEventListener('click', () => {
      $('search-input').value = name;
      runSearch(name, { autoPick: true });
    });
    $('quick-picks').append(b);
  }

  // Templates
  for (const t of TEMPLATES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tpl';
    b.dataset.id = t.id;
    b.innerHTML = `${templateIcon(t.id)}<b>${t.name}</b><small>${t.blurb}</small>`;
    b.addEventListener('click', () => {
      if (settings.template === t.id) return;
      settings.template = t.id;
      if (!t.sizes.some((s) => s.id === settings.sizeId)) settings.sizeId = t.sizes[0].id;
      settings.view.mode = t.defaults.mode;
      settings.view.terrain = t.defaults.terrain;
      syncControls();
      schedule();
    });
    $('templates').append(b);
  }

  // Fonts
  const fill = (sel, ids) => {
    for (const id of ids) sel.append(new Option(FONTS[id].name, id));
  };
  fill($('titleFont'), TITLE_FONT_IDS);
  fill($('bodyFont'), BODY_FONT_IDS);

  // Materials
  for (const [id, m] of Object.entries(MATERIALS)) $('material').append(new Option(m.name, id));

  // Stats grid
  const grid = $('stat-grid');
  for (const def of STAT_DEFS) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" data-stat="${def.id}"> ${def.label}`;
    grid.append(label);
    let input;
    if (def.id === 'difficulty') {
      input = document.createElement('select');
      input.append(new Option('Auto', ''));
      for (const d of DIFFICULTY_ORDER) input.append(new Option(d[0].toUpperCase() + d.slice(1), d));
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'decimal';
    }
    input.dataset.override = def.id;
    input.setAttribute('aria-label', `${def.label} override`);
    grid.append(input);
  }
}

/** Two-way bindings: [elementId, get, set, kind]. */
const BINDINGS = [
  ['pitch', () => settings.view.pitch, (v) => (settings.view.pitch = +v), 'range', (v) => `${v}°`],
  ['exaggeration', () => settings.view.exaggeration, (v) => (settings.view.exaggeration = +v), 'range', (v) => `${(+v).toFixed(1)}×`],
  ['ridgeCount', () => settings.view.ridgeCount, (v) => (settings.view.ridgeCount = +v), 'range', (v) => `${v}`],
  ['smooth', () => settings.view.smooth, (v) => (settings.view.smooth = +v), 'range', (v) => ['Off', 'Light', 'Medium', 'Strong'][+v]],
  ['zoom', () => settings.art.zoom, (v) => (settings.art.zoom = +v), 'range', (v) => `${Math.round(v * 100)}%`],
  ['offsetY', () => settings.art.offsetY, (v) => (settings.art.offsetY = +v), 'range', (v) => `${Math.round(v * 100)}%`],
  ['titleScale', () => settings.text.titleScale, (v) => (settings.text.titleScale = +v), 'range', (v) => `${Math.round(v * 100)}%`],
  ['isolate', () => settings.view.isolate, (v) => (settings.view.isolate = v), 'check'],
  ['trailStyle', () => settings.art.trailStyle, (v) => (settings.art.trailStyle = v), 'select'],
  ['trailWidth', () => settings.art.trailWidth, (v) => (settings.art.trailWidth = +v), 'range', (v) => `${(+v).toFixed(2)} mm`],
  ['taper', () => settings.art.taper, (v) => (settings.art.taper = v), 'check'],
  ['knockout', () => settings.art.knockout, (v) => (settings.art.knockout = v), 'check'],
  ['contourInterval', () => String(settings.view.contourInterval), (v) => (settings.view.contourInterval = +v), 'select'],
  ['terrain', () => settings.view.terrain, (v) => (settings.view.terrain = v), 'select'],
  ['liftStyle', () => settings.art.liftStyle, (v) => (settings.art.liftStyle = v), 'select'],
  ['highlightMarker', () => settings.art.highlightMarker, (v) => (settings.art.highlightMarker = v), 'select'],
  ['titleFont', () => settings.text.titleFont, (v) => (settings.text.titleFont = v), 'select'],
  ['bodyFont', () => settings.text.bodyFont, (v) => (settings.text.bodyFont = v), 'select'],
  ['smallCaps', () => settings.text.smallCaps, (v) => (settings.text.smallCaps = v), 'check'],
  ['border', () => settings.text.border, (v) => (settings.text.border = v), 'check'],
  ['dividers', () => settings.text.dividers, (v) => (settings.text.dividers = v), 'check'],
  ['units', () => settings.units, (v) => (settings.units = v), 'select'],
  ['showCoords', () => settings.showCoords, (v) => (settings.showCoords = v), 'check'],
  ['showSerial', () => settings.showSerial, (v) => (settings.showSerial = v), 'check'],
  ['coordStyle', () => settings.coordStyle, (v) => (settings.coordStyle = v), 'select'],
  ['coordSource', () => settings.coordSource, (v) => (settings.coordSource = v), 'select'],
  ['lineWidth', () => settings.export.lineWidth, (v) => (settings.export.lineWidth = clamp(+v || 0.25, 0.12, 1)), 'number'],
  ['colorMode', () => settings.export.colorMode, (v) => (settings.export.colorMode = v), 'select'],
  ['layerByDifficulty', () => settings.export.layerByDifficulty, (v) => (settings.export.layerByDifficulty = v), 'check'],
  ['includeCut', () => settings.export.includeCut, (v) => (settings.export.includeCut = v), 'check'],
  ['material', () => settings.material, (v) => (settings.material = v), 'select'],
  ['custom-w', () => settings.customW, (v) => (settings.customW = +v), 'number'],
  ['custom-h', () => settings.customH, (v) => (settings.customH = +v), 'number'],
];

const TEXT_FIELDS = { 't-title': 'title', 't-subtitle': 'subtitle', 't-personal': 'personal', 't-header': 'header', 't-stub': 'stub' };

function wireControls() {
  for (const [id, , set, kind, fmt] of BINDINGS) {
    const el = $(id);
    const ev = kind === 'range' || kind === 'number' ? 'input' : 'change';
    el.addEventListener(ev, () => {
      set(kind === 'check' ? el.checked : el.value);
      if (fmt) $(`${id}-out`).textContent = fmt(el.value);
      schedule();
    });
  }

  for (const [id, key] of Object.entries(TEXT_FIELDS)) {
    $(id).addEventListener('input', (e) => {
      if (!current) return;
      current.texts[key] = e.target.value;
      schedule();
    });
  }

  $('azimuth').addEventListener('input', (e) => {
    settings.view.azimuthOffset = +e.target.value;
    updateAzimuthLabel();
    schedule();
  });
  $('azimuth-auto').addEventListener('click', () => {
    settings.view.azimuthOffset = 0;
    $('azimuth').value = 0;
    updateAzimuthLabel();
    schedule();
  });

  $('view-mode').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.value;
    if (!v || v === settings.view.mode) return;
    settings.view.mode = v;
    settings.view.terrain = v === 'map' ? 'contours' : 'ridges';
    syncControls();
    schedule();
  });

  $('size').addEventListener('change', (e) => {
    settings.sizeId = e.target.value;
    syncControls();
    schedule();
  });

  $('highlight').addEventListener('change', (e) => {
    if (current) current.highlight = e.target.value;
    schedule();
  });

  $('convention').addEventListener('change', (e) => {
    if (current) current.convention = e.target.value;
    schedule();
  });

  $('stat-grid').addEventListener('change', (e) => {
    const stat = e.target.dataset.stat;
    if (stat) settings.stats[stat] = e.target.checked;
    const ov = e.target.dataset.override;
    if (ov && current) current.overrides[ov] = e.target.value;
    schedule();
  });
  $('stat-grid').addEventListener('input', (e) => {
    const ov = e.target.dataset.override;
    if (ov && current) {
      current.overrides[ov] = e.target.value;
      schedule();
    }
  });
  $('units').addEventListener('change', () => {
    if (current) {
      for (const k of ['summit', 'base', 'vertical']) current.overrides[k] = '';
    }
    syncStatInputs();
  });

  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch($('search-input').value);
  });

  $('btn-export-svg').addEventListener('click', () => exportSvg().catch((err) => setStatus(`SVG export failed: ${err.message}`, true)));
  $('btn-export-png').addEventListener('click', () => exportPng().catch((err) => setStatus(`PNG export failed: ${err.message}`, true)));
}

function updateAzimuthLabel() {
  const az = viewParams().azimuth;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  $('azimuth-out').textContent = `looking ${dirs[Math.round(az / 45) % 8]} (${Math.round(az)}°)`;
}

/** Push settings into the form. */
function syncControls() {
  const tpl = getTemplate(settings.template);
  document.querySelectorAll('.tpl').forEach((b) => b.classList.toggle('active', b.dataset.id === tpl.id));

  const sizeSel = $('size');
  sizeSel.innerHTML = '';
  for (const s of tpl.sizes) sizeSel.append(new Option(s.label, s.id));
  sizeSel.append(new Option(tpl.shape === 'circle' ? 'Custom diameter…' : 'Custom size…', 'custom'));
  sizeSel.value = settings.sizeId === 'custom' || tpl.sizes.some((s) => s.id === settings.sizeId) ? settings.sizeId : tpl.sizes[0].id;
  $('custom-size').classList.toggle('hidden', settings.sizeId !== 'custom');
  $('custom-h').closest('label').classList.toggle('hidden', tpl.shape === 'circle');

  document.querySelectorAll('#view-mode button').forEach((b) => b.classList.toggle('active', b.dataset.value === settings.view.mode));
  const terrainSel = $('terrain');
  terrainSel.innerHTML = '';
  const opts = settings.view.mode === 'map'
    ? [['contours', 'Contour lines'], ['none', 'None']]
    : [['ridges', '3D ridgelines'], ['outline', 'Mountain outline'], ['none', 'None']];
  for (const [v, l] of opts) terrainSel.append(new Option(l, v));
  if (!opts.some(([v]) => v === settings.view.terrain)) settings.view.terrain = opts[0][0];

  for (const [id, get, , kind, fmt] of BINDINGS) {
    const el = $(id);
    if (kind === 'check') el.checked = !!get();
    else el.value = get();
    if (fmt) $(`${id}-out`).textContent = fmt(el.value);
  }
  $('azimuth').value = settings.view.azimuthOffset;
  updateAzimuthLabel();

  document.querySelectorAll('[data-stat]').forEach((el) => (el.checked = !!settings.stats[el.dataset.stat]));
  syncStatInputs();
  syncVisibility();
}

function syncVisibility() {
  const tpl = getTemplate(settings.template);
  const is3d = settings.view.mode === '3d';
  document.querySelectorAll('.only-3d').forEach((el) => el.classList.toggle('hidden', !is3d));
  document.querySelectorAll('.only-map').forEach((el) => el.classList.toggle('hidden', is3d));
  document.querySelectorAll('.only-ridges').forEach((el) => el.classList.toggle('hidden', settings.view.terrain !== 'ridges'));
  document.querySelectorAll('.only-ticket').forEach((el) => el.classList.toggle('hidden', tpl.id !== 'ticket'));
  document.querySelectorAll('.only-bold').forEach((el) => el.classList.toggle('hidden', settings.art.trailStyle === 'line'));
  $('dividers').closest('label').classList.toggle('hidden', tpl.id !== 'summit');
}

/** Area-specific form values: texts, run names, auto stat placeholders. */
function hydrateAreaControls() {
  for (const [id, key] of Object.entries(TEXT_FIELDS)) $(id).value = current ? current.texts[key] : '';
  const hl = $('highlight');
  hl.innerHTML = '';
  hl.append(new Option('None', ''));
  for (const name of current ? current.stats.trailNames : []) hl.append(new Option(name, name));
  hl.value = current ? current.highlight : '';
  $('convention').value = current ? current.convention : 'north_america';
  renderFacts();
}

function syncStatInputs() {
  const st = current ? current.stats : null;
  const unitsLabel = settings.units === 'm' ? 'm' : 'ft';
  const elev = (m) => (m == null ? '' : `${withCommas(settings.units === 'm' ? m : Math.round((m * FT_PER_M) / 10) * 10)} ${unitsLabel}`);
  const auto = {
    summit: st ? elev(st.summit) : '',
    base: st ? elev(st.base) : '',
    vertical: st ? elev(st.summit - st.base) : '',
    trails: st ? String(st.trailCount) : '',
    lifts: st ? String(st.liftCount) : '',
  };
  document.querySelectorAll('[data-override]').forEach((el) => {
    const id = el.dataset.override;
    if (el.tagName === 'SELECT') {
      el.options[0].textContent = st && st.maxDifficulty ? `Auto (${st.maxDifficulty})` : 'Auto';
      el.value = current?.overrides[id] || '';
    } else {
      el.placeholder = auto[id] ? `Auto: ${auto[id]}` : 'Auto';
      el.value = current?.overrides[id] || '';
    }
  });
  if (current) schedule();
}

function renderFacts() {
  const box = $('facts');
  box.innerHTML = '';
  if (!current) return;
  const { stats, area } = current;
  const units = settings.units;
  const conv = current.convention;
  const c = formatCoords(stats.centerLonLat[1], stats.centerLonLat[0], 'decimal');
  const sym = { easy: '●', intermediate: '■', advanced: '◆', expert: '◆◆' };
  const breakdown = Object.entries(sym)
    .filter(([k]) => stats.byClass[k])
    .map(([k, s]) => `${s} ${stats.byClass[k]}`)
    .join('  ');
  const facts = [
    ['Location', [area.place?.locality, placeLabel(area.place)].filter(Boolean).join(' · ') || '—'],
    ['Coordinates', `${c.lat}, ${c.lon}`],
    ['Summit', formatElevation(stats.summit, units)],
    ['Base', formatElevation(stats.base, units)],
    ['Vertical', formatElevation(stats.summit - stats.base, units)],
    ['Trails', `${stats.trailCount}${breakdown ? ` <span class="sym">(${breakdown})</span>` : ''}`],
    ['Max difficulty', stats.maxDifficulty ? difficultyInfo(stats.maxDifficulty, conv).short : '—'],
    ['Lifts', String(stats.liftCount)],
    ['Trail length', `${stats.totalKm.toFixed(1)} km`],
  ];
  for (const [k, v] of facts) {
    const d = document.createElement('div');
    d.className = 'fact';
    d.innerHTML = `<small>${k}</small><b>${v}</b>`;
    box.append(d);
  }
}

// Facts depend on units.
$('units').addEventListener('change', () => renderFacts());

// ---------------------------------------------------------------------------

$('app-version').textContent = `v${APP_VERSION}`;
buildStaticControls();
wireControls();
syncControls();
schedule();
ensureFonts().catch((err) => setStatus(`Fonts failed to load: ${err.message}`, true));
if (boot.lastArea) {
  $('search-input').value = boot.lastArea.name || '';
  selectArea(boot.lastArea);
}

// Exposed for automated tests.
window.__fallLine = { settings, get current() { return current; }, get doc() { return lastDoc; }, selectArea, schedule };
