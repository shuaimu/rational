//! Check archive expansion and worksheet geometry before Calamine allocates ranges.
use crate::error::{DomainError, DomainResult};
use quick_xml::{events::Event, Reader};
use std::io::{Cursor, Read};
pub const MAX_WORKBOOK_BYTES: usize = 50 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_XML_BYTES: u64 = 16 * 1024 * 1024;
const MAX_CELLS: u64 = 500_000;
fn refused() -> DomainError {
    DomainError::Import("Workbook exceeds supported expansion or worksheet limits".into())
}
fn coordinate(value: &[u8]) -> DomainResult<(u64, u64)> {
    let mut column = 0u64;
    let mut index = 0;
    while index < value.len() && value[index].is_ascii_alphabetic() {
        column = column
            .checked_mul(26)
            .and_then(|n| n.checked_add(u64::from(value[index].to_ascii_uppercase() - b'A' + 1)))
            .ok_or_else(refused)?;
        index += 1;
    }
    let row = std::str::from_utf8(&value[index..])
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .ok_or_else(refused)?;
    if column == 0 || column > 16384 || row == 0 || row > 1048576 {
        return Err(refused());
    }
    Ok((column, row))
}
fn xml_limits(bytes: &[u8], worksheet: bool) -> DomainResult<()> {
    let mut reader = Reader::from_reader(bytes);
    let mut count = 0u64;
    let mut depth = 0usize;
    let (mut min_col, mut min_row, mut max_col, mut max_row) = (u64::MAX, u64::MAX, 0, 0);
    let (mut current_row, mut current_col) = (1u64, 1u64);
    loop {
        let event = reader.read_event().map_err(|_| refused())?;
        match &event {
            Event::Eof => break,
            Event::DocType(_) => return Err(refused()),
            Event::Start(element) | Event::Empty(element) => {
                count += 1;
                if count > 2_000_000 {
                    return Err(refused());
                }
                if matches!(event, Event::Start(_)) {
                    depth += 1;
                    if depth > 128 {
                        return Err(refused());
                    }
                }
                let local = element.local_name();
                if worksheet && local.as_ref() == b"row" {
                    for attr in element.attributes() {
                        let attr = attr.map_err(|_| refused())?;
                        if attr.key.local_name().as_ref() == b"r" {
                            current_row = std::str::from_utf8(&attr.value)
                                .ok()
                                .and_then(|s| s.parse().ok())
                                .ok_or_else(refused)?;
                        }
                    }
                }
                if worksheet && local.as_ref() == b"c" {
                    let (mut column, mut row) = (current_col, current_row);
                    for attr in element.attributes() {
                        let attr = attr.map_err(|_| refused())?;
                        if attr.key.local_name().as_ref() == b"r" {
                            (column, row) = coordinate(&attr.value)?;
                        }
                    }
                    if column == 0 || column > 16384 || row == 0 || row > 1048576 {
                        return Err(refused());
                    }
                    current_col = column + 1;
                    min_col = min_col.min(column);
                    min_row = min_row.min(row);
                    max_col = max_col.max(column);
                    max_row = max_row.max(row);
                    if (max_col - min_col + 1) * (max_row - min_row + 1) > MAX_CELLS {
                        return Err(refused());
                    }
                }
            }
            Event::End(element) => {
                depth = depth.checked_sub(1).ok_or_else(refused)?;
                if worksheet && element.local_name().as_ref() == b"row" {
                    current_row += 1;
                    current_col = 1;
                }
            }
            _ => {}
        }
    }
    Ok(())
}
pub fn validate_workbook(data: &[u8]) -> DomainResult<()> {
    if data.len() > MAX_WORKBOOK_BYTES {
        return Err(refused());
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(data))
        .map_err(|_| DomainError::Import("Invalid workbook archive".into()))?;
    if archive.len() > 512 {
        return Err(refused());
    }
    let mut expanded = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|_| refused())?;
        let name = entry.name().to_owned();
        if entry.is_dir() {
            continue;
        }
        let xml = name.ends_with(".xml") || name.ends_with(".rels");
        let limit = if xml {
            MAX_XML_BYTES
        } else {
            MAX_EXPANDED_BYTES
        };
        if entry.size() > limit
            || expanded
                .checked_add(entry.size())
                .is_none_or(|n| n > MAX_EXPANDED_BYTES)
        {
            return Err(refused());
        }
        // Verify actual expanded bytes too; never trust ZIP directory size metadata.
        if xml {
            let mut bytes = Vec::new();
            entry
                .by_ref()
                .take(limit + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| refused())?;
            if bytes.len() as u64 > limit {
                return Err(refused());
            }
            expanded += bytes.len() as u64;
            xml_limits(&bytes, name.starts_with("xl/worksheets/"))?;
        } else {
            let copied = std::io::copy(&mut entry.by_ref().take(limit + 1), &mut std::io::sink())
                .map_err(|_| refused())?;
            if copied > limit {
                return Err(refused());
            }
            expanded += copied;
        }
        if expanded > MAX_EXPANDED_BYTES {
            return Err(refused());
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sparse_range_and_entities_are_rejected_before_range_allocation() {
        assert!(xml_limits(
            br#"<worksheet><c r="A1"/><c r="XFD1048576"/></worksheet>"#,
            true
        )
        .is_err());
        assert!(xml_limits(br#"<!DOCTYPE x [<!ENTITY a "b">]><x/>"#, false).is_err());
        assert!(xml_limits(br#"<worksheet><c r="A1"/><c r="Z8000"/></worksheet>"#, true).is_ok());
    }
    #[test]
    fn oversized_input_is_refused_before_archive_parsing() {
        assert!(validate_workbook(&vec![0; MAX_WORKBOOK_BYTES + 1]).is_err());
    }
}
