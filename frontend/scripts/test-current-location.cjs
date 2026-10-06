const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const babel = require('@babel/core');
const collectDependencies = require(path.join(
  path.dirname(require.resolve('@expo/metro-config/package.json')),
  'build/transform-worker/collect-dependencies.js',
)).default;
const { createCurrentLocationGetter, CurrentLocationError } = require('../src/services/current-location.ts');

const NOW = Date.parse('2026-10-04T10:00:00.000Z');
const freshFix = { coords: { latitude: 37.3722, longitude: 126.9433, accuracy: 12 }, timestamp: NOW };
const allowed = { granted: true, canAskAgain: true };
const denied = { granted: false, canAskAgain: false };
const options = { now: () => NOW, timeoutMs: 100, permissionTimeoutMs: 100 };

function source(overrides = {}) {
  return {
    platform: 'native', hasServicesEnabled: async () => true,
    getPermission: async () => allowed, getPosition: async () => freshFix,
    ...overrides,
  };
}

test('current location waits for foreground permission and returns the actual fix timestamp', async () => {
  const calls = [];
  const getLocation = createCurrentLocationGetter(source({
    getPermission: async () => ({ granted: false, canAskAgain: true }),
    requestPermission: async () => { calls.push('permission'); return allowed; },
    getPosition: async () => { calls.push('position'); return freshFix; },
  }), options);
  assert.deepEqual(await getLocation(), {
    latitude: 37.3722, longitude: 126.9433, accuracyMeters: 12, observedAt: '2026-10-04T10:00:00.000Z',
  });
  assert.deepEqual(calls, ['permission', 'position']);
});

test('denied permission never starts a location request and offers native settings only when blocked', async () => {
  let reads = 0;
  let requests = 0;
  const getLocation = createCurrentLocationGetter(source({
    getPermission: async () => denied,
    requestPermission: async () => { requests++; return allowed; },
    getPosition: async () => { reads++; return freshFix; },
  }), options);
  await assert.rejects(getLocation(), (error) => error instanceof CurrentLocationError
    && error.kind === 'permission-denied' && error.canOpenSettings);
  assert.equal(reads, 0);
  assert.equal(requests, 0);
  await assert.rejects(createCurrentLocationGetter(source({
    getPermission: async () => ({ granted: false, canAskAgain: true }),
    requestPermission: async () => ({ granted: false, canAskAgain: true }),
  }), options)(), (error) => error.kind === 'permission-denied' && !error.canOpenSettings);
});

test('disabled location services do not prompt for permission or read position', async () => {
  const getLocation = createCurrentLocationGetter(source({
    hasServicesEnabled: async () => false,
    getPermission: async () => { assert.fail('must not request permission'); },
    getPosition: async () => { assert.fail('must not read location'); },
  }), options);
  await assert.rejects(getLocation(), (error) => error.kind === 'location-disabled');
});

test('stale, future and invalid coordinates cannot become current location endpoints', async () => {
  for (const fix of [
    { ...freshFix, timestamp: NOW - 61_000 },
    { ...freshFix, timestamp: NOW + 11_000 },
    { ...freshFix, timestamp: NaN },
    { ...freshFix, coords: { ...freshFix.coords, latitude: 91 } },
    { ...freshFix, coords: { ...freshFix.coords, longitude: -181 } },
    { ...freshFix, coords: { ...freshFix.coords, latitude: NaN } },
  ]) {
    await assert.rejects(createCurrentLocationGetter(source({ getPosition: async () => fix }), options)(),
      (error) => error.kind === 'unavailable');
  }
  const result = await createCurrentLocationGetter(source({
    getPosition: async () => ({ ...freshFix, coords: { ...freshFix.coords, accuracy: -1 } }),
  }), options)();
  assert.equal(result.accuracyMeters, null);
});

test('position and permission timeouts finish without accepting a late result', async () => {
  let finish;
  const getLocation = createCurrentLocationGetter(source({
    getPosition: () => new Promise((resolve) => { finish = resolve; }),
  }), { ...options, timeoutMs: 5 });
  await assert.rejects(getLocation(), (error) => error.kind === 'timeout');
  finish(freshFix);
  let reads = 0;
  await assert.rejects(createCurrentLocationGetter(source({
    getPermission: async () => ({ granted: false, canAskAgain: true }),
    requestPermission: () => new Promise(() => {}),
    getPosition: async () => { reads++; return freshFix; },
  }), { ...options, permissionTimeoutMs: 5 })(), (error) => error.kind === 'timeout');
  assert.equal(reads, 0);
});

test('browser error codes show permission, timeout and unavailable messages without native settings', async () => {
  for (const [code, kind] of [[1, 'permission-denied'], [2, 'unavailable'], [3, 'timeout']]) {
    await assert.rejects(createCurrentLocationGetter({
      platform: 'web', getPosition: async () => { throw { code }; },
    }, options)(), (error) => error.kind === kind && !error.canOpenSettings && /[가-힣]/.test(error.message));
  }
});

test('the Expo Go iOS entry point loads Platform without touching unrelated React Native native modules', async () => {
  // Node's import interop preserves getters, while Metro's importAll reads them.
  // Exercise the actual service through the installed Metro/Expo runtime so this
  // catches a dynamic React Native import that pure provider tests would miss.
  const serviceSource = fs.readFileSync(path.join(__dirname, '../src/services/current-location.ts'), 'utf8');
  const stripped = ts.transpileModule(serviceSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const transformed = babel.transformSync(stripped, {
    ast: true, code: false, babelrc: false, configFile: false,
    plugins: [require('@babel/plugin-transform-modules-commonjs')],
  });
  const collected = collectDependencies(transformed.ast, {
    asyncRequireModulePath: 'expo/internal/async-require-module',
    dynamicRequires: 'reject', inlineableCalls: [], keepRequireNames: true,
    allowOptionalDependencies: false, unstable_allowRequireContext: false,
    unstable_isESMImportAtSource: null,
  });
  const serviceCode = babel.transformFromAstSync(collected.ast, null, {
    babelrc: false, configFile: false,
  }).code;
  const getterReads = [];
  const locationCalls = [];
  const context = vm.createContext({
    __DEV__: false, __METRO_GLOBAL_PREFIX__: '',
    process: { env: { EXPO_OS: 'ios' } }, console, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return NOW; } },
  });
  context.global = context;
  vm.runInContext(fs.readFileSync(require.resolve('metro-runtime/polyfills/require'), 'utf8'), context);
  context.__d((_global, _require, _importDefault, _importAll, module) => {
    module.exports = {
      get Platform() { getterReads.push('Platform'); return { OS: 'ios' }; },
      get PushNotificationIOS() {
        getterReads.push('PushNotificationIOS');
        throw new Error('Expo Go does not provide PushNotificationManagerIOS');
      },
    };
  }, 1, []);
  context.__d((_global, _require, _importDefault, _importAll, module) => {
    module.exports = {
      Accuracy: { High: 4 },
      hasServicesEnabledAsync: async () => { locationCalls.push('services'); return true; },
      getForegroundPermissionsAsync: async () => {
        locationCalls.push('permission'); return { granted: false, canAskAgain: true };
      },
      requestForegroundPermissionsAsync: async () => { locationCalls.push('request'); return allowed; },
      getCurrentPositionAsync: async (positionOptions) => {
        assert.equal(positionOptions.accuracy, 4);
        locationCalls.push('position'); return freshFix;
      },
    };
  }, 2, []);
  const expoRoot = path.dirname(require.resolve('expo/package.json'));
  const asyncRequireSource = fs.readFileSync(path.join(expoRoot, 'src/async-require/asyncRequireModule.ts'), 'utf8');
  const asyncRequireCode = ts.transpileModule(asyncRequireSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInContext(`__d(function(global, require, importDefault, importAll, module, exports) {
    ${asyncRequireCode}
  }, 3, []);`, context);
  const dependencyIds = {
    'react-native': 1, 'expo-location': 2, 'expo/internal/async-require-module': 3,
  };
  const dependencyMap = collected.dependencies.map(({ name }) => {
    assert.ok(Object.hasOwn(dependencyIds, name), `Unexpected service dependency: ${name}`);
    return dependencyIds[name];
  });
  vm.runInContext(`__d(function(global, require, importDefault, importAll, module, exports, ${collected.dependencyMapName}) {
    ${serviceCode}
  }, 4, ${JSON.stringify(dependencyMap)});`, context);
  const { getCurrentLocation } = context.__r(4);
  assert.deepEqual(getterReads, [], 'Loading the service must not load React Native');
  assert.deepEqual(locationCalls, [], 'Loading the service must not request location');
  const result = await getCurrentLocation();
  assert.deepEqual(getterReads, ['Platform']);
  assert.deepEqual(locationCalls, ['services', 'permission', 'request', 'position']);
  assert.equal(result.latitude, freshFix.coords.latitude);
  assert.equal(result.longitude, freshFix.coords.longitude);
  assert.equal(result.accuracyMeters, freshFix.coords.accuracy);
  assert.equal(result.observedAt, '2026-10-04T10:00:00.000Z');
});
