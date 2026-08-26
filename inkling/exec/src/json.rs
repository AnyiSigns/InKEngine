//! 手写 JSON 解析与序列化（零外部依赖的协议底座）。
//!
//! 执行件的所有输入输出都是 JSON 线协议（MCP stdio / 数据文件），因此
//! JSON 读写是基础设施而不是业务：这里提供最小但完整的 JSON 实现——
//! 递归下降解析器（深度上限 + 出错位置，防敌对输入打爆栈）、保序对象
//! （输出确定性，测试与协议对账友好）、紧凑序列化（转义正确，任何
//! JSON 消费者都能读回）。对象键保序并采用后写覆盖（与 Python json
//! 同语义），键查找为线性扫描——工具参数对象规模小（<100 键），线性
//! 查找的常数开销远小于为它引入哈希依赖。

use std::fmt;

/// JSON 对象：保序键值对（后写覆盖重复键）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Object {
    entries: Vec<(String, Value)>,
}

impl Object {
    pub fn new() -> Self {
        Object {
            entries: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 键查找（线性扫描；对象规模小，可接受）。
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn get_str(&self, key: &str) -> Option<&str> {
        match self.get(key) {
            Some(Value::String(s)) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn get_i64(&self, key: &str) -> Option<i64> {
        match self.get(key) {
            Some(Value::Number(n)) => {
                if n.fract() == 0.0 && *n >= i64::MIN as f64 && *n <= i64::MAX as f64 {
                    Some(*n as i64)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    pub fn get_f64(&self, key: &str) -> Option<f64> {
        match self.get(key) {
            Some(Value::Number(n)) => Some(*n),
            _ => None,
        }
    }

    pub fn get_bool(&self, key: &str) -> Option<bool> {
        match self.get(key) {
            Some(Value::Bool(b)) => Some(*b),
            _ => None,
        }
    }

    pub fn get_array(&self, key: &str) -> Option<&[Value]> {
        match self.get(key) {
            Some(Value::Array(items)) => Some(items.as_slice()),
            _ => None,
        }
    }

    pub fn get_object(&self, key: &str) -> Option<&Object> {
        match self.get(key) {
            Some(Value::Object(obj)) => Some(obj),
            _ => None,
        }
    }

    pub fn insert(&mut self, key: String, value: Value) {
        if let Some(existing) = self.entries.iter_mut().find(|(k, _)| *k == key) {
            existing.1 = value;
        } else {
            self.entries.push((key, value));
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }
}

/// JSON 值（解析/序列化/程序内部传递的统一形态）。
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(Object),
}

impl Value {
    pub fn as_object(&self) -> Option<&Object> {
        match self {
            Value::Object(obj) => Some(obj),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(items) => Some(items.as_slice()),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    /// 深比较辅助：数字间按数值比较（1 与 1.0 相等——JSON 语义）。
    pub(crate) fn value_cmp_eq(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => x == y,
            (Value::String(x), Value::String(y)) => x == y,
            (Value::Bool(x), Value::Bool(y)) => x == y,
            (Value::Null, Value::Null) => true,
            (Value::Array(x), Value::Array(y)) => {
                x.len() == y.len()
                    && x.iter()
                        .zip(y.iter())
                        .all(|(i, j)| Self::value_cmp_eq(i, j))
            }
            (Value::Object(x), Value::Object(y)) => {
                x.len() == y.len()
                    && x.iter().all(|(k, v)| {
                        y.get(k)
                            .map(|yv| Self::value_cmp_eq(v, yv))
                            .unwrap_or(false)
                    })
            }
            _ => false,
        }
    }

    /// 用于集合去重的紧凑编码（unique_pairs 谓词等）。
    pub fn canonical_bytes(&self) -> Vec<u8> {
        match self {
            Value::Null => b"n".to_vec(),
            Value::Bool(b) => vec![if *b { b't' } else { b'f' }],
            Value::Number(n) => {
                let mut out = Vec::with_capacity(16);
                out.push(b'#');
                out.extend_from_slice(format_number(*n).as_bytes());
                out
            }
            Value::String(s) => {
                let mut out = Vec::with_capacity(s.len() + 2);
                out.push(b'"');
                out.extend_from_slice(s.as_bytes());
                out.push(b'"');
                out
            }
            Value::Array(items) => {
                let mut out = Vec::new();
                out.push(b'[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    out.extend_from_slice(&item.canonical_bytes());
                }
                out.push(b']');
                out
            }
            Value::Object(obj) => {
                let mut out = Vec::new();
                out.push(b'{');
                for (i, (k, v)) in obj.iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    out.push(b'"');
                    out.extend_from_slice(k.as_bytes());
                    out.push(b'"');
                    out.push(b':');
                    out.extend_from_slice(&v.canonical_bytes());
                }
                out.push(b'}');
                out
            }
        }
    }
}

/// 解析错误（带字节偏移，便于定位敌对/截断输入的问题点）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub offset: usize,
    pub message: String,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "JSON 解析错误（偏移 {}）: {}", self.offset, self.message)
    }
}

impl std::error::Error for ParseError {}

/// 解析深度上限：合法 JSON 嵌套远低于此，超过即视为敌对输入拒绝。
const MAX_DEPTH: usize = 128;

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn parse(input: &'a str) -> Result<Value, ParseError> {
        let mut parser = Parser {
            bytes: input.as_bytes(),
            pos: 0,
        };
        let value = parser.value(0)?;
        parser.skip_ws();
        if parser.pos != parser.bytes.len() {
            return Err(parser.error("解析完成后仍有剩余字符"));
        }
        Ok(value)
    }

    fn error(&self, message: impl Into<String>) -> ParseError {
        ParseError {
            offset: self.pos,
            message: message.into(),
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while let Some(b) = self.peek() {
            if matches!(b, b' ' | b'\t' | b'\n' | b'\r') {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn expect(&mut self, byte: u8, what: &str) -> Result<(), ParseError> {
        if self.peek() == Some(byte) {
            self.pos += 1;
            Ok(())
        } else {
            Err(self.error(format!("期望 {what}，实际 {:?}", self.peek())))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, ParseError> {
        if depth > MAX_DEPTH {
            return Err(self.error("嵌套深度超限（疑似敌对输入）"));
        }
        self.skip_ws();
        match self.peek() {
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => self.string().map(Value::String),
            Some(b't') => self.literal(b"true", Value::Bool(true)),
            Some(b'f') => self.literal(b"false", Value::Bool(false)),
            Some(b'n') => self.literal(b"null", Value::Null),
            Some(b) if b == b'-' || b.is_ascii_digit() => self.number(),
            Some(b) => Err(self.error(format!("意外的字符 {:?}", b as char))),
            None => Err(self.error("输入在值中途截断")),
        }
    }

    fn literal(&mut self, word: &[u8], value: Value) -> Result<Value, ParseError> {
        if self.bytes[self.pos..].starts_with(word) {
            self.pos += word.len();
            Ok(value)
        } else {
            Err(self.error("非法字面量"))
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value, ParseError> {
        self.expect(b'{', "'{'")?;
        let mut obj = Object::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Value::Object(obj));
        }
        loop {
            self.skip_ws();
            let key = self.string()?;
            self.skip_ws();
            self.expect(b':', "':'")?;
            let value = self.value(depth + 1)?;
            // 后写覆盖重复键（与 Python json 同语义：后者胜出）
            obj.insert(key, value);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(Value::Object(obj));
                }
                _ => return Err(self.error("对象内期望 ',' 或 '}'")),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Value, ParseError> {
        self.expect(b'[', "'['")?;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Value::Array(items));
        }
        loop {
            let value = self.value(depth + 1)?;
            items.push(value);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b']') => {
                    self.pos += 1;
                    return Ok(Value::Array(items));
                }
                _ => return Err(self.error("数组内期望 ',' 或 ']'")),
            }
        }
    }

    fn string(&mut self) -> Result<String, ParseError> {
        self.expect(b'"', "'\"'")?;
        let mut out = String::new();
        loop {
            let byte = self
                .peek()
                .ok_or_else(|| self.error("字符串在转义中途截断"))?;
            match byte {
                b'"' => {
                    self.pos += 1;
                    return Ok(out);
                }
                b'\\' => {
                    self.pos += 1;
                    let esc = self.peek().ok_or_else(|| self.error("转义序列截断"))?;
                    self.pos += 1;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000C}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let unit = self.hex4()?;
                            let ch = if (0xD800..0xDC00).contains(&unit) {
                                // 高位代理：必须紧跟低位代理（否则拒绝——JSON 规范要求成对）
                                if self.peek() == Some(b'\\') {
                                    self.pos += 1;
                                    if self.peek() == Some(b'u') {
                                        self.pos += 1;
                                        let low = self.hex4()?;
                                        if (0xDC00..0xE000).contains(&low) {
                                            let code = 0x1_0000u32
                                                + ((unit as u32 - 0xD800) << 10)
                                                + (low as u32 - 0xDC00);
                                            char::from_u32(code)
                                                .ok_or_else(|| self.error("非法代理对"))?
                                        } else {
                                            return Err(self.error("高位代理后不是低位代理"));
                                        }
                                    } else {
                                        return Err(self.error("高位代理后不是 \\u 转义"));
                                    }
                                } else {
                                    return Err(self.error("高位代理后不是 \\u 转义"));
                                }
                            } else if (0xDC00..0xE000).contains(&unit) {
                                return Err(self.error("孤立低位代理"));
                            } else {
                                char::from_u32(unit as u32).ok_or_else(|| self.error("非法码点"))?
                            };
                            out.push(ch);
                        }
                        _ => return Err(self.error("未知转义字符")),
                    }
                }
                b if b < 0x20 => {
                    // 控制字符必须转义（JSON 规范）；裸控制字符 = 畸形输入
                    return Err(self.error("字符串含未转义控制字符"));
                }
                _ => {
                    // 按 UTF-8 边界逐字节推进（输入已由 str 保证合法 UTF-8）
                    let len = utf8_len(byte);
                    let slice = &self.bytes[self.pos..self.pos + len];
                    self.pos += len;
                    // 安全：byte 来自合法 UTF-8 输入，len 由首字节推导
                    out.push_str(std::str::from_utf8(slice).expect("合法 UTF-8"));
                }
            }
        }
    }

    fn hex4(&mut self) -> Result<u16, ParseError> {
        let mut value: u16 = 0;
        for _ in 0..4 {
            let b = self.peek().ok_or_else(|| self.error("\\u 转义截断"))?;
            let digit = match b {
                b'0'..=b'9' => b - b'0',
                b'a'..=b'f' => b - b'a' + 10,
                b'A'..=b'F' => b - b'A' + 10,
                _ => return Err(self.error("\\u 转义含非十六进制字符")),
            };
            value = value * 16 + digit as u16;
            self.pos += 1;
        }
        Ok(value)
    }

    fn number(&mut self) -> Result<Value, ParseError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => {
                self.pos += 1;
                // 前导零拒绝（01 不是合法 JSON）
                if self.peek().is_some_and(|b| b.is_ascii_digit()) {
                    return Err(self.error("前导零"));
                }
            }
            Some(b) if b.is_ascii_digit() => {
                while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                    self.pos += 1;
                }
            }
            _ => return Err(self.error("数字缺整数部分")),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !self.peek().is_some_and(|b| b.is_ascii_digit()) {
                return Err(self.error("小数部分缺数字"));
            }
            while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(b'e') | Some(b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+') | Some(b'-')) {
                self.pos += 1;
            }
            if !self.peek().is_some_and(|b| b.is_ascii_digit()) {
                return Err(self.error("指数部分缺数字"));
            }
            while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        let text = &self.bytes[start..self.pos];
        let text = std::str::from_utf8(text).map_err(|_| self.error("数字非 UTF-8"))?;
        // 语法已按 JSON 数字文法校验；但超范围字面量（如 1e400）经 from_str
        // 会解析为 inf 而非报错——inf/NaN 序列化为非法 JSON（E3），
        // 此处显式拒绝非有限数（fail-fast，不产出污染协议行的值）。
        let number: f64 = text.parse().map_err(|_| self.error("数字超出可表示范围"))?;
        if !number.is_finite() {
            return Err(self.error("数字超出可表示范围"));
        }
        Ok(Value::Number(number))
    }
}

fn utf8_len(first: u8) -> usize {
    if first < 0x80 {
        1
    } else if first & 0xE0 == 0xC0 {
        2
    } else if first & 0xF0 == 0xE0 {
        3
    } else {
        4
    }
}

/// 解析 JSON 文本。
pub fn parse(input: &str) -> Result<Value, ParseError> {
    Parser::parse(input)
}

/// 数字序列化：整数值输出整数形态（无 ".0"），其余输出最短往返表示；
/// 非有限数（inf/NaN，理论不可达——解析期已拒绝）防御性输出 null，
/// 保证任何路径都产不出非法 JSON（E3）。
fn format_number(n: f64) -> String {
    if !n.is_finite() {
        return "null".to_string();
    }
    if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

/// 字符串序列化：按 JSON 转义规则（控制字符 \u 转义，其余原样）。
fn escape_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn write_value(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&format_number(*n)),
        Value::String(s) => out.push_str(&escape_string(s)),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Value::Object(obj) => {
            out.push('{');
            for (i, (k, v)) in obj.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&escape_string(k));
                out.push(':');
                write_value(v, out);
            }
            out.push('}');
        }
    }
}

/// 序列化 JSON 值（紧凑单行——MCP stdio 线协议要求一行一条消息）。
pub fn serialize(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

pub fn object_from_pairs(pairs: Vec<(&str, Value)>) -> Value {
    let mut obj = Object::new();
    for (k, v) in pairs {
        obj.insert(k.to_string(), v);
    }
    Value::Object(obj)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(input: &str) -> String {
        serialize(&parse(input).unwrap())
    }

    #[test]
    fn parses_primitives() {
        assert_eq!(parse("null").unwrap(), Value::Null);
        assert_eq!(parse("true").unwrap(), Value::Bool(true));
        assert_eq!(parse("false").unwrap(), Value::Bool(false));
        assert_eq!(parse("42").unwrap(), Value::Number(42.0));
        assert_eq!(parse("-0.5").unwrap(), Value::Number(-0.5));
        assert_eq!(parse("1e3").unwrap(), Value::Number(1000.0));
        assert_eq!(
            parse("\"hi\\n\\u4e2d\"").unwrap(),
            Value::String("hi\n中".to_string())
        );
    }

    #[test]
    fn parses_objects_preserving_order() {
        let value = parse(r#"{"b": 1, "a": {"x": [1, 2]}, "b": 2}"#).unwrap();
        let obj = value.as_object().unwrap();
        let keys: Vec<&str> = obj.iter().map(|(k, _)| k).collect();
        assert_eq!(keys, vec!["b", "a"]);
        assert_eq!(obj.get("b").unwrap(), &Value::Number(2.0));
    }

    #[test]
    fn rejects_truncated_and_garbage() {
        assert!(parse(r#"{"a": 1"#).is_err());
        assert!(parse(r#"{"a": }"#).is_err());
        assert!(parse(r#"01"#).is_err());
        assert!(parse(r#"[1, 2"#).is_err());
        assert!(parse(r#""\uD800""#).is_err());
        assert!(parse(r#"{"a":1}x"#).is_err());
        assert!(parse("").is_err());
    }

    #[test]
    fn rejects_deep_nesting() {
        let deep = "[".repeat(200).to_string();
        assert!(parse(&deep).is_err());
    }

    #[test]
    fn rejects_out_of_range_number() {
        // 1e400 语法合法但超出 f64 可表示范围：from_str 返回 Ok(inf)，
        // 若放行会序列化成非法 JSON——必须显式拒绝（E3）
        assert!(parse("1e400").is_err());
        assert!(parse("-1e400").is_err());
    }

    #[test]
    fn non_finite_serializes_as_null() {
        // 防御性兜底：任何路径产生的 inf/NaN 序列化输出 null（不产出非法 JSON）
        assert_eq!(serialize(&Value::Number(f64::INFINITY)), "null");
        assert_eq!(serialize(&Value::Number(f64::NEG_INFINITY)), "null");
        assert_eq!(serialize(&Value::Number(f64::NAN)), "null");
    }

    #[test]
    fn roundtrips() {
        assert_eq!(
            roundtrip(r#"{"a": [1, 2.5, "x"], "b": null}"#),
            r#"{"a":[1,2.5,"x"],"b":null}"#
        );
        assert_eq!(roundtrip(r#""a\"b\\c""#), r#""a\"b\\c""#);
        assert_eq!(roundtrip("1.0"), "1");
        assert_eq!(roundtrip("-0.0"), "0");
        assert_eq!(roundtrip(r#""\u4e2d\u6587""#), "\"中文\"");
        assert_eq!(roundtrip(r#"{"k":"\t"}"#), r#"{"k":"\t"}"#);
    }

    #[test]
    fn escapes_control_chars() {
        let value = Value::String("\u{0001}".to_string());
        assert_eq!(serialize(&value), r#""\u0001""#);
    }

    #[test]
    fn surrogate_pair() {
        let value = parse(r#""\uD83D\uDE00""#).unwrap();
        assert_eq!(value, Value::String("😀".to_string()));
    }
}
