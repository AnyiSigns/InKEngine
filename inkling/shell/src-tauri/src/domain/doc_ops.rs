//! doc_ops 域：文档/办公生态（PDF / Office 解析与生成）的壳侧执行体。
//!
//! 产品入口：用户从附件管线喂入论文 PDF / Excel / PPT，本模块在壳侧完成
//! 格式识别、内容解析（接入既有研究链）、以及 agent 产出 docx/xlsx 的导出。
//!
//! 能力范围：
//! - 格式识别：按文件头魔数识别 PDF 与 OOXML 容器（docx/xlsx/pptx）。
//! - PDF 解析：内容流文本提取 + 页面/文本块版面骨架，输出结构化 JSON。
//! - Office 解析：docx（段落/表格）、xlsx（二维表）、pptx（文本）的结构化输出。
//! - 生成：docx 报告/纪要骨架、xlsx 表格导出骨架（合法 OOXML 包结构）。
//!
//! 设计要点：zip 容器解包/封包为纯中央目录解析 + 简易封包（stored 方法），
//! 压缩流经 flate2 解压；OOXML 与 PDF 的 XML/内容流解析为纯字符串与结构
//! 处理。全部以内存缓冲为输入，可注入依赖单测，不落真实文件。
//!
//! 依赖纪律：本模块不调用其它域模块；压缩特例依赖 flate2，其余为纯逻辑。

use std::collections::HashMap;

use serde_json::Value as JsonValue;

/// PDF 头扫描窗口（前 1024 字节内找 %PDF- 魔数，容忍少量前导字节）。
const PDF_HEADER_SCAN_BYTES: usize = 1024;

/// 文本行合并容差（y 坐标差 < 1.0 视为同一行）。
const PDF_LINE_Y_TOLERANCE: f64 = 1.0;

/// 块合并容差（行 y 坐标差 < 20.0 归入同一块）。
const PDF_BLOCK_Y_TOLERANCE: f64 = 20.0;

/// 工作表/幻灯片条目遍历上限（防御性兜底；正常路径按声明条目数遍历）。
const MAX_SHEET_ENTRIES: usize = 256;

/// 依赖纪律：文档格式枚举（PDF 与 OOXML 三件套）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocFormat {
    Pdf,
    Docx,
    Xlsx,
    Pptx,
    Unknown,
}

/// 失败分型（结构化：错误类别 + 消息）。解析与生成一律 fail-closed。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocErrorKind {
    EmptyInput,
    UnsupportedFormat,
    BadZip,
    UnsupportedCompression,
    NotPdf,
    NotOffice,
    /// 压缩包结构合法但缺指定条目（与「非 Office 包」区分）。
    NotFound,
    Parse,
    Generate,
}

/// 结构化错误（可单测断言）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocError {
    pub kind: DocErrorKind,
    pub message: String,
}

impl DocError {
    pub fn new(kind: DocErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for DocError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for DocError {}

// ── 格式识别 ──

/// 按文件头魔数识别文档格式。空输入或无法识别返回 Unknown。
pub fn detect_format(bytes: &[u8]) -> DocFormat {
    if bytes.is_empty() {
        return DocFormat::Unknown;
    }
    if pdf_has_header(bytes) {
        return DocFormat::Pdf;
    }
    if bytes.starts_with(b"PK\x03\x04") {
        if let Ok(entries) = zip_list_entries(bytes) {
            let has = |prefix: &str| entries.iter().any(|e| e.name.starts_with(prefix));
            if has("word/") {
                return DocFormat::Docx;
            }
            if has("xl/") {
                return DocFormat::Xlsx;
            }
            if has("ppt/") {
                return DocFormat::Pptx;
            }
        }
    }
    DocFormat::Unknown
}

/// 在文件头 [`PDF_HEADER_SCAN_BYTES`] 字节内扫描 PDF 魔数（容忍少量前导字节）。
fn pdf_has_header(bytes: &[u8]) -> bool {
    let end = bytes.len().min(PDF_HEADER_SCAN_BYTES);
    bytes[..end].windows(5).any(|w| w == b"%PDF-")
}

// ── 压缩包（zip）解析：纯中央目录解析 + stored 读取 + flate2 解压 ──

/// 压缩内条目封装方法。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZipMethod {
    Stored,
    Deflated,
}

/// 压缩包内条目元信息（仅列名与方法，不读数据）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipEntryInfo {
    pub name: String,
    pub method: ZipMethod,
}

/// 列出压缩包内全部条目名称与方法（仅解析中央目录，不触碰数据）。
pub fn zip_list_entries(zip: &[u8]) -> Result<Vec<ZipEntryInfo>, DocError> {
    let (cd_offset, total) = read_eocd(zip)?;
    let mut entries = Vec::new();
    let mut pos = cd_offset as usize;
    for _ in 0..total {
        if pos + 46 > zip.len() {
            return Err(DocError::new(DocErrorKind::BadZip, "中央目录截断"));
        }
        if &zip[pos..pos + 4] != b"PK\x01\x02" {
            return Err(DocError::new(DocErrorKind::BadZip, "中央目录签名错误"));
        }
        let method = u16le(zip, pos + 10);
        let name_len = u16le(zip, pos + 28) as usize;
        let extra_len = u16le(zip, pos + 30) as usize;
        let comment_len = u16le(zip, pos + 32) as usize;
        let name_start = pos + 46;
        if name_start + name_len > zip.len() {
            return Err(DocError::new(DocErrorKind::BadZip, "条目名截断"));
        }
        let name = String::from_utf8_lossy(&zip[name_start..name_start + name_len]).to_string();
        let m = match method {
            0 => ZipMethod::Stored,
            8 => ZipMethod::Deflated,
            other => {
                return Err(DocError::new(
                    DocErrorKind::UnsupportedCompression,
                    format!("不支持的压缩方式 {other}"),
                ))
            }
        };
        entries.push(ZipEntryInfo { name, method: m });
        pos += 46 + name_len + extra_len + comment_len;
    }
    Ok(entries)
}

/// 读取压缩包中指定条目的解压数据；缺失返回 NotFound 分型（区别于
/// BadZip/NotOffice——包结构合法但缺条目，调用方按缺件语义处理）。
pub fn zip_read_entry(zip: &[u8], name: &str) -> Result<Vec<u8>, DocError> {
    let (cd_offset, total) = read_eocd(zip)?;
    let mut pos = cd_offset as usize;
    for _ in 0..total {
        if pos + 46 > zip.len() {
            return Err(DocError::new(DocErrorKind::BadZip, "中央目录截断"));
        }
        if &zip[pos..pos + 4] != b"PK\x01\x02" {
            return Err(DocError::new(DocErrorKind::BadZip, "中央目录签名错误"));
        }
        let method = u16le(zip, pos + 10);
        let comp_size = u32le(zip, pos + 20) as usize;
        let name_len = u16le(zip, pos + 28) as usize;
        let extra_len = u16le(zip, pos + 30) as usize;
        let comment_len = u16le(zip, pos + 32) as usize;
        let lho = u32le(zip, pos + 42) as usize;
        let name_start = pos + 46;
        if name_start + name_len > zip.len() {
            return Err(DocError::new(DocErrorKind::BadZip, "条目名截断"));
        }
        let ename = String::from_utf8_lossy(&zip[name_start..name_start + name_len]);
        if ename == name {
            return read_local_entry(zip, lho, method, comp_size);
        }
        pos += 46 + name_len + extra_len + comment_len;
    }
    Err(DocError::new(
        DocErrorKind::NotFound,
        format!("压缩包内未找到条目 {name}"),
    ))
}

/// 用 stored 方法封包若干条目（文件名 + 数据），产出合法 zip 字节。
pub fn zip_store(entries: &[(String, &[u8])]) -> Result<Vec<u8>, DocError> {
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
    Ok(out)
}

fn read_eocd(zip: &[u8]) -> Result<(u32, usize), DocError> {
    if zip.len() < 22 {
        return Err(DocError::new(DocErrorKind::BadZip, "文件过短"));
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
    let i = found.ok_or_else(|| DocError::new(DocErrorKind::BadZip, "未找到 EOCD 记录"))?;
    let total = u16le(zip, i + 10) as usize;
    let cd_offset = u32le(zip, i + 16);
    Ok((cd_offset, total))
}

fn read_local_entry(
    zip: &[u8],
    lho: usize,
    method: u16,
    comp_size: usize,
) -> Result<Vec<u8>, DocError> {
    if lho + 30 > zip.len() {
        return Err(DocError::new(DocErrorKind::BadZip, "本地头截断"));
    }
    if &zip[lho..lho + 4] != b"PK\x03\x04" {
        return Err(DocError::new(DocErrorKind::BadZip, "本地头签名错误"));
    }
    let name_len = u16le(zip, lho + 26) as usize;
    let extra_len = u16le(zip, lho + 28) as usize;
    let data_start = lho + 30 + name_len + extra_len;
    let data_end = data_start + comp_size;
    if data_end > zip.len() {
        return Err(DocError::new(DocErrorKind::BadZip, "条目数据越界"));
    }
    let data = &zip[data_start..data_end];
    match method {
        0 => Ok(data.to_vec()),
        8 => {
            use flate2::read::DeflateDecoder;
            use std::io::Read;
            let mut d = DeflateDecoder::new(data);
            let mut out = Vec::new();
            d.read_to_end(&mut out).map_err(|e| {
                DocError::new(
                    DocErrorKind::UnsupportedCompression,
                    format!("deflate 解压失败: {e}"),
                )
            })?;
            Ok(out)
        }
        other => Err(DocError::new(
            DocErrorKind::UnsupportedCompression,
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

// ── PDF 解析：内容流文本提取 + 页面/块版面骨架 ──

/// 单条文本定位（内容流坐标，y 自下而上）。
#[derive(Debug, Clone, PartialEq)]
pub struct PdfTextRun {
    pub x: f64,
    pub y: f64,
    pub text: String,
}

/// 文本块（版面骨架：一簇同处文本行）。
#[derive(Debug, Clone, PartialEq)]
pub struct PdfBlock {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub text: String,
}

/// 单页（块集合 + 整页文本）。
#[derive(Debug, Clone, PartialEq)]
pub struct PdfPage {
    pub index: usize,
    pub blocks: Vec<PdfBlock>,
    pub text: String,
}

/// 解析产物（多页）。
#[derive(Debug, Clone, PartialEq)]
pub struct PdfDocument {
    pub pages: Vec<PdfPage>,
}

/// 解析 PDF 字节为对象体切片（零拷贝：对象体为输入字节的借用切片，
/// 不在解析层复制全文件——FA9 惰性读取，内存随输入而非成倍放大）。
pub fn collect_pdf_objects(bytes: &[u8]) -> Vec<(u32, &[u8])> {
    let obj_re = bytes_regex(r"(?s)(\d+)\s+\d+\s+obj");
    let mut starts: Vec<(u32, usize)> = Vec::new();
    for c in obj_re.captures_iter(bytes) {
        let n = parse_num(c.get(1).unwrap().as_bytes());
        let pos = c.get(0).unwrap().end();
        starts.push((n, pos));
    }
    let mut out = Vec::new();
    for (n, pos) in starts {
        out.push((n, extract_object_body(bytes, pos)));
    }
    out
}

/// 抽取对象体（dict + stream 全段）的借用切片。
///
/// 边界按 `/Length` 推算的流尾逐字核对 `endstream`（关键字搜索经
/// 字面量状态跟踪，不误割字符串体内的 "stream"/"endobj" 字面量）；
/// `/Length` 与 endstream 不闭合 = 边界不可信，fail-closed 返回空
/// （宁丢该对象，不产出错割内容）。
fn extract_object_body(bytes: &[u8], after_obj: usize) -> &[u8] {
    let stream_pos = find_keyword(bytes, b"stream", after_obj);
    let endobj_pos = find_keyword(bytes, b"endobj", after_obj);
    match (stream_pos, endobj_pos) {
        (Some(sp), Some(ep)) if sp < ep => {
            let dict = &bytes[after_obj..sp];
            let eol = if bytes.get(sp + 6) == Some(&b'\r') { 2 } else { 1 };
            let data_start = sp + 6 + eol;
            let end = data_start + parse_stream_length(dict).unwrap_or(0);
            let es = end + skip_stream_eol(bytes, end);
            if es + 9 <= bytes.len() && &bytes[es..es + 9] == b"endstream" {
                &bytes[after_obj..es + 9]
            } else {
                &[]
            }
        }
        (_, Some(ep)) => &bytes[after_obj..(ep + 6).min(bytes.len())],
        _ => &[],
    }
}

/// stream 数据尾到 endstream 关键字间允许的 EOL 分隔（PDF 约定：
/// `endstream` 前可有一行 EOL；该 EOL 不属于流数据）。
fn skip_stream_eol(bytes: &[u8], pos: usize) -> usize {
    if bytes.get(pos) == Some(&b'\r') {
        if bytes.get(pos + 1) == Some(&b'\n') {
            2
        } else {
            1
        }
    } else if bytes.get(pos) == Some(&b'\n') {
        1
    } else {
        0
    }
}

/// 关键字搜索（字面量状态跟踪）：跳过 `(…)` 字符串、`<…>` 十六进制串、
/// `<<`/`>>` 字典定界符与 `%` 注释后找 needle；命中处须以分隔符收尾
/// （防半词前缀误匹配）。
fn find_keyword(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= hay.len() {
        return None;
    }
    let mut i = from;
    let mut in_literal = false;
    let mut depth = 0usize;
    let mut in_hex = false;
    while i < hay.len() {
        if in_literal {
            if hay[i] == b'\\' && i + 1 < hay.len() {
                i += 2;
                continue;
            }
            if hay[i] == b'(' {
                depth += 1;
            } else if hay[i] == b')' {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    in_literal = false;
                }
            }
            i += 1;
            continue;
        }
        if in_hex {
            if hay[i] == b'>' {
                in_hex = false;
            }
            i += 1;
            continue;
        }
        if hay[i] == b'%' {
            while i < hay.len() && hay[i] != b'\n' && hay[i] != b'\r' {
                i += 1;
            }
            continue;
        }
        if hay[i] == b'(' {
            in_literal = true;
            depth = 1;
            i += 1;
            continue;
        }
        if hay[i] == b'<' {
            if hay.get(i + 1) == Some(&b'<') {
                // 字典定界符 <<：非十六进制串，整对跳过
                i += 2;
                continue;
            }
            in_hex = true;
            i += 1;
            continue;
        }
        if hay[i..].starts_with(needle) {
            let before_ok = i == from || !hay[i - 1].is_ascii_alphanumeric();
            let after = i + needle.len();
            let after_ok = after >= hay.len() || is_keyword_delim(hay[after]);
            if before_ok && after_ok {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// 关键字分隔符判定（PDF 词法：空白/括号/尖括号/斜杠/百分号/花括号）。
fn is_keyword_delim(b: u8) -> bool {
    b.is_ascii_whitespace() || matches!(b, b'(' | b')' | b'<' | b'>' | b'/' | b'%' | b'{' | b'}' | b'[' | b']')
}

/// dict 段内 `/Length` 值（字面量状态跟踪，不误读字符串体内的 /Length）。
fn parse_stream_length(dict: &[u8]) -> Option<usize> {
    let pos = find_keyword(dict, b"/Length", 0)?;
    let mut i = pos + b"/Length".len();
    while i < dict.len() && dict[i].is_ascii_whitespace() {
        i += 1;
    }
    let start = i;
    while i < dict.len() && dict[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return None;
    }
    std::str::from_utf8(&dict[start..i]).ok()?.parse::<usize>().ok()
}

fn parse_pdf(bytes: &[u8]) -> Result<PdfDocument, DocError> {
    if bytes.len() < 5 || !pdf_has_header(bytes) {
        return Err(DocError::new(DocErrorKind::NotPdf, "PDF 头缺失或输入过短"));
    }
    let mut obj_map: HashMap<u32, &[u8]> = HashMap::new();
    for (n, body) in collect_pdf_objects(bytes) {
        if !body.is_empty() {
            obj_map.insert(n, body);
        }
    }

    let page_re = bytes_regex(r"(?s)/Type\s*/Page");
    let page_body_re = bytes_regex(r"(?s)(?:/MediaBox|/Contents)");
    let contents_re = bytes_regex(r"(?s)/Contents\s*(?:(\d+)\s+0\s+R|\[([^\]]*)\])");
    let mut streams: Vec<(u32, Vec<u8>)> = Vec::new();
    let mut order: Vec<u32> = Vec::new();
    for (n, body) in &obj_map {
        if !page_re.is_match(body) || !page_body_re.is_match(body) {
            continue;
        }
        let mut page_streams: Vec<u8> = Vec::new();
        if let Some(c) = contents_re.captures(body) {
            if let Some(single) = c.get(1) {
                let cn = parse_num(single.as_bytes());
                if let Some(sb) = obj_map.get(&cn) {
                    if let Some(s) = extract_stream(sb) {
                        page_streams.extend_from_slice(&s);
                    }
                }
            } else if let Some(arr) = c.get(2) {
                for m in bytes_regex(r"(\d+)\s+0\s+R").captures_iter(arr.as_bytes()) {
                    let cn = parse_num(m.get(1).unwrap().as_bytes());
                    if let Some(sb) = obj_map.get(&cn) {
                        if let Some(s) = extract_stream(sb) {
                            page_streams.extend_from_slice(&s);
                        }
                    }
                }
            }
        }
        streams.push((*n, page_streams));
        order.push(*n);
    }
    order.sort();
    if order.is_empty() {
        return Err(DocError::new(DocErrorKind::Parse, "PDF 未解析到页对象"));
    }
    let mut pages = Vec::new();
    for (idx, n) in order.iter().enumerate() {
        let stream = &streams.iter().find(|(k, _)| k == n).unwrap().1;
        let runs = scan_content_stream(stream);
        let blocks = cluster_blocks(&runs);
        let text = blocks
            .iter()
            .map(|b| b.text.clone())
            .collect::<Vec<_>>()
            .join("\n");
        pages.push(PdfPage {
            index: idx,
            blocks,
            text,
        });
    }
    Ok(PdfDocument { pages })
}

/// 抽取对象内内容流（解压或原文）。边界经字面量状态跟踪的
/// `stream` 关键字 + `/Length` 推算 + `endstream` 逐字核对；
/// 边界不可信 = None（fail-closed，不静默错割）。
fn extract_stream(body: &[u8]) -> Option<Vec<u8>> {
    let marker = b"stream";
    let pos = find_keyword(body, marker, 0)?;
    let after = pos + marker.len();
    let start = if body.get(after) == Some(&b'\r') {
        after + 2
    } else if body.get(after) == Some(&b'\n') {
        after + 1
    } else {
        return None;
    };
    let dict = &body[..pos];
    let len = parse_stream_length(dict)?;
    if start + len > body.len() {
        return None;
    }
    let end = start + len;
    let es = end + skip_stream_eol(body, end);
    if !(es + 9 <= body.len() && &body[es..es + 9] == b"endstream") {
        return None;
    }
    let raw = &body[start..end];
    let flate = bytes_regex(r"(?s)/Filter\s*/FlateDecode").is_match(dict);
    if flate {
        use flate2::read::ZlibDecoder;
        use std::io::Read;
        let mut d = ZlibDecoder::new(raw);
        let mut out = Vec::new();
        d.read_to_end(&mut out).ok()?;
        Some(out)
    } else {
        Some(raw.to_vec())
    }
}

fn scan_content_stream(stream: &[u8]) -> Vec<PdfTextRun> {
    let re = bytes_regex(
        r#"(?s)(?P<tm>\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+Tm)|(?P<td>[-+]?\d+(?:\.\d+)?\s+[-+]?\d+(?:\.\d+)?\s+Td)|(?P<td2>[-+]?\d+(?:\.\d+)?\s+[-+]?\d+(?:\.\d+)?\s+TD)|(?P<tj>\((?:[^()\\]|\\.)*\)\s*Tj)|(?P<tjq>\((?:[^()\\]|\\.)*\)\s*')|(?P<tjqq>[-+]?\d+(?:\.\d+)?\s*\((?:[^()\\]|\\.)*\)\s*\")|(?P<tja>\[[^\]]*?\]\s*TJ)"#,
    );
    let mut runs = Vec::new();
    let mut x = 0.0_f64;
    let mut y = 0.0_f64;
    for c in re.captures_iter(stream) {
        if let Some(m) = c.name("tm") {
            let p = split_ws(m.as_bytes());
            if p.len() >= 6 {
                x = parse_f64(p[0]);
                y = parse_f64(p[5]);
            }
        } else if let Some(m) = c.name("td") {
            let p = split_ws(m.as_bytes());
            if p.len() >= 2 {
                x += parse_f64(p[0]);
                y += parse_f64(p[1]);
            }
        } else if let Some(m) = c.name("td2") {
            let p = split_ws(m.as_bytes());
            if p.len() >= 2 {
                x += parse_f64(p[0]);
                y += parse_f64(p[1]);
            }
        } else if let Some(m) = c.name("tj") {
            let lit = extract_literals(m.as_bytes()).into_iter().next();
            if let Some(l) = lit {
                runs.push(PdfTextRun {
                    x,
                    y,
                    text: pdf_unescape_literal(&l),
                });
            }
        } else if let Some(m) = c.name("tjq") {
            let lit = extract_literals(m.as_bytes()).into_iter().next();
            if let Some(l) = lit {
                runs.push(PdfTextRun {
                    x,
                    y,
                    text: pdf_unescape_literal(&l),
                });
            }
        } else if let Some(m) = c.name("tjqq") {
            let lit = extract_literals(m.as_bytes()).into_iter().next();
            if let Some(l) = lit {
                runs.push(PdfTextRun {
                    x,
                    y,
                    text: pdf_unescape_literal(&l),
                });
            }
        } else if let Some(m) = c.name("tja") {
            let mut text = String::new();
            for lit in extract_literals(m.as_bytes()) {
                text.push_str(&pdf_unescape_literal(&lit));
            }
            if !text.is_empty() {
                runs.push(PdfTextRun { x, y, text });
            }
        }
    }
    runs
}

fn cluster_blocks(runs: &[PdfTextRun]) -> Vec<PdfBlock> {
    if runs.is_empty() {
        return Vec::new();
    }
    let mut idx: Vec<usize> = (0..runs.len()).collect();
    idx.sort_by(|&a, &b| {
        runs[b]
            .y
            .partial_cmp(&runs[a].y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(runs[a].x.partial_cmp(&runs[b].x).unwrap_or(std::cmp::Ordering::Equal))
    });
    let mut lines: Vec<(f64, f64, String)> = Vec::new();
    for &i in &idx {
        let r = &runs[i];
        if let Some(last) = lines.last_mut() {
            if (last.0 - r.y).abs() < PDF_LINE_Y_TOLERANCE {
                last.2.push(' ');
                last.2.push_str(&r.text);
                continue;
            }
        }
        lines.push((r.y, r.x, r.text.clone()));
    }
    let mut blocks: Vec<PdfBlock> = Vec::new();
    let mut cur: Option<PdfBlock> = None;
    for (y, x, text) in lines {
        match cur.as_mut() {
            Some(b) if (b.y0 - y).abs() < PDF_BLOCK_Y_TOLERANCE => {
                b.text.push('\n');
                b.text.push_str(&text);
                b.y1 = y;
            }
            _ => {
                if let Some(b) = cur.take() {
                    blocks.push(b);
                }
                cur = Some(PdfBlock {
                    x0: x,
                    y0: y,
                    x1: x,
                    y1: y,
                    text,
                });
            }
        }
    }
    if let Some(b) = cur.take() {
        blocks.push(b);
    }
    blocks
}

fn pdf_unescape_literal(bytes: &[u8]) -> String {
    let mut out: Vec<u8> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\\' && i + 1 < bytes.len() {
            let n = bytes[i + 1];
            match n {
                b'(' => out.push(b'('),
                b')' => out.push(b')'),
                b'\\' => out.push(b'\\'),
                b'n' => out.push(b'\n'),
                b'r' => out.push(b'\r'),
                b't' => out.push(b'\t'),
                b'b' => out.push(0x08),
                b'f' => out.push(0x0C),
                b'0'..=b'7' => {
                    let mut val = 0u32;
                    let mut j = i + 1;
                    while j < bytes.len() && j < i + 4 && bytes[j].is_ascii_digit() {
                        val = val * 8 + (bytes[j] - b'0') as u32;
                        j += 1;
                    }
                    if val <= 255 {
                        out.push(val as u8);
                    }
                    i = j;
                    continue;
                }
                other => out.push(other),
            }
            i += 2;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn extract_literals(bytes: &[u8]) -> Vec<Vec<u8>> {
    let re = bytes_regex(r"\((?:[^()\\]|\\.)*\)");
    re.captures_iter(bytes)
        .map(|c| {
            let m = c.get(0).unwrap().as_bytes();
            if m.len() >= 2 {
                m[1..m.len() - 1].to_vec()
            } else {
                m.to_vec()
            }
        })
        .collect()
}

fn parse_num(bytes: &[u8]) -> u32 {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0)
}

fn parse_f64(bytes: &[u8]) -> f64 {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .unwrap_or(0.0)
}

fn split_ws(bytes: &[u8]) -> Vec<&[u8]> {
    bytes.split(|b| b.is_ascii_whitespace()).filter(|s| !s.is_empty()).collect()
}

fn bytes_regex(pat: &str) -> regex::bytes::Regex {
    regex::bytes::Regex::new(pat).expect("PDF 内容模式合法")
}

/// PDF 文档 → 结构化 JSON（页/块/整页文本）。
pub fn pdf_to_json(doc: &PdfDocument) -> JsonValue {
    serde_json::json!({
        "format": "pdf",
        "page_count": doc.pages.len(),
        "pages": doc.pages.iter().map(|p| serde_json::json!({
            "index": p.index,
            "block_count": p.blocks.len(),
            "blocks": p.blocks.iter().map(|b| serde_json::json!({
                "x0": b.x0, "y0": b.y0, "x1": b.x1, "y1": b.y1, "text": b.text
            })).collect::<Vec<_>>(),
            "text": p.text
        })).collect::<Vec<_>>(),
        "text": doc.pages.iter().map(|p| p.text.clone()).collect::<Vec<_>>().join("\n\n")
    })
}

// ── XML 轻量分词（无外部依赖，fail-closed）──

enum XmlToken<'a> {
    Start(&'a str, Vec<(&'a str, &'a str)>),
    End(&'a str),
    SelfClose(&'a str, Vec<(&'a str, &'a str)>),
    Text(&'a str),
}

fn tokenize(xml: &str) -> Result<Vec<XmlToken>, DocError> {
    let bytes = xml.as_bytes();
    let mut tokens = Vec::new();
    let mut depth = 0usize;
    let mut i = 0;
    let n = bytes.len();
    while i < n {
        if bytes[i] == b'<' {
            if i + 1 < n && bytes[i + 1] == b'/' {
                let start = i + 2;
                let end = find(bytes, b'>', start)
                    .ok_or_else(|| DocError::new(DocErrorKind::Parse, "未闭合结束标签"))?;
                let name = xml[start..end].trim();
                if name.is_empty() {
                    return Err(DocError::new(DocErrorKind::Parse, "空结束标签"));
                }
                depth = depth.saturating_sub(1);
                tokens.push(XmlToken::End(name));
                i = end + 1;
            } else if i + 1 < n && (bytes[i + 1] == b'?' || bytes[i + 1] == b'!') {
                let end = find(bytes, b'>', i + 2)
                    .ok_or_else(|| DocError::new(DocErrorKind::Parse, "声明/注释未闭合"))?;
                i = end + 1;
            } else {
                let gt = find(bytes, b'>', i + 1)
                    .ok_or_else(|| DocError::new(DocErrorKind::Parse, "起始标签未闭合"))?;
                let inner = &xml[i + 1..gt];
                let self_close = inner.ends_with('/');
                let inner_body = if self_close { &inner[..inner.len() - 1] } else { inner };
                let mut parts = inner_body.splitn(2, |c| c == ' ' || c == '\t' || c == '\n' || c == '\r');
                let raw_name = parts.next().unwrap_or("").trim();
                let attr_str = parts.next().unwrap_or("");
                if raw_name.is_empty() {
                    return Err(DocError::new(DocErrorKind::Parse, "空起始标签"));
                }
                let attrs = parse_attrs(attr_str)?;
                if self_close {
                    tokens.push(XmlToken::SelfClose(raw_name, attrs));
                } else {
                    depth += 1;
                    tokens.push(XmlToken::Start(raw_name, attrs));
                }
                i = gt + 1;
            }
        } else {
            let next = find(bytes, b'<', i + 1).unwrap_or(n);
            tokens.push(XmlToken::Text(&xml[i..next]));
            i = next;
        }
    }
    if depth != 0 {
        return Err(DocError::new(DocErrorKind::Parse, "标签未闭合"));
    }
    Ok(tokens)
}

fn parse_attrs(s: &str) -> Result<Vec<(&str, &str)>, DocError> {
    let bytes = s.as_bytes();
    let mut attrs = Vec::new();
    let mut i = 0;
    let n = bytes.len();
    while i < n {
        while i < n && (bytes[i] == b' ' || bytes[i] == b'\t' || bytes[i] == b'\n' || bytes[i] == b'\r') {
            i += 1;
        }
        if i >= n {
            break;
        }
        let name_start = i;
        while i < n
            && bytes[i] != b'='
            && bytes[i] != b' '
            && bytes[i] != b'\t'
            && bytes[i] != b'\n'
            && bytes[i] != b'\r'
        {
            i += 1;
        }
        let name = &s[name_start..i];
        if name.is_empty() {
            break;
        }
        while i < n && (bytes[i] == b' ' || bytes[i] == b'\t' || bytes[i] == b'\n' || bytes[i] == b'\r') {
            i += 1;
        }
        if i >= n || bytes[i] != b'=' {
            continue;
        }
        i += 1;
        while i < n && (bytes[i] == b' ' || bytes[i] == b'\t' || bytes[i] == b'\n' || bytes[i] == b'\r') {
            i += 1;
        }
        if i >= n {
            return Err(DocError::new(DocErrorKind::Parse, "属性值缺失"));
        }
        if bytes[i] != b'"' && bytes[i] != 39 {
            return Err(DocError::new(DocErrorKind::Parse, "属性值引号缺失"));
        }
        let q = bytes[i];
        i += 1;
        let val_start = i;
        let val_end = find(bytes, q, i)
            .ok_or_else(|| DocError::new(DocErrorKind::Parse, "属性值未闭合"))?;
        let val = &s[val_start..val_end];
        attrs.push((name, val));
        i = val_end + 1;
    }
    Ok(attrs)
}

fn find(hay: &[u8], needle: u8, from: usize) -> Option<usize> {
    hay[from..]
        .iter()
        .position(|&b| b == needle)
        .map(|p| from + p)
}

fn local_name(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

fn attr_val<'a>(attrs: &[(&'a str, &'a str)], name: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(k, _)| local_name(k) == name)
        .map(|(_, v)| *v)
}

/// 精确属性值匹配（带命名空间前缀的属性，如 workbook 的 `r:id`——
/// local_name 折叠后无法与全名区分，须按原名精确匹配）。
fn attr_val_exact<'a>(attrs: &[(&'a str, &'a str)], name: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(k, _)| *k == name)
        .map(|(_, v)| *v)
}

fn xml_unescape(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '&' {
            if let Some(semi) = chars[i..].iter().position(|&c| c == ';').map(|p| i + p) {
                let ent: String = chars[i + 1..semi].iter().collect();
                let rep = if let Some(code) = ent.strip_prefix('#') {
                    let v = if code.starts_with('x') || code.starts_with('X') {
                        u32::from_str_radix(&code[1..], 16).ok()
                    } else {
                        code.parse::<u32>().ok()
                    };
                    v.and_then(char::from_u32).map(|c| c.to_string())
                        .unwrap_or_else(|| "&".to_string())
                } else {
                    match ent.as_str() {
                        "amp" => "&".to_string(),
                        "lt" => "<".to_string(),
                        "gt" => ">".to_string(),
                        "quot" => "\"".to_string(),
                        "apos" => "'".to_string(),
                        _ => "&".to_string(),
                    }
                };
                out.push_str(&rep);
                i = semi + 1;
                continue;
            }
            out.push('&');
            i += 1;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// ── docx 解析与生成 ──

/// 段落（含可选样式名，如 Heading1 / Title）。
#[derive(Debug, Clone, PartialEq)]
pub struct DocxParagraph {
    pub style: Option<String>,
    pub text: String,
}

/// 表格（二维字符串）。
#[derive(Debug, Clone, PartialEq)]
pub struct DocxTable {
    pub rows: Vec<Vec<String>>,
}

/// docx 文档（段落 + 表格，按文档序）。
#[derive(Debug, Clone, PartialEq)]
pub struct DocxDocument {
    pub paragraphs: Vec<DocxParagraph>,
    pub tables: Vec<DocxTable>,
}

/// 从 docx 压缩包解析主文档（word/document.xml）。
pub fn parse_docx_package(zip: &[u8]) -> Result<DocxDocument, DocError> {
    let xml = zip_read_entry(zip, "word/document.xml")?;
    parse_docx_document_xml(&String::from_utf8_lossy(&xml))
}

/// 解析 document.xml 文本为结构化文档（纯逻辑，可注入）。
pub fn parse_docx_document_xml(xml: &str) -> Result<DocxDocument, DocError> {
    let tokens = tokenize(xml)?;
    let mut paragraphs: Vec<DocxParagraph> = Vec::new();
    let mut tables: Vec<DocxTable> = Vec::new();
    let mut table: Option<DocxTable> = None;
    let mut row: Option<Vec<String>> = None;
    let mut cell: Option<String> = None;
    let mut para_text = String::new();
    let mut para_style: Option<String> = None;
    let mut para_open = false;
    let mut capture_text = false;
    let mut stack: Vec<String> = Vec::new();

    for tok in tokens {
        match tok {
            XmlToken::Start(name, attrs) => {
                let ln = local_name(name);
                match ln {
                    "p" => {
                        para_open = true;
                        para_text.clear();
                        para_style = None;
                    }
                    "pStyle" => {
                        para_style =
                            attr_val(&attrs, "val").map(str::to_string);
                    }
                    "t" => capture_text = true,
                    "tab" => {
                        if para_open {
                            para_text.push('\t');
                        }
                    }
                    "br" => {
                        if para_open {
                            para_text.push('\n');
                        }
                    }
                    "tbl" => table = Some(DocxTable { rows: Vec::new() }),
                    "tr" => row = Some(Vec::new()),
                    "tc" => cell = Some(String::new()),
                    _ => {}
                }
                stack.push(ln.to_string());
            }
            XmlToken::SelfClose(name, attrs) => {
                let ln = local_name(name);
                match ln {
                    "tab" => {
                        if para_open {
                            para_text.push('\t');
                        }
                    }
                    "br" => {
                        if para_open {
                            para_text.push('\n');
                        }
                    }
                    "pStyle" => {
                        para_style = attr_val(&attrs, "val").map(str::to_string);
                    }
                    _ => {}
                }
            }
            XmlToken::End(name) => {
                let ln = local_name(name);
                match ln {
                    "p" => {
                        let text = std::mem::take(&mut para_text);
                        let style = para_style.take();
                        if stack.iter().any(|s| s == "tbl") {
                            if let Some(c) = cell.as_mut() {
                                c.push_str(&text);
                                c.push('\n');
                            }
                        } else {
                            paragraphs.push(DocxParagraph { style, text });
                        }
                        para_open = false;
                    }
                    "tc" => {
                        let mut c = cell.take().unwrap_or_default();
                        if c.ends_with('\n') {
                            c.pop();
                        }
                        if let Some(r) = row.as_mut() {
                            r.push(c);
                        }
                    }
                    "tr" => {
                        if let Some(r) = row.take() {
                            if let Some(t) = table.as_mut() {
                                t.rows.push(r);
                            }
                        }
                    }
                    "tbl" => {
                        if let Some(t) = table.take() {
                            tables.push(t);
                        }
                    }
                    "t" => capture_text = false,
                    _ => {}
                }
                if let Some(top) = stack.last() {
                    if top == ln {
                        stack.pop();
                    }
                }
            }
            XmlToken::Text(t) => {
                if capture_text {
                    para_text.push_str(&xml_unescape(t));
                }
            }
        }
    }
    Ok(DocxDocument { paragraphs, tables })
}

/// docx 文档 → 结构化 JSON。
pub fn docx_to_json(doc: &DocxDocument) -> JsonValue {
    serde_json::json!({
        "format": "docx",
        "paragraph_count": doc.paragraphs.len(),
        "table_count": doc.tables.len(),
        "paragraphs": doc.paragraphs.iter().map(|p| serde_json::json!({
            "style": p.style, "text": p.text
        })).collect::<Vec<_>>(),
        "tables": doc.tables.iter().map(|t| serde_json::json!({
            "rows": t.rows
        })).collect::<Vec<_>>()
    })
}

/// 报告分节（标题可选，正文按行切分）。
#[derive(Debug, Clone)]
pub struct DocxSection {
    pub heading: Option<String>,
    pub body: String,
}

/// 表格导出规格（表头 + 行）。
#[derive(Debug, Clone)]
pub struct DocxTableSpec {
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

/// 报告规格（标题 + 分节 + 可选表格）。
#[derive(Debug, Clone)]
pub struct DocxReportSpec {
    pub title: String,
    pub sections: Vec<DocxSection>,
    pub table: Option<DocxTableSpec>,
}

/// 生成合法 docx 包字节（OOXML 结构：ContentTypes/rels/document.xml）。
pub fn build_docx_report(spec: &DocxReportSpec) -> Result<Vec<u8>, DocError> {
    let mut body = String::new();
    body.push_str(&format!(
        "<w:p><w:pPr><w:pStyle w:val=\"Title\"/></w:pPr><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
        xml_escape(&spec.title)
    ));
    for sec in &spec.sections {
        if let Some(h) = &sec.heading {
            body.push_str(&format!(
                "<w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                xml_escape(h)
            ));
        }
        for line in sec.body.split('\n') {
            body.push_str(&format!(
                "<w:p><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                xml_escape(line)
            ));
        }
    }
    if let Some(tbl) = &spec.table {
        body.push_str("<w:tbl><w:tblPr><w:tblStyle w:val=\"TableGrid\"/><w:tblW w:w=\"0\" w:type=\"auto\"/></w:tblPr><w:tblGrid>");
        let cols = tbl
            .header
            .len()
            .max(tbl.rows.iter().map(|r| r.len()).max().unwrap_or(0));
        for _ in 0..cols {
            body.push_str("<w:gridCol w:w=\"2000\"/>");
        }
        body.push_str("</w:tblGrid>");
        body.push_str("<w:tr>");
        for h in &tbl.header {
            body.push_str(&format!(
                "<w:tc><w:tcPr><w:tcW w:w=\"2000\" w:type=\"dxa\"/></w:tcPr><w:p><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p></w:tc>",
                xml_escape(h)
            ));
        }
        body.push_str("</w:tr>");
        for row in &tbl.rows {
            body.push_str("<w:tr>");
            for cell in row {
                body.push_str(&format!(
                    "<w:tc><w:tcPr><w:tcW w:w=\"2000\" w:type=\"dxa\"/></w:tcPr><w:p><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p></w:tc>",
                    xml_escape(cell)
                ));
            }
            body.push_str("</w:tr>");
        }
        body.push_str("</w:tbl>");
    }
    let document = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{body}</w:body></w:document>"
    );
    let content_types = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>";
    let root_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>";
    let doc_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>";
    let entries = vec![
        ("[Content_Types].xml".to_string(), content_types.as_bytes()),
        ("_rels/.rels".to_string(), root_rels.as_bytes()),
        ("word/document.xml".to_string(), document.as_bytes()),
        ("word/_rels/document.xml.rels".to_string(), doc_rels.as_bytes()),
    ];
    zip_store(&entries)
}

// ── xlsx 解析与生成 ──

/// 单元格数据类型。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CellKind {
    Shared,
    Inline,
    Number,
    Boolean,
    Str,
    Error,
    Empty,
}

/// 单个单元格（值 + 类型）。
#[derive(Debug, Clone, PartialEq)]
pub struct Cell {
    pub value: String,
    pub kind: CellKind,
}

/// 工作表（行 → 单元格）。
#[derive(Debug, Clone, PartialEq)]
pub struct Sheet {
    pub name: Option<String>,
    pub rows: Vec<Vec<Cell>>,
}

/// 解析共享字符串表（si → 拼接的 t 文本）。
pub fn parse_shared_strings(xml: &str) -> Vec<String> {
    let tokens = match tokenize(xml) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let mut items = Vec::new();
    let mut cur = String::new();
    let mut in_si = false;
    let mut capture = false;
    for tok in tokens {
        match tok {
            XmlToken::Start(name, _) => {
                let ln = local_name(name);
                if ln == "si" {
                    in_si = true;
                    cur.clear();
                } else if ln == "t" && in_si {
                    capture = true;
                }
            }
            XmlToken::End(name) => {
                let ln = local_name(name);
                if ln == "si" {
                    items.push(std::mem::take(&mut cur));
                    in_si = false;
                } else if ln == "t" {
                    capture = false;
                }
            }
            XmlToken::Text(t) => {
                if capture {
                    cur.push_str(&xml_unescape(t));
                }
            }
            XmlToken::SelfClose(_, _) => {}
        }
    }
    items
}

/// 解析 workbook.xml 的工作表名清单（顺序对应 sheetN.xml）。
pub fn parse_workbook_sheet_names(xml: &str) -> Vec<String> {
    parse_workbook_sheet_refs(xml)
        .into_iter()
        .map(|(name, _)| name)
        .collect()
}

/// 解析 workbook.xml 的工作表引用（文档序：name + r:id）。
///
/// FA5 基础：表名与工作表部件经 workbook 关系表（r:id → Target）
/// 关联，不依赖 sheetN 序号位置。
pub fn parse_workbook_sheet_refs(xml: &str) -> Vec<(String, String)> {
    let tokens = match tokenize(xml) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let mut refs = Vec::new();
    for tok in tokens {
        match tok {
            XmlToken::Start(name, attrs) | XmlToken::SelfClose(name, attrs) => {
                if local_name(name) == "sheet" {
                    if let Some(n) = attr_val(&attrs, "name") {
                        // r:id 为命名空间前缀属性，须精确匹配原名
                        let rid = attr_val_exact(&attrs, "r:id").unwrap_or("");
                        refs.push((n.to_string(), rid.to_string()));
                    }
                }
            }
            _ => {}
        }
    }
    refs
}

/// 解析 workbook 关系表（r:id → Target；Target 相对 xl/ 目录解析）。
fn parse_workbook_rels(xml: &str) -> HashMap<String, String> {
    let tokens = match tokenize(xml) {
        Ok(t) => t,
        Err(_) => return HashMap::new(),
    };
    let mut rels = HashMap::new();
    for tok in tokens {
        if let XmlToken::Start(name, attrs) | XmlToken::SelfClose(name, attrs) = tok {
            if let (true, Some(rid), Some(target)) = (
                local_name(name) == "Relationship",
                attr_val(&attrs, "Id"),
                attr_val(&attrs, "Target"),
            ) {
                rels.insert(rid.to_string(), target.to_string());
            }
        }
    }
    rels
}

/// workbook 关系 Target → 包内部件名（"worksheets/sheet1.xml" 相对
/// xl/ 目录解析为 "xl/worksheets/sheet1.xml"；绝对形态原样保留）。
fn normalize_workbook_target(target: &str) -> String {
    let target = target.trim_start_matches('/');
    if target.starts_with("xl/") {
        target.to_string()
    } else {
        format!("xl/{target}")
    }
}

/// 解析单个工作表 XML（shared 用于解共享字符串引用）。
pub fn parse_sheet_xml(xml: &str, shared: &[String]) -> Result<Sheet, DocError> {
    let tokens = tokenize(xml)?;
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    let mut cur_row: Option<Vec<Cell>> = None;
    let mut cur_cell: Option<Cell> = None;
    let mut cur_value = String::new();
    let mut cur_col: usize = 0;
    let mut max_col = 0;
    let mut capture = Cap::None;
    let mut capture_inline = false;
    let mut stack: Vec<String> = Vec::new();

    for tok in tokens {
        match tok {
            XmlToken::Start(name, attrs) => {
                let ln = local_name(name);
                match ln {
                    "row" => cur_row = Some(Vec::new()),
                    "c" => {
                        let r = attr_val(&attrs, "r").unwrap_or("");
                        let t = attr_val(&attrs, "t").unwrap_or("");
                        let col = col_index(r).max(1);
                        let kind = match t {
                            "s" => CellKind::Shared,
                            "inlineStr" => CellKind::Inline,
                            "b" => CellKind::Boolean,
                            "str" => CellKind::Str,
                            "e" => CellKind::Error,
                            "" => CellKind::Number,
                            _ => CellKind::Empty,
                        };
                        cur_cell = Some(Cell {
                            value: String::new(),
                            kind,
                        });
                        cur_col = col;
                        capture = Cap::None;
                    }
                    "v" => capture = Cap::Value,
                    "is" => capture = Cap::Inline,
                    "t" => {
                        if capture == Cap::Inline {
                            capture_inline = true;
                        }
                    }
                    _ => {}
                }
                stack.push(ln.to_string());
            }
            XmlToken::End(name) => {
                let ln = local_name(name);
                match ln {
                    "v" => {
                        if let Some(c) = cur_cell.as_mut() {
                            c.value = std::mem::take(&mut cur_value);
                        }
                        capture = Cap::None;
                    }
                    "is" => capture = Cap::None,
                    "t" => capture_inline = false,
                    "c" => {
                        if let Some(mut c) = cur_cell.take() {
                            if c.kind == CellKind::Shared {
                                let idx = c.value.trim().parse::<usize>().unwrap_or(usize::MAX);
                                c.value = shared.get(idx).cloned().unwrap_or_default();
                            }
                            if c.kind == CellKind::Number && c.value.trim().is_empty() {
                                c.kind = CellKind::Empty;
                            }
                            if let Some(row) = cur_row.as_mut() {
                                while row.len() < cur_col - 1 {
                                    row.push(Cell {
                                        value: String::new(),
                                        kind: CellKind::Empty,
                                    });
                                }
                                row.push(c);
                                if row.len() > max_col {
                                    max_col = row.len();
                                }
                            }
                        }
                        capture = Cap::None;
                    }
                    "row" => {
                        if let Some(mut r) = cur_row.take() {
                            while r.len() < max_col {
                                r.push(Cell {
                                    value: String::new(),
                                    kind: CellKind::Empty,
                                });
                            }
                            rows.push(r);
                        }
                    }
                    _ => {}
                }
                if let Some(top) = stack.last() {
                    if top == ln {
                        stack.pop();
                    }
                }
            }
            XmlToken::Text(t) => {
                if capture == Cap::Value {
                    cur_value.push_str(&xml_unescape(t));
                } else if capture == Cap::Inline && capture_inline {
                    if let Some(c) = cur_cell.as_mut() {
                        c.value.push_str(&xml_unescape(t));
                    }
                }
            }
            XmlToken::SelfClose(_, _) => {}
        }
    }
    Ok(Sheet { name: None, rows })
}

/// 从 xlsx 压缩包解析全部工作表。
///
/// FA5：表名经 workbook.xml（name + r:id）→ workbook.xml.rels
/// （r:id → Target）映射取用，不再按 sheetN 序号位置取——自定义
/// 命名/跳号时表名与内容不错配。workbook 声明缺失时回退为按
/// sheetN 顺序枚举（上限 [`MAX_SHEET_ENTRIES`] 防御性兜底）。
pub fn parse_xlsx_package(zip: &[u8]) -> Result<Vec<Sheet>, DocError> {
    let shared = match zip_read_entry(zip, "xl/sharedStrings.xml") {
        Ok(b) => parse_shared_strings(&String::from_utf8_lossy(&b)),
        Err(_) => Vec::new(),
    };
    let refs = match zip_read_entry(zip, "xl/workbook.xml") {
        Ok(b) => parse_workbook_sheet_refs(&String::from_utf8_lossy(&b)),
        Err(_) => Vec::new(),
    };
    let rels = match zip_read_entry(zip, "xl/_rels/workbook.xml.rels") {
        Ok(b) => parse_workbook_rels(&String::from_utf8_lossy(&b)),
        Err(_) => HashMap::new(),
    };
    let mut sheets = Vec::new();
    for (name, rid) in &refs {
        let target = rels.get(rid).cloned().unwrap_or_default();
        let entry = if target.is_empty() {
            // rels 缺失：按声明序回退 sheetN（与旧行为一致的兜底）
            format!("xl/worksheets/sheet{}.xml", sheets.len() + 1)
        } else {
            normalize_workbook_target(&target)
        };
        match zip_read_entry(zip, &entry) {
            Ok(b) => {
                let mut s = parse_sheet_xml(&String::from_utf8_lossy(&b), &shared)?;
                s.name = Some(name.clone());
                sheets.push(s);
            }
            Err(_) => break,
        }
    }
    if sheets.is_empty() {
        for n in 1..=MAX_SHEET_ENTRIES {
            let entry = format!("xl/worksheets/sheet{n}.xml");
            match zip_read_entry(zip, &entry) {
                Ok(b) => {
                    let mut s = parse_sheet_xml(&String::from_utf8_lossy(&b), &shared)?;
                    s.name = None;
                    sheets.push(s);
                }
                Err(_) => break,
            }
        }
    }
    if sheets.is_empty() {
        return Err(DocError::new(DocErrorKind::NotOffice, "xlsx 无工作表"));
    }
    Ok(sheets)
}

/// 工作表集合 → 结构化 JSON。
pub fn xlsx_to_json(sheets: &[Sheet]) -> JsonValue {
    serde_json::json!({
        "format": "xlsx",
        "sheet_count": sheets.len(),
        "sheets": sheets.iter().map(|s| serde_json::json!({
            "name": s.name,
            "row_count": s.rows.len(),
            "rows": s.rows.iter().map(|r| r.iter().map(|c| serde_json::json!({
                "value": c.value, "kind": format!("{:?}", c.kind)
            })).collect::<Vec<_>>()).collect::<Vec<_>>()
        })).collect::<Vec<_>>()
    })
}

/// 列引用（如 "A1"）→ 1 基列号。
fn col_index(reference: &str) -> usize {
    let letters: String = reference.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    col_letter_to_index(&letters)
}

fn col_letter_to_index(s: &str) -> usize {
    let mut idx = 0;
    for c in s.chars() {
        idx = idx * 26 + (c.to_ascii_uppercase() as u8 - b'A' as u8 + 1) as usize;
    }
    idx
}

fn col_letter(n: usize) -> String {
    let mut s = String::new();
    let mut n = n;
    while n > 0 {
        let rem = (n - 1) % 26;
        s.insert(0, (b'A' + rem as u8) as char);
        n = (n - 1) / 26;
    }
    s
}

/// 生成合法 xlsx 包字节（OOXML 结构：workbook/worksheet/rels）。
pub fn build_xlsx_table(sheet_name: &str, rows: &[Vec<String>]) -> Result<Vec<u8>, DocError> {
    let mut sheet = String::new();
    sheet.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>");
    for (ri, row) in rows.iter().enumerate() {
        let r = ri + 1;
        sheet.push_str(&format!("<row r=\"{r}\">"));
        for (ci, val) in row.iter().enumerate() {
            let c = col_letter(ci + 1);
            sheet.push_str(&format!(
                "<c r=\"{c}{r}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
                xml_escape(val)
            ));
        }
        sheet.push_str("</row>");
    }
    sheet.push_str("</sheetData></worksheet>");

    let workbook = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"{}\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>", xml_escape(sheet_name));
    let wb_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>";
    let content_types = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/></Types>";
    let root_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>";

    let entries = vec![
        ("[Content_Types].xml".to_string(), content_types.as_bytes()),
        ("_rels/.rels".to_string(), root_rels.as_bytes()),
        ("xl/workbook.xml".to_string(), workbook.as_bytes()),
        ("xl/_rels/workbook.xml.rels".to_string(), wb_rels.as_bytes()),
        ("xl/worksheets/sheet1.xml".to_string(), sheet.as_bytes()),
    ];
    zip_store(&entries)
}

// ── pptx 解析 ──

/// 幻灯片形状（命名可选，含若干段落文本）。
#[derive(Debug, Clone, PartialEq)]
pub struct PptxShape {
    pub name: Option<String>,
    pub paragraphs: Vec<String>,
}

/// 单张幻灯片（若干形状）。
#[derive(Debug, Clone, PartialEq)]
pub struct PptxSlide {
    pub shapes: Vec<PptxShape>,
}

/// pptx 文档（多张幻灯片）。
#[derive(Debug, Clone, PartialEq)]
pub struct PptxDocument {
    pub slides: Vec<PptxSlide>,
}

/// 解析单张幻灯片 XML 文本。
pub fn parse_slide_xml(xml: &str) -> Result<PptxSlide, DocError> {
    let tokens = tokenize(xml)?;
    let mut shapes: Vec<PptxShape> = Vec::new();
    let mut current: Option<PptxShape> = None;
    let mut para_text = String::new();
    let mut para_open = false;
    let mut capture = false;
    let mut stack: Vec<String> = Vec::new();

    for tok in tokens {
        match tok {
            XmlToken::Start(name, attrs) => {
                let ln = local_name(name);
                match ln {
                    "sp" | "graphicFrame" => {
                        current = Some(PptxShape {
                            name: None,
                            paragraphs: Vec::new(),
                        });
                    }
                    "cNvPr" => {
                        let n = attr_val(&attrs, "name").map(str::to_string);
                        if let Some(c) = current.as_mut() {
                            c.name = n;
                        }
                    }
                    "p" => {
                        para_open = true;
                        para_text.clear();
                    }
                    "t" => capture = true,
                    _ => {}
                }
                stack.push(ln.to_string());
            }
            XmlToken::SelfClose(name, attrs) => {
                if local_name(name) == "cNvPr" {
                    let n = attr_val(&attrs, "name").map(str::to_string);
                    if let Some(c) = current.as_mut() {
                        c.name = n;
                    }
                }
            }
            XmlToken::End(name) => {
                let ln = local_name(name);
                match ln {
                    "p" => {
                        let text = std::mem::take(&mut para_text);
                        if let Some(c) = current.as_mut() {
                            c.paragraphs.push(text);
                        } else {
                            shapes.push(PptxShape {
                                name: None,
                                paragraphs: vec![text],
                            });
                        }
                        para_open = false;
                    }
                    "t" => capture = false,
                    "sp" | "graphicFrame" => {
                        if let Some(c) = current.take() {
                            shapes.push(c);
                        }
                    }
                    _ => {}
                }
                if let Some(top) = stack.last() {
                    if top == ln {
                        stack.pop();
                    }
                }
            }
            XmlToken::Text(t) => {
                if capture && para_open {
                    para_text.push_str(&xml_unescape(t));
                }
            }
        }
    }
    Ok(PptxSlide { shapes })
}

/// 从 pptx 压缩包解析全部幻灯片。
///
/// 按压缩包声明条目遍历（slideN.xml 数字序），不依赖魔数上限——
/// 超 256 张幻灯片不再静默丢弃。
pub fn parse_pptx_package(zip: &[u8]) -> Result<PptxDocument, DocError> {
    let entries = zip_list_entries(zip)?;
    let mut nums: Vec<usize> = entries
        .iter()
        .filter_map(|e| {
            let rest = e.name.strip_prefix("ppt/slides/slide")?;
            rest.strip_suffix(".xml")?.parse::<usize>().ok()
        })
        .collect();
    nums.sort_unstable();
    let mut slides = Vec::new();
    for n in nums {
        let entry = format!("ppt/slides/slide{n}.xml");
        match zip_read_entry(zip, &entry) {
            Ok(b) => slides.push(parse_slide_xml(&String::from_utf8_lossy(&b))?),
            Err(_) => break,
        }
    }
    if slides.is_empty() {
        return Err(DocError::new(DocErrorKind::NotOffice, "pptx 无幻灯片"));
    }
    Ok(PptxDocument { slides })
}

/// pptx 文档 → 结构化 JSON。
pub fn pptx_to_json(doc: &PptxDocument) -> JsonValue {
    serde_json::json!({
        "format": "pptx",
        "slide_count": doc.slides.len(),
        "slides": doc.slides.iter().map(|s| serde_json::json!({
            "shape_count": s.shapes.len(),
            "text": s.shapes.iter().flat_map(|sp| sp.paragraphs.iter().cloned()).collect::<Vec<_>>()
        })).collect::<Vec<_>>()
    })
}

/// 一键解析：识别格式后分发到对应解析器，输出结构化 JSON。
pub fn parse_document(bytes: &[u8]) -> Result<JsonValue, DocError> {
    let result = match detect_format(bytes) {
        DocFormat::Pdf => Ok(pdf_to_json(&parse_pdf(bytes)?)),
        DocFormat::Docx => Ok(docx_to_json(&parse_docx_package(bytes)?)),
        DocFormat::Xlsx => Ok(xlsx_to_json(&parse_xlsx_package(bytes)?)),
        DocFormat::Pptx => Ok(pptx_to_json(&parse_pptx_package(bytes)?)),
        DocFormat::Unknown => Err(DocError::new(
            DocErrorKind::UnsupportedFormat,
            "无法识别的文档格式",
        )),
    };
    match &result {
        Ok(json) => eprintln!(
            "[doc_ops] parse ok format={}",
            json.get("format")
                .and_then(JsonValue::as_str)
                .unwrap_or("?")
        ),
        Err(err) => eprintln!(
            "[doc_ops] parse_failed kind={:?} err={}",
            err.kind, err.message
        ),
    }
    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cap {
    None,
    Value,
    Inline,
}

#[cfg(test)]
mod tests {
    use super::*;

    // 合成 PDF 构造器：use_flate 时内容流经 Zlib 压缩。
    fn make_pdf(use_flate: bool) -> Vec<u8> {
        let content = b"BT\n1 0 0 1 50 750 Tm\n(First line of text) Tj\n0 -20 Td\n(Second line) Tj\nET";
        let (dict, payload): (String, Vec<u8>) = if use_flate {
            use flate2::write::ZlibEncoder;
            use flate2::Compression;
            use std::io::Write;
            let mut e = ZlibEncoder::new(Vec::new(), Compression::default());
            e.write_all(content).unwrap();
            let comp = e.finish().unwrap();
            (
                format!("/Filter /FlateDecode /Length {}", comp.len()),
                comp,
            )
        } else {
            (format!("/Length {}", content.len()), content.to_vec())
        };
        let mut pdf = Vec::new();
        pdf.extend_from_slice(b"%PDF-1.4\n");
        pdf.extend_from_slice(b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n");
        pdf.extend_from_slice(b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n");
        pdf.extend_from_slice(
            b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R>>endobj\n",
        );
        pdf.extend_from_slice(b"4 0 obj<<");
        pdf.extend_from_slice(dict.as_bytes());
        pdf.extend_from_slice(b">>stream\n");
        pdf.extend_from_slice(&payload);
        pdf.extend_from_slice(b"\nendstream endobj\n");
        pdf.extend_from_slice(b"xref\n0 5\n0000000000 65535 f \n");
        pdf.extend_from_slice(b"trailer<</Root 1 0 R>>\nstartxref\n0\n%%EOF\n");
        pdf
    }

    // 合成存储型 zip 构造器（供格式识别与解包测试）。
    fn make_zip(entry: &str) -> Vec<u8> {
        zip_store(&[(
            entry.to_string(),
            b"<root>payload</root>" as &[u8],
        )])
        .unwrap()
    }

    #[test]
    fn magic_detects_pdf() {
        let pdf = make_pdf(false);
        assert_eq!(detect_format(&pdf), DocFormat::Pdf);
        assert_eq!(detect_format(b""), DocFormat::Unknown);
        assert_eq!(detect_format(b"not a doc"), DocFormat::Unknown);
        assert_eq!(detect_format(b"%PDF-"), DocFormat::Pdf);
    }

    #[test]
    fn magic_distinguishes_ooxml_subtypes() {
        assert_eq!(detect_format(&make_zip("word/document.xml")), DocFormat::Docx);
        assert_eq!(detect_format(&make_zip("xl/worksheets/sheet1.xml")), DocFormat::Xlsx);
        assert_eq!(detect_format(&make_zip("ppt/slides/slide1.xml")), DocFormat::Pptx);
        assert_eq!(detect_format(&make_zip("unknown/file.txt")), DocFormat::Unknown);
    }

    #[test]
    fn zip_reader_round_trips_stored_entries() {
        let zip = zip_store(&[
            ("a.txt".to_string(), b"alpha" as &[u8]),
            ("b.txt".to_string(), b"beta" as &[u8]),
        ])
        .unwrap();
        let entries = zip_list_entries(&zip).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(zip_read_entry(&zip, "a.txt").unwrap(), b"alpha");
        assert_eq!(zip_read_entry(&zip, "b.txt").unwrap(), b"beta");
        assert!(zip_read_entry(&zip, "missing").is_err());
    }

    #[test]
    fn zip_missing_entry_kind_is_not_found() {
        // FA4：zip_read_entry 缺条目 = NotFound 分型（区别于
        // BadZip/NotOffice——包结构合法但缺件，按缺件语义处理）
        let zip = make_zip("word/document.xml");
        let err = zip_read_entry(&zip, "xl/workbook.xml").unwrap_err();
        assert_eq!(err.kind, DocErrorKind::NotFound);
        assert!(err.message.contains("xl/workbook.xml"));
    }

    #[test]
    fn zip_reader_fails_closed_on_truncation() {
        let mut zip = zip_store(&[("a.txt".to_string(), b"alpha" as &[u8])]).unwrap();
        zip.truncate(zip.len() - 5);
        assert!(zip_list_entries(&zip).is_err());
        assert!(zip_read_entry(&zip, "a.txt").is_err());
        assert!(zip_store(&[]).is_ok());
    }

    #[test]
    fn pdf_extracts_pages_blocks_and_lines() {
        let pdf = make_pdf(false);
        let doc = parse_pdf(&pdf).expect("PDF 解析成功");
        assert_eq!(doc.pages.len(), 1);
        let page = &doc.pages[0];
        let text = page.text.clone();
        assert!(text.contains("First line of text"));
        assert!(text.contains("Second line"));
        assert!(!page.blocks.is_empty());
        let json = pdf_to_json(&doc);
        assert_eq!(json["format"], "pdf");
        assert_eq!(json["page_count"], 1);
        assert!(json["pages"][0]["block_count"].as_u64().unwrap() >= 1);
    }

    #[test]
    fn pdf_extracts_flate_stream_via_flate2() {
        let pdf = make_pdf(true);
        let doc = parse_pdf(&pdf).expect("flate PDF 解析成功");
        let text = doc.pages[0].text.clone();
        assert!(text.contains("First line of text"));
        assert!(text.contains("Second line"));
    }

    #[test]
    fn pdf_stream_keyword_inside_literal_not_mis_split() {
        // FA8：dict 字符串体内的 "stream"/"endobj" 字面量不得干扰流
        // 边界定位（字面量状态跟踪；旧实现正则/朴素搜索会错割）
        let content = b"BT (hello stream world) Tj ET";
        let mut pdf = Vec::new();
        pdf.extend_from_slice(b"%PDF-1.4\n");
        pdf.extend_from_slice(
            b"1 0 obj<< /Type /Page /MediaBox [0 0 595 842] /Contents 2 0 R >>endobj\n",
        );
        pdf.extend_from_slice(
            format!(
                "2 0 obj<< /Title (a stream note endobj here) /Length {} >>stream\n",
                content.len()
            )
            .as_bytes(),
        );
        pdf.extend_from_slice(content);
        pdf.extend_from_slice(b"\nendstream endobj\n%%EOF\n");
        let doc = parse_pdf(&pdf).expect("字面量含 stream 字样也应正确解析");
        let text = doc.pages[0].text.clone();
        assert!(
            text.contains("hello stream world"),
            "内容流文本应完整（未被字面量错割）: {text}"
        );
    }

    #[test]
    fn pdf_bad_stream_boundary_fails_closed() {
        // FA8 fail-closed：/Length 与 endstream 位置不闭合 = 边界不可信，
        // 不得静默截断（错割内容）；该页内容流为空也不产出错误文本
        let content = b"BT (ghost) Tj ET";
        let mut pdf = Vec::new();
        pdf.extend_from_slice(b"%PDF-1.4\n");
        pdf.extend_from_slice(
            b"1 0 obj<< /Type /Page /MediaBox [0 0 595 842] /Contents 2 0 R >>endobj\n",
        );
        pdf.extend_from_slice(
            format!(
                "2 0 obj<< /Title (stream) /Length {} >>stream\n",
                content.len() + 99
            )
            .as_bytes(),
        );
        pdf.extend_from_slice(content);
        pdf.extend_from_slice(b"\nendstream endobj\n%%EOF\n");
        let doc = parse_pdf(&pdf).expect("坏流边界对象被跳过，不击穿整包解析");
        assert!(!doc.pages[0].text.contains("ghost"), "错割内容不得进入文本");
    }

    #[test]
    fn pdf_fail_closed_on_garbage_and_empty() {
        assert!(parse_pdf(b"").is_err());
        assert!(parse_pdf(b"PK\x03\x04 garbage").is_err());
        assert!(parse_pdf(b"%PDF-1.4\nno objects here").is_err());
    }

    #[test]
    fn docx_parse_paragraphs_tables_and_styles() {
        let xml = r#"<w:document xmlns:w="x"><w:body>
            <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Title Text</w:t></w:r></w:p>
            <w:p><w:r><w:t>Plain paragraph</w:t></w:r></w:p>
            <w:p><w:r><w:t>With </w:t><w:tab/><w:t>tab</w:t></w:r></w:p>
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>H1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>H2</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>R1C1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>R1C2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        </w:body></w:document>"#;
        let doc = parse_docx_document_xml(xml).expect("docx 解析成功");
        assert_eq!(doc.paragraphs.len(), 3);
        assert_eq!(doc.paragraphs[0].style.as_deref(), Some("Title"));
        assert_eq!(doc.paragraphs[0].text, "Title Text");
        assert!(doc.paragraphs[2].text.contains('\t'));
        assert_eq!(doc.tables.len(), 1);
        assert_eq!(doc.tables[0].rows.len(), 2);
        assert_eq!(doc.tables[0].rows[1][0], "R1C1");
        assert_eq!(doc.tables[0].rows[1][1], "R1C2");
    }

    #[test]
    fn docx_parse_xml_unescape_and_fail_closed() {
        let xml = r#"<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>a &lt;b&gt; &amp; c</w:t></w:r></w:p></w:body></w:document>"#;
        let doc = parse_docx_document_xml(xml).unwrap();
        assert_eq!(doc.paragraphs[0].text, "a <b> & c");
        assert!(parse_docx_document_xml("<w:p>").is_err());
        assert!(parse_docx_document_xml("<w:p><w:r>").is_err());
    }

    #[test]
    fn docx_generate_reports_legal_ooxml_and_round_trips() {
        let spec = DocxReportSpec {
            title: "季度纪要".to_string(),
            sections: vec![
                DocxSection {
                    heading: Some("摘要".to_string()),
                    body: "第一行\n第二行".to_string(),
                },
                DocxSection {
                    heading: None,
                    body: "无标题段落".to_string(),
                },
            ],
            table: Some(DocxTableSpec {
                header: vec!["指标".to_string(), "值".to_string()],
                rows: vec![vec!["A".to_string(), "1".to_string()]],
            }),
        };
        let pkg = build_docx_report(&spec).expect("docx 生成成功");
        let entries = zip_list_entries(&pkg).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"[Content_Types].xml"));
        assert!(names.contains(&"_rels/.rels"));
        assert!(names.contains(&"word/document.xml"));
        let doc_xml = String::from_utf8(zip_read_entry(&pkg, "word/document.xml").unwrap()).unwrap();
        assert!(doc_xml.starts_with("<?xml"));
        assert!(doc_xml.contains("<w:document"));
        assert!(doc_xml.contains("<w:tbl"));
        assert!(doc_xml.contains("季度纪要"));
        let doc = parse_docx_document_xml(&doc_xml).unwrap();
        assert!(doc.paragraphs.iter().any(|p| p.text == "季度纪要"));
        assert!(doc.tables.iter().any(|t| {
            t.rows.iter().any(|r| r.iter().any(|c| c == "A"))
        }));
    }

    #[test]
    fn xlsx_parse_shared_strings_and_inline() {
        let shared = r#"<sst xmlns="x"><si><t>Apple</t></si><si><t>Banana</t></si></sst>"#;
        let ss = parse_shared_strings(shared);
        assert_eq!(ss, vec!["Apple", "Banana"]);
        let sheet = r#"<worksheet xmlns="x"><sheetData>
            <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
            <row r="2"><c r="A2" t="inlineStr"><is><t>7</t></is></c><c r="B2"><v>3.5</v></c></row>
        </sheetData></worksheet>"#;
        let sh = parse_sheet_xml(sheet, &ss).unwrap();
        assert_eq!(sh.rows[0][0].value, "Apple");
        assert_eq!(sh.rows[0][1].value, "Banana");
        assert_eq!(sh.rows[1][0].value, "7");
        assert_eq!(sh.rows[1][1].value, "3.5");
        assert_eq!(sh.rows[1][1].kind, CellKind::Number);
        assert_eq!(sh.rows[1][0].kind, CellKind::Inline);
    }

    #[test]
    fn xlsx_parse_sparse_rows_pad_to_max_column() {
        let sheet = r#"<worksheet xmlns="x"><sheetData>
            <row r="2"><c r="C2"><v>9</v></c></row>
        </sheetData></worksheet>"#;
        let sh = parse_sheet_xml(sheet, &[]).unwrap();
        assert_eq!(sh.rows.len(), 1);
        assert_eq!(sh.rows[0].len(), 3);
        assert_eq!(sh.rows[0][2].value, "9");
        assert_eq!(sh.rows[0][2].kind, CellKind::Number);
    }

    #[test]
    fn xlsx_generate_exports_and_round_trips() {
        let rows = vec![
            vec!["名称".to_string(), "数量".to_string()],
            vec!["甲".to_string(), "2".to_string()],
        ];
        let pkg = build_xlsx_table("数据表", &rows).expect("xlsx 生成成功");
        let entries = zip_list_entries(&pkg).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"xl/worksheets/sheet1.xml"));
        assert!(names.contains(&"[Content_Types].xml"));
        let sheets = parse_xlsx_package(&pkg).unwrap();
        assert_eq!(sheets.len(), 1);
        assert_eq!(sheets[0].name.as_deref(), Some("数据表"));
        assert_eq!(sheets[0].rows[1][0].value, "甲");
        assert_eq!(sheets[0].rows[0][1].value, "数量");
    }

    #[test]
    fn xlsx_parse_workbook_sheet_names() {
        let wb = r#"<workbook xmlns="x" xmlns:r="y"><sheets><sheet name="面板" sheetId="1" r:id="rId1"/><sheet name="明细" sheetId="2" r:id="rId2"/></sheets></workbook>"#;
        let names = parse_workbook_sheet_names(wb);
        assert_eq!(names, vec!["面板", "明细"]);
    }

    #[test]
    fn xlsx_sheet_names_map_by_rels_not_position() {
        // FA5：表名经 r:id → rels Target 映射——rId 顺序与 sheetN 序号
        // 错位时按位置取名会错配（旧实现 names.get(n-1)），rels 映射
        // 必须按声明序给出正确表名与内容配对
        let wb = r#"<workbook xmlns="x" xmlns:r="y"><sheets><sheet name="面板" sheetId="2" r:id="rId2"/><sheet name="明细" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
        let rels = r#"<Relationships xmlns="x"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>"#;
        let sheet1 = r#"<worksheet xmlns="x"><sheetData><row r="1"><c r="A1"><v>明细行</v></c></row></sheetData></worksheet>"#;
        let sheet2 = r#"<worksheet xmlns="x"><sheetData><row r="1"><c r="A1"><v>面板行</v></c></row></sheetData></worksheet>"#;
        let zip = zip_store(&[
            ("xl/workbook.xml".to_string(), wb.as_bytes()),
            ("xl/_rels/workbook.xml.rels".to_string(), rels.as_bytes()),
            ("xl/worksheets/sheet1.xml".to_string(), sheet1.as_bytes()),
            ("xl/worksheets/sheet2.xml".to_string(), sheet2.as_bytes()),
        ])
        .unwrap();
        let sheets = parse_xlsx_package(&zip).expect("rels 映射解析成功");
        assert_eq!(sheets.len(), 2);
        assert_eq!(sheets[0].name.as_deref(), Some("面板"));
        assert_eq!(sheets[0].rows[0][0].value, "面板行");
        assert_eq!(sheets[1].name.as_deref(), Some("明细"));
        assert_eq!(sheets[1].rows[0][0].value, "明细行");
    }

    #[test]
    fn xlsx_parses_more_than_256_declared_sheets() {
        // FA11：工作表数量按声明条目遍历，不再受 256 魔数上限约束
        let count = 260usize;
        let parts: Vec<(String, String)> = (1..=count)
            .map(|n| {
                (
                    format!("xl/worksheets/sheet{n}.xml"),
                    format!(r#"<worksheet xmlns="x"><sheetData><row r="1"><c r="A1"><v>s{n}</v></c></row></sheetData></worksheet>"#),
                )
            })
            .collect();
        let sheets_decl: String = (1..=count)
            .map(|n| format!(r#"<sheet name="表{n}" sheetId="{n}" r:id="rId{n}"/>"#))
            .collect();
        let wb = format!(r#"<workbook xmlns="x" xmlns:r="y"><sheets>{sheets_decl}</sheets></workbook>"#);
        let rels_decl: String = (1..=count)
            .map(|n| format!(r#"<Relationship Id="rId{n}" Target="worksheets/sheet{n}.xml"/>"#))
            .collect();
        let rels = format!(r#"<Relationships xmlns="x">{rels_decl}</Relationships>"#);
        let mut entries: Vec<(String, &[u8])> = vec![
            ("xl/workbook.xml".to_string(), wb.as_bytes()),
            ("xl/_rels/workbook.xml.rels".to_string(), rels.as_bytes()),
        ];
        entries.extend(
            parts
                .iter()
                .map(|(name, xml)| (name.clone(), xml.as_bytes())),
        );
        let zip = zip_store(&entries).unwrap();
        let sheets = parse_xlsx_package(&zip).expect("超 256 工作表解析成功");
        assert_eq!(sheets.len(), count);
        assert_eq!(sheets[count - 1].name.as_deref(), Some(format!("表{count}").as_str()));
        assert_eq!(sheets[count - 1].rows[0][0].value, format!("s{count}"));
    }

    #[test]
    fn pptx_parses_more_than_256_slides() {
        // FA11：幻灯片按声明条目遍历，不再受 256 魔数上限约束
        let count = 260usize;
        let parts: Vec<(String, String)> = (1..=count)
            .map(|n| {
                (
                    format!("ppt/slides/slide{n}.xml"),
                    format!(
                        r#"<p:sld xmlns:p="p" xmlns:a="a"><p:sp><p:txBody><a:p><a:t>S{n}</a:t></a:p></p:txBody></p:sp></p:sld>"#
                    ),
                )
            })
            .collect();
        let entries: Vec<(String, &[u8])> = parts
            .iter()
            .map(|(name, xml)| (name.clone(), xml.as_bytes()))
            .collect();
        let zip = zip_store(&entries).unwrap();
        let doc = parse_pptx_package(&zip).expect("超 256 幻灯片解析成功");
        assert_eq!(doc.slides.len(), count);
        let last = &doc.slides[count - 1];
        assert_eq!(last.shapes[0].paragraphs, vec![format!("S{count}")]);
    }

    #[test]
    fn pptx_parse_extracts_shape_text() {
        let xml = r#"<p:sld xmlns:p="p" xmlns:a="a"><p:sp><p:nvSpPr><p:cNvPr name="标题 1"/></p:nvSpPr><p:txBody><a:p><a:t>封面标题</a:t></a:p></p:txBody></p:sp>
            <p:sp><p:txBody><a:p><a:t>要点一</a:t></a:p><a:p><a:t>要点二</a:t></a:p></p:txBody></p:sp>
        </p:sld>"#;
        let slide = parse_slide_xml(xml).unwrap();
        assert_eq!(slide.shapes.len(), 2);
        assert_eq!(slide.shapes[0].name.as_deref(), Some("标题 1"));
        assert_eq!(slide.shapes[0].paragraphs, vec!["封面标题"]);
        assert_eq!(slide.shapes[1].paragraphs, vec!["要点一", "要点二"]);
    }

    #[test]
    fn package_parse_fail_closed_on_missing_parts() {
        let zip = make_zip("word/document.xml");
        assert!(parse_xlsx_package(&zip).is_err());
        let docx = make_zip("xl/worksheets/sheet1.xml");
        assert!(parse_docx_package(&docx).is_err());
        let empty = zip_store(&[]).unwrap();
        assert!(parse_pptx_package(&empty).is_err());
    }

    #[test]
    fn parse_document_dispatch_by_magic() {
        let pdf = make_pdf(false);
        let j = parse_document(&pdf).unwrap();
        assert_eq!(j["format"], "pdf");

        let slide_zip = zip_store(&[(
            "ppt/slides/slide1.xml".to_string(),
            b"<p:sld xmlns:p=\"p\" xmlns:a=\"a\"><p:sp><p:txBody><a:p><a:t>Hi</a:t></a:p></p:txBody></p:sp></p:sld>" as &[u8],
        )])
        .unwrap();
        let j = parse_document(&slide_zip).unwrap();
        assert_eq!(j["format"], "pptx");

        assert!(parse_document(b"???").is_err());
    }
}
