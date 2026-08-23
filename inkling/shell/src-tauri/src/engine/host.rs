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

/// 桥模块状态是进程级单例（装配句柄/回调注册表）：触碰桥的测试
/// 必须串行执行，否则并行装配互相覆盖句柄，跨测试串链。
///
/// 全 crate 共用此护栏（域模块装配/接线测试同样触碰桥）——测试间
/// 的串行化以本锁为唯一权威，禁止另起并行装配入口。
pub fn bridge_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// 经桥模块调用引擎异步操作（JSON 进/JSON 出；awaitable 经异步桥贯通）。
pub async fn call_engine_op_async(op: &str, args: JsonValue) -> Result<JsonValue, String> {
    ensure_python();
    let args_json = args.to_string();
    let op_name = op.to_string();
    let result_json = Python::attach(|py| -> PyResult<String> {
        let bridge = py.import("inkling_bridge")?.unbind();
        // 协程须在异步桥的驱动上下文内创建并转换（跨语言可等待对象的
        // 事件循环经任务局部变量传递）——创建点若在桥驱动之外，将拿
        // 不到运行中的事件循环，协程悬空报「no running event loop」。
        pyo3_async_runtimes::tokio::run(py, async move {
            let fut = Python::attach(|py| -> PyResult<_> {
                let coro = bridge
                    .bind(py)
                    .call_method1("invoke_async", (op_name.clone(), args_json.clone()))?;
                pyo3_async_runtimes::tokio::into_future(coro)
            })?;
            let value = fut.await?;
            Python::attach(|py| value.bind(py).extract::<String>())
        })
    })
    .map_err(|err: PyErr| err.to_string())?;
    serde_json::from_str(&result_json).map_err(|err| format!("引擎操作返回不可解析: {err}"))
}

/// 引擎路径装配机制的七块 feature flag（装配参数，默认全关）。
///
/// 引擎侧按名读取的渐进灰度开关：每块独立开启、独立关闭（= 单块回滚
/// 路径）；本壳只负责携带与透传（按名 JSON 装配数据形态见
/// [`crate::domain::boot::path_assembly_data`]），引擎读取方由引擎侧
/// 装配入口按名消费。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PathAssemblyFlags {
    /// 结点契约 + 链接校验器（contract + LinkValidator）。
    pub contract_enabled: bool,
    /// 边证据存储（EdgeEvidenceStore 评分与统计）。
    pub edge_evidence_enabled: bool,
    /// 沉淀钩子（SettleHooks：成败/成本归集、失败点提案）。
    pub settle_hooks_enabled: bool,
    /// 结点池治理（容量/淘汰/合并/提案预算）。
    pub pool_governance_enabled: bool,
    /// 路径组装器（PathAssembler：schema 反推/LLM 草稿/证据评分）。
    pub assembler_enabled: bool,
    /// 多径执行 + 汇流裁决（MultiPath + Junction）。
    pub multipath_enabled: bool,
    /// 指纹缓存（上下文指纹 → 组装结果复用与顶替）。
    pub fingerprint_cache_enabled: bool,
}

impl Default for PathAssemblyFlags {
    fn default() -> Self {
        Self {
            contract_enabled: false,
            edge_evidence_enabled: false,
            settle_hooks_enabled: false,
            pool_governance_enabled: false,
            assembler_enabled: false,
            multipath_enabled: false,
            fingerprint_cache_enabled: false,
        }
    }
}

/// 装配选项：仓库根（引擎/legacy 包加载路径）、存储 URI、运行数据目录、
/// 离线模型桩脚本（按消息子串匹配回复）、引擎路径装配机制开关。
#[derive(Clone)]
pub struct BootOptions {
    pub repo_root: PathBuf,
    pub storage_uri: String,
    pub data_dir: Option<PathBuf>,
    pub stub_script: Option<JsonValue>,
    pub default_reply: String,
    /// 引擎路径装配机制 feature flag（默认全关；随装配透传为按名
    /// JSON 装配数据，见 [`crate::domain::boot::path_assembly_data`]）。
    pub path_assembly: PathAssemblyFlags,
}

impl Default for BootOptions {
    fn default() -> Self {
        Self {
            repo_root: PathBuf::new(),
            storage_uri: "memory://".to_string(),
            data_dir: None,
            stub_script: None,
            default_reply: DEFAULT_STUB_REPLY.to_string(),
            path_assembly: PathAssemblyFlags::default(),
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

    /// 异步引擎操作在单线程内完成（引擎回合在 Python 事件循环内执行，
    /// 全部调用须稳定落在同一线程——测试驱动也必须遵守该线程绑定）。
    fn block_on_op(op: &str, args: JsonValue) -> Result<JsonValue, String> {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio 运行时创建失败")
            .block_on(call_engine_op_async(op, args))
    }

    #[test]
    fn boot_stub_round_and_protocols() {
        let _serial = bridge_guard();
        let options = BootOptions {
            repo_root: repo_root(),
            storage_uri: "memory://".to_string(),
            data_dir: None,
            stub_script: Some(serde_json::json!({
                "研究": {"reply": "研究计划已展开：采集 → 解析 → 评审。"}
            })),
            default_reply: DEFAULT_STUB_REPLY.to_string(),
            path_assembly: PathAssemblyFlags::default(),
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
        let _serial = bridge_guard();
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

    #[test]
    fn op_channel_domain_actions() {
        let _serial = bridge_guard();
        let root = repo_root();
        let options = BootOptions {
            repo_root: root.clone(),
            ..BootOptions::default()
        };
        let host = EngineHost::boot(options).expect("装配失败");

        // 安全判定回调（判定逻辑在域层；此处注册最小放行桩，覆盖回调桥回路）
        crate::engine::bridge::register_callback(
            "security.sandbox_validate",
            Box::new(|_payload: String| -> PyResult<String> {
                Ok("{\"pass\": true}".to_string())
            }),
        )
        .expect("回调注册失败");
        crate::engine::bridge::register_callback(
            "security.guards_operation",
            Box::new(|_payload: String| -> PyResult<String> {
                Ok("{\"guarded\": false}".to_string())
            }),
        )
        .expect("回调注册失败");
        crate::engine::bridge::register_callback(
            "security.gating_tier",
            Box::new(|_payload: String| -> PyResult<String> {
                Ok("{\"review\": false}".to_string())
            }),
        )
        .expect("回调注册失败");

        // 补丁链：主题档直过应用（L0 无审批卡）→ 链尾回退（决议注入）
        let applied = block_on_op(
            "patch.apply",
            serde_json::json!({
                "kind": "theme",
                "payload": {"tokens": {"accent.approval": "#d97706"}},
                "rationale": "主题微调",
                "thread_id": "ops-t1",
            }),
        )
        .expect("补丁应用失败");
        let outcome = applied.get("outcome").expect("补丁结果缺 outcome");
        assert_eq!(outcome.get("status").and_then(|v| v.as_str()), Some("applied"));
        let patch_id = outcome
            .get("patch_id")
            .and_then(|v| v.as_i64())
            .expect("补丁缺 patch_id");

        let reverted = block_on_op(
            "patch.revert",
            serde_json::json!({
                "patch_id": patch_id,
                "decision": "accept",
                "reason": "撤掉测试补丁",
                "thread_id": "ops-t1",
            }),
        )
        .expect("补丁回退失败");
        assert_eq!(
            reverted["outcome"].get("status").and_then(|v| v.as_str()),
            Some("reverted")
        );

        // 审批卡请求（决议注入步：后续补丁应用消费预注入决议）
        let card = block_on_op(
            "approval.gate_card_request",
            serde_json::json!({
                "key": "workspace:authorize",
                "action": {"tool": "workspace_authorize", "root": "/tmp/ws"},
                "payload": {"review_type": "gate", "node_label": "工作区授权"},
                "decision": "accept",
                "thread_id": "ops-t1",
            }),
        )
        .expect("审批卡请求失败");
        assert_eq!(card.get("decision").and_then(|v| v.as_str()), Some("accept"));

        // 工具注册表移除（幂等：无该工具 = removed false）
        let removed = call_engine_op(
            "engine.tool_registry_remove",
            serde_json::json!({"name": "no_such_tool"}),
        )
        .expect("工具移除失败");
        assert_eq!(removed.get("removed").and_then(|v| v.as_bool()), Some(false));

        // 存储快照/恢复（memory 后端序列化往返）
        let snap_dir = std::env::temp_dir().join(format!(
            "inkling-ops-snapshot-{}",
            uuid::Uuid::new_v4()
        ));
        let snap_path = snap_dir.join("bridge.sqlite");
        std::fs::create_dir_all(&snap_dir).unwrap();
        let snap_text = snap_path.to_string_lossy().into_owned();
        block_on_op("engine.storage_snapshot", serde_json::json!({"dest": snap_text}))
            .expect("快照失败");
        block_on_op("engine.storage_restore", serde_json::json!({"src": snap_text}))
            .expect("恢复失败");
        let _ = std::fs::remove_dir_all(&snap_dir);

        // 会话记录：写 → 墓碑删除 → 列表可见删除标记
        block_on_op(
            "engine.records_put",
            serde_json::json!({
                "collection": "sessions",
                "key": "ops-session-1",
                "data": {
                    "thread_id": "ops-session-1",
                    "title": "测试会话",
                    "created_at": 1.0,
                    "updated_at": 2.0,
                    "message_count": 3,
                    "current_leaf": 1i64,
                    "rename_count": 0,
                    "deleted": false,
                },
            }),
        )
        .expect("会话记录写入失败");
        block_on_op(
            "engine.records_delete",
            serde_json::json!({"collection": "sessions", "key": "ops-session-1"}),
        )
        .expect("会话记录删除失败");
        let listed =
            block_on_op("engine.records_list", serde_json::json!({"collection": "sessions"}))
                .expect("会话记录列出失败");
        assert!(
            listed
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r.get("deleted").and_then(|v| v.as_bool()) == Some(true)),
            "删除应落墓碑标记"
        );

        // 记忆查询（空集 = 空条目数组）
        let memory = block_on_op(
            "engine.memory_query",
            serde_json::json!({"namespace": "user:ops"}),
        )
        .expect("记忆查询失败");
        assert!(memory.get("entries").and_then(|v| v.as_array()).is_some());

        // MCP 状态观测：未挂载 = 空注册表；断开未知 server = closed false
        let registry =
            call_engine_op("engine.mcp_process_registry", serde_json::json!({}))
                .expect("进程注册表失败");
        assert!(registry.get("servers").and_then(|v| v.as_array()).is_some());
        let closed = block_on_op(
            "mcp.disconnect",
            serde_json::json!({"server_id": "ghost-server"}),
        )
        .expect("断开失败");
        assert_eq!(closed.get("closed").and_then(|v| v.as_bool()), Some(false));

        // 目标注册（工具内置 + 五类活跃态目标）
        call_engine_op(
            "patch.apply_target_register",
            serde_json::json!({"kind": "tool"}),
        )
        .expect("目标注册失败");
        call_engine_op("patch.register_live_targets", serde_json::json!({}))
            .expect("活跃态目标注册失败");

        // 安全流水线替换 + 界面活跃态生效
        call_engine_op(
            "pipeline.install_security_pipeline",
            serde_json::json!({}),
        )
        .expect("安全流水线安装失败");
        call_engine_op(
            "engine.introspection_ui_apply",
            serde_json::json!({"tokens": {"accent.approval": "#d97706"}}),
        )
        .expect("界面补丁生效失败");

        // 路由轻调用（离线桩：无模型配置回落主挡 = 引擎模型桩）
        let router = block_on_op(
            "engine.router_light_complete",
            serde_json::json!({
                "messages": [
                    {"role": "system", "content": "标题生成：一句话 ≤12 字"},
                    {"role": "user", "content": "说说你在做什么"},
                ]
            }),
        )
        .expect("路由轻调用失败");
        assert!(router.get("content").and_then(|v| v.as_str()).is_some());

        // 回合链：跑一回合 → 分支（锚点 = 链尾）→ 续跑 → 链索引 → 回退 → 清理
        let outcome = host
            .round(RoundRequest {
                input_text: "研究墨引擎机制".to_string(),
                thread_id: "ops-chain-t1".to_string(),
                round_id: "ops-chain-r1".to_string(),
                step_args: None,
                inject: None,
                auto_accept_review: true,
            })
            .expect("回合失败");
        assert_eq!(outcome.reason, "reply", "回合未完成到回复");
        let latest = block_on_op(
            "engine.thread_latest_checkpoint",
            serde_json::json!({"thread_id": "ops-chain-t1"}),
        )
        .expect("链尾读取失败")
        .get("checkpoint_id")
        .and_then(|v| v.as_i64())
        .expect("链尾缺 checkpoint_id");
        let branched = block_on_op(
            "engine.thread_branch",
            serde_json::json!({
                "thread_id": "ops-chain-t1",
                "parent_id": latest,
                "state_patch": {"note": "分支测试"},
            }),
        )
        .expect("分支失败");
        let branch_leaf = branched
            .get("checkpoint_id")
            .and_then(|v| v.as_i64())
            .expect("分支缺新叶");
        assert!(branch_leaf > latest, "新叶 id 应大于锚点");
        let resumed = block_on_op(
            "engine.thread_resume",
            serde_json::json!({
                "thread_id": "ops-chain-t1",
                "checkpoint_id": branch_leaf,
                "input": "继续说说",
                "round_id": "ops-chain-r2",
            }),
        )
        .expect("续跑失败");
        assert!(resumed.get("reason").and_then(|v| v.as_str()).is_some());
        let chain = block_on_op(
            "engine.thread_chain_index",
            serde_json::json!({"thread_id": "ops-chain-t1"}),
        )
        .expect("链索引失败");
        assert!(
            chain.as_array().map(|rows| !rows.is_empty()).unwrap_or(false),
            "链索引应有行"
        );
        let reverted_chain = block_on_op(
            "engine.thread_revert",
            serde_json::json!({
                "thread_id": "ops-chain-t1",
                "target_id": branch_leaf,
            }),
        )
        .expect("链回退失败");
        assert_eq!(
            reverted_chain.get("reverted_to").and_then(|v| v.as_i64()),
            Some(branch_leaf)
        );
        let cleaned = block_on_op(
            "engine.storage_delete_thread",
            serde_json::json!({"thread_id": "ops-chain-t1"}),
        )
        .expect("会话清理失败");
        assert!(
            cleaned
                .get("checkpoints_removed")
                .and_then(|v| v.as_i64())
                .map(|n| n >= 0)
                .unwrap_or(false),
            "清理应返回移除数量"
        );

        host.stop().expect("关停失败");
    }

    #[test]
    fn op_channel_canary_rounds_on_seed_graph() {
        let _serial = bridge_guard();
        let root = repo_root();
        fn seed(root: &std::path::Path, name: &str) -> serde_json::Value {
            let path = root.join("inkling").join("seed_data").join(name);
            let text = std::fs::read_to_string(path).expect("seed 文件读取失败");
            serde_json::from_str(&text).expect("seed 文件 JSON 非法")
        }
        let options = BootOptions {
            repo_root: root.clone(),
            ..BootOptions::default()
        };
        let host = EngineHost::boot(options).expect("装配失败");

        let graph_data = seed(&root, "graph.json");
        let workflow_data = seed(&root, "workflow.json");

        call_engine_op(
            "graph.register_node_types",
            serde_json::json!({"workflow": workflow_data}),
        )
        .expect("节点类型注册失败");
        let built = call_engine_op(
            "graph.build_round_graph",
            serde_json::json!({"graph": graph_data, "workflow": workflow_data}),
        )
        .expect("回合图构造失败");
        assert!(
            built.get("graph").and_then(|v| v.get("nodes")).is_some(),
            "图描述应含节点清单"
        );

        let canary = block_on_op(
            "engine.canary_stub_round",
            serde_json::json!({
                "graph": graph_data,
                "workflow": workflow_data,
                "input": "试跑一下",
                "stub_script": {"试跑": {"reply": "试跑通过"}},
            }),
        )
        .expect("试跑回合失败");
        assert!(
            canary.get("reason").and_then(|v| v.as_str()).is_some(),
            "试跑应返回终止原因"
        );
        assert!(
            canary.get("events").and_then(|v| v.as_array()).is_some(),
            "试跑应返回事件流"
        );

        host.stop().expect("关停失败");
    }
}
