//! Shared US market calendar; callers supply dates explicitly.
use chrono::{Datelike, Duration, NaiveDate, Weekday};

fn observed_date_for_fixed_holiday(year: i32, month: u32, day: u32) -> Option<NaiveDate> {
    let holiday = NaiveDate::from_ymd_opt(year, month, day)?;
    Some(match holiday.weekday() {
        Weekday::Sat => holiday - Duration::days(1),
        Weekday::Sun => holiday + Duration::days(1),
        _ => holiday,
    })
}

fn is_observed_fixed_holiday(date: NaiveDate, month: u32, day: u32) -> bool {
    for year in [date.year() - 1, date.year(), date.year() + 1] {
        if let Some(observed) = observed_date_for_fixed_holiday(year, month, day) {
            if observed == date {
                return true;
            }
        }
    }
    false
}

fn nth_weekday_of_month(year: i32, month: u32, weekday: Weekday, nth: u32) -> Option<NaiveDate> {
    if nth == 0 {
        return None;
    }

    let mut date = NaiveDate::from_ymd_opt(year, month, 1)?;
    while date.weekday() != weekday {
        date = date.succ_opt()?;
    }

    for _ in 1..nth {
        date += Duration::days(7);
        if date.month() != month {
            return None;
        }
    }

    Some(date)
}

fn last_weekday_of_month(year: i32, month: u32, weekday: Weekday) -> Option<NaiveDate> {
    let first_of_next_month = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)?
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)?
    };

    let mut date = first_of_next_month - Duration::days(1);
    while date.weekday() != weekday {
        date -= Duration::days(1);
    }

    Some(date)
}

fn easter_sunday(year: i32) -> Option<NaiveDate> {
    let a = year % 19;
    let b = year / 100;
    let c = year % 100;
    let d = b / 4;
    let e = b % 4;
    let f = (b + 8) / 25;
    let g = (b - f + 1) / 3;
    let h = (19 * a + b - d - g + 15) % 30;
    let i = c / 4;
    let k = c % 4;
    let l = (32 + 2 * e + 2 * i - h - k) % 7;
    let m = (a + 11 * h + 22 * l) / 451;
    let month = (h + l - 7 * m + 114) / 31;
    let day = ((h + l - 7 * m + 114) % 31) + 1;

    NaiveDate::from_ymd_opt(year, month as u32, day as u32)
}

fn is_us_market_holiday(date: NaiveDate) -> bool {
    let year = date.year();

    if is_observed_fixed_holiday(date, 1, 1) {
        return true; // New Year's Day
    }
    if Some(date) == nth_weekday_of_month(year, 1, Weekday::Mon, 3) {
        return true; // Martin Luther King Jr. Day
    }
    if Some(date) == nth_weekday_of_month(year, 2, Weekday::Mon, 3) {
        return true; // Presidents' Day
    }
    if let Some(easter) = easter_sunday(year) {
        if date == easter - Duration::days(2) {
            return true; // Good Friday
        }
    }
    if Some(date) == last_weekday_of_month(year, 5, Weekday::Mon) {
        return true; // Memorial Day
    }
    if year >= 2022 && is_observed_fixed_holiday(date, 6, 19) {
        return true; // Juneteenth
    }
    if is_observed_fixed_holiday(date, 7, 4) {
        return true; // Independence Day
    }
    if Some(date) == nth_weekday_of_month(year, 9, Weekday::Mon, 1) {
        return true; // Labor Day
    }
    if Some(date) == nth_weekday_of_month(year, 11, Weekday::Thu, 4) {
        return true; // Thanksgiving
    }
    if is_observed_fixed_holiday(date, 12, 25) {
        return true; // Christmas
    }

    false
}

pub fn is_us_market_trading_day(date: NaiveDate) -> bool {
    !matches!(date.weekday(), Weekday::Sat | Weekday::Sun) && !is_us_market_holiday(date)
}

pub fn trading_dates_between(start_date: NaiveDate, end_date: NaiveDate) -> Vec<NaiveDate> {
    if start_date > end_date {
        return Vec::new();
    }

    let mut dates = Vec::new();
    let mut date = start_date;

    loop {
        if is_us_market_trading_day(date) {
            dates.push(date);
        }

        if date >= end_date {
            break;
        }

        match date.succ_opt() {
            Some(next) => date = next,
            None => break,
        }
    }

    dates
}
