//! 敏感凭据保护（Windows DPAPI 加密落盘 + 前端回传打码）。
//!
//! 存储形态：加密值带 ``dpapi:<hex>`` 前缀（DPAPI 密文 hex 编码）；未加密
//! /旧值 = 原样透传（迁移兼容，解密侧识别前缀按需还原）。前端回传形态：
//! ``****<尾4>`` 打码（写入侧识别打码值 = 未变更，跳过重写，防把打码
//! 占位当作新密钥加密落盘）。
//!
//! 非 Windows 平台回落明文透传（本壳 Windows 优先；跨平台形态保持可用）。

/// 加密值前缀（DPAPI 密文 hex）。
pub const DPAPI_PREFIX: &str = "dpapi:";
/// 打码值前缀（前端回传「未变更」形态）。
pub const MASK_PREFIX: &str = "****";

#[cfg(windows)]
mod dpapi {
    use super::*;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    extern "system" {
        fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut core::ffi::c_void,
            p_prompt_struct: *mut core::ffi::c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut core::ffi::c_void,
            p_prompt_struct: *mut core::ffi::c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
        fn LocalFree(h_mem: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
    }

    /// CRYPTPROTECT_UI_FORBIDDEN（无 UI 提示，静默加密/解密）。
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    /// 测试注入口：按线程置位后 protect 恒失败（隔离其它线程真实加密）。
    #[cfg(test)]
    thread_local! {
        static FAIL_PROTECT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }

    #[cfg(test)]
    pub(crate) fn set_fail_protect(fail: bool) {
        FAIL_PROTECT.with(|flag| flag.set(fail));
    }

    fn protect_bytes(plaintext: &[u8]) -> Result<Vec<u8>, String> {
        let in_blob = DataBlob {
            cb_data: plaintext.len() as u32,
            pb_data: plaintext.as_ptr() as *mut u8,
        };
        let mut out_blob = DataBlob {
            cb_data: 0,
            pb_data: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &in_blob,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };
        if ok == 0 {
            return Err(format!(
                "CryptProtectData 失败（err={}）",
                std::io::Error::last_os_error()
            ));
        }
        let result =
            unsafe { std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize).to_vec() };
        unsafe { LocalFree(out_blob.pb_data as *mut _) };
        Ok(result)
    }

    fn unprotect_bytes(blob: &[u8]) -> Result<Vec<u8>, String> {
        let in_blob = DataBlob {
            cb_data: blob.len() as u32,
            pb_data: blob.as_ptr() as *mut u8,
        };
        let mut out_blob = DataBlob {
            cb_data: 0,
            pb_data: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &in_blob,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };
        if ok == 0 {
            return Err(format!(
                "CryptUnprotectData 失败（err={}）",
                std::io::Error::last_os_error()
            ));
        }
        let result =
            unsafe { std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize).to_vec() };
        unsafe { LocalFree(out_blob.pb_data as *mut _) };
        Ok(result)
    }

    pub fn protect(plaintext: &str) -> Result<String, String> {
        #[cfg(test)]
        if FAIL_PROTECT.with(|flag| flag.get()) {
            return Err("注入：DPAPI 加密失败（测试桩）".to_string());
        }
        let blob = protect_bytes(plaintext.as_bytes())?;
        Ok(format!("{DPAPI_PREFIX}{}", hex::encode(blob)))
    }

    pub fn unprotect(value: &str) -> Result<String, String> {
        let hex_str = value
            .strip_prefix(DPAPI_PREFIX)
            .ok_or_else(|| "缺少 dpapi 前缀".to_string())?;
        let blob = hex::decode(hex_str).map_err(|err| format!("密文 hex 非法: {err}"))?;
        let bytes = unprotect_bytes(&blob)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
}

#[cfg(not(windows))]
mod dpapi {
    pub fn protect(plaintext: &str) -> Result<String, String> {
        // 非 Windows 平台回落明文透传（本壳 Windows 优先）
        Ok(plaintext.to_string())
    }

    pub fn unprotect(_value: &str) -> Result<String, String> {
        Err("非 Windows 平台无 DPAPI".to_string())
    }
}

/// 落盘保护（写入侧主入口）：Windows = DPAPI 加密（``dpapi:<hex>``）；
/// 已加密/打码值幂等透传；非 Windows = 明文透传。
///
/// 打码占位值（``****`` 前缀）是「前端未变更」形态，不是新密钥——跳过
/// 落盘原样透传，防把打码占位当作明文密钥加密写盘（批次 5 凭据链路）。
///
/// fail-closed（R1）：加密失败不产出明文——返回空串由调用方留痕，
/// 调用方须避免把空串当作新密钥落盘（写盘侧失败即中止保存见
/// [`super::model_archive`] / [`super::web_search`]）。
pub fn protect_secret(plaintext: &str) -> String {
    match protect_secret_checked(plaintext) {
        Ok(value) => value,
        Err(err) => {
            tracing::warn!(target: "crypto", error = %err, "DPAPI 加密失败（不落明文，回落空串）");
            String::new()
        }
    }
}

/// DPAPI 加密保护（明文 → 密文；失败 = Err 带原因，绝不产出明文）。
///
/// - 空串 = Ok("")；
/// - ``dpapi:`` 前缀/打码占位值 = Ok(原值)（幂等透传）；
/// - Windows = `dpapi::protect` 成功 Ok(密文)、失败 Err(带原因)；
/// - 非 Windows = Ok(明文透传，符合既有跨平台回落设计)。
pub fn protect_secret_checked(plaintext: &str) -> Result<String, String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }
    if plaintext.starts_with(DPAPI_PREFIX) || is_masked(plaintext) {
        return Ok(plaintext.to_string());
    }
    #[cfg(windows)]
    {
        dpapi::protect(plaintext)
    }
    #[cfg(not(windows))]
    {
        Ok(plaintext.to_string())
    }
}

/// 测试注入：Windows 下置位后 dpapi::protect 恒失败（按线程隔离，
/// 不影响其它测试线程的真实加密）。
#[cfg(all(windows, test))]
pub(crate) fn force_dpapi_protect_failure(fail: bool) {
    dpapi::set_fail_protect(fail);
}

/// 存储还原：``dpapi:`` 前缀 = DPAPI 解密；其余 = 原样（明文/旧值）。
pub fn restore_secret(value: &str) -> String {
    if value.starts_with(DPAPI_PREFIX) {
        #[cfg(windows)]
        {
            dpapi::unprotect(value).unwrap_or_else(|_| value.to_string())
        }
        #[cfg(not(windows))]
        {
            value.to_string()
        }
    } else {
        value.to_string()
    }
}

/// 前端回传打码（`****<尾4>`；加密值先还原再打码；长度不足 = 全打码）。
pub fn mask_secret(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    if is_masked(value) {
        return value.to_string();
    }
    let display = if value.starts_with(DPAPI_PREFIX) {
        restore_secret(value)
    } else {
        value.to_string()
    };
    let chars: Vec<char> = display.chars().collect();
    if chars.len() <= 4 {
        return MASK_PREFIX.to_string();
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{MASK_PREFIX}{tail}")
}

/// 打码值判定（写入侧识别「未变更」形态，跳过重写）。
pub fn is_masked(value: &str) -> bool {
    value.starts_with(MASK_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protect_skips_masked_placeholder_and_encrypted_prefix() {
        // 打码占位（前端「未变更」）不是新密钥：原样透传，防打码值被当
        // 明文密钥加密落盘（批次 5 凭据链路）。
        assert_eq!(protect_secret("****abcd"), "****abcd");
        assert_eq!(protect_secret("dpapi:abc"), "dpapi:abc");
        assert_eq!(protect_secret(""), "");
    }

    #[test]
    fn mask_secret_roundtrip_keeps_placeholder() {
        assert_eq!(mask_secret("****abcd"), "****abcd");
        assert_eq!(mask_secret(""), "");
    }

    #[test]
    fn is_masked_recognizes_only_star_prefix() {
        assert!(is_masked("****1234"));
        assert!(!is_masked("sk-1234"));
        assert!(!is_masked(""));
    }

    #[test]
    fn protect_secret_checked_passthrough_masked_and_prefix() {
        // 幂等透传不打保护器（空串/打码占位/已加密值）
        assert_eq!(protect_secret_checked("").unwrap(), "");
        assert_eq!(protect_secret_checked("****abcd").unwrap(), "****abcd");
        assert_eq!(protect_secret_checked("dpapi:abc").unwrap(), "dpapi:abc");
    }

    #[cfg(windows)]
    #[test]
    fn protect_secret_checked_returns_error_on_dpapi_failure() {
        // Windows 保护失败：Err 带原因（不产明文）——由调用方决定是否
        // 中止保存，杜绝「加密失败静默落明文」。
        super::force_dpapi_protect_failure(true);
        let checked = protect_secret_checked("sk-plain");
        let legacy = protect_secret("sk-plain");
        super::force_dpapi_protect_failure(false);
        assert!(checked.is_err(), "保护失败应 Err（不回落明文）");
        let message = checked.unwrap_err();
        assert!(message.contains("DPAPI") || message.contains("注入"), "Err 须带原因");
        assert_eq!(legacy, "", "protect_secret 失败回落空串而非明文（不落盘明文）");
        // 打码/前缀值不受注入影响（幂等透传不触保护器）
        assert_eq!(protect_secret_checked("****abcd").unwrap(), "****abcd");
        assert_eq!(protect_secret_checked("dpapi:abc").unwrap(), "dpapi:abc");
    }

    #[cfg(windows)]
    #[test]
    fn protect_secret_success_encrypts_on_windows() {
        let value = protect_secret("sk-real");
        assert!(value.starts_with(DPAPI_PREFIX), "Windows 加密成功应带 dpapi 前缀");
        assert_ne!(value, "sk-real", "不得产出明文");
    }
}
