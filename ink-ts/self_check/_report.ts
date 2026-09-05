/**
 * 自检门禁报告模型与矩阵渲染。
 */

export interface GateResult {
  key: string;
  label: string;
  command: string;
  passed: boolean;
  seconds: number;
  summary: string;
  tail: string[];
}

export function renderMatrix(results: readonly GateResult[]): string {
  const rows = results.map((r) => {
    const status = r.passed ? 'PASS' : 'FAIL';
    const time = `${r.seconds.toFixed(1)}s`;
    const summary = r.summary.length > 78 ? `${r.summary.slice(0, 75)}…` : r.summary;
    return `| ${status} | ${r.label} | ${time} | ${summary} |`;
  });
  const header = '| 状态 | 门禁 | 耗时 | 摘要 |';
  const sep = '|---|---|---|---|';
  return [header, sep, ...rows].join('\n');
}

export function summaryOf(result: GateResult): string {
  return `${result.passed ? 'PASS' : 'FAIL'} ${result.label}（${result.seconds.toFixed(1)}s）：${result.summary}`;
}
