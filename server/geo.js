import { landmarks } from './db.js';
import { nowInHK, toMinutes, toHHMM } from './time.js';

// Re-exported so existing importers of geo.js keep working.
export { nowInHK, toMinutes, toHHMM };

/** Great-circle distance in metres. */
export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Walking minutes between two points.
 * 1.35x straight-line detour factor on a hilly campus at ~78 m/min.
 */
export function walkMinutes(lat1, lng1, lat2, lng2) {
  const metres = haversine(lat1, lng1, lat2, lng2) * 1.35;
  return Math.max(1, Math.round(metres / 78));
}

export function distanceToLandmark(canteen, landmarkKey) {
  const lm = landmarks[landmarkKey];
  if (!lm) return null;
  return walkMinutes(canteen.lat, canteen.lng, lm.lat, lm.lng);
}

/** Nearest landmark to a canteen — used when the user gives no location. */
export function nearestLandmark(canteen) {
  let best = null;
  for (const [key, lm] of Object.entries(landmarks)) {
    const mins = walkMinutes(canteen.lat, canteen.lng, lm.lat, lm.lng);
    if (!best || mins < best.minutes) best = { key, label: lm.label, minutes: mins };
  }
  return best;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The next scheduled opening for one canteen, searching forward from `day`.
 * Returns null when the record has no hours in the coming week.
 */
function nextOpeningFor(canteen, day) {
  for (let ahead = 1; ahead <= 7; ahead += 1) {
    const d = (day + ahead) % 7;
    const hours = canteen.hours?.[d];
    if (hours) return { day: d, opensAt: hours[0], daysAhead: ahead };
  }
  return null;
}

/**
 * Opening status of a canteen at a given moment.
 * `atMinutes` lets us evaluate "before 2pm" instead of "now".
 *
 * `opensAt` always means today's opening time, because breakfast scoring
 * compares it against 09:00. A closed outlet also carries `reopensAt` /
 * `reopensInDays` / `reopensDay`: at 22:00 "opens at 07:30" reads as today,
 * while the useful answer is tomorrow.
 */
export function openStatus(canteen, now, atMinutes = null) {
  const checkMinutes = atMinutes ?? now.minutes;
  const today = canteen.hours?.[now.day] ?? null;

  if (!today) {
    const next = nextOpeningFor(canteen, now.day);
    return {
      open: false,
      today: null,
      reason: 'Closed today',
      closesAt: null,
      opensAt: null,
      ...(next ? { reopensAt: next.opensAt, reopensInDays: next.daysAhead, reopensDay: DAY_NAMES[next.day] } : {}),
    };
  }

  const [openStr, closeStr] = today;
  const openM = toMinutes(openStr);
  const closeM = toMinutes(closeStr);

  if (checkMinutes >= openM && checkMinutes < closeM) {
    return {
      open: true,
      today,
      reason: `Open until ${closeStr}`,
      closesAt: closeStr,
      opensAt: openStr,
      minutesLeft: closeM - checkMinutes,
    };
  }

  if (checkMinutes >= closeM) {
    const next = nextOpeningFor(canteen, now.day);
    return {
      open: false,
      today,
      reason: `Closed at ${closeStr}`,
      closesAt: closeStr,
      opensAt: openStr,
      minutesLeft: 0,
      ...(next ? { reopensAt: next.opensAt, reopensInDays: next.daysAhead, reopensDay: DAY_NAMES[next.day] } : {}),
    };
  }

  return {
    open: false,
    today,
    reason: `Opens at ${openStr}`,
    closesAt: closeStr,
    opensAt: openStr,
    minutesLeft: 0,
  };
}

/** Latest closing time among canteens on `day`, or null when none is listed. */
export function latestClose(canteens, day) {
  let latest = null;
  for (const canteen of canteens) {
    const hours = canteen.hours?.[day];
    if (!hours) continue;
    if (latest == null || toMinutes(hours[1]) > toMinutes(latest)) latest = hours[1];
  }
  return latest;
}

/**
 * Earliest scheduled opening across canteens, searching forward from `day`.
 * `daysAhead` 1 is tomorrow; used to say "reopens tomorrow 07:30" instead of
 * implying the venue is open now.
 */
export function nextOpening(canteens, day) {
  for (let ahead = 1; ahead <= 7; ahead += 1) {
    const d = (day + ahead) % 7;
    let best = null;
    for (const canteen of canteens) {
      const hours = canteen.hours?.[d];
      if (!hours) continue;
      if (best == null || toMinutes(hours[0]) < toMinutes(best)) best = hours[0];
    }
    if (best) return { dayName: DAY_NAMES[d], opensAt: best, daysAhead: ahead };
  }
  return null;
}
