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

/// 引擎事件传输回桥：Python 侧 `transport.send(event)` 推 JSON 进 Rust 侧缓冲。
#[pyclass]
pub struct RustTransport {
    events: Arc<Mutex<Vec<String>>>,
}

impl RustTransport {
    pub fn new() -> Self {
        Self {
            events: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// 取走全部已收事件（JSON 字符串；取后清空，回合驱动侧按序消费）。
    pub fn take_events(&self) -> Vec<String> {
        std::mem::take(&mut *self.events.lock().unwrap())
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
        self.events.lock().unwrap().push(json_str);
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

const MEMORY_RECORD_DELETED: &str = "_deleted";
const MEMORY_PROTECTED_KEYS: [&str; 4] = ["id", "namespace", "created_at", "_deleted"];

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
            Some(rec) if rec.get(MEMORY_RECORD_DELETED) != Some(&JsonValue::Bool(true)) => {
                self.to_entry(py, &entry_id)?
            }
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
            if rec.get(MEMORY_RECORD_DELETED) != Some(&JsonValue::Bool(true)) {
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
                .filter(|(_, rec)| rec.get(MEMORY_RECORD_DELETED) != Some(&JsonValue::Bool(true)))
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

/// 向 Python 侧注册协议对象（供内嵌桥模块导入，以及注入点引用）。
pub fn register_objects(py: Python<'_>) -> PyResult<()> {
    let module = PyModule::new(py, "inkling_bridge_objects")?;
    module.add_class::<RustTransport>()?;
    module.add_class::<RustEmbedder>()?;
    module.add_class::<RustMemoryStore>()?;
    py.import("sys")?
        .getattr("modules")?
        .set_item("inkling_bridge_objects", module)?;
    Ok(())
}
