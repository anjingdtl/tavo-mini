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

/**
 * 将页面绝对坐标映射为离散滑块值。
 * 轨道尚未完成 measure 时返回 null；调用方必须等待真实几何信息，不能以
 * 默认坐标 { x: 0, width: 1 } 进行猜测，否则首次点击会被错误夹到最大值。
 */
export function valueFromTrackPosition(
  pageX: number,
  geometry: { x: number; width: number },
  min: number,
  max: number,
  step = 1,
): number | null {
  if (!Number.isFinite(geometry.width) || geometry.width <= 0) return null;
  const range = Math.max(1, max - min);
  const fraction = clamp((pageX - geometry.x) / geometry.width, 0, 1);
  const raw = min + fraction * range;
  const stepped = Math.round(raw / step) * step;
  return clamp(stepped, min, max);
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
  const geometryRef = useRef<{ x: number; width: number }>({ x: 0, width: 0 });
  const onChangeRef = useRef(onChange);
  const disabledRef = useRef(disabled);
  onChangeRef.current = onChange;
  disabledRef.current = disabled;
  const [layoutWidth, setLayoutWidth] = useState(0);

  const range = Math.max(1, max - min);

  const updateFromPageX = (pageX: number) => {
    const nextValue = valueFromTrackPosition(
      pageX,
      geometryRef.current,
      min,
      max,
      step,
    );
    if (nextValue !== null) onChangeRef.current(nextValue);
  };

  const measureTrack = (initialPageX?: number) => {
    const node = trackRef.current;
    if (!node) return;
    node.measure((_ox, _oy, w, _h, trackPageX) => {
      geometryRef.current = { x: trackPageX, width: w };
      if (w > 0 && w !== layoutWidth) setLayoutWidth(w);
      // measure 为异步回调；在这里才使用首次点击坐标，确保不会跳到最大值。
      if (initialPageX !== undefined) updateFromPageX(initialPageX);
    });
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabledRef.current,
      onMoveShouldSetPanResponder: () => !disabledRef.current,
      onPanResponderGrant: event => {
        measureTrack(event.nativeEvent.pageX);
      },
      onPanResponderMove: event => {
        updateFromPageX(event.nativeEvent.pageX);
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
        onLayout={event => {
          setLayoutWidth(event.nativeEvent.layout.width);
          measureTrack();
        }}
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
