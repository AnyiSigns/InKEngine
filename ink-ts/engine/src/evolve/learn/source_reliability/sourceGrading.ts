/**
 * 来源分级常量（单一事实来源：知识/检索/记忆共享）。
 *
 * 来源分级顺序（web < dialog < model < user）与默认可信度基准在本模块
 * 单点定义——knowledge_set（知识条目来源）、retrieval（检索 chunk 分级）、
 * memory（记忆来源权重）三侧复用同一常量，杜绝多份定义漂移：可信度由
 * 使用方按此基准定值，来源分级档与默认可信度互为映射依据。
 */

// 来源分级（web < dialog < model < user：可信度由使用方按此基准定值）
export const SOURCE_WEB = 'web';
export const SOURCE_DIALOG = 'dialog';
export const SOURCE_MODEL = 'model';
export const SOURCE_USER = 'user';

// 来源分级顺序（升序：web 最低；合并排序/分级映射的次序依据）
export const SOURCE_ORDER: readonly string[] = [
  SOURCE_WEB,
  SOURCE_DIALOG,
  SOURCE_MODEL,
  SOURCE_USER,
];

// 来源 → 默认可信度基准（web 最低——防 web 注入污染知识集；经落库
// 路径（from_dict）的条目按此分级定值，显式声明的可信度优先）
export const _SOURCE_CREDIBILITY: Readonly<Record<string, number>> = {
  [SOURCE_WEB]: 0.3,
  [SOURCE_DIALOG]: 0.6,
  [SOURCE_MODEL]: 0.7,
  [SOURCE_USER]: 0.9,
};

/**
 * 按来源取默认可信度（未知来源 = 模型级，保守不激进）。
 */
export function default_credibility(source: string): number {
  return _SOURCE_CREDIBILITY[source] ?? _SOURCE_CREDIBILITY[SOURCE_MODEL]!;
}

/**
 * credibility → 来源分级档（单源函数，检索/知识注入三路径共用）。
 *
 * 复用 _SOURCE_CREDIBILITY 分级基准：按可信度由高到低匹配，首个
 * credibility ≥ 档位的来源即为该条目分级（同源同权，杜绝多路径漂移）。
 * 均不匹配最低档时回退 web。
 */
export function grade_level_for_credibility(credibility: number): string {
  const ranking = Object.entries(_SOURCE_CREDIBILITY).sort(
    (left, right) => right[1]! - left[1]!,
  );
  for (const [source, weight] of ranking) {
    if (credibility >= weight! - 1e-9) return source;
  }
  return SOURCE_WEB;
}
