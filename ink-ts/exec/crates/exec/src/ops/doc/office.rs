//! OOXML 三件套文本提取（docx/xlsx/pptx）——zip 条目 + 轻量 XML 分词。
//!
//! 语义参照旧壳 doc_ops.rs：docx 主文档段落与表格按文档序成行；xlsx 走
//! workbook r:id → rels Target 映射定位工作表（FA5，缺失时按 sheetN 回退）；
//! pptx 按 ppt/slides/slideN.xml 数字序遍历形状段落文本。产物为纯文本行
//! （doc.parse 消费面），不保留结构字段。

use std::collections::HashMap;

use super::super::super::envelope::Deny;
use super::xml;
use super::zip;
use super::zip::ZipErrorKind;

/// 条目读取错误 → Deny：缺件 = NotOffice（format），坏包/压缩问题原样归因。
fn zip_part_error(err: zip::ZipError, part: &str) -> Deny {
    if matches!(err.kind, ZipErrorKind::NotFound) {
        Deny::new("format", format!("NotOffice: 压缩包缺条目 {part}"))
    } else {
        err.into()
    }
}

/// docx：word/document.xml 文本行——段落一行；表格行 = 单元格以制表符
/// 连接（段落与表格按文档序交错输出）。
pub fn docx_text(zip_bytes: &[u8]) -> Result<Vec<String>, Deny> {
    let entry =
        zip::read_entry(zip_bytes, "word/document.xml").map_err(|err| zip_part_error(err, "word/document.xml"))?;
    let xml_text = String::from_utf8_lossy(&entry);
    let tokens = xml::tokenize(&xml_text)
        .map_err(|message| Deny::new("format", format!("docx 主文档 XML 非法: {message}")))?;
    let mut lines: Vec<String> = Vec::new();
    let mut para = String::new();
    let mut capture = false;
    let mut table_depth = 0usize;
    let mut row_cells: Vec<String> = Vec::new();
    let mut in_cell = false;
    for tok in tokens {
        match tok {
            xml::XmlToken::Start(name, _) => {
                let ln = xml::local_name(name);
                match ln {
                    "tbl" => table_depth += 1,
                    "tr" => row_cells.clear(),
                    "tc" => {
                        in_cell = true;
                        row_cells.push(String::new());
                    }
                    "t" => capture = true,
                    "tab" => {
                        if table_depth == 0 {
                            para.push('\t');
                        }
                    }
                    "br" | "cr" => {
                        if table_depth == 0 {
                            para.push('\n');
                        }
                    }
                    "p" => para.clear(),
                    _ => {}
                }
            }
            xml::XmlToken::SelfClose(name, _) => {
                if xml::local_name(name) == "tab" && table_depth == 0 {
                    para.push('\t');
                }
            }
            xml::XmlToken::End(name) => {
                let ln = xml::local_name(name);
                match ln {
                    "p" => {
                        let text = std::mem::take(&mut para);
                        if in_cell {
                            if let Some(cell) = row_cells.last_mut() {
                                if !cell.is_empty() {
                                    cell.push('\n');
                                }
                                cell.push_str(&text);
                            }
                        } else {
                            lines.push(text);
                        }
                    }
                    "tc" => {
                        in_cell = false;
                        if let Some(cell) = row_cells.last_mut() {
                            let trimmed = cell.trim_end().to_string();
                            *cell = trimmed;
                        }
                    }
                    "tr" => {
                        let row = std::mem::take(&mut row_cells);
                        if !row.is_empty() {
                            lines.push(row.join("\t"));
                        }
                    }
                    "tbl" => table_depth = table_depth.saturating_sub(1),
                    "t" => capture = false,
                    _ => {}
                }
            }
            xml::XmlToken::Text(t) => {
                if capture {
                    para.push_str(&xml::xml_unescape(t));
                }
            }
        }
    }
    Ok(lines)
}

/// xlsx：全部工作表文本行（每行 = 单元格值以制表符连接）。
pub fn xlsx_text(zip_bytes: &[u8]) -> Result<Vec<String>, Deny> {
    let shared = match zip::read_entry(zip_bytes, "xl/sharedStrings.xml") {
        Ok(bytes) => shared_strings(&String::from_utf8_lossy(&bytes)),
        Err(_) => Vec::new(),
    };
    let refs = match zip::read_entry(zip_bytes, "xl/workbook.xml") {
        Ok(bytes) => workbook_sheet_refs(&String::from_utf8_lossy(&bytes)),
        Err(_) => Vec::new(),
    };
    let rels = match zip::read_entry(zip_bytes, "xl/_rels/workbook.xml.rels") {
        Ok(bytes) => workbook_rels(&String::from_utf8_lossy(&bytes)),
        Err(_) => HashMap::new(),
    };
    let mut lines: Vec<String> = Vec::new();
    for (name, rid) in &refs {
        let target = rels.get(rid).cloned().unwrap_or_default();
        let entry = if target.is_empty() {
            format!("xl/worksheets/sheet{}.xml", refs_index_of(&refs, rid) + 1)
        } else {
            normalize_target(&target)
        };
        match zip::read_entry(zip_bytes, &entry) {
            Ok(bytes) => {
                if !lines.is_empty() {
                    lines.push(String::new());
                }
                lines.push(format!("# sheet: {name}"));
                lines.extend(sheet_text(&String::from_utf8_lossy(&bytes), &shared)?);
            }
            Err(err) => return Err(zip_part_error(err, &entry)),
        }
    }
    if lines.is_empty() {
        // workbook 声明缺失：按 sheetN 顺序回退枚举（防御性上限）。
        for n in 1..=256 {
            let entry = format!("xl/worksheets/sheet{n}.xml");
            match zip::read_entry(zip_bytes, &entry) {
                Ok(bytes) => lines.extend(sheet_text(&String::from_utf8_lossy(&bytes), &shared)?),
                Err(_) => break,
            }
        }
    }
    if lines.is_empty() {
        return Err(Deny::new("format", "NotOffice: xlsx 无工作表"));
    }
    Ok(lines)
}

/// pptx：全部幻灯片文本行（每张形状段落文本，幻灯片间空行分隔）。
pub fn pptx_text(zip_bytes: &[u8]) -> Result<Vec<String>, Deny> {
    let entries = zip::list_entries(zip_bytes)?;
    let mut nums: Vec<usize> = entries
        .iter()
        .filter_map(|e| {
            let rest = e.name.strip_prefix("ppt/slides/slide")?;
            rest.strip_suffix(".xml")?.parse::<usize>().ok()
        })
        .collect();
    nums.sort_unstable();
    if nums.is_empty() {
        return Err(Deny::new("format", "NotOffice: pptx 无幻灯片"));
    }
    let mut lines: Vec<String> = Vec::new();
    for n in nums {
        let entry = format!("ppt/slides/slide{n}.xml");
        match zip::read_entry(zip_bytes, &entry) {
            Ok(bytes) => {
                if !lines.is_empty() {
                    lines.push(String::new());
                }
                lines.extend(slide_text(&String::from_utf8_lossy(&bytes))?);
            }
            Err(err) => return Err(zip_part_error(err, &entry)),
        }
    }
    if lines.is_empty() {
        return Err(Deny::new("format", "NotOffice: pptx 无幻灯片文本"));
    }
    Ok(lines)
}

fn refs_index_of(refs: &[(String, String)], rid: &str) -> usize {
    refs.iter().position(|(_, r)| r == rid).unwrap_or(0)
}

fn normalize_target(target: &str) -> String {
    let target = target.trim_start_matches('/');
    if target.starts_with("xl/") {
        target.to_string()
    } else {
        format!("xl/{target}")
    }
}

fn shared_strings(xml_text: &str) -> Vec<String> {
    let tokens = match xml::tokenize(xml_text) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let mut items = Vec::new();
    let mut cur = String::new();
    let mut in_si = false;
    let mut capture = false;
    for tok in tokens {
        match tok {
            xml::XmlToken::Start(name, _) => {
                let ln = xml::local_name(name);
                if ln == "si" {
                    in_si = true;
                    cur.clear();
                } else if ln == "t" && in_si {
                    capture = true;
                }
            }
            xml::XmlToken::End(name) => {
                let ln = xml::local_name(name);
                if ln == "si" {
                    items.push(std::mem::take(&mut cur));
                    in_si = false;
                } else if ln == "t" {
                    capture = false;
                }
            }
            xml::XmlToken::Text(t) => {
                if capture {
                    cur.push_str(&xml::xml_unescape(t));
                }
            }
            xml::XmlToken::SelfClose(_, _) => {}
        }
    }
    items
}

fn workbook_sheet_refs(xml_text: &str) -> Vec<(String, String)> {
    let tokens = match xml::tokenize(xml_text) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let mut refs = Vec::new();
    for tok in tokens {
        if let xml::XmlToken::Start(name, attrs) | xml::XmlToken::SelfClose(name, attrs) = tok {
            if xml::local_name(name) == "sheet" {
                if let Some(n) = xml::attr_val(&attrs, "name") {
                    let rid = xml::attr_val_exact(&attrs, "r:id").unwrap_or("");
                    refs.push((n.to_string(), rid.to_string()));
                }
            }
        }
    }
    refs
}

fn workbook_rels(xml_text: &str) -> HashMap<String, String> {
    let tokens = match xml::tokenize(xml_text) {
        Ok(t) => t,
        Err(_) => return HashMap::new(),
    };
    let mut rels = HashMap::new();
    for tok in tokens {
        if let xml::XmlToken::Start(name, attrs) | xml::XmlToken::SelfClose(name, attrs) = tok {
            if xml::local_name(name) == "Relationship" {
                if let (Some(rid), Some(target)) =
                    (xml::attr_val(&attrs, "Id"), xml::attr_val(&attrs, "Target"))
                {
                    rels.insert(rid.to_string(), target.to_string());
                }
            }
        }
    }
    rels
}

/// 单张工作表 → 文本行（稀疏行按最大列号补齐空格）。
fn sheet_text(xml_text: &str, shared: &[String]) -> Result<Vec<String>, Deny> {
    let tokens = xml::tokenize(xml_text)
        .map_err(|message| Deny::new("format", format!("worksheet XML 非法: {message}")))?;
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut cur_row: Option<Vec<String>> = None;
    let mut cur_value = String::new();
    let mut cur_col = 0usize;
    let mut max_col = 0usize;
    let mut kind_shared = false;
    let mut capture_value = false;
    let mut capture_inline = false;
    for tok in tokens {
        match tok {
            xml::XmlToken::Start(name, attrs) => {
                let ln = xml::local_name(name);
                match ln {
                    "row" => cur_row = Some(Vec::new()),
                    "c" => {
                        let r = xml::attr_val(&attrs, "r").unwrap_or("");
                        let t = xml::attr_val(&attrs, "t").unwrap_or("");
                        cur_col = col_index(r).max(1);
                        kind_shared = t == "s";
                        cur_value.clear();
                        capture_value = false;
                        capture_inline = t == "inlineStr";
                    }
                    "v" => capture_value = true,
                    "is" => capture_inline = true,
                    _ => {}
                }
            }
            xml::XmlToken::End(name) => {
                let ln = xml::local_name(name);
                match ln {
                    "v" => {
                        if kind_shared {
                            let idx = cur_value.trim().parse::<usize>().unwrap_or(usize::MAX);
                            cur_value = shared.get(idx).cloned().unwrap_or_default();
                        }
                        capture_value = false;
                    }
                    "is" => capture_inline = false,
                    "c" => {
                        if let Some(row) = cur_row.as_mut() {
                            while row.len() < cur_col - 1 {
                                row.push(String::new());
                            }
                            row.push(std::mem::take(&mut cur_value));
                            if row.len() > max_col {
                                max_col = row.len();
                            }
                        }
                    }
                    "row" => {
                        if let Some(mut r) = cur_row.take() {
                            while r.len() < max_col {
                                r.push(String::new());
                            }
                            rows.push(r);
                        }
                    }
                    _ => {}
                }
            }
            xml::XmlToken::Text(t) => {
                if capture_value || capture_inline {
                    cur_value.push_str(&xml::xml_unescape(t));
                }
            }
            xml::XmlToken::SelfClose(_, _) => {}
        }
    }
    Ok(rows
        .into_iter()
        .map(|row| row.join("\t"))
        .collect())
}

/// 单张幻灯片 → 文本行（每个 a:p 段落一行；去掉空段）。
fn slide_text(xml_text: &str) -> Result<Vec<String>, Deny> {
    let tokens = xml::tokenize(xml_text)
        .map_err(|message| Deny::new("format", format!("slide XML 非法: {message}")))?;
    let mut lines: Vec<String> = Vec::new();
    let mut capture = false;
    let mut cur = String::new();
    for tok in tokens {
        match tok {
            xml::XmlToken::Start(name, _) => {
                if xml::local_name(name) == "t" {
                    capture = true;
                }
            }
            xml::XmlToken::End(name) => {
                let ln = xml::local_name(name);
                if ln == "t" {
                    capture = false;
                } else if ln == "p" {
                    let text = std::mem::take(&mut cur).trim().to_string();
                    if !text.is_empty() {
                        lines.push(text);
                    }
                }
            }
            xml::XmlToken::Text(t) => {
                if capture {
                    cur.push_str(&xml::xml_unescape(t));
                }
            }
            xml::XmlToken::SelfClose(_, _) => {}
        }
    }
    Ok(lines)
}

/// 列引用（如 "A1"）→ 1 基列号。
fn col_index(reference: &str) -> usize {
    let letters: String = reference
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect();
    let mut idx = 0usize;
    for c in letters.chars() {
        idx = idx * 26 + (c.to_ascii_uppercase() as u8 - b'A' as u8 + 1) as usize;
    }
    idx
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zip_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let owned: Vec<(String, &[u8])> = entries
            .iter()
            .map(|(name, data)| (name.to_string(), *data))
            .collect();
        zip::store_entries(&owned)
    }

    #[test]
    fn docx_paragraphs_and_tables_in_document_order() {
        let xml = br#"<w:document xmlns:w="x"><w:body>
            <w:p><w:r><w:t>First para</w:t></w:r></w:p>
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
            <w:p><w:r><w:t>Last para</w:t></w:r></w:p>
        </w:body></w:document>"#;
        let z = zip_with(&[("word/document.xml", xml)]);
        let lines = docx_text(&z).unwrap();
        assert_eq!(lines, vec!["First para", "A1\tB1", "Last para"]);
    }

    #[test]
    fn docx_xml_unescape() {
        let xml = br#"<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>a &lt;b&gt; &amp; c</w:t></w:r></w:p></w:body></w:document>"#;
        let z = zip_with(&[("word/document.xml", xml)]);
        assert_eq!(docx_text(&z).unwrap(), vec!["a <b> & c"]);
    }

    #[test]
    fn docx_fails_on_malformed_xml_and_missing_part() {
        let bad = zip_with(&[("word/document.xml", b"<w:p><w:r>")]);
        assert!(docx_text(&bad).is_err());
        let missing = zip_with(&[("xl/workbook.xml", b"<x/>")]);
        assert!(docx_text(&missing).is_err());
        assert!(matches!(
            docx_text(&missing).unwrap_err(),
            Deny { reason: "format", .. }
        ));
    }

    #[test]
    fn xlsx_shared_inline_numbers_and_sheet_names() {
        let shared = r#"<sst xmlns="x"><si><t>Apple</t></si><si><t>Banana</t></si></sst>"#;
        let wb = r#"<workbook xmlns="x" xmlns:r="y"><sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
        let rels = r#"<Relationships xmlns="x"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#;
        let sheet = r#"<worksheet xmlns="x"><sheetData>
            <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
            <row r="2"><c r="A2" t="inlineStr"><is><t>7</t></is></c><c r="B2"><v>3.5</v></c></row>
        </sheetData></worksheet>"#;
        let z = zip_with(&[
            ("xl/sharedStrings.xml", shared.as_bytes()),
            ("xl/workbook.xml", wb.as_bytes()),
            ("xl/_rels/workbook.xml.rels", rels.as_bytes()),
            ("xl/worksheets/sheet1.xml", sheet.as_bytes()),
        ]);
        let lines = xlsx_text(&z).unwrap();
        assert_eq!(lines[0], "# sheet: 数据");
        assert_eq!(lines[1], "Apple\tBanana");
        assert_eq!(lines[2], "7\t3.5");
    }

    #[test]
    fn xlsx_sheet_names_map_by_rels_not_position() {
        let wb = r#"<workbook xmlns="x" xmlns:r="y"><sheets><sheet name="面板" sheetId="2" r:id="rId2"/><sheet name="明细" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
        let rels = r#"<Relationships xmlns="x"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>"#;
        let sheet1 = r#"<worksheet xmlns="x"><sheetData><row r="1"><c r="A1"><v>明细行</v></c></row></sheetData></worksheet>"#;
        let sheet2 = r#"<worksheet xmlns="x"><sheetData><row r="1"><c r="A1"><v>面板行</v></c></row></sheetData></worksheet>"#;
        let z = zip_with(&[
            ("xl/workbook.xml", wb.as_bytes()),
            ("xl/_rels/workbook.xml.rels", rels.as_bytes()),
            ("xl/worksheets/sheet1.xml", sheet1.as_bytes()),
            ("xl/worksheets/sheet2.xml", sheet2.as_bytes()),
        ]);
        let lines = xlsx_text(&z).unwrap();
        assert!(lines.iter().any(|l| l == "# sheet: 面板"));
        assert!(lines.iter().any(|l| l == "面板行"));
        assert!(lines.iter().any(|l| l == "明细行"));
    }

    #[test]
    fn xlsx_no_sheets_fails_closed() {
        let z = zip_with(&[("xl/workbook.xml", b"<workbook/>")]);
        assert!(xlsx_text(&z).is_err());
    }

    #[test]
    fn pptx_shape_text_per_slide() {
        let xml1 = br#"<p:sld xmlns:p="p" xmlns:a="a"><p:sp><p:txBody><a:p><a:t>cover</a:t></a:p></p:txBody></p:sp></p:sld>"#;
        let xml2 = r#"<p:sld xmlns:p="p" xmlns:a="a"><p:sp><p:txBody><a:p><a:t>要点一</a:t></a:p><a:p><a:t>要点二</a:t></a:p></p:txBody></p:sp></p:sld>"#;
        let z = zip_with(&[
            ("ppt/slides/slide1.xml", xml1),
            ("ppt/slides/slide2.xml", xml2.as_bytes()),
        ]);
        let lines = pptx_text(&z).unwrap();
        assert_eq!(lines[0], "cover");
        assert_eq!(lines[2], "要点一");
        assert_eq!(lines[3], "要点二");
    }

    #[test]
    fn pptx_no_slides_fails_closed() {
        let z = zip_with(&[("ppt/theme/theme1.xml", b"<x/>")]);
        assert!(pptx_text(&z).is_err());
    }

    #[test]
    fn unsupported_compression_is_rejected() {
        let mut z = zip_with(&[("ppt/slides/slide1.xml", b"<x/>")]);
        let eocd = z.len() - 22;
        let cd_offset =
            u32::from_le_bytes([z[eocd + 16], z[eocd + 17], z[eocd + 18], z[eocd + 19]]) as usize;
        z[cd_offset + 10] = 9;
        let err = pptx_text(&z).unwrap_err();
        assert_eq!(err.reason, "compression");
    }
}
