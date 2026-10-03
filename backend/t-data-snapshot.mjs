import { readFileSync } from 'node:fs';
import { loadBusSnapshot } from './bus-snapshot.mjs';
import { buildTDataBusRideSnapshot } from './t-data-mapping.mjs';

// Local captured samples only. No network requests, inferred crosswalk or assumed units.
// Currently produces an empty cost snapshot and explicit rejection diagnostics.
export function loadTDataBusRideSnapshot() {
  const read = kind => JSON.parse(readFileSync(new URL(`./fixtures/t-data-${kind}.json`, import.meta.url), 'utf8')).raw;
  return buildTDataBusRideSnapshot({
    sectionRaw: read('section_time'), masterRaw: read('route_stop-seoul-page1'), topology: loadBusSnapshot(),
  });
}
