//! Rust 侧协议对象（经 PyO3 注入引擎消费）：事件传输回桥、内嵌嵌入器、记忆存储。
//!
//! 引擎协议是鸭子类型——Python 侧只按方法名消费，不要求子类关系；本模块
//! 的三类对象因此可以直接注入引擎装配/回合流程。跨语言边界的可等待对象
//! 由 pyo3-async-runtimes 双向桥接（Rust future → Python awaitable）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::IntoPyObjectExt;
use serde_json::Value as JsonValue;

/// 引擎事件传输回桥：Python 侧 `transport.send(event)` 推 JSON 进 Rust 侧缓冲，
/// 同时（若已挂发射钩子）把事件实时转发到前端事件通道——回合返回体保留为
/// 兼容/回落形态，流式通道保证首事件早于回合返回到达。
#[pyclass]
pub struct RustTransport {
    events: Arc<Mutex<Vec<String>>>,
    emitter: Arc<Mutex<Option<Box<dyn Fn(&str) + Send + Sync>>>>,
}

impl RustTransport {
    pub fn new() -> Self {
        Self {
            events: Arc::new(Mutex::new(Vec::new())),
            emitter: Arc::new(Mutex::new(None)),
        }
    }

    /// 取走全部已收事件（JSON 字符串；取后清空，回合驱动侧按序消费）。
    pub fn take_events(&self) -> Vec<String> {
        std::mem::take(&mut *self.events.lock().unwrap())
    }

    /// 挂接/摘除实时发射钩子（事件到达即调用；钩子失败不影响事件收集）。
    pub fn set_emitter(&self, emitter: Option<Box<dyn Fn(&str) + Send + Sync>>) {
        *self.emitter.lock().unwrap() = emitter;
    }
}

#[pymethods]
impl RustTransport {
    /// 传输入口（协议要求异步形态：返回即可完成的 awaitable，不阻塞回合）。
    #[pyo3(name = "send")]
    fn send<'py>(
        &self,
        py: Python<'py>,
        event: Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let json_str: String = event
            .call_method0(pyo3::intern!(py, "to_json"))?
            .extract()?;
        self.events.lock().unwrap().push(json_str.clone());
        let emitter = self.emitter.lock().unwrap();
        if let Some(emit) = emitter.as_ref() {
            // 发射闭包可能 panic（如前端通道异常）：catch 住，避免 panic 经
            // PyO3 回卷中断引擎在途回合；事件收集缓冲不受影响（#6）。
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                emit(&json_str);
            }));
        }
        pyo3_async_runtimes::tokio::future_into_py(py, async move { Ok(()) })
    }

    fn event_count(&self) -> usize {
        self.events.lock().unwrap().len()
    }
}

fn fake_vector(text: &str, dim: usize) -> Vec<f64> {
    let mut state: u64 = 0x811c9dc5;
    for byte in text.bytes() {
        state ^= byte as u64;
        state = state.wrapping_mul(0x01000193);
    }
    (0..dim)
        .map(|i| {
            let x = state as f64 + (i as f64) * 12.9898;
            (x.sin() * 43758.5453).fract()
        })
        .collect()
}

/// 内嵌嵌入器（本地 ONNX 推理的协议同位件）：确定性向量用于离线验证；
/// 真实模型推理在接线层以同接口落地（懒加载/降级语义不变）。
#[pyclass]
pub struct RustEmbedder {
    dim: usize,
}

impl RustEmbedder {
    pub fn new(dim: usize) -> Self {
        Self { dim }
    }
}

#[pymethods]
impl RustEmbedder {
    fn aembed_query<'py>(
        &self,
        py: Python<'py>,
        text: String,
    ) -> PyResult<Bound<'py, PyAny>> {
        let vector = fake_vector(&text, self.dim);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            // 模拟异步推理耗时：真实 ONNX 推理的异步化执行形态
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            Python::attach(|py| vector.into_py_any(py))
        })
    }

    fn aembed_documents<'py>(
        &self,
        py: Python<'py>,
        texts: Vec<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let dim = self.dim;
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            let vectors: Vec<Vec<f64>> = texts.iter().map(|t| fake_vector(t, dim)).collect();
            Python::attach(|py| vectors.into_py_any(py))
        })
    }

    fn aclose<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        pyo3_async_runtimes::tokio::future_into_py(py, async move { Ok(()) })
    }
}

/// 出厂本地嵌入器（granite-97m ONNX 的协议注入形态）：引擎侧消费的
/// AsyncEmbedder 协议对象——`aembed_query`/`aembed_documents`/`aclose`
/// 三个可等待方法，与确定性 [`RustEmbedder`] 同位（后者供离线验证）。
///
/// 内嵌真实推理（ort + tokenizers，懒加载单体）：模型目录经构造参数
/// 显式传入（发行 = 数据目录 assets/ 解包位；开发 = 仓库 models/），
/// 计划解析/降级语义全部归接线层 [`crate::domain::embedder`]，本类
/// 只做跨语言边界的异步形态适配。
#[pyclass]
pub struct LocalOnnx {
    inner: std::sync::Arc<crate::domain::embedder::LocalOnnxEmbedder>,
}

impl LocalOnnx {
    /// 显式模型目录构造（装配注入形态；None = 环境默认解析）。
    pub fn with_model_dir(model_dir: std::path::PathBuf) -> Self {
        Self {
            inner: std::sync::Arc::new(
                crate::domain::embedder::LocalOnnxEmbedder::with_model_dir(model_dir),
            ),
        }
    }
}

fn to_py_value_err(err: crate::domain::common::DomainError) -> PyErr {
    PyValueError::new_err(err.to_string())
}

#[pymethods]
impl LocalOnnx {
    /// 构造（model_dir = None 时走环境默认：`INK_EMBEDDING_MODEL_DIR`）。
    #[new]
    fn new(model_dir: Option<String>) -> Self {
        let inner = match model_dir {
            Some(dir) => crate::domain::embedder::LocalOnnxEmbedder::with_model_dir(dir),
            None => crate::domain::embedder::LocalOnnxEmbedder::new(),
        };
        Self {
            inner: std::sync::Arc::new(inner),
        }
    }

    fn aembed_query<'py>(
        &self,
        py: Python<'py>,
        text: String,
    ) -> PyResult<Bound<'py, PyAny>> {
        let inner = self.inner.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let vector = inner
                .aembed_query(&text)
                .await
                .map_err(to_py_value_err)?;
            Python::attach(|py| vector.into_py_any(py))
        })
    }

    fn aembed_documents<'py>(
        &self,
        py: Python<'py>,
        texts: Vec<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let inner = self.inner.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let vectors = inner
                .aembed_documents(&texts)
                .await
                .map_err(to_py_value_err)?;
            Python::attach(|py| vectors.into_py_any(py))
        })
    }

    fn aclose<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let inner = self.inner.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            inner.aclose().await.map_err(to_py_value_err)?;
            Ok(())
        })
    }

    /// 当前嵌入来源（观测：local/remote/deterministic）。
    fn source(&self) -> String {
        format!("{:?}", self.inner.source())
    }

    /// 降级原因（本地推理不可用时的可观测说明）。
    fn note(&self) -> Option<String> {
        self.inner.note().map(|note| note.to_string())
    }

    /// 当前维度（模型配置声明；保底 = 默认 384）。
    fn dim(&self) -> usize {
        self.inner.dim()
    }

    /// 计划是否已解析（懒加载状态可观测）。
    fn resolved(&self) -> bool {
        self.inner.resolved()
    }
}

const MEMORY_RECORD_DELETED: &str = "_deleted";
const MEMORY_PROTECTED_KEYS: [&str; 4] = ["id", "namespace", "created_at", "_deleted"];

/// 记忆记录是否已删除（墓碑标记判定；H13：删除判定集中一处，防散落
/// 三处写法漂移）。
fn is_deleted(rec: &JsonValue) -> bool {
    rec.get(MEMORY_RECORD_DELETED) == Some(&JsonValue::Bool(true))
}

/// 内嵌记忆存储（本地文件记忆的协议同位件）：记录以 JSON 驻留 Rust 侧；
/// 删除=标记失效（召回不可见，记录仍可追溯），与引擎记忆语义一致。
#[pyclass]
pub struct RustMemoryStore {
    records: Mutex<HashMap<String, JsonValue>>,
}

impl RustMemoryStore {
    pub fn new() -> Self {
        Self {
            records: Mutex::new(HashMap::new()),
        }
    }

    fn to_entry(&self, py: Python<'_>, key: &str) -> PyResult<Py<PyAny>> {
        let json_mod = py.import("json")?;
        let mem_mod = py.import("ink_engine.core.memory")?;
        let Some(value) = self.records.lock().unwrap().get(key).cloned() else {
            return Err(PyValueError::new_err(format!("记忆条目不存在: {key}")));
        };
        let rec = json_mod.call_method1("loads", (value.to_string(),))?;
        Ok(mem_mod.call_method1("_record_to_entry", (rec,))?.unbind())
    }

    fn patch_value(py: Python<'_>, object: Bound<'_, PyAny>) -> PyResult<JsonValue> {
        let json_mod = py.import("json")?;
        let serialized: String = json_mod.call_method1("dumps", (object,))?.extract()?;
        serde_json::from_str(&serialized)
            .map_err(|err| PyValueError::new_err(format!("补丁数据不可序列化: {err}")))
    }
}

#[pymethods]
impl RustMemoryStore {
    fn save<'py>(&self, py: Python<'py>, entry: Bound<'py, PyAny>) -> PyResult<Bound<'py, PyAny>> {
        let entry_id: String = {
            let id_attr = entry.getattr(pyo3::intern!(py, "id"))?;
            if id_attr.is_none() {
                let mem_mod = py.import("ink_engine.core.memory")?;
                mem_mod.call_method1("_make_id", (&entry,))?.extract()?
            } else {
                id_attr.extract()?
            }
        };
        let mem_mod = py.import("ink_engine.core.memory")?;
        let rec = mem_mod.call_method1("_entry_to_record", (&entry, entry_id.as_str()))?;
        let value = Self::patch_value(py, rec)?;
        self.records.lock().unwrap().insert(entry_id.clone(), value);
        let result: Py<PyAny> = entry_id.into_py_any(py)?;
        pyo3_async_runtimes::tokio::future_into_py(py, async move { Ok(result) })
    }

    fn get<'py>(&self, py: Python<'py>, entry_id: String) -> PyResult<Bound<'py, PyAny>> {
        let record = self.records.lock().unwrap().get(&entry_id).cloned();
        let result: Py<PyAny> = match record {
            Some(rec) if !is_deleted(&rec) => self.to_entry(py, &entry_id)?,
            _ => py.None(),
        };
        pyo3_async_runtimes::tokio::future_into_py(py, async move { Ok(result) })
    }

    fn update<'py>(
        &self,
        py: Python<'py>,
        entry_id: String,
        data: Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let patch = Self::patch_value(py, data)?;
        let mut guard = self.records.lock().unwrap();
        let mut done = false;
        if let Some(rec) = guard.get_mut(&entry_id) {
            if !is_deleted(rec) {
                if let JsonValue::Object(fields) = patch {
                    if let JsonValue::Object(rec_fields) = rec {
                        for (key, value) in fields {
                            if !MEMORY_PROTECTED_KEYS.contains(&key.as_str()) {
                                rec_fields.insert(key, value);
                            }
                        }
                    }
                }
                done = true;
            }
        }
        let result: Py<PyAny> = done.into_py_any(py)?;
        pyo3_async_runtimes::tokio::future_into_py(py, async move { Ok(result) })
    }

    fn delete<'py>(&self, py: Python<'py>, entry_id: String) -> PyResult<Bound<'py, PyAny>> {
        let mut guard = self.records.lock().unwrap();
        let done = match guard.get_mut(&entry_id) {
            Some(rec) => {
                rec[MEMORY_RECORD_DELETED] = JsonValue::Bool(true);
                true
            }
            None => false,
        };
        let result: Py<PyAny> = done.into_py_any(py)?;
        pyo3_async_runtimes::tokio::future_into_py(py, async move { Ok(result) })
    }

    #[pyo3(name = "query")]
    fn query<'py>(&self, py: Python<'py>, q: Bound<'py, PyAny>) -> PyResult<Bound<'py, PyAny>> {
        let namespace: Option<String> = q.getattr("namespace")?.extract()?;
        let kind: Option<String> = q.getattr("kind")?.extract()?;
        let source: Option<String> = q.getattr("source")?.extract()?;
        let limit: Option<usize> = q.getattr("limit")?.extract()?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        let keys: Vec<String> = {
            let guard = self.records.lock().unwrap();
            let mut keys: Vec<(&String, &JsonValue)> = guard
                .iter()
                .filter(|(_, rec)| !is_deleted(rec))
                .filter(|(_, rec)| {
                    namespace
                        .as_deref()
                        .is_none_or(|ns| rec.get("namespace").and_then(JsonValue::as_str) == Some(ns))
                })
                .filter(|(_, rec)| {
                    r#kind
                        .as_deref()
                        .is_none_or(|k| rec.get("kind").and_then(JsonValue::as_str) == Some(k))
                })
                .filter(|(_, rec)| {
                    source
                        .as_deref()
                        .is_none_or(|s| rec.get("source").and_then(JsonValue::as_str) == Some(s))
                })
                .filter(|(_, rec)| {
                    let expires = rec
                        .get("expires_at")
                        .and_then(JsonValue::as_f64)
                        .unwrap_or(f64::MAX);
                    now < expires
                })
                .map(|(key, rec)| (key, rec))
                .collect();
            // 排序语义与引擎默认实现一致：优先级降序 → 创建时间降序
            keys.sort_by(|(_, a), (_, b)| {
                let pa = a.get("priority").and_then(JsonValue::as_f64).unwrap_or(5.0);
                let pb = b.get("priority").and_then(JsonValue::as_f64).unwrap_or(5.0);
                let ca = a.get("created_at").and_then(JsonValue::as_f64).unwrap_or(0.0);
                let cb = b.get("created_at").and_then(JsonValue::as_f64).unwrap_or(0.0);
                pb.partial_cmp(&pa)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(cb.partial_cmp(&ca).unwrap_or(std::cmp::Ordering::Equal))
            });
            keys.into_iter().map(|(k, _)| k.clone()).collect()
        };
        let mut result: Vec<Py<PyAny>> = Vec::new();
        for key in keys {
            result.push(self.to_entry(py, &key)?);
            if let Some(limit) = limit {
                if result.len() >= limit {
                    break;
                }
            }
        }
        let list: Py<PyAny> = result.into_py_any(py)?;
        pyo3_async_runtimes::tokio::future_into_py(py, async move { Ok(list) })
    }

    fn clear(&self) {
        self.records.lock().unwrap().clear();
    }
}

// ── JSON 回调桥（Python 引擎侧回拉 Rust 域逻辑的受控形态）──

/// 回调处理函数（JSON 进/JSON 出；在 Python 调用线程内同步执行）。
pub type JsonCallback = Box<dyn Fn(String) -> PyResult<String> + Send + Sync>;

/// JSON 回调宿主：Python 桥模块经 `invoke(name, payload)` 调用 Rust 侧
/// 注册的回调（域逻辑归属 Rust，桥侧仅做 JSON 往返）。
///
/// 注册入口是 Rust（`register_callback`）——回调闭包不跨语言边界暴露
/// 为 Python 对象；Python 只按名字 invoke。实例由桥模块持有（模块全
/// 局强引用），Rust 侧每次注册经模块属性定位实例。
#[pyclass]
pub struct JsonCallbackHost {
    registry: Mutex<HashMap<String, JsonCallback>>,
}

impl JsonCallbackHost {
    fn new() -> Self {
        Self {
            registry: Mutex::new(HashMap::new()),
        }
    }
}

/// 注册 Rust 侧回调（实例经桥模块定位；重复注册同名 = 覆盖）。
pub fn register_callback(name: &str, callback: JsonCallback) -> PyResult<()> {
    Python::attach(|py| {
        let host = py.import("inkling_bridge")?.call_method0("callback_host")?;
        let downcast = host.cast::<JsonCallbackHost>()?;
        downcast.borrow().registry.lock().unwrap().insert(
            name.to_string(),
            callback,
        );
        Ok(())
    })
}

/// 注销回调（摘除接线/测试恢复前置条件；返回是否命中）。
pub fn unregister_callback(name: &str) -> bool {
    Python::attach(|py| -> PyResult<bool> {
        let host = py.import("inkling_bridge")?.call_method0("callback_host")?;
        let downcast = host.cast::<JsonCallbackHost>()?;
        Ok(downcast.borrow().registry.lock().unwrap().remove(name).is_some())
    })
    .unwrap_or(false)
}

#[pymethods]
impl JsonCallbackHost {
    /// 调用已注册回调（未注册 = 显式报错，不静默回退）。
    fn invoke(&self, name: String, payload: String) -> PyResult<String> {
        let registry = self.registry.lock().unwrap();
        let callback = registry.get(&name).ok_or_else(|| {
            PyValueError::new_err(format!("回调未注册: {name}"))
        })?;
        callback(payload)
    }

    /// 已注册回调名单（诊断/审计用）。
    fn names(&self) -> Vec<String> {
        self.registry.lock().unwrap().keys().cloned().collect()
    }

    /// 注销回调（重装/替换注册表时清理；返回是否命中）。
    fn unregister(&self, name: String) -> bool {
        self.registry.lock().unwrap().remove(&name).is_some()
    }
}

/// 向 Python 侧注册协议对象（供内嵌桥模块导入，以及注入点引用）。
/// 回调宿主实例同时绑定到桥模块（Python 侧经 invoke 调用 Rust 回调）。
pub fn register_objects(py: Python<'_>) -> PyResult<()> {
    let module = PyModule::new(py, "inkling_bridge_objects")?;
    module.add_class::<RustTransport>()?;
    module.add_class::<RustEmbedder>()?;
    module.add_class::<LocalOnnx>()?;
    module.add_class::<RustMemoryStore>()?;
    module.add_class::<JsonCallbackHost>()?;
    py.import("sys")?
        .getattr("modules")?
        .set_item("inkling_bridge_objects", module)?;
    // 回调宿主实例：绑定进桥模块（模块强引用；Rust 侧注册经模块定位）
    let callback_host = Py::new(py, JsonCallbackHost::new())?;
    py.import("inkling_bridge")?
        .call_method1("bind_callback_host", (callback_host,))?;
    Ok(())
}
