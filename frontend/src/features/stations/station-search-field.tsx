import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { searchStations, type StationFieldValue } from './stations';

type Props = {
  label: string;
  value: StationFieldValue;
  active: boolean;
  onFocus: () => void;
  onChange: (value: StationFieldValue) => void;
  onSelect: () => void;
};

export function StationSearchField({ label, value, active, onFocus, onChange, onSelect }: Props) {
  const results = active && !value.station ? searchStations(value.query) : [];
  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={`${label} 검색`}
        value={value.query}
        onFocus={onFocus}
        onChangeText={(query) => onChange({ query, station: null })}
        placeholder="역 이름 검색 (예: 강남, 서울역)"
        placeholderTextColor="#566B7C"
        autoCorrect={false}
        maxLength={50}
        style={styles.input}
      />
      {value.query.length > 0 && (
        <Pressable accessibilityRole="button" accessibilityLabel={`${label} 지우기`} onPress={() => onChange({ query: '', station: null })} style={styles.clear}>
          <Text style={styles.help}>지우기</Text>
        </Pressable>
      )}
      {value.station ? (
        <Text accessibilityLiveRegion="polite" style={styles.selection}>선택됨: {value.station.name} · {value.station.line}</Text>
      ) : active ? (
        <View style={styles.results}>
          <Text accessibilityLiveRegion="polite" style={styles.help}>
            {!value.query.trim() ? '역 이름을 입력한 뒤 검색 결과를 선택하세요.' : results.length === 0 ? '검색 결과가 없습니다. 더미 데이터에 포함된 역만 검색할 수 있어요.' : `검색 결과 ${results.length}개 · 노선을 확인하고 선택하세요.`}
          </Text>
          {results.map((station) => (
            <Pressable key={station.id} accessibilityRole="button" accessibilityLabel={`${label}으로 ${station.name} ${station.line} 선택`} onPress={() => { onChange({ query: station.name, station }); onSelect(); }} style={({ pressed }) => [styles.result, pressed && styles.pressed]}>
              <Text style={styles.label}>{station.name}</Text>
              <Text style={styles.line}>{station.line}</Text>
            </Pressable>
          ))}
        </View>
      ) : value.query.trim() ? <Text style={styles.help}>검색 결과에서 역을 선택해주세요.</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 10 },
  label: { fontSize: 16, fontWeight: '600', color: '#172D40' },
  input: { borderWidth: 1, borderColor: '#D9E2E8', borderRadius: 12, padding: 16, fontSize: 16, color: '#172D40', backgroundColor: '#F4F7FA' },
  clear: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  help: { fontSize: 13, lineHeight: 21, color: '#566B7C' },
  selection: { fontSize: 14, color: '#116B55', lineHeight: 22 },
  results: { gap: 8 },
  result: { minHeight: 48, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: 12, borderWidth: 1, borderColor: '#D9E2E8', borderRadius: 10 },
  line: { fontSize: 13, color: '#116B55', backgroundColor: '#E8F4EF', padding: 6, borderRadius: 6 },
  pressed: { backgroundColor: '#E8F4EF' },
});
