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
| **Finished-looking trails** | OSM run segments are joined into continuous trails and smoothed to remove GPS jitter. Flicker where trails pass behind ridges is cleaned up. Trails are drawn as **tapered strokes** or **even-width lines**, and terrain lines stop short of each trail so it stands out. |
| **Search** | Ski areas worldwide via OpenSkiMap. Falls back to OpenStreetMap Nominatim + Overpass if needed. |
| **Stats** | Summit and base elevation, vertical drop, trail count with a difficulty breakdown, toughest run, lift count, location, and coordinates (centre, summit or base; decimal or DMS). Every value can be overridden. |
| **Templates** | **Summit** (art over title + icon stats row), **Topo** (contour map, checkered map border, title cartouche, north arrow), **Badge** (round seal with text on arcs), **Lift Ticket** (tear-off stub, dotted stat leaders, serial number made from the coordinates). |
| **Personalisation** | Title, location line, a script-font message ("Our first run together · 2026"), and a **favourite run** drawn as a ribbon with a star or heart marker. |
| **Laser export** | True-size mm SVG made only of filled `<path>`s: every line is outlined to its engraved width (no thin score lines), text is converted to outlines, and overlaps are merged so nothing burns twice. There are no fonts, masks, clip paths or dash arrays. Each layer has its own colour so it can get its own power and speed. Optional per-difficulty trail layers and a red outline of the blank. |
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

**Everything engraves.** There are no hairline score lines. Every line in a
design is exported as a filled shape of real width: terrain ridgelines and
contours, lifts, borders, rings, rules and trails. xTool fills it like text,
so lines come out solid and consistent instead of a single faint pass. Shapes
are merged so nothing overlaps. Where layers cross (e.g. a lift over a trail),
the upper one is cut out of the lower, so no spot is burned twice.

1. Export with **Download SVG** and import it into xTool Studio. It keeps its
   physical size, e.g. 101.6 × 101.6 mm for a 4″ coaster.
2. Set every colour layer to **Engrave**. Layers are colour-coded so each can
   have its own power and speed:

   | Colour | Content | Suggestion |
   |---|---|---|
   | Black | Text, icons, dots, map-border blocks | Engrave |
   | Blue `#0000FF` | Trails | Engrave |
   | Magenta `#FF00FF` | Terrain lines | Engrave at lower power for a softer look |
   | Cyan `#00A0C8` | Lifts | Engrave |
   | Orange `#FF7F00` | Favourite run | Engrave, or higher power for emphasis |
   | Teal `#008080` | Frames, rules, rings | Engrave |
   | Red `#FF0000` | Blank outline (optional, a thin line) | Cut, or use only for framing/alignment and set it not to output |

   Choose **All black** under *Colours* to put everything on one layer.
3. Line widths are real physical widths:
   - **Line width** (default 0.25 mm) sets borders, rules, rings and lifts.
     Terrain lines are 0.8× this.
   - **Trail width** (default 0.4 mm) sets the trails.

   0.2–0.5 mm engraves well on slate, wood and leather. Ridgelines and contour
   lines are thinned automatically at small sizes so neighbouring lines stay at
   least ~0.6 mm apart and don't fuse together.
4. Run a material test grid first. Slate, wood and leather vary a lot between
   machines and batches. On slate, engraved areas turn pale grey-white.

## Running locally

It's a static site with no build step and no dependencies.

```bash
node serve.mjs 8080      # or: npm start
# open http://localhost:8080
```

ES modules and font files need to be served over HTTP; opening `index.html`
directly from disk won't work.

### Deploying (GitHub Pages)

1. Settings → Pages → *Build and deployment* → **Source: GitHub Actions** (one time).
2. The `pages` workflow runs on every push to the default branch and daily. It
   rebuilds the trail data once a week (cached otherwise) and deploys the site. You can also run it by hand
   from the Actions tab (*Run workflow*, optionally with *refresh*).

GitHub Pages caches files for about 10 minutes. After an update, hard-refresh
(Ctrl/Cmd+Shift+R) and check the version and data date at the bottom of the page.

To run the app locally with bundled data, run `npm run build-data` (downloads
the OpenSkiData files, or OpenSnowMap's extract if those are unavailable) and
then `node serve.mjs`.

## Data sources and accuracy

**Trail data is self-hosted.** The `pages` GitHub Actions workflow downloads
OpenSkiMap's published GeoJSON files (`ski_areas`, `runs`, `lifts` from
[OpenSkiData](https://openskidata.org)) once a week. It splits them into a
search index (`data/index.json`) and one small file per ski area
(`data/areas/<id>.json`), and publishes them to GitHub Pages with the app. The
browser loads trails from the app's own site, so it doesn't depend on
third-party APIs being reachable, fast or CORS-friendly.

If OpenSkiMap's download server is down (downloads are retried for several
minutes first), the data is built from [OpenSnowMap](https://www.opensnowmap.org)'s
daily OpenStreetMap piste extract (`planet_pistes.osm.gz`) instead. Ski areas
then come from OpenStreetMap ski-area relations (`site=piste`) and named ski-area
outlines (`landuse=winter_sports`), with state/country names from
[Natural Earth](https://www.naturalearthdata.com); summit and base elevations
come from the terrain data. The footer names the source in use. The workflow
runs daily and goes back to OpenSkiMap data as soon as it's available. If
neither source can be downloaded, the previous copy of the data is deployed
(or, before the first successful build, the app without bundled data).

Following OpenSkiData's terms, the app does **not** use OpenSkiMap's map tiles
directly.

Fallbacks, used only when a deployment has no bundled data (e.g. `node serve.mjs`
without `npm run build-data`) or a ski area isn't in it:

- **Search:** the OpenSkiMap search API, then [Nominatim](https://nominatim.org).
- **Trails:** the [Overpass API](https://overpass-api.de). If the main server is
  silent for a few seconds, mirrors are asked in parallel and the first good
  answer wins.

Every network request has a deadline. The loading pill shows elapsed time and a
**Cancel** button, and failures name the source and reason.

**Elevation:** [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
(Terrarium PNG, zoom ≤ 14). OpenSkiMap's own min/max elevation is used when
available.

**Licence:** trail data © OpenStreetMap contributors (ODbL), with Skimap.org
data, processed by OpenSkiMap (or, for the fallback, the OpenStreetMap extract
courtesy of opensnowmap.org, with Natural Earth region names). The published
`data/` folder carries the matching notice in `data/LICENSE.txt`, and the app
footer credits the source in use.

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
js/data/                       bundled data (local.js), OpenSkiMap API, Overpass/Nominatim,
                               request deadlines (net.js), terrain tiles, model + stats
scripts/build-data.mjs         trail data build → data/index.json + data/areas/*.json
scripts/data/                  readers: OpenSkiMap GeoJSON, OpenSnowMap OSM XML (fallback),
                               Natural Earth regions; downloads with retries
.github/workflows/pages.yml    builds the data (weekly) and deploys app + data to GitHub Pages
js/render/scene.js             3D oblique projection, ray-marched hidden lines,
                               floating-horizon ridgelines/outline, plan view + contours
js/render/contours.js          marching squares
js/render/geometry.js          clipping, simplification, smoothing, dashes, ribbons
js/render/text.js              opentype.js text → outlined paths (straight and on arcs)
js/render/templates.js         the four layouts
js/render/svg.js               preview (material simulation) and laser export
js/render/outline.js           lines → engraved outlines, merging and layer cut-outs (Clipper)
vendor/opentype.module.js      opentype.js 1.3.4 (MIT)
vendor/clipper.module.js       Clipper 6.4.2 polygon offsetting/booleans (Boost licence)
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
