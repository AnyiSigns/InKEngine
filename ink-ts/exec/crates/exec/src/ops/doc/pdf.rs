//! PDF 文本提取（魔数识别 + 内容流文本算子扫描）。
//!
//! 语义参照旧壳 doc_ops.rs 的 PDF 层：`%PDF-` 魔数前 1024 字节扫描；
//! 对象切片零拷贝收集（`/Length` 推算流尾并逐字核对 `endstream`，边界
//! 不可信 fail-closed 宁丢不错割）；`/Filter /FlateDecode` 内容流经
//! flate2 解压；文本算子 Tm/Td/TD/Tj/'/"/TJ 定位，按 y 行聚类输出文本行。
//! 本实现只产出整页文本行（doc.parse 消费面），不保留版面几何骨架。

use std::collections::HashMap;

use regex::bytes::Regex as BytesRegex;

/// 扫描窗口（前 1024 字节找魔数，容忍少量前导字节）。
const HEADER_SCAN_BYTES: usize = 1024;
/// 文本行合并容差（y 坐标差 < 1.0 视为同一行）。
const LINE_Y_TOLERANCE: f64 = 1.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PdfErrorKind {
    NotPdf,
    Parse,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfError {
    pub kind: PdfErrorKind,
    pub message: String,
}

impl PdfError {
    fn new(kind: PdfErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

/// PDF 解析产物（页数 + 每页文本行）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfDoc {
    pub page_count: usize,
    pub pages: Vec<String>,
}

/// 魔数探测：输入为空或前 1024 字节内无 `%PDF-` = 非 PDF。
pub fn has_pdf_header(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    let end = bytes.len().min(HEADER_SCAN_BYTES);
    bytes[..end].windows(5).any(|w| w == b"%PDF-")
}

/// 收集对象（对象头正则 + 字面量状态跟踪的边界抽取）。
fn collect_objects(bytes: &[u8]) -> Vec<(u32, &[u8])> {
    let obj_re = bytes_regex(r"(?s)(\d+)\s+\d+\s+obj");
    let mut starts: Vec<(u32, usize)> = Vec::new();
    for c in obj_re.captures_iter(bytes) {
        let n = parse_num(c.get(1).unwrap().as_bytes());
        let pos = c.get(0).unwrap().end();
        starts.push((n, pos));
    }
    starts
        .into_iter()
        .map(|(n, pos)| (n, extract_object_body(bytes, pos)))
        .collect()
}

/// 对象体抽取：dict + stream 全段；/Length 推算的流尾须与 endstream 逐字
/// 闭合，否则边界不可信（返回空切片，宁丢该对象不错割）。
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
/// 字典定界符与注释；命中处须以分隔符收尾（防半词前缀误匹配）。
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
            let after_ok = after >= hay.len() || is_delim(hay[after]);
            if before_ok && after_ok {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn is_delim(b: u8) -> bool {
    b.is_ascii_whitespace()
        || matches!(b, b'(' | b')' | b'<' | b'>' | b'/' | b'%' | b'{' | b'}' | b'[' | b']')
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

/// 对象内内容流（解压或原文）；边界不可信 = None。
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
    if bytes_regex(r"(?s)/Filter\s*/FlateDecode").is_match(dict) {
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

/// 单条文本定位（y 自下而上，x 同页横坐标）。
struct TextRun {
    x: f64,
    y: f64,
    text: String,
}

fn parse_pdf(bytes: &[u8]) -> Result<PdfDoc, PdfError> {
    if bytes.len() < 5 || !has_pdf_header(bytes) {
        return Err(PdfError::new(PdfErrorKind::NotPdf, "PDF 头缺失或输入过短"));
    }
    let mut obj_map: HashMap<u32, Vec<u8>> = HashMap::new();
    for (n, body) in collect_objects(bytes) {
        if !body.is_empty() {
            obj_map.insert(n, body.to_vec());
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
    order.sort_unstable();
    if order.is_empty() {
        return Err(PdfError::new(PdfErrorKind::Parse, "PDF 未解析到页对象"));
    }
    let mut pages = Vec::new();
    for n in order {
        let stream = streams
            .iter()
            .find(|(k, _)| *k == n)
            .map(|(_, s)| s.clone())
            .unwrap_or_default();
        pages.push(scan_page_lines(&stream));
    }
    Ok(PdfDoc {
        page_count: pages.len(),
        pages,
    })
}

/// 内容流 → 页面文本行（按 y 降序、x 升序聚类；y 容差内并同一行）。
fn scan_page_lines(stream: &[u8]) -> String {
    let runs = scan_content_stream(stream);
    if runs.is_empty() {
        return String::new();
    }
    let mut idx: Vec<usize> = (0..runs.len()).collect();
    idx.sort_by(|&a, &b| {
        runs[b]
            .y
            .partial_cmp(&runs[a].y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(runs[a].x.partial_cmp(&runs[b].x).unwrap_or(std::cmp::Ordering::Equal))
    });
    let mut lines: Vec<(f64, Vec<String>)> = Vec::new();
    for &i in &idx {
        let r = &runs[i];
        if let Some(last) = lines.last_mut() {
            if (last.0 - r.y).abs() < LINE_Y_TOLERANCE {
                last.1.push(r.text.clone());
                continue;
            }
        }
        lines.push((r.y, vec![r.text.clone()]));
    }
    lines
        .into_iter()
        .map(|(_, parts)| parts.join(" "))
        .collect::<Vec<_>>()
        .join("\n")
}

fn scan_content_stream(stream: &[u8]) -> Vec<TextRun> {
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
        } else if let Some(m) = c.name("td").or_else(|| c.name("td2")) {
            let p = split_ws(m.as_bytes());
            if p.len() >= 2 {
                x += parse_f64(p[0]);
                y += parse_f64(p[1]);
            }
        } else if let Some(m) = c.name("tj").or_else(|| c.name("tjq")).or_else(|| c.name("tjqq")) {
            let lit = extract_literals(m.as_bytes()).into_iter().next();
            if let Some(l) = lit {
                runs.push(TextRun {
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
                runs.push(TextRun { x, y, text });
            }
        }
    }
    runs
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
    String::from_utf8_lossy(&out).into_owned()
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
    bytes
        .split(|b| b.is_ascii_whitespace())
        .filter(|s| !s.is_empty())
        .collect()
}

fn bytes_regex(pattern: &str) -> BytesRegex {
    BytesRegex::new(pattern).expect("PDF 内容模式合法")
}

/// 顶层入口：PDF 字节 → 页文本行集合。
pub fn extract_pdf(bytes: &[u8]) -> Result<PdfDoc, PdfError> {
    parse_pdf(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 合成 PDF：use_flate 时内容流经 Zlib 压缩。
    fn make_pdf(use_flate: bool) -> Vec<u8> {
        let content = b"BT\n1 0 0 1 50 750 Tm\n(First line of text) Tj\n0 -20 Td\n(Second line) Tj\nET";
        let (dict, payload): (String, Vec<u8>) = if use_flate {
            use flate2::write::ZlibEncoder;
            use flate2::Compression;
            use std::io::Write;
            let mut e = ZlibEncoder::new(Vec::new(), Compression::default());
            e.write_all(content).unwrap();
            let comp = e.finish().unwrap();
            (format!("/Filter /FlateDecode /Length {}", comp.len()), comp)
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
        pdf.extend_from_slice(b"%%EOF\n");
        pdf
    }

    #[test]
    fn header_detection() {
        assert!(has_pdf_header(&make_pdf(false)));
        assert!(has_pdf_header(b"%PDF-"));
        assert!(!has_pdf_header(b""));
        assert!(!has_pdf_header(b"not a doc"));
        assert!(!has_pdf_header(b"PK\x03\x04 garbage"));
    }

    #[test]
    fn extracts_pages_and_lines() {
        let doc = extract_pdf(&make_pdf(false)).expect("PDF 解析成功");
        assert_eq!(doc.page_count, 1);
        assert!(doc.pages[0].contains("First line of text"));
        assert!(doc.pages[0].contains("Second line"));
    }

    #[test]
    fn extracts_flate_stream() {
        let doc = extract_pdf(&make_pdf(true)).expect("flate PDF 解析成功");
        assert!(doc.pages[0].contains("First line of text"));
        assert!(doc.pages[0].contains("Second line"));
    }

    #[test]
    fn stream_word_inside_literal_not_mis_split() {
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
        let doc = extract_pdf(&pdf).expect("字面量含 stream 字样也应正确解析");
        assert!(
            doc.pages[0].contains("hello stream world"),
            "内容流文本应完整（未被字面量错割）: {:?}",
            doc.pages
        );
    }

    #[test]
    fn bad_stream_boundary_fails_closed() {
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
        let doc = extract_pdf(&pdf).expect("坏流边界对象被跳过，不击穿整包解析");
        assert!(!doc.pages[0].contains("ghost"), "错割内容不得进入文本");
    }

    #[test]
    fn fails_closed_on_garbage_and_empty() {
        assert_eq!(extract_pdf(b"").unwrap_err().kind, PdfErrorKind::NotPdf);
        assert_eq!(
            extract_pdf(b"PK\x03\x04 garbage").unwrap_err().kind,
            PdfErrorKind::NotPdf
        );
        assert_eq!(
            extract_pdf(b"%PDF-1.4\nno objects here")
                .unwrap_err()
                .kind,
            PdfErrorKind::Parse
        );
    }
}
