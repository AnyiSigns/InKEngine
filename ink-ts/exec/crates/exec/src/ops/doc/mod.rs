//! 文档解析物理执行体（file 端点）：`doc.parse`——按魔数识别 PDF/OOXML
//! 并提取文本，输出 {format, text, page_count?, warnings?}。
//!
//! 零裁决红线：本模块只做机械解析，不判断「该不该解析哪个文件」——
//! 目标路径须落在信封 roots 内（host 裁决的挂载根）；体积超上界/非法
//! 输入/不支持格式一律 fail-closed（Deny 分类归因），不静默产出。
//!
//! 依赖纪律：解析语义参照旧壳 doc_ops.rs（PDF 魔数/内容流文本提取；
//! OOXML zip 中央目录 + docx/xlsx/pptx 文本提取），在 exec 内自行实现，
//! 不 import 壳 crate、不读策略文件。

use serde_json::{Value as JsonValue, json};

use crate::envelope::{Deny, Envelope};

pub mod office;
pub mod pdf;
pub mod xml;
pub mod zip;

/// 文档解析体积上限（字节；20MB，对齐旧壳 doc_ops/附件导入口径）。
/// 读前 stat 先行拦截，超大文件不整包读入内存。
pub const MAX_DOC_BYTES: u64 = 20 * 1024 * 1024;

/// 文档格式识别产物。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocFormat {
    Pdf,
    Docx,
    Xlsx,
    Pptx,
}

/// 按文件头魔数识别格式（空输入/无法识别 = None）。
pub fn detect_format(bytes: &[u8]) -> Option<DocFormat> {
    if bytes.is_empty() {
        return None;
    }
    if pdf::has_pdf_header(bytes) {
        return Some(DocFormat::Pdf);
    }
    if bytes.starts_with(b"PK\x03\x04") {
        if let Ok(entries) = zip::list_entries(bytes) {
            let has = |prefix: &str| entries.iter().any(|e| e.name.starts_with(prefix));
            if has("word/") {
                return Some(DocFormat::Docx);
            }
            if has("xl/") {
                return Some(DocFormat::Xlsx);
            }
            if has("ppt/") {
                return Some(DocFormat::Pptx);
            }
        }
    }
    None
}

/// 解析产物（文本 + 可选的页数）。
struct Parsed {
    format: &'static str,
    text: String,
    page_count: Option<usize>,
}

/// 解析文档字节（识别 → 分发 → 文本行拼装）。
fn parse_bytes(bytes: &[u8]) -> Result<Parsed, Deny> {
    let format = detect_format(bytes)
        .ok_or_else(|| Deny::new("format", "无法识别的文档格式（仅 pdf/docx/xlsx/pptx）"))?;
    match format {
        DocFormat::Pdf => {
            let doc = pdf::extract_pdf(bytes)
                .map_err(|err| Deny::new("format", format!("{:?}: {}", err.kind, err.message)))?;
            Ok(Parsed {
                format: "pdf",
                text: doc.pages.join("\n\n"),
                page_count: Some(doc.page_count),
            })
        }
        DocFormat::Docx => Ok(Parsed {
            format: "docx",
            text: office::docx_text(bytes)?.join("\n"),
            page_count: None,
        }),
        DocFormat::Xlsx => Ok(Parsed {
            format: "xlsx",
            text: office::xlsx_text(bytes)?.join("\n"),
            page_count: None,
        }),
        DocFormat::Pptx => Ok(Parsed {
            format: "pptx",
            text: office::pptx_text(bytes)?.join("\n"),
            page_count: None,
        }),
    }
}

/// 物理执行体入口（subop 分派）。
pub fn run(envelope: &Envelope) -> Result<JsonValue, Deny> {
    let args = envelope
        .args
        .as_object()
        .ok_or_else(|| Deny::new("params", "doc 的 args 须为对象"))?;
    let subop = args
        .get("subop")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| Deny::new("params", "doc 缺 subop（parse）"))?;
    match subop {
        "parse" => run_parse(envelope),
        other => Err(Deny::new("params", format!("不支持的 doc subop: {other}"))),
    }
}

/// parse：根内路径 → stat 预检 → 读入 → 解析 → 文本截断（带标记）。
fn run_parse(envelope: &Envelope) -> Result<JsonValue, Deny> {
    let args = envelope
        .args
        .as_object()
        .ok_or_else(|| Deny::new("params", "doc 的 args 须为对象"))?;
    let roots = crate::guard::validate_roots(&envelope.roots)?;
    let target_text = args
        .get("path")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| Deny::new("params", "doc.parse 缺 path（须为字符串）"))?;
    let path = crate::guard::resolve_within_roots(&roots, target_text)?;
    let metadata = std::fs::metadata(&path)
        .map_err(|err| Deny::new("params", format!("文档元数据读取失败: {err}")))?;
    if metadata.is_dir() {
        return Err(Deny::new("params", "目标为目录（doc.parse 须指向文件）"));
    }
    if metadata.len() > MAX_DOC_BYTES {
        return Err(Deny::new(
            "size",
            format!(
                "文档体积超解析上限（≤{}MB）: {} > {}",
                MAX_DOC_BYTES / (1024 * 1024),
                metadata.len(),
                MAX_DOC_BYTES
            ),
        ));
    }
    let bytes = std::fs::read(&path)
        .map_err(|err| Deny::new("execution", format!("文档读取失败: {err}")))?;
    let parsed = parse_bytes(&bytes)?;
    let (text, truncated) = truncate_chars(&parsed.text, envelope.max_chars as usize);
    let mut warnings: Vec<String> = Vec::new();
    if truncated {
        warnings.push(format!("输出文本超上限截断（≤{} 字符）", envelope.max_chars));
    }
    let mut out = json!({
        "subop": "parse",
        "format": parsed.format,
        "text": text,
        "warnings": warnings,
        "truncated": truncated,
    });
    if let Some(page_count) = parsed.page_count {
        out["page_count"] = JsonValue::from(page_count);
    }
    Ok(out)
}

/// 字符截断（返回是否被截断）。
fn truncate_chars(text: &str, max_chars: usize) -> (String, bool) {
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
    use std::path::PathBuf;
    use uuid::Uuid;

    fn scratch_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ink-exec-doc-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn envelope_for(root: &PathBuf, path: &std::path::Path) -> Envelope {
        Envelope {
            version: 1,
            id: "op-doc".into(),
            tool: "doc_parse".into(),
            op: "doc".into(),
            args: json!({ "subop": "parse", "path": path.to_string_lossy() }),
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
            decision: crate::envelope::Decision {
                approved: true,
                by: "test".into(),
                trace_id: None,
            },
        }
    }

    fn make_pdf(use_flate: bool) -> Vec<u8> {
        let content =
            b"BT\n1 0 0 1 50 750 Tm\n(First line of text) Tj\n0 -20 Td\n(Second line) Tj\nET";
        let (dict, payload): (String, Vec<u8>) = if use_flate {
            use flate2::write::ZlibEncoder;
            use flate2::Compression;
            use std::io::Write;
            let mut e = ZlibEncoder::new(Vec::new(), Compression::default());
            e.write_all(content).unwrap();
            let comp = e.finish().unwrap();
            (format!("/Filter /FlateDecode /Length {}", comp.len()), comp)
        } else {
            (format!("/Length {}", content.len()), content.to_vec())
        };
        let mut pdf = Vec::new();
        pdf.extend_from_slice(b"%PDF-1.4\n");
        pdf.extend_from_slice(b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n");
        pdf.extend_from_slice(b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n");
        pdf.extend_from_slice(
            b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R>>endobj\n",
        );
        pdf.extend_from_slice(b"4 0 obj<<");
        pdf.extend_from_slice(dict.as_bytes());
        pdf.extend_from_slice(b">>stream\n");
        pdf.extend_from_slice(&payload);
        pdf.extend_from_slice(b"\nendstream endobj\n%%EOF\n");
        pdf
    }

    fn make_docx() -> Vec<u8> {
        let xml = r#"<w:document xmlns:w="x"><w:body>
            <w:p><w:r><w:t>标题段落</w:t></w:r></w:p>
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        </w:body></w:document>"#;
        let owned = vec![("word/document.xml".to_string(), xml.as_bytes())];
        zip::store_entries(&owned)
    }

    #[test]
    fn format_detection_by_magic() {
        assert_eq!(detect_format(&make_pdf(false)), Some(DocFormat::Pdf));
        assert_eq!(detect_format(&make_pdf(true)), Some(DocFormat::Pdf));
        assert_eq!(detect_format(&make_docx()), Some(DocFormat::Docx));
        let xlsx = zip::store_entries(&vec![(
            "xl/workbook.xml".to_string(),
            b"<x/>" as &[u8],
        )]);
        assert_eq!(detect_format(&xlsx), Some(DocFormat::Xlsx));
        assert_eq!(detect_format(b""), None);
        assert_eq!(detect_format(b"plain bytes"), None);
    }

    #[test]
    fn parse_pdf_sample_within_root() {
        let dir = scratch_dir("pdf");
        let path = dir.join("sample.pdf");
        std::fs::write(&path, make_pdf(false)).unwrap();
        let value = run(&envelope_for(&dir, &path)).expect("PDF 解析成功");
        assert_eq!(value["format"], "pdf");
        assert_eq!(value["page_count"], 1);
        assert!(value["text"].as_str().unwrap().contains("First line of text"));
        assert!(value["text"].as_str().unwrap().contains("Second line"));
        assert_eq!(value["truncated"], false);
    }

    #[test]
    fn parse_flate_pdf_within_root() {
        let dir = scratch_dir("pdf-flate");
        let path = dir.join("sample.pdf");
        std::fs::write(&path, make_pdf(true)).unwrap();
        let value = run(&envelope_for(&dir, &path)).expect("flate PDF 解析成功");
        assert!(value["text"].as_str().unwrap().contains("First line of text"));
    }

    #[test]
    fn parse_docx_sample_within_root() {
        let dir = scratch_dir("docx");
        let path = dir.join("sample.docx");
        std::fs::write(&path, make_docx()).unwrap();
        let value = run(&envelope_for(&dir, &path)).expect("docx 解析成功");
        assert_eq!(value["format"], "docx");
        let text = value["text"].as_str().unwrap();
        assert!(text.contains("标题段落"));
        assert!(text.contains("A1\tB1"));
        assert!(value.get("page_count").is_none());
    }

    #[test]
    fn unknown_format_is_fail_closed() {
        let dir = scratch_dir("unknown");
        let path = dir.join("blob.bin");
        std::fs::write(&path, b"not a document").unwrap();
        let deny = run(&envelope_for(&dir, &path)).expect_err("非法文档须拒绝");
        assert_eq!(deny.reason, "format");
    }

    #[test]
    fn oversized_document_is_refused() {
        let dir = scratch_dir("oversize");
        let path = dir.join("big.pdf");
        let bytes = vec![0u8; (MAX_DOC_BYTES + 1) as usize];
        std::fs::write(&path, &bytes).unwrap();
        let deny = run(&envelope_for(&dir, &path)).expect_err("超大文档须拒绝");
        assert_eq!(deny.reason, "size");
    }

    #[test]
    fn out_of_root_path_is_refused() {
        let dir = scratch_dir("outside");
        let outside = std::env::temp_dir().join(format!("ink-exec-doc-outside-{}.pdf", Uuid::new_v4()));
        std::fs::write(&outside, make_pdf(false)).unwrap();
        let deny = run(&envelope_for(&dir, &outside)).expect_err("根外路径须拒绝");
        assert_eq!(deny.reason, "root");
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn missing_path_is_refused() {
        let dir = scratch_dir("missing");
        let path = dir.join("nope.pdf");
        let deny = run(&envelope_for(&dir, &path)).expect_err("缺失文件须拒绝");
        assert_eq!(deny.reason, "params");
    }

    #[test]
    fn text_is_truncated_with_marker() {
        let dir = scratch_dir("truncate");
        let path = dir.join("sample.pdf");
        std::fs::write(&path, make_pdf(false)).unwrap();
        let mut env = envelope_for(&dir, &path);
        env.max_chars = 10;
        let value = run(&env).expect("解析成功");
        assert_eq!(value["truncated"], true);
        assert!(value["text"].as_str().unwrap().contains("（已截断）"));
        let warnings = value["warnings"].as_array().unwrap();
        assert!(warnings.iter().any(|w| w.as_str().unwrap().contains("截断")));
    }
}
