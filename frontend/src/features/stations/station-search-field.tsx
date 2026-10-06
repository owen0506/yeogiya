import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StationLines, palette, ui } from '../journey/journey-ui';
import { searchStations, type StationFieldValue } from './stations';
import { formatNearbyDistance } from './nearby-stations';

type Props = {
  label: string; value: StationFieldValue; active: boolean; onFocus: () => void; onBlur?: () => void;
  onChange: (value: StationFieldValue) => void; onSelect: () => void; resultsMaxHeight?: number;
  onUseCurrentLocation?: () => void; locating?: boolean; locationBusy?: boolean;
  locationError?: string | null; onOpenSettings?: () => void;
};

export function StationSearchField({ label, value, active, onFocus, onBlur, onChange, onSelect, resultsMaxHeight = 320,
  onUseCurrentLocation, locating, locationBusy, locationError, onOpenSettings }: Props) {
  const inputRef = useRef<TextInput>(null);
  const resultsRef = useRef<ScrollView>(null);
  const [showNearby, setShowNearby] = useState(false);
  useEffect(() => { if (!active) inputRef.current?.blur(); }, [active]);
  useEffect(() => { resultsRef.current?.scrollTo({ y: 0, animated: false }); }, [value.query]);
  useEffect(() => { setShowNearby(false); }, [value.currentLocation?.observedAt]);
  const results = active && !value.station && !value.currentLocation ? searchStations(value.query) : [];
  const destination = label === '도착역';
  const endpointLabel = destination ? '도착지' : '출발지';
  return <View style={{ gap: 8 }}>
    <View style={[styles.field, active && { borderColor: palette.green, backgroundColor: '#FFF' }]}>
      <View style={styles.fieldHeader}>
        <Text style={styles.label}>{endpointLabel}</Text>
        {onUseCurrentLocation && <Pressable accessibilityRole="button" accessibilityLabel={`${endpointLabel}로 내 위치 사용`}
          accessibilityState={{ disabled: !!locationBusy, busy: !!locating }} disabled={locationBusy} onPress={onUseCurrentLocation}
          style={[styles.locationButton, locationBusy && !locating && { opacity: .45 }]}>
          {locating && <ActivityIndicator size="small" color={palette.green} />}
          <Text style={styles.locationButtonText}>{locating ? '위치 확인 중' : value.currentLocation ? '위치 새로고침' : '◎ 내 위치'}</Text>
        </Pressable>}
      </View>
      <View style={styles.inputRow}>
        <View style={[styles.dot, destination && { backgroundColor: palette.green }]} />
        <TextInput ref={inputRef} accessibilityLabel={`${label} 검색`} value={value.query} onFocus={onFocus} onBlur={onBlur} onChangeText={(query) => onChange({ query, station: null })} placeholder={destination ? '목적지 역 또는 내 위치' : '출발역 또는 내 위치'} placeholderTextColor="#9AA49E" autoCorrect={false} selectTextOnFocus={!!value.currentLocation} maxLength={50} returnKeyType="done" style={styles.input} />
        {value.station && !value.currentLocation && <StationLines lines={value.station.lines} small />}
        {!!value.query && <Pressable accessibilityRole="button" accessibilityLabel={`${label} 지우기`} onPress={() => { onChange({ query: '', station: null }); inputRef.current?.focus(); }} style={styles.clear}><Text style={{ fontSize: 19, color: '#9AA49E' }}>×</Text></Pressable>}
      </View>
      {value.currentLocation && value.station && <View style={styles.locationSummary}>
        <Text style={[ui.muted, { flex: 1 }]}>{!destination && !value.currentLocation.connectionStationSelected ? '가까운 역 ' : ''}{value.station.name}{destination || value.currentLocation.connectionStationSelected ? ' 연결' : ''} · 직선 약 {formatNearbyDistance(value.currentLocation.distanceMeters)}</Text>
        {!!value.nearbyStations?.length && <Pressable accessibilityRole="button" accessibilityLabel={`${endpointLabel} 주변 연결 역 변경`} accessibilityState={{ expanded: showNearby }} onPress={() => { onSelect(); setShowNearby(!showNearby); }} style={styles.changeStation}>
          <Text style={styles.locationButtonText}>{showNearby ? '접기' : '역 변경'}</Text>
        </Pressable>}
      </View>}
      {value.currentLocation && !value.station && <Text style={[ui.muted, { paddingLeft: 20, paddingBottom: 4 }]}>위치 확인 완료 · 주변 군포 버스 정류장을 검색해요.</Text>}
      {value.currentLocation?.accuracyMeters != null && value.currentLocation.accuracyMeters > 100 &&
        <Text style={styles.accuracyNotice}>위치 오차 약 {formatNearbyDistance(value.currentLocation.accuracyMeters)} · 연결 역을 확인해주세요.</Text>}
    </View>
    {locationError && <View style={styles.locationFeedback}>
      <Text accessibilityRole="alert" style={styles.error}>{locationError}</Text>
      {onOpenSettings && <Pressable accessibilityRole="button" onPress={onOpenSettings} style={styles.settingsButton}><Text style={styles.locationButtonText}>위치 권한 설정 열기</Text></Pressable>}
    </View>}
    {value.currentLocation && showNearby && <View style={styles.nearby}>
      <Text style={ui.muted}>가까운 역 · 직선 거리 기준</Text>
      {value.nearbyStations?.map(({ station, distanceMeters }) => <Pressable key={station.id} accessibilityRole="radio"
        accessibilityLabel={`${endpointLabel} 연결 역 ${station.name}, 직선 약 ${formatNearbyDistance(distanceMeters)}`}
        accessibilityState={{ checked: value.station?.id === station.id }} style={styles.result}
        onPress={() => { onChange({ ...value, station, currentLocation: { ...value.currentLocation!, distanceMeters, connectionStationSelected: true } }); setShowNearby(false); onSelect(); }}>
        <View style={{ flex: 1, gap: 2 }}><Text style={ui.text}>{value.station?.id === station.id ? '✓ ' : ''}{station.name}</Text><Text style={ui.muted}>약 {formatNearbyDistance(distanceMeters)}</Text></View>
        <StationLines lines={station.lines} small />
      </Pressable>)}
    </View>}
    {active && !value.station && !value.currentLocation && !!value.query.trim() && <ScrollView ref={resultsRef} style={[styles.results, { maxHeight: resultsMaxHeight }]} contentContainerStyle={styles.resultsContent} nestedScrollEnabled keyboardShouldPersistTaps="handled" keyboardDismissMode="none">
      <Text accessibilityLiveRegion="polite" style={ui.muted}>{results.length ? '환승역은 하나로 모아 보여드려요' : '검색 결과가 없어요. 다른 이름을 입력해보세요.'}</Text>
      {results.slice(0, 10).map((station) => <Pressable key={station.id} accessibilityRole="button" accessibilityLabel={`${label}으로 ${station.name} ${station.lines.join('·')} 선택`} onPress={() => { onChange({ query: station.name, station }); onSelect(); }} style={({ pressed }) => [styles.result, pressed && { backgroundColor: palette.tint }]}><Text style={[ui.text, { flex: 1 }]}>{station.name}</Text><StationLines lines={station.lines} small /></Pressable>)}
      {results.length > 10 && <Text style={ui.muted}>역 이름을 더 입력하면 검색 범위를 좁힐 수 있어요.</Text>}
    </ScrollView>}
  </View>;
}

const styles = StyleSheet.create({
  field: { minHeight: 86, paddingLeft: 15, paddingRight: 8, paddingVertical: 6, borderWidth: 1, borderColor: '#EDF0ED', backgroundColor: '#F7F9F7', borderRadius: 12, gap: 1 },
  fieldHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 32 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 36 },
  dot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: palette.green },
  label: { fontSize: 10, fontWeight: '600', color: palette.muted },
  input: { flex: 1, fontSize: 16, color: palette.ink, fontWeight: '600', paddingVertical: 2, paddingHorizontal: 0, minWidth: 0 },
  locationButton: { minHeight: 32, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', gap: 5 },
  locationButtonText: { fontSize: 11, color: palette.green, fontWeight: '700' },
  locationSummary: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 20, paddingBottom: 3 },
  accuracyNotice: { fontSize: 11, lineHeight: 17, color: '#A16B36', paddingLeft: 20, paddingBottom: 4 },
  changeStation: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 6 },
  locationFeedback: { gap: 3, paddingHorizontal: 4 },
  error: { fontSize: 12, lineHeight: 19, color: '#BE6841' },
  settingsButton: { alignSelf: 'flex-start', minHeight: 36, justifyContent: 'center' },
  nearby: { padding: 12, borderWidth: 1, borderColor: palette.border, borderRadius: 12, backgroundColor: '#FFF', gap: 4 },
  clear: { minWidth: 36, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  results: { borderWidth: 1, borderColor: palette.border, borderRadius: 12, backgroundColor: '#FFF', flexGrow: 0 },
  resultsContent: { padding: 12, gap: 4 },
  result: { minHeight: 45, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: '#F0F3F0', gap: 8 },
});
