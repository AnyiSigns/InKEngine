//! 文件物理执行体（file 端点）：read/list/write——全部路径先过挂载根守门
//! （工作区根 + 动态挂载根），读/写有大小上界，目录列举有条目上界。
//!
//! 只承载机械 IO：不做授权门、不记台账（零裁决红线）；「哪个路径能读写」
//! 完全由信封现取的 roots 决定。

use std::path::PathBuf;

use serde_json::{Value as JsonValue, json};

use super::super::envelope::{
    Deny, Envelope, FILE_LIST_ENTRIES_MAX, FILE_READ_BYTES_MAX,
};

const MAX_WRITE_BYTES: u64 = 1 << 20;

/// 文件目标（守门产物：解析后的绝对路径 + 上界）。
struct FileTarget {
    path: PathBuf,
    max_chars: usize,
}

/// 守门：subop 形状 + path 根内解析 + 读大小预检（读前看元数据）。
fn prepare(envelope: &Envelope, need_existing: bool) -> Result<FileTarget, Deny> {
    let args = envelope
        .args
        .as_object()
        .ok_or_else(|| Deny::new("params", "file 的 args 须为对象"))?;
    let roots = super::super::guard::validate_roots(&envelope.roots)?;
    let target_text = args
        .get("path")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| Deny::new("params", "file 缺 path（须为字符串）"))?;
    let resolved = super::super::guard::resolve_within_roots(&roots, target_text)?;
    if need_existing && !resolved.exists() {
        return Err(Deny::new(
            "params",
            format!("路径不存在: {}", resolved.display()),
        ));
    }
    Ok(FileTarget {
        path: resolved,
        max_chars: envelope.max_chars as usize,
    })
}

/// 物理执行体入口（subop 分派）。
pub fn run(envelope: &Envelope) -> Result<JsonValue, Deny> {
    let args = envelope
        .args
        .as_object()
        .ok_or_else(|| Deny::new("params", "file 的 args 须为对象"))?;
    let subop = args
        .get("subop")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| Deny::new("params", "file 缺 subop（read/list/write）"))?;
    match subop {
        "read" => run_read(envelope),
        "list" => run_list(envelope),
        "write" => run_write(envelope),
        other => Err(Deny::new("params", format!("不支持的 file subop: {other}"))),
    }
}

/// read：元数据预检（>1 MiB 拒绝，fail-closed）+ 读取 + 字符截断带标记。
fn run_read(envelope: &Envelope) -> Result<JsonValue, Deny> {
    let target = prepare(envelope, true)?;
    let metadata = std::fs::metadata(&target.path)
        .map_err(|err| Deny::new("execution", format!("文件元数据读取失败: {err}")))?;
    if metadata.is_dir() {
        return Err(Deny::new("params", "目标为目录（file read 须指向文件）"));
    }
    if metadata.len() > FILE_READ_BYTES_MAX {
        return Err(Deny::new(
            "size",
            format!(
                "文件大小超限: {} > {} 字节",
                metadata.len(),
                FILE_READ_BYTES_MAX
            ),
        ));
    }
    let bytes = std::fs::read(&target.path)
        .map_err(|err| Deny::new("execution", format!("文件读取失败: {err}")))?;
    let text = String::from_utf8_lossy(&bytes);
    let (content, truncated) = truncate_with_flag(&text, target.max_chars);
    Ok(json!({
        "subop": "read",
        "content": content,
        "truncated": truncated,
        "bytes": bytes.len(),
    }))
}

/// list：目录列举（排序 + 条目上界；只回条目名与类型，不泄露绝对路径）。
fn run_list(envelope: &Envelope) -> Result<JsonValue, Deny> {
    let target = prepare(envelope, true)?;
    if !target.path.is_dir() {
        return Err(Deny::new("params", "目标不是目录（file list 须指向目录）"));
    }
    let entries = std::fs::read_dir(&target.path)
        .map_err(|err| Deny::new("execution", format!("目录读取失败: {err}")))?
        .filter_map(|entry| entry.ok())
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let kind = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                "dir"
            } else {
                "file"
            };
            json!({ "name": name, "kind": kind })
        })
        .collect::<Vec<JsonValue>>();
    if entries.len() > FILE_LIST_ENTRIES_MAX {
        return Err(Deny::new("size", format!("目录条目超限（≤{FILE_LIST_ENTRIES_MAX}）")));
    }
    Ok(json!({ "subop": "list", "entries": entries, "count": entries.len() }))
}

/// write：根内落盘（父目录按需创建，仍限在根内）；内容按字节上界拒绝。
fn run_write(envelope: &Envelope) -> Result<JsonValue, Deny> {
    let args = envelope
        .args
        .as_object()
        .ok_or_else(|| Deny::new("params", "file 的 args 须为对象"))?;
    let content = args
        .get("content")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| Deny::new("params", "file write 缺 content（须为字符串）"))?;
    let content_bytes = content.len() as u64;
    if content_bytes > MAX_WRITE_BYTES {
        return Err(Deny::new(
            "size",
            format!("写入内容超限: {content_bytes} > {MAX_WRITE_BYTES} 字节"),
        ));
    }
    let target = prepare(envelope, false)?;
    if target.path.is_dir() {
        return Err(Deny::new("params", "目标为目录（file write 须指向文件）"));
    }
    let parent = target
        .path
        .parent()
        .ok_or_else(|| Deny::new("params", "写入目标缺父目录"))?;
    std::fs::create_dir_all(parent)
        .map_err(|err| Deny::new("execution", format!("父目录创建失败: {err}")))?;
    std::fs::write(&target.path, content.as_bytes())
        .map_err(|err| Deny::new("execution", format!("文件写入失败: {err}")))?;
    Ok(json!({
        "subop": "write",
        "bytes": content_bytes,
    }))
}

/// 字符截断（返回是否被截断）。
fn truncate_with_flag(text: &str, max_chars: usize) -> (String, bool) {
    if text.chars().count() <= max_chars {
        return (text.to_string(), false);
    }
    let mut head: String = text.chars().take(max_chars).collect();
    head.push_str("…（已截断）");
    (head, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use uuid::Uuid;

    fn scratch_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ink-exec-file-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn envelope_for(root: &PathBuf, _subop: &str, args: JsonValue) -> Envelope {
        Envelope {
            version: 1,
            id: "op-file".into(),
            tool: "file_exec".into(),
            op: "file".into(),
            args,
            endpoint: "file".into(),
            roots: vec![root.to_string_lossy().into_owned()],
            allowlist: vec![],
            allow_domains: vec![],
            cwd: None,
            env: None,
            timeout_secs: 20,
            max_chars: 4096,
            nonce: "n".into(),
            issued_at: 1,
            decision: super::super::super::envelope::Decision {
                approved: true,
                by: "test".into(),
                trace_id: None,
            },
        }
    }

    #[test]
    fn write_then_read_roundtrip_within_root() {
        let dir = scratch_dir("rw");
        let path = dir.join("sub/nested/hello.txt");
        let write_env = envelope_for(
            &dir,
            "write",
            json!({ "subop": "write", "path": path.to_string_lossy(), "content": "hello 中文" }),
        );
        let written = run(&write_env).expect("写入成功");
        assert_eq!(written["bytes"], 12); // "hello 中文" UTF-8 字节数

        let read_env = envelope_for(
            &dir,
            "read",
            json!({ "subop": "read", "path": path.to_string_lossy() }),
        );
        let read = run(&read_env).expect("读取成功");
        assert_eq!(read["content"], "hello 中文");
        assert_eq!(read["truncated"], false);
    }

    #[test]
    fn read_outside_root_is_refused() {
        let dir = scratch_dir("outside");
        let outside = std::env::temp_dir().join("some-unrelated-file.txt");
        std::fs::write(&outside, b"x").unwrap();
        let env = envelope_for(
            &dir,
            "read",
            json!({ "subop": "read", "path": outside.to_string_lossy() }),
        );
        let deny = run(&env).expect_err("根外读取须拒绝");
        assert_eq!(deny.reason, "root");
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn dotdot_path_is_refused() {
        let dir = scratch_dir("dotdot");
        let path = dir.join("../../escape.txt");
        let env = envelope_for(
            &dir,
            "write",
            json!({ "subop": "write", "path": path.to_string_lossy(), "content": "x" }),
        );
        let deny = run(&env).expect_err("`..` 穿越须拒绝");
        assert_eq!(deny.reason, "root");
    }

    #[test]
    fn list_returns_sorted_entries() {
        let dir = scratch_dir("list");
        std::fs::write(dir.join("a.txt"), b"a").unwrap();
        std::fs::create_dir(dir.join("sub")).unwrap();
        let env = envelope_for(
            &dir,
            "list",
            json!({ "subop": "list", "path": dir.to_string_lossy() }),
        );
        let listed = run(&env).expect("列举成功");
        let entries = listed["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        let names: Vec<&str> = entries
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["a.txt", "sub"]);
    }
}
