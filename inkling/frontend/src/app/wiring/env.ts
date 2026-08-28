/**
 * 演示态守卫：mock 夹具仅在 dev 或显式开启 VITE_USE_FIXTURE 时生效。
 * 生产构建（非 dev 且未开开关）回落真后端/空态，不内嵌演示夹具。
 */

export function isFixtureMode(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_USE_FIXTURE === 'true';
}
