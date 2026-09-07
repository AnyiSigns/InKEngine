/**
 * 设计 token 全集测试（几何/节奏/层级单一事实源）。
 */

import {
  LINE_HEIGHT_BODY,
  MOTION,
  RADIUS_SCALE,
  SHADOW_LEVELS,
  SPACE_SCALE,
  TYPE_SCALE,
  Z_INDEX,
} from '@/renderer/designTokens';

describe('设计 token 全集', () => {
  it('间距 8pt 栅格：4/8/12/16/24/32', () => {
    expect(SPACE_SCALE).toEqual([4, 8, 12, 16, 24, 32]);
  });

  it('圆角 4/8/12；阴影 0/1/2', () => {
    expect(RADIUS_SCALE).toEqual([4, 8, 12]);
    expect(SHADOW_LEVELS).toEqual([0, 1, 2]);
  });

  it('动效 150-250ms 区间，进入 180ms ease-out', () => {
    expect(MOTION.fastMs).toBe(150);
    expect(MOTION.baseMs).toBe(180);
    expect(MOTION.slowMs).toBe(250);
    expect(MOTION.easing).toBe('ease-out');
  });

  it('字号 12/13/15/17/20，行高 1.6', () => {
    expect(TYPE_SCALE).toEqual([12, 13, 15, 17, 20]);
    expect(LINE_HEIGHT_BODY).toBe(1.6);
  });

  it('z-index 策略：正文 < 底栏 < 卡片 < 悬浮窗', () => {
    expect(Z_INDEX.base).toBeLessThan(Z_INDEX.bar);
    expect(Z_INDEX.bar).toBeLessThan(Z_INDEX.card);
    expect(Z_INDEX.card).toBeLessThan(Z_INDEX.floater);
  });
});
