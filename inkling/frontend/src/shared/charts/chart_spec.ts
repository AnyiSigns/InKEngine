/**
 * 图表规格（chart spec）——渲染器与生成端同源同规格。
 *
 * 规格是会话内嵌渲染与规格生成端之间的唯一契约：
 * 渲染器消费 ChartSpec 绘制折线/柱状/饼图/散点；生成端把结构化数据
 * 与分析指令收敛为 ChartSpec，并可序列化为数据 URL（可入会话附件、
 * 可导出）。布局与配色与渲染组件共享，避免两端漂移。
 */

export type ChartType = 'line' | 'bar' | 'pie' | 'scatter';

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartPoint {
  x: number;
  y: number;
  series?: string;
}

export interface ChartStyle {
  width?: number;
  height?: number;
  /** 显式配色（缺省回落共享调色板，导出脱离宿主也可重现） */
  palette?: string[];
}

export interface ChartSpec {
  type: ChartType;
  title?: string;
  /** 分类轴标签（折线/柱状/饼图切片名共用） */
  labels: Array<string | number>;
  /** 折线/柱状/饼图数据系列；饼图取首个系列为切片值 */
  series: ChartSeries[];
  /** 散点专用：x/y 点对（覆盖 labels+series 语义） */
  points?: ChartPoint[];
  style?: ChartStyle;
}

/** 共享调色板（渲染与导出一致，复用主题 token，不写死色值） */
export const CHART_PALETTE: string[] = [
  'var(--ink-accent)',
  'var(--ink-text-base)',
  'var(--ink-text-muted)',
  'var(--ink-text-faint)',
  'var(--ink-border-strong)',
  'var(--ink-bg-elevated)',
];

/** 非法/缺失规格的兜底（渲染器据此降级，不抛错） */
export function isRenderableSpec(spec: unknown): spec is ChartSpec {
  if (!spec || typeof spec !== 'object') return false;
  const candidate = spec as Partial<ChartSpec>;
  const types: ChartType[] = ['line', 'bar', 'pie', 'scatter'];
  if (!types.includes(candidate.type as ChartType)) return false;
  if (candidate.type === 'scatter') {
    return Array.isArray(candidate.points) && candidate.points.length > 0;
  }
  return (
    Array.isArray(candidate.labels) &&
    Array.isArray(candidate.series) &&
    candidate.series.length > 0
  );
}

export interface ChartBuildInput {
  type?: ChartType;
  title?: string;
  labels: Array<string | number>;
  series: ChartSeries[];
  points?: ChartPoint[];
  style?: ChartStyle;
}

/**
 * 生成端：结构化数据 + 分析指令 → chart spec。
 *
 * 指令（directive）可显式指定图形类型；缺省按数据形态推断：
 * 单系列且标签为类别倾向柱状，多系列倾向折线，散点需显式 points。
 */
export function buildChartSpec(input: ChartBuildInput, directive?: { type?: ChartType }): ChartSpec {
  const type = directive?.type ?? input.type ?? inferChartType(input);
  return {
    type,
    title: input.title,
    labels: input.labels,
    series: input.series,
    points: input.points,
    style: input.style,
  };
}

function inferChartType(input: ChartBuildInput): ChartType {
  if (input.points && input.points.length > 0) return 'scatter';
  if (input.series.length <= 1) return 'bar';
  return 'line';
}

/** 序列化为数据 URL（application/json），可入会话附件 / 可导出。 */
export function chartSpecToDataUrl(spec: ChartSpec): string {
  const json = JSON.stringify(spec);
  const encoded = typeof btoa !== 'undefined'
    ? btoa(unescape(encodeURIComponent(json)))
    : Buffer.from(json, 'utf-8').toString('base64');
  return `data:application/json;base64,${encoded}`;
}

/** 数据 URL 反解（生成端产物回到规格，供渲染器消费）。 */
export function chartSpecFromDataUrl(url: string): ChartSpec | null {
  const prefix = 'data:application/json;base64,';
  if (!url.startsWith(prefix)) return null;
  try {
    const json = typeof atob !== 'undefined'
      ? decodeURIComponent(escape(atob(url.slice(prefix.length))))
      : Buffer.from(url.slice(prefix.length), 'base64').toString('utf-8');
    const spec = JSON.parse(json) as ChartSpec;
    return isRenderableSpec(spec) ? spec : null;
  } catch {
    return null;
  }
}
