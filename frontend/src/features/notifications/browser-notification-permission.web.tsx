import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { palette, ui } from '../journey/journey-ui';

export function BrowserNotificationPermission() {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const update = () => setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
    update(); window.addEventListener('focus', update);
    return () => window.removeEventListener('focus', update);
  }, []);
  async function request() {
    setBusy(true);
    try { setPermission(await Notification.requestPermission()); }
    catch { setPermission('unsupported'); }
    finally { setBusy(false); }
  }
  return <View style={{ gap: 8 }}>
    <Text style={[ui.muted, { fontSize: 10 }]}>{permission === 'granted' ? '브라우저 알림이 허용되어 있어요. 탭은 계속 열어두세요.' : permission === 'denied' ? '브라우저 알림이 차단되어 화면에서 알려드려요. 주소창의 사이트 설정에서 알림을 허용할 수 있어요.' : permission === 'unsupported' ? '이 브라우저에서는 화면 안에서 알려드려요. 탭을 열어두세요.' : '탭을 열어두면 화면에서 알려드려요. 브라우저 알림도 함께 받을 수 있어요.'}</Text>
    {permission === 'default' && <Pressable accessibilityRole="button" disabled={busy} onPress={() => void request()} style={{ minHeight: 34, justifyContent: 'center' }}><Text style={{ color: palette.green, fontSize: 11 }}>{busy ? '브라우저의 권한 안내를 확인해주세요' : '브라우저 알림도 허용하기 ↗'}</Text></Pressable>}
  </View>;
}
