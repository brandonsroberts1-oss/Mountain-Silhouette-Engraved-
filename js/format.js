// Shared formatting: units, coordinates and run-difficulty conventions.

export const FT_PER_M = 3.28084;

export const DIFFICULTY_ORDER = ['novice', 'easy', 'intermediate', 'advanced', 'expert', 'freeride', 'extreme'];

export function difficultyRank(d) {
  const i = DIFFICULTY_ORDER.indexOf(d);
  return i < 0 ? -1 : i;
}

/** Collapse OSM difficulties into four engraving classes. */
export function difficultyClass(d) {
  switch (d) {
    case 'novice':
    case 'easy':
      return 'easy';
    case 'intermediate':
      return 'intermediate';
    case 'advanced':
      return 'advanced';
    case 'expert':
    case 'freeride':
    case 'extreme':
      return 'expert';
    default:
      return 'other';
  }
}

const NA = {
  novice: { symbol: 'circle', label: 'Beginner', short: 'Green Circle' },
  easy: { symbol: 'circle', label: 'Easier', short: 'Green Circle' },
  intermediate: { symbol: 'square', label: 'More Difficult', short: 'Blue Square' },
  advanced: { symbol: 'diamond', label: 'Most Difficult', short: 'Black Diamond' },
  expert: { symbol: 'double', label: 'Experts Only', short: 'Double Black' },
  freeride: { symbol: 'double', label: 'Experts Only', short: 'Double Black' },
  extreme: { symbol: 'double', label: 'Extreme Terrain', short: 'Double Black' },
};

const EU = {
  novice: { symbol: 'circle', label: 'Beginner', short: 'Green' },
  easy: { symbol: 'circle', label: 'Easy', short: 'Blue' },
  intermediate: { symbol: 'square', label: 'Intermediate', short: 'Red' },
  advanced: { symbol: 'diamond', label: 'Difficult', short: 'Black' },
  expert: { symbol: 'double', label: 'Expert', short: 'Black' },
  freeride: { symbol: 'double', label: 'Freeride', short: 'Freeride' },
  extreme: { symbol: 'double', label: 'Extreme', short: 'Extreme' },
};

const JP = {
  novice: { symbol: 'circle', label: 'Beginner', short: 'Green' },
  easy: { symbol: 'circle', label: 'Beginner', short: 'Green' },
  intermediate: { symbol: 'square', label: 'Intermediate', short: 'Red' },
  advanced: { symbol: 'diamond', label: 'Advanced', short: 'Black' },
  expert: { symbol: 'double', label: 'Expert', short: 'Black' },
  freeride: { symbol: 'double', label: 'Off-piste', short: 'Off-piste' },
  extreme: { symbol: 'double', label: 'Extreme', short: 'Extreme' },
};

export function difficultyInfo(difficulty, convention = 'north_america') {
  const table = convention === 'europe' ? EU : convention === 'japan' ? JP : NA;
  return table[difficulty] || table.intermediate;
}

export function round(n, step) {
  return Math.round(n / step) * step;
}

export function withCommas(n) {
  return Math.round(n).toLocaleString('en-US');
}

/** Elevation in metres → { value: '3,600', unit: 'FT' }. */
export function elevationParts(m, units) {
  if (m == null || !Number.isFinite(m)) return { value: '—', unit: '' };
  if (units === 'm') return { value: withCommas(round(m, 1)), unit: 'M' };
  return { value: withCommas(round(m * FT_PER_M, 10)), unit: 'FT' };
}

export function formatElevation(m, units) {
  const p = elevationParts(m, units);
  return p.unit ? `${p.value} ${p.unit}` : p.value;
}

function dms(value) {
  const abs = Math.abs(value);
  let d = Math.floor(abs);
  let m = Math.floor((abs - d) * 60);
  let s = Math.round(((abs - d) * 60 - m) * 60);
  if (s === 60) { s = 0; m += 1; }
  if (m === 60) { m = 0; d += 1; }
  return `${d}°${String(m).padStart(2, '0')}′${String(s).padStart(2, '0')}″`;
}

export function formatCoords(lat, lon, style = 'decimal') {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  if (style === 'dms') {
    return { lat: `${dms(lat)} ${ns}`, lon: `${dms(lon)} ${ew}` };
  }
  return { lat: `${Math.abs(lat).toFixed(4)}° ${ns}`, lon: `${Math.abs(lon).toFixed(4)}° ${ew}` };
}

const COUNTRY_SHORT = { US: 'USA', GB: 'UK', AE: 'UAE' };

export function placeLabel(place) {
  if (!place) return '';
  const country = COUNTRY_SHORT[place.countryCode] || place.country || '';
  return [place.region, country].filter(Boolean).join(' · ');
}

export function slugify(s) {
  return String(s || 'design')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'design';
}
