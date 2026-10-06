export type Place = Readonly<{
  provider: 'kakao';
  providerPlaceId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  kind: 'PLACE' | 'ADDRESS';
  category?: string;
}>;
