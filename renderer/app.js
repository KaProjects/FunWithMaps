'use strict';

// Kind codes must match parse.js: 0=path, 1=visit, 2=activity, 3=raw.
const KINDS = [
  { id: 'path',     label: 'Movement path',  factor: 1.0 },
  { id: 'visit',    label: 'Places visited', factor: 1.7 },
  { id: 'activity', label: 'Trip start/end', factor: 1.25 },
  { id: 'raw',      label: 'Raw signals',    factor: 1.0 },
];

const DOT = '#ff3b30';
const styleUrl = (name) => `https://tiles.openfreemap.org/styles/${name}`;
const nf = new Intl.NumberFormat();

const el = (id) => document.getElementById(id);
const panel = el('panel');
const splash = el('splash');
const status = el('status');

let collections = null;   // { path: FeatureCollection, ... }
let fogSets = null;       // { every } Float32Array of Web Mercator x,y
let fogPoints = 0;
let bounds = null;        // maplibregl.LngLatBounds
let size = 1;
let fogOn = false;
let baseStatus = '';
let fogLayer = null;
let labelsOn = true;
let symbolLayers = [];   // [{ id, original }] captured fresh from each style
let regionBorders = null;

let revealMeters = 50000;

// How far the fog opens around each recorded fix, and the range of the slider.
const REVEAL_MAX_M = 100000;
const REVEAL_DEFAULT_M = 50000;

const map = new maplibregl.Map({
  container: 'map',
  style: styleUrl('liberty'),
  center: [10, 30],
  zoom: 1.4,
  attributionControl: { compact: true },
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

/* ---------- layers ---------- */

const radius = (factor) => [
  'interpolate', ['linear'], ['zoom'],
  0,  1.1 * factor * size,
  4,  1.6 * factor * size,
  8,  2.4 * factor * size,
  12, 3.6 * factor * size,
  16, 6.0 * factor * size,
];

const opacity = [
  'interpolate', ['linear'], ['zoom'],
  0, 0.45,
  10, 0.7,
  16, 0.85,
];

// `style.load` fires once per style, including the initial one. We keep a
// persistent handler (rather than `once`) so a basemap switch re-adds the dot
// layers, and a flag so data arriving *after* the style is ready still lands:
// isStyleLoaded() stays false while tiles are in flight, so it cannot be used
// as an "is the style ready" test.
let styleReady = false;
let fitted = false;
let projection = 'mercator';

map.on('style.load', () => {
  styleReady = true;
  captureLabels();
  applyLabels();
  addLayers();
  fitOnce();
  // A style load resets the projection, so re-assert the user's choice.
  map.setProjection({ type: projection });
  // Some style layers land after this handler runs, which would leave the fog
  // buried under the label layers. Re-assert the order once the style settles.
  map.once('idle', raiseOverlays);
});

/**
 * Note each style's own idea of which place-name layers should be drawn, so the
 * toggle can put things back exactly as the style intended rather than turning
 * on labels the style deliberately suppresses (AOE hides road and POI names).
 */
function captureLabels() {
  symbolLayers = map.getStyle().layers
    .filter((layer) => layer.type === 'symbol')
    .map((layer) => ({
      id: layer.id,
      original: (layer.layout && layer.layout.visibility) || 'visible',
    }));
}

function applyLabels() {
  for (const { id, original } of symbolLayers) {
    if (!map.getLayer(id)) continue;
    map.setLayoutProperty(id, 'visibility', labelsOn ? original : 'none');
  }
}

/** Keep the fog above the basemap, and the dots above the fog. */
function raiseOverlays() {
  if (map.getLayer('fog')) map.moveLayer('fog');
  for (const kind of KINDS) {
    const id = `pts-${kind.id}`;
    if (map.getLayer(id)) map.moveLayer(id);
  }
}

function fitOnce() {
  if (fitted || !bounds) return;
  fitted = true;
  map.fitBounds(bounds, { padding: 60, duration: 0 });
}

function addLayers() {
  if (!collections) return;

  if (fogSets && !map.getLayer('fog')) {
    fogLayer = createFogLayer({
      sets: fogSets,
      active: () => (fogOn ? 'every' : null),
      radiusMeters: () => revealMeters,
      borders: () => fogOn,
    });
    map.addLayer(fogLayer);
    if (regionBorders && regionBorders !== 'pending') fogLayer.setBorders(regionBorders);
  }

  for (const kind of KINDS) {
    const src = `pts-${kind.id}`;
    if (map.getSource(src)) continue;
    map.addSource(src, { type: 'geojson', data: collections[kind.id] });
    map.addLayer({
      id: src,
      type: 'circle',
      source: src,
      layout: { visibility: el(`chk-${kind.id}`).checked ? 'visible' : 'none' },
      paint: {
        'circle-color': DOT,
        'circle-radius': radius(kind.factor),
        'circle-opacity': opacity,
        'circle-blur': 0.15,
      },
    });
  }

  raiseOverlays();
}

function applySize() {
  for (const kind of KINDS) {
    if (map.getLayer(`pts-${kind.id}`)) {
      map.setPaintProperty(`pts-${kind.id}`, 'circle-radius', radius(kind.factor));
    }
  }
}


/* ---------- regions ---------- */

/** Ray casting against one flat [x,y,x,y,...] ring. */
function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1];
    const xj = ring[j], yj = ring[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** A point is in a polygon when it is inside the outer ring and no hole. */
function inPolygon(rings, x, y) {
  if (!inRing(rings[0], x, y)) return false;
  for (let i = 1; i < rings.length; i++) if (inRing(rings[i], x, y)) return false;
  return true;
}

/**
 * Work out which administrative regions hold at least one visit, then hand back
 * a triangulated mesh of them in Mercator space.
 *
 */
function regionIndex(regions) {
  // Bucket regions by whole degree so each lookup tests only a few candidates.
  const buckets = new Map();
  regions.forEach((region, index) => {
    const [minX, minY, maxX, maxY] = region.b;
    for (let x = Math.floor(minX); x <= Math.floor(maxX); x++) {
      for (let y = Math.floor(minY); y <= Math.floor(maxY); y++) {
        const key = `${x},${y}`;
        let bucket = buckets.get(key);
        if (!bucket) buckets.set(key, (bucket = []));
        bucket.push(index);
      }
    }
  });
  return buckets;
}

/** Which region covers this lon/lat, or -1 for open water. */
function regionAt(regions, buckets, x, y) {
  const bucket = buckets.get(`${Math.floor(x)},${Math.floor(y)}`);
  if (!bucket) return -1;
  for (const index of bucket) {
    const region = regions[index];
    const [minX, minY, maxX, maxY] = region.b;
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    if (region.p.some((poly) => inPolygon(poly, x, y))) return index;
  }
  return -1;
}

/**
 * Region outlines as GL_LINES vertex pairs, split into two classes: edges that
 * face another country (or open water) and edges that merely separate two
 * regions of the same country. Drawing them at different weights is what makes
 * the undiscovered ground read like a political map rather than a mesh.
 *
 * The outward side of an edge is found from the ring's winding rather than a
 * point-in-polygon test, which keeps this linear over ~236k edges.
 */
function regionOutlines(regions, buckets) {
  const countryLines = [];
  const regionLines = [];

  for (const region of regions) {
    for (const poly of region.p) {
      for (const ring of poly) {
        const n = ring.length / 2;

        // Signed area gives the winding, and so which side is outside. Holes
        // wind the other way, which flips the normal exactly as it should.
        let area = 0;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          area += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
        }
        const sign = area > 0 ? 1 : -1;

        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const ax = ring[i * 2], ay = ring[i * 2 + 1];
          const bx = ring[j * 2], by = ring[j * 2 + 1];

          const midLat = (ay + by) / 2;
          const cosLat = Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
          let nx = sign * (by - ay) / cosLat;
          let ny = sign * -(bx - ax) * cosLat;
          const len = Math.hypot(nx, ny);

          let neighbour = -1;
          if (len) {
            const step = 0.04; // ~4km out, past any simplification slack
            neighbour = regionAt(regions, buckets,
              (ax + bx) / 2 + (nx / len) * step / cosLat,
              midLat + (ny / len) * step);
          }

          const sameCountry = neighbour !== -1 && regions[neighbour].a === region.a;
          const into = sameCountry ? regionLines : countryLines;
          const ma = maplibregl.MercatorCoordinate.fromLngLat([ax, ay]);
          const mb = maplibregl.MercatorCoordinate.fromLngLat([bx, by]);
          into.push(ma.x, ma.y, mb.x, mb.y);
        }
      }
    }
  }

  return {
    region: new Float32Array(regionLines),
    country: new Float32Array(countryLines),
  };
}

/**
 * The region file is loaded for one purpose now: tracing administrative borders
 * onto the undiscovered ground. Nothing reveals by region any more.
 */
async function loadBorders() {
  if (regionBorders) return;
  regionBorders = 'pending';
  status.textContent = `${baseStatus} · tracing borders…`;

  const data = await window.timeline.regions();
  if (!data || data.error) {
    regionBorders = null;
    status.textContent = `${baseStatus} · borders unavailable`;
    return;
  }

  // Classifying every edge takes a couple of seconds, so let the status paint
  // before the main thread goes away.
  await new Promise((resolve) => setTimeout(resolve, 50));
  regionBorders = regionOutlines(data.regions, regionIndex(data.regions));

  if (fogLayer) fogLayer.setBorders(regionBorders);
  showStatus();
  map.triggerRepaint();
}

/* ---------- panel ---------- */

function buildPanel(counts) {
  const box = el('kinds');
  box.querySelectorAll('label').forEach((n) => n.remove());
  for (const kind of KINDS) {
    const label = document.createElement('label');
    label.innerHTML =
      `<input type="checkbox" id="chk-${kind.id}" checked />` +
      `<span class="swatch"></span><span>${kind.label}</span>` +
      `<span class="count">${nf.format(counts[kind.id] || 0)}</span>`;
    box.appendChild(label);
    label.querySelector('input').addEventListener('change', applyDotVisibility);
  }
}

el('size').addEventListener('input', (e) => {
  size = Number(e.target.value);
  applySize();
});

// The AOE basemap is the Detailed one recoloured, so it is fetched once and
// rewritten rather than shipped as a second style document.
let aoeStyle = null;

async function styleFor(name) {
  if (name !== 'aoe') return styleUrl(name);
  if (!aoeStyle) {
    const base = await (await fetch(styleUrl('liberty'))).json();
    aoeStyle = buildAoeStyle(base);
  }
  return aoeStyle;
}

el('labels').addEventListener('change', (e) => {
  labelsOn = e.target.checked;
  applyLabels();
});

el('basemap').addEventListener('change', async (e) => {
  map.setStyle(await styleFor(e.target.value));
});

/**
 * The two variants draw the same sheet from different point sets, so only one
 * can be on at a time.
 */
function setFog(on) {
  fogOn = on;
  el('fog').checked = on;
  el('reveal-row').hidden = !on;

  if (on) {
    revealMeters = REVEAL_DEFAULT_M;
    el('reveal').max = String(REVEAL_MAX_M);
    el('reveal').value = String(revealMeters);
    showReveal();
    loadBorders();
  }

  applyDotVisibility();
  showStatus();
  map.triggerRepaint();
}

function showStatus() {
  status.textContent = fogOn
    ? `${baseStatus} · ${nf.format(fogPoints)} reveal points`
    : baseStatus;
}

function applyDotVisibility() {
  for (const kind of KINDS) {
    const id = `pts-${kind.id}`;
    if (!map.getLayer(id)) continue;
    const visible = el(`chk-${kind.id}`).checked;
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

el('fog').addEventListener('change', (e) => setFog(e.target.checked));

function showReveal() {
  el('reveal-value').textContent = revealMeters < 1000
    ? `${revealMeters} m`
    : `${(revealMeters / 1000).toFixed(revealMeters % 1000 ? 1 : 0)} km`;
}

el('reveal').addEventListener('input', (e) => {
  revealMeters = Number(e.target.value);
  showReveal();
  map.triggerRepaint();
});

el('globe').addEventListener('change', (e) => {
  projection = e.target.checked ? 'globe' : 'mercator';
  map.setProjection({ type: projection });
});

el('fit').addEventListener('click', () => {
  if (bounds) map.fitBounds(bounds, { padding: 60, duration: 900 });
});

el('world').addEventListener('click', () => {
  map.easeTo({ center: [10, 30], zoom: 1.4, duration: 900 });
});

el('toggle').addEventListener('click', () => {
  const collapsed = panel.classList.toggle('collapsed');
  const button = el('toggle');
  button.innerHTML = collapsed ? '&raquo;' : '&laquo;';
  button.title = collapsed ? 'Show controls' : 'Hide controls';
  button.setAttribute('aria-expanded', String(!collapsed));
});

el('open').addEventListener('click', pickFile);
el('splash-open').addEventListener('click', pickFile);

/* ---------- popup ---------- */

map.on('click', (e) => {
  const layers = KINDS.map((k) => `pts-${k.id}`).filter((id) => map.getLayer(id));
  const hits = map.queryRenderedFeatures(e.point, { layers });
  if (!hits.length) return;
  const f = hits[0];
  const kind = KINDS.find((k) => `pts-${k.id}` === f.layer.id);
  const when = f.properties.t ? new Date(f.properties.t).toLocaleString() : 'unknown time';
  const [lng, lat] = f.geometry.coordinates;
  new maplibregl.Popup({ closeButton: false, offset: 8 })
    .setLngLat(f.geometry.coordinates)
    .setHTML(
      `<strong>${kind ? kind.label : 'Point'}</strong><br>${when}<br>` +
      `<code>${lat.toFixed(5)}, ${lng.toFixed(5)}</code>`
    )
    .addTo(map);
});

map.on('mouseenter', 'pts-visit', () => { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'pts-visit', () => { map.getCanvas().style.cursor = ''; });

/* ---------- data ---------- */

function buildCollections(payload) {
  const lat = new Float64Array(payload.lat);
  const lng = new Float64Array(payload.lng);
  const kind = new Uint8Array(payload.kind);
  const time = new Float64Array(payload.time);

  const out = {};
  for (const k of KINDS) out[k.id] = { type: 'FeatureCollection', features: [] };

  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (let i = 0; i < lat.length; i++) {
    const k = KINDS[kind[i]];
    if (!k) continue;
    out[k.id].features.push({
      type: 'Feature',
      properties: { t: time[i] },
      geometry: { type: 'Point', coordinates: [lng[i], lat[i]] },
    });
    if (lat[i] < minLat) minLat = lat[i];
    if (lat[i] > maxLat) maxLat = lat[i];
    if (lng[i] < minLng) minLng = lng[i];
    if (lng[i] > maxLng) maxLng = lng[i];

  }

  // Every recorded fix, whatever its kind. No bridging: the movement trails are
  // already continuous, so there are no gaps to fill.
  const every = new Float32Array(lat.length * 2);
  for (let i = 0; i < lat.length; i++) {
    const m = maplibregl.MercatorCoordinate.fromLngLat([lng[i], lat[i]]);
    every[i * 2] = m.x;
    every[i * 2 + 1] = m.y;
  }

  fogSets = { every };
  fogPoints = every.length / 2;

  bounds = new maplibregl.LngLatBounds([minLng, minLat], [maxLng, maxLat]);
  return out;
}

function show(payload) {
  collections = buildCollections(payload);
  buildPanel(payload.counts);

  if (styleReady) {
    addLayers();
    fitOnce();
  }

  splash.hidden = true;
  panel.hidden = false;
  el('total').textContent = `${nf.format(payload.total)} GPS points`;
  baseStatus = `${payload.file.split(/[/\\]/).pop()} · parsed in ${payload.ms} ms`
    + (payload.dropped ? ` · ${nf.format(payload.dropped)} excluded` : '')
    + (payload.added ? ` · ${nf.format(payload.added)} added` : '');
  showStatus();
}

function fail(result) {
  splash.hidden = false;
  el('splash-open').hidden = false;
  el('splash-hint').hidden = false;
  if (result && result.error === 'parse') {
    el('splash-title').textContent = 'Could not read that file';
    el('splash-body').textContent = result.message;
  } else {
    el('splash-title').textContent = 'No Timeline export found';
    el('splash-body').innerHTML =
      'Put <code>Timeline.json</code> in the same folder as this app and reopen it,' +
      ' or pick the file manually.';
  }
}

async function pickFile() {
  const result = await window.timeline.pick();
  if (!result) return;
  if (result.error) fail(result);
  else show(result);
}

async function open(file) {
  const result = await window.timeline.load(file);
  if (result.error) fail(result);
  else show(result);
}

/* ---------- drag and drop ---------- */

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragover');
});
document.addEventListener('dragleave', () => document.body.classList.remove('dragover'));
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const path = window.timeline.pathForFile(file);
  if (path) open(path);
});

open();
