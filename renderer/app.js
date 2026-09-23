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
let bounds = null;        // maplibregl.LngLatBounds
let size = 1;

const map = new maplibregl.Map({
  container: 'map',
  style: styleUrl('dark'),
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
  addLayers();
  fitOnce();
  // A style load resets the projection, so re-assert the user's choice.
  map.setProjection({ type: projection });
});

function fitOnce() {
  if (fitted || !bounds) return;
  fitted = true;
  map.fitBounds(bounds, { padding: 60, duration: 0 });
}

function addLayers() {
  if (!collections) return;
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
}

function applySize() {
  for (const kind of KINDS) {
    if (map.getLayer(`pts-${kind.id}`)) {
      map.setPaintProperty(`pts-${kind.id}`, 'circle-radius', radius(kind.factor));
    }
  }
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
    label.querySelector('input').addEventListener('change', (e) => {
      const layer = `pts-${kind.id}`;
      if (map.getLayer(layer)) {
        map.setLayoutProperty(layer, 'visibility', e.target.checked ? 'visible' : 'none');
      }
    });
  }
}

el('size').addEventListener('input', (e) => {
  size = Number(e.target.value);
  applySize();
});

el('basemap').addEventListener('change', (e) => {
  map.setStyle(styleUrl(e.target.value));
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
  status.textContent = `${payload.file.split(/[/\\]/).pop()} · parsed in ${payload.ms} ms`;
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
