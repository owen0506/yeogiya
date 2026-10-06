import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { getBusCorridorStops, type BusVehicleCandidate } from '../../services/bus-vehicles';
import type { RideLeg } from '../transit/journey-plan';
import { VehicleAsset } from '../transit/vehicle-asset';
import { palette } from './journey-ui';

const GAP = 128;

export function BusTrack({ leg, candidates, color, selectedId, focusedId, onPress }: {
  leg: RideLeg; candidates: readonly BusVehicleCandidate[]; color: string;
  selectedId?: string; focusedId: string | null; onPress: (id: string) => void;
}) {
  const stops = getBusCorridorStops(leg);
  const scroll = useRef<ScrollView>(null);
  const [width, setWidth] = useState(0);
  const [groupSequence, setGroupSequence] = useState<number | null>(null);
  const boardIndex = stops.findIndex(stop => stop.serviceSequence === (leg.boardingSequence ?? leg.from.serviceSequence));
  const currentStartIndex = stops.findIndex(stop => stop.serviceSequence === leg.from.serviceSequence);
  useEffect(() => {
    if (width && currentStartIndex >= 0) scroll.current?.scrollTo({
      x: Math.max(0, (currentStartIndex + .5) * GAP - width / 2), animated: false,
    });
  }, [width, currentStartIndex, leg.id]);
  const group = candidates.filter(candidate => candidate.currentStopSequence === groupSequence);
  return <View style={styles.wrapper}>
    <Text style={styles.hint}>{stops[0]?.name} → {leg.to.name} 방향 · 차량은 API가 알려준 정류장 기준 위치에 표시해요.</Text>
    <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator onLayout={event => setWidth(event.nativeEvent.layout.width)}>
      <View style={{ width: stops.length * GAP, height: 152 }}>
        <View style={[styles.rail, { left: GAP / 2, width: Math.max(0, (stops.length - 1) * GAP), backgroundColor: color }]} />
        {stops.map((stop, index) => {
          const vehicles = candidates.filter(candidate => candidate.currentStopSequence === stop.serviceSequence
            && candidate.currentStopId === stop.providerStopId);
          const vehicle = vehicles.find(item => item.id === focusedId) ?? vehicles.find(item => item.id === selectedId) ?? vehicles[0];
          const selected = vehicle?.id === selectedId;
          const focused = vehicle?.id === focusedId;
          return <View key={`${stop.serviceSequence}:${stop.providerStopId}`} style={[styles.column, { left: index * GAP }]}>
            {vehicle && <Pressable accessibilityRole="button"
              accessibilityLabel={vehicles.length > 1 ? `${stop.name} 기준 버스 ${vehicles.length}대 선택 목록` : `${vehicle.vehicleNumber} 버스 선택`}
              accessibilityState={{ selected }} onPress={() => vehicles.length > 1
                ? setGroupSequence(groupSequence === stop.serviceSequence ? null : stop.serviceSequence) : onPress(vehicle.id)}
              style={styles.marker}>
              <Text style={[styles.number, { borderColor: selected || focused ? color : palette.border, color: selected ? color : palette.ink }]} numberOfLines={1}>
                {selected ? '✓ ' : ''}{vehicle.vehicleNumber}{vehicles.length > 1 ? ` · ${vehicles.length}대` : ''}
              </Text>
              <VehicleAsset mode="BUS" color={color} width={84} />
            </Pressable>}
            <View style={[styles.dot, { borderColor: color, backgroundColor: index === boardIndex ? color : '#FFF' }]} />
            <Text style={[styles.stopName, index === boardIndex && { color, fontWeight: '800' }]} numberOfLines={2}>{stop.name}</Text>
            {index === boardIndex && <Text style={[styles.role, { color }]}>승차</Text>}
            {stop.serviceSequence === leg.to.serviceSequence && <Text style={styles.role}>하차</Text>}
          </View>;
        })}
      </View>
    </ScrollView>
    <Text style={styles.hint}>30초마다 조회해요. 정류장 사이의 정확한 위치와 도착 시각은 이 표시만으로 확정할 수 없어요.</Text>
    {group.length > 1 && <View style={styles.group}>
      <Text style={styles.hint}>같은 정류장 기준 버스 {group.length}대 · 탈 차량을 고르세요.</Text>
      <View style={styles.chips}>{group.map(vehicle => <Pressable key={vehicle.id} accessibilityRole="button"
        accessibilityLabel={`${vehicle.vehicleNumber} 버스 선택`} accessibilityState={{ selected: vehicle.id === selectedId }}
        onPress={() => onPress(vehicle.id)} style={[styles.chip, { borderColor: vehicle.id === focusedId || vehicle.id === selectedId ? color : palette.border }]}>
        <Text style={styles.chipText}>{vehicle.id === selectedId ? '✓ ' : ''}{vehicle.vehicleNumber}</Text>
        <VehicleAsset mode="BUS" color={color} width={72} />
      </Pressable>)}</View>
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  wrapper: { gap: 10 },
  hint: { color: palette.muted, fontSize: 11, lineHeight: 17 },
  rail: { position: 'absolute', top: 64, height: 3, borderRadius: 2, opacity: .55, pointerEvents: 'none' },
  column: { position: 'absolute', width: GAP, top: 0, height: 152, alignItems: 'center' },
  marker: { position: 'absolute', top: 0, gap: 3, alignItems: 'center' },
  number: { backgroundColor: '#FFF', borderWidth: 1, borderRadius: 8, fontSize: 10, fontWeight: '800', maxWidth: GAP - 8, paddingHorizontal: 5, paddingVertical: 3 },
  dot: { position: 'absolute', top: 59, width: 13, height: 13, borderRadius: 7, borderWidth: 3 },
  stopName: { marginTop: 84, color: palette.muted, fontSize: 11, lineHeight: 16, textAlign: 'center', minHeight: 32, paddingHorizontal: 6 },
  role: { color: palette.ink, fontSize: 10, fontWeight: '700' },
  group: { gap: 10, padding: 10, borderWidth: 1, borderColor: palette.border, borderRadius: 10, backgroundColor: '#F7F9F7' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { padding: 6, borderWidth: 1, borderRadius: 9, backgroundColor: '#FFF', gap: 4, alignItems: 'center' },
  chipText: { color: palette.ink, fontSize: 11, fontWeight: '700' },
});
