//! 语音命令面（能力探测 / 识别 / 合成 / 采集 / 设备清单）。

use serde_json::{json, Value as JsonValue};
use tauri::AppHandle;

use super::error::CommandError;
use crate::app_data_dir;

/// 语音能力探测（麦克风/STT/TTS 三项独立降级）。
#[tauri::command]
pub(crate) fn voice_status(app: AppHandle) -> JsonValue {
    let dir = app_data_dir(&app).ok();
    crate::domain::voice::capabilities(dir.as_deref())
}

/// 语音识别：音频（WAV 字节）→ 文本（模型缺失即报不可用降级）。
#[tauri::command]
pub(crate) async fn voice_transcribe(app: AppHandle, audio: Vec<u8>) -> Result<JsonValue, CommandError> {
    let dir = app_data_dir(&app).ok();
    let text = crate::domain::voice::transcribe(&audio, dir.as_deref())
        .await
        .map_err(CommandError::internal)?;
    Ok(json!({ "text": text, "available": true }))
}

/// 语音合成：Windows SAPI 朗读文本。
#[tauri::command]
pub(crate) fn voice_synthesize(text: String) -> Result<JsonValue, CommandError> {
    let spoken = crate::domain::voice::speak(&text).map_err(CommandError::internal)?;
    Ok(json!({ "spoken": spoken }))
}

/// 麦克风采集：录制指定毫秒数，返回 WAV 字节。
#[tauri::command]
pub(crate) fn voice_record(duration_ms: u32) -> Result<Vec<u8>, CommandError> {
    crate::domain::voice::record_wav(duration_ms).map_err(CommandError::internal)
}

/// 麦克风设备清单。
#[tauri::command]
pub(crate) fn voice_devices() -> JsonValue {
    crate::domain::voice::list_devices()
}
