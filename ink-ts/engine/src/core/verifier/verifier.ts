/**
 * 验证器门控（VTM）：节点产出评审 + 违规驱动重做——verifier.py 移植。
 *
 * 背景（实验结论，tools/benchmarks/bench_confidence_head.py Q7/Q9，
 * 2026-08-30）：预测成败不可信（LLM 自评 p≥0.9 仍漏 19% 失败），评审产出
 * 才可信（验证器漏抓 3%，抓到 7/8 失败）；违规清单驱动定向重做 73% vs 盲
 * 重试 28%（+45%）——violations 是生成信号。
 *
 * 落点（引擎接线）：节点返回值携带保留键 VERIFY_KEY 声明评审规格
 * （{"task": str, "requirements": list[str], "entity_id": str|None}）——缺省
 * 不评审，既有图零行为变化。挂 output_verifier 后引擎对节点产出做评审；
 * 评审 fail → 违规清单写入 ctx.state[VERIFY_FEEDBACK_KEY] 后重做节点（有界，
 * 上限在引擎 RunOptions.verify_retry_limit），重做耗尽仍 fail → 抛
 * OutputVerificationError，执行器按节点失败收口。门控接线、反馈写入与重做
 * 次数属执行器职责，本模块只落评审协议、终败错误与评审输出解析。
 *
 * LLM 调用以 seam 接口表达（消息进、content 出，宿主注入统一协议），
 * core 不做真 IO。
 */

import { isRecord, type JsonRecord } from '../json.js';

/** 节点返回值保留键：声明评审规格（task/requirements/entity_id）；缺省不评审。 */
export const VERIFY_KEY = '__verify__';

/** 重做反馈键：违规清单写入 ctx.state，节点重跑时读取做定向修复。 */
export const VERIFY_FEEDBACK_KEY = '__verify_feedback__';

/** 评审入参（镜像 Python 关键字实参 node/output/spec）。 */
export interface VerifyOptions {
  node: string;
  output: JsonRecord;
  spec: JsonRecord;
}

/** 评审结果（镜像 Python 返回 dict {"pass": bool, "violations": [str, ...]}）。 */
export interface VerifyResult {
  pass: boolean;
  violations: string[];
}

/**
 * 产出评审器协议：对节点产出做验收判断（宿主注入——LLM 验证器/确定性
 * 检查）。结构化形状即契约：实现方只需提供同名 verify 方法即可注入。
 */
export interface OutputVerifier {
  verify(ctx: unknown, options: VerifyOptions): Promise<VerifyResult>;
}

/** 评审消息形态：LLM seam 的消息项（镜像 llm.messages.Message 的 role/content）。 */
export interface VerifierMessage {
  role: 'system' | 'user';
  content: string;
}

/** LLM seam：ainvoke 收消息序列、返回带 content 的结果对象（宿主注入协议）。 */
export interface VerifierLlm {
  ainvoke(messages: readonly VerifierMessage[]): Promise<{ content?: string | null }>;
}

/**
 * 产出验证终败（违规驱动重做耗尽）：按节点失败收口。
 * entity_id: 评审规格携带的实体归因（演化管线据此定向变异；
 * null = 无实体关联，仅留痕不变异）。
 */
export class OutputVerificationError extends Error {
  readonly entity_id: string | null;

  constructor(message: string, entity_id: string | null = null) {
    super(message);
    this.name = 'OutputVerificationError';
    this.entity_id = entity_id;
  }
}

/**
 * LLM 验证器：按评审规格对节点产出做硬性要求验收（复用统一 LLM seam）。
 * 评审提示拼装与 Python 逐字对齐；对 LLM 输出走 _parse_verdict 容错解析，
 * LLM 抛错原样上抛（Python 侧同样不捕获）。
 */
export class LLMOutputVerifier implements OutputVerifier {
  private readonly _llm: VerifierLlm;

  constructor(llm: VerifierLlm) {
    this._llm = llm;
  }

  async verify(_ctx: unknown, options: VerifyOptions): Promise<VerifyResult> {
    const { output, spec } = options;
    const rawRequirements = get(spec, 'requirements');
    const reqText = isTruthy(rawRequirements)
      ? iteratePy(rawRequirements)
          .map((r) => `- ${pyStr(r)}`)
          .join('\n')
      : '';
    const rawTask = get(spec, 'task');
    const task = isTruthy(rawTask) ? pyStr(rawTask) : '';
    const prompt =
      '给定任务、硬性要求与节点产出，判断产出是否通过验收。\n' +
      `任务：${task}\n` +
      `硬性要求：\n${reqText}\n` +
      `节点产出：\n${jsonDumps(output)}\n` +
      '输出严格 JSON：{"pass": true/false, "violations": ["违反了什么"]}\n' +
      '只输出 JSON。产出不满足任何硬性要求就 pass=false，不要宽容。';
    const result = await this._llm.ainvoke([
      { role: 'system', content: '你是验收评审器。' },
      { role: 'user', content: prompt },
    ]);
    return _parse_verdict(result.content || '');
  }
}

const UNPARSEABLE = '评审输出无法解析';

/**
 * 解析 LLM 评审输出为判决：先裁出首尾花括号之间的文本再整体解析（容忍
 * 散文/代码围栏夹带）；解析失败或缺席评审字段一律按 fail + 无法解析清单
 * 兜底（评审不可信 = 不放行）。解析边界逐点对齐 Python 实现。
 */
export function _parse_verdict(text: string): VerifyResult {
  const stripped = text.trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { pass: false, violations: [UNPARSEABLE] };
  }
  let data: unknown;
  try {
    data = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return { pass: false, violations: [UNPARSEABLE] };
  }
  if (!isRecord(data)) {
    return { pass: false, violations: [UNPARSEABLE] };
  }
  return {
    pass: isTruthy(get(data, 'pass')),
    violations: stringifyViolations(get(data, 'violations')),
  };
}

/** dict.get 口径取键：键缺席返回 undefined（Python 为 None，真值语义等价）。 */
function get(record: JsonRecord, key: string): unknown {
  return key in record ? record[key] : undefined;
}

/** Python 真值口径：None/undefined/False/0/''/空容器一律为假。 */
function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** Python 迭代口径：list→元素、str→逐字符、dict→键；真值但不可迭代按空处理。 */
function iteratePy(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return Array.from(value);
  if (isRecord(value)) return Object.keys(value);
  return [];
}

/** 违规清单 str() 化：falsy 一律空清单；元素按 Python str 口径渲染。 */
function stringifyViolations(raw: unknown): string[] {
  if (!isTruthy(raw)) return [];
  return iteratePy(raw).map(pyStr);
}

/** Python str() 口径的标量渲染（None→None、布尔大写）；复合值走 jsonDumps。 */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return jsonDumps(value);
}

/** 对齐 json.dumps(ensure_ascii=False) 的确定性序列化：保留键插入序与分隔空格。 */
function jsonDumps(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return `[${value.map(jsonDumps).join(', ')}]`;
  }
  const record = value as JsonRecord;
  const parts: string[] = [];
  for (const key of Object.keys(record)) {
    parts.push(`${JSON.stringify(key)}: ${jsonDumps(record[key] as unknown)}`);
  }
  return `{${parts.join(', ')}}`;
}
