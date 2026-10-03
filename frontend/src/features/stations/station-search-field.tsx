import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { StationLines, palette, ui } from '../journey/journey-ui';
import { searchStations, type StationFieldValue } from './stations';

type Props = { label: string; value: StationFieldValue; active: boolean; onFocus: () => void; onChange: (value: StationFieldValue) => void; onSelect: () => void };

export function StationSearchField({ label, value, active, onFocus, onChange, onSelect }: Props) {
  const results = active && !value.station ? searchStations(value.query) : [];
  const destination = label === '도착역';
  return <View style={{ gap: 8 }}>
    <View style={[styles.field, active && { borderColor: palette.green, backgroundColor: '#FFF' }]}>
      <View style={[styles.dot, destination && { backgroundColor: palette.green }]} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={styles.label}>{destination ? '내릴 역' : '출발역'}</Text>
        <TextInput accessibilityLabel={`${label} 검색`} value={value.query} onFocus={onFocus} onChangeText={(query) => onChange({ query, station: null })} placeholder={destination ? '어디에서 내리시나요?' : '어디에서 출발하시나요?'} placeholderTextColor="#9AA49E" autoCorrect={false} maxLength={50} style={styles.input} />
      </View>
      {value.station && <StationLines lines={value.station.lines} small />}
      {!!value.query && <Pressable accessibilityRole="button" accessibilityLabel={`${label} 지우기`} onPress={() => { onChange({ query: '', station: null }); onFocus(); }} style={styles.clear}><Text style={{ fontSize: 19, color: '#9AA49E' }}>×</Text></Pressable>}
    </View>
    {active && !value.station && !!value.query.trim() && <View style={styles.results}>
      <Text accessibilityLiveRegion="polite" style={ui.muted}>{results.length ? '환승역은 하나로 모아 보여드려요' : '검색 결과가 없어요. 다른 이름을 입력해보세요.'}</Text>
      {results.slice(0, 10).map((station) => <Pressable key={station.id} accessibilityRole="button" accessibilityLabel={`${label}으로 ${station.name} ${station.lines.join('·')} 선택`} onPress={() => { onChange({ query: station.name, station }); onSelect(); }} style={({ pressed }) => [styles.result, pressed && { backgroundColor: palette.tint }]}><Text style={[ui.text, { flex: 1 }]}>{station.name}</Text><StationLines lines={station.lines} small /></Pressable>)}
      {results.length > 10 && <Text style={ui.muted}>역 이름을 더 입력하면 검색 범위를 좁힐 수 있어요.</Text>}
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  field: { minHeight: 70, paddingLeft: 15, paddingRight: 5, borderWidth: 1, borderColor: '#EDF0ED', backgroundColor: '#F7F9F7', borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: palette.green },
  label: { fontSize: 10, fontWeight: '600', color: palette.muted },
  input: { fontSize: 16, color: palette.ink, fontWeight: '600', paddingVertical: 2, paddingHorizontal: 0, minWidth: 0 },
  clear: { minWidth: 36, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  results: { borderWidth: 1, borderColor: palette.border, borderRadius: 12, padding: 12, backgroundColor: '#FFF', gap: 4 },
  result: { minHeight: 45, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: '#F0F3F0', gap: 8 },
});
