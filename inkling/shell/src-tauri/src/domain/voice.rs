//! 本地语音域：麦克风采集（Windows waveIn）+ STT（whisper ONNX 推理，
//! 与 granite-97m 同构嵌入链）+ TTS（Windows SAPI，零新依赖）。
//!
//! 模型落位（与嵌入链同构）：
//! - 开发形态默认目录 = `inkling/models/whisper`（相对进程 CWD）；
//! - 捆绑形态 = `data_dir/assets/whisper`（首启由 resources/whisper 解包）；
//! - 显式覆盖 = `INK_VOICE_MODEL_DIR` 环境变量。
//! - 文件：`model_q8.onnx`（int8 量化图）、`tokenizer.json`（whisper BPE）、
//!   `config.json`（sample_rate / eot_token_id 等机器可读声明）。
//!
//! 降级：模型目录/文件缺失 → STT 不可用（capabilities.stt=false），
//! 不阻塞交付；采集与合成链路独立降级（平台不支持即显式报不支持）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// 模型目录默认位置（开发形态，相对进程 CWD）。
pub const VOICE_MODEL_DIR_DEFAULT: &str = "inkling/models/whisper";

/// 本地 ONNX 图文件名（int8 量化 whisper）。
pub const LOCAL_STT_ONNX: &str = "model_q8.onnx";

/// 本地分词器文件名（whisper BPE）。
pub const LOCAL_STT_TOKENIZER: &str = "tokenizer.json";

/// 本地模型配置文件名。
pub const LOCAL_STT_CONFIG: &str = "config.json";

/// 默认采样率（whisper base 训练 16kHz）。
pub const DEFAULT_SAMPLE_RATE: u32 = 16000;

/// 默认结束符（whisper 序列结束标记）。
pub const DEFAULT_EOT: u32 = 50257;

/// 模型目录解析（覆盖 → 捆绑资产 → 相对 CWD 默认）。
fn resolve_dir(data_dir: Option<&Path>) -> PathBuf {
    if let Ok(env) = std::env::var("INK_VOICE_MODEL_DIR") {
        if !env.is_empty() {
            return PathBuf::from(env);
        }
    }
    if crate::engine::runtime::bundled_mode() {
        if let Some(d) = data_dir {
            return crate::engine::runtime::voice_model_dir_in(d);
        }
    }
    PathBuf::from(VOICE_MODEL_DIR_DEFAULT)
}

/// STT 模型配置文件（采样率 / 结束符等机器可读声明）。
struct SttConfig {
    sample_rate: u32,
    eot: u32,
}

fn read_stt_config(dir: &Path) -> SttConfig {
    let mut cfg = SttConfig {
        sample_rate: DEFAULT_SAMPLE_RATE,
        eot: DEFAULT_EOT,
    };
    let path = dir.join(LOCAL_STT_CONFIG);
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(s) = v.get("sample_rate").and_then(|x| x.as_u64()) {
                cfg.sample_rate = s as u32;
            }
            if let Some(e) = v.get("eot_token_id").and_then(|x| x.as_u64()) {
                cfg.eot = e as u32;
            }
        }
    }
    cfg
}

/// STT 模型文件齐备性（目录 + 图 + 分词器）。
fn stt_ready(dir: &Path) -> bool {
    dir.is_dir()
        && dir.join(LOCAL_STT_ONNX).is_file()
        && dir.join(LOCAL_STT_TOKENIZER).is_file()
}

/// 本地 whisper 推理运行时（分词器 + ONNX 会话；懒加载单例）。
struct WhisperRuntime {
    session: tokio::sync::Mutex<ort::session::Session>,
    tokenizer: tokenizers::Tokenizer,
    eot: u32,
}

fn load_whisper(dir: &Path) -> Result<WhisperRuntime, String> {
    let tokenizer = tokenizers::Tokenizer::from_file(dir.join(LOCAL_STT_TOKENIZER))
        .map_err(|e| format!("语音分词器加载失败: {e}"))?;
    let session = ort::session::Session::builder()
        .map_err(|e| format!("语音会话构建失败: {e}"))?
        .with_intra_threads(2)
        .map_err(|e| format!("语音会话线程配置失败: {e}"))?
        .commit_from_file(dir.join(LOCAL_STT_ONNX))
        .map_err(|e| format!("语音会话提交失败: {e}"))?;
    let cfg = read_stt_config(dir);
    Ok(WhisperRuntime {
        session: tokio::sync::Mutex::new(session),
        tokenizer,
        eot: cfg.eot,
    })
}

/// STT 模型句柄：目录固定，运行时懒装载（失败原因可观测）。
pub struct WhisperModel {
    dir: PathBuf,
    runtime: OnceLock<Result<WhisperRuntime, String>>,
}

impl WhisperModel {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            runtime: OnceLock::new(),
        }
    }

    fn runtime(&self) -> Result<&WhisperRuntime, String> {
        self.runtime
            .get_or_init(|| load_whisper(&self.dir))
            .as_ref()
            .map_err(Clone::clone)
    }

    pub fn available(&self) -> bool {
        stt_ready(&self.dir)
    }
}

/// 能力探测（麦克风/STT/TTS 三项独立降级）。
pub fn capabilities(data_dir: Option<&Path>) -> serde_json::Value {
    let dir = resolve_dir(data_dir);
    let mic = cfg!(windows);
    let stt = stt_ready(&dir);
    let tts = cfg!(windows);
    serde_json::json!({
        "mic": mic,
        "stt": stt,
        "tts": tts,
        "stt_model_dir": dir.to_string_lossy(),
        "note": if stt {
            serde_json::Value::Null
        } else {
            serde_json::Value::String("模型缺失".to_string())
        },
    })
}

/// WAV（PCM 16-bit）解析为单声道 f32（[-1,1]）。
fn parse_wav_to_mono_f32(data: &[u8]) -> Result<Vec<f32>, String> {
    if data.len() < 44 || &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err("音频非 WAV 容器".to_string());
    }
    let mut pos = 12usize;
    let mut channels = 1u16;
    let mut bits = 16u16;
    let mut data_start = None;
    let mut data_len = 0usize;
    while pos + 8 <= data.len() {
        let id = &data[pos..pos + 4];
        let size = u32::from_le_bytes([data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]]) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 16 <= data.len() {
            channels = u16::from_le_bytes([data[body + 2], data[body + 3]]);
            bits = u16::from_le_bytes([data[body + 14], data[body + 15]]);
        } else if id == b"data" {
            data_start = Some(body);
            data_len = size.min(data.len().saturating_sub(body));
            break;
        }
        if size == 0 {
            break;
        }
        pos = body + size + (size & 1);
    }
    let start = data_start.ok_or_else(|| "音频缺 data 块".to_string())?;
    let pcm = &data[start..start + data_len];
    if bits != 16 {
        return Err(format!("仅支持 16-bit PCM（当前 {bits}）"));
    }
    if channels == 1 {
        Ok(pcm
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect())
    } else {
        let frame = (2 * channels as usize).max(2);
        Ok(pcm
            .chunks_exact(frame)
            .map(|f| i16::from_le_bytes([f[0], f[1]]) as f32 / 32768.0)
            .collect())
    }
}

/// STT：音频（WAV 字节）→ 文本（真实推理：张量 → 会话 → 贪心解码）。
pub async fn transcribe(audio: &[u8], data_dir: Option<&Path>) -> Result<String, String> {
    let dir = resolve_dir(data_dir);
    if !stt_ready(&dir) {
        return Err("语音识别不可用（模型缺失）".to_string());
    }
    let samples = parse_wav_to_mono_f32(audio)?;
    // 模型实例按目录缓存（Arc 复用）：ONNX 会话不随每次调用重载（FB13）
    let model = cached_whisper_model(dir);
    let rt = model.runtime()?;
    let n = samples.len();
    if n == 0 {
        return Ok(String::new());
    }
    let input = ort::value::Tensor::from_array(([1usize, n], samples.clone()))
        .map_err(|e| format!("语音输入张量构建失败: {e}"))?;
    let inputs = ort::inputs! { "audio" => input };
    let run_options = ort::session::run_options::RunOptions::new()
        .map_err(|e| format!("语音运行选项创建失败: {e}"))?;
    let mut session = rt.session.lock().await;
    let outputs = session
        .run_async(inputs, &run_options)
        .map_err(|e| format!("语音推理启动失败: {e}"))?
        .await
        .map_err(|e| format!("语音推理失败: {e}"))?;
    if outputs.len() == 0 {
        return Err("语音模型无输出".to_string());
    }
    let (shape, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("语音输出提取失败: {e}"))?;
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    let vocab = *dims.last().ok_or_else(|| "语音输出缺词表维度".to_string())?;
    let seq = if dims.len() >= 2 { dims[dims.len() - 2] } else { 0 };
    let mut ids: Vec<u32> = Vec::with_capacity(seq);
    for t in 0..seq {
        let base = t * vocab;
        let mut best = 0usize;
        let mut bestv = f32::NEG_INFINITY;
        for v in 0..vocab {
            let val = data[base + v];
            if val > bestv {
                bestv = val;
                best = v;
            }
        }
        if best as u32 == rt.eot {
            break;
        }
        // 特殊标记区间（>= 50000）跳过，仅拼接常规词片段
        if best as u32 >= 50000 {
            continue;
        }
        ids.push(best as u32);
    }
    let text = rt
        .tokenizer
        .decode(&ids, true)
        .map_err(|e| format!("语音解码失败: {e}"))?;
    Ok(text.trim().to_string())
}

/// STT 模型实例缓存（进程级，按模型目录键控）。
///
/// 模型实例内的 ONNX 会话首次装载后常驻（OnceLock）——每次调用
/// 重建 WhisperModel 会让 ONNX 会话反复重载，本缓存按目录复用实例
/// （目录形态有限：开发默认/捆绑资产/显式覆盖，常驻内存可控）。
fn cached_whisper_model(dir: PathBuf) -> Arc<WhisperModel> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Arc<WhisperModel>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    guard
        .entry(dir.clone())
        .or_insert_with(|| Arc::new(WhisperModel::new(dir)))
        .clone()
}

/// SAPI 朗读脚本（纯函数：$args[0] = 临时文本文件路径）。
///
/// 路径经命令行参数传递（`-LiteralPath $args[0]`）而非拼进脚本——
/// 文件路径原样进 argv，无 shell 插值面（含引号/空格/$ 字符均安全）。
fn speak_script() -> &'static str {
    "Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak((Get-Content -Raw -LiteralPath $args[0])); $s.Dispose()"
}

/// TTS：Windows SAPI 朗读（PowerShell 桥，零新依赖；文本落临时文件防注入）。
pub fn speak(text: &str) -> Result<bool, String> {
    if !cfg!(windows) {
        return Err("当前平台不支持语音合成".to_string());
    }
    if text.trim().is_empty() {
        return Ok(false);
    }
    let tmp = std::env::temp_dir().join(format!("inkling-tts-{}.txt", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, text).map_err(|e| format!("语音临时文件写入失败: {e}"))?;
    let path_arg = tmp.to_string_lossy().into_owned();
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", speak_script(), &path_arg])
        .output()
        .map_err(|e| format!("语音合成启动失败: {e}"))?;
    let _ = std::fs::remove_file(&tmp);
    if out.status.success() {
        Ok(true)
    } else {
        Err(format!(
            "语音合成失败：{}",
            String::from_utf8_lossy(&out.stderr)
        ))
    }
}

/// 麦克风采集（Windows waveIn）；非 Windows 显式报不支持。
pub fn record_wav(duration_ms: u32) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        windows_audio::record_wav(duration_ms)
    }
    #[cfg(not(windows))]
    {
        let _ = duration_ms;
        Err("当前平台不支持音频采集".to_string())
    }
}

/// 麦克风设备清单（Windows waveIn；非 Windows 返回空清单）。
pub fn list_devices() -> serde_json::Value {
    #[cfg(windows)]
    {
        windows_audio::list_devices()
    }
    #[cfg(not(windows))]
    {
        serde_json::json!({ "count": 0, "devices": [], "note": "当前平台不支持音频采集" })
    }
}

#[cfg(windows)]
mod windows_audio {
    // WAV/MME FFI 结构体字段沿用 Win32 命名（wFormatTag 等）：布局须与
    // 系统头一致，显式声明非 snake_case 为有意匹配，防改名破坏布局
    #![allow(non_snake_case)]

    use std::ffi::c_void;
    use std::ptr;

    const WAVE_FORMAT_PCM: u16 = 1;
    const WAVE_MAPPER: usize = 0xFFFF_FFFF;

    #[repr(C)]
    struct WAVEFORMATEX {
        wFormatTag: u16,
        nChannels: u16,
        nSamplesPerSec: u32,
        nAvgBytesPerSec: u32,
        nBlockAlign: u16,
        wBitsPerSample: u16,
        cbSize: u16,
    }

    #[repr(C)]
    struct WAVEHDR {
        lpData: *mut u8,
        dwBufferLength: u32,
        dwBytesRecorded: u32,
        dwUser: usize,
        dwFlags: u32,
        dwLoops: u32,
        lpNext: *mut WAVEHDR,
        reserved: usize,
    }

    #[repr(C)]
    struct WAVEINCAPSW {
        wMid: u16,
        wPid: u16,
        vDriverVersion: u32,
        szPname: [u16; 32],
        dwFormats: u32,
        wChannels: u16,
        wReserved1: u16,
    }

    #[link(name = "winmm")]
    extern "system" {
        fn waveInGetNumDevs() -> u32;
        fn waveInGetDevCapsW(uptr: usize, caps: *mut WAVEINCAPSW, sz: u32) -> u32;
        fn waveInOpen(
            phwi: *mut *mut c_void,
            uDeviceID: usize,
            pwfx: *const WAVEFORMATEX,
            dwCallback: usize,
            dwInstance: usize,
            fdwOpen: u32,
        ) -> u32;
        fn waveInPrepareHeader(hwi: *mut c_void, pwh: *mut WAVEHDR, cbwh: u32) -> u32;
        fn waveInAddBuffer(hwi: *mut c_void, pwh: *mut WAVEHDR, cbwh: u32) -> u32;
        fn waveInStart(hwi: *mut c_void) -> u32;
        fn waveInStop(hwi: *mut c_void) -> u32;
        fn waveInReset(hwi: *mut c_void) -> u32;
        fn waveInUnprepareHeader(hwi: *mut c_void, pwh: *mut WAVEHDR, cbwh: u32) -> u32;
        fn waveInClose(hwi: *mut c_void) -> u32;
    }

    const SAMPLE_RATE: u32 = 16000;
    const CHANNELS: u16 = 1;
    const BITS: u16 = 16;

    pub fn record_wav(duration_ms: u32) -> Result<Vec<u8>, String> {
        let bytes_per_sec = SAMPLE_RATE * CHANNELS as u32 * (BITS as u32 / 8);
        let total = ((duration_ms as u64 * bytes_per_sec as u64) / 1000) as usize;
        if total == 0 {
            return Err("录音时长过短".to_string());
        }
        let mut buffer: Vec<u8> = vec![0u8; total];
        let mut hdr = WAVEHDR {
            lpData: buffer.as_mut_ptr(),
            dwBufferLength: total as u32,
            dwBytesRecorded: 0,
            dwUser: 0,
            dwFlags: 0,
            dwLoops: 0,
            lpNext: ptr::null_mut(),
            reserved: 0,
        };
        let fmt = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM,
            nChannels: CHANNELS,
            nSamplesPerSec: SAMPLE_RATE,
            nAvgBytesPerSec: bytes_per_sec,
            nBlockAlign: CHANNELS * BITS / 8,
            wBitsPerSample: BITS,
            cbSize: 0,
        };
        let mut hwi: *mut c_void = ptr::null_mut();
        let rc = unsafe { waveInOpen(&mut hwi, WAVE_MAPPER, &fmt, 0, 0, 0) };
        if rc != 0 {
            return Err(format!("麦克风打开失败（错误码 {rc}）"));
        }
        let hdr_size = std::mem::size_of::<WAVEHDR>() as u32;
        let rc = unsafe { waveInPrepareHeader(hwi, &mut hdr, hdr_size) };
        if rc != 0 {
            let _ = unsafe { waveInClose(hwi) };
            return Err(format!("录音头准备失败（{rc}）"));
        }
        let rc = unsafe { waveInAddBuffer(hwi, &mut hdr, hdr_size) };
        if rc != 0 {
            let _ = unsafe { waveInClose(hwi) };
            return Err(format!("录音缓冲提交失败（{rc}）"));
        }
        let rc = unsafe { waveInStart(hwi) };
        if rc != 0 {
            let _ = unsafe { waveInClose(hwi) };
            return Err(format!("录音启动失败（{rc}）"));
        }
        std::thread::sleep(std::time::Duration::from_millis(duration_ms as u64));
        unsafe {
            waveInStop(hwi);
            waveInReset(hwi);
            waveInUnprepareHeader(hwi, &mut hdr, hdr_size);
            waveInClose(hwi);
        }
        let recorded = hdr.dwBytesRecorded as usize;
        buffer.truncate(recorded);
        Ok(write_wav(&buffer))
    }

    fn write_wav(pcm: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(44 + pcm.len());
        let data_len = pcm.len() as u32;
        let byte_rate = SAMPLE_RATE * CHANNELS as u32 * (BITS as u32 / 8);
        let block_align = CHANNELS * BITS / 8;
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&WAVE_FORMAT_PCM.to_le_bytes());
        out.extend_from_slice(&CHANNELS.to_le_bytes());
        out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        out.extend_from_slice(&byte_rate.to_le_bytes());
        out.extend_from_slice(&block_align.to_le_bytes());
        out.extend_from_slice(&BITS.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        out.extend_from_slice(pcm);
        out
    }

    pub fn list_devices() -> serde_json::Value {
        let num = unsafe { waveInGetNumDevs() };
        let mut devices = Vec::new();
        for i in 0..num {
            let mut caps = WAVEINCAPSW {
                wMid: 0,
                wPid: 0,
                vDriverVersion: 0,
                szPname: [0u16; 32],
                dwFormats: 0,
                wChannels: 0,
                wReserved1: 0,
            };
            let rc = unsafe {
                waveInGetDevCapsW(i as usize, &mut caps, std::mem::size_of::<WAVEINCAPSW>() as u32)
            };
            let name = if rc == 0 {
                let end = caps.szPname.iter().position(|&c| c == 0).unwrap_or(32);
                String::from_utf16_lossy(&caps.szPname[..end])
            } else {
                format!("device-{i}")
            };
            devices.push(serde_json::json!({ "id": i, "name": name }));
        }
        serde_json::json!({ "count": num, "devices": devices })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_degrade_when_model_missing() {
        // 临时空目录必然缺模型文件 → stt=false（不阻塞交付）
        let dir = std::env::temp_dir().join(format!("inkling-voice-cap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let caps = capabilities(Some(&dir));
        assert_eq!(caps["stt"], false);
        assert_eq!(caps["mic"], cfg!(windows));
        assert_eq!(caps["tts"], cfg!(windows));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wav_parse_extracts_mono_samples() {
        // 构造最小 16-bit mono WAV（2 样本：0 与 -32768 → -1.0）
        let pcm = [0x00u8, 0x00u8, 0x00u8, 0x80u8];
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&32000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        wav.extend_from_slice(&pcm);
        let samples = parse_wav_to_mono_f32(&wav).unwrap();
        assert_eq!(samples.len(), 2);
        assert!((samples[0] - 0.0).abs() < 1e-6);
        assert!((samples[1] + 1.0).abs() < 1e-6);
    }

    #[test]
    fn transcribe_errors_without_model() {
        let dir = std::env::temp_dir().join(format!("inkling-voice-tr-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt.block_on(transcribe(&[0u8; 44], Some(&dir)));
        assert!(err.is_err(), "模型缺失应报不可用：{err:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn whisper_model_cached_per_model_dir() {
        // FB13 回归：同目录复用同一实例（ONNX 会话不反复重载）
        let dir = std::env::temp_dir().join(format!("inkling-voice-cache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = cached_whisper_model(dir.clone());
        let second = cached_whisper_model(dir.clone());
        assert!(Arc::ptr_eq(&first, &second), "同目录应复用同一实例");
        let other = std::env::temp_dir()
            .join(format!("inkling-voice-cache-other-{}", uuid::Uuid::new_v4()));
        let third = cached_whisper_model(other.clone());
        assert!(!Arc::ptr_eq(&first, &third), "异目录应独立实例");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn speak_script_passes_path_as_argument() {
        // FB14 回归：路径经 -LiteralPath $args[0] 传参——脚本无单引号转义拼接
        let script = speak_script();
        assert!(script.contains("-LiteralPath $args[0]"), "路径应经 argv 传递");
        assert!(!script.contains('\''), "脚本不应含单引号转义拼接");
    }
}
