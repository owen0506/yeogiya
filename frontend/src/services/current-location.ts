export type CurrentLocation = Readonly<{
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  observedAt: string;
}>;

export type CurrentLocationErrorKind =
  | 'permission-denied'
  | 'location-disabled'
  | 'timeout'
  | 'unavailable'
  | 'unsupported';

export class CurrentLocationError extends Error {
  readonly kind: CurrentLocationErrorKind;
  readonly canOpenSettings: boolean;

  constructor(kind: CurrentLocationErrorKind, message: string, canOpenSettings = false) {
    super(message);
    this.name = 'CurrentLocationError';
    this.kind = kind;
    this.canOpenSettings = canOpenSettings;
  }
}

type Permission = Readonly<{ granted: boolean; canAskAgain: boolean }>;
type LocationFix = Readonly<{
  coords: Readonly<{ latitude: number; longitude: number; accuracy?: number | null }>;
  timestamp: number;
}>;

/** The provider boundary keeps device permissions and stale-fix handling testable. */
export type CurrentLocationSource = Readonly<{
  platform: 'native' | 'web';
  hasServicesEnabled?: () => Promise<boolean>;
  getPermission?: () => Promise<Permission>;
  requestPermission?: () => Promise<Permission>;
  getPosition: () => Promise<LocationFix>;
}>;

const POSITION_TIMEOUT_MS = 20_000;
const PERMISSION_TIMEOUT_MS = 60_000;
const MAX_FIX_AGE_MS = 60_000;

function permissionError(platform: CurrentLocationSource['platform'], canAskAgain = false) {
  return new CurrentLocationError(
    'permission-denied',
    platform === 'web'
      ? '브라우저의 사이트 설정에서 위치 접근을 허용한 뒤 다시 눌러주세요.'
      : canAskAgain
        ? '내 위치를 사용하려면 위치 접근을 허용해주세요.'
        : '설정에서 위치 접근을 허용한 뒤 다시 눌러주세요.',
    platform === 'native' && !canAskAgain,
  );
}

function unavailableError() {
  return new CurrentLocationError('unavailable', '현재 위치를 확인하지 못했어요. 잠시 후 다시 눌러주세요.');
}

function normalizeLocationError(error: unknown, platform: CurrentLocationSource['platform']) {
  if (error instanceof CurrentLocationError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 1 || (typeof code === 'string' && /PERMISSION|UNAUTHORIZED/.test(code))) {
    return permissionError(platform);
  }
  if (code === 3 || (typeof code === 'string' && /TIMEOUT/.test(code))) {
    return new CurrentLocationError('timeout', '위치를 찾는 데 시간이 걸리고 있어요. 창가나 야외에서 다시 눌러주세요.');
  }
  if (typeof code === 'string' && /SERVICES_DISABLED|SETTINGS_UNSATISFIED/.test(code)) {
    return new CurrentLocationError('location-disabled', '휴대폰의 위치 서비스를 켠 뒤 다시 눌러주세요.');
  }
  return unavailableError();
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CurrentLocationError(
          'timeout', '위치를 찾는 데 시간이 걸리고 있어요. 창가나 야외에서 다시 눌러주세요.',
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createCurrentLocationGetter(
  source: CurrentLocationSource,
  options: Readonly<{ now?: () => number; timeoutMs?: number; permissionTimeoutMs?: number }> = {},
): () => Promise<CurrentLocation> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? POSITION_TIMEOUT_MS;
  const permissionTimeoutMs = options.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS;

  return async () => {
    try {
      if (source.hasServicesEnabled && !await withTimeout(source.hasServicesEnabled(), timeoutMs)) {
        throw new CurrentLocationError('location-disabled', '휴대폰의 위치 서비스를 켠 뒤 다시 눌러주세요.');
      }

      if (source.getPermission) {
        let permission = await withTimeout(source.getPermission(), timeoutMs);
        if (!permission.granted && permission.canAskAgain && source.requestPermission) {
          permission = await withTimeout(source.requestPermission(), permissionTimeoutMs);
        }
        if (!permission.granted) throw permissionError(source.platform, permission.canAskAgain);
      }

      // One fresh fix only. A late native result after timeout is ignored; no tracking is started.
      const fix = await withTimeout(source.getPosition(), timeoutMs);
      const { latitude, longitude, accuracy } = fix.coords;
      const ageMs = now() - fix.timestamp;
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
        || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
        || !Number.isFinite(fix.timestamp) || ageMs > MAX_FIX_AGE_MS || ageMs < -10_000) {
        throw unavailableError();
      }

      return {
        latitude,
        longitude,
        accuracyMeters: typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
        observedAt: new Date(fix.timestamp).toISOString(),
      };
    } catch (error) {
      throw normalizeLocationError(error, source.platform);
    }
  };
}

/** Call in response to the user's current-location button, never on app startup. */
export async function getCurrentLocation(): Promise<CurrentLocation> {
  // Metro's dynamic import reads every React Native lazy export, including native
  // modules unavailable in Expo Go. Load only Platform when the button is pressed.
  const { Platform } = require('react-native') as typeof import('react-native');
  if (Platform.OS === 'web') {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      throw new CurrentLocationError('unsupported', '이 브라우저에서는 위치를 사용할 수 없어요. 휴대폰 앱에서 사용해주세요.');
    }
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      throw new CurrentLocationError('unsupported', '웹에서는 HTTPS 주소에서 위치를 사용할 수 있어요. 휴대폰에서는 Expo 앱을 이용해주세요.');
    }
    // The browser requests permission with this one foreground call. maximumAge: 0
    // prevents a previously cached location from silently becoming the route endpoint.
    return createCurrentLocationGetter({
      platform: 'web',
      getPosition: () => new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: POSITION_TIMEOUT_MS,
        });
      }),
    })();
  }

  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    throw new CurrentLocationError('unsupported', '이 기기에서는 위치를 사용할 수 없어요.');
  }

  const Location = await import('expo-location');
  return createCurrentLocationGetter({
    platform: 'native',
    hasServicesEnabled: Location.hasServicesEnabledAsync,
    getPermission: Location.getForegroundPermissionsAsync,
    requestPermission: Location.requestForegroundPermissionsAsync,
    getPosition: () => Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
  })();
}
