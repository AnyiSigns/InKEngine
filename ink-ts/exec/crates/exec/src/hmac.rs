//! HMAC-SHA256（RFC 2104；sha2 手写，规避额外依赖）与常时比较。
//!
//! exec 会话密钥（spawn 期经环境注入的随机值）只用于信封签名复核；签名
//! 文本 = 信封 body 原文（compact JSON 文本）——host 与 exec 两侧都不做
//! 跨语言 canonical JSON（避免浮点/排序边界差异）：复核对象与执行对象是
//! 同一串字节。常时比较防时序侧信道。

use sha2::{Digest, Sha256};

const HMAC_BLOCK: usize = 64;

/// HMAC-SHA256（key/data → 32 字节摘要）。
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut block_key = [0u8; HMAC_BLOCK];
    if key.len() > HMAC_BLOCK {
        let digest = Sha256::digest(key);
        block_key[..digest.len()].copy_from_slice(&digest);
    } else {
        block_key[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; HMAC_BLOCK];
    let mut opad = [0x5cu8; HMAC_BLOCK];
    for (slot, &key_byte) in ipad.iter_mut().zip(block_key.iter()) {
        *slot ^= key_byte;
    }
    for (slot, &key_byte) in opad.iter_mut().zip(block_key.iter()) {
        *slot ^= key_byte;
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(data);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_digest);
    let digest = outer.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// 字节 → 十六进制（小写）。
pub fn hex_encode(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push_str(&format!("{:02x}", byte));
    }
    text
}

/// 十六进制 → 字节（非法字符返回 None；签名面强制小写输入）。
pub fn hex_decode(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    let bytes = hex.as_bytes();
    for pair in bytes.chunks_exact(2) {
        let high = (pair[0] as char).to_digit(16)?;
        let low = (pair[1] as char).to_digit(16)?;
        out.push(((high << 4) | low) as u8);
    }
    Some(out)
}

/// 常时相等比较（长度不一致直接不等，不泄露前缀信息）。
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(x: &[u8]) -> String {
        hex_encode(x)
    }

    /// RFC 4231 Test Case 1：key = 0x0b × 20，data = "Hi There"。
    #[test]
    fn rfc4231_case1_matches() {
        let key = [0x0bu8; 20];
        let digest = hmac_sha256(&key, b"Hi There");
        assert_eq!(
            hex(&digest),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    /// RFC 4231 Test Case 2：key = "Jefe"，data = "what do ya want for nothing?"。
    #[test]
    fn rfc4231_case2_matches() {
        let digest = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            hex(&digest),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn hex_roundtrips_and_rejects() {
        let bytes = [0x00u8, 0x01, 0xab, 0xff];
        let text = hex(&bytes);
        assert_eq!(text, "0001abff");
        assert_eq!(hex_decode(&text).unwrap(), bytes);
        assert!(hex_decode("abc").is_none(), "奇数长度拒绝");
        assert!(hex_decode("0g").is_none(), "非法字符拒绝");
        assert!(hex_decode("0x1f").is_none(), "非法字符拒绝");
    }

    #[test]
    fn constant_time_eq_is_bytewise() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"x"));
    }

    #[test]
    fn long_key_hashes_into_block() {
        // RFC 4231 Test Case 6：key = 0xaa × 131（超块长），data = "Test Using
        // Larger Than Block-Size Key - Hash Key First"——验证超块长密钥先 hash
        let key = vec![0xaau8; 131];
        let digest = hmac_sha256(&key, b"Test Using Larger Than Block-Size Key - Hash Key First");
        assert_eq!(
            hex(&digest),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }
}
