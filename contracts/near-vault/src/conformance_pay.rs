//! Payouts conformance harness (cargo feature `payouts`): executes EVERY scenario of
//! `contracts/vault-conformance-pay.json` against the contract. The same file is run against
//! `src/vault-model.js` by `tests/vault-pay-conformance.test.js`. Schema and conventions are those of
//! `conformance.rs` (read its header): 1 abstract NEAR unit = 1e21 yocto, the mocked balance is scaled so
//! `available()` equals the abstract number, and roles are mapped to account ids through the file's
//! `accounts` table. Token amounts are plain integers (the token's smallest unit, not scaled).
//!
//! Besides `expect` and every `state` key, each step additionally asserts
//!  * the shape of the receipts: `pay` creates exactly `ft_transfer(receiver_id, amount[, memo])` on the token with
//!    1 yoctoNEAR and `FT_TRANSFER_GAS`, then `on_paid` on the vault; `withdraw_token` the same to the CURRENT
//!    owner with `on_token_withdrawn`; nothing else (no other action, no other receiver);
//!  * preview parity: `preview_pay` returns exactly the code the real `pay` hits (except `Unauthorized`, which
//!    previews never return, and `BadMemo`, which previews cannot see: they carry no memo);
//!  * a failing step leaves every view (config, mandate, usage, templates, available, tokens, payees, and the usage
//!    of every account in the table) unchanged.
//! The abstract balance cannot express the 1 yoctoNEAR deposit of each `ft_transfer`; the exact-yocto edge is
//! covered by `tests_pay::pay_needs_one_yocto_of_spendable_near`. A zero abstract balance means zero spendable NEAR.

use crate::payouts::FT_TRANSFER_GAS;
use crate::testkit::*;
use crate::*;
use near_sdk::mock::{MockAction, Receipt};
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::testing_env;
use near_sdk::PromiseResult;
use std::collections::{BTreeMap, BTreeSet};

const FILE: &str = include_str!("../../vault-conformance-pay.json");

struct Accounts {
    by_role: BTreeMap<String, String>,
    by_account: BTreeMap<String, String>,
}

impl Accounts {
    fn load(f: &Value) -> Self {
        let by_role: BTreeMap<String, String> = f["accounts"]
            .as_object()
            .expect("accounts")
            .iter()
            .map(|(r, a)| (r.clone(), a.as_str().unwrap().to_string()))
            .collect();
        let by_account = by_role
            .iter()
            .map(|(r, a)| (a.clone(), r.clone()))
            .collect();
        // The ids the shared test kit hard-codes must be the ones the file names.
        for (role, want) in [
            ("owner", OWNER),
            ("agent", AGENT),
            ("other", OTHER),
            ("newOwner", NEW_OWNER),
            ("vault", VAULT),
        ] {
            assert_eq!(by_role[role], want, "accounts.{role}");
        }
        Accounts {
            by_role,
            by_account,
        }
    }
    fn of(&self, role: &str) -> String {
        self.by_role
            .get(role)
            .unwrap_or_else(|| panic!("unknown role {role:?}"))
            .clone()
    }
    fn id(&self, role: &str) -> AccountId {
        acct(&self.of(role))
    }
    fn role(&self, account: &str) -> String {
        self.by_account
            .get(account)
            .cloned()
            .unwrap_or_else(|| account.to_string())
    }
}

fn units(v: &Value, key: &str) -> u128 {
    u128::from(v[key].as_u64().unwrap_or_else(|| panic!("missing {key}"))) * SCALE
}

fn raw(v: &Value, key: &str) -> u128 {
    u128::from(v[key].as_u64().unwrap_or_else(|| panic!("missing {key}")))
}

fn secs(v: &Value, key: &str) -> u64 {
    v[key].as_u64().unwrap_or_else(|| panic!("missing {key}"))
}

fn unscale(yocto: u128) -> u128 {
    assert_eq!(
        yocto % SCALE,
        0,
        "{yocto} yocto is not a whole number of units"
    );
    yocto / SCALE
}

fn memo_of(args: &Value) -> Option<String> {
    if let Some(n) = args["memo_len"].as_u64() {
        return Some("x".repeat(usize::try_from(n).unwrap()));
    }
    if let Some(a) = args["memo_repeat"].as_array() {
        let n = usize::try_from(a[1].as_u64().unwrap()).unwrap();
        return Some(a[0].as_str().unwrap().repeat(n));
    }
    args["memo"].as_str().map(str::to_string)
}

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

struct Run<'a> {
    v: Vault,
    acc: &'a Accounts,
    /// Abstract units.
    balance: u128,
    storage_usage: u64,
    /// (token role, receiver role) -> amount transferred out, net of failed transfers.
    sent: BTreeMap<(String, String), u128>,
}

struct Outcome {
    result: Result<(), String>,
    preview: Option<String>,
}

impl<'a> Run<'a> {
    fn new(balance: u128, acc: &'a Accounts) -> Self {
        reset_storage();
        Ctx::new(OWNER, 1, balance * SCALE).set();
        let v = Vault::new(acct(OWNER), "testnet".into());
        Run {
            v,
            acc,
            balance,
            storage_usage: env::storage_usage().max(5_000),
            sent: BTreeMap::new(),
        }
    }

    fn ctx(&self, who: &str, t: u64) -> Ctx {
        Ctx::new(who, t, self.balance * SCALE).su(self.storage_usage)
    }

    /// Context of a private callback: predecessor = the vault, one promise result.
    fn callback_ctx(&self, t: u64, failed: bool) {
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
                .block_timestamp(t * NS_PER_SEC)
                .storage_usage(self.storage_usage)
                .account_balance(NearToken::from_yoctonear(balance_for(
                    self.balance * SCALE,
                    self.storage_usage
                )))
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
    }

    /// Everything a failing call must leave untouched.
    fn snapshot(&self) -> String {
        let v = &self.v;
        let usage: BTreeMap<&String, Value> = self
            .acc
            .by_role
            .iter()
            // payees p1..p65 are never tokens: skip them to keep the per-step snapshot cheap
            .filter(|(role, _)| {
                !(role.starts_with('p') && role[1..].chars().all(|c| c.is_ascii_digit()))
            })
            .map(|(role, a)| (role, json!(v.token_usage(acct(a)))))
            .collect();
        serde_json::to_string(&json!({
            "config": v.config(),
            "mandate": v.mandate(),
            "usage": v.usage(),
            "templates": v.templates(None, Some(U64(MAX_PAGE))),
            "available": v.available(),
            "tokens": v.tokens(),
            "payees": v.payees(None, Some(U64(MAX_PAGE))),
            "token_usage": usage,
        }))
        .unwrap()
    }

    fn step(&mut self, step: &Value) -> Outcome {
        let t = secs(step, "t");
        let who = self.acc.of(step["as"].as_str().unwrap());
        let op = step["op"].as_str().unwrap();
        let args = &step["args"];
        let acc = self.acc;
        let attached = if op == "deposit" {
            units(args, "amount")
        } else {
            0
        };
        // Preview first (same time, same state, same caller as the real call).
        let mut preview = None;
        self.ctx(&who, t).set();
        if op == "pay" {
            preview = Some(self.v.preview_pay(
                acc.id(args["token"].as_str().unwrap()),
                acc.id(args["to"].as_str().unwrap()),
                U128(raw(args, "amount")),
            ));
        }
        let before = self.snapshot();
        let is_callback = op == "on_paid" || op == "on_token_withdrawn";
        if is_callback {
            self.callback_ctx(t, args["failed"].as_bool().unwrap());
        } else {
            self.ctx(&who, t).attach(attached).set();
        }
        let v = &mut self.v;
        let result: Result<(), String> = try_call(|| match op {
            "set_mandate" => v.set_mandate(
                acc.of(args["agent"].as_str().unwrap()),
                U64(secs(args, "expires_at")),
                U128(units(args, "per_draw_cap")),
                U64(secs(args, "period_secs")),
                U128(units(args, "period_cap")),
                U128(units(args, "total_cap")),
                u32::try_from(secs(args, "max_deploys")).unwrap(),
            ),
            "revoke" => v.revoke(),
            "pause" => v.pause(),
            "unpause" => v.unpause(),
            "withdraw" => {
                v.withdraw(U128(units(args, "amount")));
            }
            "transfer_ownership" => v.transfer_ownership(acc.of(args["to"].as_str().unwrap())),
            "accept_ownership" => v.accept_ownership(),
            "deposit" => v.deposit(),
            "draw" => {
                v.draw(U128(units(args, "amount")));
            }
            "allow_token" => v.allow_token(
                acc.id(args["token"].as_str().unwrap()),
                U128(raw(args, "per_pay_cap")),
                U128(raw(args, "period_cap")),
                U128(raw(args, "total_cap")),
            ),
            "disallow_token" => v.disallow_token(acc.id(args["token"].as_str().unwrap())),
            "allow_payee" => v.allow_payee(acc.id(args["account"].as_str().unwrap())),
            "disallow_payee" => v.disallow_payee(acc.id(args["account"].as_str().unwrap())),
            "withdraw_token" => v.withdraw_token(
                acc.id(args["token"].as_str().unwrap()),
                U128(raw(args, "amount")),
            ),
            "pay" => v.pay(
                acc.id(args["token"].as_str().unwrap()),
                acc.id(args["to"].as_str().unwrap()),
                U128(raw(args, "amount")),
                memo_of(args),
            ),
            "preview_pay" => {
                let code = v.preview_pay(
                    acc.id(args["token"].as_str().unwrap()),
                    acc.id(args["to"].as_str().unwrap()),
                    U128(raw(args, "amount")),
                );
                if !code.is_empty() {
                    panic!("E_{code}: preview");
                }
            }
            "on_paid" => v.on_paid(
                U64(secs(args, "epoch")),
                U64(secs(args, "period_index")),
                acc.id(args["token"].as_str().unwrap()),
                acc.id(args["to"].as_str().unwrap()),
                U128(raw(args, "amount")),
            ),
            "on_token_withdrawn" => v.on_token_withdrawn(
                acc.id(args["token"].as_str().unwrap()),
                acc.id(args["to"].as_str().unwrap()),
                U128(raw(args, "amount")),
            ),
            x => panic!("unknown op {x:?}"),
        });

        if result.is_err() {
            self.ctx(&who, t).set();
            assert_eq!(self.snapshot(), before, "a failing {op} changed state");
        } else {
            self.account_effects(op, args);
        }
        Outcome { result, preview }
    }

    fn add_sent(&mut self, token: &str, to: &str, amount: u128, negative: bool) {
        let e = self
            .sent
            .entry((self.acc.role(token), self.acc.role(to)))
            .or_insert(0);
        *e = if negative {
            e.saturating_sub(amount)
        } else {
            *e + amount
        };
    }

    /// Reads the receipts of the call that just succeeded; updates balance / sent and asserts their shape.
    fn account_effects(&mut self, op: &str, args: &Value) {
        self.storage_usage = env::storage_usage();
        let receipts = get_created_receipts();
        match op {
            "deposit" => {
                self.balance += units(args, "amount") / SCALE;
            }
            "withdraw" => {
                assert_eq!(receipts.len(), 1);
                self.balance -= unscale(transferred(&receipts));
            }
            "draw" => {
                assert_eq!(receipts.len(), 2, "draw: one transfer + on_drawn");
                self.balance -= unscale(transferred(&receipts));
            }
            "pay" | "withdraw_token" => {
                assert_eq!(receipts.len(), 2, "{op}: ft_transfer + the callback");
                assert_eq!(transferred(&receipts), 0, "{op} moves no NEAR");
                let token = self.acc.of(args["token"].as_str().unwrap());
                let (tx, cb) = (&receipts[0], &receipts[1]);
                assert_eq!(
                    tx.receiver_id.as_str(),
                    token,
                    "ft_transfer goes to the token"
                );
                let (m, a, dep, gas) = call_of(tx);
                assert_eq!(m, "ft_transfer", "the only call a token ever gets");
                assert_eq!((dep, gas), (1, FT_TRANSFER_GAS), "1 yocto, fixed gas");
                let amount = raw(args, "amount");
                assert_eq!(a["amount"], amount.to_string());
                let mut want_keys = vec!["amount", "receiver_id"];
                let to = if op == "pay" {
                    let to = self.acc.of(args["to"].as_str().unwrap());
                    match memo_of(args) {
                        Some(memo) => {
                            assert_eq!(a["memo"], memo);
                            want_keys.insert(1, "memo");
                        }
                        None => assert!(a.get("memo").is_none(), "no memo, no memo argument"),
                    }
                    to
                } else {
                    self.v.config().owner.to_string() // only ever the CURRENT owner
                };
                assert_eq!(a["receiver_id"], to);
                let mut keys: Vec<&str> =
                    a.as_object().unwrap().keys().map(String::as_str).collect();
                keys.sort_unstable();
                assert_eq!(keys, want_keys, "ft_transfer arguments");
                assert_eq!(cb.receiver_id.as_str(), VAULT);
                let (m, ca, dep, _) = call_of(cb);
                assert_eq!(dep, 0);
                if op == "pay" {
                    assert_eq!(m, "on_paid");
                    assert_eq!(ca["epoch"], self.v.config().epoch.0.to_string());
                    assert_eq!(ca["token"], token);
                    assert_eq!(ca["to"], to);
                    assert_eq!(ca["amount"], amount.to_string());
                } else {
                    assert_eq!(m, "on_token_withdrawn");
                    assert_eq!(ca["token"], token);
                    assert_eq!(ca["to"], to);
                }
                self.add_sent(&token, &to, amount, false);
            }
            "on_paid" | "on_token_withdrawn" => {
                assert!(receipts.is_empty(), "a callback creates no receipt");
                if args["failed"].as_bool().unwrap() {
                    // The transfer did not happen, whether or not the charge could be reversed.
                    let (token, to) = (
                        self.acc.of(args["token"].as_str().unwrap()),
                        self.acc.of(args["to"].as_str().unwrap()),
                    );
                    self.add_sent(&token, &to, raw(args, "amount"), true);
                }
            }
            _ => assert!(
                receipts.is_empty() || transferred(&receipts) == 0,
                "{op} must not move value"
            ),
        }
    }

    fn token_period_effective(&self, role: &str, t: u64) -> u128 {
        let idx = self
            .v
            .period_state(Some(U64(t)))
            .expect("mandate")
            .period_index;
        let u = self.v.token_usage(self.acc.id(role));
        if u.period_index == idx {
            u.period_spent.0
        } else {
            0
        }
    }

    fn check_state(&self, state: &Value, t: u64, who: &str) {
        self.ctx(who, t).set();
        let v = &self.v;
        let roles = |ids: Vec<AccountId>| -> Vec<String> {
            let mut r: Vec<String> = ids.iter().map(|a| self.acc.role(a.as_str())).collect();
            r.sort();
            r
        };
        for (key, want) in state.as_object().unwrap() {
            match key.as_str() {
                "available" => assert_eq!(unscale(v.available().0), want.as_u64().unwrap().into()),
                "total_spent" => assert_eq!(
                    unscale(v.usage().total_spent.0),
                    want.as_u64().unwrap().into()
                ),
                "period_spent" => {
                    let ps = v.period_state(Some(U64(t))).expect("mandate");
                    assert_eq!(unscale(ps.period_spent.0), want.as_u64().unwrap().into());
                }
                "epoch" => assert_eq!(v.config().epoch.0, want.as_u64().unwrap()),
                "paused" => assert_eq!(v.config().paused, want.as_bool().unwrap()),
                "revoked" => assert_eq!(
                    v.mandate().expect("mandate").revoked,
                    want.as_bool().unwrap()
                ),
                "token_total" => {
                    for (role, n) in want.as_object().unwrap() {
                        let got = v.token_usage(self.acc.id(role)).total_spent.0;
                        assert_eq!(got, u128::from(n.as_u64().unwrap()), "token_total[{role}]");
                    }
                }
                "token_period" => {
                    for (role, n) in want.as_object().unwrap() {
                        let got = self.token_period_effective(role, t);
                        assert_eq!(got, u128::from(n.as_u64().unwrap()), "token_period[{role}]");
                    }
                }
                "token_sent" => {
                    for (tr, tos) in want.as_object().unwrap() {
                        for (r, n) in tos.as_object().unwrap() {
                            let got = self
                                .sent
                                .get(&(tr.clone(), r.clone()))
                                .copied()
                                .unwrap_or(0);
                            assert_eq!(
                                got,
                                u128::from(n.as_u64().unwrap()),
                                "token_sent[{tr}][{r}]"
                            );
                        }
                    }
                }
                "allowed_tokens" => {
                    let got = roles(v.tokens().into_iter().map(|x| x.token).collect());
                    let want: Vec<String> = want
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|x| x.as_str().unwrap().to_string())
                        .collect();
                    assert_eq!(got, want, "allowed_tokens");
                }
                "allowed_payees" => {
                    let got = roles(v.payees(None, Some(U64(MAX_PAGE))));
                    let want: Vec<String> = want
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|x| x.as_str().unwrap().to_string())
                        .collect();
                    assert_eq!(got, want, "allowed_payees");
                }
                "n_tokens" => assert_eq!(v.tokens().len() as u64, want.as_u64().unwrap()),
                "n_payees" => assert_eq!(
                    v.payees(None, Some(U64(MAX_PAGE))).len() as u64,
                    want.as_u64().unwrap()
                ),
                "caps" => {
                    for (role, caps) in want.as_object().unwrap() {
                        let id = self.acc.id(role);
                        let got = v
                            .tokens()
                            .into_iter()
                            .find(|x| x.token == id)
                            .map(|x| vec![x.per_pay_cap.0, x.period_cap.0, x.total_cap.0]);
                        let want: Option<Vec<u128>> = caps
                            .as_array()
                            .map(|a| a.iter().map(|n| u128::from(n.as_u64().unwrap())).collect());
                        assert_eq!(got, want, "caps[{role}]");
                    }
                }
                k => panic!("unknown state key {k:?}: the harness would silently skip it"),
            }
        }
    }
}

/// Sum of the `Transfer` actions of all receipts (yocto).
fn transferred(receipts: &[Receipt]) -> u128 {
    receipts
        .iter()
        .flat_map(|r| r.actions.iter())
        .map(|a| match a {
            MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
            _ => 0,
        })
        .sum()
}

fn expected(step: &Value) -> Result<(), String> {
    match &step["expect"] {
        Value::String(s) if s == "ok" => Ok(()),
        Value::Object(o) => Err(o["err"].as_str().unwrap().to_string()),
        other => panic!("bad expect {other:?}"),
    }
}

#[test]
fn pay_error_list_matches_the_contract() {
    let f: Value = serde_json::from_str(FILE).unwrap();
    let file: Vec<&str> = f["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e.as_str().unwrap())
        .collect();
    let code: Vec<&str> = Code::ALL
        .iter()
        .chain(Code::PAYOUTS.iter())
        .map(|c| c.as_str())
        .collect();
    assert_eq!(file, code);
}

#[test]
fn near_pay_conformance_all_scenarios() {
    let f: Value = serde_json::from_str(FILE).unwrap();
    assert_eq!(f["version"], 1);
    let acc = Accounts::load(&f);
    let mut ran = Vec::new();
    let mut steps_run = 0usize;
    let mut codes_seen = BTreeSet::new();
    for sc in f["scenarios"].as_array().unwrap() {
        let name = sc["name"].as_str().unwrap();
        assert!(
            sc["only"].is_null(),
            "{name}: payout scenarios run on NEAR only, untagged"
        );
        let mut run = Run::new(sc["setup"]["balance"].as_u64().unwrap().into(), &acc);
        for (i, step) in sc["steps"].as_array().unwrap().iter().enumerate() {
            let at = format!("{name} step {i} ({} {})", step["as"], step["op"]);
            let out = run.step(step);
            let want = expected(step);
            assert_eq!(out.result, want, "{at}: result");
            if let Err(c) = &want {
                codes_seen.insert(c.clone());
            }
            // Preview parity (previews assume the bound agent and carry no memo).
            if let Some(pv) = &out.preview {
                match &out.result {
                    Ok(()) => {
                        assert_eq!(pv, "", "{at}: preview says {pv:?} but the call succeeded")
                    }
                    Err(c) if c == "Unauthorized" => {
                        assert_ne!(pv, c, "{at}: previews never return {c}")
                    }
                    Err(c) if c == "BadMemo" => assert!(
                        pv.is_empty() || pv == "InsufficientBalance",
                        "{at}: preview {pv:?} for a call that only fails on its memo"
                    ),
                    Err(c) => assert_eq!(pv, c, "{at}: preview != real error"),
                }
            }
            steps_run += 1;
            if let Some(state) = step.get("state") {
                run.check_state(state, secs(step, "t"), OWNER);
            }
        }
        ran.push(name.to_string());
    }
    assert_eq!(ran.len(), f["scenarios"].as_array().unwrap().len());
    assert!(ran.len() >= 15, "suspiciously few scenarios ran: {ran:?}");
    for c in Code::PAYOUTS {
        assert!(
            codes_seen.contains(c.as_str()),
            "payout error {} is never asserted",
            c.as_str()
        );
    }
    println!(
        "NEAR payout conformance: {} scenarios / {steps_run} steps ran",
        ran.len()
    );
    println!("error codes asserted by scenarios: {codes_seen:?}");
}
