//! 本地 md 记忆存储域：namespace=目录、条目=文件、frontmatter=元数据。
//!
//! 定位：引擎 MemoryStore 协议的本地持久化落地——每一条记忆是一个
//! markdown 文件，元数据（id/namespace/kind/weight/时效/失效标记等）
//! 以 YAML frontmatter 承载，正文即记忆内容。文件形态天然可读、可
//! 导出、可人工编辑，也是「按 namespace 分目录」的存档布局。
//!
//! 语义对齐引擎记忆契约（与引擎 `core.memory` 的默认实现同源）：
//! - 删除 = 标记失效（frontmatter `_deleted: true`），文件保留可追溯，
//!   召回侧不再返回——非破坏性遗忘；
//! - 更新保护身份字段（id/namespace/created_at），只改可变更字段；
//! - 查询按 namespace/kind/source 过滤 + 过期条目排除，排序为
//!   优先级降序 → 创建时间降序（确定性召回顺序，与引擎一致）。
//!
//! 可靠写：所有落盘走「临时文件写 + 原子改名」；Windows 上覆盖既有
//! 文件时先清旧再换新（尽力原子：文件系统无法保证两步间的崩溃一致性，
//! 但任何时刻磁盘上都存在完整版本，不会出现半截 yaml）。
//!
//! 接口边界：本模块为独立 Rust 库逻辑，不依赖引擎 op 通道；异步形态
//! 与桥层协议对象同构（save/get/update/delete/query/clear），可直接
//! 作为桥层持久化实现的落地载体。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::common::DomainError;

/// frontmatter 分隔行（首行与收盘行均为此形态）。
const FRONTMATTER_DELIMITER: &str = "---";

/// 失效标记键（frontmatter 字段；标记后召回不可见、文件仍可追溯）。
const RECORD_DELETED: &str = "_deleted";

/// 不可变身份字段（更新时忽略，与引擎约定一致）。
const PROTECTED_KEYS: [&str; 4] = ["id", "namespace", "created_at", RECORD_DELETED];

/// 条目默认优先级（缺失时按 5 处理，与引擎默认一致）。
const DEFAULT_PRIORITY: f64 = 5.0;

/// 条目默认权重。
const DEFAULT_WEIGHT: f64 = 1.0;

/// 条目默认来源。
const DEFAULT_SOURCE: &str = "manual";

/// 当前 epoch 秒（创建时间戳基准）。
fn now_epoch() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// 单条记忆条目（与引擎 MemoryEntry 的字段语义一一对应）。
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryRecord {
    pub id: String,
    pub namespace: String,
    pub kind: String,
    pub content: String,
    pub title: Option<String>,
    pub source: String,
    pub priority: f64,
    pub weight: f64,
    pub meta: serde_json::Value,
    pub created_at: f64,
    pub expires_at: Option<f64>,
}

impl MemoryRecord {
    /// 便捷构造：带默认值的标准条目（id 留空由 save 生成）。
    pub fn new(namespace: &str, kind: &str, content: &str) -> Self {
        Self {
            id: String::new(),
            namespace: namespace.to_string(),
            kind: kind.to_string(),
            content: content.to_string(),
            title: None,
            source: DEFAULT_SOURCE.to_string(),
            priority: DEFAULT_PRIORITY,
            weight: DEFAULT_WEIGHT,
            meta: serde_json::json!({}),
            created_at: now_epoch(),
            expires_at: None,
        }
    }

    /// 是否已失效（无失效时间视为永续）。
    pub fn is_expired_at(&self, now: f64) -> bool {
        self.expires_at.is_some_and(|t| t <= now)
    }
}

/// 记忆查询条件（按字段过滤；limit 截断 top-k）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MemoryQuery {
    pub namespace: Option<String>,
    pub kind: Option<String>,
    pub source: Option<String>,
    pub limit: Option<usize>,
}

/// frontmatter 元数据（落盘形态；正文内容单独承载）。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileMeta {
    id: String,
    namespace: String,
    kind: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default = "default_source_meta")]
    source: String,
    #[serde(default = "default_priority_meta")]
    priority: f64,
    #[serde(default = "default_weight_meta")]
    weight: f64,
    #[serde(default = "default_meta_value")]
    meta: serde_json::Value,
    #[serde(default)]
    created_at: f64,
    #[serde(default)]
    expires_at: Option<f64>,
    #[serde(default)]
    _deleted: bool,
}

fn default_source_meta() -> String {
    DEFAULT_SOURCE.to_string()
}

fn default_priority_meta() -> f64 {
    DEFAULT_PRIORITY
}

fn default_weight_meta() -> f64 {
    DEFAULT_WEIGHT
}

fn default_meta_value() -> serde_json::Value {
    serde_json::json!({})
}

impl FileMeta {
    fn to_record(&self, content: String) -> MemoryRecord {
        MemoryRecord {
            id: self.id.clone(),
            namespace: self.namespace.clone(),
            kind: self.kind.clone(),
            content,
            title: self.title.clone(),
            source: self.source.clone(),
            priority: self.priority,
            weight: self.weight,
            meta: self.meta.clone(),
            created_at: self.created_at,
            expires_at: self.expires_at,
        }
    }
}

/// 本地 md 记忆存储（root = 记忆目录；namespace = 其下子目录）。
pub struct MemoryMdStore {
    root: PathBuf,
}

impl MemoryMdStore {
    /// 打开（或创建）以 root 为基座的记忆存储。
    pub fn open(root: impl AsRef<Path>) -> Result<Self, DomainError> {
        let root = root.as_ref().to_path_buf();
        std::fs::create_dir_all(&root).map_err(|e| {
            DomainError::Storage(format!("记忆目录创建失败 {}: {e}", root.display()))
        })?;
        Ok(Self { root })
    }

    /// 条目文件路径：namespace/id 经路径安全编码后落盘（目录与文件名
    /// 均不含跨平台非法字符；`:` 在 Windows 文件名中非法，id 的
    /// `ns:hex` 形态因此必须编码）。
    fn file_for(&self, namespace: &str, id: &str) -> PathBuf {
        self.root
            .join(encode_component(namespace))
            .join(format!("{}.md", encode_component(id)))
    }

    /// 按 id 定位文件：先走 `<编码ns>/<编码id>.md` 直取；未命中时全树
    /// 扫描同名文件兜底（兼容不含 namespace 前缀的老 id），避免目录
    /// 布局强约束。
    fn locate(&self, id: &str) -> Option<PathBuf> {
        let name = format!("{}.md", encode_component(id));
        if let Some((ns, _)) = id.split_once(':') {
            let direct = self.file_for(ns, id);
            if direct.is_file() {
                return Some(direct);
            }
        }
        let root = self.root.clone();
        walkdir::WalkDir::new(&root)
            .min_depth(1)
            .into_iter()
            .filter_map(|e| e.ok())
            .find(|e| e.file_type().is_file() && e.file_name().to_string_lossy() == name)
            .map(|e| e.path().to_path_buf())
    }

    /// 保存条目：id 缺失时按 `{namespace}:{uuid}` 生成（与引擎一致），
    /// 覆盖式写（同 id 再存 = 更新）。返回条目 id。
    pub async fn save(&self, record: MemoryRecord) -> Result<String, DomainError> {
        let id = if record.id.is_empty() {
            format!("{}:{}", record.namespace, uuid::Uuid::new_v4().simple())
        } else {
            record.id.clone()
        };
        validate_component(&record.namespace)?;
        validate_component(&id)?;
        let meta = FileMeta {
            id: id.clone(),
            namespace: record.namespace.clone(),
            kind: record.kind.clone(),
            title: record.title.clone(),
            source: record.source.clone(),
            priority: record.priority,
            weight: record.weight,
            meta: record.meta.clone(),
            created_at: record.created_at,
            expires_at: record.expires_at,
            _deleted: false,
        };
        let yaml = serde_yaml::to_string(&meta)
            .map_err(|e| DomainError::Storage(format!("记忆元数据渲染失败: {e}")))?;
        let content = format!("{FRONTMATTER_DELIMITER}\n{yaml}{FRONTMATTER_DELIMITER}\n{}", record.content);
        let path = self.file_for(&record.namespace, &id);
        atomic_write(&path, content.as_bytes())?;
        Ok(id)
    }

    /// 读取条目：不存在或已标记失效返回 None。
    pub async fn get(&self, id: &str) -> Result<Option<MemoryRecord>, DomainError> {
        let Some(path) = self.locate(id) else {
            return Ok(None);
        };
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| DomainError::Storage(format!("记忆读取失败 ({}): {e}", path.display())))?;
        let (yaml, body) = split_frontmatter(&raw)
            .ok_or_else(|| DomainError::InvalidData(format!("frontmatter 缺失 ({}): {}", path.display(), id)))?;
        let meta: FileMeta = serde_yaml::from_str(&yaml)
            .map_err(|e| DomainError::InvalidData(format!("frontmatter 解析失败 ({}): {e}", path.display())))?;
        if meta._deleted {
            return Ok(None);
        }
        Ok(Some(meta.to_record(body)))
    }

    /// 按补丁字段更新：content 走正文，其余走 frontmatter；
    /// 身份字段（id/namespace/created_at/_deleted）保护不动。
    /// 条目不存在或已失效返回 false。
    pub async fn update(
        &self,
        entry_id: &str,
        patch: &serde_json::Value,
    ) -> Result<bool, DomainError> {
        let Some(path) = self.locate(entry_id) else {
            return Ok(false);
        };
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| DomainError::Storage(format!("记忆读取失败 ({}): {e}", path.display())))?;
        let (yaml, body) = split_frontmatter(&raw)
            .ok_or_else(|| DomainError::InvalidData(format!("frontmatter 缺失: {entry_id}")))?;
        let mut meta: FileMeta = serde_yaml::from_str(&yaml)
            .map_err(|e| DomainError::InvalidData(format!("frontmatter 解析失败: {e}")))?;
        if meta._deleted {
            return Ok(false);
        }
        let fields = patch
            .as_object()
            .ok_or_else(|| DomainError::InvalidData("更新数据须为 JSON 对象".to_string()))?;
        let mut content = body;
        for (key, value) in fields {
            if PROTECTED_KEYS.contains(&key.as_str()) {
                continue;
            }
            apply_patch(&mut meta, &mut content, key, value);
        }
        let yaml = serde_yaml::to_string(&meta)
            .map_err(|e| DomainError::Storage(format!("记忆元数据渲染失败: {e}")))?;
        let rendered = format!("{FRONTMATTER_DELIMITER}\n{yaml}{FRONTMATTER_DELIMITER}\n{content}");
        atomic_write(&path, rendered.as_bytes())?;
        Ok(true)
    }

    /// 标记失效（不物理删除：文件保留、`_deleted: true`，召回不可见）。
    /// 条目不存在返回 false。
    pub async fn delete(&self, entry_id: &str) -> Result<bool, DomainError> {
        let Some(path) = self.locate(entry_id) else {
            return Ok(false);
        };
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| DomainError::Storage(format!("记忆读取失败 ({}): {e}", path.display())))?;
        let (yaml, body) = split_frontmatter(&raw)
            .ok_or_else(|| DomainError::InvalidData(format!("frontmatter 缺失: {entry_id}")))?;
        let mut meta: FileMeta = serde_yaml::from_str(&yaml)
            .map_err(|e| DomainError::InvalidData(format!("frontmatter 解析失败: {e}")))?;
        meta._deleted = true;
        let yaml = serde_yaml::to_string(&meta)
            .map_err(|e| DomainError::Storage(format!("记忆元数据渲染失败: {e}")))?;
        let rendered = format!("{FRONTMATTER_DELIMITER}\n{yaml}{FRONTMATTER_DELIMITER}\n{body}");
        atomic_write(&path, rendered.as_bytes())?;
        Ok(true)
    }

    /// 查询：namespace/kind/source 过滤 + 过期排除 + 失效排除，
    /// 排序 = 优先级降序 → 创建时间降序，按 limit 截断。
    ///
    /// 文件损坏的条目跳过（不因单条坏数据拖垮整段记忆召回）。
    pub async fn query(&self, q: &MemoryQuery) -> Result<Vec<MemoryRecord>, DomainError> {
        let now = now_epoch();
        let mut entries: Vec<MemoryRecord> = walkdir::WalkDir::new(&self.root)
            .min_depth(1)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file()
                    && e.file_name().to_string_lossy().ends_with(".md")
            })
            .filter_map(|e| read_record(&e.path()))
            .filter(|r| !r.is_expired_at(now))
            .filter(|r| {
                q.namespace
                    .as_deref()
                    .is_none_or(|ns| r.namespace == ns)
            })
            .filter(|r| q.kind.as_deref().is_none_or(|k| r.kind == k))
            .filter(|r| q.source.as_deref().is_none_or(|s| r.source == s))
            .collect();
        entries.sort_by(|a, b| {
            b.priority
                .partial_cmp(&a.priority)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(
                    b.created_at
                        .partial_cmp(&a.created_at)
                        .unwrap_or(std::cmp::Ordering::Equal),
                )
        });
        if let Some(limit) = q.limit {
            entries.truncate(limit);
        }
        Ok(entries)
    }

    /// 清空记忆目录（显式清除：物理删除全部条目文件）。
    pub async fn clear(&self) -> Result<(), DomainError> {
        if self.root.exists() {
            std::fs::remove_dir_all(&self.root).map_err(|e| {
                DomainError::Storage(format!("记忆清空失败 ({}): {e}", self.root.display()))
            })?;
            std::fs::create_dir_all(&self.root).map_err(|e| {
                DomainError::Storage(format!("记忆目录重建失败 ({}): {e}", self.root.display()))
            })?;
        }
        Ok(())
    }

    /// 记忆根目录（导出/备份的基座）。
    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// 路径分量安全校验（namespace 与 id 都严禁路径逃逸；
/// 跨平台非法字符不在校验之列——落盘经 [`encode_component`] 编码）。
fn validate_component(name: &str) -> Result<(), DomainError> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err(DomainError::InvalidData(format!(
            "非法路径分量（禁止空/点/分隔符）: {name:?}"
        )));
    }
    Ok(())
}

/// 路径分量编码：Windows 文件名非法字符（含 `:`）与 `%` 按 UTF-8
/// 字节百分号转义（`user%3Aalice` 形态）。目录/文件名只此形态落盘，
/// 读回语义（namespace/kind 等）以文件内 frontmatter 为权威，无需解码。
fn encode_component(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        match ch {
            '%' | '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => {
                out.push('%');
                let mut buf = [0u8; 4];
                for byte in ch.encode_utf8(&mut buf).bytes() {
                    let _ = std::fmt::Write::write_fmt(&mut out, format_args!("{byte:02X}"));
                }
            }
            _ => out.push(ch),
        }
    }
    out
}

/// 原子写：临时文件 + 改名；Windows 覆盖已有目标时先清旧再换新，
/// 任何时刻磁盘上都只存在完整版本。
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), DomainError> {
    if let Some(parent) = path.parent() {
        if !parent.is_dir() {
            std::fs::create_dir_all(parent).map_err(|e| {
                DomainError::Storage(format!("记忆目录创建失败 ({}): {e}", parent.display()))
            })?;
        }
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "memory.md".to_string());
    let tmp = path.with_file_name(format!(".{name}.tmp-{}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&tmp, bytes).map_err(|e| {
        DomainError::Storage(format!("临时文件写入失败 ({}): {e}", tmp.display()))
    })?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(first) => {
            // Windows tip：rename 遇存在目标会失败；清旧后重试一次
            if path.exists() {
                std::fs::remove_file(path).map_err(|e| {
                    DomainError::Storage(format!("旧文件清理失败 ({}): {e}", path.display()))
                })?;
                std::fs::rename(&tmp, path).map_err(|e| {
                    DomainError::Storage(format!("文件替换失败 ({}): {e}", path.display()))
                })
            } else {
                Err(DomainError::Storage(format!(
                    "文件改名失败 ({} → {}): {first}",
                    tmp.display(),
                    path.display()
                )))
            }
        }
    }
}

/// frontmatter 切分：首行 `---` 起、收盘行 `---` 止，其余为正文。
fn split_frontmatter(raw: &str) -> Option<(String, String)> {
    let mut iter = raw.split('\n');
    let first = iter.next()?;
    if first.trim_end_matches('\r') != FRONTMATTER_DELIMITER {
        return None;
    }
    let mut yaml = String::new();
    for line in iter.by_ref() {
        if line.trim_end_matches('\r') == FRONTMATTER_DELIMITER {
            // 收盘行后剥一个换行：写文件时 `---\n` 与正文之间的空行
            let body = iter.collect::<Vec<&str>>().join("\n");
            let body = body.strip_prefix('\n').unwrap_or(&body);
            return Some((yaml, body.to_string()));
        }
        yaml.push_str(line);
        yaml.push('\n');
    }
    None
}

/// 读取单条记录文件（失效/损坏返回 None；失效优先静默跳过）。
fn read_record(path: &Path) -> Option<MemoryRecord> {
    let raw = std::fs::read_to_string(path).ok()?;
    let (yaml, body) = split_frontmatter(&raw)?;
    let meta: FileMeta = serde_yaml::from_str(&yaml).ok()?;
    if meta._deleted {
        return None;
    }
    Some(meta.to_record(body))
}

/// 按补丁键把 JSON 值落到元数据/正文（类型不符的键静默跳过，
/// 兼容旧字段与未来扩展：不因单个键的形态错误阻断整次更新）。
fn apply_patch(meta: &mut FileMeta, content: &mut String, key: &str, value: &serde_json::Value) {
    match key {
        "content" => {
            if let Some(text) = value.as_str() {
                *content = text.to_string();
            }
        }
        "title" => match value {
            serde_json::Value::Null => meta.title = None,
            serde_json::Value::String(s) => meta.title = Some(s.clone()),
            _ => {}
        },
        "source" => {
            if let Some(s) = value.as_str() {
                meta.source = s.to_string();
            }
        }
        "kind" => {
            if let Some(s) = value.as_str() {
                meta.kind = s.to_string();
            }
        }
        "priority" => {
            if let Some(p) = value.as_f64() {
                meta.priority = p;
            }
        }
        "weight" => {
            if let Some(w) = value.as_f64() {
                meta.weight = w;
            }
        }
        "meta" => {
            if value.is_object() {
                meta.meta = value.clone();
            }
        }
        "expires_at" => match value {
            serde_json::Value::Null => meta.expires_at = None,
            serde_json::Value::Number(n) => {
                if let Some(t) = n.as_f64() {
                    meta.expires_at = Some(t);
                }
            }
            _ => {}
        },
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// 测试用临时目录（Drop 时整体清理）。
    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("inkling-memory-md-{label}-{}", Uuid::new_v4()));
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

    fn record(ns: &str, kind: &str, content: &str, created_at: f64, priority: f64) -> MemoryRecord {
        let mut r = MemoryRecord::new(ns, kind, content);
        r.created_at = created_at;
        r.priority = priority;
        r
    }

    #[tokio::test]
    async fn save_and_get_roundtrip() {
        let dir = TestDir::new("roundtrip");
        let store = MemoryMdStore::open(dir.path()).unwrap();

        let id = store
            .save(MemoryRecord::new("user:alice", "insight", "记忆正文内容"))
            .await
            .unwrap();
        assert!(id.starts_with("user:alice:"));

        let got = store.get(&id).await.unwrap().expect("条目应存在");
        assert_eq!(got.id, id);
        assert_eq!(got.namespace, "user:alice");
        assert_eq!(got.kind, "insight");
        assert_eq!(got.content, "记忆正文内容");
        assert_eq!(got.priority, DEFAULT_PRIORITY);
        assert!(got.title.is_none());

        // 文件确实在 namespace 目录下（编码目录名），frontmatter 形态存在
        let file = store.file_for("user:alice", &id);
        assert!(file.is_file());
        assert_eq!(
            file.parent().unwrap().file_name().unwrap().to_string_lossy(),
            "user%3Aalice"
        );
        let raw = std::fs::read_to_string(&file).unwrap();
        assert!(raw.starts_with("---\n"));
    }

    #[tokio::test]
    async fn get_missing_returns_none() {
        let dir = TestDir::new("missing");
        let store = MemoryMdStore::open(dir.path()).unwrap();
        assert!(store.get("user:x:nope").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn save_with_explicit_id_is_overwrite() {
        let dir = TestDir::new("explicit");
        let store = MemoryMdStore::open(dir.path()).unwrap();
        let id = "user:bob:fixed-id".to_string();
        let mut first = record("user:bob", "rule", "第一版", 100.0, 3.0);
        first.id = id.clone();
        let mut second = record("user:bob", "rule", "第二版", 200.0, 4.0);
        second.id = id.clone();
        store.save(first).await.unwrap();
        store.save(second).await.unwrap();
        let got = store.get("user:bob:fixed-id").await.unwrap().expect("条目应存在");
        assert_eq!(got.id, id);
        assert_eq!(got.content, "第二版");
        assert_eq!(got.created_at, 200.0);
    }

    #[tokio::test]
    async fn update_applies_patch_and_protects_identity() {
        let dir = TestDir::new("update");
        let store = MemoryMdStore::open(dir.path()).unwrap();
        let id = store
            .save(record("user:c", "insight", "旧内容", 100.0, 3.0))
            .await
            .unwrap();

        let patch = serde_json::json!({
            "content": "新内容",
            "priority": 9,
            "source": "dialog",
            "id": "user:c:被保护的id",
            "namespace": "user:被保护的ns",
            "created_at": 0.0,
            "_deleted": true,
            "meta": {"related": 42}
        });
        assert!(store.update(&id, &patch).await.unwrap());

        let got = store.get(&id).await.unwrap().expect("更新后应存在");
        assert_eq!(got.content, "新内容");
        assert_eq!(got.priority, 9.0);
        assert_eq!(got.source, "dialog");
        assert_eq!(got.id, id);
        assert_eq!(got.namespace, "user:c");
        assert_eq!(got.created_at, 100.0);
        assert_eq!(got.meta["related"], 42);
    }

    #[tokio::test]
    async fn update_missing_or_deleted_returns_false() {
        let dir = TestDir::new("update-false");
        let store = MemoryMdStore::open(dir.path()).unwrap();
        let patch = serde_json::json!({"content": "x"});
        assert!(!store.update("user:x:nope", &patch).await.unwrap());
        assert!(!store.update("noseparator", &patch).await.unwrap());
    }

    #[tokio::test]
    async fn delete_marks_invalid_but_keeps_trace_file() {
        let dir = TestDir::new("delete");
        let store = MemoryMdStore::open(dir.path()).unwrap();
        let id = store
            .save(MemoryRecord::new("user:d", "insight", "将被遗忘"))
            .await
            .unwrap();

        assert!(store.delete(&id).await.unwrap());
        assert!(store.get(&id).await.unwrap().is_none());
        // 文件仍在，_deleted 标记可追溯
        let file = store.file_for("user:d", &id);
        assert!(file.is_file());
        let raw = std::fs::read_to_string(&file).unwrap();
        assert!(raw.contains("_deleted: true"));
        assert!(raw.contains("将被遗忘"));

        assert!(!store.delete("user:d:nope").await.unwrap());
        // 已标记失效的记录仍存在（标记幂等：再删一次 = true，与引擎一致）
        assert!(store.delete(&id).await.unwrap());
    }

    #[tokio::test]
    async fn query_filters_and_orders_by_priority_then_created() {
        let dir = TestDir::new("query");
        let store = MemoryMdStore::open(dir.path()).unwrap();
        let mut low = record("user:e", "insight", "低优先级旧", 100.0, 2.0);
        low.source = "dialog".to_string();
        let mut high = record("user:e", "insight", "高优先级新", 300.0, 8.0);
        high.source = "dialog".to_string();
        let mut mid = record("user:e", "insight", "中优先级久远", 50.0, 8.0);
        mid.source = "self_reflection".to_string();
        let mut other_ns = record("user:f", "insight", "别的域", 400.0, 9.0);
        other_ns.source = "dialog".to_string();
        let mut expired = record("user:e", "insight", "已过期", 150.0, 9.0);
        expired.expires_at = Some(90.0);
        let deleted = record("user:e", "insight", "已删除", 160.0, 9.0);
        let deleted_id = store.save(deleted).await.unwrap();
        store.delete(&deleted_id).await.unwrap();

        store.save(low).await.unwrap();
        store.save(high).await.unwrap();
        store.save(mid).await.unwrap();
        store.save(other_ns).await.unwrap();
        store.save(expired).await.unwrap();

        let hits = store
            .query(&MemoryQuery {
                namespace: Some("user:e".to_string()),
                kind: Some("insight".to_string()),
                source: Some("dialog".to_string()),
                limit: None,
            })
            .await
            .unwrap();
        let contents: Vec<&str> = hits.iter().map(|r| r.content.as_str()).collect();
        // 高优先级在前；同优先级按创建时间降序（300 > 100）
        assert_eq!(contents, vec!["高优先级新", "低优先级旧"]);
    }

    #[tokio::test]
    async fn query_limit_and_other_filters() {
        let dir = TestDir::new("query-limit");
        let store = MemoryMdStore::open(dir.path()).unwrap();
        store.save(record("user:g", "insight", "a", 1.0, 1.0)).await.unwrap();
        store.save(record("user:g", "insight", "b", 2.0, 1.0)).await.unwrap();
        store.save(record("user:g", "rule", "c", 3.0, 9.0)).await.unwrap();

        let by_kind = store
            .query(&MemoryQuery {
                kind: Some("rule".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(by_kind.len(), 1);
        assert_eq!(by_kind[0].content, "c");

        let limited = store
            .query(&MemoryQuery {
                namespace: Some("user:g".to_string()),
                limit: Some(1),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].content, "c");
    }

    #[tokio::test]
    async fn malformed_file_is_skipped_in_query() {
        let dir = TestDir::new("malformed");
        let store = MemoryMdStore::open(dir.path()).unwrap();
        store
            .save(record("user:h", "insight", "正常条目", 1.0, 1.0))
            .await
            .unwrap();
        std::fs::write(
            store.file_for("user:h", "bad"),
            "没有 frontmatter 的文本\n",
        )
        .unwrap();
        let hits = store.query(&MemoryQuery::default()).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, "正常条目");
    }

    #[tokio::test]
    async fn path_traversal_is_rejected() {
        let dir = TestDir::new("traversal");
        let store = MemoryMdStore::open(dir.path()).unwrap();
        let evil = MemoryRecord::new("../outside", "insight", "x");
        assert!(store.save(evil).await.is_err());
        let evil_id = MemoryRecord::new("user:i", "insight", "x");
        let evil = MemoryRecord {
            id: "..\\..\\evil".to_string(),
            ..evil_id
        };
        assert!(store.save(evil).await.is_err());
    }

    #[tokio::test]
    async fn clear_wipes_all_records() {
        let dir = TestDir::new("clear");
        let store = MemoryMdStore::open(dir.path()).unwrap();
        store.save(record("user:j", "insight", "x", 1.0, 1.0)).await.unwrap();
        store.clear().await.unwrap();
        assert_eq!(store.query(&MemoryQuery::default()).await.unwrap().len(), 0);
    }

    #[test]
    fn path_components_are_encoded_windows_safe() {
        assert_eq!(encode_component("user:alice"), "user%3Aalice");
        assert_eq!(encode_component("用户"), "用户");
        assert_eq!(encode_component("a\\b|c"), "a%5Cb%7Cc");
        assert_eq!(encode_component("%"), "%25");
    }
}
