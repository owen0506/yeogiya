import { useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StationSearchField } from '../stations/station-search-field';
import type { StationFieldValue } from '../stations/stations';
import { findRoute, type JourneyRoute } from './route-service';
import { RouteResultScreen } from './route-result-screen';
import { AlarmStatus } from '../notifications/alarm-status';

export default function HomeScreen() {
  const [departure, setDeparture] = useState<StationFieldValue>({ query: '', station: null });
  const [arrival, setArrival] = useState<StationFieldValue>({ query: '', station: null });
  const [activeField, setActiveField] = useState<'departure' | 'arrival' | null>(null);
  const [stopsBefore, setStopsBefore] = useState(1);
  const [route, setRoute] = useState<JourneyRoute | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const sameStation = departure.station != null && departure.station.id === arrival.station?.id;
  const canSearch = Boolean(departure.station && arrival.station && !sameStation);

  function searchRoute() {
    if (!departure.station || !arrival.station || sameStation) return;
    finishSelection();
    const result = findRoute(departure.station.id, arrival.station.id);
    setRouteError(result ? null : '데모 노선망에서 연결 경로를 찾지 못했습니다. 다른 역을 선택해주세요.');
    setRoute(result);
  }

  function finishSelection() {
    setActiveField(null);
    Keyboard.dismiss();
  }

  if (route) return <RouteResultScreen route={route} stopsBefore={stopsBefore} onBack={() => setRoute(null)} />;

  return (
    <SafeAreaView style={styles.page}>
      <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.brand}>지하철 하차 알림 · 수도권</Text>
          <Text accessibilityRole="header" style={styles.title}>어디까지 가시나요?</Text>
          <Text style={styles.description}>내릴 역을 미리 정하고, 이동하는 동안 잠시 쉬어가세요.</Text>
          <AlarmStatus />
          <View style={styles.card}>
            <Text style={styles.caption}>일부 역의 더미 데이터로 검색을 체험할 수 있어요.</Text>
            <StationSearchField label="출발역" value={departure} onChange={setDeparture} active={activeField === 'departure'} onFocus={() => setActiveField('departure')} onSelect={finishSelection} />
            <Pressable accessibilityRole="button" accessibilityLabel="출발역과 도착역 바꾸기" onPress={() => { setDeparture(arrival); setArrival(departure); finishSelection(); }} style={styles.swap}>
              <Text style={styles.brand}>↑↓ 출발·도착 바꾸기</Text>
            </Pressable>
            <StationSearchField label="도착역" value={arrival} onChange={setArrival} active={activeField === 'arrival'} onFocus={() => setActiveField('arrival')} onSelect={finishSelection} />
            {sameStation && <Text accessibilityRole="alert" style={styles.caption}>출발역과 도착역이 같습니다. 다른 역을 선택해주세요.</Text>}
            <View style={styles.divider} />
            <Text style={styles.label}>언제 알려드릴까요?</Text>
            <View style={styles.options}>
              {[1, 2].map((count) => (
                <Pressable key={count} accessibilityRole="radio" accessibilityState={{ checked: stopsBefore === count }} onPress={() => setStopsBefore(count)} style={({ pressed }) => [styles.option, stopsBefore === count && styles.selected, pressed && { opacity: 0.65 }]}>
                  <Text style={styles.label}>{count}개 역 전</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.caption}>경로를 확인하고 탑승 후 예상 시간 알림을 시작하세요.</Text>
            {routeError && <Text accessibilityRole="alert" style={styles.caption}>{routeError}</Text>}
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canSearch }} disabled={!canSearch} onPress={searchRoute} style={[styles.disabledButton, canSearch && { backgroundColor: '#116B55' }]}>
              <Text style={[styles.description, canSearch && { color: '#FFFFFF' }]}>경로 검색</Text>
            </Pressable>
          </View>
          <View style={styles.notice}>
            <Text style={styles.label}>하차 알림, 이렇게 이용해요</Text>
            <Text style={styles.description}>1. 출발역과 도착역을 선택해요.</Text>
            <Text style={styles.description}>2. 경로를 확인하고 알림을 시작해요.</Text>
            <Text style={styles.description}>3. 도착 전 알림을 받고 하차를 준비해요.</Text>
          </View>
          <Text style={styles.caption}>더미 경로와 예상 시간 알림을 체험할 수 있습니다. 실제 열차 위치 기반 하차 안내가 아닙니다.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F4F7FA' },
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', padding: 24, gap: 20, paddingBottom: 40 },
  brand: { fontSize: 15, fontWeight: '700', color: '#116B55' },
  title: { fontSize: 30, fontWeight: '700', color: '#172D40', marginTop: 20 },
  description: { fontSize: 15, lineHeight: 24, color: '#566B7C' },
  card: { backgroundColor: '#FFFFFF', padding: 22, borderRadius: 24, gap: 14, borderWidth: 1, borderColor: '#D9E2E8' },
  label: { fontSize: 16, fontWeight: '600', color: '#172D40' },
  swap: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  divider: { height: 1, backgroundColor: '#D9E2E8', marginVertical: 8 },
  options: { flexDirection: 'row', gap: 12 },
  option: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: '#D9E2E8', padding: 12 },
  selected: { backgroundColor: '#E8F4EF', borderColor: '#116B55' },
  caption: { fontSize: 13, lineHeight: 21, color: '#566B7C' },
  disabledButton: { backgroundColor: '#E2E8ED', borderRadius: 12, minHeight: 54, justifyContent: 'center', alignItems: 'center', padding: 12 },
  notice: { padding: 20, backgroundColor: '#E8F4EF', borderRadius: 20, gap: 10 },
});
