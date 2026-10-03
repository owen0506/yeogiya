import { createHash } from 'node:crypto';

const allowed = { routeMaster: 'routeId', stopMaster: 'sttnId', bisRouteInfo: 'routeId' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Read bounded pages; retain only targets and non-secret request diagnostics.
 * startRow=1 and 2 distinguish a one-row offset from disjoint page-number batches.
 * Unclear/changing pagination stops the search instead of guessing/skipping rows.
 * BIS name lookup yields a candidate, not a verified provider crosswalk.
 */
export async function lookupTDataTargets(client, {
  service, targetValues, matchField = allowed[service], rowCnt = 1000, maxRequests = 60, signal, onRequest,
}) {
  if (!allowed[service] || !Array.isArray(targetValues) || !targetValues.length ||
      !targetValues.every(v => typeof v === 'string' && v.trim()) ||
      ![allowed[service], ...(service === 'bisRouteInfo' ? ['routeNm'] : [])].includes(matchField) ||
      !Number.isInteger(rowCnt) || rowCnt < 2 || rowCnt > 1000 ||
      !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 100) throw new Error('T_DATA_LOOKUP_INVALID_OPTIONS');
  const wanted = new Set(targetValues), found = new Map(), requests = [], fingerprints = new Set();
  let startRow = 1, previousIds, pagination = 'undetermined';
  const finish = reason => ({ service, matchField, reason, pagination, requestCount: requests.length,
    matches: [...found.values()], missing: [...wanted].filter(v => !found.has(v)), requests });
  while (requests.length < maxRequests) {
    if (signal?.aborted) return finish('aborted');
    const query = { startRow, rowCnt };
    let raw;
    try { raw = await client[service](query, { signal }); }
    catch (error) {
      const entry = { ...query, error: ['T_DATA_HTTP_ERROR', 'T_DATA_TIMEOUT', 'T_DATA_ABORTED', 'T_DATA_INVALID_RESPONSE', 'T_DATA_INVALID_JSON'].includes(error?.message) ? error.message : 'T_DATA_REQUEST_FAILED' };
      if (Number.isInteger(error?.status)) entry.httpStatus = error.status;
      requests.push(entry); onRequest?.(entry);
      // Only an initial size-related HTTP rejection permits a smaller trial.
      if (startRow === 1 && !previousIds && [400, 413].includes(error?.status) && rowCnt > 10) {
        rowCnt = rowCnt > 100 ? 100 : 10;
        continue;
      }
      return finish(signal?.aborted ? 'aborted' : 'api-error');
    }
    if (!Array.isArray(raw) || raw.length > rowCnt || raw.some(r => !r || typeof r[allowed[service]] !== 'string' || !r[allowed[service]].trim())) {
      const entry = { ...query, error: 'T_DATA_INVALID_RESPONSE' };
      requests.push(entry); onRequest?.(entry); return finish('api-error');
    }
    const ids = raw.map(r => r[allowed[service]]), fingerprint = hash(raw);
    const overlap = previousIds ? ids.filter(id => previousIds.includes(id)).length : undefined;
    const entry = { ...query, returned: raw.length, fingerprint,
      ...(overlap === undefined ? {} : { overlapWithPrevious: overlap }) };
    requests.push(entry); onRequest?.(entry);
    if (!raw.length) return finish('empty-page');
    if (fingerprints.has(fingerprint)) return finish('repeated-page');
    fingerprints.add(fingerprint);
    if (new Set(ids).size !== ids.length) return finish('ambiguous-page');
    if (previousIds && pagination === 'undetermined') {
      if (previousIds.length > 1 && ids.length > 0 && equal(previousIds.slice(1), ids.slice(0, previousIds.length - 1))) pagination = 'offset';
      else if (overlap === 0) pagination = 'page-number';
      else return finish('ambiguous-pagination');
    } else if (previousIds && overlap !== 0) return finish('unstable-pagination');
    for (const value of wanted) {
      const candidates = raw.filter(r => r[matchField] === value);
      if (candidates.length > 1) return finish('ambiguous-target');
      if (candidates.length === 1) {
        if (found.has(value) && !equal(found.get(value).raw, candidates[0])) return finish('conflicting-target');
        if (!found.has(value)) found.set(value, { value, raw: candidates[0], query, requestNumber: requests.length });
      }
    }
    if (found.size === wanted.size) return finish('targets-found');
    previousIds = ids;
    startRow = pagination === 'offset' ? startRow + raw.length : startRow + 1;
  }
  return finish('max-requests');
}
