const fs = require('node:fs');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { test } = require('node:test');

require.extensions['.ts'] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(compiled.outputText, filename);
};

const { findAverageRoute, findAverageRouteBetween } = require('../src/features/transit/average-route-engine.ts');
const { findRoute } = require('../src/features/journey/route-service.ts');
const { createRouteCostProvider } = require('../src/features/journey/route-costs.ts');
const nodes = [
  { id: 'A', type: 'SUBWAY_PLATFORM', routeId: '2' },
  { id: 'B', type: 'SUBWAY_PLATFORM', routeId: '2' },
  { id: 'C', type: 'SUBWAY_PLATFORM', routeId: '2' },
  { id: 'X', type: 'BUS_STOP' },
  { id: 'X:721', type: 'BUS_SERVICE_STATE', routeId: '721' },
  { id: 'Y:721', type: 'BUS_SERVICE_STATE', routeId: '721' },
  { id: 'Y', type: 'BUS_STOP' },
];
const ride = (id, from, to, seconds, mode, routeId) => ({ id, from, to, averageTravelSeconds: seconds, kind: 'RIDE', mode, routeId });
const connector = (id, from, to, seconds, kind) => ({ id, from, to, averageTravelSeconds: seconds, kind });
const edges = [
  ride('rail-ab', 'A', 'B', 120, 'SUBWAY', '2'),
  ride('rail-bc', 'B', 'C', 120, 'SUBWAY', '2'),
  connector('walk-ax', 'A', 'X', 30, 'WALK'),
  connector('board', 'X', 'X:721', 0, 'BOARD'),
  ride('bus', 'X:721', 'Y:721', 100, 'BUS', '721'),
  connector('alight', 'Y:721', 'Y', 0, 'ALIGHT'),
  connector('walk-yc', 'Y', 'C', 30, 'WALK'),
];

test('average graph finds the cheaper multimodal path and leaves waiting unknown', () => {
  const route = findAverageRoute({ nodes, edges }, 'A', 'C');
  assert.ok(route);
  assert.equal(route.source, 'AVERAGE_EDGE');
  assert.equal(route.averageTravelSeconds, 160);
  assert.equal(route.waitingSeconds, null);
  assert.deepEqual(route.edges.map(edge => edge.id), ['walk-ax', 'board', 'bus', 'alight', 'walk-yc']);
  assert.deepEqual(route.nodeIds, ['A', 'X', 'X:721', 'Y:721', 'Y', 'C']);
});

test('missing coverage returns null; an explicit transfer has an explicit cost', () => {
  assert.equal(findAverageRoute({ nodes, edges: [] }, 'A', 'C'), null);
  const graph = { nodes: [
    { id: 'line1', type: 'SUBWAY_PLATFORM', routeId: '1' },
    { id: 'line2', type: 'SUBWAY_PLATFORM', routeId: '2' },
    { id: 'destination', type: 'SUBWAY_PLATFORM', routeId: '2' },
  ], edges: [
    connector('transfer', 'line1', 'line2', 300, 'TRANSFER'),
    ride('ride', 'line2', 'destination', 120, 'SUBWAY', '2'),
  ] };
  assert.equal(findAverageRoute(graph, 'line1', 'destination').averageTravelSeconds, 420);
});

test('multiple platforms preserve fastest versus fewest-transfers ordering', () => {
  const graph = { nodes: [
    { id: 'A', type: 'SUBWAY_PLATFORM', routeId: '1' },
    { id: 'B', type: 'SUBWAY_PLATFORM', routeId: '2' },
    { id: 'T1', type: 'SUBWAY_PLATFORM', routeId: '1' },
    { id: 'T2', type: 'SUBWAY_PLATFORM', routeId: '2' },
  ], edges: [
    ride('slow-direct', 'A', 'T1', 1000, 'SUBWAY', '1'),
    connector('change', 'A', 'B', 10, 'TRANSFER'),
    ride('quick-after-change', 'B', 'T2', 10, 'SUBWAY', '2'),
  ] };
  const fast = findAverageRouteBetween(graph, ['A'], ['T1', 'T2'], 'fastest');
  const fewer = findAverageRouteBetween(graph, ['A'], ['T1', 'T2'], 'fewest-transfers');
  assert.deepEqual([fast.to, fast.averageTravelSeconds, fast.transferCount], ['T2', 20, 1]);
  assert.deepEqual([fewer.to, fewer.averageTravelSeconds, fewer.transferCount], ['T1', 1000, 0]);
  const multiOrigin = findAverageRouteBetween(graph, ['A', 'B'], ['T1', 'T2']);
  assert.deepEqual([multiOrigin.from, multiOrigin.to, multiOrigin.averageTravelSeconds], ['B', 'T2', 10]);
});

test('zero-second verified rides remain valid for the existing provider contract', () => {
  const graph = { nodes: [nodes[0], nodes[1]], edges: [ride('zero', 'A', 'B', 0, 'SUBWAY', '2')] };
  assert.equal(findAverageRoute(graph, 'A', 'B').averageTravelSeconds, 0);
});

test('fallback adapter preserves transfer-only routes and zero-second provider rides', () => {
  const transfer = findRoute('mock-1-cityhall', 'mock-2-cityhall');
  assert.equal(transfer.stops, 0);
  assert.equal(transfer.transfers, 1);
  assert.equal(transfer.seconds, 300);
  assert.deepEqual(transfer.steps.map(step => step.transfer), [false, true]);
  const provider = createRouteCostProvider({ rides: [
    { fromPlatformId: 'mock-2-gangnam', toPlatformId: 'mock-2-yeoksam', seconds: 0 },
  ] });
  const zero = findRoute('mock-2-gangnam', 'mock-2-yeoksam', 'fastest', provider);
  assert.equal(zero.stops, 1);
  assert.equal(zero.seconds, 0);
  assert.deepEqual(zero.steps.map(step => step.secondsFromStart), [0, 0]);
});

test('invalid ride endpoints and missing or negative average costs are rejected', () => {
  const physical = { nodes: [{ id: 'station', type: 'SUBWAY_STATION' }, nodes[1]],
    edges: [ride('bad', 'station', 'B', 120, 'SUBWAY', '2')] };
  assert.throws(() => findAverageRoute(physical, 'station', 'B'), /AVERAGE_GRAPH_INVALID_EDGE/);
  assert.throws(() => findAverageRoute({ nodes, edges: [ride('bad', 'A', 'B', -10, 'SUBWAY', '2')] }, 'A', 'B'), /AVERAGE_GRAPH_INVALID_EDGE/);
  assert.throws(() => findAverageRoute({ nodes, edges: [ride('bad', 'A', 'B', 120, 'SUBWAY', '1')] }, 'A', 'B'), /AVERAGE_GRAPH_INVALID_EDGE/);
  assert.throws(() => findAverageRoute({ nodes: [{ id: 'bad', type: 'BUS_SERVICE_STATE' }], edges: [] }, 'bad', 'bad'), /AVERAGE_GRAPH_INVALID_NODE/);
  assert.throws(() => findAverageRoute({ nodes, edges: [{ ...ride('bad', 'A', 'B', 120, 'SUBWAY', '2'), averageTravelSeconds: undefined }] }, 'A', 'B'), /AVERAGE_GRAPH_INVALID_EDGE/);
  assert.throws(() => findAverageRoute({ nodes, edges: [ride('bad', 'A', 'missing', 120, 'SUBWAY', '2')] }, 'A', 'B'), /AVERAGE_GRAPH_INVALID_EDGE/);
});
