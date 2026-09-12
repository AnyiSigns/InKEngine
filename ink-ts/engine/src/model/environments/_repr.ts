/**
 * Python repr() 的窄面镜像（错误消息渲染注入值形态用）。
 *
 * 对齐 Py 文案的可读性口径：字符串带单引号、True/False、数组 []、dict {}，
 * 键按插入顺序（JSON 解析保留原顺序，与 Py dict 一致）。仅覆盖安装命令/
 * 运行时类非法值等错误消息会出现的形态，非通用序列化。
 */

// 族收敛：pyRepr 近似拷贝的统一迁移点 = core/py_repr.ts 单源（已就绪）。
// 本实现差异：字符串内 \\ ' 换行/回车/tab 转义；语义一致的可迁移族见
// rules/_py.ts 头注，后续批次可按批迁移（防行为漂移，本文件暂不改实现）。
/** Python repr() 窄面渲染（null→None；字符串引号/换行转义）。 */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') {
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    return `'${escaped}'`;
  }
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
