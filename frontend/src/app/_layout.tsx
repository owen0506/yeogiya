import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import Head from 'expo-router/head';

export default function RootLayout() {
  return <><Head><title>여기야 · 나만의 하차 알림</title><meta name="description" content="지하철 경로를 찾고 실제 탈 열차를 선택한 뒤 하차 알림을 설정하세요." /></Head><StatusBar style="dark" /><Stack screenOptions={{ headerShown: false }} /></>;
}
