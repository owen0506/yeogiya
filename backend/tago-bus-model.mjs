import { parseTagoResponse } from './tago-bus-client.mjs';

// Only fields observed in the saved TAGO samples are mapped here. These are
// backend records, not Transit nodes/edges. Missing pattern/vehicle IDs stay absent.
const invalid = () => { throw new Error('TAGO_BUS_INVALID_DATA'); };
const text = (value) => {
  if (typeof value !== 'string' || !value.trim()) invalid();
  return value;
};
const number = (value, min, max, integer = false) => {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') invalid();
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) invalid();
  return result;
};
const city = value => String(number(value, 1, Number.MAX_SAFE_INTEGER, true));
const label = value => typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value);
const coordinates = row => ({ latitude: number(row.gpslati, -90, 90), longitude: number(row.gpslong, -180, 180) });
const scoped = cityCode => ({ providerId: 'tago', cityCode: city(cityCode) });
const matchingId = (actual, requested) => {
  if (requested !== undefined && text(actual) !== text(requested)) invalid();
  return text(actual);
};

/**
 * Internal records use providerId + cityCode + stopId/routeId as identities.
 * Context is the original request, never an inferred route number or direction.
 * routeStops retain every occurrence (stopSequence), without sorting/deduplication.
 */
export function normalizeTagoBusResponse(kind, raw, context = {}) {
  if (!['stops', 'routes', 'routeStops', 'arrivals', 'locations'].includes(kind)) invalid();
  if (kind !== 'stops') city(context.cityCode);
  if (['routeStops', 'locations'].includes(kind)) text(context.routeId);
  if (kind === 'arrivals') text(context.nodeId);
  return parseTagoResponse(raw).map(row => {
    if (kind === 'stops') return {
      ...scoped(row.citycode), stopId: text(row.nodeid), name: text(row.nodenm), ...coordinates(row),
    };
    const scope = scoped(context.cityCode);
    if (kind === 'routes') return {
      ...scope, routeId: text(row.routeid), routeNumber: label(row.routeno),
      ...(row.routetp ? { routeType: text(row.routetp) } : {}),
      ...(row.startnodenm ? { startStopName: text(row.startnodenm) } : {}),
      ...(row.endnodenm ? { endStopName: text(row.endnodenm) } : {}),
    };
    if (kind === 'routeStops') return {
      ...scope, routeId: row.routeid === undefined ? text(context.routeId) : matchingId(row.routeid, context.routeId),
      stopId: text(row.nodeid), name: text(row.nodenm), ...coordinates(row),
      stopSequence: number(row.nodeord, 1, Number.MAX_SAFE_INTEGER, true),
      ...(row.updowncd === undefined || row.updowncd === '' ? {} : { directionCode: String(number(row.updowncd, 0, 1, true)) }),
    };
    if (kind === 'arrivals') return {
      ...scope, stopId: matchingId(row.nodeid, context.nodeId), routeId: text(row.routeid),
      routeNumber: label(row.routeno), arrivalSeconds: number(row.arrtime, 0, Number.MAX_SAFE_INTEGER, true),
      remainingStops: number(row.arrprevstationcnt, 0, Number.MAX_SAFE_INTEGER, true),
      ...(row.vehicletp ? { vehicleType: text(row.vehicletp) } : {}),
    };
    return {
      ...scope, routeId: text(context.routeId), vehicleNumber: text(row.vehicleno),
      stopId: text(row.nodeid), stopSequence: number(row.nodeord, 1, Number.MAX_SAFE_INTEGER, true),
      ...coordinates(row),
    };
  });
}
