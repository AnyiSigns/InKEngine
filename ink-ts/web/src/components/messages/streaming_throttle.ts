/**
 * 流式绘制节流：内容原样保留（事件序/条目不合并），仅限制重绘频率。
 *
 * 流式 token 逐片到达时组件高频重渲——节流面 = 展示值（显示上一帧
 * 内容至间隔到达），终值（renderer 每次拿到的完整 content）不变，
 * 事件序与条目结构零扰动。实现为固定节拍（throttle 而非 debounce）：
 * 首个变化即排期，后续变化不重置计时（长流式期间仍周期性落盘画面）；
 * 间隔 0 = 关闭节流（测试直绘）。
 */

import { useEffect, useRef, useState } from 'react';

export const DEFAULT_STREAM_THROTTLE_MS = 60;

/** 展示面节流值：value 变化后按固定节拍重绘（尾部强制刷新）。 */
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [display, setDisplay] = useState(value);
  const latestRef = useRef(value);
  const displayRef = useRef(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  latestRef.current = value;

  useEffect(() => {
    if (timerRef.current !== null) return;
    if (displayRef.current === latestRef.current) return;
    if (intervalMs <= 0) {
      displayRef.current = latestRef.current;
      setDisplay(latestRef.current);
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      displayRef.current = latestRef.current;
      setDisplay(latestRef.current);
    }, intervalMs);
  }, [value, intervalMs]);

  // 卸载清理（避免卸载后 setState）
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return display;
}
