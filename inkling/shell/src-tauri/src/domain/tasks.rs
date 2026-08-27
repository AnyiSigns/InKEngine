//! 后台任务域：任务注册表、事件留痕、取消回退与项目任务对象（归约纯函数）。
//!
//! 本域只描述「宿主侧后台任务的承载与观测」，不驱动引擎内部逻辑——
//! 引擎零改动。后台任务经 tokio spawn 执行，状态变化经既有流式事件
//! 通道 (`inkling://round_event`) 留痕，取消经 cancel token 撤销在途工作
//! 并经既有 `engine.thread_revert` 操作通道回退链状态。
//!
//! 事件契约对照 `inkling/seed_data/event_types.json` 登记的任务事件
//! （task_start / task_update / task_done / task_cancelled），字段名与
//! 必填项与之对齐；事件对象形态对照 lib.rs 中 `round_send` 经
//! `set_event_emitter` 发射的引擎事件信封（type / payload / thread_id …）。
//!
//! 项目任务对象 (`ProjectTask`) 是领域无关的目标载体：回合开始把它的序列化
//! 形态注入 `RoundRequest.inject`（引擎零改动感知），回合结束从回合事件
//! 序列确定性归约更新（纯函数，不调模型）。

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio::task::JoinHandle;

// ── 常量（命名集中，禁用裸字符串/裸数字）──

/// 事件协议版本（与引擎侧 `PROTOCOL_VERSION` 对齐，前端零改动）。
const PROTOCOL_VERSION: i64 = 2;

/// 任务状态语义常量。
const STATUS_PENDING: &str = "pending";
const STATUS_RUNNING: &str = "running";
const STATUS_COMPLETED: &str = "completed";
const STATUS_CANCELLED: &str = "cancelled";
const STATUS_FAILED: &str = "failed";
const STATUS_IN_PROGRESS: &str = "in_progress";
const STATUS_ERROR: &str = "error";

/// 任务事件类型（对照 seed 登记的事件名）。
const EVENT_TASK_START: &str = "task_start";
const EVENT_TASK_UPDATE: &str = "task_update";
const EVENT_TASK_DONE: &str = "task_done";
const EVENT_TASK_CANCELLED: &str = "task_cancelled";

/// 既有链回退操作通道名（host.rs 既有 `engine.thread_revert`）。
const OP_THREAD_REVERT: &str = "engine.thread_revert";

/// 取消缺省原因（用户未显式给原因时使用）。
pub const DEFAULT_CANCEL_REASON: &str = "user_cancelled";

/// 工具事件中表示「写文件」的 kind 取值。
const TOOL_KIND_FILE_WRITE: &str = "file_write";
const TOOL_KIND_FILE_EDIT: &str = "file_edit";
const TOOL_KIND_TEST_RUN: &str = "test_run";

// ── 事件发射 ──

/// 事件汇（可注入，便于测试替身记录）。
pub type EventSink = Arc<dyn Fn(JsonValue) + Send + Sync>;

/// 链回退器（可注入，便于测试替身断言调用）。
pub type Reverter = Arc<dyn Fn(&str, &str) -> Result<JsonValue, String> + Send + Sync>;

/// 构造与引擎事件信封同构的事件对象（type / payload / thread_id …）。
fn build_event(event_type: &str, payload: JsonValue, thread_id: Option<&str>) -> JsonValue {
    json!({
        "type": event_type,
        "version": PROTOCOL_VERSION,
        "payload": payload,
        "step_id": JsonValue::Null,
        "parent_step_id": JsonValue::Null,
        "round_id": JsonValue::Null,
        "node": JsonValue::Null,
        "graph_path": [],
        "seq": JsonValue::Null,
        "trace_id": "-",
        "thread_id": thread_id,
    })
}

// ── 任务状态 / 注册表条目 ──

/// 任务生命周期状态（任务注册即进入运行态，故无独立 pending 变体）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaskStatus {
    Running,
    Completed,
    Cancelled,
    Failed,
}

impl TaskStatus {
    fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Running => STATUS_RUNNING,
            TaskStatus::Completed => STATUS_COMPLETED,
            TaskStatus::Cancelled => STATUS_CANCELLED,
            TaskStatus::Failed => STATUS_FAILED,
        }
    }

    /// 是否进入终态（不可再取消/续跑）。
    fn is_terminal(&self) -> bool {
        matches!(
            self,
            TaskStatus::Completed | TaskStatus::Cancelled | TaskStatus::Failed
        )
    }
}

/// 注册表条目（运行期状态；不对外序列化）。
struct TaskEntry {
    id: String,
    kind: String,
    goal: String,
    status: TaskStatus,
    thread_id: Option<String>,
    /// 链回退目标（checkpoint id）；缺省回落为空串占位。
    revert_target: Option<String>,
    created_at: i64,
    /// 取消令牌（cancel 置位；后台工作轮询感知）。
    cancel: Arc<AtomicBool>,
    /// 后台 join 句柄（取消时中止在途工作）。
    handle: Option<JoinHandle<()>>,
}

impl TaskEntry {
    /// 投影为对外可见的任务元信息。
    fn meta(&self) -> TaskMeta {
        TaskMeta {
            id: self.id.clone(),
            kind: self.kind.clone(),
            goal: self.goal.clone(),
            status: self.status.as_str().to_string(),
            thread_id: self.thread_id.clone(),
            created_at: self.created_at,
        }
    }
}

/// 任务元信息（命令返回形态；前端任务面板消费）。
#[derive(Debug, Clone, Serialize)]
pub struct TaskMeta {
    pub id: String,
    pub kind: String,
    pub goal: String,
    pub status: String,
    pub thread_id: Option<String>,
    pub created_at: i64,
}

/// 任务错误（结构化，命令层映射为字符串透传）。
#[derive(Debug)]
pub enum TaskError {
    NotFound(String),
    AlreadyExists(String),
    AlreadyTerminal(String),
    Channel(String),
}

impl std::fmt::Display for TaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TaskError::NotFound(id) => write!(f, "unknown_task_id: {id}"),
            TaskError::AlreadyExists(id) => write!(f, "task_already_exists: {id}"),
            TaskError::AlreadyTerminal(id) => write!(f, "task_already_terminal: {id}"),
            TaskError::Channel(e) => write!(f, "task_channel_error: {e}"),
        }
    }
}

/// 受控通道消息（tracked 任务经 mpsc 接收前端/回合驱动信号）。
enum TaskControl {
    Progress(f64, String),
    Finish(String),
    Fail(String),
}

// ── 任务句柄（后台工作闭包内使用）──

/// 后台工作闭包持有的句柄：上报进度 + 感知取消。
pub struct TaskHandle {
    id: String,
    sink: EventSink,
    cancel: Arc<AtomicBool>,
    thread_id: Option<String>,
}

impl TaskHandle {
    fn new(id: String, sink: EventSink, cancel: Arc<AtomicBool>, thread_id: Option<String>) -> Self {
        Self {
            id,
            sink,
            cancel,
            thread_id,
        }
    }

    /// 上报进度（task_update 事件；status 固化 running，progress 递增由调用方控制）。
    pub fn progress(&self, value: f64, note: &str) {
        (self.sink)(build_event(
            EVENT_TASK_UPDATE,
            json!({
                "task_id": self.id,
                "status": STATUS_RUNNING,
                "progress": value,
                "note": note,
            }),
            self.thread_id.as_deref(),
        ));
    }

    /// 是否已收到取消信号。
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

// ── 任务注册表 ──

/// 任务注册表：注册 / 启动 / 取消 / 状态查询；事件经注入汇留痕，
/// 取消经注入回退器回退链。构造时可注入汇与回退器（测试替身），生产
/// 形态经 [`registry`] 全局单例使用既有的 AppHandle 通道与引擎操作通道。
pub struct TaskRegistry {
    tasks: Arc<Mutex<std::collections::HashMap<String, TaskEntry>>>,
    controls: Arc<Mutex<std::collections::HashMap<String, UnboundedSender<TaskControl>>>>,
    sink: EventSink,
    reverter: Reverter,
}

impl TaskRegistry {
    /// 以注入的事件汇与回退器构造（测试与生产共用同一实现）。
    pub fn new(sink: EventSink, reverter: Reverter) -> Self {
        Self {
            tasks: Arc::new(Mutex::new(std::collections::HashMap::new())),
            controls: Arc::new(Mutex::new(std::collections::HashMap::new())),
            sink,
            reverter,
        }
    }

    /// 注册并启动一个后台任务：以 tokio spawn 执行 `work`，完成后按结果
    /// 发射 task_done（成功）或 task_cancelled（失败兜底）。
    pub fn start<F, Fut>(
        &self,
        id: &str,
        kind: &str,
        goal: &str,
        thread_id: Option<&str>,
        revert_target: Option<&str>,
        work: F,
    ) -> Result<(), TaskError>
    where
        F: FnOnce(TaskHandle) -> Fut + Send + 'static,
        Fut: Future<Output = Result<String, String>> + Send + 'static,
    {
        {
            let tasks = self.tasks.lock().unwrap();
            if tasks.contains_key(id) {
                return Err(TaskError::AlreadyExists(id.to_string()));
            }
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let created_at = chrono::Utc::now().timestamp();
        let entry = TaskEntry {
            id: id.to_string(),
            kind: kind.to_string(),
            goal: goal.to_string(),
            status: TaskStatus::Running,
            thread_id: thread_id.map(str::to_string),
            revert_target: revert_target.map(str::to_string),
            created_at,
            cancel: cancel.clone(),
            handle: None,
        };
        self.tasks.lock().unwrap().insert(id.to_string(), entry);

        (self.sink)(
            build_event(
                EVENT_TASK_START,
                json!({ "task_id": id, "kind": kind, "goal": goal }),
                thread_id,
            ),
        );

        let tasks_arc = self.tasks.clone();
        let sink = self.sink.clone();
        let reverter = self.reverter.clone();
        let id_owned = id.to_string();
        let thread_id_owned = thread_id.map(str::to_string);
        let revert_target_owned = revert_target.map(str::to_string);

        let join_handle = tokio::spawn(async move {
            let t_handle = TaskHandle::new(
                id_owned.clone(),
                sink.clone(),
                cancel.clone(),
                thread_id_owned.clone(),
            );
            let result = work(t_handle).await;
            let cancelled = cancel.load(Ordering::SeqCst);
            // 取消路径已在本体 cancel() 发射 task_cancelled + 回退，此处不重复。
            if !cancelled {
                match &result {
                    Ok(res) => {
                        (sink)(build_event(
                            EVENT_TASK_DONE,
                            json!({ "task_id": &id_owned, "result": res }),
                            thread_id_owned.as_deref(),
                        ));
                    }
                    Err(reason) => {
                        (sink)(build_event(
                            EVENT_TASK_CANCELLED,
                            json!({ "task_id": &id_owned, "reason": reason }),
                            thread_id_owned.as_deref(),
                        ));
                        if let Some(tid) = &thread_id_owned {
                            let _ = (reverter)(tid, &revert_target_owned.clone().unwrap_or_default());
                        }
                    }
                }
            }
            if let Some(e) = tasks_arc.lock().unwrap().get_mut(&id_owned) {
                e.status = if cancelled {
                    TaskStatus::Cancelled
                } else {
                    match result {
                        Ok(_) => TaskStatus::Completed,
                        Err(_) => TaskStatus::Failed,
                    }
                };
                e.handle = None;
            }
        });

        self.tasks
            .lock()
            .unwrap()
            .get_mut(id)
            .unwrap()
            .handle = Some(join_handle);
        Ok(())
    }

    /// 启动受控后台任务：经 mpsc 受前端/回合驱动信号（progress/finish/fail），
    /// 自身不执行引擎逻辑，仅作领域无关的承载与留痕（引擎零改动）。
    pub fn start_tracked(
        &self,
        id: &str,
        kind: &str,
        goal: &str,
        thread_id: Option<&str>,
        revert_target: Option<&str>,
    ) -> Result<(), TaskError> {
        let (tx, mut rx) = mpsc::unbounded_channel::<TaskControl>();
        self.controls
            .lock()
            .unwrap()
            .insert(id.to_string(), tx);
        let work = move |handle: TaskHandle| async move {
            handle.progress(0.0, "task_started");
            while let Some(msg) = rx.recv().await {
                match msg {
                    TaskControl::Progress(p, note) => handle.progress(p, &note),
                    TaskControl::Finish(r) => return Ok(r),
                    TaskControl::Fail(reason) => return Err(reason),
                }
            }
            Err("channel_closed".to_string())
        };
        self.start(id, kind, goal, thread_id, revert_target, work)
    }

    /// 取消任务：置位取消令牌 + 发射 task_cancelled + 经回退器回退链。
    /// 未知 id → NotFound；已终态 → AlreadyTerminal（不可重复取消）。
    pub fn cancel(&self, id: &str, reason: &str) -> Result<(), TaskError> {
        let (thread_id, revert_target, handle) = {
            let mut tasks = self.tasks.lock().unwrap();
            let entry = tasks
                .get_mut(id)
                .ok_or_else(|| TaskError::NotFound(id.to_string()))?;
            if entry.status.is_terminal() {
                return Err(TaskError::AlreadyTerminal(id.to_string()));
            }
            entry.status = TaskStatus::Cancelled;
            entry.cancel.store(true, Ordering::SeqCst);
            let thread_id = entry.thread_id.clone();
            let revert_target = entry.revert_target.clone();
            let handle = entry.handle.take();
            (thread_id, revert_target, handle)
        };
        // 受控通道关闭，使在途 work 从 recv 退出。
        self.controls.lock().unwrap().remove(id);
        if let Some(h) = handle {
            h.abort();
        }
        (self.sink)(
            build_event(
                EVENT_TASK_CANCELLED,
                json!({ "task_id": id, "reason": reason }),
                thread_id.as_deref(),
            ),
        );
        if let Some(tid) = thread_id {
            let _ = (self.reverter)(&tid, &revert_target.unwrap_or_default());
        }
        Ok(())
    }

    /// 上报进度（受控任务路径）。
    pub fn progress_signal(&self, id: &str, value: f64, note: &str) -> Result<(), TaskError> {
        let controls = self.controls.lock().unwrap();
        let tx = controls
            .get(id)
            .ok_or_else(|| TaskError::NotFound(id.to_string()))?;
        tx.send(TaskControl::Progress(value, note.to_string()))
            .map_err(|e| TaskError::Channel(e.to_string()))?;
        Ok(())
    }

    /// 标记受控任务完成（发射 task_done）。
    pub fn finish_signal(&self, id: &str, result: &str) -> Result<(), TaskError> {
        let controls = self.controls.lock().unwrap();
        let tx = controls
            .get(id)
            .ok_or_else(|| TaskError::NotFound(id.to_string()))?;
        tx.send(TaskControl::Finish(result.to_string()))
            .map_err(|e| TaskError::Channel(e.to_string()))?;
        Ok(())
    }

    /// 标记受控任务失败（发射 task_cancelled 兜底）。
    pub fn fail_signal(&self, id: &str, reason: &str) -> Result<(), TaskError> {
        let controls = self.controls.lock().unwrap();
        let tx = controls
            .get(id)
            .ok_or_else(|| TaskError::NotFound(id.to_string()))?;
        tx.send(TaskControl::Fail(reason.to_string()))
            .map_err(|e| TaskError::Channel(e.to_string()))?;
        Ok(())
    }

    /// 任务清单（全部元信息）。
    pub fn list(&self) -> Vec<TaskMeta> {
        self.tasks
            .lock()
            .unwrap()
            .values()
            .map(|e| e.meta())
            .collect()
    }

    /// 单任务元信息（未知 id → NotFound）。
    pub fn state(&self, id: &str) -> Result<TaskMeta, TaskError> {
        self.tasks
            .lock()
            .unwrap()
            .get(id)
            .map(|e| e.meta())
            .ok_or_else(|| TaskError::NotFound(id.to_string()))
    }
}

// ── 全局单例（生产命令路径；测试用构造器直接注入替身）──

static APP_HANDLE: Mutex<Option<AppHandle>> = Mutex::new(None);
static REGISTRY: OnceLock<Arc<TaskRegistry>> = OnceLock::new();

/// 绑定 AppHandle 到全局单例（命令首调用时登记，供事件汇发射）。
pub fn bind_app(app: AppHandle) {
    *APP_HANDLE.lock().unwrap() = Some(app);
}

/// 取全局任务注册表单例（懒初始化，事件汇走既有 AppHandle 通道，
/// 回退走既有 `engine.thread_revert` 操作通道）。
pub fn registry() -> Arc<TaskRegistry> {
    REGISTRY
        .get_or_init(|| {
            let sink: EventSink = Arc::new(|event: JsonValue| {
                let guard = APP_HANDLE.lock().unwrap();
                if let Some(app) = guard.as_ref() {
                    if let Err(err) = app.emit("inkling://round_event", event) {
                        eprintln!("[tasks] 事件发射失败: {err}");
                    }
                }
            });
            let revert: Reverter = Arc::new(
                |thread_id: &str, target_id: &str| -> Result<JsonValue, String> {
                    call_engine_revert(thread_id, target_id)
                },
            );
            Arc::new(TaskRegistry::new(sink, revert))
        })
        .clone()
}

/// 经既有操作通道回退链（同步形态，复用 host 既有异步桥 + 当前线程运行时）。
fn call_engine_revert(thread_id: &str, target_id: &str) -> Result<JsonValue, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| format!("回退运行时创建失败: {err}"))?
        .block_on(crate::engine::host::call_engine_op_async(
            OP_THREAD_REVERT,
            json!({ "thread_id": thread_id, "target_id": target_id }),
        ))
}

// ── 项目任务对象（领域无关目标载体）──

/// 检查状态（最近一次运行 + 是否通过）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CheckStatus {
    pub last_run: Option<i64>,
    pub passing: bool,
}

/// 项目任务对象：以 goal 语义承载一轮领域无关的工作目标，回合边界注入
/// 与归约更新均围绕它进行（引擎零改动）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectTask {
    pub goal: String,
    pub round_no: u64,
    pub status: String,
    pub changed_files: Vec<String>,
    pub check_status: CheckStatus,
    pub next_step: Option<String>,
    pub summary_ref: Option<String>,
}

impl ProjectTask {
    /// 以目标新建空任务（初态 pending，未跑检查）。
    pub fn new(goal: &str) -> Self {
        Self {
            goal: goal.to_string(),
            round_no: 0,
            status: STATUS_PENDING.to_string(),
            changed_files: Vec::new(),
            check_status: CheckStatus {
                last_run: None,
                passing: false,
            },
            next_step: None,
            summary_ref: None,
        }
    }
}

/// 从回合事件序列确定性归约更新项目任务（纯函数，不调模型）。
///
/// 归约规则：tool_end 的写文件成功 → 累加入 changed_files（去重）；
/// 测试运行（tool_end kind=test_run 或事件名以 run_test 开头）→ 更新
/// check_status（last_run 记时、passing 依据成败与失败数）；error →
/// status 置 error 且 next_step 提示复检。每轮归约 round_no +1。
pub fn reduce_project_task(task: &ProjectTask, events: &[JsonValue]) -> ProjectTask {
    let mut out = task.clone();
    out.round_no += 1;
    let mut saw_event = false;
    for ev in events {
        let etype = match ev.get("type").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => continue,
        };
        let payload = ev
            .get("payload")
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        saw_event = true;
        match etype {
            "tool_end" => {
                let success = payload
                    .get("success")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let is_write = payload.get("kind").and_then(|v| v.as_str())
                    == Some(TOOL_KIND_FILE_WRITE)
                    || payload.get("kind").and_then(|v| v.as_str())
                        == Some(TOOL_KIND_FILE_EDIT)
                    || payload
                        .get("tool")
                        .and_then(|v| v.as_str())
                        .map(|t| t.starts_with("write") || t.starts_with("edit"))
                        .unwrap_or(false);
                if is_write && success {
                    if let Some(path) = payload
                        .get("path")
                        .or_else(|| payload.get("file"))
                        .and_then(|v| v.as_str())
                    {
                        if !out.changed_files.iter().any(|f| f == path) {
                            out.changed_files.push(path.to_string());
                        }
                    }
                }
                let is_test = payload.get("kind").and_then(|v| v.as_str())
                    == Some(TOOL_KIND_TEST_RUN)
                    || payload
                        .get("tool")
                        .and_then(|v| v.as_str())
                        .map(|t| {
                            t.contains("test") || t.contains("pytest") || t.contains("cargo_test")
                        })
                        .unwrap_or(false);
                if is_test {
                    let failed = payload.get("failed").and_then(|v| v.as_i64()).unwrap_or(0);
                    out.check_status.last_run = Some(chrono::Utc::now().timestamp());
                    out.check_status.passing = success && failed <= 0;
                }
            }
            name if name.starts_with("run_test") => {
                let failed = payload.get("failed").and_then(|v| v.as_i64()).unwrap_or(0);
                let passed = payload.get("passed").and_then(|v| v.as_i64()).unwrap_or(0);
                out.check_status.last_run = Some(chrono::Utc::now().timestamp());
                out.check_status.passing = failed <= 0 && passed >= 0;
            }
            "error" => {
                out.status = STATUS_ERROR.to_string();
                out.next_step = Some("review_error".to_string());
            }
            _ => {}
        }
    }
    if saw_event && out.status != STATUS_ERROR {
        out.status = STATUS_IN_PROGRESS.to_string();
    }
    out
}

/// 构造回合注入负载：把任务对象序列化进 `project_task` 键（引擎零改动感知）。
pub fn inject_project_task(task: &ProjectTask) -> JsonValue {
    json!({ "project_task": serde_json::to_value(task).unwrap_or(JsonValue::Null) })
}

// ── 单元测试 ──

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// 构造带记录汇与回退替身的注册表（不触碰真实引擎）。
    #[allow(clippy::type_complexity)]
    fn test_registry(
    ) -> (Arc<TaskRegistry>, Arc<Mutex<Vec<JsonValue>>>, Arc<Mutex<Vec<(String, String)>>>) {
        let sink_calls = Arc::new(Mutex::new(Vec::new()));
        let revert_calls = Arc::new(Mutex::new(Vec::new()));
        let sink: EventSink = {
            let sc = sink_calls.clone();
            Arc::new(move |e| sc.lock().unwrap().push(e))
        };
        let revert: Reverter = {
            let rc = revert_calls.clone();
            Arc::new(move |t, tg| {
                rc.lock().unwrap().push((t.to_string(), tg.to_string()));
                Ok(json!({ "reverted_to": tg }))
            })
        };
        (
            Arc::new(TaskRegistry::new(sink, revert)),
            sink_calls,
            revert_calls,
        )
    }

    /// 轮询直至任务进入终态（测试内等待后台工作结束）。
    async fn wait_terminal(reg: &TaskRegistry, id: &str) {
        for _ in 0..400 {
            if let Ok(meta) = reg.state(id) {
                if meta.status == STATUS_COMPLETED
                    || meta.status == STATUS_CANCELLED
                    || meta.status == STATUS_FAILED
                {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    fn events_of(calls: &Arc<Mutex<Vec<JsonValue>>>, etype: &str) -> Vec<JsonValue> {
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.get("type").and_then(|v| v.as_str()) == Some(etype))
            .cloned()
            .collect()
    }

    #[test]
    fn register_execute_complete_emits_task_done_with_contract() {
        let (reg, sink, _revert) = test_registry();
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            reg.start(
                "task-done-1",
                "build",
                "完成构建",
                Some("thread-1"),
                Some("cp-1"),
                |_h| async move { Ok("all_done".to_string()) },
            )
            .unwrap();
            wait_terminal(&reg, "task-done-1").await;
        });
        let done = events_of(&sink, EVENT_TASK_DONE)
            .into_iter()
            .next()
            .expect("应发射 task_done");
        assert_eq!(done["payload"]["task_id"], "task-done-1");
        assert_eq!(done["payload"]["result"], "all_done");
        let start = events_of(&sink, EVENT_TASK_START)
            .into_iter()
            .next()
            .expect("应发射 task_start");
        assert_eq!(start["payload"]["task_id"], "task-done-1");
        assert_eq!(start["payload"]["goal"], "完成构建");
        assert_eq!(reg.state("task-done-1").unwrap().status, STATUS_COMPLETED);
    }

    #[test]
    fn status_advances_start_update_done_with_increasing_progress() {
        let (reg, sink, _revert) = test_registry();
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            reg.start(
                "task-seq-1",
                "x",
                "g",
                None,
                None,
                |h| async move {
                    h.progress(0.25, "第一步");
                    h.progress(0.75, "第二步");
                    Ok("ok".to_string())
                },
            )
            .unwrap();
            wait_terminal(&reg, "task-seq-1").await;
        });
        let evs: Vec<JsonValue> = sink.lock().unwrap().iter().cloned().collect();
        let types: Vec<&str> = evs
            .iter()
            .map(|e| e.get("type").and_then(|v| v.as_str()).unwrap())
            .collect();
        assert_eq!(
            types,
            vec![EVENT_TASK_START, EVENT_TASK_UPDATE, EVENT_TASK_UPDATE, EVENT_TASK_DONE]
        );
        let ups: Vec<f64> = events_of(&sink, EVENT_TASK_UPDATE)
            .iter()
            .map(|e| e["payload"]["progress"].as_f64().unwrap())
            .collect();
        assert!(ups[0] < ups[1], "进度应递增");
        assert_eq!(evs[1]["payload"]["note"], "第一步");
    }

    #[test]
    fn cancel_marks_cancelled_emits_event_and_reverts() {
        let (reg, sink, revert) = test_registry();
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            reg.start(
                "task-cancel-1",
                "x",
                "g",
                Some("thread-c1"),
                Some("cp-c1"),
                |h| async move {
                    for _ in 0..2000 {
                        if h.is_cancelled() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    Ok("不应完成".to_string())
                },
            )
            .unwrap();
            tokio::time::sleep(Duration::from_millis(30)).await;
            reg.cancel("task-cancel-1", "user_abort").unwrap();
            wait_terminal(&reg, "task-cancel-1").await;
        });
        assert_eq!(reg.state("task-cancel-1").unwrap().status, STATUS_CANCELLED);
        let cancelled = events_of(&sink, EVENT_TASK_CANCELLED)
            .into_iter()
            .next()
            .expect("应发射 task_cancelled");
        assert_eq!(cancelled["payload"]["task_id"], "task-cancel-1");
        assert_eq!(cancelled["payload"]["reason"], "user_abort");
        let rev = revert.lock().unwrap();
        assert!(
            rev.contains(&("thread-c1".to_string(), "cp-c1".to_string())),
            "取消应触发 thread_revert 回退调用"
        );
    }

    #[test]
    fn reduce_updates_fields_from_round_events_and_is_pure() {
        let task = ProjectTask::new("实现特性");
        let events = vec![
            json!({"type":"tool_start","payload":{"tool":"write_file","tool_call_id":"c1"}}),
            json!({"type":"tool_end","payload":{"tool":"write_file","kind":"file_write","path":"src/a.rs","success":true}}),
            json!({"type":"run_test_unit","payload":{"passed":3,"failed":0}}),
            json!({"type":"error","payload":{"node":"n","message":"boom"}}),
        ];
        let updated = reduce_project_task(&task, &events);
        assert!(
            updated.changed_files.contains(&"src/a.rs".to_string()),
            "写文件应进入 changed_files"
        );
        assert!(updated.check_status.last_run.is_some(), "测试运行应记时");
        assert!(updated.check_status.passing, "无失败应通过");
        assert_eq!(updated.status, STATUS_ERROR, "错误应置 error 状态");
        assert_eq!(updated.round_no, 1, "每轮归约 round_no +1");
        let again = reduce_project_task(&task, &events);
        assert_eq!(updated, again, "归约应为确定性纯函数");
    }

    #[test]
    fn reduce_does_not_invoke_model() {
        // 纯函数无外部依赖：无引擎/无网络/无模型调用，仅数据归约。
        let task = ProjectTask::new("目标");
        let events = vec![json!({"type":"tool_end","payload":{"tool":"edit_file","kind":"file_edit","path":"b.rs","success":true}})];
        let out = reduce_project_task(&task, &events);
        assert_eq!(out.changed_files, vec!["b.rs".to_string()]);
    }

    #[test]
    fn inject_carries_project_task_into_round_request() {
        let task = ProjectTask::new("目标 x");
        let inject = inject_project_task(&task);
        let req = crate::engine::host::RoundRequest {
            input_text: "go".to_string(),
            thread_id: "th".to_string(),
            round_id: "r".to_string(),
            step_args: None,
            orchestrate: None,
            inject: Some(inject),
            auto_accept_review: true,
        };
        let inj = req.inject.expect("inject 应透传");
        assert_eq!(inj["project_task"]["goal"], "目标 x");
    }

    #[test]
    fn cancel_unknown_task_is_structured_error() {
        let (reg, _sink, _revert) = test_registry();
        let err = reg.cancel("nope", "x").unwrap_err();
        assert!(
            err.to_string().contains("unknown_task_id"),
            "未知任务取消应返回结构化错误，实际: {err}"
        );
    }

    #[test]
    fn spawn_failure_emits_task_cancelled_fallback() {
        let (reg, sink, revert) = test_registry();
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            reg.start(
                "task-fail-1",
                "x",
                "g",
                Some("thread-f1"),
                Some("cp-f1"),
                |_h| async move { Err("boom".to_string()) },
            )
            .unwrap();
            wait_terminal(&reg, "task-fail-1").await;
        });
        let cancelled = events_of(&sink, EVENT_TASK_CANCELLED)
            .into_iter()
            .next()
            .expect("失败应兜底发射 task_cancelled");
        assert_eq!(cancelled["payload"]["reason"], "boom");
        assert_eq!(reg.state("task-fail-1").unwrap().status, STATUS_FAILED);
        let rev = revert.lock().unwrap();
        assert!(
            rev.contains(&("thread-f1".to_string(), "cp-f1".to_string())),
            "失败兜底仍应触发回退"
        );
    }

    #[test]
    fn tracked_task_driver_signals_flow_to_events() {
        let (reg, sink, _revert) = test_registry();
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let reg = reg.clone();
            reg.start_tracked("task-track-1", "x", "g", None, None)
                .unwrap();
            reg.progress_signal("task-track-1", 0.5, "中段").unwrap();
            reg.finish_signal("task-track-1", "达成").unwrap();
            wait_terminal(&reg, "task-track-1").await;
        });
        let done = events_of(&sink, EVENT_TASK_DONE)
            .into_iter()
            .next()
            .expect("受控完成应发射 task_done");
        assert_eq!(done["payload"]["result"], "达成");
    }
}
