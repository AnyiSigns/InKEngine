//! OOXML zip 容器最小读取：纯中央目录解析（零外部 zip 依赖）。
//!
//! 语义参照旧壳 doc_ops.rs 的 zip 层：只支持 stored/deflate 两种封装方法，
//! 其余 fail-closed；解压经 flate2。包结构合法但缺条目 = NotFound（与
//! BadZip/NotOffice 区分），调用方按缺件语义处理。

use flate2::read::DeflateDecoder;
use std::io::Read;

use super::super::super::envelope::Deny;

/// 压缩包错误分型（DocError 语义收敛为 Deny reason 分类 + 消息）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ZipErrorKind {
    EmptyInput,
    BadZip,
    UnsupportedCompression,
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipError {
    pub kind: ZipErrorKind,
    pub message: String,
}

impl ZipError {
    pub fn new(kind: ZipErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

/// 条目元信息（仅列名与方法，不读数据）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipEntryInfo {
    pub name: String,
    pub method: u16,
}

/// 读取压缩包内全部条目（仅解析中央目录）。
pub fn list_entries(zip: &[u8]) -> Result<Vec<ZipEntryInfo>, ZipError> {
    let (cd_offset, total) = read_eocd(zip)?;
    let mut entries = Vec::new();
    let mut pos = cd_offset as usize;
    for _ in 0..total {
        if pos + 46 > zip.len() {
            return Err(ZipError::new(ZipErrorKind::BadZip, "中央目录截断"));
        }
        if &zip[pos..pos + 4] != b"PK\x01\x02" {
            return Err(ZipError::new(ZipErrorKind::BadZip, "中央目录签名错误"));
        }
        let method = u16le(zip, pos + 10);
        let name_len = u16le(zip, pos + 28) as usize;
        let extra_len = u16le(zip, pos + 30) as usize;
        let comment_len = u16le(zip, pos + 32) as usize;
        let name_start = pos + 46;
        if name_start + name_len > zip.len() {
            return Err(ZipError::new(ZipErrorKind::BadZip, "条目名截断"));
        }
        let name =
            String::from_utf8_lossy(&zip[name_start..name_start + name_len]).into_owned();
        entries.push(ZipEntryInfo { name, method });
        pos += 46 + name_len + extra_len + comment_len;
    }
    Ok(entries)
}

/// 读取压缩包中指定条目的解压数据；缺失返回 NotFound。
pub fn read_entry(zip: &[u8], name: &str) -> Result<Vec<u8>, ZipError> {
    let (cd_offset, total) = read_eocd(zip)?;
    let mut pos = cd_offset as usize;
    for _ in 0..total {
        if pos + 46 > zip.len() {
            return Err(ZipError::new(ZipErrorKind::BadZip, "中央目录截断"));
        }
        if &zip[pos..pos + 4] != b"PK\x01\x02" {
            return Err(ZipError::new(ZipErrorKind::BadZip, "中央目录签名错误"));
        }
        let method = u16le(zip, pos + 10);
        let comp_size = u32le(zip, pos + 20) as usize;
        let name_len = u16le(zip, pos + 28) as usize;
        let extra_len = u16le(zip, pos + 30) as usize;
        let comment_len = u16le(zip, pos + 32) as usize;
        let lho = u32le(zip, pos + 42) as usize;
        let name_start = pos + 46;
        if name_start + name_len > zip.len() {
            return Err(ZipError::new(ZipErrorKind::BadZip, "条目名截断"));
        }
        let ename = String::from_utf8_lossy(&zip[name_start..name_start + name_len]);
        if ename == name {
            return read_local_entry(zip, lho, method, comp_size);
        }
        pos += 46 + name_len + extra_len + comment_len;
    }
    Err(ZipError::new(
        ZipErrorKind::NotFound,
        format!("压缩包内未找到条目 {name}"),
    ))
}

fn read_eocd(zip: &[u8]) -> Result<(u32, usize), ZipError> {
    if zip.len() < 22 {
        return Err(ZipError::new(ZipErrorKind::BadZip, "文件过短"));
    }
    let max_back = (zip.len() - 22).min(65535);
    let start = zip.len() - 22 - max_back;
    let mut found = None;
    for i in start..=zip.len() - 22 {
        if &zip[i..i + 4] == b"PK\x05\x06" {
            found = Some(i);
            break;
        }
    }
    let i = found.ok_or_else(|| ZipError::new(ZipErrorKind::BadZip, "未找到 EOCD 记录"))?;
    let total = u16le(zip, i + 10) as usize;
    let cd_offset = u32le(zip, i + 16);
    Ok((cd_offset, total))
}

fn read_local_entry(
    zip: &[u8],
    lho: usize,
    method: u16,
    comp_size: usize,
) -> Result<Vec<u8>, ZipError> {
    if lho + 30 > zip.len() {
        return Err(ZipError::new(ZipErrorKind::BadZip, "本地头截断"));
    }
    if &zip[lho..lho + 4] != b"PK\x03\x04" {
        return Err(ZipError::new(ZipErrorKind::BadZip, "本地头签名错误"));
    }
    let name_len = u16le(zip, lho + 26) as usize;
    let extra_len = u16le(zip, lho + 28) as usize;
    let data_start = lho + 30 + name_len + extra_len;
    let data_end = data_start + comp_size;
    if data_end > zip.len() {
        return Err(ZipError::new(ZipErrorKind::BadZip, "条目数据越界"));
    }
    let data = &zip[data_start..data_end];
    match method {
        0 => Ok(data.to_vec()),
        8 => {
            let mut d = DeflateDecoder::new(data);
            let mut out = Vec::new();
            d.read_to_end(&mut out).map_err(|e| {
                ZipError::new(
                    ZipErrorKind::UnsupportedCompression,
                    format!("deflate 解压失败: {e}"),
                )
            })?;
            Ok(out)
        }
        other => Err(ZipError::new(
            ZipErrorKind::UnsupportedCompression,
            format!("不支持的压缩方式 {other}"),
        )),
    }
}

fn u16le(b: &[u8], o: usize) -> u16 {
    if o + 2 > b.len() {
        0
    } else {
        u16::from_le_bytes([b[o], b[o + 1]])
    }
}

fn u32le(b: &[u8], o: usize) -> u32 {
    if o + 4 > b.len() {
        0
    } else {
        u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
    }
}

impl From<ZipError> for Deny {
    fn from(err: ZipError) -> Self {
        let reason = match err.kind {
            ZipErrorKind::BadZip | ZipErrorKind::EmptyInput => "bad_zip",
            ZipErrorKind::UnsupportedCompression => "compression",
            ZipErrorKind::NotFound => "not_found",
        };
        Deny::new(reason, format!("{:?}: {}", err.kind, err.message))
    }
}

/// 用 stored 方法封包若干条目（测试/合成样张用）。
#[cfg(test)]
pub fn store_entries(entries: &[(String, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    let mut offset: u32 = 0;
    for (name, data) in entries {
        let name_bytes = name.as_bytes();
        let crc = crc32(data);
        let local_len = 30 + name_bytes.len();
        out.extend_from_slice(b"PK\x03\x04");
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(data);

        central.extend_from_slice(b"PK\x01\x02");
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name_bytes);
        offset = offset + (local_len + data.len()) as u32;
    }
    let cd_offset = offset;
    let cd_size = central.len() as u32;
    let total = entries.len() as u16;
    out.extend_from_slice(&central);
    out.extend_from_slice(b"PK\x05\x06");
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&total.to_le_bytes());
    out.extend_from_slice(&total.to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

#[cfg(test)]
fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for n in 0..256u32 {
        let mut c = n;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB88320 ^ (c >> 1) } else { c >> 1 };
        }
        table[n as usize] = c;
    }
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_round_trip_stored() {
        let zip = store_entries(&[
            ("a.txt".to_string(), b"alpha" as &[u8]),
            ("b.txt".to_string(), b"beta" as &[u8]),
        ]);
        let entries = list_entries(&zip).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(read_entry(&zip, "a.txt").unwrap(), b"alpha");
        assert_eq!(read_entry(&zip, "b.txt").unwrap(), b"beta");
        let missing = read_entry(&zip, "missing").unwrap_err();
        assert_eq!(missing.kind, ZipErrorKind::NotFound);
    }

    #[test]
    fn truncated_zip_fails_closed() {
        let mut zip = store_entries(&[("a.txt".to_string(), b"alpha" as &[u8])]);
        zip.truncate(zip.len() - 5);
        assert!(list_entries(&zip).is_err());
        assert!(read_entry(&zip, "a.txt").is_err());
    }
}
