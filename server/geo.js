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

/**
 * Opening status of a canteen at a given moment.
 * `atMinutes` lets us evaluate "before 2pm" instead of "now".
 */
export function openStatus(canteen, now, atMinutes = null) {
  const checkMinutes = atMinutes ?? now.minutes;
  const today = canteen.hours?.[now.day] ?? null;

  if (!today) {
    return { open: false, today: null, reason: 'Closed today', closesAt: null, opensAt: null };
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

  return {
    open: false,
    today,
    reason: checkMinutes < openM ? `Opens at ${openStr}` : `Closed at ${closeStr}`,
    closesAt: closeStr,
    opensAt: openStr,
    minutesLeft: 0,
  };
}
