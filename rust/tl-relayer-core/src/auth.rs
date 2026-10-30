//! Authenticated capability policy. The legacy relayer had no authentication on
//! registry mutation. Authentication itself (tokens, mTLS, sessions) is an
//! adapter concern; the core only sees the resulting [`AuthContext`].

use crate::error::{Error, Result};
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Principal(String);

impl Principal {
    /// 1-64 chars of `[A-Za-z0-9._:@-]`.
    pub fn new(s: &str) -> Result<Principal> {
        if s.is_empty()
            || s.len() > 64
            || !s
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:@-".contains(&b))
        {
            return Err(Error::InvalidField("principal"));
        }
        Ok(Principal(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Capability {
    /// Register watch-only accounts and read one's own entries.
    Register,
    /// Read every registry entry (operators).
    ReadAll,
    /// Write UTXO/token/scan snapshots (providers, scanner nodes, the service).
    WriteSnapshot,
    /// Faucet requests (testnet only).
    Faucet,
    /// Everything, including bootstrap, rescan and removal of foreign entries.
    Admin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthContext {
    principal: Option<Principal>,
    caps: BTreeSet<Capability>,
}

impl AuthContext {
    pub fn anonymous() -> AuthContext {
        AuthContext {
            principal: None,
            caps: BTreeSet::new(),
        }
    }

    pub fn new(principal: Principal, caps: &[Capability]) -> AuthContext {
        AuthContext {
            principal: Some(principal),
            caps: caps.iter().copied().collect(),
        }
    }

    /// The service's own identity for internal bookkeeping writes (token
    /// snapshots of provider responses). Never constructible from request data.
    pub fn system() -> AuthContext {
        AuthContext {
            principal: Some(Principal("system".to_string())),
            caps: [Capability::Admin].into_iter().collect(),
        }
    }

    pub fn principal(&self) -> Option<&Principal> {
        self.principal.as_ref()
    }

    pub fn has(&self, c: Capability) -> bool {
        self.caps.contains(&Capability::Admin) || self.caps.contains(&c)
    }

    /// Require an authenticated principal holding `c`.
    pub fn require(&self, c: Capability) -> Result<&Principal> {
        let p = self.principal.as_ref().ok_or(Error::Unauthorized)?;
        if self.has(c) {
            Ok(p)
        } else {
            Err(Error::Forbidden("missing capability"))
        }
    }
}
