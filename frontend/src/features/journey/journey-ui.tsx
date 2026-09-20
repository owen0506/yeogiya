import type { PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { lineColor } from '../stations/network';

export const palette = { green: '#16875B', bright: '#20AC72', ink: '#23352D', muted: '#7B8780', border: '#E6EBE7', soft: '#F5F8F5', tint: '#EDF7EF', white: '#FFFFFF' };

export function TrainIcon({ size = 24, color = palette.green }: { size?: number; color?: string }) {
  return <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    <View style={{ width: size * .67, height: size * .75, borderWidth: 1.8, borderColor: color, borderRadius: size * .18, padding: size * .1, gap: size * .1 }}>
      <View style={{ height: size * .23, borderWidth: 1.4, borderColor: color, borderRadius: 2 }} />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><View style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: color }} /><View style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: color }} /></View>
    </View>
    <View style={{ position: 'absolute', bottom: 0, width: size * .48, borderBottomWidth: 1.6, borderColor: color }} />
  </View>;
}

export function LineBadge({ line, small = false }: { line: string; small?: boolean }) {
  return <View style={[ui.badge, { backgroundColor: lineColor(line) }, small && { paddingHorizontal: 6, paddingVertical: 2 }]}><Text style={{ color: '#FFF', fontWeight: '700', fontSize: small ? 10 : 11 }}>{line}</Text></View>;
}

export function Action({ children, onPress, secondary = false, disabled = false, label, style }: PropsWithChildren<{ onPress: () => void; secondary?: boolean; disabled?: boolean; label?: string; style?: StyleProp<ViewStyle> }>) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [ui.action, secondary ? ui.secondary : ui.primary, disabled && { opacity: .42 }, pressed && { opacity: .75 }, style]}><Text style={[ui.actionText, { color: secondary ? palette.green : '#FFF' }]}>{children}</Text></Pressable>;
}

export const ui = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  heading: { fontSize: 18, fontWeight: '700', color: palette.ink, letterSpacing: -.5 },
  text: { fontSize: 14, color: palette.ink, lineHeight: 22 },
  muted: { fontSize: 12, color: palette.muted, lineHeight: 19 },
  eyebrow: { fontSize: 10, color: palette.green, letterSpacing: 2, fontWeight: '700' },
  badge: { borderRadius: 5, paddingHorizontal: 7, paddingVertical: 4, alignSelf: 'flex-start' },
  card: { backgroundColor: '#FFF', borderWidth: 1, borderColor: palette.border, borderRadius: 18, padding: 20, gap: 16 },
  divider: { height: 1, backgroundColor: palette.border },
  action: { minHeight: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 13 },
  primary: { backgroundColor: palette.green },
  secondary: { backgroundColor: palette.tint },
  actionText: { fontSize: 14, fontWeight: '700', textAlign: 'center' },
});
