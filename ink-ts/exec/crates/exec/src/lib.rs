//! OS 执行器子进程（信封驱动零声明表执行）。
//!
//! 职责边界：只按宿主下发的**授权信封**机械复核——签名校验 +
//! 信封约束（工具名/参数形状/端点归属/命令白名单/路径根与动态挂载根/
//! 出网域名白名单/尺寸与超时上界）通过后执行物理执行体回 JSON，任何漂移
//! fail-closed。执行约束全部随信封现取，本进程**不载策略文件、不做审批
//! 判定、不持久化台账**（零裁决红线）；信封里没有的可执行面（如白名单
//! 外命令）一律不存在，不在本进程内做二次审批放行。
//!
//! 传输形态 = rpc crate 的 stdio JSON-RPC 行帧；方法面：
//! - `ping`（健康探测）；
//! - `exec.call`（params = { body, signature }——body 为信封 JSON 的紧凑
//!   文本，signature = 会话密钥 HMAC-SHA256(body) 的十六进制；执行只信任
//!   通过签名复核的信封字节）。

pub mod envelope;
pub mod guard;
pub mod hmac;
pub mod ops;
pub mod protocol;

/// 会话密钥环境变量名（宿主 spawn 时注入；exec 启动期读取一次）。
pub const SESSION_KEY_ENV: &str = "INK_EXEC_SESSION_KEY";

/// 执行器会话：会话密钥（一次启动固定，供信封签名复核）。
pub struct Executor {
    key: Option<String>,
}

impl Executor {
    /// 从环境构造（缺省 = 无密钥：除 ping 外全部 fail-closed）。
    pub fn from_env() -> Self {
        Self::with_key(std::env::var(SESSION_KEY_ENV).ok())
    }

    /// 显式密钥构造（测试/宿主注入）。
    pub fn with_key(key: Option<String>) -> Self {
        Self {
            key: key.filter(|value| !value.is_empty()),
        }
    }

    /// 会话密钥是否已配置（无密钥 = 无法复核签名，调用一律拒绝）。
    pub fn has_key(&self) -> bool {
        self.key.is_some()
    }
}
