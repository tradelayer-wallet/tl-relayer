//! Explicit chain and network identity. A network is never inferred from an
//! address prefix; address decoding takes a [`Network`] argument and rejects
//! addresses that belong elsewhere.

use crate::error::{Error, Result};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Chain {
    Bitcoin,
    Litecoin,
    Dogecoin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Net {
    Main,
    Test,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Network {
    pub chain: Chain,
    pub net: Net,
}

impl Network {
    pub const BTC: Network = Network::new(Chain::Bitcoin, Net::Main);
    pub const BTC_TEST: Network = Network::new(Chain::Bitcoin, Net::Test);
    pub const LTC: Network = Network::new(Chain::Litecoin, Net::Main);
    pub const LTC_TEST: Network = Network::new(Chain::Litecoin, Net::Test);
    pub const DOGE: Network = Network::new(Chain::Dogecoin, Net::Main);
    pub const DOGE_TEST: Network = Network::new(Chain::Dogecoin, Net::Test);
    pub const ALL: [Network; 6] = [
        Network::BTC,
        Network::BTC_TEST,
        Network::LTC,
        Network::LTC_TEST,
        Network::DOGE,
        Network::DOGE_TEST,
    ];

    pub const fn new(chain: Chain, net: Net) -> Network {
        Network { chain, net }
    }

    /// Strict, exact-token parse. Accepts the legacy env codes (`LTC`, `LTCTEST`,
    /// `BTC`, `BTCTEST`) and the collator names (`litecoin.testnet`, ...). It never
    /// uses substring matching (the legacy `normalizeNetwork` did, and mapped any
    /// unknown `*TEST*` string to `LTCTEST`).
    pub fn parse(s: &str) -> Result<Network> {
        let t = s.trim();
        if t.is_empty() || t.len() > 32 {
            return Err(Error::InvalidNetwork(truncate(t)));
        }
        let lower = t.to_ascii_lowercase();
        for n in Network::ALL {
            if lower == n.legacy_code().to_ascii_lowercase() || lower == n.collator_name() {
                return Ok(n);
            }
        }
        Err(Error::InvalidNetwork(truncate(t)))
    }

    /// Legacy env code (`NETWORK=LTCTEST`).
    pub const fn legacy_code(&self) -> &'static str {
        match (self.chain, self.net) {
            (Chain::Bitcoin, Net::Main) => "BTC",
            (Chain::Bitcoin, Net::Test) => "BTCTEST",
            (Chain::Litecoin, Net::Main) => "LTC",
            (Chain::Litecoin, Net::Test) => "LTCTEST",
            (Chain::Dogecoin, Net::Main) => "DOGE",
            (Chain::Dogecoin, Net::Test) => "DOGETEST",
        }
    }

    /// Network name used in collator `/rpc/route` requests.
    pub const fn collator_name(&self) -> &'static str {
        match (self.chain, self.net) {
            (Chain::Bitcoin, Net::Main) => "bitcoin.mainnet",
            (Chain::Bitcoin, Net::Test) => "bitcoin.testnet",
            (Chain::Litecoin, Net::Main) => "litecoin.mainnet",
            (Chain::Litecoin, Net::Test) => "litecoin.testnet",
            (Chain::Dogecoin, Net::Main) => "dogecoin.mainnet",
            (Chain::Dogecoin, Net::Test) => "dogecoin.testnet",
        }
    }

    pub const fn is_test(&self) -> bool {
        matches!(self.net, Net::Test)
    }

    /// Base58 P2PKH version byte. Values match the legacy `networks` table for
    /// BTC/LTC (`tx.service.ts:22-71`); Dogecoin values are from its chainparams.
    pub const fn p2pkh_version(&self) -> u8 {
        match (self.chain, self.net) {
            (Chain::Bitcoin, Net::Main) => 0x00,
            (Chain::Litecoin, Net::Main) => 0x30,
            (Chain::Dogecoin, Net::Main) => 0x1e,
            (Chain::Dogecoin, Net::Test) => 0x71,
            (_, Net::Test) => 0x6f,
        }
    }

    pub const fn p2sh_version(&self) -> u8 {
        match (self.chain, self.net) {
            (Chain::Bitcoin, Net::Main) => 0x05,
            (Chain::Bitcoin, Net::Test) => 0xc4,
            (Chain::Litecoin, Net::Main) => 0x32,
            (Chain::Litecoin, Net::Test) => 0x3a,
            (Chain::Dogecoin, Net::Main) => 0x16,
            (Chain::Dogecoin, Net::Test) => 0xc4,
        }
    }

    /// Segwit human-readable part; Dogecoin has no segwit.
    pub const fn bech32_hrp(&self) -> Option<&'static str> {
        match (self.chain, self.net) {
            (Chain::Bitcoin, Net::Main) => Some("bc"),
            (Chain::Bitcoin, Net::Test) => Some("tb"),
            (Chain::Litecoin, Net::Main) => Some("ltc"),
            (Chain::Litecoin, Net::Test) => Some("tltc"),
            (Chain::Dogecoin, _) => None,
        }
    }

    /// Conservative dust threshold in satoshis (policy, not consensus).
    pub const fn dust_sats(&self) -> u64 {
        match self.chain {
            Chain::Dogecoin => 1_000_000,
            _ => 546,
        }
    }

    /// Upper bound for a single amount on the chain.
    pub const fn max_money_sats(&self) -> u64 {
        match self.chain {
            Chain::Bitcoin => 21_000_000 * 100_000_000,
            Chain::Litecoin => 84_000_000 * 100_000_000,
            Chain::Dogecoin => 10_000_000_000 * 100_000_000,
        }
    }

    /// Whether the chain has segwit (Dogecoin does not).
    pub const fn has_segwit(&self) -> bool {
        !matches!(self.chain, Chain::Dogecoin)
    }
}

impl fmt::Display for Network {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.legacy_code())
    }
}

fn truncate(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(32).collect()
}
