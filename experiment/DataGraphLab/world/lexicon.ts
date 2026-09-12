/**
 * 合成世界文法数据（义项与目标词表），无逻辑、无 IO。
 *
 * 义项是自然语言 ↔ 算子序列的唯一映射源：`render_recipe` 只能从此取词，
 * `parse_recipe`/启发式臂只能按它解析。硬约束（由 `lexicon_audit.ts` 强制）：
 * 每个 op/terminal ≥3 义项；任一义项不得是另一义项的连续子序列；同一义项若被
 * 多个算子共享，则这些算子的 `requires` 类型必须互斥（歧义必须类型可判定）。
 */

export const LEXICON: Readonly<Record<string, readonly string[]>> = {
  add3: ['加三', '增三', '添三'],
  mul2: ['翻倍', '乘以二', '加上自身'],
  sub1: ['减一', '降一', '去掉一'],
  neg: ['变号', '取负', '取反'],
  mod7: ['对七取余', '取模七', '模七求余'],
  upper: ['转大写', '全大写', '变大写'],
  lower: ['转小写', '全小写', '变小写'],
  // `取反` 与 `neg` 共享：`neg` 只收 Int、`reverse` 只收 Str，歧义由当前类型判定。
  reverse: ['反转', '倒序', '颠倒', '取反'],
  append_bang: ['加叹号', '补叹号', '末尾添叹'],
  str_len: ['取长度', '求长度', '算字符数'],
  cond_even: ['偶数则加一否则变双倍', '双数加一单数变双倍', '偶数加一奇数取双倍'],
  cond_long: ['够长则全换大写否则补问号', '长度不够补问号', '字符够多则全换大写'],
  submit: ['提交', '输出答案', '给出答案'],
  check_parity: ['核验奇偶', '检查奇偶', '校验奇偶性'],
  check_len: ['核验长度', '检查长度', '校验位数'],
};

/** 目标类别的义项词；只用于目标族指令渲染与特征，不含算子义项。 */
export const GOAL_LEX: Readonly<Record<string, readonly string[]>> = {
  parity: ['偶数', '奇数', '双数', '单数'],
  // gt 是严格 >；禁用“不小于”等 ≥ 语义词，避免污染标签。
  gt: ['大于', '超过', '多于', '高过'],
  len: ['长度', '位数', '字符数', '之间'],
};

/** 目标族句子模板；阈值/区间端点必须显式出现，否则数值通道无法还原目标。 */
export const GOAL_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  parity: ['结果是{parity_word}数', '让最终值为{parity_word}数', '输出应为{parity_word}数'],
  gt: ['结果大于{target}', '让最终值超过{target}', '把结果变成大于{target}的数'],
  len: ['长度在{min}到{max}之间', '字符数介于{min}和{max}', '总长度落在{min}与{max}之间'],
};

/** 合取目标的连接词池；不含任何算子义项。 */
export const GOAL_CONNECTORS: readonly string[] = ['，且', '并且', '同时'];

/** 配方族句子前缀池（以标点收尾，避免与前一个义项形成跨段 bigram）。 */
export const RECIPE_PREFIXES: readonly string[] = [
  '按顺序做：',
  '依次执行：',
  '照下面来：',
  '从起点出发，',
];

/** 配方族步骤连接词池（同样以标点分段，叉段由渲染器插入“，”）。 */
export const RECIPE_CONNECTORS: readonly string[] = ['接着', '然后', '再', '随后', '之后', '此时'];
