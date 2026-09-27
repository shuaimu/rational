//! Shared provider activity normalization; input comes from a captured HTTP page.
use crate::ingest::NormalizedTxn;
use chrono::NaiveDate;
use serde::Deserialize;
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
#[derive(Debug, Deserialize)]
pub struct Activity {
    /// Equity/security object (nullable for cash/option activities). Shape varies
    /// by brokerage, so kept as raw JSON and probed by `extract_ticker`.
    #[serde(default)]
    pub symbol: Option<Value>,
    #[serde(default)]
    pub option_symbol: Option<OptionSymbol>,
    #[serde(default)]
    pub price: Option<f64>,
    #[serde(default)]
    pub units: Option<f64>,
    #[serde(default)]
    pub amount: Option<f64>,
    /// Activity category: BUY, SELL, DIVIDEND, OPTIONASSIGNMENT, ...
    #[serde(rename = "type", default)]
    pub activity_type: Option<String>,
    /// Option trade action (BUY_TO_OPEN / SELL_TO_CLOSE / ...). Distinct from
    /// `option_symbol.option_type` which is CALL/PUT.
    #[serde(default)]
    pub option_type: Option<String>,
    #[serde(default)]
    pub trade_date: Option<String>,
    #[serde(default)]
    pub settlement_date: Option<String>,
    #[serde(default)]
    pub fee: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct OptionSymbol {
    /// OCC symbol, e.g. "AAPL  250131C00420000".
    #[serde(default)]
    pub ticker: Option<String>,
    /// "CALL" or "PUT".
    #[serde(default)]
    pub option_type: Option<String>,
    #[serde(default)]
    pub strike_price: Option<f64>,
    #[serde(default)]
    pub expiration_date: Option<String>,
    #[serde(default)]
    pub underlying_symbol: Option<Value>,
}

/// Direction/category of an activity, which controls sign and cost handling.
#[derive(Debug, Clone, Copy, PartialEq)]
enum ActivityKind {
    /// Buy/sell of stock or options: signed quantity, cost = price * quantity.
    Trade,
    /// Assignment/expiration/exercise: positive magnitude, cost from price (~0).
    Corporate,
    /// Dividend/deposit/withdrawal/interest: quantity 0, cost = -amount.
    CashFlow,
}

/// Classify a SnapTrade activity into RobinLab's transaction_type vocabulary +
/// kind, matching the conventions observed in the existing data. For options the
/// `action` (BUY_TO_OPEN/SELL_TO_OPEN/...) disambiguates open vs close.
fn classify(
    raw_type: &str,
    action: Option<&str>,
    is_option: bool,
    has_units: bool,
) -> Option<(String, ActivityKind)> {
    let t = raw_type.to_ascii_uppercase();
    let (name, kind): (&str, ActivityKind) = match t.as_str() {
        "BUY" | "SELL" => {
            let name = if is_option {
                match action.map(|a| a.to_ascii_uppercase()).as_deref() {
                    Some("BUY_TO_OPEN") => "Buy",
                    Some("SELL_TO_CLOSE") => "Sell",
                    Some("SELL_TO_OPEN") => "Sell short",
                    Some("BUY_TO_CLOSE") => "Buy to cover",
                    _ if t == "BUY" => "Buy",
                    _ => "Sell",
                }
            } else if t == "BUY" {
                "Buy"
            } else {
                "Sell"
            };
            (name, ActivityKind::Trade)
        }
        "OPTIONASSIGNMENT" => ("Assigned", ActivityKind::Corporate),
        "OPTIONEXPIRATION" => ("Expired", ActivityKind::Corporate),
        "OPTIONEXERCISE" => ("Exercised", ActivityKind::Corporate),
        "DIVIDEND" => ("Dividend", ActivityKind::CashFlow),
        "CONTRIBUTION" => ("Deposit", ActivityKind::CashFlow),
        "WITHDRAWAL" => ("Withdraw", ActivityKind::CashFlow),
        "INTEREST" => ("Interest", ActivityKind::CashFlow),
        "" => return None,
        // Unknown type: keep it (Title Case) so nothing is dropped, routing by
        // shape — a row with units behaves like a trade, otherwise a cash flow.
        _ => {
            let kind = if has_units {
                ActivityKind::Trade
            } else {
                ActivityKind::CashFlow
            };
            return Some((title_case(raw_type), kind));
        }
    };
    Some((name.to_string(), kind))
}

/// Convert a SnapTrade activity into RobinLab's normalized transaction shape,
/// matching the existing data's conventions:
/// - option quantity in shares (contracts * 100), signed per `units`
/// - cost = price * signed_quantity for trades; -amount for cash flows
/// - types: Buy / Sell / Sell short / Buy to cover / Assigned / Expired / ...
pub fn activity_to_normalized(activity: &Activity, account_code: &str) -> Option<NormalizedTxn> {
    let raw_type = activity.activity_type.as_deref().unwrap_or("");
    let is_option = activity.option_symbol.is_some();
    let units = activity.units.unwrap_or(0.0);
    let action = activity.option_type.as_deref();

    let (transaction_type, kind) = classify(raw_type, action, is_option, units.abs() > 0.0)?;

    let date = activity
        .trade_date
        .as_deref()
        .or(activity.settlement_date.as_deref())
        .and_then(parse_date)?;

    let fees = Some(activity.fee.unwrap_or(0.0));

    // Option contract fields + the underlying ticker.
    let (option_type, strike_price, expiration_date, option_code, underlying) =
        if let Some(opt) = &activity.option_symbol {
            let otype = opt.option_type.as_deref().map(|t| {
                if t.eq_ignore_ascii_case("CALL") {
                    "C".to_string()
                } else {
                    "P".to_string()
                }
            });
            let exp = opt.expiration_date.as_deref().and_then(parse_date);
            let code = match (&otype, opt.strike_price, exp) {
                (Some(t), Some(strike), Some(e)) => Some(build_option_code(e, t, strike)),
                _ => None,
            };
            let underlying = activity
                .symbol
                .as_ref()
                .and_then(extract_ticker)
                .or_else(|| opt.underlying_symbol.as_ref().and_then(extract_ticker))
                .or_else(|| opt.ticker.as_deref().and_then(occ_underlying));
            (otype, opt.strike_price, exp, code, underlying)
        } else {
            (
                None,
                None,
                None,
                None,
                activity.symbol.as_ref().and_then(extract_ticker),
            )
        };

    let (ticker_symbol, quantity, price, cost, opt_fields) = match kind {
        ActivityKind::CashFlow => {
            // Dividends carry the paying ticker; pure cash uses the CASH bucket.
            let ticker = if transaction_type == "Dividend" {
                underlying.unwrap_or_else(|| "CASH".to_string())
            } else {
                "CASH".to_string()
            };
            (
                ticker,
                0.0,
                0.0,
                round2(-activity.amount.unwrap_or(0.0)),
                false,
            )
        }
        ActivityKind::Trade | ActivityKind::Corporate => {
            let multiplier = if is_option { 100.0 } else { 1.0 };
            let signed_qty = units * multiplier;
            // Corporate actions are recorded with a positive magnitude.
            let quantity = if kind == ActivityKind::Corporate {
                signed_qty.abs()
            } else {
                signed_qty
            };
            let price = activity.price.unwrap_or(0.0);
            let ticker = underlying.unwrap_or_else(|| "CASH".to_string());
            (ticker, quantity, price, round2(price * quantity), true)
        }
    };
    // Fold renamed tickers onto their canonical symbol (e.g. FB -> META).
    let ticker_symbol = canonical_ticker(ticker_symbol);

    Some(NormalizedTxn {
        account_code: account_code.to_string(),
        ticker_symbol,
        transaction_type,
        quantity,
        price,
        cost,
        fees,
        date,
        option_type: if opt_fields { option_type } else { None },
        strike_price: if opt_fields { strike_price } else { None },
        expiration_date: if opt_fields { expiration_date } else { None },
        option_code: if opt_fields { option_code } else { None },
        status: "open".to_string(),
        source: "snaptrade".to_string(),
    })
}

fn title_case(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let mut chars = lower.chars();
    match chars.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}

/// Probe a brokerage symbol JSON object for the underlying ticker string. Shapes
/// seen in the wild: a bare string, `{symbol: "AAPL"}`, `{raw_symbol: "AAPL"}`,
/// or `{symbol: {symbol: "AAPL"}}`.
pub fn extract_ticker(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    for key in ["symbol", "raw_symbol", "ticker"] {
        if let Some(inner) = v.get(key) {
            if let Some(s) = inner.as_str() {
                return Some(s.to_string());
            }
            if let Some(s) = inner.get("symbol").and_then(|x| x.as_str()) {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// Extract the underlying ticker from an OCC option symbol by taking the leading
/// alphabetic run (e.g. "AAPL250131C00420000" -> "AAPL").
fn occ_underlying(occ: &str) -> Option<String> {
    let u: String = occ
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect();
    if u.is_empty() {
        None
    } else {
        Some(u)
    }
}

/// Build RobinLab's compact option code (YYMMDD + C/P + strike), the inverse of
/// the `parse_option_code` used by the Excel importer.
use crate::broker::build_option_code;

/// Round a currency amount to cents, avoiding float artifacts like
/// `4.9 * 200 = 980.0000000000001`.
fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// Map a renamed ticker to its canonical symbol so history and current activity
/// share one ticker. Extend this list as more renames come up.
pub fn canonical_ticker(symbol: String) -> String {
    match symbol.as_str() {
        "FB" => "META".to_string(),
        _ => symbol,
    }
}

fn parse_date(s: &str) -> Option<NaiveDate> {
    let s = s.trim();
    if s.len() >= 10 {
        if let Ok(d) = NaiveDate::parse_from_str(&s[0..10], "%Y-%m-%d") {
            return Some(d);
        }
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_option_code_from_parts() {
        let exp = NaiveDate::from_ymd_opt(2025, 1, 31).unwrap();
        assert_eq!(build_option_code(exp, "P", 420.0), "250131P420");
        assert_eq!(build_option_code(exp, "C", 420.5), "250131C420.5");
    }

    #[test]
    fn extracts_occ_underlying() {
        assert_eq!(
            occ_underlying("AAPL250131C00420000").as_deref(),
            Some("AAPL")
        );
        assert_eq!(occ_underlying("123").as_deref(), None);
    }

    #[test]
    fn extracts_ticker_from_shapes() {
        assert_eq!(extract_ticker(&json!("AAPL")).as_deref(), Some("AAPL"));
        assert_eq!(
            extract_ticker(&json!({"symbol": "MSFT"})).as_deref(),
            Some("MSFT")
        );
        assert_eq!(
            extract_ticker(&json!({"symbol": {"symbol": "TSLA"}})).as_deref(),
            Some("TSLA")
        );
    }

    #[test]
    fn classifies_types_and_actions() {
        assert_eq!(
            classify("SELL", Some("SELL_TO_OPEN"), true, true).unwrap(),
            ("Sell short".to_string(), ActivityKind::Trade)
        );
        assert_eq!(
            classify("BUY", Some("BUY_TO_CLOSE"), true, true).unwrap(),
            ("Buy to cover".to_string(), ActivityKind::Trade)
        );
        assert_eq!(
            classify("SELL", Some("SELL_TO_CLOSE"), true, true).unwrap(),
            ("Sell".to_string(), ActivityKind::Trade)
        );
        assert_eq!(
            classify("SELL", None, false, true).unwrap(),
            ("Sell".to_string(), ActivityKind::Trade)
        );
        assert_eq!(
            classify("OPTIONASSIGNMENT", None, true, true).unwrap(),
            ("Assigned".to_string(), ActivityKind::Corporate)
        );
        assert_eq!(
            classify("DIVIDEND", None, false, false).unwrap(),
            ("Dividend".to_string(), ActivityKind::CashFlow)
        );
        assert_eq!(classify("", None, false, false), None);
    }

    fn option_activity(
        symbol: &str,
        occ: &str,
        otype: &str,
        strike: f64,
        exp: &str,
        action: &str,
        ty: &str,
        units: f64,
        price: f64,
        amount: f64,
        fee: f64,
    ) -> Activity {
        Activity {
            symbol: Some(json!(symbol)),
            option_symbol: Some(OptionSymbol {
                ticker: Some(occ.to_string()),
                option_type: Some(otype.to_string()),
                strike_price: Some(strike),
                expiration_date: Some(exp.to_string()),
                underlying_symbol: None,
            }),
            price: Some(price),
            units: Some(units),
            amount: Some(amount),
            activity_type: Some(ty.to_string()),
            option_type: Some(action.to_string()),
            trade_date: Some("2026-06-16T16:44:53Z".to_string()),
            settlement_date: None,
            fee: Some(fee),
        }
    }

    // Real DIS fill: sell-to-open 5 puts @ 2.47.
    #[test]
    fn normalizes_short_option_sell_to_existing_convention() {
        let act = option_activity(
            "DIS",
            "DIS   260717P00100000",
            "PUT",
            100.0,
            "2026-07-17",
            "SELL_TO_OPEN",
            "SELL",
            -5.0,
            2.47,
            1235.0,
            0.4,
        );
        let n = activity_to_normalized(&act, "SL#RH").unwrap();
        assert_eq!(n.transaction_type, "Sell short");
        assert_eq!(n.ticker_symbol, "DIS");
        assert_eq!(n.quantity, -500.0); // 5 contracts * 100, signed
        assert_eq!(n.price, 2.47);
        assert_eq!(n.cost, -1235.0); // price * signed_quantity
        assert_eq!(n.fees, Some(0.4));
        assert_eq!(n.option_code.as_deref(), Some("260717P100"));
        assert_eq!(n.option_type.as_deref(), Some("P"));
        assert_eq!(n.strike_price, Some(100.0));
    }

    #[test]
    fn normalizes_long_option_buy() {
        let act = option_activity(
            "TSLA",
            "TSLA  260717C00635000",
            "CALL",
            635.0,
            "2026-07-17",
            "BUY_TO_OPEN",
            "BUY",
            1.0,
            0.54,
            -54.0,
            0.0,
        );
        let n = activity_to_normalized(&act, "SL#RH").unwrap();
        assert_eq!(n.transaction_type, "Buy");
        assert_eq!(n.quantity, 100.0);
        assert_eq!(n.cost, 54.0); // 0.54 * 100
        assert_eq!(n.option_code.as_deref(), Some("260717C635"));
    }

    #[test]
    fn normalizes_stock_sell_signed() {
        let act = Activity {
            symbol: Some(json!("UNH")),
            option_symbol: None,
            price: Some(320.0),
            units: Some(-200.0),
            amount: Some(64000.0),
            activity_type: Some("SELL".to_string()),
            option_type: None,
            trade_date: Some("2026-06-13".to_string()),
            settlement_date: None,
            fee: Some(0.0),
        };
        let n = activity_to_normalized(&act, "SL#RH").unwrap();
        assert_eq!(n.transaction_type, "Sell");
        assert_eq!(n.ticker_symbol, "UNH");
        assert_eq!(n.quantity, -200.0);
        assert_eq!(n.cost, -64000.0);
        assert!(n.option_code.is_none());
    }

    #[test]
    fn normalizes_dividend_as_negative_cost_cashflow() {
        let act = Activity {
            symbol: Some(json!("KO")),
            option_symbol: None,
            price: Some(0.0),
            units: Some(0.0),
            amount: Some(6707.94),
            activity_type: Some("DIVIDEND".to_string()),
            option_type: None,
            trade_date: Some("2026-06-02".to_string()),
            settlement_date: None,
            fee: Some(0.0),
        };
        let n = activity_to_normalized(&act, "SL#RH").unwrap();
        assert_eq!(n.transaction_type, "Dividend");
        assert_eq!(n.ticker_symbol, "KO");
        assert_eq!(n.quantity, 0.0);
        assert_eq!(n.cost, -6707.94);
    }

    #[test]
    fn normalizes_assignment_positive_magnitude() {
        let act = option_activity(
            "UNH",
            "UNH   260717C00320000",
            "CALL",
            320.0,
            "2026-07-17",
            "",
            "OPTIONASSIGNMENT",
            -2.0,
            0.0,
            0.0,
            0.0,
        );
        let n = activity_to_normalized(&act, "SL#RH").unwrap();
        assert_eq!(n.transaction_type, "Assigned");
        assert_eq!(n.quantity, 200.0); // abs(-2) * 100
        assert_eq!(n.cost, 0.0);
        assert_eq!(n.option_code.as_deref(), Some("260717C320"));
    }
}
