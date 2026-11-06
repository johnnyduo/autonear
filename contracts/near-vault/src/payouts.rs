//! Token payouts (cargo feature `payouts`, behaviour version 1.1.0). Stage 1 only: money flows OUT.
//!
//! The owner funds the vault with an NEP-141 token (USDC first), allowlists tokens (with per-pay /
//! per-period / total caps) and payees; the mandate agent can then `pay` an allowlisted payee from an
//! allowlisted token inside those caps. The only outbound call to a token is `ft_transfer` (1
//! yoctoNEAR, never `ft_transfer_call`). Design: docs/superpowers/specs/2026-11-06-stablecoin-payouts-design.md.
//!
//! Isolation from v1: none of this is compiled without the feature, so the default wasm stays
//! byte-identical to the attested v1. The payout state lives under its OWN storage key (`p:state`),
//! not in the `Vault` struct, so the borsh layout of the v1 state is untouched.
//!
//! The token budget reuses the NEAR mandate's clock, agent, expiry, revoke, pause and `epoch`
//! (`period_secs`, `start`, `gate`). Token usage is stamped with the epoch it was charged in; a
//! `set_mandate` bumps the epoch, so older usage reads as zero (nothing to clear). Re-allowing a
//! token (or disallowing and allowing it again) never resets usage.

use crate::errors::{fail, or_abort, Code, Fail};
use crate::events::PayEvent;
use crate::{is_zero_account, now_secs, Mandate, Vault, VaultExt, DEFAULT_PAGE, MAX_PAGE, TGAS};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{borsh, env, near, require, AccountId, Gas, NearToken, PromiseResult};

pub const MAX_TOKENS: u32 = 8;
pub const MAX_PAYEES: u32 = 64;
pub const MAX_MEMO_BYTES: usize = 128;
/// Gas given to the token's `ft_transfer` (a plain NEP-141 transfer needs far less).
pub const FT_TRANSFER_GAS: u64 = 30 * TGAS;
/// Static gas reserved for `on_paid` (loads/saves the payout state).
pub const PAY_CALLBACK_GAS: u64 = 10 * TGAS;
/// Static gas reserved for `on_token_withdrawn` (one log).
pub const WITHDRAW_CALLBACK_GAS: u64 = 5 * TGAS;
/// The deposit `ft_transfer` requires (NEP-141 security: 1 yoctoNEAR).
const ONE_YOCTO: u128 = 1;

const STATE_KEY: &[u8] = b"p:state";

#[near(serializers=[borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TokenLimits {
    per_pay_cap: u128,
    period_cap: u128,
    total_cap: u128,
}

/// Spend of one token, valid for the mandate epoch it was charged in (a stale epoch reads as zero).
#[near(serializers=[borsh])]
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
struct TokenUsage {
    epoch: u64,
    total: u128,
    /// Period `period` belongs to (re-based lazily on the next charge).
    period_index: u64,
    period: u128,
}

/// All payout state. Persisted whole under `STATE_KEY`: the store collections keep their length /
/// free-list metadata in the struct, so a handle must be saved after every mutation.
#[near(serializers=[borsh])]
struct Payouts {
    tokens: IterableMap<AccountId, TokenLimits>,
    /// Kept for tokens that are disallowed again, so a later re-allow cannot reset the usage.
    usage: LookupMap<AccountId, TokenUsage>,
    payees: IterableSet<AccountId>,
}

impl Payouts {
    fn fresh() -> Self {
        Payouts {
            tokens: IterableMap::new(b"p:tok".to_vec()),
            usage: LookupMap::new(b"p:use".to_vec()),
            payees: IterableSet::new(b"p:pay".to_vec()),
        }
    }

    fn load() -> Self {
        match env::storage_read(STATE_KEY) {
            Some(bytes) => borsh::from_slice(&bytes)
                .unwrap_or_else(|_| env::panic_str("payout state is corrupt")),
            None => Self::fresh(),
        }
    }

    fn save(&mut self) {
        self.tokens.flush();
        self.usage.flush();
        self.payees.flush();
        let bytes = borsh::to_vec(self).unwrap_or_else(|_| env::panic_str("payout state"));
        env::storage_write(STATE_KEY, &bytes);
    }

    /// Usage effective in `epoch`: stored values, or zeros when the record is from an older epoch.
    fn usage_in(&self, token: &AccountId, epoch: u64) -> TokenUsage {
        match self.usage.get(token) {
            Some(u) if u.epoch == epoch => *u,
            _ => TokenUsage {
                epoch,
                ..TokenUsage::default()
            },
        }
    }
}

fn period_spent_in(u: &TokenUsage, idx: u64) -> u128 {
    if u.period_index == idx {
        u.period
    } else {
        0
    }
}

#[near(serializers=[json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenView {
    pub token: AccountId,
    pub per_pay_cap: U128,
    pub period_cap: U128,
    pub total_cap: U128,
}

#[near(serializers=[json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenUsageView {
    pub total_spent: U128,
    /// Stored (lazily re-based) values of the current epoch; zeros for an older epoch. Use
    /// `token_period_state` for the figures effective at a given time.
    pub period_index: U64,
    pub period_spent: U128,
}

#[near(serializers=[json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenPeriodStateView {
    pub period_index: U64,
    pub period_start: U64,
    pub period_end: U64,
    pub period_spent: U128,
    pub period_remaining: U128,
    pub total_spent: U128,
    pub total_remaining: U128,
    pub active: bool,
}

/// Account ids a payout rule must never accept as vault, token or payee.
fn reserved(a: &AccountId) -> bool {
    is_zero_account(a.as_str()) || *a == env::current_account_id()
}

/// `ft_transfer(receiver_id, amount, memo?)` on `token`, 1 yoctoNEAR from the vault balance, then
/// `callback` on the vault (whose promise is returned, so the transaction outcome includes it).
fn ft_transfer_then(
    token: &AccountId,
    receiver: &AccountId,
    amount: U128,
    memo: Option<&str>,
    callback: &str,
    callback_args: Vec<u8>,
    callback_gas: u64,
) {
    let mut args = serde_json::Map::new();
    args.insert("receiver_id".into(), json!(receiver));
    args.insert("amount".into(), json!(amount));
    if let Some(m) = memo {
        args.insert("memo".into(), Value::String(m.to_string()));
    }
    let args = serde_json::to_vec(&Value::Object(args))
        .unwrap_or_else(|_| env::panic_str("ft_transfer args"));
    let transfer = env::promise_batch_create(token);
    env::promise_batch_action_function_call(
        transfer,
        "ft_transfer",
        &args,
        NearToken::from_yoctonear(ONE_YOCTO),
        Gas::from_gas(FT_TRANSFER_GAS),
    );
    let cb = env::promise_batch_then(transfer, &env::current_account_id());
    env::promise_batch_action_function_call(
        cb,
        callback,
        &callback_args,
        NearToken::from_yoctonear(0),
        Gas::from_gas(callback_gas),
    );
    env::promise_return(cb);
}

#[near]
impl Vault {
    // ------------------------------------------------------------ owner ops

    /// Allowlists `token` (an NEP-141 contract) with its own caps, or updates the caps of an allowed
    /// one (usage is kept). `0 < per_pay_cap <= period_cap <= total_cap`; at most 8 tokens; the token
    /// must not be the vault, a zero account or a currently allowed payee: else `E_BadToken`.
    pub fn allow_token(
        &mut self,
        token: AccountId,
        per_pay_cap: U128,
        period_cap: U128,
        total_cap: U128,
    ) {
        let by = or_abort(self.assert_owner());
        if reserved(&token) {
            fail(Code::BadToken, "invalid token account").abort();
        }
        if !(per_pay_cap.0 > 0 && per_pay_cap.0 <= period_cap.0 && period_cap.0 <= total_cap.0) {
            fail(Code::BadToken, "token caps out of bounds").abort();
        }
        let mut p = Payouts::load();
        if p.payees.contains(&token) {
            fail(Code::BadToken, "token is an allowed payee").abort();
        }
        let updated = p.tokens.contains_key(&token);
        if !updated && p.tokens.len() >= MAX_TOKENS {
            fail(Code::BadToken, "too many tokens").abort();
        }
        p.tokens.insert(
            token.clone(),
            TokenLimits {
                per_pay_cap: per_pay_cap.0,
                period_cap: period_cap.0,
                total_cap: total_cap.0,
            },
        );
        p.save();
        PayEvent::TokenAllowed {
            token,
            per_pay_cap,
            period_cap,
            total_cap,
            updated,
            by,
        }
        .emit();
    }

    /// Removes the token from the allowlist. Its usage record is kept (a re-allow does not reset it).
    pub fn disallow_token(&mut self, token: AccountId) {
        let by = or_abort(self.assert_owner());
        let mut p = Payouts::load();
        if p.tokens.remove(&token).is_none() {
            fail(Code::TokenNotAllowed, "unknown token").abort();
        }
        p.save();
        PayEvent::TokenDisallowed { token, by }.emit();
    }

    /// Allowlists a payee. Not the vault, a zero account or an allowed token; at most 64 payees
    /// (`E_BadPayee`). Re-allowing a payee is a no-op without an event.
    pub fn allow_payee(&mut self, account: AccountId) {
        let by = or_abort(self.assert_owner());
        if reserved(&account) {
            fail(Code::BadPayee, "invalid payee account").abort();
        }
        let mut p = Payouts::load();
        if p.tokens.contains_key(&account) {
            fail(Code::BadPayee, "payee is an allowed token").abort();
        }
        if p.payees.contains(&account) {
            return;
        }
        if p.payees.len() >= MAX_PAYEES {
            fail(Code::BadPayee, "too many payees").abort();
        }
        p.payees.insert(account.clone());
        p.save();
        PayEvent::PayeeAllowed { payee: account, by }.emit();
    }

    pub fn disallow_payee(&mut self, account: AccountId) {
        let by = or_abort(self.assert_owner());
        let mut p = Payouts::load();
        if !p.payees.remove(&account) {
            fail(Code::PayeeNotAllowed, "unknown payee").abort();
        }
        p.save();
        PayEvent::PayeeDisallowed { payee: account, by }.emit();
    }

    /// Sends `amount` of `token` to the OWNER only (`ft_transfer`, 1 yoctoNEAR from the vault). Works
    /// while paused, revoked or expired, and for any token account (also one that is no longer
    /// allowed), so funds can always be recovered. Nothing is charged, so a failed transfer only logs
    /// `token_withdraw_failed` (via `on_token_withdrawn`).
    pub fn withdraw_token(&mut self, token: AccountId, amount: U128) {
        let owner = or_abort(self.assert_owner());
        if reserved(&token) {
            fail(Code::BadToken, "invalid token account").abort();
        }
        if amount.0 == 0 {
            fail(Code::BadAmount, "amount must be > 0").abort();
        }
        if Self::available_yocto() < ONE_YOCTO {
            fail(Code::InsufficientBalance, "no NEAR for the 1 yocto deposit").abort();
        }
        PayEvent::TokenWithdrawn {
            token: token.clone(),
            to: owner.clone(),
            amount,
        }
        .emit();
        let cb_args = serde_json::to_vec(&json!({
            "token": token,
            "to": owner,
            "amount": amount,
        }))
        .unwrap_or_else(|_| env::panic_str("callback args"));
        ft_transfer_then(
            &token,
            &owner,
            amount,
            None,
            "on_token_withdrawn",
            cb_args,
            WITHDRAW_CALLBACK_GAS,
        );
    }

    /// Callback of `withdraw_token`: only logs a failure.
    #[private]
    pub fn on_token_withdrawn(&mut self, token: AccountId, to: AccountId, amount: U128) {
        require!(
            env::promise_results_count() == 1,
            "expected one promise result"
        );
        if let PromiseResult::Failed = env::promise_result(0) {
            PayEvent::TokenWithdrawFailed { token, to, amount }.emit();
        }
    }

    // ------------------------------------------------------------ agent ops

    /// `ft_transfer(to, amount, memo)` on `token`, 1 yoctoNEAR attached, only to an allowlisted
    /// payee, from an allowlisted token, by the bound agent, inside the token's caps. The charge is
    /// optimistic; `on_paid` reverses it if the transfer failed. Attach >= 100 Tgas.
    pub fn pay(&mut self, token: AccountId, to: AccountId, amount: U128, memo: Option<String>) {
        let caller = env::predecessor_account_id();
        let now = now_secs();
        let mut p = Payouts::load();
        or_abort(self.plan_pay(
            &p,
            &caller,
            &token,
            &to,
            amount.0,
            memo.as_deref(),
            now,
            Self::available_yocto(),
        ));
        // Effects first, then the promise.
        let idx = {
            let m = self
                .mandate
                .as_ref()
                .unwrap_or_else(|| env::panic_str("no mandate"));
            Self::period_index(m, now)
        };
        let mut u = p.usage_in(&token, self.epoch);
        if u.period_index != idx {
            u.period_index = idx;
            u.period = 0;
        }
        u.period += amount.0;
        u.total += amount.0;
        p.usage.insert(token.clone(), u);
        p.save();
        PayEvent::Paid {
            agent: caller,
            token: token.clone(),
            to: to.clone(),
            amount,
            memo: memo.clone(),
            epoch: U64(self.epoch),
            total_spent: U128(u.total),
            period_spent: U128(u.period),
        }
        .emit();
        let cb_args = serde_json::to_vec(&json!({
            "epoch": U64(self.epoch),
            "period_index": U64(idx),
            "token": token,
            "to": to,
            "amount": amount,
        }))
        .unwrap_or_else(|_| env::panic_str("callback args"));
        ft_transfer_then(
            &token,
            &to,
            amount,
            memo.as_deref(),
            "on_paid",
            cb_args,
            PAY_CALLBACK_GAS,
        );
    }

    /// Callback of `pay`. If the transfer failed, the optimistic charge is reversed: only inside the
    /// same mandate epoch (a newer mandate has its own counters and is left alone), `period` only if
    /// the stored period is still the one charged. Saturating, so a replay can never underflow. On
    /// success it does nothing.
    #[private]
    pub fn on_paid(
        &mut self,
        epoch: U64,
        period_index: U64,
        token: AccountId,
        to: AccountId,
        amount: U128,
    ) {
        require!(
            env::promise_results_count() == 1,
            "expected one promise result"
        );
        if let PromiseResult::Failed = env::promise_result(0) {
            let mut reversed = false;
            if epoch.0 == self.epoch {
                let mut p = Payouts::load();
                if let Some(mut u) = p.usage.get(&token).copied() {
                    if u.epoch == epoch.0 {
                        u.total = u.total.saturating_sub(amount.0);
                        if u.period_index == period_index.0 {
                            u.period = u.period.saturating_sub(amount.0);
                        }
                        p.usage.insert(token.clone(), u);
                        p.save();
                        reversed = true;
                    }
                }
            }
            PayEvent::PayFailed {
                token,
                to,
                amount,
                epoch,
                reversed,
            }
            .emit();
        }
    }

    // ------------------------------------------------------------ views

    pub fn tokens(&self) -> Vec<TokenView> {
        Payouts::load()
            .tokens
            .iter()
            .map(|(t, l)| TokenView {
                token: t.clone(),
                per_pay_cap: U128(l.per_pay_cap),
                period_cap: U128(l.period_cap),
                total_cap: U128(l.total_cap),
            })
            .collect()
    }

    /// Allowlisted payees, 50 per page by default, at most 100. Order is insertion order until a
    /// `disallow_payee` moves the last entry into the freed slot.
    pub fn payees(&self, from_index: Option<U64>, limit: Option<U64>) -> Vec<AccountId> {
        let from = usize::try_from(from_index.map_or(0, |v| v.0)).unwrap_or(usize::MAX);
        let limit = usize::try_from(limit.map_or(DEFAULT_PAGE, |v| v.0).min(MAX_PAGE)).unwrap_or(0);
        Payouts::load()
            .payees
            .iter()
            .skip(from)
            .take(limit)
            .cloned()
            .collect()
    }

    /// Spend of `token` in the current mandate epoch (zeros for an unknown token or an older epoch).
    pub fn token_usage(&self, token: AccountId) -> TokenUsageView {
        let u = Payouts::load().usage_in(&token, self.epoch);
        TokenUsageView {
            total_spent: U128(u.total),
            period_index: U64(u.period_index),
            period_spent: U128(u.period),
        }
    }

    /// Token budget figures effective at `now` (seconds; default: current block time). `None`
    /// without a mandate or when the token is not allowed.
    pub fn token_period_state(
        &self,
        token: AccountId,
        now: Option<U64>,
    ) -> Option<TokenPeriodStateView> {
        let now = now.map_or_else(now_secs, |n| n.0);
        let m = self.mandate.as_ref()?;
        let p = Payouts::load();
        let lim = *p.tokens.get(&token)?;
        let idx = Self::period_index(m, now);
        let u = p.usage_in(&token, self.epoch);
        let spent = period_spent_in(&u, idx);
        Some(TokenPeriodStateView {
            period_index: U64(idx),
            period_start: U64(m.start.saturating_add(idx.saturating_mul(m.period_secs))),
            period_end: U64(m
                .start
                .saturating_add(idx.saturating_add(1).saturating_mul(m.period_secs))),
            period_spent: U128(spent),
            period_remaining: U128(lim.period_cap.saturating_sub(spent)),
            total_spent: U128(u.total),
            total_remaining: U128(lim.total_cap.saturating_sub(u.total)),
            active: !m.revoked && now < m.expires_at,
        })
    }

    /// The error code `pay(token, to, amount, <no memo>)` would hit now if called by the bound
    /// agent; "" = ok.
    pub fn preview_pay(&self, token: AccountId, to: AccountId, amount: U128) -> String {
        let caller = self.assumed_agent();
        match self.plan_pay(
            &Payouts::load(),
            &caller,
            &token,
            &to,
            amount.0,
            None,
            now_secs(),
            Self::available_yocto(),
        ) {
            Ok(()) => String::new(),
            Err(f) => f.code.as_str().to_string(),
        }
    }
}

impl Vault {
    /// All `pay` rules, in order: agent gate (NoMandate, Unauthorized, Paused, MandateInactive),
    /// token, payee, amount, per-pay cap, period, total, memo length, 1 yocto available.
    fn plan_pay(
        &self,
        p: &Payouts,
        caller: &AccountId,
        token: &AccountId,
        to: &AccountId,
        amount: u128,
        memo: Option<&str>,
        now: u64,
        available: u128,
    ) -> Result<(), Fail> {
        let m: &Mandate = self.gate(caller, now)?;
        let lim = p
            .tokens
            .get(token)
            .ok_or_else(|| fail(Code::TokenNotAllowed, "token not allowlisted"))?;
        if !p.payees.contains(to) {
            return Err(fail(Code::PayeeNotAllowed, "payee not allowlisted"));
        }
        if amount == 0 {
            return Err(fail(Code::BadAmount, "amount must be > 0"));
        }
        if amount > lim.per_pay_cap {
            return Err(fail(Code::PerPayCap, "per-pay cap exceeded"));
        }
        let u = p.usage_in(token, self.epoch);
        let idx = Self::period_index(m, now);
        // `checked_add`: a sum past u128::MAX is over any cap (also a cap of u128::MAX itself).
        if period_spent_in(&u, idx)
            .checked_add(amount)
            .map_or(true, |s| s > lim.period_cap)
        {
            return Err(fail(Code::PeriodCap, "period cap exceeded"));
        }
        if u.total
            .checked_add(amount)
            .map_or(true, |s| s > lim.total_cap)
        {
            return Err(fail(Code::TotalCap, "total cap exceeded"));
        }
        if memo.is_some_and(|s| s.len() > MAX_MEMO_BYTES) {
            return Err(fail(Code::BadMemo, "memo longer than 128 bytes"));
        }
        if available < ONE_YOCTO {
            return Err(fail(
                Code::InsufficientBalance,
                "no NEAR for the 1 yocto deposit",
            ));
        }
        Ok(())
    }
}
