//! 项目任务对象（领域无关的目标载体）与回合归约。
//!
//! 后台任务承载（任务注册表 / task_* 事件 / 取消回退 / schedule 例行回合）
//! 已废弃：定时统一走前台 `sleep` 工具（停止会话即打断），不再有后台
//! 驻留任务域。本项目任务对象独立保留——回合边界注入（RoundRequest.inject
//! 的 `project_task` 键）与回合事件确定性归约，引擎零改动感知。
//!
//! 事件契约对照 `inkling/seed_data/event_types.json` 登记的任务事件。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};

// ── 项目任务状态 ──

/// 任务生命周期状态（单一词表真源：注册表条目、回合归约、事件载荷、
/// 前端契约共用；当前仅项目任务对象消费）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Running,
    Completed,
    Cancelled,
    Failed,
    InProgress,
    Error,
}

impl TaskStatus {
    /// 对外字面形态（事件载荷 / 命令返回的统一字符串词表）。
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Pending => "pending",
            TaskStatus::Running => "running",
            TaskStatus::Completed => "completed",
            TaskStatus::Cancelled => "cancelled",
            TaskStatus::Failed => "failed",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Error => "error",
        }
    }
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
    pub status: TaskStatus,
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
            status: TaskStatus::Pending,
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

/// 工具事件中表示「写文件」的 kind 取值。
const TOOL_KIND_FILE_WRITE: &str = "file_write";
const TOOL_KIND_FILE_EDIT: &str = "file_edit";
const TOOL_KIND_TEST_RUN: &str = "test_run";

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
                out.status = TaskStatus::Error;
                out.next_step = Some("review_error".to_string());
            }
            _ => {}
        }
    }
    if saw_event && out.status != TaskStatus::Error {
        out.status = TaskStatus::InProgress;
    }
    out
}

/// 构造回合注入负载：把任务对象序列化进 `project_task` 键（引擎零改动感知）。
pub fn inject_project_task(task: &ProjectTask) -> JsonValue {
    json!({ "project_task": serde_json::to_value(task).unwrap_or(JsonValue::Null) })
}

// ── 项目任务落库（注入 → 回合归约 → 落库完整化的壳侧存储面）──

/// 项目任务存储目录名（data_dir 下；按任务 id 单文件 JSON）。
const PROJECT_TASK_DIR: &str = "project_tasks";

/// 文件名安全化（非字母数字统一为下划线，防路径穿越；与账本同纪律）。
fn sanitize(name: &str) -> String {
    name.chars()
        .map(|ch| if ch.is_alphanumeric() { ch } else { '_' })
        .collect()
}

fn project_task_dir(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join(PROJECT_TASK_DIR)
}

/// 落库项目任务（回合归约后写回；失败 = 结构化错误，不静默）。
pub fn save_project_task(
    data_dir: &std::path::Path,
    task_id: &str,
    task: &ProjectTask,
) -> Result<std::path::PathBuf, String> {
    let dir = project_task_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|err| format!("任务目录创建失败: {err}"))?;
    let path = dir.join(format!("task_{}.json", sanitize(task_id)));
    let text = serde_json::to_string_pretty(task).map_err(|err| format!("任务序列化失败: {err}"))?;
    std::fs::write(&path, text).map_err(|err| format!("任务落盘失败: {err}"))?;
    Ok(path)
}

/// 读回项目任务（无记录/坏 JSON = None；供 round_send 注入与 resume 续流）。
pub fn load_project_task(data_dir: &std::path::Path, task_id: &str) -> Option<ProjectTask> {
    let path = project_task_dir(data_dir).join(format!("task_{}.json", sanitize(task_id)));
    let text = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&text).ok()
}

/// 归约后更新并落库（读 → 归约 → 写回）。
pub fn reduce_and_save_project_task(
    data_dir: &std::path::Path,
    task_id: &str,
    task: &ProjectTask,
    events: &[JsonValue],
) -> Result<ProjectTask, String> {
    let updated = reduce_project_task(task, events);
    save_project_task(data_dir, task_id, &updated)?;
    Ok(updated)
}

// ── 单元测试 ──

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(updated.status, TaskStatus::Error, "错误应置 error 状态");
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
            model: None,
            attachments: None,
            auto_accept_review: true,
        };
        let inj = req.inject.expect("inject 应透传");
        assert_eq!(inj["project_task"]["goal"], "目标 x");
        assert_eq!(inj["project_task"]["status"], "pending", "枚举序列化 = snake_case 词表");
    }

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("{tag}_{}", uuid::Uuid::new_v4().simple()))
    }

    fn round_events() -> Vec<JsonValue> {
        vec![
            json!({"type":"tool_start","payload":{"tool":"write_file","tool_call_id":"call-1","title":"写文件"}}),
            json!({"type":"tool_end","payload":{"tool":"write_file","tool_call_id":"call-1","kind":"file_write","path":"src/a.rs","success":true}}),
            json!({"type":"run_test_unit","payload":{"passed":3,"failed":0}}),
        ]
    }

    #[test]
    fn project_task_inject_reduce_persist_roundtrip() {
        let dir = tmp_dir("pt_roundtrip");
        let task = ProjectTask::new("实现特性");
        // 1) 注入：任务序列化进 RoundRequest.inject（引擎零改动感知）
        let inject = inject_project_task(&task);
        let req = crate::engine::host::RoundRequest {
            input_text: "go".to_string(),
            thread_id: "th".to_string(),
            round_id: "r".to_string(),
            step_args: None,
            orchestrate: None,
            inject: Some(inject),
            model: None,
            attachments: None,
            auto_accept_review: true,
        };
        assert_eq!(req.inject.as_ref().unwrap()["project_task"]["goal"], "实现特性");
        // 2) 归约：回合事件确定性收敛任务状态
        let updated = reduce_project_task(&task, &round_events());
        assert!(updated.changed_files.contains(&"src/a.rs".to_string()));
        assert!(updated.check_status.passing);
        assert_eq!(updated.round_no, 1);
        // 3) 落库：归约结果写回 + 读回一致（重启续流形态）
        save_project_task(&dir, "task-1", &updated).expect("落库须成功");
        let loaded = load_project_task(&dir, "task-1").expect("读回须命中");
        assert_eq!(loaded, updated);
        // 4) 一步链：读 → 归约 → 写回
        let again = reduce_and_save_project_task(&dir, "task-1", &loaded, &round_events())
            .expect("链式归约落库须成功");
        assert_eq!(again.round_no, 2, "第二轮归约 round_no 递增");
        assert_eq!(load_project_task(&dir, "task-1").unwrap(), again);
        assert!(load_project_task(&dir, "task-missing").is_none(), "未落库任务 = None");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_task_inject_to_persist_via_round_steps_transport() {
        // 端到端形态：round_send 的注入 → 记录器 feed 回合事件 → 归约落库
        let dir = tmp_dir("pt_chain");
        let task = ProjectTask::new("端到端目标");
        let inject = inject_project_task(&task);
        // 注入负载进入回合请求
        let mut recorder = crate::domain::steps::RoundStepsTransport::new("r-1", None, None);
        let req = crate::engine::host::RoundRequest {
            input_text: "go".to_string(),
            thread_id: "th".to_string(),
            round_id: "r".to_string(),
            step_args: None,
            orchestrate: None,
            inject: Some(inject),
            model: None,
            attachments: None,
            auto_accept_review: true,
        };
        assert_eq!(req.inject.as_ref().unwrap()["project_task"]["goal"], "端到端目标");
        // 回合事件经记录器收敛为步骤序列，再喂给归约
        for ev in &round_events() {
            recorder.feed(ev);
        }
        let steps = recorder.snapshot();
        assert!(!steps.is_empty(), "记录器应收敛出步骤");
        let updated = reduce_and_save_project_task(&dir, "task-e2e", &task, &round_events())
            .expect("归约落库须成功");
        assert_eq!(updated.round_no, 1);
        let persisted = load_project_task(&dir, "task-e2e").unwrap();
        assert_eq!(persisted.status, TaskStatus::InProgress, "有事件无错误 → in_progress");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
