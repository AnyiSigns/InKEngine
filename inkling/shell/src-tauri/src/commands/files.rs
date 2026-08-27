//! 文件/文档/资料/截图功能域命令面（doc_parse / doc_generate /
//! material_import / screenshot_capture）。

use serde_json::{json, Value as JsonValue};

use super::error::CommandError;
use crate::{DEFAULT_MOUNT_ROOT, expand_home};

/// 文档解析（PDF/Office → 结构化 JSON；与壳执行器同源域函数，路径根收口）。
#[tauri::command]
pub(crate) fn doc_parse(path: String) -> Result<JsonValue, CommandError> {
    let resolved = expand_home(&path);
    let bytes = std::fs::read(&resolved)
        .map_err(|err| CommandError::io(format!("读取文档失败: {err}")))?;
    crate::domain::doc_ops::parse_document(&bytes).map_err(CommandError::internal)
}

/// 文档生成（docx 报告 / xlsx 表格 → 落盘工作区根，返回路径与字节数）。
#[tauri::command]
pub(crate) fn doc_generate(
    format: String,
    title: String,
    body: Option<String>,
    table: Option<String>,
) -> Result<JsonValue, CommandError> {
    let bytes = match format.as_str() {
        "docx" => {
            use crate::domain::doc_ops::{build_docx_report, DocxReportSpec, DocxSection};
            let spec = DocxReportSpec {
                title: title.clone(),
                sections: vec![DocxSection {
                    heading: None,
                    body: body.unwrap_or_default(),
                }],
                table: None,
            };
            build_docx_report(&spec).map_err(CommandError::internal)?
        }
        "xlsx" => {
            use crate::domain::doc_ops::build_xlsx_table;
            let rows: Vec<Vec<String>> = table
                .and_then(|text| serde_json::from_str::<Vec<Vec<String>>>(&text).ok())
                .unwrap_or_default();
            build_xlsx_table(&title, &rows).map_err(CommandError::internal)?
        }
        other => return Err(CommandError::invalid_arg(format!("不支持的文档格式: {other}（docx/xlsx）"))),
    };
    let out_dir = expand_home(DEFAULT_MOUNT_ROOT);
    std::fs::create_dir_all(&out_dir).map_err(|err| CommandError::io(format!("输出目录创建失败: {err}")))?;
    let stamp = chrono::Utc::now().timestamp_millis();
    let safe_title: String = title
        .chars()
        .map(|ch| if ch.is_alphanumeric() || ch == '_' || ch == '-' { ch } else { '_' })
        .collect();
    let ext = if format == "xlsx" { "xlsx" } else { "docx" };
    let out_path = out_dir.join(format!("{safe_title}_{stamp}.{ext}"));
    std::fs::write(&out_path, &bytes)
        .map_err(|err| CommandError::io(format!("文档写入失败: {err}")))?;
    Ok(json!({
        "path": out_path.to_string_lossy(),
        "format": format,
        "bytes": bytes.len(),
    }))
}

/// 既有资料批量导入（搬进 InKEngine 第一步）：目录扫描归一 + 可选走样例闸门入料。
///
/// `ingest=false`（默认）= 仅扫描归一预览；`ingest=true` = 逐条目经既有样例闸门
/// / 知识集入料链（`patch.propose_knowledge`）入集，返回逐文件入料状态。
#[tauri::command]
pub(crate) async fn material_import(
    path: String,
    recursive: Option<bool>,
    ingest: Option<bool>,
) -> Result<JsonValue, CommandError> {
    let recursive = recursive.unwrap_or(false);
    let scan = crate::domain::import_material::scan_and_normalize(&path, recursive)
        .map_err(CommandError::internal)?;
    if !ingest.unwrap_or(false) {
        return serde_json::to_value(&scan).map_err(CommandError::internal);
    }
    let mut ingested = 0usize;
    let mut rejected = 0usize;
    let mut file_results: Vec<JsonValue> = Vec::with_capacity(scan.files.len());
    // A3：base_version = 集补丁链 head（补丁数 + 1；链记录读取失败回落 1）——
    // 补丁链推进后陈旧基版本会被引擎 fail-closed 拒绝，资料静默未入库
    let base_version = crate::domain::incubation::chain_head_version().await;
    for file in &scan.files {
        let format = file.format.clone();
        let entry = json!({
            "id": format!("material:{}", file.path),
            "level": "user",
            "kind": "insight",
            "data": { "content": file.normalized.clone(), "format": format },
            "source": file.path,
            "title": format!("导入资料：{}", file.path),
            "tags": ["material", format],
        });
        let schema_errs = crate::domain::incubation::entry_schema_errors(&entry);
        let injection = crate::domain::incubation::scan_entry_injection(&entry);
        if !schema_errs.is_empty() || !injection.is_empty() {
            rejected += 1;
            file_results.push(json!({
                "path": file.path,
                "status": "rejected",
                "reason": schema_errs.into_iter().chain(injection).collect::<Vec<_>>().join("; "),
            }));
            continue;
        }
        match crate::domain::incubation::propose_knowledge_patch(json!({
            "payload": { "entry": entry },
            "rationale": "既有资料批量导入（搬进 InKEngine）",
            "base_version": base_version,
        }))
        .await
        {
            Ok(_) => {
                ingested += 1;
                file_results.push(json!({ "path": file.path, "status": "ingested" }));
            }
            Err(err) => {
                rejected += 1;
                file_results.push(json!({ "path": file.path, "status": "rejected", "reason": err }));
            }
        }
    }
    Ok(json!({
        "scanned": scan.files.len(),
        "ingested": ingested,
        "rejected": rejected,
        "files": file_results,
    }))
}

/// 屏幕截图（隐私分级：本地直喂 / 云端默认禁外发，授权开关 + 审批回调，
/// 外发事件落审计；与壳执行器同源域函数）。
#[tauri::command]
pub(crate) fn screenshot_capture(
    model_class: String,
    destination: Option<String>,
) -> Result<JsonValue, CommandError> {
    use crate::domain::screenshot::{
        capture_and_feed, WindowsScreenCapturer, ModelClass, VisionGate, VisionSettings,
    };
    let model = match model_class.as_str() {
        "local" => ModelClass::Local,
        "cloud" => ModelClass::Cloud,
        other => return Err(CommandError::invalid_arg(format!("目标模型类别非法: {other}（local/cloud）"))),
    };
    let destination = destination.unwrap_or_else(|| "engine".to_string());
    let settings_path = expand_home("~/.inkling/vision.json");
    let settings = VisionSettings::load(&settings_path).unwrap_or_else(|_| VisionSettings::default());
    let gate = VisionGate {
        settings,
        approve: std::sync::Arc::new(|| false),
    };
    let out_dir = expand_home("~/.inkling/attachments");
    let capturer = WindowsScreenCapturer;
    let attachment = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| CommandError::internal(format!("截图运行时构建失败: {err}")))?
        .block_on(capture_and_feed(
            &capturer,
            &gate,
            model,
            &destination,
            &out_dir,
            &None,
        ))
        .map_err(CommandError::internal)?;
    Ok(attachment.to_dict())
}
