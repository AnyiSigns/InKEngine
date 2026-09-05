/**
 * Python 标量语义公共工具（repr/str/truthy/type 名）——core 单源。
 *
 * 收敛目标：rules/_py.ts / ui_schema.uiSchemaSupport / environments._repr /
 * tool_vetting._types / builder._types / link_validator / pool_governance /
 * review_card / growth._helpers / self_tools._json /
 * knowledge_signals._types 等近似拷贝统一迁移点（镜像 Python 标量语义，
 * 数据面限定 JSON 兼容值）。pyRepr/pyStr/pyTruthy 按 rules/_py.ts（本族最
 * 完整实现）口径定义；typeName/typeNameOf 直连 core/json.typeName（该处已
 * 是 type(x).__name__ 的既有单源）。
 *
 * 各族本地实现存在行为微差异（如字符串转义、对象递归、NaN 真值等），
 * 迁移须逐批核对语义，见各文件头注；声明式工具域（declarative_spec /
 * _gates 的 _pyRepr）已迁至本模块共享。
 */

import { isRecord, typeName, typeName as typeNameOf } from './json.js';

export { typeName, typeNameOf };

/** Python repr()：消息文案与声明错误文案的统一形态（None/单引号/True/False）。 */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (isRecord(value)) {
    const parts = Object.entries(value).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`);
    return `{${parts.join(', ')}}`;
  }
  return String(value);
}

/** Python str()：entity_id 等留痕字段的字符串化（None → "None"）。 */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

/** Python 真值语义（bool()）：空列表/空字典为假，其余 JSON 值按直觉。 */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}
