// Builds the text/stat content a template prints, from computed stats and the
// user's edits.

import * as icons from './render/icons.js';
import { FT_PER_M, elevationParts, formatCoords, difficultyInfo, placeLabel, withCommas } from './format.js';

export const STAT_DEFS = [
  { id: 'summit', label: 'Summit' },
  { id: 'base', label: 'Base' },
  { id: 'vertical', label: 'Vertical' },
  { id: 'trails', label: 'Trails' },
  { id: 'lifts', label: 'Lifts' },
  { id: 'difficulty', label: 'Max difficulty' },
];

export function currentSeason(date = new Date()) {
  const y = date.getFullYear();
  const start = date.getMonth() >= 6 ? y : y - 1;
  return `${start}/${String(start + 1).slice(-2)}`;
}

function parseNum(s) {
  if (s == null || String(s).trim() === '') return null;
  const n = Number(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Elevation override (typed in display units) → metres. */
function elevOverride(s, units) {
  const n = parseNum(s);
  if (n == null) return null;
  return units === 'm' ? n : n / FT_PER_M;
}

/** Defaults for editable fields given a loaded area. */
export function defaultTexts(area, stats) {
  return {
    title: area ? area.name : '',
    subtitle: area ? placeLabel(area.place) : '',
    personal: '',
    header: `Lift Ticket · ${currentSeason()} Season`,
    stub: 'Admit One',
  };
}

/**
 * s: settings { texts, stats (enabled map), order, overrides, units,
 *               coordStyle, coordSource, showCoords, showSerial, convention }
 */
export function buildContent(stats, s) {
  const units = s.units;
  const ov = s.overrides || {};
  const summitM = elevOverride(ov.summit, units) ?? stats?.summit;
  const baseM = elevOverride(ov.base, units) ?? stats?.base;
  const vertM = elevOverride(ov.vertical, units) ?? (summitM != null && baseM != null ? summitM - baseM : null);
  const trails = parseNum(ov.trails) ?? stats?.trailCount;
  const lifts = parseNum(ov.lifts) ?? stats?.liftCount;
  const diffKey = ov.difficulty || stats?.maxDifficulty || 'advanced';
  const diff = difficultyInfo(diffKey, s.convention);
  const diffIconWidth = diff.symbol === 'double' ? 1.55 : 0.9;

  const defs = {
    summit: () => {
      const p = elevationParts(summitM, units);
      return { icon: icons.peak, value: p.value, unit: p.unit, label: 'Summit', inline: `${p.value} ${p.unit} summit` };
    },
    base: () => {
      const p = elevationParts(baseM, units);
      return { icon: icons.lodge, value: p.value, unit: p.unit, label: 'Base', inline: `${p.value} ${p.unit} base` };
    },
    vertical: () => {
      const p = elevationParts(vertM, units);
      return { icon: icons.vertical, value: p.value, unit: p.unit, label: 'Vertical', inline: `${p.value} ${p.unit} vertical` };
    },
    trails: () => {
      const v = trails != null ? withCommas(trails) : '—';
      return { icon: icons.tracks, value: v, unit: '', label: 'Trails', inline: `${v} trails` };
    },
    lifts: () => {
      const v = lifts != null ? withCommas(lifts) : '—';
      return { icon: icons.chairlift, value: v, unit: '', label: 'Lifts', inline: `${v} lifts` };
    },
    difficulty: () => ({
      icon: (cx, cy, sz) => icons.difficultyIcon(diff.symbol, cx, cy, sz),
      iconWidth: diffIconWidth,
      value: diff.short,
      unit: '',
      label: 'Toughest run',
      inline: diff.short,
    }),
  };

  const order = s.order || STAT_DEFS.map((d) => d.id);
  const list = order.filter((id) => s.stats[id] && defs[id]).map((id) => ({ id, ...defs[id]() }));

  let coords = '';
  let serial = '';
  const ll = stats ? (s.coordSource === 'summit' ? stats.summitLonLat : s.coordSource === 'base' ? stats.baseLonLat : stats.centerLonLat) : null;
  if (ll) {
    const c = formatCoords(ll[1], ll[0], s.coordStyle);
    coords = `${c.lat}  ·  ${c.lon}`;
    serial = `No. ${Math.round(Math.abs(ll[1]) * 100)}-${Math.round(Math.abs(ll[0]) * 100)}`;
  }

  return {
    title: s.texts.title,
    subtitle: s.texts.subtitle,
    personal: s.texts.personal,
    header: s.texts.header,
    stub: s.texts.stub,
    coords: s.showCoords ? coords : '',
    serial: s.showSerial ? serial : '',
    stats: list,
    maxDifficulty: diff,
    northAngle: null,
  };
}
