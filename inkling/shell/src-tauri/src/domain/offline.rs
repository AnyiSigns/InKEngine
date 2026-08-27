//! 离线支持级：本地模型端点探测（Ollama）+ 本地嵌入（granite-97m 随包）
//! + 本地记忆/技能（数据目录校验）+ 离线 settings 档。
//!
//! 同一数据形态双通道：检测到本地模型可选离线配置（settings 档），
//! 无本地模型云端照常；本地嵌入与本地记忆复用既有域能力。

use std::path::Path;
use std::time::Duration;

/// Ollama 默认探测地址（常见本地端点）。
const OLLAMA_CANDIDATES: &[&str] = &[
    "http://localhost:11434",
    "http://127.0.0.1:11434",
];

/// Ollama 探测结果。
pub struct OllamaStatus {
    pub reachable: bool,
    pub url: Option<String>,
    pub models: Vec<String>,
}

/// 探测本地 Ollama 端点（候选地址任一可达即回报模型清单）。
pub async fn detect_ollama() -> OllamaStatus {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return OllamaStatus { reachable: false, url: None, models: Vec::new() },
    };
    for base in OLLAMA_CANDIDATES {
        let url = format!("{base}/api/tags");
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(v) = resp.json::<serde_json::Value>().await {
                    let models: Vec<String> = v
                        .get("models")
                        .and_then(|m| m.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default();
                    return OllamaStatus {
                        reachable: true,
                        url: Some((*base).to_string()),
                        models,
                    };
                }
            }
        }
    }
    OllamaStatus { reachable: false, url: None, models: Vec::new() }
}

/// 本地嵌入状态（复用 granited 嵌入域；本地模型可用即 available）。
pub fn local_embedding_status() -> serde_json::Value {
    let embedder = crate::domain::embedder::LocalOnnxEmbedder::new();
    let source = embedder.source();
    serde_json::json!({
        "available": source == crate::domain::embedder::EmbedSource::LocalOnnx,
        "source": format!("{source:?}"),
    })
}

/// 默认存储数据库文件名（引擎存储 URI 的产品缺省形态）。
const DEFAULT_STORAGE_DB: &str = "inkling.sqlite";

/// 本地记忆/技能状态（数据目录 sqlite 存在即视为可用）。
///
/// 数据库文件名从离线 settings 的 `storage_db` 读取（缺省
/// `inkling.sqlite`）——引擎改 db 名时探测不再仅按固定文件名误报（FB16）。
pub fn local_memory_status(data_dir: &Path) -> serde_json::Value {
    let settings = read_settings(data_dir);
    let db_name = settings
        .get("storage_db")
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(DEFAULT_STORAGE_DB);
    let sqlite = data_dir.join(db_name);
    let available = sqlite.is_file();
    serde_json::json!({ "available": available, "path": sqlite.to_string_lossy() })
}

/// 综合离线探测（Ollama + 本地嵌入 + 本地记忆）。
pub async fn detect(data_dir: Option<&Path>) -> Result<serde_json::Value, String> {
    let ollama = detect_ollama().await;
    let embedding = local_embedding_status();
    let memory = data_dir
        .map(local_memory_status)
        .unwrap_or_else(|| serde_json::json!({ "available": false }));
    Ok(serde_json::json!({
        "ollama": { "reachable": ollama.reachable, "url": ollama.url, "models": ollama.models },
        "local_embedding": embedding,
        "local_memory": memory,
    }))
}

/// 离线 settings 档文件名（落数据目录）。
const OFFLINE_SETTINGS_FILE: &str = "offline_settings.json";

/// 离线 settings 默认值（缺字段补默认，防双源漂移）。
fn default_settings() -> serde_json::Value {
    serde_json::json!({
        "enabled": false,
        "mode": "auto",
        "ollama_url": "",
        "use_local_embedding": true,
        "use_local_memory": true,
    })
}

/// 读取离线 settings（缺文件或解析失败回落默认）。
pub fn read_settings(data_dir: &Path) -> serde_json::Value {
    let path = data_dir.join(OFFLINE_SETTINGS_FILE);
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(obj) = v.as_object() {
                let mut merged = default_settings();
                if let Some(m) = merged.as_object_mut() {
                    for (k, val) in obj {
                        m.insert(k.clone(), val.clone());
                    }
                }
                return merged;
            }
        }
    }
    default_settings()
}

/// 写入离线 settings（与默认合并后落盘，返回合并结果）。
pub fn write_settings(data_dir: &Path, settings: serde_json::Value) -> serde_json::Value {
    let mut base = default_settings();
    if let (Some(b), Some(s)) = (base.as_object_mut(), settings.as_object()) {
        for (k, val) in s {
            b.insert(k.clone(), val.clone());
        }
    }
    let path = data_dir.join(OFFLINE_SETTINGS_FILE);
    let _ = std::fs::create_dir_all(data_dir);
    if let Ok(text) = serde_json::to_string_pretty(&base) {
        let _ = std::fs::write(&path, text);
    }
    base
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_roundtrip_merges_defaults() {
        let dir = std::env::temp_dir().join(format!("inkling-offline-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let written = write_settings(&dir, serde_json::json!({ "enabled": true, "mode": "local" }));
        assert_eq!(written["enabled"], true);
        assert_eq!(written["mode"], "local");
        // 缺字段补默认
        assert_eq!(written["use_local_embedding"], true);
        let reread = read_settings(&dir);
        assert_eq!(reread["enabled"], true);
        assert_eq!(reread["use_local_memory"], true);
        // 覆盖写入
        let updated = write_settings(&dir, serde_json::json!({ "ollama_url": "http://localhost:11434" }));
        assert_eq!(updated["ollama_url"], "http://localhost:11434");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_default_when_missing() {
        let dir = std::env::temp_dir().join(format!("inkling-offline-def-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let s = read_settings(&dir);
        assert_eq!(s["enabled"], false);
        assert_eq!(s["mode"], "auto");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
