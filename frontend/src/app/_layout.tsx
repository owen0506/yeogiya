import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import Head from 'expo-router/head';

export default function RootLayout() {
  return <><Head><title>여기야 · 서울 지하철 하차 알림</title><meta name="description" content="원하는 지하철 노선과 내릴 역을 선택하고, 편안하게 이동하세요. 서울 지하철 경로 탐색과 하차 알림, 여기야." /></Head><StatusBar style="dark" /><Stack screenOptions={{ headerShown: false }} /></>;
}
