# Fall Line Studio

Search any ski area and get a laser-ready SVG of its trails, its terrain, and the
mountain's stats. You see a live preview on slate, wood, leather or acrylic, then
export a file sized in millimetres that imports straight into **xTool Studio**.

The trails are not traced by hand. They come from OpenStreetMap, are placed on a
real elevation model, and are drawn in one of two views:

- **Mountain view** (the default on coasters, badges and tickets): an oblique
  view from the base looking uphill, like a painted resort trail map. Trails
  hidden behind ridges are removed. The terrain is drawn as **3D ridgelines**
  (Joy-Division-style horizon slices) or as a clean **mountain outline**.
- **Top-down map:** a plan view rotated so the summit sits at the top, over
  **contour lines** generated from the terrain.

## Features

| | |
|---|---|
| **Finished-looking trails** | OSM run segments are joined into continuous trails and smoothed to remove GPS jitter. Flicker where trails pass behind ridges is cleaned up. Trails are drawn as **bold tapered strokes** (filled shapes, engraved solid) or as **fine score lines**, and terrain lines stop short of each trail so it stands out. |
| **Search** | Ski areas worldwide via OpenSkiMap. Falls back to OpenStreetMap Nominatim + Overpass if needed. |
| **Stats** | Summit and base elevation, vertical drop, trail count with a difficulty breakdown, toughest run, lift count, location, and coordinates (centre, summit or base; decimal or DMS). Every value can be overridden. |
| **Templates** | **Summit** (art over title + icon stats row), **Topo** (contour map, checkered map border, title cartouche, north arrow), **Badge** (round seal with text on arcs), **Lift Ticket** (tear-off stub, dotted stat leaders, serial number made from the coordinates). |
| **Personalisation** | Title, location line, a script-font message ("Our first run together · 2026"), and a **favourite run** drawn as a ribbon with a star or heart marker. |
| **Laser export** | True-size mm SVG with only `<g>` and `<path>`: no text, fonts, masks, clip paths or dash arrays. Text is converted to outlines. Each operation gets its own colour so it becomes its own layer. Optional per-difficulty trail layers and a red outline of the blank. |
| **Mockups** | PNG export of the material preview, for product listings. |

### Positioning (why this design)

A quick look at what engraved ski-map products already sell:

- Flat trail-map wall art on wood (e.g. Mountaincut, Etsy sellers)
- Aspen trail-map ornaments (Parks Art)
- Slate coasters with contours and trails of New England mountains (Bay Slate Coasters)
- Custom piste maps with coordinates and dedications (uniquemaps)

Plan-view maps and contour coasters are common. This app leans into what is not:

- **3D mountain view from real terrain** with hidden-line removal. It looks like a
  resort trail map instead of a GPS trace, and it works for any resort with no
  manual drawing.
- **Ridgeline terrain**, a modern graphic style rarely seen on engraved goods.
- **The Lift Ticket format.** No vintage lift-ticket keepsakes turned up in the
  research.
- **Data-rich, giftable personalisation:** a difficulty breakdown, the toughest run, a
  favourite-run highlight, a script dedication, and coordinates.

## Using it with xTool Studio

1. Export with **Download SVG** and import it into xTool Studio. It keeps its
   physical size, e.g. 101.6 × 101.6 mm for a 4″ coaster.
2. Layers are colour-coded:

   | Colour | Content | Suggested processing |
   |---|---|---|
   | Black fill | Text, icons, dots, blocks | Engrave (fill) |
   | Blue `#0000FF` | Trails | Engrave (fill) with *Bold engraved strokes*; Score with *Fine score lines* |
   | Magenta `#FF00FF` | Terrain lines | Score at lower power, so it reads lighter |
   | Cyan `#00A0C8` | Lifts | Score |
   | Orange `#FF7F00` | Favourite run | Score, or higher power for emphasis |
   | Teal `#008080` | Frames, rules, rings | Score |
   | Red `#FF0000` | Blank outline (optional) | Cut, or use only for framing/alignment and set it not to output |

   Choose **All black** under *Colours* if you prefer to assign processing per object.
3. Run a material test grid first. Slate, wood and leather vary a lot between
   machines and batches. Score lines on slate turn light grey and engraved fills
   turn pale.
4. *Trail width* (bold style) is a real physical width: the trails are filled
   shapes, so they engrave as solid lines of that width. 0.35–0.5 mm reads well
   on a 4″ coaster. *Line weight* only sets the preview/SVG stroke width of
   score lines; a score follows the path centreline.

## Running locally

It's a static site with no build step and no dependencies.

```bash
node serve.mjs 8080      # or: npm start
# open http://localhost:8080
```

ES modules and font files need to be served over HTTP; opening `index.html`
directly from disk won't work.

### Deploying (GitHub Pages)

Settings → Pages → *Deploy from a branch* → pick the branch and `/ (root)`.
All paths are relative, so it works from a sub-path. GitHub Pages caches files
for about 10 minutes. After an update, hard-refresh (Ctrl/Cmd+Shift+R) and check
the version shown at the bottom of the page.

## Data sources and accuracy

- **Trails, lifts, ski areas, places:** © OpenStreetMap contributors, via the
  [OpenSkiMap](https://openskimap.org) API
  (`api.openskimap.org/search`, `/features.geojson`). If that's unavailable, it
  falls back to the [Overpass API](https://overpass-api.de) and
  [Nominatim](https://nominatim.org).
- **Elevation:** [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
  (Terrarium PNG, zoom ≤ 14). OpenSkiMap's own min/max elevation is used when
  available.

OpenStreetMap often splits a run into several segments and maps some glades or
connectors without names. The trail count groups segments by name and only counts
unnamed segments longer than 250 m, so it can differ from a resort's advertised
number. Type the official figure into the *Trails* override when selling a
product.

## Project layout

```
index.html, css/styles.css     UI
js/main.js                     state, controls, preview, export
js/content.js                  stats → printable content (icons, units, overrides)
js/format.js                   units, coordinates, difficulty conventions (NA / EU / JP)
js/fonts.js                    bundled OFL fonts (Fontsource WOFF, latin + latin-ext)
js/data/                       OpenSkiMap, Overpass/Nominatim, terrain tiles, model + stats
js/render/scene.js             3D oblique projection, ray-marched hidden lines,
                               floating-horizon ridgelines/outline, plan view + contours
js/render/contours.js          marching squares
js/render/geometry.js          clipping, simplification, smoothing, dashes, ribbons
js/render/text.js              opentype.js text → outlined paths (straight and on arcs)
js/render/templates.js         the four layouts
js/render/svg.js               preview (material simulation) and laser export
vendor/opentype.module.js      opentype.js 1.3.4 (MIT)
fonts/                         Cinzel, Playfair Display, Bebas Neue, Josefin Sans,
                               Alfa Slab One, Oswald, Montserrat, Great Vibes (OFL)
```

## Tests

```bash
npm test             # unit tests (node --test): geometry, contours, hidden lines, stats, text, SVG safety
npm run test:e2e     # headless Chromium end-to-end run with all APIs mocked (needs Playwright)
npm run test:layout  # geometric check of every template × size × worst-case text (needs Playwright)
```

The layout check composes every template at every preset size, plus odd custom
sizes, with plain, worst-case (long names, all stats, dedication) and script-font
content. It then samples every engraved path with the browser's SVG geometry engine
to verify four things:

- everything is on the physical blank
- content stays inside the border
- nothing touches a frame line
- no two pieces of text overlap

The end-to-end test uses `tests/fixtures/synthetic-area.json`: synthetic runs
generated on real terrain near Mount Snow, VT. They are for offline testing
only and are not real trail data. Terrain tiles are cached in `tests/.cache/`.
