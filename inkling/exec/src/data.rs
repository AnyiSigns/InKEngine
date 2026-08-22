//! 种子数据目录解析与数据文件加载。
//!
//! 执行件的领域数据（rules/samples/signals/review/tools）是「知识是数据」
//! 公理的载体：执行体只消费数据，不内置任何领域内容。数据目录解析顺序：
//! 1. 环境变量 INKLING_SEED_DATA 显式指定（M3 集成时宿主把该变量指向
//!    seeds/inkling/seed_data/，即真实数据绑定路径）；
//! 2. 当前目录下的 seed_data/（开发时直接从种子目录运行）；
//! 3. 编译期固定的 exec/tests/fixtures/（开发/测试缺省：本地夹具镜像
//!    M0 数据契约语义，M0 数据落盘后由前两条路径接管）。
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

/// 编译期固定的夹具目录：tests/fixtures（镜像 M0 数据契约的本地基线）。
const FIXTURES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

/// 解析数据目录（见模块文档的解析顺序）。
pub fn resolve_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var(ENV_SEED_DATA) {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let local = cwd.join(LOCAL_SEED_DATA_DIR);
        if local.is_dir() {
            return local;
        }
    }
    PathBuf::from(FIXTURES_DIR)
}

/// 加载数据文件（解析失败返回带路径与原因的说明，执行体据此报结构化错误）。
pub fn load_json_file(name: &str) -> Result<Value, String> {
    let path = resolve_data_dir().join(name);
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("数据文件 {} 读取失败: {}", path.display(), e))?;
    json::parse(&content).map_err(|e| format!("数据文件 {} 解析失败: {}", path.display(), e))
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
}
