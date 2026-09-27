use crate::{
    error::{DomainError as AppError, DomainResult as AppResult},
    ingest::NormalizedTxn,
};
use calamine::{open_workbook_from_rs, Data, Reader, Xlsx};
use chrono::NaiveDate;
use std::{collections::HashMap, io::Cursor};
type ColumnMap<'a> = HashMap<&'a str, Vec<usize>>;

/// Parse without accessing persistence; cloud imports publish the whole result atomically.
pub fn parse_excel_data(data: &[u8]) -> AppResult<Vec<NormalizedTxn>> {
    crate::workbook_limits::validate_workbook(data)?;
    let cursor = Cursor::new(data);
    let mut workbook: Xlsx<_> = open_workbook_from_rs(cursor)
        .map_err(|e| AppError::Import(format!("Failed to open Excel file: {}", e)))?;

    let sheet_names = workbook.sheet_names().to_vec();

    // Try to find "History" sheet, otherwise use first sheet
    let sheet_name = sheet_names
        .iter()
        .find(|s| s.to_lowercase().contains("history"))
        .or(sheet_names.first())
        .ok_or_else(|| AppError::Import("No sheets found in workbook".to_string()))?
        .clone();

    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|e| AppError::Import(format!("Failed to read sheet: {}", e)))?;

    let mut rows = range.rows();
    let header_row = rows
        .next()
        .ok_or_else(|| AppError::Import("No header row found".to_string()))?;

    let headers: Vec<String> = header_row
        .iter()
        .map(|c| cell_to_string(c).to_lowercase().trim().to_string())
        .collect();

    // Map column names to indices
    let col_map = build_column_map(&headers);

    // Parse each row into a normalized transaction; account/ticker resolution
    // and idempotent dedup are handled by the shared upsert below.
    let mut txns: Vec<NormalizedTxn> = Vec::new();

    for row in rows {
        // Extract account code
        let account_code = get_cell_string(row, &col_map, &["account", "account_code", "acct"]);
        if account_code.is_empty() {
            continue;
        }

        // Extract transaction type early (needed to interpret cash-flow rows with blank ticker)
        let transaction_type =
            get_cell_string(row, &col_map, &["type", "transaction_type", "action"]);
        if transaction_type.is_empty() {
            continue;
        }
        let tx_type_lower = transaction_type.to_ascii_lowercase();
        let is_cash_flow_row = matches!(
            tx_type_lower.as_str(),
            "deposit" | "withdraw" | "withdrawal"
        );

        // Option fields - "option" column contains the option code in this format
        let option_code = get_cell_string(
            row,
            &col_map,
            &["option", "option_code", "opt_code", "contract"],
        );
        let option_type_col = get_cell_string(
            row,
            &col_map,
            &["option type", "option_type", "opt_type", "c/p"],
        );
        let strike_price =
            get_cell_float(row, &col_map, &["strike", "strike_price", "option price"]);
        let expiration_date = get_cell_date(
            row,
            &col_map,
            &["option date", "expiration", "expiration_date", "exp_date"],
        );

        // Extract ticker symbol.
        // The History sheet duplicates the Ticker header:
        // - first occurrence is the instrument label (e.g. "AAPL-C")
        // - second occurrence is the underlying ticker (e.g. "AAPL")
        // For option rows, keep the underlying ticker while still using the first Price column.
        // Deposits/withdrawals have blank ticker; map them to synthetic CASH ticker.
        let ticker_symbol = resolve_ticker_symbol(row, &col_map, &option_code, is_cash_flow_row);
        if ticker_symbol.is_empty() {
            continue;
        }

        // Extract transaction fields
        let quantity = get_cell_float(row, &col_map, &["quantity", "qty", "shares"]);
        let price = get_cell_float(row, &col_map, &["price"]);
        let cost = get_cell_float(row, &col_map, &["cost", "total", "amount"]);
        let fees = get_cell_float(row, &col_map, &["fees", "commission"]);
        let date = get_cell_date(row, &col_map, &["date", "trade_date"]);

        // Status can be in first column (unnamed) or "status" column
        // First column often has "Closed" or "Open"
        let status_from_col = get_cell_string(row, &col_map, &["status"]);
        let status_from_first = row
            .first()
            .map(|c| cell_to_string(c).to_lowercase().trim().to_string())
            .unwrap_or_default();

        let status = if !status_from_col.is_empty() {
            status_from_col
        } else if status_from_first == "closed" || status_from_first == "open" {
            status_from_first
        } else {
            "open".to_string()
        };

        // Parse option code if present to extract details
        let (parsed_option_type, parsed_strike, parsed_expiration) =
            parse_option_code(&option_code);

        let final_option_type = if !option_type_col.is_empty() {
            Some(option_type_col)
        } else {
            parsed_option_type
        };
        let final_strike = if strike_price.is_some() {
            strike_price
        } else {
            parsed_strike
        };
        let final_expiration = if expiration_date.is_some() {
            expiration_date
        } else {
            parsed_expiration
        };

        if let Some(date) = date {
            let option_code_value = if option_code.is_empty() {
                None
            } else {
                Some(option_code.clone())
            };

            txns.push(NormalizedTxn {
                account_code,
                ticker_symbol,
                transaction_type,
                quantity: quantity.unwrap_or(0.0),
                price: price.unwrap_or(0.0),
                cost: cost.unwrap_or(0.0),
                fees: Some(fees.unwrap_or(0.0)),
                date,
                option_type: final_option_type,
                strike_price: final_strike,
                expiration_date: final_expiration,
                option_code: option_code_value,
                status,
                source: "excel".to_string(),
            });
        }
    }

    Ok(txns)
}

fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Int(i) => i.to_string(),
        Data::Float(f) => f.to_string(),
        Data::String(s) => s.clone(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(dt) => dt.to_string(),
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
        Data::Error(_) => String::new(),
        Data::Empty => String::new(),
    }
}

fn build_column_map<'a>(headers: &'a [String]) -> ColumnMap<'a> {
    let mut col_map = HashMap::new();

    for (idx, header) in headers.iter().enumerate() {
        col_map
            .entry(header.as_str())
            .or_insert_with(Vec::new)
            .push(idx);
    }

    col_map
}

fn get_column_index(col_map: &ColumnMap<'_>, names: &[&str], occurrence: usize) -> Option<usize> {
    for name in names {
        if let Some(indices) = col_map.get(*name) {
            if let Some(&idx) = indices.get(occurrence) {
                return Some(idx);
            }
        }
    }
    None
}

fn get_cell_string_at(
    row: &[Data],
    col_map: &ColumnMap<'_>,
    names: &[&str],
    occurrence: usize,
) -> String {
    if let Some(idx) = get_column_index(col_map, names, occurrence) {
        if let Some(cell) = row.get(idx) {
            return cell_to_string(cell).trim().to_string();
        }
    }
    String::new()
}

fn get_cell_string(row: &[Data], col_map: &ColumnMap<'_>, names: &[&str]) -> String {
    get_cell_string_at(row, col_map, names, 0)
}

fn get_cell_float_at(
    row: &[Data],
    col_map: &ColumnMap<'_>,
    names: &[&str],
    occurrence: usize,
) -> Option<f64> {
    if let Some(idx) = get_column_index(col_map, names, occurrence) {
        if let Some(cell) = row.get(idx) {
            match cell {
                Data::Float(f) => return Some(*f),
                Data::Int(i) => return Some(*i as f64),
                Data::String(s) => {
                    if let Ok(f) = s.trim().replace(",", "").replace("$", "").parse::<f64>() {
                        return Some(f);
                    }
                }
                _ => {}
            }
        }
    }
    None
}

fn get_cell_float(row: &[Data], col_map: &ColumnMap<'_>, names: &[&str]) -> Option<f64> {
    get_cell_float_at(row, col_map, names, 0)
}

fn parse_compact_date(s: &str) -> Option<NaiveDate> {
    let digits = s.trim();
    if !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }

    match digits.len() {
        // YYMMDD -> assume 20YY for modern options data
        6 => {
            let year = 2000 + digits[0..2].parse::<i32>().ok()?;
            let month = digits[2..4].parse::<u32>().ok()?;
            let day = digits[4..6].parse::<u32>().ok()?;
            NaiveDate::from_ymd_opt(year, month, day)
        }
        // YYYYMMDD
        8 => {
            let year = digits[0..4].parse::<i32>().ok()?;
            let month = digits[4..6].parse::<u32>().ok()?;
            let day = digits[6..8].parse::<u32>().ok()?;
            NaiveDate::from_ymd_opt(year, month, day)
        }
        _ => None,
    }
}

fn parse_compact_date_from_number(n: i64) -> Option<NaiveDate> {
    if n <= 0 {
        return None;
    }

    // Zero-pad to preserve leading zeros for YY in compact YYMMDD values (e.g., 010101).
    let padded_six = format!("{:06}", n);
    if let Some(d) = parse_compact_date(&padded_six) {
        return Some(d);
    }

    parse_compact_date(&n.to_string())
}

fn get_cell_date(row: &[Data], col_map: &ColumnMap<'_>, names: &[&str]) -> Option<NaiveDate> {
    if let Some(idx) = get_column_index(col_map, names, 0) {
        if let Some(cell) = row.get(idx) {
            match cell {
                Data::DateTime(dt) => {
                    // ExcelDateTime as days since 1899-12-30
                    let days = dt.as_f64() as i64;
                    return NaiveDate::from_ymd_opt(1899, 12, 30)
                        .and_then(|base| base.checked_add_signed(chrono::Duration::days(days)));
                }
                Data::Float(f) => {
                    // Some exports store compact YYMMDD/YYYYMMDD as numeric.
                    if f.is_finite() {
                        let rounded = *f as i64;
                        if (*f - rounded as f64).abs() < f64::EPSILON {
                            if let Some(d) = parse_compact_date_from_number(rounded) {
                                return Some(d);
                            }
                        }
                    }

                    // Otherwise treat it as Excel serial date.
                    let days = *f as i64;
                    return NaiveDate::from_ymd_opt(1899, 12, 30)
                        .and_then(|base| base.checked_add_signed(chrono::Duration::days(days)));
                }
                Data::Int(i) => {
                    // Some exports store compact YYMMDD/YYYYMMDD as integer.
                    if let Some(d) = parse_compact_date_from_number(*i) {
                        return Some(d);
                    }

                    // Otherwise treat it as Excel serial date.
                    return NaiveDate::from_ymd_opt(1899, 12, 30)
                        .and_then(|base| base.checked_add_signed(chrono::Duration::days(*i)));
                }
                Data::DateTimeIso(s) => {
                    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
                        return Some(d);
                    }
                }
                Data::String(s) => {
                    let s = s.trim();
                    if let Some(d) = parse_compact_date(s) {
                        return Some(d);
                    }
                    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
                        return Some(d);
                    }
                    if let Ok(d) = NaiveDate::parse_from_str(s, "%m/%d/%Y") {
                        return Some(d);
                    }
                    if let Ok(d) = NaiveDate::parse_from_str(s, "%m/%d/%y") {
                        return Some(d);
                    }
                }
                _ => {}
            }
        }
    }
    None
}

fn resolve_ticker_symbol(
    row: &[Data],
    col_map: &ColumnMap<'_>,
    option_code: &str,
    is_cash_flow_row: bool,
) -> String {
    let primary_ticker = get_cell_string(row, col_map, &["ticker", "symbol", "stock"]);
    let ticker_symbol = if option_code.is_empty() {
        primary_ticker
    } else {
        let underlying_ticker = get_cell_string_at(row, col_map, &["ticker", "symbol", "stock"], 1);
        if !underlying_ticker.is_empty() {
            underlying_ticker
        } else {
            strip_option_suffix(&primary_ticker)
        }
    };

    if ticker_symbol.is_empty() && is_cash_flow_row {
        "CASH".to_string()
    } else {
        ticker_symbol
    }
}

fn strip_option_suffix(symbol: &str) -> String {
    symbol
        .trim()
        .strip_suffix("-C")
        .or_else(|| symbol.trim().strip_suffix("-P"))
        .unwrap_or(symbol.trim())
        .to_string()
}

/// Parse option code like "250131P420" to extract expiration, type, and strike
fn parse_option_code(code: &str) -> (Option<String>, Option<f64>, Option<NaiveDate>) {
    let normalized = code.trim().to_ascii_uppercase();
    if normalized.is_empty() || normalized.len() < 8 {
        return (None, None, None);
    }

    // Format: YYMMDD[CP]STRIKE (e.g., "250131P420")
    // Find the C or P
    let option_idx = match normalized.find(['C', 'P']) {
        Some(i) if i >= 6 => i,
        _ => return (None, None, None),
    };

    let date_str = &normalized[0..6];
    let option_type = normalized[option_idx..option_idx + 1].to_string();
    let strike_str = &normalized[option_idx + 1..];

    // Parse date (YYMMDD)
    let expiration = parse_compact_date(date_str);

    // Parse strike price
    let strike = if strike_str.is_empty() {
        None
    } else {
        strike_str.parse::<f64>().ok()
    };

    (Some(option_type), strike, expiration)
}

#[cfg(test)]
mod tests {
    use super::{
        build_column_map, get_cell_float, get_cell_float_at, parse_compact_date, parse_option_code,
        resolve_ticker_symbol,
    };
    use calamine::Data;
    use chrono::NaiveDate;

    #[test]
    fn parses_compact_dates() {
        assert_eq!(
            parse_compact_date("250131"),
            NaiveDate::from_ymd_opt(2025, 1, 31)
        );
        assert_eq!(
            parse_compact_date("20250131"),
            NaiveDate::from_ymd_opt(2025, 1, 31)
        );
        assert_eq!(parse_compact_date("251332"), None);
    }

    #[test]
    fn parses_option_code_yymmdd() {
        let (option_type, strike, expiration) = parse_option_code("250131p420");
        assert_eq!(option_type.as_deref(), Some("P"));
        assert_eq!(strike, Some(420.0));
        assert_eq!(expiration, NaiveDate::from_ymd_opt(2025, 1, 31));
    }

    #[test]
    fn duplicate_headers_preserve_occurrence_order() {
        let headers = vec![
            "account".to_string(),
            "ticker".to_string(),
            "price".to_string(),
            "price".to_string(),
        ];
        let col_map = build_column_map(&headers);
        let row = vec![
            Data::String("SL#RH".to_string()),
            Data::String("MSFU".to_string()),
            Data::Float(31.83),
            Data::Float(27.56),
        ];

        assert_eq!(col_map.get("price"), Some(&vec![2, 3]));
        assert_eq!(get_cell_float(&row, &col_map, &["price"]), Some(31.83));
        assert_eq!(
            get_cell_float_at(&row, &col_map, &["price"], 1),
            Some(27.56)
        );
    }

    #[test]
    fn option_rows_use_underlying_ticker_and_trade_price() {
        let headers = vec![
            "ticker".to_string(),
            "option".to_string(),
            "price".to_string(),
            "ticker".to_string(),
            "price".to_string(),
        ];
        let col_map = build_column_map(&headers);
        let row = vec![
            Data::String("AAPL-C".to_string()),
            Data::String("201113C119".to_string()),
            Data::Float(2.26),
            Data::String("AAPL".to_string()),
            Data::Float(255.78),
        ];

        assert_eq!(
            resolve_ticker_symbol(&row, &col_map, "201113C119", false),
            "AAPL"
        );
        assert_eq!(get_cell_float(&row, &col_map, &["price"]), Some(2.26));
    }
}
