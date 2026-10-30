//! Integer money. Amounts are satoshis; decimal coin values are parsed exactly
//! from text (no binary floating point) and anything with more than eight
//! fractional digits is rejected rather than rounded.

use crate::error::{Error, Result};
use crate::network::Network;
use serde_json::Value;

pub const COIN: u64 = 100_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub struct Amount(u64);

impl Amount {
    pub const ZERO: Amount = Amount(0);

    pub const fn from_sat(s: u64) -> Amount {
        Amount(s)
    }

    pub const fn sat(self) -> u64 {
        self.0
    }

    pub fn checked_add(self, o: Amount) -> Result<Amount> {
        self.0
            .checked_add(o.0)
            .map(Amount)
            .ok_or(Error::AmountOverflow)
    }

    pub fn checked_sub(self, o: Amount) -> Result<Amount> {
        self.0
            .checked_sub(o.0)
            .map(Amount)
            .ok_or(Error::AmountOverflow)
    }

    /// Sum with overflow detection.
    pub fn sum<I: IntoIterator<Item = Amount>>(it: I) -> Result<Amount> {
        it.into_iter().try_fold(Amount::ZERO, Amount::checked_add)
    }

    /// Reject values above the chain's money bound.
    pub fn check_money(self, n: Network) -> Result<Amount> {
        if self.0 > n.max_money_sats() {
            Err(Error::InvalidAmount("exceeds chain maximum"))
        } else {
            Ok(self)
        }
    }

    /// Exact decimal parse of a non-negative coin amount: `12`, `0.00001`,
    /// `1e-5`, `1.5E2`. At most 8 fractional digits after exponent expansion.
    pub fn parse_coin(s: &str) -> Result<Amount> {
        let b = s.as_bytes();
        if b.is_empty() || b.len() > 48 {
            return Err(Error::InvalidAmount("empty or too long"));
        }
        let mut i = 0;
        let mut digits: Vec<u8> = Vec::new();
        let mut frac_len: i64 = 0;
        let mut seen_dot = false;
        let mut any_digit = false;
        while i < b.len() {
            match b[i] {
                b'0'..=b'9' => {
                    digits.push(b[i] - b'0');
                    any_digit = true;
                    if seen_dot {
                        frac_len += 1;
                    }
                }
                b'.' if !seen_dot && any_digit => seen_dot = true,
                b'e' | b'E' => break,
                _ => return Err(Error::InvalidAmount("unexpected character")),
            }
            i += 1;
        }
        if !any_digit || (seen_dot && frac_len == 0) {
            return Err(Error::InvalidAmount("no digits"));
        }
        let mut exp: i64 = 0;
        if i < b.len() {
            i += 1; // skip e
            let mut neg = false;
            if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
                neg = b[i] == b'-';
                i += 1;
            }
            if i >= b.len() {
                return Err(Error::InvalidAmount("empty exponent"));
            }
            while i < b.len() {
                if !b[i].is_ascii_digit() {
                    return Err(Error::InvalidAmount("bad exponent"));
                }
                exp = exp * 10 + i64::from(b[i] - b'0');
                if exp > 400 {
                    return Err(Error::InvalidAmount("exponent out of range"));
                }
                i += 1;
            }
            if neg {
                exp = -exp;
            }
        }
        // Strip leading zeros; trailing zeros are consumed while scaling down.
        let Some(first) = digits.iter().position(|d| *d != 0) else {
            return Ok(Amount::ZERO);
        };
        let mut digits = digits.split_off(first);
        // value = digits * 10^(exp - frac_len); in satoshis multiply by 10^8.
        let mut scale: i64 = exp - frac_len + 8;
        while scale < 0 {
            match digits.last() {
                Some(0) => {
                    digits.pop();
                    scale += 1;
                }
                _ => return Err(Error::InvalidAmount("more than 8 decimal places")),
            }
        }
        if digits.len() as i64 + scale > 20 {
            return Err(Error::AmountOverflow);
        }
        let mut v: u128 = 0;
        for d in &digits {
            v = v * 10 + u128::from(*d);
        }
        for _ in 0..scale {
            v = v.checked_mul(10).ok_or(Error::AmountOverflow)?;
        }
        u64::try_from(v)
            .map(Amount)
            .map_err(|_| Error::AmountOverflow)
    }

    /// Accept a JSON number or string holding a coin amount. `serde_json` renders
    /// finite numbers with the shortest round-trip text, which is then parsed
    /// exactly; a float like `0.30000000000000004` is rejected (17 decimals).
    pub fn from_json_coin(v: &Value) -> Result<Amount> {
        match v {
            Value::Number(n) => Amount::parse_coin(&n.to_string()),
            Value::String(s) => Amount::parse_coin(s.trim()),
            _ => Err(Error::InvalidAmount("expected number or string")),
        }
    }

    /// Canonical coin text with exactly eight decimals.
    pub fn to_coin_string(self) -> String {
        format!("{}.{:08}", self.0 / COIN, self.0 % COIN)
    }
}
