//! 种子数据目录解析与数据文件加载。
//!
//! 执行件的领域数据（rules/samples/signals/review/tools）是「知识是数据」
//! 公理的载体：执行体只消费数据，不内置任何领域内容。数据目录解析顺序：
//! 1. 环境变量 INKLING_SEED_DATA 显式指定（M3 集成时宿主把该变量指向
//!    seeds/inkling/seed_data/，即真实数据绑定路径）；
//! 2. 当前目录下的 seed_data/（开发时直接从种子目录运行）；
//! 3. 编译期固定的 exec/tests/fixtures/（仅测试/调试构建：本地夹具镜像
//!    数据契约语义，M0 数据落盘后由前两条路径接管）。发布构建无夹具
//!    回落——缺失数据返回统一提示（E11：编译机绝对路径不得烧进发布
//!    二进制，夹具回落是开发态便利不是产品行为）。
//!
//! 数据文件按调用加载不缓存：知识是补丁链演化的活数据，缓存会让执行件
//! 在数据升级后继续用旧基线（与「变化是补丁」公理冲突）；文件本身是 KB
//! 级，每次调用重读的 IO 成本可忽略。

use std::path::PathBuf;

use crate::json::{self, Value};

/// 环境变量名：真实种子数据目录（集成时切真实数据的绑定点）。
pub const ENV_SEED_DATA: &str = "INKLING_SEED_DATA";

/// 相对当前目录的种子数据目录名（与种子目录结构 seed_data/ 同名）。
const LOCAL_SEED_DATA_DIR: &str = "seed_data";

/// 编译期固定的夹具目录：tests/fixtures（仅测试/调试构建生效的本地基线）。
#[cfg(any(test, debug_assertions))]
const FIXTURES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

/// 解析数据目录（见模块文档的解析顺序）。release 缺数据返回错误（E11）。
/// env 指向的目录必须真实存在（否则报错而非静默回落——env 是显式绑定
/// 点，配错了要大声失败，不能让夹具回落掩盖装配错误）；相对路径按
/// 当前目录解析（cargo 测试进程 CWD = 包根目录，宿主通常给绝对路径）。
pub fn resolve_data_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var(ENV_SEED_DATA) {
        let dir = dir.trim();
        if !dir.is_empty() {
            let path = PathBuf::from(dir);
            if path.is_dir() {
                return Ok(path);
            }
            if let Ok(cwd) = std::env::current_dir() {
                let resolved = cwd.join(&path);
                if resolved.is_dir() {
                    return Ok(resolved);
                }
            }
            return Err(format!(
                "种子数据不可用：{} 指向的目录不存在（{}）",
                ENV_SEED_DATA, dir
            ));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let local = cwd.join(LOCAL_SEED_DATA_DIR);
        if local.is_dir() {
            return Ok(local);
        }
    }
    // 夹具回落仅测试/调试构建（E11）：release 无夹具，缺数据 = 装配缺失
    #[cfg(any(test, debug_assertions))]
    {
        Ok(PathBuf::from(FIXTURES_DIR))
    }
    #[cfg(not(any(test, debug_assertions)))]
    {
        Err(format!(
            "种子数据不可用：未设置 {} 且当前目录无 {}（夹具回落仅限开发/测试构建，请配置真实种子数据目录）",
            ENV_SEED_DATA, LOCAL_SEED_DATA_DIR
        ))
    }
}

/// 加载数据文件。对外错误统一「种子数据不可用」+ 文件名（E17：不暴露
/// 宿主文件系统布局）；文件系统路径只进 stderr 供排障，不进回包。
pub fn load_json_file(name: &str) -> Result<Value, String> {
    let path = resolve_data_dir()?.join(name);
    let content = std::fs::read_to_string(&path).map_err(|e| {
        eprintln!("[inkling_exec] 数据文件读取失败: {}（{}）", path.display(), e);
        format!("种子数据不可用（{} 读取失败）", name)
    })?;
    json::parse(&content).map_err(|e| format!("种子数据不可用（{} 解析失败）: {}", name, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_dir_resolves() {
        // 缺省（无环境变量、无本地 seed_data）应回落夹具目录且数据可读
        let rules = load_json_file("rules.json").expect("夹具 rules.json 可加载");
        assert!(rules.as_object().is_some());
    }

    #[test]
    fn error_message_does_not_leak_path() {
        // E17：错误文案不得含绝对路径（宿主文件系统布局不外泄）
        let err = load_json_file("no_such_file.json").unwrap_err();
        assert!(err.starts_with("种子数据不可用"), "错误文案: {}", err);
        assert!(!err.contains('\\') && !err.contains('/'), "错误文案泄露路径: {}", err);
    }
}
