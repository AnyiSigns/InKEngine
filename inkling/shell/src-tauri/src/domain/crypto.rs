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

/// 落盘保护：Windows = DPAPI 加密（``dpapi:<hex>``）；已加密/打码值
/// 幂等透传；非 Windows = 明文透传。
pub fn protect_secret(plaintext: &str) -> String {
    if plaintext.is_empty() {
        return String::new();
    }
    if plaintext.starts_with(DPAPI_PREFIX) || is_masked(plaintext) {
        return plaintext.to_string();
    }
    dpapi::protect(plaintext).unwrap_or_else(|_| plaintext.to_string())
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
