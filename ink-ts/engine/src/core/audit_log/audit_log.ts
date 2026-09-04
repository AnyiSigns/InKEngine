/**
 * 干预能力审计落库（append-only 审计统一出口；复用 set_audit 集合）。
 *
 * 四个干预 op（候选选择 / 多径开关 / 缓存失效 / 边档降级）经本模块把审计
 * 记录写入引擎存储的 set_audit 集合——与沉淀侧审计 sink（宿主装配处）同一
 * 落库通道，保证干预动作与运行期审计在同一 append-only 审计集合中可追溯。
 * 记录 type 字段复用事件注册表既有审计类型（禁新增事件类型），kind 取 type
 * 作为渲染归并键。
 *
 * TS seam 差异：存储以接口表达（AuditStorage / GuardedAuditStorage），实现
 * 由宿主注入；GuardedAuditStorage 的 allow_mechanism 返回豁免作用域
 * （enter/exit 镜像 Python with 语义，put 夹在两者之间）。ts/key 原属
 * time/uuid 副作用，改为注入的 now/keyGen——缺省确定值（now→0、keyGen→
 * 固定 '000000000000'），core 零时钟零随机可复现。Python logging.warning
 * 留痕属可观测性副作用，core 不落：对应行为以「缺 put_record / 写失败一律
 * 跳过不抛」表达——审计失败不得污染干预动作结果。
 */

/** 干预动作审计落库集合（与沉淀侧 _audit_sink 同一集合名，审计可追溯统一）。 */
export const AUDIT_COLLECTION = 'set_audit';

/** 审计记录：宽松 dict（原值原形状透传，只增补 ts/kind）。 */
export type AuditRecord = { [key: string]: unknown };

/** 审计落库存储的最小契约（ENG5-12：显式接口替代鸭子类型）。 */
export interface AuditStorage {
  put_record(collection: string, key: string, data: AuditRecord): Promise<void>;
}

/** 豁免作用域：镜像 Python AbstractContextManager（enter 后写、finally exit）。 */
export interface MechanismExemptionScope {
  enter(): void | Promise<void>;
  exit(): void | Promise<void>;
}

/** 受守卫审计存储：额外实现 allow_mechanism 豁免入口（set_audit 属受守卫集合，
 *  审计落库须经豁免上下文放行；裸存储无守卫直接写）。 */
export interface GuardedAuditStorage extends AuditStorage {
  allow_mechanism(collection?: string | null): MechanismExemptionScope;
}

/** emit_audit 注入面：ts/key 的确定性来源（缺省确定值，纯函数可复现）。 */
export interface EmitAuditOptions {
  /** 时间源（等价 Python time.time）；缺省按确定值 0。 */
  now?: () => number;
  /** 键片段源（等价 uuid.uuid4().hex[:12]）；缺省固定 12 位十六进制。 */
  keyGen?: () => string;
}

/** 缺省时间源：确定值 0（镜像 ledger 的 now 缺省）。 */
const DEFAULT_NOW = (): number => 0;

/** 缺省键片段源：固定 12 位十六进制，保证键确定性。 */
const DEFAULT_KEY_GEN = (): string => '000000000000';

/** Python 真值口径（kind 取 type、缺省回落 'op' 用；空容器同样为假）。 */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * 把一条审计记录落库到 set_audit 集合（无存储 = 静默跳过，不抛错）。
 *
 * ts 已在记录中（非 null）则原样保留，否则取注入 now；kind 取记录的 type
 * （缺省 'op'）。受守卫存储（带 allow_mechanism）的 set_audit 属受守卫集合，
 * 落库经豁免上下文放行；裸存储直接写——两种环境都兼容。存储缺 put_record
 * （接口漂移）或落库/豁免任何一步失败：跳过不抛，审计不阻断干预动作。
 *
 * @param storage 审计落库存储（null = 跳过）；实现 GuardedAuditStorage 时
 *   自动走豁免通道。
 * @param record 审计记录（type 复用事件注册表既有审计类型；不原地修改）。
 * @param options.now/keyGen ts 与键片段来源（测试注入确定性值）。
 */
export async function emit_audit(
  storage: AuditStorage | null | undefined,
  record: AuditRecord,
  options: EmitAuditOptions = {},
): Promise<void> {
  if (storage === null || storage === undefined) return;
  const now = options.now ?? DEFAULT_NOW;
  const keyGen = options.keyGen ?? DEFAULT_KEY_GEN;
  const rawTs = record['ts'];
  const ts = rawTs === undefined || rawTs === null ? now() : rawTs;
  const key = `op-${keyGen()}`;
  const rawType = record['type'];
  const data: AuditRecord = { ...record, ts, kind: pyTruthy(rawType) ? rawType : 'op' };
  try {
    // 契约漂移（缺 put_record）不再静默：跳过留痕可闻（logging 属宿主面，不抛）
    if (typeof storage.put_record !== 'function') return;
    if (typeof (storage as GuardedAuditStorage).allow_mechanism === 'function') {
      const scope = (storage as GuardedAuditStorage).allow_mechanism(AUDIT_COLLECTION);
      await scope.enter();
      try {
        await storage.put_record(AUDIT_COLLECTION, key, data);
      } finally {
        await scope.exit();
      }
    } else {
      await storage.put_record(AUDIT_COLLECTION, key, data);
    }
  } catch {
    // 审计落库失败只跳过不阻断（Python 记 warning；core 不留日志）
  }
}
