import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { lineColor } from '../stations/network';
import { type Station } from '../stations/stations';
import { palette, TrainIcon, ui } from './journey-ui';
import type { JourneyRoute } from './route-service';
import { getMapLayout, type MapPoint } from './map-layout';

function Stroke({ a, b, color, width = 5, opacity = 1 }: { a: MapPoint; b: MapPoint; color: string; width?: number; opacity?: number }) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return <View pointerEvents="none" style={{ position: 'absolute', left: (a.x + b.x) / 2 - Math.hypot(dx, dy) / 2, top: (a.y + b.y) / 2 - width / 2, width: Math.hypot(dx, dy), height: width, borderRadius: width, backgroundColor: color, opacity, transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }] }} />;
}

export function SubwayMap({ line, departure, arrival, route, onSelect }: { line: string; departure: Station | null; arrival: Station | null; route: JourneyRoute | null; onSelect: (station: Station) => void }) {
  const [width, setWidth] = useState(960);
  const [zoom, setZoom] = useState(1);
  const layout = getMapLayout(line);
  const points = layout.stations;
  const color = lineColor(line);
  const scale = Math.max(.66, Math.min(width / 1000, 1.3)) * zoom;
  const canvasHeight = layout.height;
  const routeNames = new Set(route?.steps.filter((step) => step.station.line === line).map((step) => step.station.stationId));
  return <View style={styles.container} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
    <View style={styles.mapHeader}><View style={ui.row}><View style={[styles.lineCircle, { backgroundColor: color }]}><Text style={{ color: '#FFF', fontWeight: '700', fontSize: 12 }}>{line.replace('호선', '').replace('신분당선', '신')}</Text></View><Text style={[ui.text, { fontWeight: '700' }]}>{line === '2호선' ? '서울을 한 바퀴, 2호선' : `${line} 노선 살펴보기`}</Text></View><Text style={ui.muted}>역을 눌러 선택하세요</Text></View>
    <ScrollView horizontal contentContainerStyle={{ minWidth: '100%', justifyContent: 'center' }} showsHorizontalScrollIndicator={false}>
      <View style={{ width: 1000 * scale, height: canvasHeight * scale, overflow: 'hidden' }}>
        <View style={{ width: 1000, height: canvasHeight, transform: [{ scale }], transformOrigin: 'top left' }}>
          {line === '2호선' && <>
            <View style={styles.parkOne} /><View style={styles.parkTwo} />
            <View style={styles.river}><Text style={styles.riverText}>한  강  ·  H A N   R I V E R</Text></View>
          </>}
          {layout.connections.map((connection, connectionIndex) => connection.points.slice(1).map((point, index) => <View key={`edge-${connectionIndex}-${index}`}>
            <Stroke a={connection.points[index]} b={point} color={color} width={line === '2호선' ? 6 : 5} />
            {connection.oneWay && index === 0 && <Text pointerEvents="none" style={{ position: 'absolute', left: (connection.points[index].x + point.x) / 2 - 6, top: (connection.points[index].y + point.y) / 2 - 10, color, fontSize: 16, transform: [{ rotate: `${Math.atan2(point.y - connection.points[index].y, point.x - connection.points[index].x)}rad` }] }}>➤</Text>}
          </View>))}
          {points.map((point) => {
            const station = point.station;
            const isFrom = departure?.id === station.id, isTo = arrival?.id === station.id;
            const inRoute = routeNames.has(station.id);
            const transfer = station.lines.length > 1;
            return <Pressable key={station.id} accessibilityRole="button" accessibilityLabel={`노선도 ${station.name} ${station.lines.join('·')}`} onPress={() => onSelect(station)} style={[styles.station, { left: point.x - 43, top: point.y - 20 }]}>
              {(isFrom || isTo) && <View style={[styles.marker, { backgroundColor: isTo ? palette.green : palette.ink }]}><Text style={styles.markerText}>{isFrom ? '출발' : '도착'}</Text></View>}
              <View style={[styles.stationDot, { borderColor: color, width: transfer ? 16 : 11, height: transfer ? 16 : 11 }, (isFrom || isTo || inRoute) && { backgroundColor: color, borderColor: '#FFF', boxShadow: `0 0 0 3px ${color}` }]} />
              <Text numberOfLines={2} style={[styles.stationLabel, (isFrom || isTo) && { color: palette.green, fontWeight: '800' }]}>{station.name}</Text>
            </Pressable>;
          })}
          {line === '2호선' && <View style={styles.mapBrand}><TrainIcon size={30} /><Text style={{ fontSize: 23, color: '#3E6752', fontWeight: '700', letterSpacing: -1 }}>여기야</Text><Text style={{ fontSize: 11, color: '#8BA193', marginTop: 3 }}>당신의 편안한 한 정거장</Text></View>}
        </View>
      </View>
    </ScrollView>
    <View style={styles.mapFooter}><View style={{ flex: 1 }}><Text style={ui.muted}>○ 일반역   ◉ 환승역</Text><Text style={[ui.muted, { fontSize: 10 }]}>전체 역 연결도 · 실제 위치·거리와 다름{line === '6호선' ? ' · 화살표는 순환 방향' : ''}</Text></View><View style={styles.zoom}><Pressable accessibilityRole="button" accessibilityLabel="노선도 축소" disabled={zoom <= .8} onPress={() => setZoom((value) => Math.max(.8, value - .2))} style={styles.zoomButton}><Text style={{ fontSize: 21 }}>−</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="노선도 기본 크기" onPress={() => setZoom(1)} style={styles.zoomButton}><Text style={{ fontSize: 11 }}>{Math.round(zoom * 100)}%</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="노선도 확대" disabled={zoom >= 1.8} onPress={() => setZoom((value) => Math.min(1.8, value + .2))} style={styles.zoomButton}><Text style={{ fontSize: 21 }}>+</Text></Pressable></View></View>
  </View>;
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#F7F9F3', borderRadius: 20, borderWidth: 1, borderColor: '#E4EADF', overflow: 'hidden' },
  mapHeader: { paddingHorizontal: 24, paddingVertical: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', zIndex: 2 },
  lineCircle: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  river: { position: 'absolute', width: 1150, height: 74, left: -60, top: 343, backgroundColor: '#DBEEF1', transform: [{ rotate: '11deg' }], alignItems: 'center', justifyContent: 'center', borderWidth: 5, borderColor: '#EAF3F1' },
  riverText: { color: '#83ACB6', fontSize: 11, letterSpacing: 2 },
  parkOne: { position: 'absolute', left: 300, top: 235, width: 120, height: 78, borderRadius: 50, backgroundColor: '#E9EFDE', transform: [{ rotate: '-20deg' }] },
  parkTwo: { position: 'absolute', left: 670, top: 390, width: 80, height: 85, borderRadius: 40, backgroundColor: '#E6EFDC' },
  district: { position: 'absolute', color: '#B6C0AE', fontSize: 14, letterSpacing: 3 },
  station: { position: 'absolute', width: 86, height: 64, alignItems: 'center', paddingTop: 12, gap: 8 },
  stationDot: { borderWidth: 3, borderRadius: 10, backgroundColor: '#FFF', marginTop: 1 },
  stationLabel: { fontSize: 11, color: '#566157', textAlign: 'center', fontWeight: '500', backgroundColor: '#F7F9F3E8', paddingHorizontal: 3, borderRadius: 3 },
  marker: { position: 'absolute', top: -22, minWidth: 44, padding: 6, borderRadius: 7, alignItems: 'center', boxShadow: '0 3px 8px #223C2420' },
  markerText: { color: '#FFF', fontWeight: '700', fontSize: 11 },
  mapBrand: { position: 'absolute', left: 405, top: 285, alignItems: 'center', gap: 4, padding: 12, backgroundColor: '#F7F9F3D9', borderRadius: 18 },
  mapFooter: { paddingHorizontal: 22, paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  zoom: { flexDirection: 'row', backgroundColor: '#FFF', borderWidth: 1, borderColor: palette.border, borderRadius: 10 },
  zoomButton: { width: 40, height: 42, alignItems: 'center', justifyContent: 'center' },
});
