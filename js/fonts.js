// Bundled OFL fonts (from Fontsource). Each entry lists latin + latin-ext files
// so accented resort names render.

import { parse } from '../vendor/opentype.module.js';
import { makeFontSet } from './render/text.js';

const files = (id, w) => [`${id}/${id}-latin-${w}-normal.woff`, `${id}/${id}-latin-ext-${w}-normal.woff`];

export const FONTS = {
  cinzel: { name: 'Cinzel', files: files('cinzel', 600) },
  playfair: { name: 'Playfair Display', files: files('playfair-display', 700) },
  bebas: { name: 'Bebas Neue', files: files('bebas-neue', 400) },
  josefin: { name: 'Josefin Sans', files: files('josefin-sans', 600) },
  alfa: { name: 'Alfa Slab One', files: files('alfa-slab-one', 400) },
  oswald: { name: 'Oswald', files: files('oswald', 500) },
  montserrat: { name: 'Montserrat', files: files('montserrat', 500) },
  'montserrat-bold': { name: 'Montserrat Bold', files: files('montserrat', 700) },
  'great-vibes': { name: 'Great Vibes', files: files('great-vibes', 400), script: true },
};

export const TITLE_FONT_IDS = ['cinzel', 'playfair', 'bebas', 'josefin', 'alfa', 'oswald', 'montserrat-bold', 'great-vibes'];
export const BODY_FONT_IDS = ['montserrat', 'josefin', 'oswald', 'cinzel'];

/** Bold companion used for stat values. */
export const BOLD_FOR = { montserrat: 'montserrat-bold' };

const cache = new Map();

/** loader(path) → Promise<ArrayBuffer>. */
export function loadFont(id, loader) {
  if (!cache.has(id)) {
    const def = FONTS[id];
    const p = Promise.all(
      def.files.map((f) =>
        loader(f).then(
          (buf) => parse(buf),
          () => null
        )
      )
    ).then((fonts) => {
      const ok = fonts.filter(Boolean);
      if (!ok.length) throw new Error(`Font ${def.name} failed to load`);
      // Script faces must never be forced into capitals.
      return { ...makeFontSet(ok), isScript: !!def.script };
    });
    cache.set(id, p);
  }
  return cache.get(id);
}

export const browserLoader = (path) =>
  fetch(new URL(`../fonts/${path}`, import.meta.url)).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.arrayBuffer();
  });
