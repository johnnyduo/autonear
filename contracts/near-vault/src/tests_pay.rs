//! Unit tests of the `payouts` feature (token payouts, v1.1). Compiled only with `--features payouts`.
//! The shared conformance file does not cover payouts yet (phase 2); everything is tested here.

use super::payouts::*;
use super::testkit::*;
use super::*;
use near_sdk::mock::{MockAction, Receipt};
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::testing_env;
use near_sdk::PromiseResult;

const DAY: u64 = 86_400;
const USDC: u128 = 1_000_000; // 6 decimals
const TOKEN: &str = "usdc.testnet";
const TOKEN2: &str = "usdt.testnet";
const PAYEE: &str = "alice.testnet";
const PAYEE2: &str = "bob.testnet";

struct Fx {
    v: Vault,
    t: u64,
    avail: u128,
    su: u64,
    logs: Vec<String>,
    receipts: Vec<Receipt>,
}

impl Fx {
    fn new(avail: u128) -> Self {
        reset_storage();
        Ctx::new(OWNER, T0, avail).set();
        let v = Vault::new(acct(OWNER), "testnet".into());
        Fx {
            v,
            t: T0,
            avail,
            su: env::storage_usage().max(5_000),
            logs: vec![],
            receipts: vec![],
        }
    }

    /// Mandate for AGENT (NEAR caps are irrelevant to payouts): 1 h periods, 1 day.
    fn with_mandate() -> Self {
        let mut fx = Fx::new(1_000 * NEAR);
        fx.set_mandate(AGENT);
        fx
    }

    /// Mandate + TOKEN (per pay 10, period 25, total 100 USDC) + payee PAYEE.
    fn ready() -> Self {
        let mut fx = Fx::with_mandate();
        fx.allow_token(TOKEN, 10 * USDC, 25 * USDC, 100 * USDC)
            .unwrap();
        fx.allow_payee(PAYEE).unwrap();
        fx
    }

    fn set_mandate(&mut self, agent: &str) {
        let t = self.t;
        self.run(OWNER, |v| {
            v.set_mandate(
                agent.into(),
                U64(t + DAY),
                U128(10 * NEAR),
                U64(3600),
                U128(25 * NEAR),
                U128(100 * NEAR),
                5,
            )
        })
        .unwrap();
    }

    fn run<R>(&mut self, who: &str, f: impl FnOnce(&mut Vault) -> R) -> Result<R, String> {
        Ctx::new(who, self.t, self.avail).su(self.su).set();
        let v = &mut self.v;
        let r = try_call(|| f(v));
        self.logs = get_logs();
        self.receipts = get_created_receipts();
        if r.is_ok() {
            self.su = env::storage_usage();
            let sent: u128 = self.receipts.iter().map(value_of).sum();
            self.avail -= sent;
        }
        r
    }

    fn view<R>(&self, f: impl FnOnce(&Vault) -> R) -> R {
        Ctx::new(OWNER, self.t, self.avail).su(self.su).set();
        f(&self.v)
    }

    fn allow_token(
        &mut self,
        token: &str,
        per: u128,
        period: u128,
        total: u128,
    ) -> Result<(), String> {
        self.run(OWNER, |v| {
            v.allow_token(acct(token), U128(per), U128(period), U128(total))
        })
    }

    fn allow_payee(&mut self, a: &str) -> Result<(), String> {
        self.run(OWNER, |v| v.allow_payee(acct(a)))
    }

    fn pay_as(
        &mut self,
        who: &str,
        token: &str,
        to: &str,
        amount: u128,
        memo: Option<&str>,
    ) -> Result<(), String> {
        let memo = memo.map(str::to_string);
        self.run(who, |v| v.pay(acct(token), acct(to), U128(amount), memo))
    }

    fn pay(&mut self, amount: u128) -> Result<(), String> {
        self.pay_as(AGENT, TOKEN, PAYEE, amount, None)
    }

    fn usage(&self, token: &str) -> (u128, u128) {
        let u = self.view(|v| v.token_usage(acct(token)));
        (u.total_spent.0, u.period_spent.0)
    }

    fn preview(&self, token: &str, to: &str, amount: u128) -> String {
        self.view(|v| v.preview_pay(acct(token), acct(to), U128(amount)))
    }

    fn events(&self) -> Vec<Value> {
        events_of(&self.logs)
    }
}

/// Everything that leaves the vault balance in a receipt: transfers plus attached call deposits.
fn value_of(r: &Receipt) -> u128 {
    r.actions
        .iter()
        .map(|a| match a {
            MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
            MockAction::FunctionCallWeight {
                attached_deposit, ..
            } => attached_deposit.as_yoctonear(),
            _ => 0,
        })
        .sum()
}

fn events_of(logs: &[String]) -> Vec<Value> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str(j).expect("event is JSON"))
        .collect()
}

fn ev(e: &Value) -> &str {
    e["event"].as_str().unwrap()
}

/// (method, args, deposit, gas) of the single function call of a receipt.
fn call_of(r: &Receipt) -> (String, Value, u128, u64) {
    assert_eq!(r.actions.len(), 1, "exactly one action: {:?}", r.actions);
    match &r.actions[0] {
        MockAction::FunctionCallWeight {
            method_name,
            args,
            attached_deposit,
            prepaid_gas,
            ..
        } => (
            String::from_utf8(method_name.clone()).unwrap(),
            serde_json::from_slice(args).unwrap(),
            attached_deposit.as_yoctonear(),
            prepaid_gas.as_gas(),
        ),
        other => panic!("not a function call: {other:?}"),
    }
}

fn callback_ctx(fx: &Fx, failed: bool) {
    let result = if failed {
        PromiseResult::Failed
    } else {
        PromiseResult::Successful(vec![])
    };
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acct(VAULT))
            .predecessor_account_id(acct(VAULT))
            .signer_account_id(acct(AGENT))
            .block_timestamp(fx.t * NS_PER_SEC)
            .storage_usage(fx.su)
            .account_balance(NearToken::from_yoctonear(balance_for(fx.avail, fx.su)))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

/// Runs `on_paid` as the contract itself. The runtime refunds the 1 yocto of a failed transfer.
fn paid_callback(fx: &mut Fx, failed: bool, epoch: u64, period: u64, token: &str, amount: u128) {
    callback_ctx(fx, failed);
    fx.v.on_paid(
        U64(epoch),
        U64(period),
        acct(token),
        acct(PAYEE),
        U128(amount),
    );
    fx.logs = get_logs();
    fx.su = env::storage_usage();
    fx.avail += u128::from(failed);
}

fn withdraw_callback(fx: &mut Fx, failed: bool, token: &str, amount: u128) {
    callback_ctx(fx, failed);
    fx.v.on_token_withdrawn(acct(token), acct(OWNER), U128(amount));
    fx.logs = get_logs();
    fx.su = env::storage_usage();
    fx.avail += u128::from(failed);
}

// ------------------------------------------------------------------ version, fresh state

#[test]
fn version_is_1_1_0_and_a_fresh_vault_has_no_tokens_or_payees() {
    let fx = Fx::new(5 * NEAR);
    fx.view(|v| {
        assert_eq!(v.config().version, "1.1.0");
        assert!(v.tokens().is_empty());
        assert!(v.payees(None, None).is_empty());
        assert_eq!(v.token_usage(acct(TOKEN)).total_spent, U128(0));
        assert!(v.token_period_state(acct(TOKEN), None).is_none());
        assert_eq!(
            v.preview_pay(acct(TOKEN), acct(PAYEE), U128(1)),
            "NoMandate"
        );
    });
}

// ------------------------------------------------------------------ allow_token / allow_payee

#[test]
fn allow_token_rejects_bad_inputs_and_updates_in_place() {
    let mut fx = Fx::with_mandate();
    let bad = |fx: &mut Fx, token: &str, a: u128, b: u128, c: u128| fx.allow_token(token, a, b, c);
    assert_eq!(
        bad(&mut fx, TOKEN, 0, 5, 5),
        Err("BadToken".into()),
        "per_pay > 0"
    );
    assert_eq!(
        bad(&mut fx, TOKEN, 6, 5, 9),
        Err("BadToken".into()),
        "per_pay <= period"
    );
    assert_eq!(
        bad(&mut fx, TOKEN, 5, 9, 8),
        Err("BadToken".into()),
        "period <= total"
    );
    assert_eq!(
        bad(&mut fx, VAULT, 1, 1, 1),
        Err("BadToken".into()),
        "not the vault"
    );
    assert_eq!(
        bad(&mut fx, "system", 1, 1, 1),
        Err("BadToken".into()),
        "not system"
    );
    assert_eq!(
        bad(&mut fx, &"0".repeat(64), 1, 1, 1),
        Err("BadToken".into()),
        "not the zero implicit account"
    );
    assert!(fx.view(|v| v.tokens()).is_empty());
    // Equal caps are fine.
    fx.allow_token(TOKEN, 5, 5, 5).unwrap();
    let e = fx.events();
    assert_eq!(ev(&e[0]), "token_allowed");
    assert_eq!(e[0]["data"]["updated"], false);
    assert_eq!(e[0]["data"]["token"], TOKEN);
    assert_eq!(e[0]["data"]["by"], OWNER);
    // Re-allow updates the caps, does not duplicate.
    fx.allow_token(TOKEN, 6, 7, 8).unwrap();
    assert_eq!(fx.events()[0]["data"]["updated"], true);
    let t = fx.view(|v| v.tokens());
    assert_eq!(
        t,
        vec![TokenView {
            token: acct(TOKEN),
            per_pay_cap: U128(6),
            period_cap: U128(7),
            total_cap: U128(8)
        }]
    );
}

#[test]
fn token_count_is_capped_at_8_but_updates_still_work() {
    let mut fx = Fx::with_mandate();
    for i in 0..MAX_TOKENS {
        fx.allow_token(&format!("t{i}.testnet"), 1, 1, 1).unwrap();
    }
    assert_eq!(
        fx.allow_token("t8.testnet", 1, 1, 1),
        Err("BadToken".into())
    );
    fx.allow_token("t3.testnet", 2, 3, 4).unwrap(); // update of an existing one
    assert_eq!(fx.view(|v| v.tokens()).len(), 8);
    // Freeing a slot lets a new one in.
    fx.run(OWNER, |v| v.disallow_token(acct("t0.testnet")))
        .unwrap();
    fx.allow_token("t8.testnet", 1, 1, 1).unwrap();
}

#[test]
fn disallow_token_unknown_reverts_and_emits_on_change_only() {
    let mut fx = Fx::ready();
    assert_eq!(
        fx.run(OWNER, |v| v.disallow_token(acct(TOKEN2))),
        Err("TokenNotAllowed".into())
    );
    assert!(fx.events().is_empty());
    fx.run(OWNER, |v| v.disallow_token(acct(TOKEN))).unwrap();
    assert_eq!(ev(&fx.events()[0]), "token_disallowed");
    assert!(fx.view(|v| v.tokens()).is_empty());
}

#[test]
fn allow_payee_rules_pagination_and_idempotence() {
    let mut fx = Fx::ready(); // TOKEN allowed, PAYEE allowed
    assert_eq!(fx.allow_payee(VAULT), Err("BadPayee".into()));
    assert_eq!(fx.allow_payee("system"), Err("BadPayee".into()));
    assert_eq!(fx.allow_payee(&"0".repeat(64)), Err("BadPayee".into()));
    assert_eq!(
        fx.allow_payee(TOKEN),
        Err("BadPayee".into()),
        "a token is no payee"
    );
    // A payee cannot become a token either.
    assert_eq!(fx.allow_token(PAYEE, 1, 1, 1), Err("BadToken".into()));
    // Idempotent: no state change, no event.
    fx.allow_payee(PAYEE).unwrap();
    assert!(fx.events().is_empty());
    assert_eq!(fx.view(|v| v.payees(None, None)), vec![acct(PAYEE)]);
    fx.allow_payee(PAYEE2).unwrap();
    let e = fx.events();
    assert_eq!(ev(&e[0]), "payee_allowed");
    assert_eq!(e[0]["data"]["payee"], PAYEE2);
    assert_eq!(
        fx.view(|v| v.payees(Some(U64(1)), Some(U64(5)))),
        vec![acct(PAYEE2)]
    );
    assert!(fx.view(|v| v.payees(Some(U64(2)), None)).is_empty());
    // Once a token is disallowed its account can be listed as a payee.
    fx.run(OWNER, |v| v.disallow_token(acct(TOKEN))).unwrap();
    fx.allow_payee(TOKEN).unwrap();
    // Remove.
    assert_eq!(
        fx.run(OWNER, |v| v.disallow_payee(acct("nobody.testnet"))),
        Err("PayeeNotAllowed".into())
    );
    fx.run(OWNER, |v| v.disallow_payee(acct(PAYEE))).unwrap();
    assert_eq!(ev(&fx.events()[0]), "payee_disallowed");
    assert_eq!(fx.view(|v| v.payees(None, None)).len(), 2);
}

#[test]
fn payee_count_is_capped_at_64() {
    let mut fx = Fx::with_mandate();
    for i in 0..MAX_PAYEES {
        fx.allow_payee(&format!("p{i}.testnet")).unwrap();
    }
    assert_eq!(fx.allow_payee("p64.testnet"), Err("BadPayee".into()));
    fx.allow_payee("p10.testnet").unwrap(); // already listed: no-op even when full
    assert_eq!(fx.view(|v| v.payees(None, Some(U64(100)))).len(), 64);
}

#[test]
fn only_the_owner_reaches_owner_methods_and_only_the_agent_pays() {
    let mut fx = Fx::ready();
    for who in [AGENT, OTHER, NEW_OWNER] {
        let who = who.to_string();
        assert_eq!(
            fx.run(&who, |v| v.allow_token(
                acct(TOKEN2),
                U128(1),
                U128(1),
                U128(1)
            )),
            Err("Unauthorized".into()),
            "{who}"
        );
        assert_eq!(
            fx.run(&who, |v| v.disallow_token(acct(TOKEN))),
            Err("Unauthorized".into())
        );
        assert_eq!(
            fx.run(&who, |v| v.allow_payee(acct(PAYEE2))),
            Err("Unauthorized".into())
        );
        assert_eq!(
            fx.run(&who, |v| v.disallow_payee(acct(PAYEE))),
            Err("Unauthorized".into())
        );
        assert_eq!(
            fx.run(&who, |v| v.withdraw_token(acct(TOKEN), U128(1))),
            Err("Unauthorized".into())
        );
    }
    // The owner, other accounts and even a payee are not the agent.
    for who in [OWNER, OTHER, PAYEE] {
        assert_eq!(
            fx.pay_as(who, TOKEN, PAYEE, USDC, None),
            Err("Unauthorized".into()),
            "{who}"
        );
    }
    assert!(fx.receipts.is_empty());
    assert_eq!(fx.usage(TOKEN), (0, 0));
    // Nothing changed.
    assert_eq!(fx.view(|v| v.tokens()).len(), 1);
    assert_eq!(fx.view(|v| v.payees(None, None)), vec![acct(PAYEE)]);
}

// ------------------------------------------------------------------ pay: shape of the call

#[test]
fn pay_sends_exactly_one_ft_transfer_with_1_yocto_and_a_callback() {
    let mut fx = Fx::ready();
    let before = fx.avail;
    fx.pay_as(AGENT, TOKEN, PAYEE, 7 * USDC, Some("invoice 42"))
        .unwrap();
    assert_eq!(fx.receipts.len(), 2, "ft_transfer + on_paid");
    let (tx, cb) = (&fx.receipts[0], &fx.receipts[1]);
    assert_eq!(tx.receiver_id, acct(TOKEN));
    let (m, args, dep, gas) = call_of(tx);
    assert_eq!(m, "ft_transfer");
    assert_eq!(
        args,
        json!({"receiver_id": PAYEE, "amount": (7 * USDC).to_string(), "memo": "invoice 42"})
    );
    assert_eq!(dep, 1, "exactly 1 yoctoNEAR");
    assert_eq!(gas, FT_TRANSFER_GAS);
    assert_eq!(cb.receiver_id, acct(VAULT));
    let (m, args, dep, gas) = call_of(cb);
    assert_eq!(m, "on_paid");
    assert_eq!(dep, 0);
    assert_eq!(gas, PAY_CALLBACK_GAS);
    assert_eq!(
        args,
        json!({"epoch": "1", "period_index": "0", "token": TOKEN, "to": PAYEE,
               "amount": (7 * USDC).to_string()})
    );
    assert_eq!(before - fx.avail, 1, "only the 1 yocto leaves the vault");
    let e = fx.events();
    assert_eq!(e.len(), 1);
    assert_eq!(ev(&e[0]), "paid");
    assert_eq!(e[0]["data"]["agent"], AGENT);
    assert_eq!(e[0]["data"]["token"], TOKEN);
    assert_eq!(e[0]["data"]["to"], PAYEE);
    assert_eq!(e[0]["data"]["amount"], (7 * USDC).to_string());
    assert_eq!(e[0]["data"]["memo"], "invoice 42");
    assert_eq!(e[0]["data"]["total_spent"], (7 * USDC).to_string());
    assert_eq!(fx.usage(TOKEN), (7 * USDC, 7 * USDC));
}

#[test]
fn pay_without_memo_omits_the_memo_argument() {
    let mut fx = Fx::ready();
    fx.pay(USDC).unwrap();
    let (_, args, _, _) = call_of(&fx.receipts[0]);
    assert_eq!(
        args,
        json!({"receiver_id": PAYEE, "amount": USDC.to_string()})
    );
    assert_eq!(fx.events()[0]["data"]["memo"], Value::Null);
}

#[test]
fn pay_never_touches_the_near_budget_and_the_near_budget_never_touches_token_usage() {
    let mut fx = Fx::ready();
    fx.pay(5 * USDC).unwrap();
    fx.view(|v| {
        assert_eq!(v.usage().total_spent, U128(0));
        assert_eq!(v.usage().period_spent, U128(0));
        assert_eq!(v.period_state(None).unwrap().total_spent, U128(0));
    });
    fx.run(AGENT, |v| {
        v.draw(U128(NEAR));
    })
    .unwrap();
    assert_eq!(fx.usage(TOKEN), (5 * USDC, 5 * USDC));
}

#[test]
fn the_vault_only_ever_calls_ft_transfer_on_a_token_and_never_ft_transfer_call() {
    let mut fx = Fx::ready();
    fx.pay_as(AGENT, TOKEN, PAYEE, USDC, Some("m")).unwrap();
    let mut all = fx.receipts.clone();
    fx.run(OWNER, |v| v.withdraw_token(acct(TOKEN), U128(3)))
        .unwrap();
    all.extend(fx.receipts.clone());
    assert_eq!(all.len(), 4);
    for r in &all {
        for a in &r.actions {
            match a {
                MockAction::FunctionCallWeight { method_name, .. } => {
                    let m = String::from_utf8(method_name.clone()).unwrap();
                    if r.receiver_id.as_str() == TOKEN {
                        assert_eq!(m, "ft_transfer");
                    } else {
                        assert_eq!(r.receiver_id.as_str(), VAULT);
                        assert!(m == "on_paid" || m == "on_token_withdrawn", "{m}");
                    }
                }
                other => panic!("unexpected action {other:?}"),
            }
        }
    }
}

// ------------------------------------------------------------------ pay: rules and order

#[test]
fn pay_rules_run_in_the_documented_order() {
    // No mandate at all.
    reset_storage();
    let mut fx = Fx::new(100 * NEAR);
    assert_eq!(fx.pay(1), Err("NoMandate".into()));
    // Set up: mandate, token, payee.
    fx.set_mandate(AGENT);
    fx.allow_token(TOKEN, 10 * USDC, 25 * USDC, 100 * USDC)
        .unwrap();
    fx.allow_payee(PAYEE).unwrap();

    // Unauthorized beats everything below it (unknown token, unknown payee, zero amount).
    assert_eq!(
        fx.pay_as(OTHER, TOKEN2, "nobody.testnet", 0, None),
        Err("Unauthorized".into())
    );
    // Paused beats MandateInactive and the token checks.
    fx.run(OWNER, |v| v.pause()).unwrap();
    assert_eq!(
        fx.pay_as(AGENT, TOKEN2, "nobody.testnet", 0, None),
        Err("Paused".into())
    );
    fx.run(OWNER, |v| v.unpause()).unwrap();
    // Token before payee before amount.
    assert_eq!(
        fx.pay_as(AGENT, TOKEN2, "nobody.testnet", 0, None),
        Err("TokenNotAllowed".into())
    );
    assert_eq!(
        fx.pay_as(AGENT, TOKEN, "nobody.testnet", 0, None),
        Err("PayeeNotAllowed".into())
    );
    assert_eq!(fx.pay(0), Err("BadAmount".into()));
    // Per-pay beats period and total.
    assert_eq!(fx.pay(10 * USDC + 1), Err("PerPayCap".into()));
    // Period beats total: lower the total below the period cap first.
    fx.allow_token(TOKEN, 10 * USDC, 25 * USDC, 25 * USDC)
        .unwrap();
    fx.pay(10 * USDC).unwrap();
    fx.pay(10 * USDC).unwrap();
    assert_eq!(fx.pay(6 * USDC), Err("PeriodCap".into()));
    fx.t += 3600; // next period: the period no longer blocks, the total does
    assert_eq!(fx.pay(6 * USDC), Err("TotalCap".into()));
    fx.pay(5 * USDC).unwrap();
    assert_eq!(fx.pay(1), Err("TotalCap".into()));
    // Memo length is checked after the caps.
    fx.allow_token(TOKEN, 10 * USDC, 25 * USDC, 100 * USDC)
        .unwrap();
    let long = "x".repeat(MAX_MEMO_BYTES + 1);
    assert_eq!(
        fx.pay_as(AGENT, TOKEN, PAYEE, 0, Some(&long)),
        Err("BadAmount".into())
    );
    assert_eq!(
        fx.pay_as(AGENT, TOKEN, PAYEE, 1, Some(&long)),
        Err("BadMemo".into())
    );
    let ok = "y".repeat(MAX_MEMO_BYTES);
    fx.pay_as(AGENT, TOKEN, PAYEE, 1, Some(&ok)).unwrap();
}

#[test]
fn memo_limit_counts_bytes_not_chars() {
    let mut fx = Fx::ready();
    let two_byte = "é".repeat(MAX_MEMO_BYTES / 2); // exactly 128 bytes
    fx.pay_as(AGENT, TOKEN, PAYEE, 1, Some(&two_byte)).unwrap();
    let too_long = "é".repeat(MAX_MEMO_BYTES / 2 + 1);
    assert_eq!(
        fx.pay_as(AGENT, TOKEN, PAYEE, 1, Some(&too_long)),
        Err("BadMemo".into())
    );
}

#[test]
fn revoke_pause_and_expiry_block_pay() {
    let mut fx = Fx::ready();
    fx.run(OWNER, |v| v.pause()).unwrap();
    assert_eq!(fx.pay(1), Err("Paused".into()));
    fx.run(OWNER, |v| v.unpause()).unwrap();
    fx.pay(1).unwrap();
    // Expiry is exclusive: active while now < expires_at.
    fx.t = T0 + DAY - 1;
    fx.pay(1).unwrap();
    fx.t = T0 + DAY;
    assert_eq!(fx.pay(1), Err("MandateInactive".into()));
    // Revoke.
    let mut fx = Fx::ready();
    fx.run(OWNER, |v| v.revoke()).unwrap();
    assert_eq!(fx.pay(1), Err("MandateInactive".into()));
    assert!(fx.receipts.is_empty());
}

#[test]
fn agent_can_never_pay_a_non_allowlisted_payee_or_token() {
    let mut fx = Fx::ready();
    for to in [OWNER, AGENT, OTHER, VAULT, TOKEN, TOKEN2, PAYEE2] {
        assert_eq!(
            fx.pay_as(AGENT, TOKEN, to, USDC, None),
            Err("PayeeNotAllowed".into()),
            "{to}"
        );
        assert!(fx.receipts.is_empty(), "no receipt for {to}");
    }
    for token in [TOKEN2, OWNER, VAULT, PAYEE] {
        assert_eq!(
            fx.pay_as(AGENT, token, PAYEE, USDC, None),
            Err("TokenNotAllowed".into()),
            "{token}"
        );
    }
    // Removing the payee / the token closes the door at once.
    fx.pay(USDC).unwrap();
    fx.run(OWNER, |v| v.disallow_payee(acct(PAYEE))).unwrap();
    assert_eq!(fx.pay(USDC), Err("PayeeNotAllowed".into()));
    fx.allow_payee(PAYEE).unwrap();
    fx.pay(USDC).unwrap();
    fx.run(OWNER, |v| v.disallow_token(acct(TOKEN))).unwrap();
    assert_eq!(fx.pay(USDC), Err("TokenNotAllowed".into()));
    // The owner can list the agent itself as a payee: that is the owner's choice.
    fx.allow_token(TOKEN, 10 * USDC, 25 * USDC, 100 * USDC)
        .unwrap();
    fx.allow_payee(AGENT).unwrap();
    fx.pay_as(AGENT, TOKEN, AGENT, USDC, None).unwrap();
}

#[test]
fn caps_are_per_token_and_boundaries_are_inclusive() {
    let mut fx = Fx::ready();
    fx.allow_token(TOKEN2, 3 * USDC, 4 * USDC, 5 * USDC)
        .unwrap();
    fx.pay(10 * USDC).unwrap(); // per-pay boundary
    fx.pay(10 * USDC).unwrap();
    fx.pay(5 * USDC).unwrap(); // period boundary: 25 exactly
    assert_eq!(fx.pay(1), Err("PeriodCap".into()));
    assert_eq!(fx.usage(TOKEN), (25 * USDC, 25 * USDC));
    // The other token has its own, untouched budget.
    assert_eq!(fx.usage(TOKEN2), (0, 0));
    fx.pay_as(AGENT, TOKEN2, PAYEE, 3 * USDC, None).unwrap();
    assert_eq!(
        fx.pay_as(AGENT, TOKEN2, PAYEE, 3 * USDC, None),
        Err("PeriodCap".into())
    );
    // Rollover: period cap resets, total keeps counting.
    for _ in 0..3 {
        fx.t += 3600;
        fx.pay(10 * USDC).unwrap();
        fx.pay(10 * USDC).unwrap();
        fx.pay(5 * USDC).unwrap();
    }
    // total so far 100 = total cap
    assert_eq!(fx.usage(TOKEN).0, 100 * USDC);
    fx.t += 3600;
    assert_eq!(fx.pay(1), Err("TotalCap".into()));
}

#[test]
fn pay_needs_one_yocto_of_spendable_near() {
    let mut fx = Fx::ready();
    fx.avail = 0;
    assert_eq!(fx.pay(1), Err("InsufficientBalance".into()));
    assert_eq!(fx.preview(TOKEN, PAYEE, 1), "InsufficientBalance");
    assert_eq!(
        fx.run(OWNER, |v| v.withdraw_token(acct(TOKEN), U128(1))),
        Err("InsufficientBalance".into())
    );
    fx.avail = 1;
    fx.pay(1).unwrap();
    assert_eq!(
        fx.avail, 0,
        "the reserve is untouched: only spendable NEAR paid the yocto"
    );
    assert_eq!(fx.pay(1), Err("InsufficientBalance".into()));
}

#[test]
fn huge_amounts_never_overflow() {
    let mut fx = Fx::with_mandate();
    fx.allow_token(TOKEN, u128::MAX, u128::MAX, u128::MAX)
        .unwrap();
    fx.allow_payee(PAYEE).unwrap();
    fx.pay(u128::MAX - 1).unwrap();
    assert_eq!(fx.pay(2), Err("PeriodCap".into()));
    fx.pay(1).unwrap();
    assert_eq!(fx.usage(TOKEN), (u128::MAX, u128::MAX));
    assert_eq!(fx.pay(1), Err("PeriodCap".into()));
    // A reversal of more than was charged saturates.
    paid_callback(&mut fx, true, 1, 0, TOKEN, u128::MAX);
    paid_callback(&mut fx, true, 1, 0, TOKEN, u128::MAX);
    assert_eq!(fx.usage(TOKEN), (0, 0));
}

// ------------------------------------------------------------------ views

#[test]
fn token_period_state_tracks_rollover_and_remaining() {
    let mut fx = Fx::ready();
    fx.pay(10 * USDC).unwrap();
    let s = fx
        .view(|v| v.token_period_state(acct(TOKEN), None))
        .unwrap();
    assert_eq!(s.period_index, U64(0));
    assert_eq!(s.period_start, U64(T0));
    assert_eq!(s.period_end, U64(T0 + 3600));
    assert_eq!(s.period_spent, U128(10 * USDC));
    assert_eq!(s.period_remaining, U128(15 * USDC));
    assert_eq!(s.total_spent, U128(10 * USDC));
    assert_eq!(s.total_remaining, U128(90 * USDC));
    assert!(s.active);
    // Seen from the next period.
    let s = fx
        .view(|v| v.token_period_state(acct(TOKEN), Some(U64(T0 + 3600))))
        .unwrap();
    assert_eq!(s.period_index, U64(1));
    assert_eq!(s.period_spent, U128(0));
    assert_eq!(s.period_remaining, U128(25 * USDC));
    assert_eq!(s.total_remaining, U128(90 * USDC));
    // Seen after expiry.
    let s = fx
        .view(|v| v.token_period_state(acct(TOKEN), Some(U64(T0 + DAY))))
        .unwrap();
    assert!(!s.active);
    // Unknown / disallowed token: None.
    assert!(fx
        .view(|v| v.token_period_state(acct(TOKEN2), None))
        .is_none());
}

#[test]
fn preview_pay_matches_the_real_call_over_a_sweep() {
    let mut fx = Fx::ready();
    fx.allow_token(TOKEN2, 3 * USDC, 4 * USDC, 5 * USDC)
        .unwrap();
    let cases: Vec<(&str, &str, u128)> = vec![
        (TOKEN, PAYEE, USDC),
        (TOKEN, PAYEE, 0),
        (TOKEN, PAYEE, 10 * USDC),
        (TOKEN, PAYEE, 10 * USDC + 1),
        (TOKEN, PAYEE2, USDC),
        (TOKEN2, PAYEE, 3 * USDC),
        (TOKEN2, PAYEE, 4 * USDC),
        ("nope.testnet", PAYEE, USDC),
        (TOKEN, OWNER, USDC),
        (TOKEN, PAYEE, u128::MAX),
    ];
    // Walk through a few states: fresh, partly spent, paused, revoked, expired, new epoch.
    for step in 0..7 {
        match step {
            1 => {
                fx.pay(10 * USDC).ok();
                fx.pay(10 * USDC).ok();
            }
            2 => fx.t += 3600,
            3 => fx.run(OWNER, |v| v.pause()).unwrap(),
            4 => {
                fx.run(OWNER, |v| v.unpause()).unwrap();
                fx.run(OWNER, |v| v.revoke()).unwrap();
            }
            5 => fx.set_mandate(AGENT),
            6 => fx.t += DAY,
            _ => {}
        }
        for (token, to, amount) in &cases {
            let pv = fx.preview(token, to, *amount);
            let real = fx.pay_as(AGENT, token, to, *amount, None);
            match real {
                Ok(()) => assert_eq!(pv, "", "step {step} {token} {to} {amount}"),
                Err(c) => assert_eq!(pv, c, "step {step} {token} {to} {amount}"),
            }
        }
    }
}

// ------------------------------------------------------------------ usage: re-allow, epochs

#[test]
fn re_allowing_a_token_does_not_reset_its_usage() {
    let mut fx = Fx::ready();
    fx.pay(10 * USDC).unwrap();
    fx.pay(10 * USDC).unwrap();
    // Updating caps keeps usage.
    fx.allow_token(TOKEN, 10 * USDC, 25 * USDC, 100 * USDC)
        .unwrap();
    assert_eq!(fx.usage(TOKEN), (20 * USDC, 20 * USDC));
    // Disallow then allow again: still kept.
    fx.run(OWNER, |v| v.disallow_token(acct(TOKEN))).unwrap();
    assert_eq!(
        fx.usage(TOKEN),
        (20 * USDC, 20 * USDC),
        "usage survives disallow"
    );
    fx.allow_token(TOKEN, 10 * USDC, 25 * USDC, 100 * USDC)
        .unwrap();
    assert_eq!(fx.usage(TOKEN), (20 * USDC, 20 * USDC));
    assert_eq!(
        fx.pay(6 * USDC),
        Err("PeriodCap".into()),
        "the period budget is not refreshed"
    );
    fx.pay(5 * USDC).unwrap();
    // Raising the caps is the owner's explicit way to give more.
    fx.allow_token(TOKEN, 10 * USDC, 30 * USDC, 100 * USDC)
        .unwrap();
    fx.pay(5 * USDC).unwrap();
}

#[test]
fn set_mandate_resets_token_usage_for_every_token() {
    let mut fx = Fx::ready();
    fx.allow_token(TOKEN2, 3 * USDC, 4 * USDC, 5 * USDC)
        .unwrap();
    fx.pay(10 * USDC).unwrap();
    fx.pay_as(AGENT, TOKEN2, PAYEE, 3 * USDC, None).unwrap();
    fx.set_mandate(AGENT); // epoch 2
    assert_eq!(fx.usage(TOKEN), (0, 0));
    assert_eq!(fx.usage(TOKEN2), (0, 0));
    let s = fx
        .view(|v| v.token_period_state(acct(TOKEN), None))
        .unwrap();
    assert_eq!(s.total_spent, U128(0));
    assert_eq!(s.period_remaining, U128(25 * USDC));
    // The allowlists and caps survive, the budget is fresh.
    assert_eq!(fx.view(|v| v.tokens()).len(), 2);
    fx.pay(10 * USDC).unwrap();
    fx.pay(10 * USDC).unwrap();
    fx.pay(5 * USDC).unwrap();
    assert_eq!(fx.usage(TOKEN), (25 * USDC, 25 * USDC));
    assert_eq!(fx.pay(1), Err("PeriodCap".into()));
}

#[test]
fn a_stale_usage_record_cannot_leak_into_a_newer_epoch_via_a_late_reversal() {
    let mut fx = Fx::ready();
    fx.pay(4 * USDC).unwrap(); // epoch 1
    fx.set_mandate(AGENT); // epoch 2: usage reads zero
    fx.pay(2 * USDC).unwrap(); // epoch 2 charge replaces the stale record
    assert_eq!(fx.usage(TOKEN), (2 * USDC, 2 * USDC));
    // The epoch-1 transfer fails late: reported, not applied.
    paid_callback(&mut fx, true, 1, 0, TOKEN, 4 * USDC);
    assert_eq!(fx.usage(TOKEN), (2 * USDC, 2 * USDC));
    let e = events_of(&fx.logs);
    assert_eq!(ev(&e[0]), "pay_failed");
    assert_eq!(e[0]["data"]["reversed"], false);
    assert_eq!(e[0]["data"]["epoch"], "1");
}

#[test]
fn a_late_reversal_with_only_a_stale_record_changes_nothing() {
    let mut fx = Fx::ready();
    fx.pay(4 * USDC).unwrap(); // epoch 1, record stamped 1
    fx.set_mandate(AGENT); // epoch 2, no charge yet
                           // A (wrongly) epoch-2 reversal finds a stamp-1 record: must not touch it.
    paid_callback(&mut fx, true, 2, 0, TOKEN, 4 * USDC);
    assert_eq!(events_of(&fx.logs)[0]["data"]["reversed"], false);
    assert_eq!(fx.usage(TOKEN), (0, 0));
}

// ------------------------------------------------------------------ on_paid

#[test]
fn failed_transfer_reverses_the_charge_and_emits_pay_failed() {
    let mut fx = Fx::ready();
    fx.pay(10 * USDC).unwrap();
    assert_eq!(fx.avail, 1_000 * NEAR - 1);
    paid_callback(&mut fx, true, 1, 0, TOKEN, 10 * USDC);
    assert_eq!(fx.usage(TOKEN), (0, 0));
    assert_eq!(
        fx.avail,
        1_000 * NEAR,
        "the failed call refunded the 1 yocto"
    );
    let e = events_of(&fx.logs);
    assert_eq!(e.len(), 1);
    assert_eq!(ev(&e[0]), "pay_failed");
    assert_eq!(e[0]["data"]["reversed"], true);
    assert_eq!(e[0]["data"]["token"], TOKEN);
    assert_eq!(e[0]["data"]["to"], PAYEE);
    assert_eq!(e[0]["data"]["amount"], (10 * USDC).to_string());
    // The whole budget is usable again.
    fx.pay(10 * USDC).unwrap();
    fx.pay(10 * USDC).unwrap();
    fx.pay(5 * USDC).unwrap();
}

#[test]
fn successful_transfer_keeps_the_charge_and_emits_nothing() {
    let mut fx = Fx::ready();
    fx.pay(10 * USDC).unwrap();
    paid_callback(&mut fx, false, 1, 0, TOKEN, 10 * USDC);
    assert_eq!(fx.usage(TOKEN), (10 * USDC, 10 * USDC));
    assert!(events_of(&fx.logs).is_empty());
}

#[test]
fn failed_transfer_after_a_mandate_replacement_does_not_touch_the_new_epoch() {
    let mut fx = Fx::ready();
    fx.pay(4 * USDC).unwrap();
    fx.set_mandate(AGENT);
    fx.pay(2 * USDC).unwrap();
    paid_callback(&mut fx, true, 1, 0, TOKEN, 4 * USDC);
    assert_eq!(fx.usage(TOKEN), (2 * USDC, 2 * USDC));
    assert_eq!(events_of(&fx.logs)[0]["data"]["reversed"], false);
}

#[test]
fn failed_transfer_after_a_period_rollover_reverses_total_but_not_the_new_period() {
    let mut fx = Fx::ready();
    fx.pay(4 * USDC).unwrap(); // period 0
    fx.t += 3600;
    fx.pay(3 * USDC).unwrap(); // period 1, total 7
    paid_callback(&mut fx, true, 1, 0, TOKEN, 4 * USDC);
    let u = fx.view(|v| v.token_usage(acct(TOKEN)));
    assert_eq!(u.total_spent, U128(3 * USDC));
    assert_eq!(u.period_index, U64(1));
    assert_eq!(u.period_spent, U128(3 * USDC));
}

#[test]
fn failed_transfer_callback_replay_cannot_underflow() {
    let mut fx = Fx::ready();
    fx.pay(4 * USDC).unwrap();
    paid_callback(&mut fx, true, 1, 0, TOKEN, 4 * USDC);
    paid_callback(&mut fx, true, 1, 0, TOKEN, 4 * USDC);
    assert_eq!(fx.usage(TOKEN), (0, 0));
    // A callback for a token that never had a record does nothing but report.
    paid_callback(&mut fx, true, 1, 0, TOKEN2, 4 * USDC);
    assert_eq!(events_of(&fx.logs)[0]["data"]["reversed"], false);
}

#[test]
fn a_reversal_also_works_after_the_token_was_disallowed_and_never_touches_other_tokens() {
    let mut fx = Fx::ready();
    fx.allow_token(TOKEN2, 3 * USDC, 4 * USDC, 5 * USDC)
        .unwrap();
    fx.pay(4 * USDC).unwrap();
    fx.pay_as(AGENT, TOKEN2, PAYEE, 3 * USDC, None).unwrap();
    fx.run(OWNER, |v| v.disallow_token(acct(TOKEN))).unwrap();
    paid_callback(&mut fx, true, 1, 0, TOKEN, 4 * USDC);
    assert_eq!(fx.usage(TOKEN), (0, 0));
    assert_eq!(fx.usage(TOKEN2), (3 * USDC, 3 * USDC));
    assert_eq!(events_of(&fx.logs)[0]["data"]["reversed"], true);
}

#[test]
fn pay_callback_does_not_touch_the_near_counters() {
    let mut fx = Fx::ready();
    fx.run(AGENT, |v| {
        v.draw(U128(2 * NEAR));
    })
    .unwrap();
    fx.pay(USDC).unwrap();
    paid_callback(&mut fx, true, 1, 0, TOKEN, USDC);
    assert_eq!(fx.view(|v| v.usage().total_spent), U128(2 * NEAR));
}

// ------------------------------------------------------------------ withdraw_token

#[test]
fn withdraw_token_sends_ft_transfer_to_the_owner_only() {
    let mut fx = Fx::ready();
    let before = fx.avail;
    fx.run(OWNER, |v| v.withdraw_token(acct(TOKEN), U128(9 * USDC)))
        .unwrap();
    assert_eq!(fx.receipts.len(), 2);
    assert_eq!(fx.receipts[0].receiver_id, acct(TOKEN));
    let (m, args, dep, gas) = call_of(&fx.receipts[0]);
    assert_eq!(m, "ft_transfer");
    assert_eq!(
        args,
        json!({"receiver_id": OWNER, "amount": (9 * USDC).to_string()})
    );
    assert_eq!(dep, 1);
    assert_eq!(gas, FT_TRANSFER_GAS);
    assert_eq!(fx.receipts[1].receiver_id, acct(VAULT));
    let (m, _, _, gas) = call_of(&fx.receipts[1]);
    assert_eq!(m, "on_token_withdrawn");
    assert_eq!(gas, WITHDRAW_CALLBACK_GAS);
    assert_eq!(before - fx.avail, 1);
    let e = fx.events();
    assert_eq!(ev(&e[0]), "token_withdrawn");
    assert_eq!(e[0]["data"]["to"], OWNER);
    // It is not a spend: the agent's budget is untouched.
    assert_eq!(fx.usage(TOKEN), (0, 0));
}

#[test]
fn withdraw_token_rejects_zero_and_reserved_tokens() {
    let mut fx = Fx::ready();
    assert_eq!(
        fx.run(OWNER, |v| v.withdraw_token(acct(TOKEN), U128(0))),
        Err("BadAmount".into())
    );
    assert_eq!(
        fx.run(OWNER, |v| v.withdraw_token(acct(VAULT), U128(1))),
        Err("BadToken".into())
    );
    assert_eq!(
        fx.run(OWNER, |v| v.withdraw_token(acct("system"), U128(1))),
        Err("BadToken".into())
    );
    assert!(fx.receipts.is_empty());
}

#[test]
fn owner_can_withdraw_tokens_when_everything_else_is_blocked() {
    let mut fx = Fx::ready();
    fx.run(OWNER, |v| v.pause()).unwrap();
    fx.run(OWNER, |v| v.revoke()).unwrap();
    fx.t = T0 + 10 * DAY; // also expired
    assert_eq!(fx.pay(1), Err("Paused".into()));
    fx.run(OWNER, |v| v.withdraw_token(acct(TOKEN), U128(USDC)))
        .unwrap();
    // Also a token that is no longer allowed (or never was).
    fx.run(OWNER, |v| v.disallow_token(acct(TOKEN))).unwrap();
    fx.run(OWNER, |v| v.withdraw_token(acct(TOKEN), U128(USDC)))
        .unwrap();
    fx.run(OWNER, |v| v.withdraw_token(acct(TOKEN2), U128(USDC)))
        .unwrap();
    // And with no mandate ever.
    let mut fresh = Fx::new(10 * NEAR);
    fresh
        .run(OWNER, |v| v.withdraw_token(acct(TOKEN), U128(1)))
        .unwrap();
}

#[test]
fn withdraw_token_callback_failure_only_logs_and_charges_nothing() {
    let mut fx = Fx::ready();
    fx.run(OWNER, |v| v.withdraw_token(acct(TOKEN), U128(USDC)))
        .unwrap();
    withdraw_callback(&mut fx, true, TOKEN, USDC);
    let e = events_of(&fx.logs);
    assert_eq!(e.len(), 1);
    assert_eq!(ev(&e[0]), "token_withdraw_failed");
    assert_eq!(e[0]["data"]["token"], TOKEN);
    assert_eq!(e[0]["data"]["to"], OWNER);
    assert_eq!(e[0]["data"]["amount"], USDC.to_string());
    assert_eq!(fx.usage(TOKEN), (0, 0));
    withdraw_callback(&mut fx, false, TOKEN, USDC);
    assert!(events_of(&fx.logs).is_empty());
}

// ------------------------------------------------------------------ events, storage

#[test]
fn events_are_nep297_json_for_every_payout_mutation() {
    let mut fx = Fx::with_mandate();
    let mut seen: Vec<String> = vec![];
    let mut check = |fx: &Fx, expect: &str| {
        let logs: Vec<&String> = fx
            .logs
            .iter()
            .filter(|l| l.starts_with("EVENT_JSON:"))
            .collect();
        assert_eq!(
            logs.len(),
            1,
            "{expect}: exactly one event, got {:?}",
            fx.logs
        );
        let e: Value = serde_json::from_str(&logs[0]["EVENT_JSON:".len()..]).unwrap();
        assert_eq!(e["standard"], "autonear_vault");
        assert_eq!(e["version"], "1.1.0");
        assert_eq!(e["event"], expect);
        assert!(e["data"].is_object());
        seen.push(expect.to_string());
    };
    fx.allow_token(TOKEN, 10, 20, 30).unwrap();
    check(&fx, "token_allowed");
    fx.allow_payee(PAYEE).unwrap();
    check(&fx, "payee_allowed");
    fx.pay(5).unwrap();
    check(&fx, "paid");
    paid_callback(&mut fx, true, 1, 0, TOKEN, 5);
    check(&fx, "pay_failed");
    fx.run(OWNER, |v| v.withdraw_token(acct(TOKEN), U128(1)))
        .unwrap();
    check(&fx, "token_withdrawn");
    withdraw_callback(&mut fx, true, TOKEN, 1);
    check(&fx, "token_withdraw_failed");
    fx.run(OWNER, |v| v.disallow_payee(acct(PAYEE))).unwrap();
    check(&fx, "payee_disallowed");
    fx.run(OWNER, |v| v.disallow_token(acct(TOKEN))).unwrap();
    check(&fx, "token_disallowed");
    assert_eq!(seen.len(), 8);
    // Failed calls emit nothing.
    assert_eq!(fx.pay(1), Err("TokenNotAllowed".into()));
    assert!(fx.events().is_empty());
}

#[test]
fn payout_state_lives_under_its_own_key_and_leaves_the_v1_state_bytes_alone() {
    let mut fx = Fx::ready();
    let state_before = near_sdk::borsh::to_vec(&fx.v).unwrap();
    fx.allow_token(TOKEN2, 1, 2, 3).unwrap();
    fx.allow_payee(PAYEE2).unwrap();
    fx.pay(USDC).unwrap();
    paid_callback(&mut fx, true, 1, 0, TOKEN, USDC);
    let state_after = near_sdk::borsh::to_vec(&fx.v).unwrap();
    assert_eq!(
        state_before, state_after,
        "the Vault struct is not touched by payouts"
    );
    Ctx::new(OWNER, fx.t, fx.avail).su(fx.su).set();
    assert!(env::storage_has_key(b"p:state"));
    // Views read the persisted state (not a cache): a round trip of the Vault struct keeps them.
    fx.v.templates_flush_for_test();
    env::state_write(&fx.v);
    let back: Vault = env::state_read().expect("state");
    assert_eq!(back.tokens().len(), 2);
    assert_eq!(back.payees(None, None).len(), 2);
}

impl Vault {
    fn templates_flush_for_test(&mut self) {
        self.templates.flush();
    }
}
