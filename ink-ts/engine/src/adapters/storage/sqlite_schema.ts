/**
 * 存储 schema 描述层（sqlite 三表 DDL 单一权威，storage_schema.py 移植）。
 *
 * sqlite 后端的 checkpoints/event_log/records 三表结构与 Python 完全同构
 * （跨语言对账：表名/列名/索引名一字不差）。checkpoint 状态 JSON 序列化
 * 入 TEXT 列；schema 变更即删库重建（不做迁移，启动期 _check_schema 自检
 * 旧表缺列并给出明确指令）。
 *
 * TS 形态差异：只落 sqlite 方言（postgres 方言与引擎侧后端一并延后），
 * 但表/列/索引描述保持与 Python _TABLES/_INDEXES 同构，方言演进只改映射。
 */

/** 方言列类型映射（sqlite 独有，源自 Python _DIALECT_TYPES["sqlite"]）。 */
const DIALECT_TYPES: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  json: 'TEXT',
  real: 'REAL',
  bigint: 'INTEGER',
  int: 'INTEGER',
  text: 'TEXT',
};

/** 列声明：(列名, 类型槽位, not_null, 默认值文本)。
 *  默认值按原样拼入 SQL（JSON 列带引号：'[]' / '{}'；数值列裸数字）；
 *  主键列（id 槽位）不标 NOT NULL（sqlite INTEGER PK 隐含非空）。 */
const TABLES: Record<string, [string, string, boolean, string | null][]> = {
  checkpoints: [
    ['checkpoint_id', 'id', false, null],
    ['thread_id', 'text', true, null],
    ['node', 'text', false, null],
    ['graph_path', 'json', true, "'[]'"],
    ['state', 'json', true, "'{}'"],
    ['parent_id', 'bigint', false, null],
    ['reason', 'text', false, null],
    ['created_at', 'real', true, null],
    ['version', 'int', true, '1'],
    ['event_seq', 'bigint', true, '0'],
    ['error', 'text', false, null],
    ['interrupt', 'json', false, null],
    ['graph_version', 'text', false, null],
    ['plan', 'json', false, null],
  ],
  event_log: [
    ['seq', 'id', false, null],
    ['thread_id', 'text', true, null],
    ['event', 'json', true, null],
  ],
  records: [
    ['collection', 'text', true, null],
    ['key', 'text', true, null],
    ['data', 'json', true, null],
  ],
};

/** 表 → (索引名, 列清单)（与 Python 同组索引，语义一致）。 */
const INDEXES: Record<string, [string, string][]> = {
  checkpoints: [['idx_checkpoints_thread', 'thread_id, checkpoint_id DESC']],
  event_log: [['idx_event_log_thread', 'thread_id, seq']],
};

/** records 表主键（collection+key 唯一，upsert 冲突键）。 */
const RECORDS_PK = 'PRIMARY KEY (collection, key)';

/** 单列 DDL：镜像 Python column_ddl（类型槽位 + NOT NULL + DEFAULT）。 */
function columnDdl(name: string, slot: string, notNull: boolean, def: string | null): string {
  const typeSql = DIALECT_TYPES[slot] ?? slot;
  const parts = [`    ${name} ${typeSql}`];
  if (notNull) parts.push('NOT NULL');
  if (def !== null) parts.push(`DEFAULT ${def}`);
  return parts.join(' ');
}

/**
 * 生成 sqlite 三表 DDL（CREATE TABLE IF NOT EXISTS + 索引），
 * 与 Python build_schema_sql("sqlite") 输出逐字一致。
 */
export function buildSchemaSql(): string {
  const statements: string[] = [];
  for (const table of Object.keys(TABLES)) {
    const columns = TABLES[table]!;
    const body: string[] = columns.map(([name, slot, notNull, def]) =>
      columnDdl(name, slot, notNull, def),
    );
    if (table === 'records') body.push(`    ${RECORDS_PK}`);
    statements.push(`CREATE TABLE IF NOT EXISTS ${table} (\n${body.join(',\n')}\n);`);
    for (const [indexName, indexColumns] of INDEXES[table] ?? []) {
      statements.push(
        `CREATE INDEX IF NOT EXISTS ${indexName} ON ${table}(${indexColumns});`,
      );
    }
  }
  return statements.join('\n');
}

/** 预生成的完整 DDL 文本（_connect 建表即执行）。 */
export const SCHEMA_SQL = buildSchemaSql();

/** 与 Python 同构的三表结构（表名全集）。 */
export const SCHEMA_TABLES: readonly string[] = ['checkpoints', 'event_log', 'records'];
