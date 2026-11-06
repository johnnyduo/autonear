//! Shared test support (unit tests and the conformance harness). Compiled only for tests.

use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use std::panic::{catch_unwind, AssertUnwindSafe};

pub const VAULT: &str = "vault.testnet";
pub const OWNER: &str = "owner.testnet";
pub const AGENT: &str = "agent.testnet";
pub const OTHER: &str = "other.testnet";
pub const NEW_OWNER: &str = "newowner.testnet";
pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// 1 abstract conformance unit = 1e21 yoctoNEAR (spec "NEAR harness" note).
pub const SCALE: u128 = 1_000_000_000_000_000_000_000;
pub const BYTE_COST: u128 = 10_000_000_000_000_000_000;
pub const T0: u64 = 1_700_000_000;

/// Two distinct tiny, valid wasm modules (t1, t2). t2 = t1 + a one-byte custom section named "x".
pub const WASM_T1: &[u8] = b"\0asm\x01\0\0\0";
pub const WASM_T2: &[u8] = b"\0asm\x01\0\0\0\0\x02\x01x";

pub fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

pub fn hash_hex(code: &[u8]) -> String {
    to_hex(&env::sha256_array(code))
}

/// account_balance such that `available() == avail` for the given storage usage.
pub fn balance_for(avail: u128, storage_usage: u64) -> u128 {
    avail + u128::from(storage_usage) * BYTE_COST + RESERVE_YOCTO
}

pub struct Ctx {
    pub who: String,
    /// Seconds.
    pub t: u64,
    /// Value of `available()` the mocked balance should produce.
    pub avail: u128,
    pub storage_usage: u64,
    pub attached: u128,
}

impl Ctx {
    pub fn new(who: &str, t: u64, avail: u128) -> Self {
        Ctx {
            who: who.to_string(),
            t,
            avail,
            storage_usage: 5_000,
            attached: 0,
        }
    }
    pub fn su(mut self, s: u64) -> Self {
        self.storage_usage = s;
        self
    }
    pub fn attach(mut self, a: u128) -> Self {
        self.attached = a;
        self
    }
    /// Installs the mocked blockchain (storage is carried over from the previous context).
    pub fn set(&self) {
        // The real runtime credits the attached deposit to the balance before execution.
        let bal = balance_for(self.avail, self.storage_usage) + self.attached;
        testing_env!(VMContextBuilder::new()
            .current_account_id(acct(VAULT))
            .signer_account_id(acct(&self.who))
            .predecessor_account_id(acct(&self.who))
            .block_timestamp(self.t * NS_PER_SEC)
            .storage_usage(self.storage_usage)
            .account_balance(NearToken::from_yoctonear(bal))
            .attached_deposit(NearToken::from_yoctonear(self.attached))
            .build());
    }
}

/// Drops all persisted storage of the mocked blockchain (fresh contract account).
pub fn reset_storage() {
    near_sdk::mock::with_mocked_blockchain(|b| {
        b.take_storage();
    });
}

/// Runs `f`; `Err(code)` for an `E_<Code>:` revert, panics on any other panic shape.
pub fn try_call<R>(f: impl FnOnce() -> R) -> Result<R, String> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(r) => Ok(r),
        Err(e) => {
            let m = panic_message(&e);
            Err(code_of(&m).unwrap_or_else(|| panic!("non-vault panic: {m:?}")))
        }
    }
}

pub fn panic_message(e: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = e.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = e.downcast_ref::<&str>() {
        (*s).to_string()
    } else {
        String::from("<non-string panic>")
    }
}

/// Extracts `X` from a message that STARTS WITH `E_X:` (the panic text may be wrapped by the mock).
pub fn code_of(msg: &str) -> Option<String> {
    let rest = &msg[msg.find("E_")? + 2..];
    let code = &rest[..rest.find(':')?];
    #[cfg(feature = "payouts")]
    let extra = Code::PAYOUTS.iter();
    #[cfg(not(feature = "payouts"))]
    let extra = [].iter();
    Code::ALL
        .iter()
        .chain(extra)
        .any(|c| c.as_str() == code)
        .then(|| code.to_string())
}

pub fn expect_code<R>(code: &str, f: impl FnOnce() -> R) {
    match try_call(f) {
        Ok(_) => panic!("expected E_{code}, but the call succeeded"),
        Err(c) => assert_eq!(c, code, "wrong error code"),
    }
}
