/**
 * 自指元工具的结果文本与 Python repr 口径工具（core/self_tools.py 的
 * ``_json`` / repr 形态移植）。
 *
 * 全部工具输出为 JSON 文本（工具流水线结果契约）：``_json`` 等价
 * ``json.dumps(data, ensure_ascii=False)``——保持对象插入序（与 Python
 * dict 顺序同构）、不做键排序、不转义非 ASCII；``pyRepr`` 等价 Python
 * 内建 ``repr()``（错误文案呈现用，字符串单引号、None → 'None'）。
 */

// 族收敛：pyRepr 近似拷贝的统一迁移点 = core/py_repr.ts 单源（已就绪）；
// 本实现与 rules/_py.ts pyRepr 语义一致。后续批次可按批迁移，本文件暂不
// 改实现。
/** Python repr() 口径（错误文案呈现；字符串单引号、None → 'None'）。 */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record).map((key) => `${pyRepr(key)}: ${pyRepr(record[key])}`);
    return `{${parts.join(', ')}}`;
  }
  return String(value);
}

/** 结果文本序列化（json.dumps(ensure_ascii=False) 口径：插入序、不转义）。 */
export function _json(data: Record<string, unknown>): string {
  return JSON.stringify(data);
}
