/**
 * 图表 SVG 序列化（导出端）：chart spec → 自包含 SVG 字符串。
 *
 * 与渲染组件共用配色与缩放口径；产物为独立 <svg>（内联显式色值，
 * 脱离宿主亦可重现），供导出数据 URL 与会话附件消费。
 */

import { CHART_PALETTE, type ChartSpec } from './chart_spec';

interface Box { width: number; height: number; pad: number; }

function box(spec: ChartSpec): Box {
  const width = spec.style?.width ?? 360;
  const height = spec.style?.height ?? 220;
  return { width, height, pad: 28 };
}

function palette(spec: ChartSpec): string[] {
  return spec.style?.palette ?? CHART_PALETTE;
}

function esc(text: string): string {
  return text.replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch] ?? ch));
}

export function chartSpecToSvgString(spec: ChartSpec): string {
  const { width, height, pad } = box(spec);
  const colors = palette(spec);
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const parts: string[] = [];

  if (spec.type === 'scatter' && spec.points && spec.points.length > 0) {
    const xs = spec.points.map((p) => p.x);
    const ys = spec.points.map((p) => p.y);
    const minX = Math.min(0, ...xs);
    const maxX = Math.max(1, ...xs);
    const minY = Math.min(0, ...ys);
    const maxY = Math.max(1, ...ys);
    const sx = (x: number) => pad + ((x - minX) / (maxX - minX)) * innerW;
    const sy = (y: number) => height - pad - ((y - minY) / (maxY - minY)) * innerH;
    for (const p of spec.points) {
      const c = colors[(spec.series.findIndex((s) => s.name === p.series) + colors.length) % colors.length];
      parts.push(`<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4" fill="${c}" class="ink-chart-scatter"/>`);
    }
  } else if (spec.type === 'pie') {
    const values = spec.series[0]?.values ?? [];
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const cx = width / 2;
    const cy = height / 2;
    const r = Math.min(innerW, innerH) / 2;
    let angle = -Math.PI / 2;
    values.forEach((v, i) => {
      const slice = (v / total) * Math.PI * 2;
      const x2 = cx + r * Math.cos(angle);
      const y2 = cy + r * Math.sin(angle);
      const x3 = cx + r * Math.cos(angle + slice);
      const y3 = cy + r * Math.sin(angle + slice);
      const large = slice > Math.PI ? 1 : 0;
      parts.push(`<path d="M ${cx} ${cy} L ${x2.toFixed(1)} ${y2.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x3.toFixed(1)} ${y3.toFixed(1)} Z" fill="${colors[i % colors.length]}" class="ink-chart-pie"/>`);
      angle += slice;
    });
  } else {
    // 折线 / 柱状 共用笛卡尔坐标
    const allValues = spec.series.flatMap((s) => s.values);
    const maxV = Math.max(1, ...allValues);
    const baseY = height - pad;
    const plotH = innerH;
    const yOf = (v: number) => baseY - (v / maxV) * plotH;

    if (spec.type === 'bar') {
      const groupCount = spec.labels.length;
      const slot = innerW / Math.max(1, groupCount);
      const barW = (slot * 0.7) / Math.max(1, spec.series.length);
      spec.labels.forEach((_label, gi) => {
        spec.series.forEach((s, si) => {
          const v = s.values[gi] ?? 0;
          const x = pad + gi * slot + si * barW + (slot - barW * spec.series.length) / 2;
          const y = yOf(v);
          parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${(baseY - y).toFixed(1)}" fill="${colors[si % colors.length]}" class="ink-chart-bar"/>`);
        });
      });
    } else {
      spec.series.forEach((s, si) => {
        const pts = s.values
          .map((v, i) => {
            const x = pad + (spec.labels.length <= 1 ? innerW / 2 : (i / (spec.labels.length - 1)) * innerW);
            return `${x.toFixed(1)},${yOf(v).toFixed(1)}`;
          })
          .join(' ');
        parts.push(`<polyline points="${pts}" fill="none" stroke="${colors[si % colors.length]}" stroke-width="2" class="ink-chart-line"/>`);
        s.values.forEach((v, i) => {
          const x = pad + (spec.labels.length <= 1 ? innerW / 2 : (i / (spec.labels.length - 1)) * innerW);
          parts.push(`<circle cx="${x.toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="2.5" fill="${colors[si % colors.length]}"/>`);
        });
      });
    }
  }

  const title = spec.title ? `<text x="${pad}" y="16" font-size="11" fill="var(--ink-text-base)">${esc(spec.title)}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="ink-chart-svg">${title}${parts.join('')}</svg>`;
}
