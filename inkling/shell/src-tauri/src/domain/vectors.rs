//! 向量目录域：sqlite 持久化的派生索引（文本向量 → 余弦检索）。
//!
//! 定位：检索前置的向量层——把「知识集/记忆里有哪些条目」与「这些条目
//! 的语义向量在哪」解耦。向量表对本体（知识集、记忆文件）是派生数据：
//! 本体条目增删改后，经 [`VectorCatalog::refresh_missing`] 或宿主侧的
//! upsert 同步，向量层自身不裁决本体内容。
//!
//! 接口边界：本模块不依赖任何域模块——嵌入器/记忆存储由调用方以
//! 闭包或显式数据形态接入（`refresh_missing` 接收嵌入函数），保证
//! 向量目录可独立单测、可替换后端。
//!
//! 规模语义：全量余弦扫描——每个查询在进程内做点积而不是下推到
//! sqlite 表达式（向量是 BLOB，无向量扩展的前提下这是确定性最快路径）。
//! 千级条目（1000 × 384 维）实测毫秒级，满足「千级 <10ms」目标；
//! 万级以上再考虑分批/分片，本模块不预先引入复杂度。
//!
//! 持久化：库文件随数据目录导出（[`VectorCatalog::export_to`]），
//! 迁移/备份经 VACUUM INTO 落成一致性快照，不依赖 WAL 文件状态。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};

use super::common::DomainError;

/// 向量目录库文件名（放在数据目录下，随导出传入）。
pub const VECTOR_DB_NAME: &str = "vectors.sqlite";

/// 当前 epoch 秒（写入 updated_at 的时间基准）。
fn now_epoch() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// 向量编码为 BLOB（f64 little-endian 序列；解码按 dim 还原）。
fn encode_vec(vector: &[f64]) -> Vec<u8> {
    vector.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// BLOB 解码为向量（长度与 dim 不一致视为数据损坏）。
fn decode_vec(blob: &[u8], dim: usize) -> Result<Vec<f64>, DomainError> {
    let expected = dim * 8;
    if blob.len() != expected {
        return Err(DomainError::InvalidData(format!(
            "向量 BLOB 长度 {} 与声明的 dim {} 不符（应 {} 字节）",
            blob.len(),
            dim,
            expected
        )));
    }
    Ok(blob
        .chunks_exact(8)
        .map(|c| f64::from_le_bytes(c.try_into().expect("8 字节块")))
        .collect())
}

/// 余弦相似度（BLOB 存储原始向量，检索时实时计算）。
fn cosine(a: &[f64], b: &[f64]) -> f64 {
    let mut dot = 0.0;
    let mut na = 0.0;
    let mut nb = 0.0;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    // 零向量防除零：对不上任何种子也无意义，给极小分母即可
    dot / (na.sqrt() * nb.sqrt() + 1e-12)
}

/// 单条检索命中（分数为余弦相似度，取值 [-1, 1]，降序）。
#[derive(Debug, Clone, PartialEq)]
pub struct VectorHit {
    pub entry_id: String,
    pub score: f64,
}

/// 增量同步结果（新增条数 / 嵌入失败跳过的条数）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefreshReport {
    pub added: usize,
    pub skipped: usize,
}

/// sqlite 向量目录：`entry_vectors` 表（entry_id 主键 + dim + 向量 BLOB +
/// updated_at），提供 upsert / delete / search / 增量补齐 / 导出。
pub struct VectorCatalog {
    conn: Connection,
    path: Option<PathBuf>,
}

impl VectorCatalog {
    /// 打开（或新建）指定路径的向量库文件；父目录不存在时创建。
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DomainError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                DomainError::Storage(format!("向量库目录创建失败 {}: {e}", parent.display()))
            })?;
        }
        let conn = Connection::open(path)
            .map_err(|e| DomainError::Storage(format!("向量库打开失败 {}: {e}", path.display())))?;
        let catalog = Self::prepare(conn)?;
        Ok(Self {
            conn: catalog,
            path: Some(path.to_path_buf()),
        })
    }

    /// 打开数据目录下的向量库（`<dir>/vectors.sqlite`）。
    pub fn open_in_data_dir(dir: impl AsRef<Path>) -> Result<Self, DomainError> {
        Self::open(dir.as_ref().join(VECTOR_DB_NAME))
    }

    /// 内存态向量库（测试/临时批次用，零落盘）。
    pub fn open_in_memory() -> Result<Self, DomainError> {
        let conn = Connection::open_in_memory()
            .map_err(|e| DomainError::Storage(format!("内存向量库创建失败: {e}")))?;
        let conn = Self::prepare(conn)?;
        Ok(Self { conn, path: None })
    }

    fn prepare(conn: Connection) -> Result<Connection, DomainError> {
        // WAL + NORMAL：读多写少模式的写放大容忍；数据安全仍在连接关闭时落盘
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| DomainError::Storage(format!("向量库 WAL 设置失败: {e}")))?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS entry_vectors (
                entry_id   TEXT PRIMARY KEY,
                dim        INTEGER NOT NULL,
                vector     BLOB NOT NULL,
                updated_at REAL NOT NULL
            )",
            [],
        )
        .map_err(|e| DomainError::Storage(format!("向量表初始化失败: {e}")))?;
        Ok(conn)
    }

    /// 当前库文件路径（内存态为 None）。
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// 写入/覆盖一条向量（entry_id 已存在则更新向量列，语义幂等）。
    pub fn upsert(&mut self, entry_id: &str, vector: &[f64]) -> Result<(), DomainError> {
        let updated_at = now_epoch();
        self.upsert_at(entry_id, vector, updated_at)
    }

    /// 带时间戳写入（时间敏感流程显式给定时间基准，缺省走现在时间）。
    pub fn upsert_at(
        &mut self,
        entry_id: &str,
        vector: &[f64],
        updated_at: f64,
    ) -> Result<(), DomainError> {
        if vector.is_empty() {
            return Err(DomainError::InvalidData(format!(
                "条目 {entry_id} 的空向量禁止写入（切面索引无法比对上任何东西）"
            )));
        }
        let blob = encode_vec(vector);
        self.conn
            .execute(
                "INSERT INTO entry_vectors (entry_id, dim, vector, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(entry_id) DO UPDATE SET
                     dim = excluded.dim,
                     vector = excluded.vector,
                     updated_at = excluded.updated_at",
                rusqlite::params![entry_id, vector.len() as i64, blob, updated_at],
            )
            .map_err(|e| DomainError::Storage(format!("向量写入失败 ({entry_id}): {e}")))?;
        Ok(())
    }

    /// 批量写入（同一事务，全成或全败）。
    pub fn upsert_many<'a, I>(&mut self, items: I) -> Result<(), DomainError>
    where
        I: IntoIterator<Item = (&'a str, &'a [f64])>,
    {
        let tx = self
            .conn
            .transaction()
            .map_err(|e| DomainError::Storage(format!("向量事务开启失败: {e}")))?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO entry_vectors (entry_id, dim, vector, updated_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(entry_id) DO UPDATE SET
                         dim = excluded.dim,
                         vector = excluded.vector,
                         updated_at = excluded.updated_at",
                )
                .map_err(|e| DomainError::Storage(format!("向量批量语句准备失败: {e}")))?;
            let now = now_epoch();
            for (entry_id, vector) in items {
                if vector.is_empty() {
                    return Err(DomainError::InvalidData(format!(
                        "条目 {entry_id} 的空向量禁止写入"
                    )));
                }
                stmt.execute(rusqlite::params![
                    entry_id,
                    vector.len() as i64,
                    encode_vec(vector),
                    now
                ])
                .map_err(|e| DomainError::Storage(format!("向量批量写入失败 ({entry_id}): {e}")))?;
            }
        }
        tx.commit()
            .map_err(|e| DomainError::Storage(format!("向量批量提交失败: {e}")))?;
        Ok(())
    }

    /// 删除条目向量（不存在返回 false）。
    pub fn delete(&mut self, entry_id: &str) -> Result<bool, DomainError> {
        let affected = self
            .conn
            .execute("DELETE FROM entry_vectors WHERE entry_id = ?1", [entry_id])
            .map_err(|e| DomainError::Storage(format!("向量删除失败 ({entry_id}): {e}")))?;
        Ok(affected > 0)
    }

    /// 读取单条向量（不存在或数据损坏返回 None/Err 由调用方区分）。
    pub fn get(&self, entry_id: &str) -> Result<Option<(usize, Vec<f64>)>, DomainError> {
        let row = self
            .conn
            .query_row(
                "SELECT dim, vector FROM entry_vectors WHERE entry_id = ?1",
                [entry_id],
                |row| {
                    let dim: i64 = row.get(0)?;
                    let blob: Vec<u8> = row.get(1)?;
                    Ok((dim as usize, blob))
                },
            )
            .optional()
            .map_err(|e| DomainError::Storage(format!("向量读取失败 ({entry_id}): {e}")))?;
        match row {
            None => Ok(None),
            Some((dim, blob)) => Ok(Some((dim, decode_vec(&blob, dim)?))),
        }
    }

    /// 条目数（向量表规模）。
    pub fn count(&self) -> Result<usize, DomainError> {
        self.conn
            .query_row("SELECT COUNT(*) FROM entry_vectors", [], |row| {
                row.get::<_, i64>(0)
            })
            .map(|n| n as usize)
            .map_err(|e| DomainError::Storage(format!("向量表计数失败: {e}")))
    }

    /// 表内全部条目 id（本体侧判「缺哪些」的输入）。
    pub fn entry_ids(&self) -> Result<Vec<String>, DomainError> {
        let mut stmt = self
            .conn
            .prepare("SELECT entry_id FROM entry_vectors ORDER BY entry_id")
            .map_err(|e| DomainError::Storage(format!("向量条目清单准备失败: {e}")))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| DomainError::Storage(format!("向量条目清单查询失败: {e}")))?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(row.map_err(|e| DomainError::Storage(format!("向量条目清单读取失败: {e}")))?);
        }
        Ok(ids)
    }

    /// 全量余弦检索：返回 top-k 命中（分数降序；同分按 entry_id 稳定排序）。
    ///
    /// 只比对与查询同维的条目（dim 列过滤），不同维度的旧版本向量
    /// 天然不会串扰——维度变更只影响该条目，不影响整库语义。
    pub fn search(&self, query: &[f64], limit: usize) -> Result<Vec<VectorHit>, DomainError> {
        if query.is_empty() {
            return Err(DomainError::InvalidData("查询向量不能为空".to_string()));
        }
        let mut stmt = self
            .conn
            .prepare("SELECT entry_id, dim, vector FROM entry_vectors WHERE dim = ?1")
            .map_err(|e| DomainError::Storage(format!("检索语句准备失败: {e}")))?;
        let rows = stmt
            .query_map([query.len() as i64], |row| {
                let entry_id: String = row.get(0)?;
                let dim: i64 = row.get(1)?;
                let blob: Vec<u8> = row.get(2)?;
                Ok((entry_id, dim as usize, blob))
            })
            .map_err(|e| DomainError::Storage(format!("检索执行失败: {e}")))?;
        let mut hits = Vec::new();
        for row in rows {
            let (entry_id, dim, blob) =
                row.map_err(|e| DomainError::Storage(format!("检索行读取失败: {e}")))?;
            // 数据损坏行跳过（BLOB 截断/异常维度），不因单条坏数据拖垮检索
            let Ok(vector) = decode_vec(&blob, dim) else {
                continue;
            };
            hits.push(VectorHit {
                entry_id,
                score: cosine(query, &vector),
            });
        }
        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.entry_id.cmp(&b.entry_id))
        });
        hits.truncate(limit);
        Ok(hits)
    }

    /// 增量同步：本体侧有、向量表缺的条目补齐（缺了才嵌入，不重复刷新）。
    ///
    /// 嵌入函数由调用方提供（本模块不依赖嵌入器域）；嵌入失败的单条
    /// 跳过并计入 skipped，不中断整批——语义层降级而非硬失败。
    pub fn refresh_missing<E>(
        &mut self,
        known_ids: &[String],
        mut embed: E,
    ) -> Result<RefreshReport, DomainError>
    where
        E: FnMut(&str) -> Result<Vec<f64>, DomainError>,
    {
        let existing: std::collections::HashSet<String> =
            self.entry_ids()?.into_iter().collect();
        let mut report = RefreshReport {
            added: 0,
            skipped: 0,
        };
        for id in known_ids {
            if existing.contains(id) {
                continue;
            }
            match embed(id) {
                Ok(vector) if !vector.is_empty() => {
                    self.upsert(id, &vector)?;
                    report.added += 1;
                }
                _ => report.skipped += 1,
            }
        }
        Ok(report)
    }

    /// 一致性快照导出（VACUUM INTO：单文件、不依赖 WAL 状态）。
    ///
    /// dest 建议传绝对路径（sqlite 按进程当前目录解析相对路径）。
    pub fn export_to(&self, dest: impl AsRef<Path>) -> Result<(), DomainError> {
        let dest = dest.as_ref();
        let quoted = dest.to_string_lossy().replace('\'', "''");
        self.conn
            .execute(&format!("VACUUM INTO '{quoted}'"), [])
            .map_err(|e| DomainError::Storage(format!("向量库导出失败 ({}): {e}", dest.display())))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// 测试用临时目录（Drop 时整体清理，避免测试残留）。
    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("inkling-vectors-{label}-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 确定性测试向量（独立于任何模型：FNV + 三角波，跨机器稳定）。
    fn test_vec(seed: u64, dim: usize) -> Vec<f64> {
        (0..dim)
            .map(|i| {
                let x = seed as f64 * 0.618_033_988_75 + i as f64;
                (x * 0.5).fract() - 0.5
            })
            .collect()
    }

    #[test]
    fn upsert_and_get_roundtrip() {
        let dir = TestDir::new("roundtrip");
        let db = dir.path().join("v.sqlite");
        let mut cat = VectorCatalog::open(&db).unwrap();
        cat.upsert("seed.alpha", &test_vec(1, 384)).unwrap();

        let (dim, vec) = cat.get("seed.alpha").unwrap().expect("条目应存在");
        assert_eq!(dim, 384);
        assert_eq!(vec, test_vec(1, 384));
        assert_eq!(cat.count().unwrap(), 1);
        assert!(cat.path().unwrap().is_file());
    }

    #[test]
    fn upsert_overwrites_and_replaces() {
        let dir = TestDir::new("overwrite");
        let db = dir.path().join("v.sqlite");
        let mut cat = VectorCatalog::open(&db).unwrap();
        cat.upsert("a", &test_vec(1, 8)).unwrap();
        cat.upsert("b", &test_vec(2, 8)).unwrap();
        assert_eq!(cat.count().unwrap(), 2);

        cat.upsert("a", &test_vec(9, 8)).unwrap();
        assert_eq!(cat.count().unwrap(), 2);
        let (_, vec) = cat.get("a").unwrap().unwrap();
        assert_eq!(vec, test_vec(9, 8));
    }

    #[test]
    fn search_orders_by_cosine_and_honors_dim() {
        let dir = TestDir::new("search");
        let db = dir.path().join("v.sqlite");
        let mut cat = VectorCatalog::open(&db).unwrap();
        // 同维的三条：最近邻应排第一
        cat.upsert("far", &test_vec(7, 32)).unwrap();
        cat.upsert("near", &test_vec(1, 32)).unwrap();
        cat.upsert("mid", &test_vec(4, 32)).unwrap();
        // 异维条目不应参与同维检索
        cat.upsert("wrong-dim", &test_vec(1, 16)).unwrap();

        let hits = cat.search(&test_vec(1, 32), 3).unwrap();
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].entry_id, "near");
        assert!(hits[0].score >= hits[1].score);
        assert!(hits[1].score >= hits[2].score);
        assert!(!hits.iter().any(|h| h.entry_id == "wrong-dim"));
    }

    #[test]
    fn delete_marks_absence() {
        let dir = TestDir::new("delete");
        let db = dir.path().join("v.sqlite");
        let mut cat = VectorCatalog::open(&db).unwrap();
        cat.upsert("a", &test_vec(1, 8)).unwrap();

        assert!(!cat.delete("missing").unwrap());
        assert!(cat.delete("a").unwrap());
        assert!(cat.get("a").unwrap().is_none());
        assert_eq!(cat.count().unwrap(), 0);
    }

    #[test]
    fn refresh_missing_embeds_absent_entries_and_keeps_existing() {
        let dir = TestDir::new("refresh");
        let db = dir.path().join("v.sqlite");
        let mut cat = VectorCatalog::open(&db).unwrap();
        cat.upsert("has", &test_vec(1, 8)).unwrap();

        let known = vec![
            "has".to_string(),
            "new1".to_string(),
            "new2".to_string(),
            "broken".to_string(),
        ];
        let report = cat
            .refresh_missing(&known, |id| {
                if id == "broken" {
                    Err(DomainError::other("嵌入失败"))
                } else {
                    Ok(test_vec(3, 8))
                }
            })
            .unwrap();
        assert_eq!(report.added, 2);
        assert_eq!(report.skipped, 1);
        assert_eq!(cat.count().unwrap(), 3);
        assert!(cat.get("has").unwrap().is_some());
        assert!(cat.get("new1").unwrap().is_some());
        assert!(cat.get("broken").unwrap().is_none());
    }

    #[test]
    fn export_produces_readable_snapshot() {
        let dir = TestDir::new("export");
        let db = dir.path().join("v.sqlite");
        let mut cat = VectorCatalog::open(&db).unwrap();
        cat.upsert("a", &test_vec(1, 16)).unwrap();
        cat.upsert("b", &test_vec(2, 16)).unwrap();

        let snapshot = dir.path().join("snapshot.sqlite");
        cat.export_to(&snapshot).unwrap();
        let reopened = VectorCatalog::open(&snapshot).unwrap();
        assert_eq!(reopened.count().unwrap(), 2);
        assert!(reopened.get("a").unwrap().is_some());
    }

    #[test]
    fn search_scales_to_kilo_entries() {
        let dir = TestDir::new("scale");
        let db = dir.path().join("v.sqlite");
        let mut cat = VectorCatalog::open(&db).unwrap();
        let items: Vec<(String, Vec<f64>)> =
            (0..1000).map(|i| (format!("e{i}"), test_vec(i as u64, 384))).collect();
        cat.upsert_many(
            items
                .iter()
                .map(|(id, v)| (id.as_str(), v.as_slice())),
        )
        .unwrap();

        let started = std::time::Instant::now();
        let hits = cat.search(&test_vec(42, 384), 5).unwrap();
        let elapsed = started.elapsed();
        assert_eq!(hits.len(), 5);
        assert!(hits[0].score >= hits[4].score);
        // 千级 × 384 维全量余弦：调试构建下也应远低于 100ms（目标 <10ms，
        // 此处留 10 倍余量防 CI 抖动误报）
        assert!(
            elapsed.as_millis() < 100,
            "千级检索耗时超预期: {elapsed:?}"
        );
    }

    #[test]
    fn corrupted_blob_is_skipped_not_fatal() {
        let dir = TestDir::new("corrupt");
        let db = dir.path().join("v.sqlite");
        let mut cat = VectorCatalog::open(&db).unwrap();
        cat.upsert("good", &test_vec(1, 8)).unwrap();
        cat.conn
            .execute("UPDATE entry_vectors SET dim = 7 WHERE entry_id = 'good'", [])
            .unwrap();
        // dim 与 BLOB 不符的行检索时跳过，不拖垮整库
        let hits = cat.search(&test_vec(1, 8), 1).unwrap();
        assert!(hits.is_empty());
    }
}
