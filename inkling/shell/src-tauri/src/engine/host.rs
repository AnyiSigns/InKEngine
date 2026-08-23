//! 引擎装配与回合驱动：壳进程侧嵌入式运行时的封装。
//!
//! 装配语义与 legacy 宿主装配一致（配方数据装配 + 宿主五件套），区分仅在
//! 装配的发起方：本模块从 Rust 侧发起，Python 侧只持有「用 Python 表达最
//! 自然」的部分（离线模型桩/装配助手）。Rust 接线层后续各域模块经此入口
//! 驱动回合与读取事件流。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use pyo3::prelude::*;
use pyo3::types::PyDict;
use serde_json::Value as JsonValue;

use super::bridge::{register_objects, RustEmbedder, RustMemoryStore, RustTransport};

const BRIDGE_MODULE_SOURCE: &str = include_str!("py/bridge.py");

const DEFAULT_STUB_REPLY: &str = "（stub 缺省回复）";

/// 归一化目录路径：Windows canonicalize 产出 `\\?\` 前缀的 verbatim 路径，
/// Python 导入器无法可靠处理该类路径——统一转换为普通路径形态。
fn readable_path(path: PathBuf) -> PathBuf {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
    let text = canonical.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        canonical
    }
}

/// 解释器就绪哨兵（auto-initialize 特性下首次 attach 自动初始化；
/// 此处主动触碰一次，保证初始化发生在装配早期而非首次回合）。
pub fn ensure_python() {
    static READY: OnceLock<()> = OnceLock::new();
    READY.get_or_init(|| {
        let _: Result<(), PyErr> = Python::attach(|py| {
            let _ = py;
            Ok(())
        });
    });
}

/// 经桥模块调用引擎同步操作（JSON 进/JSON 出；域模块访问引擎公开 API
/// 的统一通道，薄包装在 bridge.py 的 op 注册表中）。
pub fn call_engine_op(op: &str, args: JsonValue) -> Result<JsonValue, String> {
    ensure_python();
    let args_json = args.to_string();
    let result_json = Python::attach(|py| -> PyResult<String> {
        let bridge = py.import("inkling_bridge")?;
        let outcome = bridge.call_method1("invoke", (op, args_json))?;
        outcome.extract()
    })
    .map_err(|err: PyErr| err.to_string())?;
    serde_json::from_str(&result_json).map_err(|err| format!("引擎操作返回不可解析: {err}"))
}

/// 经桥模块调用引擎异步操作（JSON 进/JSON 出；awaitable 经异步桥贯通）。
pub async fn call_engine_op_async(op: &str, args: JsonValue) -> Result<JsonValue, String> {
    ensure_python();
    let args_json = args.to_string();
    let result_json = Python::attach(|py| -> PyResult<String> {
        let bridge = py.import("inkling_bridge")?.unbind();
        let fut = Python::attach(|py| -> PyResult<_> {
            let coro = bridge
                .bind(py)
                .call_method1("invoke_async", (op, args_json))?;
            pyo3_async_runtimes::tokio::into_future(coro)
        })?;
        pyo3_async_runtimes::tokio::run(py, async move {
            let value = fut.await?;
            Python::attach(|py| value.bind(py).extract::<String>())
        })
    })
    .map_err(|err: PyErr| err.to_string())?;
    serde_json::from_str(&result_json).map_err(|err| format!("引擎操作返回不可解析: {err}"))
}

/// 装配选项：仓库根（引擎/legacy 包加载路径）、存储 URI、运行数据目录、
/// 离线模型桩脚本（按消息子串匹配回复）。
#[derive(Clone)]
pub struct BootOptions {
    pub repo_root: PathBuf,
    pub storage_uri: String,
    pub data_dir: Option<PathBuf>,
    pub stub_script: Option<JsonValue>,
    pub default_reply: String,
}

impl Default for BootOptions {
    fn default() -> Self {
        Self {
            repo_root: PathBuf::new(),
            storage_uri: "memory://".to_string(),
            data_dir: None,
            stub_script: None,
            default_reply: DEFAULT_STUB_REPLY.to_string(),
        }
    }
}

/// 装配结果摘要（工具/事件类型清单：宿主侧观测与门禁断言用）。
#[derive(Debug, Clone)]
pub struct BootReport {
    pub tool_names: Vec<String>,
    pub event_types: Vec<String>,
}

/// 回合请求（状态载荷 + 审批决议注入；auto_accept_review 仅离线验证用，
/// 生产宿主按审批卡交互——默认关闭）。
#[derive(Clone)]
pub struct RoundRequest {
    pub input_text: String,
    pub thread_id: String,
    pub round_id: String,
    pub step_args: Option<JsonValue>,
    pub inject: Option<JsonValue>,
    pub auto_accept_review: bool,
}

/// 回合结果：终止原因 + 最终输出 + 全量事件流（引擎事件协议形态）。
#[derive(Debug, Clone)]
pub struct RoundOutcome {
    pub reason: String,
    pub output: Option<String>,
    pub events: Vec<JsonValue>,
}

/// 协议注入验证结果（嵌入器评分可用性 / 记忆回路剩余条目）。
#[derive(Debug, Clone)]
pub struct ProtocolCheck {
    pub embedding_score: f64,
    pub memory_remaining: usize,
}

struct Inner {
    runtime: Py<PyAny>,
    host: Py<PyAny>,
    transport: Py<RustTransport>,
}

/// 引擎宿主句柄：装配一次、回合驱动多次、结尾关停（进程级单例语义）。
pub struct EngineHost {
    inner: Mutex<Option<Inner>>,
}

impl EngineHost {
    /// 装配嵌入式引擎运行时（重复装配由引擎幂等语义兜底）。
    pub fn boot(options: BootOptions) -> Result<EngineHost, String> {
        ensure_python();
        let repo_root = readable_path(options.repo_root.clone())
            .to_string_lossy()
            .into_owned();
        // 种子根 = 产品根 inkling/（seed_data 所在目录）
        let seed_root = readable_path(PathBuf::from(&repo_root).join("inkling"))
            .to_string_lossy()
            .into_owned();
        let storage_uri = options.storage_uri.clone();
        let data_dir = options.data_dir.map(|p| readable_path(p).to_string_lossy().into_owned());
        let script_json = options.stub_script.map(|v| v.to_string());
        let default_reply = options.default_reply.clone();

        let (runtime, host_out, transport) =
            Python::attach(|py| -> PyResult<(Py<PyAny>, Py<PyAny>, Py<RustTransport>)> {
                // 仓库根置前：legacy/种子包从仓库代码加载；引擎包目录紧随其后
                // （repo/ink_engine 为包外层）；开发形态再补 venv 站点包
                // （发行形态由捆绑运行时自带依赖，此步无副作用）。
                let sys = py.import("sys")?;
                let path = sys.getattr("path")?;
                path.call_method1(
                    pyo3::intern!(py, "insert"),
                    (0, format!("{repo_root}/ink_engine")),
                )?;
                path.call_method1(pyo3::intern!(py, "insert"), (1, repo_root.clone()))?;
                let venv_site = PathBuf::from(&repo_root).join(".venv/Lib/site-packages");
                if venv_site.is_dir() {
                    // .pth 机制注册（pywintypes 等按 venv 布局的依赖须经此处）
                    py.import("site")?.call_method1(
                        "addsitedir",
                        (readable_path(venv_site).to_string_lossy().into_owned(),),
                    )?;
                }
                // 内嵌桥模块注册进 sys.modules（后续回合驱动 import 复用）
                let bridge_code = std::ffi::CString::new(BRIDGE_MODULE_SOURCE)
                    .expect("桥模块内嵌源码含 NUL 字节");
                let bridge = PyModule::from_code(
                    py,
                    bridge_code.as_c_str(),
                    c"py/bridge.py",
                    c"inkling_bridge",
                )?;
                py.import("sys")?
                    .getattr("modules")?
                    .set_item("inkling_bridge", bridge.clone())?;
                register_objects(py)?;

                // 事件传输回桥（回合事件流终点）
                let transport = Py::new(py, RustTransport::new())?;

                // 离线模型桩（脚本匹配；缺省回复兜底）
                let llm_kwargs = PyDict::new(py);
                if let Some(script) = script_json.as_deref() {
                    let script_dict = py.import("json")?.call_method1("loads", (script,))?;
                    llm_kwargs.set_item("script", script_dict)?;
                }
                llm_kwargs.set_item("default_reply", &default_reply)?;
                let llm = bridge.call_method("StubLLM", (), Some(&llm_kwargs))?;

                // 宿主五件套（存储 URI + 模型桩 + Rust 传输回桥）
                let host_kwargs = PyDict::new(py);
                host_kwargs.set_item("storage_uri", &storage_uri)?;
                host_kwargs.set_item("llm", llm.clone())?;
                host_kwargs.set_item("transport", transport.clone_ref(py))?;
                let host = bridge.call_method("make_host", (), Some(&host_kwargs))?;

                // 装配（异步发起：在运行环内创建协程并等待完成）
                let boot_kwargs = PyDict::new(py);
                boot_kwargs.set_item("host", host.clone())?;
                if let Some(data) = data_dir.as_deref() {
                    boot_kwargs.set_item("data_dir", data)?;
                }
                let boot_kwargs = boot_kwargs.unbind();
                let (runtime_py, host_py) =
                    pyo3_async_runtimes::tokio::run(
                        py,
                        async move {
                            let fut = Python::attach(|py| -> PyResult<_> {
                                let legacy_host = py.import("legacy.host.host")?;
                                let boot_kwargs = boot_kwargs
                                    .bind(py)
                                    .cast::<PyDict>()?
                                    .to_owned();
                                let root_path = py
                                    .import("pathlib")?
                                    .call_method1("Path", (seed_root.clone(),))?;
                                let coro = legacy_host.call_method(
                                    "boot_inkling",
                                    (root_path,),
                                    Some(&boot_kwargs),
                                )?;
                                pyo3_async_runtimes::tokio::into_future(coro)
                            })?;
                            let booted = fut.await?;
                            Python::attach(|py| {
                                let runtime_py = booted.bind(py).get_item(0)?.unbind();
                                let host_py = booted.bind(py).get_item(1)?.unbind();
                                Ok((runtime_py, host_py))
                            })
                        },
                    )?;
                // 模块级运行时句柄绑定（引擎操作通道的出口；桥模块持有）
                py.import("inkling_bridge")?
                    .call_method1("bind_runtime", (runtime_py.clone_ref(py), host_py.clone_ref(py)))?;
                Ok((runtime_py, host_py, transport))
            })
            .map_err(|err: PyErr| err.to_string())?;

        let handle = EngineHost {
            inner: Mutex::new(Some(Inner {
                runtime,
                host: host_out,
                transport,
            })),
        };
        let _ = handle.report();
        Ok(handle)
    }

    /// 装配摘要（工具/事件类型清单；观测与门禁用）。
    pub fn report(&self) -> Result<BootReport, String> {
        let inner = self.inner.lock().unwrap();
        let Some(inner) = inner.as_ref() else {
            return Err("引擎未装配".to_string());
        };
        let report = Python::attach(|py| {
            let bridge = py.import("inkling_bridge")?;
            let runtime_ref = inner.runtime.clone_ref(py);
            let summary = bridge
                .call_method1(pyo3::intern!(py, "boot_summary"), (runtime_ref,))?;
            let map: HashMap<String, Vec<String>> = summary.extract()?;
            Ok(BootReport {
                tool_names: map.get("tool_names").cloned().unwrap_or_default(),
                event_types: map.get("event_types").cloned().unwrap_or_default(),
            })
        })
        .map_err(|err: PyErr| err.to_string())?;
        Ok(report)
    }

    /// 驱动一次回合直至终态（审批卡按需决议）。
    pub fn round(&self, request: RoundRequest) -> Result<RoundOutcome, String> {
        let inner = self.inner.lock().unwrap();
        let Some(inner) = inner.as_ref() else {
            return Err("引擎未装配（先 boot）".to_string());
        };
        let input_text = request.input_text.clone();
        let thread_id = request.thread_id.clone();
        let round_id = request.round_id.clone();
        let step_args = request.step_args.map(|v| v.to_string());
        let inject = request.inject.map(|v| v.to_string());
        let auto_accept = request.auto_accept_review;

        let (reason, output) = Python::attach(|py| -> PyResult<(String, Option<String>)> {
            let bridge = py.import("inkling_bridge")?.unbind();
            let kwargs = PyDict::new(py);
            kwargs.set_item("input_text", input_text.clone())?;
            kwargs.set_item("thread_id", thread_id.clone())?;
            kwargs.set_item("round_id", round_id.clone())?;
            if let Some(step_args) = step_args.as_deref() {
                let rendered = py.import("json")?.call_method1("loads", (step_args,))?;
                kwargs.set_item("step_args", rendered)?;
            }
            if let Some(inject) = inject.as_deref() {
                let rendered = py.import("json")?.call_method1("loads", (inject,))?;
                kwargs.set_item("inject", rendered)?;
            }
            kwargs.set_item("auto_accept_review", auto_accept)?;
            let kwargs = kwargs.unbind();
            let runtime_ref = inner.runtime.clone_ref(py);
            let host_ref = inner.host.clone_ref(py);
            pyo3_async_runtimes::tokio::run(
                py,
                async move {
                    let fut = Python::attach(|py| -> PyResult<_> {
                        let bridge = bridge.bind(py);
                        let kwargs = kwargs.bind(py).cast::<PyDict>()?.to_owned();
                        let coro = bridge.call_method(
                            "execute_round_to_reply",
                            (runtime_ref, host_ref),
                            Some(&kwargs),
                        )?;
                        pyo3_async_runtimes::tokio::into_future(coro)
                    })?;
                    let result = fut.await?;
                    Python::attach(|py| {
                        let reason: String = result.bind(py).get_item("reason")?.extract()?;
                        let state = result.bind(py).get_item("state")?;
                        let reply: Option<String> =
                            state.call_method1("get", ("reply",))?.extract()?;
                        let output: Option<String> = match reply {
                            Some(value) => Some(value),
                            None => state.call_method1("get", ("output",))?.extract()?,
                        };
                        Ok((reason, output))
                    })
                },
            )
        })
        .map_err(|err: PyErr| err.to_string())?;

        let raw_events = Python::attach(|py| {
            let transport = inner.transport.clone_ref(py);
            let events = {
                let borrowed = transport.borrow(py);
                borrowed.take_events()
            };
            Ok(events)
        })
        .map_err(|err: PyErr| err.to_string())?;
        let mut events = Vec::with_capacity(raw_events.len());
        for raw in raw_events {
            if let Ok(value) = serde_json::from_str(&raw) {
                events.push(value);
            }
        }
        Ok(RoundOutcome {
            reason,
            output,
            events,
        })
    }

    /// 协议注入验证：Rust 嵌入器/记忆存储被引擎侧消费回路一次往返。
    pub fn check_protocol_injection(&self) -> Result<ProtocolCheck, String> {
        let inner = self.inner.lock().unwrap();
        let Some(inner) = inner.as_ref() else {
            return Err("引擎未装配（先 boot）".to_string());
        };
        let runtime_ref = Python::attach(|py| inner.runtime.clone_ref(py));
        let embedding_score = Python::attach(|py| -> PyResult<f64> {
            let bridge = py.import("inkling_bridge")?.unbind();
            let embedder = Py::new(py, RustEmbedder::new(384))?;
            let runtime_ref = runtime_ref.clone_ref(py);
            pyo3_async_runtimes::tokio::run(
                py,
                async move {
                    let fut = Python::attach(|py| -> PyResult<_> {
                        let coro = bridge.bind(py).call_method1(
                            "check_embedding_protocol",
                            (runtime_ref, embedder.clone_ref(py)),
                        )?;
                        pyo3_async_runtimes::tokio::into_future(coro)
                    })?;
                    let value = fut.await?;
                    Python::attach(|py| value.bind(py).extract::<f64>())
                },
            )
        })
        .map_err(|err: PyErr| err.to_string())?;

        let memory_remaining = Python::attach(|py| -> PyResult<i64> {
            let bridge = py.import("inkling_bridge")?.unbind();
            let store = Py::new(py, RustMemoryStore::new())?;
            pyo3_async_runtimes::tokio::run(
                py,
                async move {
                    let fut = Python::attach(|py| -> PyResult<_> {
                        let coro = bridge.bind(py).call_method1(
                            "check_memory_protocol",
                            (store.clone_ref(py),),
                        )?;
                        pyo3_async_runtimes::tokio::into_future(coro)
                    })?;
                    let value = fut.await?;
                    Python::attach(|py| value.bind(py).extract::<i64>())
                },
            )
        })
        .map_err(|err: PyErr| err.to_string())?;

        Ok(ProtocolCheck {
            embedding_score,
            memory_remaining: memory_remaining.max(0) as usize,
        })
    }

    /// 关停运行时（幂等）。
    pub fn stop(&self) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        let Some(inner) = inner.as_ref() else {
            return Ok(());
        };
        Python::attach(|py| -> PyResult<()> {
            let bridge = py.import("inkling_bridge")?.unbind();
            let runtime_ref = inner.runtime.clone_ref(py);
            pyo3_async_runtimes::tokio::run(
                py,
                async move {
                    let fut = Python::attach(|py| -> PyResult<_> {
                        let coro = bridge
                            .bind(py)
                            .call_method1("stop_runtime", (runtime_ref,))?;
                        pyo3_async_runtimes::tokio::into_future(coro)
                    })?;
                    fut.await?;
                    Ok(())
                },
            )
        })
        .map_err(|err: PyErr| err.to_string())
    }
}

impl Drop for EngineHost {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_root() -> PathBuf {
        readable_path(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."),
        )
    }

    #[test]
    fn boot_stub_round_and_protocols() {
        let options = BootOptions {
            repo_root: repo_root(),
            storage_uri: "memory://".to_string(),
            data_dir: None,
            stub_script: Some(serde_json::json!({
                "研究": {"reply": "研究计划已展开：采集 → 解析 → 评审。"}
            })),
            default_reply: DEFAULT_STUB_REPLY.to_string(),
        };
        let host = EngineHost::boot(options).expect("装配失败");
        let report = host.report().expect("摘要失败");
        assert!(!report.tool_names.is_empty(), "工具清单为空");

        let outcome = host
            .round(RoundRequest {
                input_text: "研究墨引擎机制".to_string(),
                thread_id: "bridge-t1".to_string(),
                round_id: "bridge-r1".to_string(),
                step_args: None,
                inject: None,
                auto_accept_review: true,
            })
            .expect("回合失败");
        assert_eq!(outcome.reason, "reply", "回合未完成到回复");
        assert!(!outcome.events.is_empty(), "事件流为空");

        let check = host.check_protocol_injection().expect("协议验证失败");
        assert!(check.embedding_score >= 0.0, "嵌入协议异常");
        assert_eq!(check.memory_remaining, 0, "记忆回路残留条目");

        host.stop().expect("关停失败");
    }

    #[test]
    fn op_channel_reads_boot_summary_and_knowledge() {
        let options = BootOptions {
            repo_root: repo_root(),
            ..BootOptions::default()
        };
        let host = EngineHost::boot(options).expect("装配失败");

        let specs = call_engine_op("engine.collect_specs", serde_json::json!({}))
            .expect("操作通道调用失败");
        assert!(specs.is_array(), "工具清单应为数组");

        let summary = host.report().expect("摘要失败");
        assert!(!summary.tool_names.is_empty(), "操作通道与装配摘要口径不一致");

        host.stop().expect("关停失败");
    }
}
