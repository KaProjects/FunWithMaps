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

/* ---------- flights ---------- */

// Too slow over a long distance means a train, or a car with a missing stop in
// between. There is deliberately no upper bound: an impossible speed says the
// clock is wrong, not that the journey did not happen, and 600 km between two
// fixes minutes apart can only have been flown.
const MIN_KMH = 120;
// Google's own label is trusted down to short hops; a hop we infer ourselves has
// to be long enough and fast enough that no ground journey could explain it.
const MIN_LABELLED_KM = 100;
const MIN_INFERRED_KM = 500, MIN_INFERRED_KMH = 300;
// What Google says it measured, over the great circle between the endpoints. A
// real leg tracks the great circle, so this sits at 1.00; across this dataset 69
// of 73 labelled flights land inside these bounds and all four outside are
// broken -- either an endpoint is wrong (ratio near zero) or the segment has
// swallowed a whole multi-leg journey (ratio 2.0 and up).
const MIN_TRACK_RATIO = 0.7, MAX_TRACK_RATIO = 1.5;

// How close a listed endpoint has to be for a flight to count as the listed one.
const FLIGHT_MATCH_KM = 10;

/** Great-circle distance in km. */
function greatCircle(a, b) {
  const R = 6371;
  const p1 = (a[0] * Math.PI) / 180;
  const p2 = (b[0] * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((b[1] - a[1]) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const localDate = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * Build a test for journeys the user has said are not flights. Some of them look
 * perfectly well formed -- a road trip whose middle went untracked can reach the
 * right distance at a believable speed -- so there is nothing to detect and they
 * are simply listed, matched on the date and both endpoints. This is kept apart
 * from the point exclusions on purpose: the endpoints are usually real places the
 * user genuinely visited, and must keep their dots.
 */
function makeFlightExcluder(exclusions) {
  const listed = (exclusions && exclusions.flights) || [];
  if (!listed.length) return () => false;

  return (from, to, start) => listed.some((entry) => {
    if (entry.date && entry.date !== localDate(start)) return false;
    const a = entry.from && [entry.from.lat, entry.from.lng];
    const b = entry.to && [entry.to.lat, entry.to.lng];
    return a && b
      && greatCircle(from, a) <= FLIGHT_MATCH_KM
      && greatCircle(to, b) <= FLIGHT_MATCH_KM;
  });
}

/** Fast enough to be a flight. A missing or collapsed duration counts as fast. */
const fastEnough = (km, hours, floor) => !(hours > 0) || km / hours >= floor;

/**
 * Work out which journeys were flights.
 *
 * Google already labels them: `activity.topCandidate.type === 'FLYING'`. Measured
 * against this dataset that label is worth far more than any rule of our own --
 * an independent detector agreed with 85% of it and, of the hops it found that
 * Google had not labelled, well over half were road or rail journeys with a
 * missing stop in between rather than flights.
 *
 * So the label leads, and we only do two things to it: throw out the entries that
 * are plainly broken (zero-length hops, and speeds that are impossible or far too
 * slow), and add the long fast jumps between consecutive visits that Google missed
 * entirely, where the distance and speed together leave no ground explanation.
 *
 * A flight is also only as good as the fixes it is anchored on, so the same
 * exclusion list that filters the plotted points applies here: a hop that starts
 * or ends on a position already marked as bad data is a bad reading being read as
 * a journey, not a journey.
 *
 * Where Google dropped a trip altogether there is nothing to detect, so flights
 * can be listed in the additions file as well. Those are appended unfiltered, on
 * the same footing as an added visit.
 */
function extractFlights(doc, exclusions, additions) {
  const flights = [];
  const labelled = [];
  const visits = [];
  const excluded = makeExcluder(exclusions);
  const notAFlight = makeFlightExcluder(exclusions);
  const anchoredOnNoise = (from, to) =>
    excluded(from[0], from[1]) || excluded(to[0], to[1]);

  for (const seg of doc.semanticSegments || []) {
    const start = time(seg.startTime);
    const end = time(seg.endTime);

    const visit = seg.visit && seg.visit.topCandidate;
    if (visit && visit.placeLocation && start && end) {
      const ll = latLng(visit.placeLocation.latLng);
      if (ll) visits.push({ start, end, ll });
    }

    const activity = seg.activity;
    if (!activity || !start || !end) continue;
    if (((activity.topCandidate || {}).type) !== 'FLYING') continue;

    labelled.push([start, end]);
    const from = latLng((activity.start || {}).latLng);
    const to = latLng((activity.end || {}).latLng);
    if (!from || !to) continue;

    if (anchoredOnNoise(from, to) || notAFlight(from, to, start)) continue;

    const km = greatCircle(from, to);
    if (km < MIN_LABELLED_KM) continue;
    if (!fastEnough(km, (end - start) / 3600000, MIN_KMH)) continue;

    // Google reports how far it thinks the journey ran, which is the better
    // integrity check than speed: a broken clock still leaves the two endpoints
    // a real flight apart, but a wrong endpoint does not.
    const tracked = (activity.distanceMeters || 0) / 1000;
    const ratio = tracked / km;
    if (ratio < MIN_TRACK_RATIO || ratio > MAX_TRACK_RATIO) continue;

    flights.push({ from, to, start, end, km, inferred: false });
  }

  // An hour either side: the visit that ends a flight often starts a little after
  // the segment does, and we only want to know whether this hop is already covered.
  const known = (a, b) => labelled.some(([s, e]) => !(b < s - 3600000 || a > e + 3600000));

  visits.sort((a, b) => a.start - b.start);
  for (let i = 1; i < visits.length; i++) {
    const previous = visits[i - 1];
    const next = visits[i];
    const hours = (next.start - previous.end) / 3600000;
    const km = greatCircle(previous.ll, next.ll);
    if (km < MIN_INFERRED_KM) continue;
    if (!fastEnough(km, hours, MIN_INFERRED_KMH)) continue;
    if (known(previous.end, next.start)) continue;
    if (anchoredOnNoise(previous.ll, next.ll)) continue;
    if (notAFlight(previous.ll, next.ll, previous.end)) continue;
    flights.push({
      from: previous.ll, to: next.ll, start: previous.end, end: next.start, km, inferred: true,
    });
  }

  for (const f of (additions && additions.flights) || []) {
    const from = f.from && latLng(`${f.from.lat}, ${f.from.lng}`);
    const to = f.to && latLng(`${f.to.lat}, ${f.to.lng}`);
    if (!from || !to) continue;
    const start = time(f.start);
    flights.push({
      from,
      to,
      start,
      end: time(f.end) || start,
      km: greatCircle(from, to),
      inferred: false,
      added: true,
    });
  }

  flights.sort((a, b) => a.start - b.start);
  return flights;
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

module.exports = { extractPoints, extractFlights, latLng };
