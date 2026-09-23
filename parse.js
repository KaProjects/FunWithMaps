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

// Kind codes, kept in sync with KINDS in renderer/app.js.
const PATH = 0, VISIT = 1, ACTIVITY = 2, RAW = 3;

/**
 * Pull every GPS point out of a parsed Timeline.json.
 * Returns flat typed arrays so the payload can cross the IPC boundary
 * as a handful of ArrayBuffers instead of 250k plain objects.
 */
function extractPoints(doc) {
  const lat = [], lng = [], kind = [], t = [];
  const counts = { path: 0, visit: 0, activity: 0, raw: 0 };

  const push = (ll, k, ts, bucket) => {
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
  };
}

module.exports = { extractPoints, latLng };
