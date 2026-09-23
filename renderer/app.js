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
let fogSets = null;       // { fine, regions } Float32Arrays of Web Mercator x,y
let bounds = null;        // maplibregl.LngLatBounds
let size = 1;
// null | 'tiered' (reveals whole administrative regions) | 'wide' (100km circles).
// Both draw the same parchment, lettering and two-weight borders.
let fogMode = null;
let fogCounts = { kept: 0, total: 0 };
let fogSizes = { all: 0 };
let baseStatus = '';
let fogLayer = null;
let regionMesh = null;   // 'pending' while loading, then the uploaded Float32Array
let regionCount = 0;
let regionBorders = null;

let regionLat = [], regionLng = [];
let revealMeters = 20000;

// Which point set each variant reveals with, and how far it reaches by default.
const FOG_SET = { tiered: 'regions', wide: 'all' };
const REVEAL_DEFAULTS = { wide: 100000 };
// Variants that reveal by region rather than by radius. Both variants draw the
// same border treatment, so either way the region file has to be loaded.
const REGION_MODES = new Set(['tiered']);
// Countries below this reveal whole rather than region by region, so a visit to
// Luxembourg does not light up a sliver of it.
const SMALL_COUNTRY_KM2 = 30000;
// How far a revealed coastal region reaches out over the water.
const SEA_MARGIN_M = 50000;
const NOISE_RADIUS_M = 5000;
const LINK_DISTANCE_M = 20000;  // bridge visits at least this close together
const LINK_STEP_M = 6000;       // spacing of the filler points along a bridge
const MAX_LINKS = 6;            // per site, nearest first

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
  addLayers();
  fitOnce();
  // A style load resets the projection, so re-assert the user's choice.
  map.setProjection({ type: projection });
  // Some style layers land after this handler runs, which would leave the fog
  // buried under the label layers. Re-assert the order once the style settles.
  map.once('idle', raiseOverlays);
});

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
      active: () => (fogMode ? FOG_SET[fogMode] : null),
      radiusMeters: () => revealMeters,
      borders: () => Boolean(fogMode),
    });
    map.addLayer(fogLayer);
    if (regionMesh instanceof Float32Array) fogLayer.setMesh('regions', regionMesh);
    if (regionBorders) fogLayer.setBorders(regionBorders);
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

/** Rough surface area of a ring in km², good enough to judge "small country". */
function ringKm2(ring) {
  let sum = 0, latSum = 0;
  for (let i = 0, n = ring.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    sum += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
    latSum += ring[i * 2 + 1];
  }
  const meanLat = latSum / (ring.length / 2);
  return Math.abs(sum / 2) * 111.32 * 111.32 * Math.cos((meanLat * Math.PI) / 180);
}

/**
 * Work out which administrative regions hold at least one visit, then hand back
 * a triangulated mesh of them in Mercator space.
 *
 * Visits are matched against the denoised set rather than every fix: at this
 * granularity a single stray GPS reading would light up an entire province.
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

function regionMeshFor(regions, buckets, lats, lngs) {
  const hit = new Set();
  for (let i = 0; i < lats.length; i++) {
    const x = lngs[i], y = lats[i];
    const bucket = buckets.get(`${Math.floor(x)},${Math.floor(y)}`);
    if (!bucket) continue;
    for (const index of bucket) {
      if (hit.has(index)) continue;
      const region = regions[index];
      const [minX, minY, maxX, maxY] = region.b;
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      if (region.p.some((poly) => inPolygon(poly, x, y))) hit.add(index);
    }
  }

  // Small countries reveal whole, so a visit does not light up one sliver.
  const area = new Map();
  for (const region of regions) {
    const km2 = region.p.reduce((sum, poly) => sum + ringKm2(poly[0]), 0);
    area.set(region.a, (area.get(region.a) || 0) + km2);
  }
  const smallCountries = new Set();
  for (const index of hit) {
    const country = regions[index].a;
    if ((area.get(country) || 0) < SMALL_COUNTRY_KM2) smallCountries.add(country);
  }
  if (smallCountries.size) {
    regions.forEach((region, index) => {
      if (smallCountries.has(region.a)) hit.add(index);
    });
  }

  const vertices = [];
  const triangulate = window.earcut.default || window.earcut;

  const merc = (x, y) => {
    const m = maplibregl.MercatorCoordinate.fromLngLat([x, y]);
    return [m.x, m.y];
  };
  const tri = (a, b, c) => {
    vertices.push(a[0], a[1], b[0], b[1], c[0], c[1]);
  };

  /**
   * Widen a revealed region out over the water. Each ring edge is offset to the
   * side that lies outside its own polygon; if that side is not inside some
   * other region either, it is coast rather than a land border, and gets a band
   * of sea. Quads cover the edges and a fan covers each corner, so the band
   * stays continuous around headlands.
   */
  const strokeCoast = (poly) => {
    const latDeg = SEA_MARGIN_M / 110540;
    for (const ring of poly) {
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = ring[i * 2], ay = ring[i * 2 + 1];
        const bx = ring[j * 2], by = ring[j * 2 + 1];
        const lonDeg = latDeg / Math.max(0.05, Math.cos(((ay + by) / 2 * Math.PI) / 180));

        // Unit normal, in degrees scaled so it measures the same on the ground.
        let nx = (by - ay), ny = -(bx - ax);
        const len = Math.hypot(nx / lonDeg, ny / latDeg);
        if (!len) continue;
        nx = (nx / lonDeg / len) * lonDeg;
        ny = (ny / latDeg / len) * latDeg;

        // Point outwards: away from the region's own interior.
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        const probe = 0.15;
        if (inPolygon(poly, mx + nx * probe, my + ny * probe)) { nx = -nx; ny = -ny; }

        // Land on the far side means this is a border, not a coastline.
        if (regionAt(regions, buckets, mx + nx * 0.2, my + ny * 0.2) !== -1) continue;

        const a = merc(ax, ay), b = merc(bx, by);
        const ao = merc(ax + nx, ay + ny), bo = merc(bx + nx, by + ny);
        tri(a, b, bo);
        tri(a, bo, ao);

        // Fan at the corner so consecutive bands meet cleanly.
        const centre = merc(bx, by);
        for (let k = 0; k < 8; k++) {
          const t0 = (k / 8) * Math.PI * 2;
          const t1 = ((k + 1) / 8) * Math.PI * 2;
          tri(centre,
            merc(bx + Math.cos(t0) * lonDeg, by + Math.sin(t0) * latDeg),
            merc(bx + Math.cos(t1) * lonDeg, by + Math.sin(t1) * latDeg));
        }
      }
    }
  };

  for (const index of hit) {
    for (const poly of regions[index].p) {
      // earcut wants one flat vertex list plus the index where each hole starts.
      const flat = [];
      const holes = [];
      poly.forEach((ring, n) => {
        if (n > 0) holes.push(flat.length / 2);
        for (let i = 0; i < ring.length; i += 2) {
          const m = maplibregl.MercatorCoordinate.fromLngLat([ring[i], ring[i + 1]]);
          flat.push(m.x, m.y);
        }
      });
      for (const v of triangulate(flat, holes, 2)) {
        vertices.push(flat[v * 2], flat[v * 2 + 1]);
      }
      strokeCoast(poly);
    }
  }

  return { mesh: new Float32Array(vertices), count: hit.size };
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

async function loadRegions() {
  if (regionMesh) return;
  regionMesh = 'pending';
  status.textContent = `${baseStatus} · loading regions…`;

  const data = await window.timeline.regions();
  if (!data || data.error) {
    regionMesh = null;
    status.textContent = `${baseStatus} · regions unavailable`;
    return;
  }

  const buckets = regionIndex(data.regions);
  const built = regionMeshFor(data.regions, buckets, regionLat, regionLng);
  regionMesh = built.mesh;
  regionCount = built.count;

  // Classifying every edge takes a couple of seconds, so let the status paint
  // before the main thread goes away.
  status.textContent = `${baseStatus} · tracing borders…`;
  await new Promise((resolve) => setTimeout(resolve, 50));
  regionBorders = regionOutlines(data.regions, buckets);

  if (fogLayer) {
    fogLayer.setMesh('regions', regionMesh);
    fogLayer.setBorders(regionBorders);
  }
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

el('basemap').addEventListener('change', (e) => {
  map.setStyle(styleUrl(e.target.value));
});

/**
 * The two variants draw the same sheet from different point sets, so only one
 * can be on at a time.
 */
function setFogMode(mode) {
  // At this radius the dots are just noise over the revealed regions, so turning
  // the sheet on clears them -- by unchecking the boxes rather than overriding
  // them, so they can be switched straight back on.
  const turningOn = mode && !fogMode;

  fogMode = mode;
  el('fog4').checked = mode === 'wide';
  el('fog6').checked = mode === 'tiered';
  el('reveal-row').hidden = !mode || REGION_MODES.has(mode);

  if (turningOn) {
    for (const kind of KINDS) el(`chk-${kind.id}`).checked = false;
  }
  if (mode && REVEAL_DEFAULTS[mode]) {
    // Each variant has its own reach, so re-seed the slider when switching.
    revealMeters = REVEAL_DEFAULTS[mode];
    el('reveal').value = String(revealMeters);
  }
  if (mode) loadRegions();

  applyDotVisibility();
  showStatus();
  map.triggerRepaint();
}

function showStatus() {
  if (!fogMode) {
    status.textContent = baseStatus;
  } else if (REGION_MODES.has(fogMode)) {
    status.textContent = `${baseStatus} · ${nf.format(regionCount)} regions revealed`;
  } else {
    status.textContent = `${baseStatus} · ${nf.format(fogSizes[FOG_SET[fogMode]])} reveal points`;
  }
}

function applyDotVisibility() {
  for (const kind of KINDS) {
    const id = `pts-${kind.id}`;
    if (!map.getLayer(id)) continue;
    const visible = el(`chk-${kind.id}`).checked;
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

el('fog4').addEventListener('change', (e) => setFogMode(e.target.checked ? 'wide' : null));
el('fog6').addEventListener('change', (e) => setFogMode(e.target.checked ? 'tiered' : null));

el('reveal').addEventListener('input', (e) => {
  revealMeters = Number(e.target.value);
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

/**
 * Drop isolated visits. A place with no other visit within `radius` is almost
 * always a stray fix — a bad GPS lock, or a point picked up in passing — rather
 * than somewhere you actually spent time. Bucketed into a grid so this stays
 * linear instead of comparing every visit against every other one.
 *
 * Note this also drops a genuine one-off: a trip where you visited exactly one
 * place and nothing else nearby disappears too.
 */
function denoise(lats, lngs, radius) {
  const cell = radius / 111320; // grid step, in degrees of latitude
  const buckets = new Map();
  for (let i = 0; i < lats.length; i++) {
    const key = `${Math.floor(lats[i] / cell)},${Math.floor(lngs[i] / cell)}`;
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = []));
    bucket.push(i);
  }

  const keep = [];
  const limit = radius * radius;
  for (let i = 0; i < lats.length; i++) {
    const row = Math.floor(lats[i] / cell);
    const col = Math.floor(lngs[i] / cell);
    // A cell is `radius` tall but narrower than that in metres as you move away
    // from the equator, so widen the column search to compensate.
    const cosLat = Math.max(0.05, Math.cos((lats[i] * Math.PI) / 180));
    const span = Math.min(8, Math.ceil(1 / cosLat));

    let found = false;
    for (let dr = -1; dr <= 1 && !found; dr++) {
      for (let dc = -span; dc <= span && !found; dc++) {
        const bucket = buckets.get(`${row + dr},${col + dc}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j === i) continue;
          const dy = (lats[j] - lats[i]) * 110540;
          const dx = (lngs[j] - lngs[i]) * 111320 * cosLat;
          if (dx * dx + dy * dy <= limit) { found = true; break; }
        }
      }
    }
    if (found) keep.push(i);
  }
  return keep;
}

/**
 * Fill the waist between neighbouring visits. Two discs whose centres are
 * `LINK_DISTANCE_M` apart overlap, but the union is pinched in the middle --
 * points off to the side of the midpoint are further than the radius from
 * either centre, so the map shows through as an hourglass rather than a blob.
 *
 * Rather than draw capsules, which would need their own geometry and shader,
 * this seeds extra points along each link. Discs at those positions fill the
 * waist using the renderer that is already there.
 *
 * Sites are collapsed onto a coarse grid first, so a dense city contributes a
 * handful of links instead of the square of its visit count.
 */
function bridge(lats, lngs, linkDistance, step, maxLinks) {
  const siteCell = linkDistance / 10 / 111320;
  const sites = new Map();
  for (let i = 0; i < lats.length; i++) {
    sites.set(`${Math.floor(lats[i] / siteCell)},${Math.floor(lngs[i] / siteCell)}`, i);
  }
  const index = [...sites.values()];

  const cell = linkDistance / 111320;
  const buckets = new Map();
  for (const i of index) {
    const key = `${Math.floor(lats[i] / cell)},${Math.floor(lngs[i] / cell)}`;
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = []));
    bucket.push(i);
  }

  const extraLat = [], extraLng = [];
  for (const i of index) {
    const row = Math.floor(lats[i] / cell);
    const col = Math.floor(lngs[i] / cell);
    const cosLat = Math.max(0.05, Math.cos((lats[i] * Math.PI) / 180));
    const span = Math.min(8, Math.ceil(1 / cosLat));

    const near = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -span; dc <= span; dc++) {
        const bucket = buckets.get(`${row + dr},${col + dc}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue; // each pair once
          const dy = (lats[j] - lats[i]) * 110540;
          const dx = (lngs[j] - lngs[i]) * 111320 * cosLat;
          const distance = Math.hypot(dx, dy);
          if (distance <= linkDistance) near.push({ j, distance });
        }
      }
    }

    near.sort((a, b) => a.distance - b.distance);
    for (const { j, distance } of near.slice(0, maxLinks)) {
      const steps = Math.max(1, Math.round(distance / step));
      for (let n = 1; n < steps; n++) {
        const t = n / steps;
        extraLat.push(lats[i] + (lats[j] - lats[i]) * t);
        extraLng.push(lngs[i] + (lngs[j] - lngs[i]) * t);
      }
    }
  }
  return { extraLat, extraLng };
}

function buildCollections(payload) {
  const lat = new Float64Array(payload.lat);
  const lng = new Float64Array(payload.lng);
  const kind = new Uint8Array(payload.kind);
  const time = new Float64Array(payload.time);

  const out = {};
  for (const k of KINDS) out[k.id] = { type: 'FeatureCollection', features: [] };

  const visitLat = [], visitLng = [];

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

    // The fog reveals places you stopped at, not every breadcrumb in between.
    if (KINDS[kind[i]] && KINDS[kind[i]].id === 'visit') {
      visitLat.push(lat[i]);
      visitLng.push(lng[i]);
    }
  }

  // Bridge the gaps, then project. Done twice: once over the denoised visits,
  // and once over every visit, so the two variants can be compared directly.
  const buildSet = (lats, lngs) => {
    const { extraLat, extraLng } = bridge(
      lats, lngs, LINK_DISTANCE_M, LINK_STEP_M, MAX_LINKS);
    const allLat = lats.concat(extraLat);
    const allLng = lngs.concat(extraLng);
    const out = new Float32Array(allLat.length * 2);
    for (let i = 0; i < allLat.length; i++) {
      const m = maplibregl.MercatorCoordinate.fromLngLat([allLng[i], allLat[i]]);
      out[i * 2] = m.x;
      out[i * 2 + 1] = m.y;
    }
    return out;
  };

  const clustered = denoise(visitLat, visitLng, NOISE_RADIUS_M);
  regionLat = clustered.map((i) => visitLat[i]);
  regionLng = clustered.map((i) => visitLng[i]);
  fogSets = { all: buildSet(visitLat, visitLng) };
  fogSizes = { all: fogSets.all.length / 2 };
  fogCounts = { kept: clustered.length, total: visitLat.length };

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
    + ` · ${nf.format(fogCounts.kept)}/${nf.format(fogCounts.total)} visits clustered`;
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
