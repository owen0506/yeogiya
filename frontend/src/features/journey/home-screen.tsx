import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function HomeScreen() {
  const [departure, setDeparture] = useState('');
  const [arrival, setArrival] = useState('');
  const [stopsBefore, setStopsBefore] = useState(1);

  return (
    <SafeAreaView style={styles.page}>
      <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.brand}>지하철 하차 알림 · 수도권</Text>
          <Text accessibilityRole="header" style={styles.title}>어디까지 가시나요?</Text>
          <Text style={styles.description}>내릴 역을 미리 정하고, 이동하는 동안 잠시 쉬어가세요.</Text>
          <View style={styles.card}>
            <Text style={styles.label}>출발역</Text>
            <TextInput accessibilityLabel="출발역" value={departure} onChangeText={setDeparture} placeholder="출발역을 입력하세요" placeholderTextColor="#566B7C" autoCorrect={false} maxLength={50} style={styles.input} />
            <Pressable accessibilityRole="button" accessibilityLabel="출발역과 도착역 바꾸기" onPress={() => { setDeparture(arrival); setArrival(departure); }} style={styles.swap}>
              <Text style={styles.brand}>↑↓ 출발·도착 바꾸기</Text>
            </Pressable>
            <Text style={styles.label}>도착역</Text>
            <TextInput accessibilityLabel="도착역" value={arrival} onChangeText={setArrival} placeholder="도착역을 입력하세요" placeholderTextColor="#566B7C" autoCorrect={false} maxLength={50} style={styles.input} />
            <View style={styles.divider} />
            <Text style={styles.label}>언제 알려드릴까요?</Text>
            <View style={styles.options}>
              {[1, 2].map((count) => (
                <Pressable key={count} accessibilityRole="radio" accessibilityState={{ checked: stopsBefore === count }} onPress={() => setStopsBefore(count)} style={({ pressed }) => [styles.option, stopsBefore === count && styles.selected, pressed && { opacity: 0.65 }]}>
                  <Text style={styles.label}>{count}개 역 전</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.caption}>알림 시점을 미리 선택할 수 있어요. 실제 알림 기능은 준비 중입니다.</Text>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: true }} disabled style={styles.disabledButton}>
              <Text style={styles.description}>경로 검색 · 준비 중</Text>
            </Pressable>
          </View>
          <View style={styles.notice}>
            <Text style={styles.label}>하차 알림, 이렇게 이용해요</Text>
            <Text style={styles.description}>1. 출발역과 도착역을 선택해요.</Text>
            <Text style={styles.description}>2. 경로를 확인하고 알림을 시작해요.</Text>
            <Text style={styles.description}>3. 도착 전 알림을 받고 하차를 준비해요.</Text>
          </View>
          <Text style={styles.caption}>현재는 기본 화면입니다. 역 검색, 경로 안내, 실시간 정보와 하차 알림은 순차적으로 제공할 예정입니다.</Text>
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
  input: { borderWidth: 1, borderColor: '#D9E2E8', borderRadius: 12, padding: 16, fontSize: 18, color: '#172D40', backgroundColor: '#F4F7FA' },
  swap: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  divider: { height: 1, backgroundColor: '#D9E2E8', marginVertical: 8 },
  options: { flexDirection: 'row', gap: 12 },
  option: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: '#D9E2E8', padding: 12 },
  selected: { backgroundColor: '#E8F4EF', borderColor: '#116B55' },
  caption: { fontSize: 13, lineHeight: 21, color: '#566B7C' },
  disabledButton: { backgroundColor: '#E2E8ED', borderRadius: 12, minHeight: 54, justifyContent: 'center', alignItems: 'center', padding: 12 },
  notice: { padding: 20, backgroundColor: '#E8F4EF', borderRadius: 20, gap: 10 },
});
