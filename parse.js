'use strict';

// Google Timeline exports encode coordinates as a display string, e.g.
//   "48.9926326°, 21.2540978°"   (and "geo:48.99,21.25" on some iOS exports)
// so we just pull the first two numbers out of whatever we are handed.
const NUM = /-?\d+(?:\.\d+)?/g;

function latLng(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(NUM);
  if (!m || m.length < 2) return null;
  const lat = Number(m[0]);
  const lng = Number(m[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null; // null island
  return [lat, lng];
}

function time(raw) {
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Build a test for points the user has marked as bad data. Google's export
 * carries the occasional fix in open sea, or a straight line drawn between two
 * real positions; those are listed in data/exclusions.json rather than edited
 * out of Timeline.json, so the original export stays untouched and the list
 * survives re-exporting.
 */
function makeExcluder(exclusions) {
  const points = (exclusions && exclusions.points) || [];
  if (!points.length) return () => false;
  const fallback = (exclusions && exclusions.radius) || 50;

  return (lat, lng) => {
    for (const point of points) {
      const radius = point.radius || fallback;
      const dy = (lat - point.lat) * 110540;
      const dx = (lng - point.lng) * 111320 * Math.cos((lat * Math.PI) / 180);
      if (dx * dx + dy * dy <= radius * radius) return true;
    }
    return false;
  };
}

// Kind codes, kept in sync with KINDS in renderer/app.js.
const PATH = 0, VISIT = 1, ACTIVITY = 2, RAW = 3;
const KIND_NAMES = { path: PATH, visit: VISIT, activity: ACTIVITY, raw: RAW };
const KIND_BUCKETS = ['path', 'visit', 'activity', 'raw'];

/**
 * Pull every GPS point out of a parsed Timeline.json.
 * Returns flat typed arrays so the payload can cross the IPC boundary
 * as a handful of ArrayBuffers instead of 250k plain objects.
 */
function extractPoints(doc, exclusions, additions) {
  const lat = [], lng = [], kind = [], t = [];
  const counts = { path: 0, visit: 0, activity: 0, raw: 0 };
  const excluded = makeExcluder(exclusions);
  let dropped = 0;
  let added = 0;

  const push = (ll, k, ts, bucket) => {
    if (excluded(ll[0], ll[1])) {
      dropped++;
      return;
    }
    lat.push(ll[0]);
    lng.push(ll[1]);
    kind.push(k);
    t.push(ts);
    counts[bucket]++;
  };

  for (const seg of doc.semanticSegments || []) {
    if (Array.isArray(seg.timelinePath)) {
      for (const p of seg.timelinePath) {
        const ll = latLng(p.point);
        if (ll) push(ll, PATH, time(p.time || seg.startTime), 'path');
      }
    }

    const cand = seg.visit && seg.visit.topCandidate;
    if (cand && cand.placeLocation) {
      const ll = latLng(cand.placeLocation.latLng);
      if (ll) push(ll, VISIT, time(seg.startTime), 'visit');
    }

    if (seg.activity) {
      for (const end of ['start', 'end']) {
        const ll = seg.activity[end] && latLng(seg.activity[end].latLng);
        if (ll) push(ll, ACTIVITY, time(end === 'start' ? seg.startTime : seg.endTime), 'activity');
      }
    }
  }

  // Places Google missed. Appended after the filtering above, so an addition is
  // never silently dropped by an exclusion.
  for (const point of (additions && additions.points) || []) {
    const ll = latLng(`${point.lat}, ${point.lng}`);
    if (!ll) continue;
    const k = KIND_NAMES[point.kind] !== undefined ? KIND_NAMES[point.kind] : VISIT;
    lat.push(ll[0]);
    lng.push(ll[1]);
    kind.push(k);
    t.push(time(point.time));
    counts[KIND_BUCKETS[k]]++;
    added++;
  }

  for (const sig of doc.rawSignals || []) {
    // Capitalised "LatLng" here, lowercase "latLng" in semanticSegments. Thanks, Google.
    const pos = sig.position;
    if (!pos) continue;
    const ll = latLng(pos.LatLng || pos.latLng);
    if (ll) push(ll, RAW, time(pos.timestamp), 'raw');
  }

  return {
    lat: new Float64Array(lat),
    lng: new Float64Array(lng),
    kind: new Uint8Array(kind),
    time: new Float64Array(t),
    counts,
    total: lat.length,
    dropped,
    added,
  };
}

module.exports = { extractPoints, latLng };
