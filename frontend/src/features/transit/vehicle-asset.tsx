import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

const assets = {
  SUBWAY: { body: require('../../../assets/vehicles/train-body.svg'), stripe: require('../../../assets/vehicles/train-stripe.svg') },
  BUS: { body: require('../../../assets/vehicles/bus-body.svg'), stripe: require('../../../assets/vehicles/bus-stripe.svg') },
};

export function VehicleAsset({ mode, color, direction = 1, width = 80 }: {
  mode: 'SUBWAY' | 'BUS'; color: string; direction?: 1 | -1; width?: number;
}) {
  const source = assets[mode];
  return <View style={{ width, height: width * 44 / 112, transform: [{ scaleX: direction }], pointerEvents: 'none' }}>
    <Image source={source.body} contentFit="contain" style={StyleSheet.absoluteFill} accessible={false} />
    <Image source={source.stripe} tintColor={color} contentFit="contain" style={StyleSheet.absoluteFill} accessible={false} />
  </View>;
}
