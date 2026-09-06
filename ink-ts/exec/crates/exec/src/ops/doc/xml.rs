//! XML 轻量分词（零外部依赖，fail-closed）：OOXML 部件文本提取共用。
//!
//! 语义参照旧壳 doc_ops.rs 的 XML 层：起始/结束/自闭合/文本 token + 属性
//! 解析 + 实体反转义；未闭合标签/属性引号缺失一律 Err（不静默降级）。

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum XmlToken<'a> {
    Start(&'a str, Vec<(&'a str, &'a str)>),
    End(&'a str),
    SelfClose(&'a str, Vec<(&'a str, &'a str)>),
    Text(&'a str),
}

pub fn tokenize(xml: &str) -> Result<Vec<XmlToken<'_>>, String> {
    let bytes = xml.as_bytes();
    let mut tokens = Vec::new();
    let mut depth = 0usize;
    let mut i = 0;
    let n = bytes.len();
    while i < n {
        if bytes[i] == b'<' {
            if i + 1 < n && bytes[i + 1] == b'/' {
                let start = i + 2;
                let end = find(bytes, b'>', start).ok_or("未闭合结束标签")?;
                let name = xml[start..end].trim();
                if name.is_empty() {
                    return Err("空结束标签".into());
                }
                depth = depth.saturating_sub(1);
                tokens.push(XmlToken::End(name));
                i = end + 1;
            } else if i + 1 < n && (bytes[i + 1] == b'?' || bytes[i + 1] == b'!') {
                let end = find(bytes, b'>', i + 2).ok_or("声明/注释未闭合")?;
                i = end + 1;
            } else {
                let gt = find(bytes, b'>', i + 1).ok_or("起始标签未闭合")?;
                let inner = &xml[i + 1..gt];
                let self_close = inner.ends_with('/');
                let inner_body = if self_close {
                    &inner[..inner.len() - 1]
                } else {
                    inner
                };
                let mut parts =
                    inner_body.splitn(2, |c| c == ' ' || c == '\t' || c == '\n' || c == '\r');
                let raw_name = parts.next().unwrap_or("").trim();
                let attr_str = parts.next().unwrap_or("");
                if raw_name.is_empty() {
                    return Err("空起始标签".into());
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
        return Err("标签未闭合".into());
    }
    Ok(tokens)
}

fn parse_attrs(s: &str) -> Result<Vec<(&str, &str)>, String> {
    let bytes = s.as_bytes();
    let mut attrs = Vec::new();
    let mut i = 0;
    let n = bytes.len();
    while i < n {
        while i < n && is_ws(bytes[i]) {
            i += 1;
        }
        if i >= n {
            break;
        }
        let name_start = i;
        while i < n && bytes[i] != b'=' && !is_ws(bytes[i]) {
            i += 1;
        }
        let name = &s[name_start..i];
        if name.is_empty() {
            break;
        }
        while i < n && is_ws(bytes[i]) {
            i += 1;
        }
        if i >= n || bytes[i] != b'=' {
            continue;
        }
        i += 1;
        while i < n && is_ws(bytes[i]) {
            i += 1;
        }
        if i >= n {
            return Err("属性值缺失".into());
        }
        if bytes[i] != b'"' && bytes[i] != 39 {
            return Err("属性值引号缺失".into());
        }
        let q = bytes[i];
        i += 1;
        let val_start = i;
        let val_end = find(bytes, q, i).ok_or("属性值未闭合")?;
        attrs.push((name, &s[val_start..val_end]));
        i = val_end + 1;
    }
    Ok(attrs)
}

fn is_ws(b: u8) -> bool {
    b == b' ' || b == b'\t' || b == b'\n' || b == b'\r'
}

fn find(hay: &[u8], needle: u8, from: usize) -> Option<usize> {
    hay[from..]
        .iter()
        .position(|&b| b == needle)
        .map(|p| from + p)
}

/// 命名空间前缀折叠后的本地名。
pub fn local_name(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

/// 本地名匹配取属性值。
pub fn attr_val<'a>(attrs: &[(&'a str, &'a str)], name: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(k, _)| local_name(k) == name)
        .map(|(_, v)| *v)
}

/// 原名精确匹配取属性值（带命名空间前缀的属性须精确匹配）。
pub fn attr_val_exact<'a>(attrs: &[(&'a str, &'a str)], name: &str) -> Option<&'a str> {
    attrs.iter().find(|(k, _)| *k == name).map(|(_, v)| *v)
}

pub fn xml_unescape(s: &str) -> String {
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
                    v.and_then(char::from_u32)
                        .map(|c| c.to_string())
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
