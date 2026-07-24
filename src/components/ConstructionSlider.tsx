import React, { useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useThemeStore } from '../store/themeStore';

/**
 * 「构建」模块的输出预留滑块（SPEC §6.2）。
 *
 * 不引入原生 slider 依赖，使用纯 JS + PanResponder + measure 实现真机可拖拽。
 * 离散步进（默认 1%），受控组件。
 */
export interface ConstructionSliderProps {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  testID?: string;
}

function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

export const ConstructionSlider: React.FC<ConstructionSliderProps> = ({
  min,
  max,
  step = 1,
  value,
  onChange,
  disabled = false,
  testID,
}) => {
  const { theme } = useThemeStore();
  const trackRef = useRef<View>(null);
  // 通过 measure 拿到的轨道绝对起点与宽度（拖拽映射需要绝对坐标）。
  const geometryRef = useRef<{ x: number; width: number }>({ x: 0, width: 1 });
  const [layoutWidth, setLayoutWidth] = useState(0);

  const range = Math.max(1, max - min);

  const valueFromPageX = (pageX: number): number => {
    const { x, width } = geometryRef.current;
    const safeWidth = width > 0 ? width : 1;
    const fraction = clamp((pageX - x) / safeWidth, 0, 1);
    const raw = min + fraction * range;
    const stepped = Math.round(raw / step) * step;
    return clamp(stepped, min, max);
  };

  const measureTrack = () => {
    const node = trackRef.current;
    if (!node) return;
    node.measure((_ox, _oy, w, _h, pageX) => {
      geometryRef.current = { x: pageX, width: w };
      if (w > 0 && w !== layoutWidth) setLayoutWidth(w);
    });
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabled,
      onMoveShouldSetPanResponder: () => !disabled,
      onPanResponderGrant: event => {
        measureTrack();
        onChange(valueFromPageX(event.nativeEvent.pageX));
      },
      onPanResponderMove: event => {
        onChange(valueFromPageX(event.nativeEvent.pageX));
      },
      onPanResponderTerminationRequest: () => true,
    }),
  ).current;

  const fraction = range > 0 ? clamp((value - min) / range, 0, 1) : 0;
  const trackPx = layoutWidth > 0 ? layoutWidth : 0;
  const fillWidth = Math.round(fraction * trackPx);

  const trackStyle: ViewStyle = {
    backgroundColor: theme.colors.accentSoft,
    borderColor: theme.colors.border,
    opacity: disabled ? 0.5 : 1,
  };
  const fillStyle: ViewStyle = {
    backgroundColor: theme.colors.accent,
    width: fillWidth,
  };
  const thumbStyle: ViewStyle = {
    left: fillWidth,
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.surface,
  };

  return (
    <View
      testID={testID}
      accessibilityRole="adjustable"
      accessibilityValue={{ min, max, now: value }}
    >
      <View
        ref={trackRef}
        onLayout={event => setLayoutWidth(event.nativeEvent.layout.width)}
        style={[styles.track, trackStyle]}
        {...panResponder.panHandlers}
      >
        <View style={[styles.fill, fillStyle]} />
        <View style={[styles.thumb, thumbStyle]} />
      </View>
      <Text style={[styles.value, { color: theme.colors.textPrimary }]}>
        {value}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  track: {
    height: 36,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  fill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    borderRadius: 18,
    opacity: 0.35,
  },
  thumb: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 3,
    marginLeft: -12,
    top: 6,
  },
  value: {
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
    textAlign: 'right',
  },
});
