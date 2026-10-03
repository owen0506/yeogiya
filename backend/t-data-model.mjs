// Names below are from the captured JSON, not the snake_case documentation table.
const invalid = () => { throw new Error('T_DATA_INVALID_RESPONSE'); };
const id = x => typeof x === 'string' && /^\d+$/.test(x) ? x : invalid();
const numeric = x => (typeof x === 'number' || (typeof x === 'string' && x.trim() !== '')) && Number.isFinite(Number(x)) ? Number(x) : undefined;
const sequence = x => { const n = numeric(x); return Number.isSafeInteger(n) && n > 0 ? n : invalid(); };
const positive = x => { const n = numeric(x); return n > 0 ? n : undefined; };
const rows = raw => Array.isArray(raw) && raw.every(x => x && typeof x === 'object' && !Array.isArray(x)) ? raw : invalid();
const date = x => {
  if (typeof x !== 'string' || !/^\d{8}$/.test(x)) invalid();
  const result = `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6)}`;
  const parsed = new Date(result);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === result ? result : invalid();
};

export function parseTDataRouteStops(raw) {
  return rows(raw).map(row => ({ externalRouteId: id(row.routeId), externalStopId: id(row.nodeId), sequence: sequence(row.sttnSn) }));
}

export function parseTDataSectionTimes(raw) {
  return rows(raw).map(row => ({
    externalRouteId: id(row.routeId), fromExternalStopId: id(row.fromStaId), toExternalStopId: id(row.toStaId),
    fromSequence: sequence(row.fromStaSn), toSequence: sequence(row.toStaSn), referenceDate: date(row.stdrDe),
    // Unit is intentionally unknown here. These are NOT seconds.
    value: positive(row.tripTime),
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, value: positive(row[`tripTime${String(hour).padStart(2, '0')}h`]) }))
      .filter(item => item.value !== undefined),
    // tripFcnt is not treated as sampleCount without a verified definition.
  }));
}

const label = x => typeof x === 'string' && x.trim() ? x : invalid();

export function parseTDataRouteMaster(raw) {
  return rows(raw).map(row => ({ providerId: 'seoul-taims', routeId: id(row.routeId), name: label(row.routeNm),
    routeType: label(row.routeTy),
    // Distance is not used for time or speed calculations: unit is not verified.
    ...(positive(row.dstnc) === undefined ? {} : { distanceValue: positive(row.dstnc) }),
  }));
}

export function parseTDataStopMaster(raw) {
  return rows(raw).map(row => {
    const x = numeric(row.crdntX), y = numeric(row.crdntY);
    if (x === undefined || y === undefined) invalid();
    return { providerId: 'seoul-taims', stopId: id(row.sttnId), name: label(row.sttnNm),
      number: label(row.sttnNo), coordinates: { x, y, crs: 'unknown' } };
  });
}

// Type codes are documented in the BIS route-info specification (data_id=1053).
const bisTypes = { '1': '공항', '2': '마을', '3': '간선', '4': '지선', '5': '순환', '6': '광역', '7': '인천', '8': '경기', '10': '관광' };
export function parseTDataBisRouteInfo(raw) {
  return rows(raw).map(row => ({ providerId: 'seoul-bis', routeId: id(row.routeId), name: label(row.routeNm),
    routeType: bisTypes[row.routeTy] ?? 'unknown', typeCode: label(row.routeTy),
    startStopName: label(row.ssttnNm), endStopName: label(row.esttnNm),
    ...(positive(row.dstnc) === undefined ? {} : { distanceValue: positive(row.dstnc) }),
    ...(row.useAt === undefined ? {} : { useCode: label(row.useAt) }),
    ...(row.opratAt === undefined ? {} : { operationCode: label(row.opratAt) }),
  }));
}
