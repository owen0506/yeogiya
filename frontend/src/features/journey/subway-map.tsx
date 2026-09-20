import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { lineColor, networkSegments } from '../stations/network';
import { stations, type Station } from '../stations/stations';
import { palette, TrainIcon, ui } from './journey-ui';
import type { JourneyRoute } from './route-service';

type Point = { name: string; x: number; y: number };
// 주요역 중심 간략도. 생략된 역은 노선의 전체 역 목록에서 선택할 수 있습니다.
const ring: Point[] = [
  { name: '시청', x: 310, y: 160 }, { name: '을지로3가', x: 435, y: 160 }, { name: '동대문역사문화공원', x: 575, y: 160 },
  { name: '왕십리', x: 725, y: 215 }, { name: '성수', x: 800, y: 290 }, { name: '건대입구', x: 855, y: 365 },
  { name: '잠실', x: 855, y: 485 }, { name: '잠실새내', x: 770, y: 540 }, { name: '종합운동장', x: 660, y: 540 },
  { name: '삼성', x: 560, y: 540 }, { name: '선릉', x: 465, y: 540 }, { name: '역삼', x: 370, y: 540 },
  { name: '강남', x: 275, y: 540 }, { name: '교대', x: 195, y: 485 }, { name: '사당', x: 120, y: 410 },
  { name: '신림', x: 120, y: 325 }, { name: '신도림', x: 120, y: 240 }, { name: '당산', x: 120, y: 160 },
  { name: '합정', x: 160, y: 85 }, { name: '홍대입구', x: 270, y: 85 }, { name: '신촌', x: 370, y: 85 },
  { name: '충정로', x: 410, y: 125 },
];

function Stroke({ a, b, color, width = 5, opacity = 1 }: { a: Point; b: Point; color: string; width?: number; opacity?: number }) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return <View pointerEvents="none" style={{ position: 'absolute', left: (a.x + b.x) / 2 - Math.hypot(dx, dy) / 2, top: (a.y + b.y) / 2 - width / 2, width: Math.hypot(dx, dy), height: width, borderRadius: width, backgroundColor: color, opacity, transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }] }} />;
}

export function SubwayMap({ line, departure, arrival, route, onSelect }: { line: string; departure: Station | null; arrival: Station | null; route: JourneyRoute | null; onSelect: (station: Station) => void }) {
  const [width, setWidth] = useState(960);
  const [zoom, setZoom] = useState(1);
  const primary = networkSegments.find((segment) => segment.line === line && !segment.branch)!;
  const points = line === '2호선' ? ring : primary.names.map((name, index): Point => {
    const row = Math.floor(index / 7), column = index % 7;
    return { name, x: 100 + (row % 2 ? 6 - column : column) * 130, y: 100 + row * 90 };
  });
  const color = lineColor(line);
  const scale = Math.max(.66, Math.min(width / 1000, 1.3)) * zoom;
  const canvasHeight = line === '2호선' ? 650 : Math.max(520, 180 + Math.floor((points.length - 1) / 7) * 90);
  const faintLines = [
    { color: '#EF8740', points: [{ x: 385, y: 0 }, { x: 435, y: 160 }, { x: 480, y: 290 }, { x: 410, y: 410 }, { x: 195, y: 485 }, { x: 205, y: 650 }] },
    { color: '#36A5D5', points: [{ x: 620, y: 0 }, { x: 575, y: 160 }, { x: 355, y: 255 }, { x: 265, y: 300 }, { x: 120, y: 410 }, { x: 25, y: 470 }] },
    { color: '#9165CD', points: [{ x: 0, y: 280 }, { x: 220, y: 280 }, { x: 310, y: 160 }, { x: 435, y: 195 }, { x: 575, y: 160 }, { x: 725, y: 215 }, { x: 990, y: 165 }] },
    { color: '#B79D61', points: [{ x: 0, y: 155 }, { x: 120, y: 160 }, { x: 220, y: 400 }, { x: 410, y: 410 }, { x: 565, y: 455 }, { x: 660, y: 540 }, { x: 950, y: 590 }] },
  ];
  const routeNames = new Set(route?.steps.filter((step) => step.station.line === line).map((step) => step.station.name));
  return <View style={styles.container} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
    <View style={styles.mapHeader}><View style={ui.row}><View style={[styles.lineCircle, { backgroundColor: color }]}><Text style={{ color: '#FFF', fontWeight: '700', fontSize: 12 }}>{line.replace('호선', '').replace('신분당선', '신')}</Text></View><Text style={[ui.text, { fontWeight: '700' }]}>{line === '2호선' ? '서울을 한 바퀴, 2호선' : `${line} 노선 살펴보기`}</Text></View><Text style={ui.muted}>역을 눌러 선택하세요</Text></View>
    <ScrollView horizontal contentContainerStyle={{ minWidth: '100%', justifyContent: 'center' }} showsHorizontalScrollIndicator={false}>
      <View style={{ width: 1000 * scale, height: canvasHeight * scale, overflow: 'hidden' }}>
        <View style={{ width: 1000, height: canvasHeight, transform: [{ scale }], transformOrigin: 'top left' }}>
          {line === '2호선' && <>
            <View style={styles.parkOne} /><View style={styles.parkTwo} />
            <View style={styles.river}><Text style={styles.riverText}>한  강  ·  H A N   R I V E R</Text></View>
            <Text style={[styles.district, { left: 470, top: 60 }]}>종로구</Text><Text style={[styles.district, { left: 500, top: 230 }]}>중구</Text><Text style={[styles.district, { left: 680, top: 310 }]}>성동구</Text><Text style={[styles.district, { left: 480, top: 600 }]}>강남구</Text><Text style={[styles.district, { left: 860, top: 580 }]}>송파구</Text>
            {faintLines.map((path, i) => path.points.slice(1).map((point, j) => <Stroke key={`${i}-${j}`} a={{ ...path.points[j], name: '' }} b={{ ...point, name: '' }} color={path.color} width={3} opacity={.25} />))}
          </>}
          {points.slice(1).map((point, index) => <Stroke key={`edge-${index}`} a={points[index]} b={point} color={color} width={line === '2호선' ? 6 : 5} />)}
          {line === '2호선' && <Stroke a={points[points.length - 1]} b={points[0]} color={color} width={6} />}
          {points.map((point) => {
            const station = stations.find((item) => item.name === point.name && item.line === line)!;
            const isFrom = departure?.id === station.id, isTo = arrival?.id === station.id;
            const inRoute = routeNames.has(station.name);
            const transfer = stations.filter((item) => item.name === station.name).length > 1;
            return <Pressable key={point.name} accessibilityRole="button" accessibilityLabel={`노선도 ${point.name} ${line}`} onPress={() => onSelect(station)} style={[styles.station, { left: point.x - 43, top: point.y - 20 }]}>
              {(isFrom || isTo) && <View style={[styles.marker, { backgroundColor: isTo ? palette.green : palette.ink }]}><Text style={styles.markerText}>{isFrom ? '출발' : '도착'}</Text></View>}
              <View style={[styles.stationDot, { borderColor: color, width: transfer ? 16 : 11, height: transfer ? 16 : 11 }, (isFrom || isTo || inRoute) && { backgroundColor: color, borderColor: '#FFF', boxShadow: `0 0 0 3px ${color}` }]} />
              <Text numberOfLines={2} style={[styles.stationLabel, (isFrom || isTo) && { color: palette.green, fontWeight: '800' }]}>{point.name}</Text>
            </Pressable>;
          })}
          {line === '2호선' && <View style={styles.mapBrand}><TrainIcon size={30} /><Text style={{ fontSize: 23, color: '#3E6752', fontWeight: '700', letterSpacing: -1 }}>여기야</Text><Text style={{ fontSize: 11, color: '#8BA193', marginTop: 3 }}>당신의 편안한 한 정거장</Text></View>}
        </View>
      </View>
    </ScrollView>
    <View style={styles.mapFooter}><View style={{ flex: 1 }}><Text style={ui.muted}>○ 일반역   ◉ 환승역</Text><Text style={[ui.muted, { fontSize: 10 }]}>주요 구간 간략도 · 실제 위치·거리와 다름{line === '2호선' ? ' · 일부 역 생략' : ''}</Text></View><View style={styles.zoom}><Pressable accessibilityRole="button" accessibilityLabel="노선도 축소" disabled={zoom <= .8} onPress={() => setZoom((value) => Math.max(.8, value - .2))} style={styles.zoomButton}><Text style={{ fontSize: 21 }}>−</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="노선도 기본 크기" onPress={() => setZoom(1)} style={styles.zoomButton}><Text style={{ fontSize: 11 }}>{Math.round(zoom * 100)}%</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="노선도 확대" disabled={zoom >= 1.8} onPress={() => setZoom((value) => Math.min(1.8, value + .2))} style={styles.zoomButton}><Text style={{ fontSize: 21 }}>+</Text></Pressable></View></View>
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
