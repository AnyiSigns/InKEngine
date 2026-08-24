//! 引擎装配与回合驱动：壳进程侧嵌入式运行时的封装。
//!
//! 装配语义 = 配方数据装配 + 宿主五件套，装配的发起方在 Rust 侧；Python
//! 侧持有「用 Python 表达最自然」的部分（离线模型桩/装配助手/宿主装配
//! 域包），全部经 include_str 内嵌进二进制，运行时以模块形态注册进
//! 解释器（不依赖磁盘源码路径）。Rust 接线层各域模块经本入口驱动回合
//! 与读取事件流。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use pyo3::prelude::*;
use pyo3::types::PyDict;
use serde_json::Value as JsonValue;

use super::bridge::{register_objects, RustEmbedder, RustMemoryStore, RustTransport};

const BRIDGE_MODULE_SOURCE: &str = include_str!("py/bridge.py");

/// 嵌入式宿主装配域包（模块名 = 文件基名；包内相对导入自洽）。
///
/// 机制装配的宿主侧实现（配方构造/装配域/图配方/安全纵深等）：随壳进程
/// 内嵌执行，装配期注册为 ``inkling_host`` 包后即可被桥模块与装配入口
/// 按名导入。注册顺序按包内相对导入的依赖序（叶子在前，`host` 汇总，
/// `__init__` 最后执行——其顶层导入须等全部子模块就位）。
const HOST_PACKAGE_SOURCES: &[(&str, &str)] = &[
    ("assembly_domain", include_str!("py/inkling_host/assembly_domain.py")),
    ("build_domain", include_str!("py/inkling_host/build_domain.py")),
    ("convergence_domain", include_str!("py/inkling_host/convergence_domain.py")),
    ("environment_domain", include_str!("py/inkling_host/environment_domain.py")),
    ("graph_recipe", include_str!("py/inkling_host/graph_recipe.py")),
    ("knowledge_domain", include_str!("py/inkling_host/knowledge_domain.py")),
    ("live_apply", include_str!("py/inkling_host/live_apply.py")),
    ("mcp_service", include_str!("py/inkling_host/mcp_service.py")),
    ("model_layers", include_str!("py/inkling_host/model_layers.py")),
    ("quality", include_str!("py/quality.py")),
    ("review_pipeline", include_str!("py/inkling_host/review_pipeline.py")),
    ("round_steps_feed", include_str!("py/inkling_host/round_steps_feed.py")),
    ("scoring", include_str!("py/inkling_host/scoring.py")),
    ("security_domain", include_str!("py/inkling_host/security_domain.py")),
    ("recipe_loader", include_str!("py/inkling_host/recipe_loader.py")),
    ("host", include_str!("py/inkling_host/host.py")),
    ("__init__", include_str!("py/inkling_host/__init__.py")),
];

/// 注册嵌入式宿主装配域包：包根 + 各子模块全部预注册进 ``sys.modules``，
/// 包内相对导入（``from .x import y``）经各模块的 ``__package__`` 解析。
fn register_host_package(py: Python<'_>) -> PyResult<()> {
    let package = PyModule::new(py, "inkling_host")?;
    package.setattr("__path__", Vec::<String>::new())?;
    package.setattr("__package__", "")?;
    py.import("sys")?
        .getattr("modules")?
        .set_item("inkling_host", package.unbind())?;
    for (name, source) in HOST_PACKAGE_SOURCES {
        let code = std::ffi::CString::new(*source).expect("内嵌宿主模块源码含 NUL 字节");
        let full_name = format!("inkling_host.{name}");
        let module_name =
            std::ffi::CString::new(full_name.as_str()).expect("模块名含 NUL 字节");
        let module = PyModule::from_code(
            py,
            code.as_c_str(),
            c"py/inkling_host/<module>.py",
            module_name.as_c_str(),
        )?;
        module.setattr("__package__", "inkling_host")?;
        py.import("sys")?
            .getattr("modules")?
            .set_item(full_name, module.unbind())?;
    }
    Ok(())
}

const DEFAULT_STUB_REPLY: &str = "（stub 缺省回复）";

/// 读取行为准则层源文本（seed_data/boot_prompt.json 的 prompt 字段）。
fn load_behavior_prompt(seed_root: &str) -> Result<String, String> {
    let path = std::path::Path::new(seed_root).join("seed_data").join("boot_prompt.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|err| format!("行为准则层源缺失 {}: {err}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|err| format!("行为准则层源 JSON 非法: {err}"))?;
    value
        .get("prompt")
        .and_then(serde_json::Value::as_str)
        .map(|prompt| prompt.to_string())
        .ok_or_else(|| "行为准则层源缺 prompt 字段".to_string())
}

/// 读取行为准则层工具清单（seed_root/seed_data/tools.json）。
fn load_behavior_tools(seed_root: &str) -> Result<serde_json::Value, String> {
    let path = std::path::Path::new(seed_root).join("seed_data").join("tools.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|err| format!("行为准则层工具清单缺失 {}: {err}", path.display()))?;
    serde_json::from_str(&text).map_err(|err| format!("行为准则层工具清单 JSON 非法: {err}"))
}

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

/// 装配选项：仓库根（种子/引擎包解析基准）、存储 URI、运行数据目录、
/// 离线模型桩脚本（按消息子串匹配回复）、引擎路径装配机制开关、
/// 安全模式（崩溃循环下出厂基线启动，链内容不参与装配）。
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
    /// 安全模式：链内容（自写资产载体）不参与装配，出厂基线启动；
    /// 由崩溃计数触发（见 [`crate::domain::recovery`]）。
    pub safe_mode: bool,
    /// 捆绑形态：装配前自动完成资源解包（resources → 数据目录）与
    /// 内嵌解释器路径准备（发行包用户零 Python 前置；debug 构建可经
    /// `INKLING_BUNDLED=1` 模拟）。捆绑形态下 repo_root = 数据目录
    /// （引擎包/种子根随解包落位）。
    pub bundled: bool,
    /// 本地语义嵌入模型目录（granite-97m）：注入后引擎检索源默认挂
    /// 本地语义召回（懒加载 + 缺失降级确定性保底）；None = 不注入，
    /// 检索回落关键词基线（离线测试形态）。
    pub embedder_model_dir: Option<PathBuf>,
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
            safe_mode: false,
            bundled: false,
            embedder_model_dir: None,
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
        // 捆绑形态前置：资源解包（首启）→ 内嵌解释器路径准备，均在
        // 任何 Python API 触碰之前完成（pyo3 首次 attach 即初始化）。
        if options.bundled {
            let data_dir = options
                .data_dir
                .clone()
                .ok_or_else(|| "捆绑形态装配缺数据目录".to_string())?;
            let report = super::runtime::provision(&data_dir)?;
            super::runtime::prepare_bundled_python(&data_dir)?;
            let _ = report;
        }
        ensure_python();
        let repo_root = readable_path(options.repo_root.clone())
            .to_string_lossy()
            .into_owned();
        // 种子根 = 产品根 inkling/（seed_data 所在目录）
        let seed_root = readable_path(PathBuf::from(&repo_root).join("inkling"))
            .to_string_lossy()
            .into_owned();
        let storage_uri = options.storage_uri.clone();
        let data_dir_path = options.data_dir.clone();
        let data_dir = data_dir_path
            .as_ref()
            .map(|p| readable_path(p.clone()).to_string_lossy().into_owned());
        let script_json = options.stub_script.map(|v| v.to_string());
        let default_reply = options.default_reply.clone();
        // 回合行为层（行为准则层注入）：boot_prompt + 工具清单 → 纯函数
        // 组成（soul/准则/事实 + 打标准则 + 档位说明 + 交错引导语 + 工具名
        // 对照表），随宿主注入为每次 LLM 调用的系统消息。种子根齐备是
        // 装配前提（缺文件 = 显式失败，行为准则层为生产级必做项）。
        let behavior = crate::domain::prompt::compose_round_behavior(
            &load_behavior_prompt(&seed_root)?,
            &load_behavior_tools(&seed_root)?,
            crate::domain::prompt::ReasoningTier::LiteProbe,
        );
        let behavior_text = behavior;

        let (runtime, host_out, transport) =
            Python::attach(|py| -> PyResult<(Py<PyAny>, Py<PyAny>, Py<RustTransport>)> {
                // 捆绑形态：运行时目录登记为扩展模块 DLL 搜索位
                // （os.add_dll_directory：pyd 依赖解析的确定途径，
                // 覆盖 vcruntime/pywintypes 等随包原生依赖）
                if let Some(data) = data_dir_path.as_ref() {
                    let runtime_dir = super::runtime::runtime_dir_in(data);
                    if runtime_dir.is_dir() {
                        py.import("os")?.call_method1(
                            "add_dll_directory",
                            (runtime_dir.to_string_lossy().into_owned(),),
                        )?;
                    }
                }
                // 引擎包目录置前（repo/ink_engine 为包外层）；开发形态再补
                // venv 站点包（发行形态由捆绑运行时自带依赖，此步无副作用）。
                let sys = py.import("sys")?;
                let path = sys.getattr("path")?;
                path.call_method1(
                    pyo3::intern!(py, "insert"),
                    (0, format!("{repo_root}/ink_engine")),
                )?;
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
                // 宿主装配域包注册（桥 op 与装配入口按包名导入）
                register_host_package(py)?;

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
                // 离线模型桩句柄绑定（提示词生效断言的可观测出口）
                bridge.call_method1("bind_stub_llm", (llm.clone(),))?;

                // 宿主五件套（存储 URI + 模型桩 + Rust 传输回桥）
                let host_kwargs = PyDict::new(py);
                host_kwargs.set_item("storage_uri", &storage_uri)?;
                host_kwargs.set_item("llm", llm.clone())?;
                host_kwargs.set_item("transport", transport.clone_ref(py))?;
                // 本地语义嵌入器注入（模型目录显式传入；懒加载 + 缺失
                // 降级确定性保底由接线层嵌入器保证）——引擎检索源默认
                // 挂语义召回（出厂形态）；不注入 = 关键词基线
                let local_embedder = match options.embedder_model_dir.as_ref() {
                    Some(model_dir) => Some(Py::new(
                        py,
                        super::bridge::LocalOnnx::with_model_dir(model_dir.clone()),
                    )?),
                    None => None,
                };
                if let Some(embedder) = local_embedder.as_ref() {
                    host_kwargs.set_item("embedder", embedder.clone_ref(py))?;
                }
                host_kwargs.set_item("behavior", behavior_text.clone())?;
                let host = bridge.call_method("make_host", (), Some(&host_kwargs))?;

                // 装配（异步发起：在运行环内创建协程并等待完成）
                let boot_kwargs = PyDict::new(py);
                boot_kwargs.set_item("host", host.clone())?;
                if let Some(data) = data_dir.as_deref() {
                    boot_kwargs.set_item("data_dir", data)?;
                }
                boot_kwargs.set_item("safe_mode", options.safe_mode)?;
                if let Some(embedder) = local_embedder.as_ref() {
                    boot_kwargs.set_item("embedder", embedder.clone_ref(py))?;
                }
                let boot_kwargs = boot_kwargs.unbind();
                let (runtime_py, host_py) =
                    pyo3_async_runtimes::tokio::run(
                        py,
                        async move {
                            let fut = Python::attach(|py| -> PyResult<_> {
                                let host_module = py.import("inkling_host.host")?;
                                let boot_kwargs = boot_kwargs
                                    .bind(py)
                                    .cast::<PyDict>()?
                                    .to_owned();
                                let root_path = py
                                    .import("pathlib")?
                                    .call_method1("Path", (seed_root.clone(),))?;
                                let coro = host_module.call_method(
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
            safe_mode: false,
            ..BootOptions::default()
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

    /// 坏链注入（sqlite 存储，跨装配持久）：内容型损坏——补丁路径指向
    /// 字符串节点（组装即抛错），但链记录可解析（回退路径可达）。
    ///
    /// 引擎侧旁路写拦截（演化资产唯一写入路径 = 自指应用管线），测试
    /// 直写 records 表模拟「已落链的坏补丁」（产品代码无旁路）。
    fn corrupt_chain_record(data_dir: &std::path::Path) {
        let db_path = data_dir.join("inkling.sqlite");
        let conn = rusqlite::Connection::open(&db_path).expect("坏链注入：打开存储库失败");
        conn.execute(
            "INSERT OR REPLACE INTO records (collection, key, data) VALUES (?1, ?2, ?3)",
            rusqlite::params![
                "set_patch_chain",
                "chain",
                r##"{"base": {"theme": "broken"}, "patches": [{"op": "replace", "path": ["theme", "tokens"], "value": {"bg": "#000000"}}]}"##,
            ],
        )
        .expect("坏链注入：写入记录失败");
    }

    fn chain_version_now() -> i64 {
        let record = block_on_op(
            "engine.records_get",
            serde_json::json!({ "collection": "set_patch_chain", "key": "chain" }),
        )
        .expect("链记录读取失败");
        crate::domain::boot::chain_version(&record)
    }

    #[test]
    fn boot_fallback_reverts_corrupt_chain_tail_and_audits() {
        let _serial = bridge_guard();
        let root = repo_root();
        let data_dir = std::env::temp_dir().join(format!(
            "inkling-fallback-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&data_dir).unwrap();
        let options = BootOptions {
            repo_root: root,
            storage_uri: format!(
                "sqlite:///{}",
                data_dir.join("inkling.sqlite").display()
            ),
            data_dir: Some(data_dir.clone()),
            ..BootOptions::default()
        };
        let host = EngineHost::boot(options.clone()).expect("首次装配失败");
        host.stop().expect("关停失败");
        drop(host);
        // 引擎停机后注入坏链（持有连接期间直写会被库锁阻塞）
        corrupt_chain_record(&data_dir);

        // 二次装配：链引导回退应自动逐尾回退 → 装配成功、链回基线
        let second = EngineHost::boot(options).expect("引导回退后装配应成功");
        let report = second.report().expect("摘要失败");
        assert!(!report.tool_names.is_empty(), "回退后工具清单为空");
        assert_eq!(chain_version_now(), 1, "坏补丁应被引导回退移除");
        // 回退动作落审计（append-only）：集审计集合含 kind=revert 记录
        let audit = block_on_op(
            "engine.records_list",
            serde_json::json!({ "collection": "set_audit" }),
        )
        .expect("审计记录读取失败");
        assert!(
            audit
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r.get("kind").and_then(|v| v.as_str()) == Some("revert")),
            "引导回退应落审计记录"
        );
        second.stop().expect("关停失败");
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn safe_mode_boot_leaves_chain_intact() {
        let _serial = bridge_guard();
        let root = repo_root();
        let data_dir = std::env::temp_dir().join(format!(
            "inkling-safemode-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&data_dir).unwrap();
        let options = BootOptions {
            repo_root: root.clone(),
            storage_uri: format!(
                "sqlite:///{}",
                data_dir.join("inkling.sqlite").display()
            ),
            data_dir: Some(data_dir.clone()),
            ..BootOptions::default()
        };
        let host = EngineHost::boot(options.clone()).expect("首次装配失败");
        host.stop().expect("关停失败");
        drop(host);
        // 引擎停机后注入坏链（持有连接期间直写会被库锁阻塞）
        corrupt_chain_record(&data_dir);

        // 安全模式装配：链内容（自写资产载体）不参与启动、原样保留
        let safe = EngineHost::boot(BootOptions {
            safe_mode: true,
            ..options
        })
        .expect("安全模式装配应成功（出厂基线启动）");
        let report = safe.report().expect("摘要失败");
        assert!(!report.tool_names.is_empty(), "安全模式工具清单为空");
        assert_eq!(
            chain_version_now(),
            2,
            "安全模式不触碰链内容（坏补丁原样保留）"
        );
        safe.stop().expect("关停失败");
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// 仓库内向量模型目录（出厂接通测试的真实模型位）。
    fn repo_model_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../inkling/models/granite-97m")
    }

    /// 本地语义嵌入器注入装配：检索源清单应含 embedding（出厂接通）；
    /// 无注入装配回落关键词基线（离线测试形态）。
    #[test]
    fn boot_injects_local_embedder_into_retrieval_sources() {
        let _serial = bridge_guard();
        let root = repo_root();
        let model_dir = repo_model_dir();
        let options = BootOptions {
            repo_root: root.clone(),
            embedder_model_dir: Some(model_dir),
            ..BootOptions::default()
        };
        let host = EngineHost::boot(options).expect("装配失败");

        let sources = call_engine_op(
            "engine.retrieval_source_names",
            serde_json::json!({}),
        )
        .expect("检索源清单读取失败");
        let names: Vec<String> = sources
            .get("sources")
            .and_then(serde_json::Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            names.contains(&"embedding".to_string()),
            "出厂接通：注入本地嵌入器后检索源应含 embedding（实际 {names:?}）"
        );
        assert!(names.contains(&"knowledge_set".to_string()));

        // 回合正常（检索源携带真实语义嵌入不影响 stub 回合闭环）
        let outcome = host
            .round(RoundRequest {
                input_text: "研究墨引擎机制".to_string(),
                thread_id: "embed-t1".to_string(),
                round_id: "embed-r1".to_string(),
                step_args: None,
                inject: None,
                auto_accept_review: true,
            })
            .expect("回合失败");
        assert_eq!(outcome.reason, "reply", "回合未完成到回复");

        host.stop().expect("关停失败");
    }

    /// 无注入装配 = 关键词基线（embedding 源不出现，离线测试零模型依赖）。
    #[test]
    fn boot_without_embedder_stays_keyword_baseline() {
        let _serial = bridge_guard();
        let root = repo_root();
        let options = BootOptions {
            repo_root: root.clone(),
            ..BootOptions::default()
        };
        let host = EngineHost::boot(options).expect("装配失败");
        let sources = call_engine_op(
            "engine.retrieval_source_names",
            serde_json::json!({}),
        )
        .expect("检索源清单读取失败");
        let names: Vec<String> = sources
            .get("sources")
            .and_then(serde_json::Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            !names.contains(&"embedding".to_string()),
            "未注入 = 关键词基线（实际 {names:?}）"
        );
        host.stop().expect("关停失败");
    }

    /// 本地嵌入器真实推理（granite-97m ONNX）：384 维向量 + 计划来源
    /// LocalOnnx（真实模型位存在）；模型缺失机器回落确定性保底可观测。
    #[test]
    fn local_onnx_bridge_embeds_with_real_model() {
        let _serial = bridge_guard();
        let model_dir = repo_model_dir();
        let embedder = crate::engine::bridge::LocalOnnx::with_model_dir(model_dir.clone());
        Python::attach(|py| {
            let obj = Py::new(py, embedder).expect("嵌入器对象创建失败");
            // 计划解析（懒加载触发）：模型在位 → 本地真实推理
            let source: String = obj
                .bind(py)
                .call_method0(pyo3::intern!(py, "source"))
                .expect("来源读取失败")
                .extract()
                .expect("来源类型不符");
            assert_eq!(source, "LocalOnnx", "模型在位应走本地真实推理");

            // 异步推理（跨语言 awaitable 双向桥，与回合驱动同形态）
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio 运行时创建失败");
            let handle = obj.clone_ref(py);
            let vector: Vec<f64> = runtime
                .block_on(async {
                    pyo3_async_runtimes::tokio::run(py, async move {
                        let fut = Python::attach(|py| -> PyResult<_> {
                            let bound = handle.bind(py);
                            let coro = bound
                                .call_method1("aembed_query", ("墨引擎检索测试",))?;
                            pyo3_async_runtimes::tokio::into_future(coro)
                        })?;
                        let value = fut.await?;
                        Python::attach(|py| value.bind(py).extract::<Vec<f64>>())
                    })
                })
                .expect("嵌入推理失败");
            assert_eq!(vector.len(), 384, "granite-97m 输出维度");
            let norm: f64 = vector.iter().map(|v| v * v).sum::<f64>().sqrt();
            assert!((norm - 1.0).abs() < 1e-3, "L2 归一向量");

            // 文档批量 + 关闭（协议方法全回路）
            let handle = obj.clone_ref(py);
            let docs: Vec<Vec<f64>> = runtime
                .block_on(async {
                    pyo3_async_runtimes::tokio::run(py, async move {
                        let fut = Python::attach(|py| -> PyResult<_> {
                            let bound = handle.bind(py);
                            let coro = bound.call_method1(
                                "aembed_documents",
                                (vec!["条目一".to_string(), "条目二".to_string()],),
                            )?;
                            pyo3_async_runtimes::tokio::into_future(coro)
                        })?;
                        let value = fut.await?;
                        Python::attach(|py| value.bind(py).extract::<Vec<Vec<f64>>>())
                    })
                })
                .expect("批量嵌入失败");
            assert_eq!(docs.len(), 2, "批量顺序与输入一致");
            assert_eq!(docs[0].len(), 384);
            let handle = obj.clone_ref(py);
            runtime.block_on(async {
                pyo3_async_runtimes::tokio::run(py, async move {
                    let fut = Python::attach(|py| -> PyResult<_> {
                        let bound = handle.bind(py);
                        let coro = bound.call_method0("aclose")?;
                        pyo3_async_runtimes::tokio::into_future(coro)
                    })?;
                    fut.await?;
                    Ok(())
                })
            })
            .expect("关闭失败");
        });
    }

    /// 提示词生效断言：宿主 LLM 调用消息流含行为准则层
    /// （boot_prompt 引导语 + 打标分类准则）——行为块经协议代理作为
    /// 系统消息前置（路由轻调用为代表路径；覆盖评审/蒸馏/路由全调用
    /// 点），经离线模型桩的消息流可观测出口核对。
    #[test]
    fn stub_llm_messages_contain_behavior_guidance() {
        let _serial = bridge_guard();
        let root = repo_root();
        let options = BootOptions {
            repo_root: root.clone(),
            stub_script: Some(serde_json::json!({
                "研究": {"reply": "研究计划已展开：采集 → 解析 → 评审。"}
            })),
            ..BootOptions::default()
        };
        let host = EngineHost::boot(options).expect("装配失败");

        // 路由轻调用（策略层代表性 LLM 路径；离线桩回落主挡）
        let router = block_on_op(
            "engine.router_light_complete",
            serde_json::json!({
                "messages": [
                    {"role": "system", "content": "标题生成：一句话 ≤12 字"},
                    {"role": "user", "content": "研究墨引擎机制"},
                ]
            }),
        )
        .expect("路由轻调用失败");
        assert!(router.get("content").and_then(serde_json::Value::as_str).is_some());

        // 模型桩最近一次调用：系统消息应含行为准则层（引导语 + 打标准则）
        let recorded = call_engine_op(
            "engine.stub_llm_last_messages",
            serde_json::json!({}),
        )
        .expect("模型桩消息流读取失败");
        let messages = recorded
            .get("messages")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(!messages.is_empty(), "模型桩应有调用记录");
        let system_texts: Vec<String> = messages
            .iter()
            .filter(|m| m.get("role").and_then(serde_json::Value::as_str) == Some("system"))
            .filter_map(|m| m.get("content").and_then(serde_json::Value::as_str))
            .map(|s| s.to_string())
            .collect();
        assert!(
            !system_texts.is_empty(),
            "行为准则层应作为系统消息注入（实际角色: {:?}）",
            messages.iter().map(|m| m.get("role").cloned()).collect::<Vec<_>>()
        );
        let joined = system_texts.join("\n");
        assert!(
            joined.contains("【身份与立场】") && joined.contains("【行为准则】"),
            "系统消息应含 boot_prompt 引导语三段结构"
        );
        assert!(
            joined.contains("打标分类准则") || joined.contains("spawn"),
            "系统消息应含打标分类准则"
        );
        assert!(
            joined.contains("推理过程中"),
            "系统消息应含交错推理引导语"
        );

        host.stop().expect("关停失败");
    }
}
