//! Versioned JSON interface. Transport owns I/O, authentication and durable CAS.
use crate::{
    error::{DomainError, DomainResult},
    repository::*,
    repository_calculations::CalculationInputs,
    repository_format,
    repository_ops::{self, WorkingPortfolio},
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};

pub const INTERFACE_VERSION: u32 = 1;
fn parse<T: DeserializeOwned>(value: &Value) -> DomainResult<T> {
    serde_json::from_value(value.clone())
        .map_err(|_| DomainError::BadRequest("Invalid domain input".into()))
}
fn value<T: Serialize>(value: T) -> DomainResult<Value> {
    serde_json::to_value(value).map_err(|_| RepositoryError::Serialization.into())
}
fn dataset(input: &Value) -> DomainResult<PortfolioDataset> {
    let dataset = PortfolioDataset {
        public: parse(&input["public"])?,
        private: parse(&input["private"])?,
    };
    dataset.validate()?;
    Ok(dataset)
}
fn branch(value: &Value) -> DomainResult<repository_format::EncodedBranch> {
    Ok(repository_format::EncodedBranch {
        root: parse(&value["root"])?,
        documents: parse(&value["documents"])?,
    })
}
fn branch_value(branch: repository_format::EncodedBranch) -> Value {
    json!({"root":branch.root,"documents":branch.documents})
}

pub fn invoke(input: &Value) -> DomainResult<Value> {
    if input["interfaceVersion"].as_u64() != Some(u64::from(INTERFACE_VERSION)) {
        return Err(DomainError::BadRequest(
            "Unsupported domain interface".into(),
        ));
    }
    match input["action"].as_str().unwrap_or("") {
        "identity" => value(CommandIdentity::new(
            input["id"].as_str().unwrap_or(""),
            input["operation"].as_str().unwrap_or(""),
            &input["input"],
        )?),
        "canonical" => Ok(json!({"payload":canonical(&input["value"])?})),
        "encode" => {
            let (public, private) =
                repository_format::encode_dataset(&dataset(&input["dataset"])?)?;
            Ok(json!({"public":branch_value(public),"private":branch_value(private)}))
        }
        "decode" => {
            let dataset = repository_format::decode_dataset(
                &branch(&input["public"])?,
                &branch(&input["private"])?,
            )?;
            Ok(json!({"public":dataset.public,"private":dataset.private}))
        }
        "read" => {
            let dataset = dataset(&input["dataset"])?;
            let args = &input["input"];
            match input["operation"].as_str().unwrap_or("") {
                "accounts" => value(repository_ops::list_accounts(&dataset)),
                "account" => value(repository_ops::get_account(&dataset, parse(&args["id"])?)?),
                "tickers" => value(repository_ops::list_tickers(&dataset)),
                "transactions" => value(repository_ops::list_transactions(&dataset, &parse(args)?)),
                "transaction" => value(repository_ops::get_transaction(
                    &dataset,
                    parse(&args["id"])?,
                )?),
                "summary" => value(CalculationInputs::from_dataset(&dataset).summary()),
                "performance" => {
                    value(CalculationInputs::from_dataset(&dataset).daily_performance())
                }
                "positions" | "yield" | "accounts_performance" => {
                    let inputs = CalculationInputs::from_dataset(&dataset);
                    let latest: Vec<LatestPrice> = parse(&args["latest"])?;
                    let prices = latest
                        .iter()
                        .map(|r| (r.symbol.clone(), r.latest_price))
                        .collect();
                    let dates = latest
                        .iter()
                        .map(|r| (r.symbol.clone(), r.latest_price_date))
                        .collect();
                    match input["operation"].as_str().unwrap() {
                        "positions" => {
                            let mut positions = inputs.positions(
                                parse(&args["account_id"])?,
                                args["include_closed"].as_bool().unwrap_or(false),
                            );
                            robinlab_core::enrich::enrich_positions(
                                &mut positions,
                                &prices,
                                &dates,
                            );
                            value(positions)
                        }
                        "yield" => Ok(
                            json!({"annual_yield_rate":robinlab_core::reports::portfolio_yield(&inputs.transactions, &inputs.accounts, &inputs.symbols, &prices, &dates, parse(&args["today"])?) }),
                        ),
                        _ => value(inputs.account_performance(
                            &dataset,
                            &latest,
                            &parse::<Vec<HistoricalPrice>>(&args["historical"])?,
                            parse(&args["today"])?,
                        )),
                    }
                }
                "ticker_pnl" => value(
                    CalculationInputs::from_dataset(&dataset)
                        .realized_pnl(parse(&args["account_id"])?),
                ),
                _ => Err(DomainError::BadRequest("Unknown domain read".into())),
            }
        }
        "market_rules" => {
            let symbol: String = parse(&input["symbol"])?;
            Ok(
                json!({"fetchable":crate::market_prices::is_remote_fetchable_symbol(&symbol),"split":crate::market_prices::parse_split_suffix(&symbol),"underlying":crate::market_prices::leverage_underlying(&symbol)}),
            )
        }
        "market_payload" => match input["provider"].as_str().unwrap_or("") {
            "twelvedata" => value(crate::market_prices::twelve_series(&input["payload"])),
            "yahoo" => value(crate::market_prices::yahoo_series(
                &input["payload"],
                input["scale"].as_f64().unwrap_or(1.0),
            )),
            "quote" => value(
                crate::market_prices::extract_price(&input["payload"]).filter(|v| v.is_finite()),
            ),
            _ => Err(DomainError::BadRequest("Unknown price payload".into())),
        },
        "cache_range" => {
            let today: chrono::NaiveDate = parse(&input["today"])?;
            let days = input["days"].as_i64().unwrap_or(365).clamp(7, 1825);
            Ok(
                json!({"start":(today-chrono::Duration::days(days-1)).to_string(),"end":today.to_string()}),
            )
        }
        "cache_report" => {
            let rows: Vec<HistoricalPrice> = parse(&input["rows"])?;
            match input["operation"].as_str().unwrap_or("") {
                "coverage" => value(crate::cache_reports::coverage(
                    &rows,
                    parse(&input["symbol"])?,
                    parse(&input["start"])?,
                    parse(&input["end"])?,
                )),
                "trend" => value(crate::cache_reports::trend(
                    rows,
                    parse(&input["symbol"])?,
                    parse(&input["start"])?,
                    parse(&input["end"])?,
                )),
                "usage" => value(crate::cache_reports::usage(
                    &rows,
                    &parse::<Vec<ProviderRequest>>(&input["logs"])?,
                    parse(&input["today"])?,
                    parse(&input["providers"])?,
                )),
                _ => Err(DomainError::BadRequest("Unknown cache report".into())),
            }
        }
        "plan_snaptrade_capture" => crate::snaptrade_capture::plan(
            &dataset(&input["dataset"])?,
            &parse(&input["options"])?,
            parse(&input["today"])?,
        ),
        "normalize_snaptrade_stocks" => value(crate::snaptrade_capture::stocks(
            input["account"]
                .as_str()
                .ok_or_else(|| DomainError::BadRequest("Account code is required".into()))?,
            &input["positions"],
        )),
        "normalize_splits" => value(crate::snaptrade_capture::splits(
            input["symbol"]
                .as_str()
                .ok_or_else(|| DomainError::BadRequest("Symbol is required".into()))?,
            &input["response"],
        )),
        "preview_snaptrade" => {
            let data = dataset(&input["dataset"])?;
            let mut working = WorkingPortfolio {
                next_ids: IdCounters::from_initial_dataset(&data)?,
                dataset: data,
            };
            let options: crate::sync_options::SyncOptions = parse(&input["options"])?;
            if options.apply && !options.roll_detect {
                return Err(DomainError::BadRequest(
                    "Preview cannot apply an import".into(),
                ));
            }
            working.snaptrade(
                &options,
                &parse(&input["captured"])?,
                input["now"].as_str().ok_or_else(|| {
                    DomainError::BadRequest("Explicit preview time is required".into())
                })?,
            )
        }
        "normalize_snaptrade" => {
            let account = input["account"]
                .as_str()
                .ok_or_else(|| DomainError::BadRequest("Account code is required".into()))?;
            let activities: Vec<crate::snaptrade_activity::Activity> = parse(&input["activities"])?;
            value(
                activities
                    .iter()
                    .filter_map(|a| crate::snaptrade_activity::activity_to_normalized(a, account))
                    .collect::<Vec<_>>(),
            )
        }
        "prepare" => {
            let mut working = WorkingPortfolio {
                dataset: dataset(&input["dataset"])?,
                next_ids: parse(&input["nextIds"])?,
            };
            let args = &input["input"];
            let now = input["now"].as_str().ok_or_else(|| {
                DomainError::BadRequest("Explicit command time is required".into())
            })?;
            let operation = input["operation"].as_str().unwrap_or("");
            let response = match operation {
                "create_account" => value(working.create_account(parse(args)?)?)?,
                "create_transaction" => value(working.create_transaction(parse(args)?, now)?)?,
                "update_transaction" => value(working.update_transaction(
                    parse(&args["id"])?,
                    parse(&args["body"])?,
                    now,
                )?)?,
                "delete_transaction" => {
                    let id = parse(&args["id"])?;
                    working.delete_transaction(id)?;
                    json!({"deleted":id})
                }
                "option_roll" | "option_close" | "option_expire" | "option_assign" => {
                    working.option_operation(&operation[7..], args.clone(), now)?
                }
                "link_snaptrade_account" => working.link_brokerage(
                    args["snaptrade_account_id"].as_str().ok_or_else(|| {
                        DomainError::BadRequest("Invalid brokerage account".into())
                    })?,
                    parse(&args["account_id"])?,
                    now,
                )?,
                "discover_snaptrade_accounts" => working.discover_brokerages(
                    &parse::<Vec<crate::broker_management::DiscoveredAccount>>(&args["accounts"])?,
                    input["captured"]["userId"]
                        .as_str()
                        .ok_or_else(|| DomainError::BadRequest("Missing brokerage user".into()))?,
                    now,
                )?,
                "register_snaptrade" => working.register_brokerage(&input["captured"], now)?,
                "import_excel" => {
                    value(working.ingest(&parse::<Vec<_>>(&input["captured"])?, now)?)?
                }
                "import_snaptrade" => {
                    working.snaptrade(&parse(args)?, &parse(&input["captured"])?, now)?
                }
                _ => return Err(DomainError::BadRequest("Unknown domain mutation".into())),
            };
            let head: PortfolioHead = parse(&input["previous"]["head"])?;
            let revision = input["previous"]["revision"]
                .as_str()
                .ok_or(RepositoryError::Format)?;
            let prepared = repository_format::prepare_mutation(
                &working.dataset,
                working.next_ids,
                Some((&head, revision)),
                parse(&input["identity"])?,
                response,
            )?;
            value(prepared)
        }
        _ => Err(DomainError::BadRequest("Unknown domain action".into())),
    }
}

/// Errors retain the native HTTP status/message contract without leaking parse input.
pub fn invoke_json(input: &str) -> String {
    let outcome = serde_json::from_str(input)
        .map_err(|_| DomainError::BadRequest("Invalid domain JSON".into()))
        .and_then(|input| invoke(&input));
    let envelope = match outcome {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(error) => {
            let status = if matches!(error, DomainError::NotFound(_)) {
                404
            } else {
                400
            };
            let message = match error {
                DomainError::NotFound(message)
                | DomainError::BadRequest(message)
                | DomainError::Import(message) => message,
                DomainError::Repository(error) => error.to_string(),
            };
            json!({"ok":false,"status":status,"error":message})
        }
    };
    serde_json::to_string(&envelope).expect("JSON envelope contains no non-JSON values")
}
