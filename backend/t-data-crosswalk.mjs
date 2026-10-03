const present = value => typeof value === 'string' && value.trim().length > 0 && value !== 'unknown';
const equal = (a, b) => present(a) && present(b) && a === b;

// Explicitly reviewed exception for this captured 5515 investigation only.
// Raw distance values corroborate identity; their unit is NOT inferred here.
// This does not validate stops, sequence, service date, time units or other routes.
export function verify5515RouteCrosswalk(taimsRoutes, bisRoutes) {
  const sources = taimsRoutes.filter(r => r.providerId === 'seoul-taims' && r.routeId === '100100252');
  if (sources.length !== 1) return { status: 'missing', reason: 'source-not-unique' };
  const source = sources[0];
  if (source.name !== '5515' || source.routeType !== '지선' || source.distanceValue !== 10.8) {
    return { status: 'missing', reason: 'outside-reviewed-5515-scope' };
  }
  const candidates = bisRoutes.filter(r => r.providerId === 'seoul-bis' && r.name === source.name && r.routeType === source.routeType);
  if (candidates.length !== 1) return { status: 'missing', reason: candidates.length ? 'ambiguous-route' : 'no-candidate' };
  const target = candidates[0];
  if (!present(target.routeId) || target.distanceValue !== source.distanceValue || target.useCode !== '1' || target.operationCode !== '1') {
    return { status: 'missing', reason: '5515-evidence-mismatch' };
  }
  return { status: 'matched', crosswalk: {
    scope: 'captured-5515-route-identity-only', taimsProviderId: 'seoul-taims', bisProviderId: 'seoul-bis',
    taimsRouteId: source.routeId, bisRouteId: target.routeId, routeName: source.name,
    evidence: { routeName: { taims: source.name, bis: target.name }, routeType: { taims: source.routeType, bis: target.routeType },
      distanceValue: { taims: source.distanceValue, bis: target.distanceValue, unit: 'unknown' },
      bisUseCode: target.useCode, bisOperationCode: target.operationCode,
      terminiCompared: false, idEqualityUsedAsEvidence: false },
  } };
}

// Inputs must be normalized provider records. Equality of source IDs is never evidence.
// Optional terminus names require an independently established source; the current
// TAIMS master does not expose them, so actual records cannot yet pass this gate.
export function matchTaimsBisRoute(taimsRoutes, bisRoutes, taimsRouteId) {
  const sources = taimsRoutes.filter(r => r.providerId === 'seoul-taims' && r.routeId === taimsRouteId);
  if (sources.length !== 1) return { status: 'missing', reason: sources.length ? 'ambiguous-source' : 'source-not-loaded' };
  const source = sources[0];
  const candidates = bisRoutes.filter(r => r.providerId === 'seoul-bis' && equal(source.name, r.name) && equal(source.routeType, r.routeType));
  if (candidates.length !== 1) return { status: 'missing', reason: candidates.length ? 'ambiguous-route' : 'no-candidate' };
  const target = candidates[0];
  if (!equal(source.startStopName, target.startStopName) || !equal(source.endStopName, target.endStopName)) {
    return { status: 'missing', reason: 'unconfirmed-termini' };
  }
  return { status: 'matched', crosswalk: { taimsRouteId: source.routeId, bisRouteId: target.routeId, routeName: source.name,
    evidence: { routeNameMatch: true, routeTypeMatch: true, startStopMatch: true, endStopMatch: true } } };
}

// BIS stop normalization is deliberately not implemented without an actual response.
// This matcher accepts provider-neutral stop records for a verified route context.
export function matchTaimsBisStop(source, candidates, routeMatch) {
  if (routeMatch.status !== 'matched' || source.providerId !== 'seoul-taims' || source.routeId !== routeMatch.crosswalk.taimsRouteId) {
    return { status: 'missing', reason: 'unverified-route' };
  }
  if (!present(source.stopId)) return { status: 'missing', reason: 'invalid-stop-id' };
  const matches = candidates.filter(target => present(target.stopId) && target.providerId === 'seoul-bis' && target.routeId === routeMatch.crosswalk.bisRouteId &&
    equal(source.name, target.name) && equal(source.number, target.number));
  if (matches.length !== 1) return { status: 'missing', reason: matches.length ? 'ambiguous-stop' : 'no-candidate' };
  return { status: 'matched', crosswalk: { taimsStopId: source.stopId, bisStopId: matches[0].stopId,
    evidence: { nameMatch: true, numberMatch: true, routeMatch: true } } };
}
