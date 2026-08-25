/**
 * 图表渲染器（P4.8）+ 生成端（P4.7）+ 导出 + 降级渲染断言。
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MessageList } from '@/components/message_list';
import { ChartEntry } from '@/components/messages/chart_entry';
import type { InkChartMessage } from '@/shared/session/types';
import {
  buildChartSpec,
  chartSpecFromDataUrl,
  chartSpecToDataUrl,
  type ChartSpec,
} from '@/shared/charts/chart_spec';

function lineMessage(): InkChartMessage {
  return {
    id: 'c-line',
    kind: 'chart',
    spec: { type: 'line', title: '趋势', labels: ['一', '二', '三'], series: [{ name: 'A', values: [1, 2, 3] }] },
  };
}

function barMessage(): InkChartMessage {
  return {
    id: 'c-bar',
    kind: 'chart',
    spec: { type: 'bar', title: '分布', labels: ['x', 'y'], series: [{ name: 'A', values: [4, 6] }] },
  };
}

function pieMessage(): InkChartMessage {
  return {
    id: 'c-pie',
    kind: 'chart',
    spec: { type: 'pie', title: '占比', labels: ['a', 'b', 'c'], series: [{ name: 'A', values: [3, 4, 5] }] },
  };
}

function scatterMessage(): InkChartMessage {
  return {
    id: 'c-scatter',
    kind: 'chart',
    spec: { type: 'scatter', title: '散点', labels: [], series: [], points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
  };
}

describe('chart 渲染器：会话流内嵌 SVG 渲染', () => {
  it('折线图内嵌渲染（svg 节点 + 折线类名）', () => {
    const { container } = render(<MessageList bindValue={[lineMessage()]} />);
    expect(screen.getAllByText('趋势').length).toBeGreaterThan(0);
    expect(container.querySelector('svg.ink-chart-svg')).toBeInTheDocument();
    expect(container.querySelector('polyline.ink-chart-line')).toBeInTheDocument();
  });

  it('柱状图内嵌渲染（svg 节点 + 柱类名）', () => {
    const { container } = render(<MessageList bindValue={[barMessage()]} />);
    expect(container.querySelector('rect.ink-chart-bar')).toBeInTheDocument();
  });

  it('饼图内嵌渲染（svg 节点 + 扇区类名）', () => {
    const { container } = render(<MessageList bindValue={[pieMessage()]} />);
    expect(container.querySelector('path.ink-chart-pie')).toBeInTheDocument();
  });

  it('散点图内嵌渲染（svg 节点 + 散点类名）', () => {
    const { container } = render(<MessageList bindValue={[scatterMessage()]} />);
    expect(container.querySelector('circle.ink-chart-scatter')).toBeInTheDocument();
  });
});

describe('chart 导出：触发断言', () => {
  it('点击导出触发回调并产出 SVG 字符串', async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    render(<ChartEntry message={lineMessage()} onExport={onExport} />);
    await user.click(screen.getByText('导出'));
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onExport.mock.calls[0][0]).toContain('<svg');
    expect(onExport.mock.calls[0][1].type).toBe('line');
  });
});

describe('chart 生成端（P4.7）：同源同 spec', () => {
  it('结构化数据 + 指令 → chart spec（类型推断正确）', () => {
    const spec = buildChartSpec(
      { labels: ['一', '二', '三'], series: [{ name: 'A', values: [1, 2, 3] }] },
      { type: 'line' },
    );
    expect(spec.type).toBe('line');
    expect(spec.series[0].values).toEqual([1, 2, 3]);
  });

  it('散点经 points 生成并序列化为数据 URL 可回解', () => {
    const spec: ChartSpec = buildChartSpec({
      type: 'scatter',
      labels: [],
      series: [],
      points: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
    });
    const url = chartSpecToDataUrl(spec);
    expect(url.startsWith('data:application/json;base64,')).toBe(true);
    expect(chartSpecFromDataUrl(url)?.type).toBe('scatter');
  });
});

describe('chart 降级渲染：缺数据/非法 spec 不崩', () => {
  it('spec 缺失降级占位', () => {
    const broken = { id: 'c-x', kind: 'chart', spec: undefined } as unknown as InkChartMessage;
    const { container } = render(<MessageList bindValue={[broken]} />);
    expect(screen.getByText(/数据不可用/)).toBeInTheDocument();
    expect(container.querySelector('svg.ink-chart-svg')).not.toBeInTheDocument();
  });

  it('非法类型降级占位', () => {
    const broken = {
      id: 'c-y',
      kind: 'chart',
      spec: { type: 'unknown', labels: [], series: [] },
    } as unknown as InkChartMessage;
    render(<MessageList bindValue={[broken]} />);
    expect(screen.getByText(/数据不可用/)).toBeInTheDocument();
  });
});
