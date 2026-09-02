//! 壳侧审批台账（审批闸门归属壳侧；命令面拆分迁入 commands 域）。
//!
//! 命令层不接受客户端 approved 布尔；`registry.run` 前的裁决 = 档位表
//! （工具声明 permission → TieredGate）判定 review 档 → 查询台账（引擎
//! 审批卡决议态驱动：`approval.gate_card_request` 决议 / 自动审批配置 /
//! 引擎 `os.dispatch` 放行态登记）。无服务端审批态 = review 档被拒
//! （fail-closed，客户端无法自证授权）。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::Value as JsonValue;

use crate::executors::impls::Authorization;
use crate::executors::tool_decl::{PermissionLevel, ToolDeclarations};

/// 审批台账条目键：(工具名, 参数指纹) → 已批准（指纹 = 参数规范 JSON，
/// 按调用实参精确裁决——同工具不同参数不共享批准）。
fn fingerprint_key(tool: &str, args: &BTreeMap<String, JsonValue>) -> String {
    let args_text = serde_json::to_string(args).unwrap_or_default();
    format!("{tool}\u{1f}{args_text}")
}

/// 剥离下划线开头的内部信令键（`_escalated` 等引擎内部标记）：内部
/// 信令不得进入裁决指纹，渲染进程伪造的内部键在裁决前被清除（S-2——
/// 升级放行的信任依据 = 审批台账批准态本身，而非 args 中的标记）。
pub fn strip_internal_keys(args: &BTreeMap<String, JsonValue>) -> BTreeMap<String, JsonValue> {
    args.iter()
        .filter(|(key, _)| !key.starts_with('_'))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// 壳侧审批台账（决议 4：命令面裁决的档位表与决议态；与引擎侧
/// `security.auto_approve_set` 门禁同口径）。
#[derive(Clone)]
pub struct ApprovalLedger {
    gate: crate::domain::security::TieredGate,
    auto_all_review: Arc<Mutex<bool>>,
    auto_tools: Arc<Mutex<HashSet<String>>>,
    resolutions: Arc<Mutex<HashMap<String, bool>>>,
    /// 引擎通道一次性放行（`os.dispatch` 回调登记；命中即消费，防渲染
    /// 进程经命令面重放引擎已批准的同参数调用——引擎放行态不常驻台账）
    engine_approvals: Arc<Mutex<HashSet<String>>>,
}

impl ApprovalLedger {
    /// 从工具声明（fixtures/tools_os.json）装载档位表（permission → 档位；
    /// deny 档不登记 = TieredGate 无条件拒绝语义由执行器守卫兜底）。
    pub fn from_declarations(declarations: &ToolDeclarations) -> Self {
        let mut tiers = HashMap::new();
        for tool in &declarations.tools {
            let tier = match tool.permission {
                PermissionLevel::Allow => crate::domain::security::ALLOW,
                PermissionLevel::Review => crate::domain::security::REVIEW,
                PermissionLevel::Deny => crate::domain::security::DENY,
            };
            tiers.insert(tool.name.clone(), tier.to_string());
        }
        Self {
            gate: crate::domain::security::TieredGate::new(
                tiers,
                crate::domain::security::DENY,
                HashMap::new(),
            ),
            auto_all_review: Arc::new(Mutex::new(false)),
            auto_tools: Arc::new(Mutex::new(HashSet::new())),
            resolutions: Arc::new(Mutex::new(HashMap::new())),
            engine_approvals: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// `registry.run` 前的裁决（命令层唯一授权入口）：allow/未登记工具按
    /// 声明直过；review 档查询台账，无批准态 = 拒绝。
    pub fn adjudicate(&self, tool: &str, args: &BTreeMap<String, JsonValue>) -> Authorization {
        let approved = if self.gate.review_needed(tool) {
            self.is_approved(tool, args)
        } else {
            true
        };
        Authorization { approved }
    }

    /// 引擎通道放行态登记（`os.dispatch` 回调）：引擎审批流水线先行裁决
    /// （approval.gate_card_request / 自动审批 / 策略档，seed 单源），壳侧
    /// 将引擎放行态记入一次性台账——仅引擎通道本次放行消费，不留常驻
    /// 批准（防渲染进程重放同参数调用）。
    pub fn record_engine_dispatch(&self, tool: &str, args: &BTreeMap<String, JsonValue>) {
        if self.gate.review_needed(tool) {
            self.engine_approvals
                .lock()
                .unwrap()
                .insert(fingerprint_key(tool, &strip_internal_keys(args)));
        }
    }

    /// 审批卡决议登记（引擎 `approval.gate_card_request` 决议态驱动）：
    /// payload 携带 tool/args 线索时按 (工具, 参数指纹) 落台账（调用方
    /// 约定：审批请求 payload 含 `{"tool": "...", "args": {...}}`）；
    /// 无线索仅留 key 迹（审计可回溯，裁决不命中）。
    pub fn record_resolution(&self, key: &str, decision: &str, payload: Option<&JsonValue>) {
        let accepted = decision == "accept";
        if let Some(payload) = payload {
            if let (Some(tool), Some(args)) = (
                payload.get("tool").and_then(JsonValue::as_str),
                payload.get("args"),
            ) {
                if let Some(map) = args.as_object() {
                    let map = map.clone().into_iter().collect();
                    self.resolutions
                        .lock()
                        .unwrap()
                        .insert(fingerprint_key(tool, &strip_internal_keys(&map)), accepted);
                }
            }
        }
        self.resolutions
            .lock()
            .unwrap()
            .insert(format!("key:{key}"), accepted);
    }

    /// 自动审批配置登记（能力设置持久化同源：`security.auto_approve_set`
    /// 成功后同步，命令面裁决与引擎侧门禁同口径）。
    pub fn set_auto_approve(&self, tools: Vec<String>, all_review: bool) {
        *self.auto_all_review.lock().unwrap() = all_review;
        *self.auto_tools.lock().unwrap() = tools.into_iter().collect();
    }

    fn is_approved(&self, tool: &str, args: &BTreeMap<String, JsonValue>) -> bool {
        if *self.auto_all_review.lock().unwrap() {
            return true;
        }
        if self.auto_tools.lock().unwrap().contains(tool) {
            return true;
        }
        let fingerprint = fingerprint_key(tool, args);
        if self
            .resolutions
            .lock()
            .unwrap()
            .get(&fingerprint)
            .copied()
            .unwrap_or(false)
        {
            return true;
        }
        // 引擎通道一次性放行：命中即消费（remove 原子完成判中 + 失效），
        // 命令面后续同参数调用不再命中（防重放）
        self.engine_approvals.lock().unwrap().remove(&fingerprint)
    }
}
