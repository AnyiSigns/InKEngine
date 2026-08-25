//! 多模态视觉域：截图采集（Win32 FFI）+ 隐私分级（本地直喂 / 云端禁外发）
//! + 外发审计留痕。
//!
//! 截图采集经 Win32 BitBlt/PrintWindow 风格 FFI 截屏，存为本地图片文件，
//! 输出引擎既有 Attachment 序列化形态（kind=image，url/path 引用）。
//!
//! 隐私分级（安全属性，默认禁外发）：
//! - 本地多模态模型可直喂截图（不出网）；
//! - 云端模型默认禁止截图外发（屏幕内容不出网）——仅当用户显式授权
//!   （设置持久化）且每次外发经审批确认，才放开；
//! - 任何截图外发事件经审计流留痕（复用既有 device_sensed 事件类型与
//!   records 通道），可审计。
//!
//! 失败路径 fail-closed：截屏 FFI 失败、分级拒绝、审批拒绝均不产出
//! 外发附件、不调用下游模型。采集器与审批可注入（测试 mock）。
//!
//! 依赖纪律：本模块不直接调用其它域模块；审计经注入的 AuditSink 通道
//! 落库（与 env 域同一通道形态），采集器可注入（测试免真实桌面）。

use std::ffi::{c_int, c_void};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value as JsonValue;

use super::common::DomainError;

// ── 附件（引擎 Attachment 序列化契约：kind=image + url/path）──

/// 截图附件（序列化形态对齐引擎 llm Attachment：kind=image，引用 url/path）。
#[derive(Debug, Clone, PartialEq)]
pub struct VisionAttachment {
    pub kind: String,
    pub url: Option<String>,
    pub path: Option<String>,
    pub mime_type: Option<String>,
    pub alt: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub name: Option<String>,
}

impl VisionAttachment {
    /// 序列化为引擎 Attachment 形态（缺省字段回落 null，引用缺失由调用方保证）。
    pub fn to_dict(&self) -> JsonValue {
        let mut obj = serde_json::Map::new();
        obj.insert("kind".to_string(), JsonValue::String(self.kind.clone()));
        obj.insert("url".to_string(), opt_str(&self.url));
        obj.insert("path".to_string(), opt_str(&self.path));
        obj.insert("mime_type".to_string(), opt_str(&self.mime_type));
        obj.insert("alt".to_string(), opt_str(&self.alt));
        obj.insert("width".to_string(), opt_u32(&self.width));
        obj.insert("height".to_string(), opt_u32(&self.height));
        obj.insert("name".to_string(), opt_str(&self.name));
        JsonValue::Object(obj)
    }
}

fn opt_str(value: &Option<String>) -> JsonValue {
    match value {
        Some(v) => JsonValue::String(v.clone()),
        None => JsonValue::Null,
    }
}

fn opt_u32(value: &Option<u32>) -> JsonValue {
    match value {
        Some(v) => JsonValue::from(*v as u64),
        None => JsonValue::Null,
    }
}

// ── 采集错误（失败路径统一形态，fail-closed）──

/// 截屏采集失败（消息为产品可读的失败原因；结果文本与日志共用）。
#[derive(Debug, Clone)]
pub struct CaptureError(pub String);

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CaptureError {}

// ── 采集器（可注入；测试用 stub 免真实桌面）──

/// 屏幕采集器（截屏 → 图片字节；失败返回 CaptureError，fail-closed）。
pub trait ScreenCapturer: Send + Sync {
    fn capture(&self) -> Result<Vec<u8>, CaptureError>;
}

/// Win32 BitBlt/PrintWindow 风格默认采集器（链接系统 user32/gdi32）。
pub struct WindowsScreenCapturer;

impl ScreenCapturer for WindowsScreenCapturer {
    fn capture(&self) -> Result<Vec<u8>, CaptureError> {
        capture_desktop_bmp().map_err(CaptureError)
    }
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
unsafe extern "system" {
    fn GetDesktopWindow() -> *mut c_void;
    fn GetWindowDC(hwnd: *mut c_void) -> *mut c_void;
    fn ReleaseDC(hwnd: *mut c_void, hdc: *mut c_void) -> c_int;
    fn GetSystemMetrics(n_index: c_int) -> c_int;
}

#[cfg(target_os = "windows")]
#[link(name = "gdi32")]
unsafe extern "system" {
    fn CreateCompatibleDC(hdc: *mut c_void) -> *mut c_void;
    fn CreateCompatibleBitmap(hdc: *mut c_void, cx: c_int, cy: c_int) -> *mut c_void;
    fn SelectObject(hdc: *mut c_void, h: *mut c_void) -> *mut c_void;
    fn BitBlt(
        hdc: *mut c_void,
        x: c_int,
        y: c_int,
        cx: c_int,
        cy: c_int,
        srchdc: *mut c_void,
        sx: c_int,
        sy: c_int,
        rop: u32,
    ) -> c_int;
    fn DeleteObject(h: *mut c_void) -> c_int;
    fn DeleteDC(hdc: *mut c_void) -> c_int;
    fn GetDIBits(
        hdc: *mut c_void,
        hbmp: *mut c_void,
        u_start_scan: u32,
        c_scan_lines: u32,
        lpv_bits: *mut c_void,
        bmi: *mut BITMAPINFOHEADER,
        usage: u32,
    ) -> c_int;
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct BITMAPINFOHEADER {
    bi_size: u32,
    bi_width: c_int,
    bi_height: c_int,
    bi_planes: u16,
    bi_bit_count: u16,
    bi_compression: u32,
    bi_size_image: u32,
    bi_x_pels_per_meter: c_int,
    bi_y_pels_per_meter: c_int,
    bi_clr_used: u32,
    bi_clr_important: u32,
}

#[cfg(target_os = "windows")]
fn capture_desktop_bmp() -> Result<Vec<u8>, String> {
    const SRCCOPY: u32 = 0x00CC0020;
    unsafe {
        let hwnd = GetDesktopWindow();
        let hdc = GetWindowDC(hwnd);
        if hdc.is_null() {
            return Err("获取桌面 DC 失败".to_string());
        }
        let w = GetSystemMetrics(0);
        let h = GetSystemMetrics(1);
        if w <= 0 || h <= 0 {
            ReleaseDC(hwnd, hdc);
            return Err("获取屏幕尺寸失败".to_string());
        }
        let hmem = CreateCompatibleDC(hdc);
        let hbmp = CreateCompatibleBitmap(hdc, w, h);
        if hmem.is_null() || hbmp.is_null() {
            if !hmem.is_null() {
                DeleteDC(hmem);
            }
            if !hbmp.is_null() {
                DeleteObject(hbmp);
            }
            ReleaseDC(hwnd, hdc);
            return Err("创建兼容位图失败".to_string());
        }
        let old = SelectObject(hmem, hbmp);
        let ok = BitBlt(hmem, 0, 0, w, h, hdc, 0, 0, SRCCOPY) != 0;
        SelectObject(hmem, old);
        ReleaseDC(hwnd, hdc);
        if !ok {
            DeleteObject(hbmp);
            DeleteDC(hmem);
            return Err("BitBlt 截屏失败".to_string());
        }
        let stride = w * 4;
        let mut header = BITMAPINFOHEADER {
            bi_size: 40,
            bi_width: w,
            bi_height: h, // 正值 = 自下而上（标准 BMP）
            bi_planes: 1,
            bi_bit_count: 32,
            bi_compression: 0,
            bi_size_image: (stride * h) as u32,
            bi_x_pels_per_meter: 0,
            bi_y_pels_per_meter: 0,
            bi_clr_used: 0,
            bi_clr_important: 0,
        };
        let mut buf: Vec<u8> = vec![0u8; (stride as usize) * (h as usize)];
        let got = GetDIBits(
            hmem,
            hbmp,
            0,
            h as u32,
            buf.as_mut_ptr() as *mut c_void,
            &mut header as *mut BITMAPINFOHEADER,
            0,
        );
        DeleteObject(hbmp);
        DeleteDC(hmem);
        if got == 0 {
            return Err("获取位图像素失败".to_string());
        }
        Ok(bmp_file(&buf, w as u32, h as u32))
    }
}

#[cfg(target_os = "windows")]
fn bmp_file(pixels: &[u8], w: u32, h: u32) -> Vec<u8> {
    let file_header_size = 14u32;
    let info_header_size = 40u32;
    let off_bits = file_header_size + info_header_size;
    let pixel_bytes = w * 4 * h;
    let file_size = off_bits + pixel_bytes;
    let mut out = Vec::with_capacity(file_size as usize);
    out.extend_from_slice(&0x4D42u16.to_le_bytes()); // 'BM'
    out.extend_from_slice(&file_size.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&off_bits.to_le_bytes());
    out.extend_from_slice(&info_header_size.to_le_bytes());
    out.extend_from_slice(&(w as i32).to_le_bytes());
    out.extend_from_slice(&(h as i32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&pixel_bytes.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(pixels);
    out
}

#[cfg(not(target_os = "windows"))]
fn capture_desktop_bmp() -> Result<Vec<u8>, String> {
    Err("非 Windows 平台不支持 BitBlt 截屏".to_string())
}

// ── 隐私分级（授权开关 + 模型类别 + 每发审批）──

/// 模型类别（决定截图是否出网）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelClass {
    /// 本地多模态模型（截图不出网，可直喂）。
    Local,
    /// 云端模型（截图内容不应出网）。
    Cloud,
}

impl ModelClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Cloud => "cloud",
        }
    }
}

/// 外发决策（allow = 可直喂 / deny = 禁止外发）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportDecision {
    Allow,
    Deny,
}

/// 云端默认禁外发原因（fail-closed 默认禁外发）。
pub const EXPORT_DENY_REASON: &str = "云端模型默认禁止截图外发（屏幕内容不出网）";

/// 视觉授权设置（持久化态：是否显式授权截图外发）。
#[derive(Debug, Clone, PartialEq)]
pub struct VisionSettings {
    pub screenshot_export_authorized: bool,
}

impl VisionSettings {
    /// 默认未授权（fail-closed：默认禁止截图外发）。
    pub fn default() -> Self {
        Self {
            screenshot_export_authorized: false,
        }
    }

    /// 从 JSON 文件载入（缺失/非法回落默认未授权态，不崩溃）。
    pub fn load(path: &Path) -> Result<Self, DomainError> {
        match std::fs::read_to_string(path) {
            Ok(text) => match serde_json::from_str::<JsonValue>(&text) {
                Ok(value) => Ok(Self {
                    screenshot_export_authorized: value
                        .get("screenshot_export_authorized")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                }),
                Err(err) => Err(DomainError::Storage(format!("视觉设置解析失败: {err}"))),
            },
            Err(_) => Ok(Self::default()),
        }
    }

    /// 持久化到 JSON 文件（显式授权态落地，可审计）。
    pub fn save(&self, path: &Path) -> Result<(), DomainError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| DomainError::Storage(format!("视觉设置目录创建失败: {e}")))?;
        }
        let data = serde_json::json!({
            "screenshot_export_authorized": self.screenshot_export_authorized,
        });
        std::fs::write(path, data.to_string())
            .map_err(|e| DomainError::Storage(format!("视觉设置写入失败: {e}")))
    }
}

/// 每发审批回调（注入；返回 true = 用户批准外发）。
pub type ApprovalFn = Arc<dyn Fn() -> bool + Send + Sync>;

/// 视觉分级闸门（授权开关 + 模型类别判定）。
pub struct VisionGate {
    pub settings: VisionSettings,
    pub approve: ApprovalFn,
}

impl VisionGate {
    /// 授权档判定：本地直喂 allow；云端仅授权后 allow（不含每发审批）。
    pub fn classify(&self, model: ModelClass) -> ExportDecision {
        match model {
            ModelClass::Local => ExportDecision::Allow,
            ModelClass::Cloud => {
                if self.settings.screenshot_export_authorized {
                    ExportDecision::Allow
                } else {
                    ExportDecision::Deny
                }
            }
        }
    }
}

/// 审计落库通道（与 env 域同形态：异步闭包追加记录）。
pub type AuditSink =
    Arc<dyn Fn(JsonValue) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// 复用既有事件类型（device_sensed）与 records 通道（vision_audit 集合）。
pub const VISION_AUDIT_EVENT_TYPE: &str = "device_sensed";
pub const VISION_AUDIT_COLLECTION: &str = "vision_audit";

fn now_epoch() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// 写截图字节到本地文件，产出引擎 Attachment 形态。
fn write_attachment(bytes: &[u8], out_dir: &Path) -> Result<VisionAttachment, DomainError> {
    std::fs::create_dir_all(out_dir)
        .map_err(|e| DomainError::Storage(format!("截图目录创建失败: {e}")))?;
    let name = format!("screenshot_{:.3}.bmp", now_epoch());
    let path = out_dir.join(&name);
    std::fs::write(&path, bytes)
        .map_err(|e| DomainError::Storage(format!("截图写入失败: {e}")))?;
    let url = format!("file:///{}", path.to_string_lossy().replace('\\', "/"));
    Ok(VisionAttachment {
        kind: "image".to_string(),
        url: Some(url),
        path: Some(path.to_string_lossy().into_owned()),
        mime_type: Some("image/bmp".to_string()),
        alt: Some("屏幕截图".to_string()),
        width: None,
        height: None,
        name: Some(name),
    })
}

async fn emit_audit(audit: &Option<AuditSink>, record: JsonValue) {
    if let Some(sink) = audit {
        sink(record).await;
    }
}

/// 采集 + 分级 + 落审计：截图 → 附件（仅在允许时）。
///
/// 失败路径 fail-closed：截屏 FFI 失败、云端未授权、审批拒绝均返回错误，
/// 不产出外发附件、不调用下游模型；外发事件经审计流留痕（复用既有
/// device_sensed 事件类型）。
pub async fn capture_and_feed(
    capturer: &dyn ScreenCapturer,
    gate: &VisionGate,
    model: ModelClass,
    destination: &str,
    out_dir: &Path,
    audit: &Option<AuditSink>,
) -> Result<VisionAttachment, DomainError> {
    // ① 采集（失败 = fail-closed，无外发、无审计）
    let bytes = capturer
        .capture()
        .map_err(|e| DomainError::External(e.0.clone()))?;

    match model {
        ModelClass::Local => {
            // 本地多模态直喂（不出网）：存文件 → 附件 → 记 capture 审计
            let attachment = write_attachment(&bytes, out_dir)?;
            emit_audit(
                audit,
                export_record("capture", model, destination, true, ""),
            )
            .await;
            Ok(attachment)
        }
        ModelClass::Cloud => {
            if gate.settings.screenshot_export_authorized {
                if (gate.approve)() {
                    let attachment = write_attachment(&bytes, out_dir)?;
                    emit_audit(
                        audit,
                        export_record("export", model, destination, true, ""),
                    )
                    .await;
                    Ok(attachment)
                } else {
                    emit_audit(
                        audit,
                        export_record(
                            "export",
                            model,
                            destination,
                            false,
                            "用户拒绝截图外发审批",
                        ),
                    )
                    .await;
                    Err(DomainError::Other("用户拒绝截图外发审批".to_string()))
                }
            } else {
                emit_audit(
                    audit,
                    export_record("export", model, destination, false, EXPORT_DENY_REASON),
                )
                .await;
                Err(DomainError::Other(EXPORT_DENY_REASON.to_string()))
            }
        }
    }
}

/// 构造截图外发/采集审计记录（复用 device_sensed 事件类型 + records 通道）。
fn export_record(
    action: &str,
    model: ModelClass,
    destination: &str,
    allowed: bool,
    reason: &str,
) -> JsonValue {
    let mut record = serde_json::json!({
        "collection": VISION_AUDIT_COLLECTION,
        "type": VISION_AUDIT_EVENT_TYPE,
        "sensor": "screen",
        "action": action,
        "model": model.as_str(),
        "destination": destination,
        "allowed": allowed,
        "ts": now_epoch(),
    });
    if !reason.is_empty() {
        record["reason"] = JsonValue::String(reason.to_string());
    }
    record
}

// ── 单测 ──

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: Future>(fut: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(fut)
    }

    struct StubCapturer {
        result: Result<Vec<u8>, CaptureError>,
    }

    impl ScreenCapturer for StubCapturer {
        fn capture(&self) -> Result<Vec<u8>, CaptureError> {
            self.result.clone()
        }
    }

    fn collecting_sink() -> (AuditSink, Arc<Mutex<Vec<JsonValue>>>) {
        let records: Arc<Mutex<Vec<JsonValue>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: AuditSink = {
            let records = records.clone();
            Arc::new(move |v: JsonValue| {
                let records = records.clone();
                Box::pin(async move {
                    records.lock().unwrap().push(v);
                })
            })
        };
        (sink, records)
    }

    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ink_vision_test_{}", uuid_simple()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn uuid_simple() -> String {
        // 轻量唯一名（测试隔离）；不引第三方
        let n = now_epoch();
        format!("{n:.6}")
    }

    #[test]
    fn classify_local_always_allowed() {
        let gate = VisionGate {
            settings: VisionSettings::default(),
            approve: Arc::new(|| true),
        };
        assert_eq!(gate.classify(ModelClass::Local), ExportDecision::Allow);
    }

    #[test]
    fn classify_cloud_default_denied() {
        let gate = VisionGate {
            settings: VisionSettings::default(),
            approve: Arc::new(|| true),
        };
        assert_eq!(gate.classify(ModelClass::Cloud), ExportDecision::Deny);
    }

    #[test]
    fn classify_cloud_authorized_allowed() {
        let gate = VisionGate {
            settings: VisionSettings {
                screenshot_export_authorized: true,
            },
            approve: Arc::new(|| true),
        };
        assert_eq!(gate.classify(ModelClass::Cloud), ExportDecision::Allow);
    }

    #[test]
    fn settings_persistence_round_trip() {
        let dir = tmp_dir();
        let path = dir.join("vision_settings.json");
        let settings = VisionSettings {
            screenshot_export_authorized: true,
        };
        settings.save(&path).unwrap();
        let loaded = VisionSettings::load(&path).unwrap();
        assert_eq!(loaded, settings);
        // 缺省未授权（fail-closed）
        let defaulted = VisionSettings::load(&dir.join("missing.json")).unwrap();
        assert!(!defaulted.screenshot_export_authorized);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn capture_failure_is_fail_closed() {
        let capturer = StubCapturer {
            result: Err(CaptureError("FFI 失败".to_string())),
        };
        let gate = VisionGate {
            settings: VisionSettings::default(),
            approve: Arc::new(|| true),
        };
        let (sink, records) = collecting_sink();
        let out = block_on(capture_and_feed(
            &capturer,
            &gate,
            ModelClass::Cloud,
            "cloud-model",
            &tmp_dir(),
            &Some(sink),
        ));
        assert!(out.is_err(), "截屏失败必须 fail-closed 拒绝");
        // 采集失败不产生任何外发审计（无外发事件发生）
        let exported: Vec<JsonValue> = records
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.get("action").and_then(|v| v.as_str()) == Some("export"))
            .cloned()
            .collect();
        assert!(exported.is_empty());
    }

    #[test]
    fn cloud_unauthorized_records_denied_export() {
        let capturer = StubCapturer {
            result: Ok(vec![1, 2, 3, 4]),
        };
        let gate = VisionGate {
            settings: VisionSettings::default(), // 未授权
            approve: Arc::new(|| true),
        };
        let (sink, records) = collecting_sink();
        let out = block_on(capture_and_feed(
            &capturer,
            &gate,
            ModelClass::Cloud,
            "cloud-model",
            &tmp_dir(),
            &Some(sink),
        ));
        assert!(out.is_err());
        let exported: Vec<JsonValue> = records
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.get("action").and_then(|v| v.as_str()) == Some("export"))
            .cloned()
            .collect();
        assert_eq!(exported.len(), 1);
        assert_eq!(exported[0]["allowed"], JsonValue::Bool(false));
        assert_eq!(
            exported[0]["type"],
            JsonValue::String(VISION_AUDIT_EVENT_TYPE.to_string())
        );
        assert_eq!(
            exported[0]["collection"],
            JsonValue::String(VISION_AUDIT_COLLECTION.to_string())
        );
    }

    #[test]
    fn cloud_authorized_but_approval_rejected() {
        let capturer = StubCapturer {
            result: Ok(vec![1, 2, 3, 4]),
        };
        let gate = VisionGate {
            settings: VisionSettings {
                screenshot_export_authorized: true,
            },
            approve: Arc::new(|| false), // 用户拒绝
        };
        let (sink, records) = collecting_sink();
        let out = block_on(capture_and_feed(
            &capturer,
            &gate,
            ModelClass::Cloud,
            "cloud-model",
            &tmp_dir(),
            &Some(sink),
        ));
        assert!(out.is_err());
        let exported: Vec<JsonValue> = records
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.get("action").and_then(|v| v.as_str()) == Some("export"))
            .cloned()
            .collect();
        assert_eq!(exported.len(), 1);
        assert_eq!(exported[0]["allowed"], JsonValue::Bool(false));
    }

    #[test]
    fn cloud_authorized_and_approved_produces_attachment_and_audit() {
        let capturer = StubCapturer {
            result: Ok(vec![1, 2, 3, 4]),
        };
        let gate = VisionGate {
            settings: VisionSettings {
                screenshot_export_authorized: true,
            },
            approve: Arc::new(|| true),
        };
        let (sink, records) = collecting_sink();
        let out = block_on(capture_and_feed(
            &capturer,
            &gate,
            ModelClass::Cloud,
            "cloud-model",
            &tmp_dir(),
            &Some(sink),
        ));
        let attachment = out.expect("授权+批准应产出附件");
        assert_eq!(attachment.kind, "image");
        assert!(attachment.path.is_some());
        assert!(attachment.url.is_some());
        // 外发审计：allowed=true，复用 device_sensed 事件类型
        let exported: Vec<JsonValue> = records
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.get("action").and_then(|v| v.as_str()) == Some("export"))
            .cloned()
            .collect();
        assert_eq!(exported.len(), 1);
        assert_eq!(exported[0]["allowed"], JsonValue::Bool(true));
        assert_eq!(
            exported[0]["type"],
            JsonValue::String(VISION_AUDIT_EVENT_TYPE.to_string())
        );
    }

    #[test]
    fn local_model_fed_directly_with_capture_audit() {
        let capturer = StubCapturer {
            result: Ok(vec![1, 2, 3, 4]),
        };
        let gate = VisionGate {
            settings: VisionSettings::default(),
            approve: Arc::new(|| false), // 本地直喂不需要审批
        };
        let (sink, records) = collecting_sink();
        let out = block_on(capture_and_feed(
            &capturer,
            &gate,
            ModelClass::Local,
            "local-model",
            &tmp_dir(),
            &Some(sink),
        ));
        let attachment = out.expect("本地直喂应产出附件");
        assert_eq!(attachment.kind, "image");
        // 本地不产生 export 审计，只有 capture 审计
        let exported: Vec<JsonValue> = records
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.get("action").and_then(|v| v.as_str()) == Some("export"))
            .cloned()
            .collect();
        assert!(exported.is_empty());
    }
}
