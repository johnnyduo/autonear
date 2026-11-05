//! Conformance harness: executes EVERY scenario of `contracts/vault-conformance.json` whose `only`
//! is absent or `"near"` against the contract, asserting `expect` and every `state` key.
//!
//! Scaling (spec "NEAR harness"): 1 abstract unit = 1e21 yocto, the mocked account balance is
//! `abstract * 1e21 + storage_cost + 1 NEAR`, so `available()` equals the abstract number.
//! Receipts created by each call are inspected: every `Transfer` is subtracted from the abstract
//! balance, `received` is read from them, and the deploy batch shape is asserted.
//!
//! Besides the scenario `expect`, each step additionally asserts
//!  * preview parity: `preview_draw` / `preview_deploy` return exactly the code the real call hits
//!    (except `Unauthorized`, which previews never return because they assume the bound agent,
//!    and `CodeMismatch`, which needs the wasm bytes);
//!  * a failing step leaves every view unchanged (checks run before effects).

use super::testkit::*;
use super::*;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::get_created_receipts;
use std::collections::{BTreeMap, BTreeSet};

const FILE: &str = include_str!("../../vault-conformance.json");

fn role_account(role: &str) -> String {
    match role {
        "owner" => OWNER.into(),
        "agent" => AGENT.into(),
        "other" => OTHER.into(),
        "newOwner" => NEW_OWNER.into(),
        // The empty string is the spec's "zero/empty" value; the contract takes it as a string.
        "" => String::new(),
        x => panic!("unknown role {x:?}"),
    }
}

fn account_role(account: &str) -> Option<&'static str> {
    [
        ("owner", OWNER),
        ("agent", AGENT),
        ("other", OTHER),
        ("newOwner", NEW_OWNER),
    ]
    .iter()
    .find(|(_, a)| *a == account)
    .map(|(r, _)| *r)
}

fn fixture(name: &str) -> &'static [u8] {
    match name {
        "t1" => WASM_T1,
        "t2" => WASM_T2,
        x => panic!("no wasm fixture for template {x:?}"),
    }
}

fn units(v: &Value, key: &str) -> u128 {
    u128::from(v[key].as_u64().unwrap_or_else(|| panic!("missing {key}"))) * SCALE
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

/// Everything a failing call must leave untouched.
fn snapshot(v: &Vault) -> String {
    serde_json::to_string(&json!({
        "config": v.config(),
        "mandate": v.mandate(),
        "usage": v.usage(),
        "templates": v.templates(None, Some(U64(MAX_PAGE))),
        "available": v.available(),
    }))
    .unwrap()
}

struct Run {
    v: Vault,
    /// Abstract units.
    balance: u128,
    storage_usage: u64,
    received: BTreeMap<String, u128>,
    deploy_batches: usize,
}

struct Outcome {
    result: Result<(), String>,
    preview: Option<String>,
}

impl Run {
    fn new(balance: u128) -> Self {
        reset_storage();
        Ctx::new(OWNER, 1, balance * SCALE).set();
        let v = Vault::new(acct(OWNER), "testnet".into());
        Run {
            v,
            balance,
            storage_usage: env::storage_usage().max(5_000),
            received: BTreeMap::new(),
            deploy_batches: 0,
        }
    }

    fn ctx(&self, who: &str, t: u64) -> Ctx {
        Ctx::new(who, t, self.balance * SCALE).su(self.storage_usage)
    }

    fn step(&mut self, step: &Value) -> Outcome {
        let t = secs(step, "t");
        let who = role_account(step["as"].as_str().unwrap());
        let op = step["op"].as_str().unwrap();
        let args = &step["args"];
        let attached = if op == "deposit" {
            units(args, "amount")
        } else {
            0
        };
        // Previews first (same time, same state, same caller as the real call).
        let mut preview = None;
        self.ctx(&who, t).set();
        match op {
            "draw" => {
                preview = Some(self.v.preview_draw(U128(units(args, "amount"))));
            }
            "deploy" => {
                let id = hash_hex(fixture(args["template"].as_str().unwrap()));
                preview = Some(
                    self.v
                        .preview_deploy(id, args["name"].as_str().unwrap().into()),
                );
            }
            _ => {}
        }
        let before = snapshot(&self.v);

        self.ctx(&who, t).attach(attached).set();
        let v = &mut self.v;
        let result: Result<(), String> = try_call(|| match op {
            "set_mandate" => v.set_mandate(
                role_account(args["agent"].as_str().unwrap()),
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
            "allow_template" => v.allow_template(
                hash_hex(fixture(args["template"].as_str().unwrap())),
                args["label"].as_str().unwrap().into(),
                U128(units(args, "deposit")),
                None,
                None,
            ),
            "disallow_template" => {
                v.disallow_template(hash_hex(fixture(args["template"].as_str().unwrap())))
            }
            "withdraw" => {
                v.withdraw(U128(units(args, "amount")));
            }
            "transfer_ownership" => {
                v.transfer_ownership(role_account(args["to"].as_str().unwrap()))
            }
            "accept_ownership" => v.accept_ownership(),
            "deposit" => v.deposit(),
            "draw" => {
                v.draw(U128(units(args, "amount")));
            }
            "deploy" => {
                let tpl = args["template"].as_str().unwrap();
                let code_name = args["code"].as_str().unwrap_or(tpl);
                v.deploy(
                    hash_hex(fixture(tpl)),
                    args["name"].as_str().unwrap().into(),
                    fixture(code_name).to_vec().into(),
                );
            }
            // Previews are exercised as steps in their own right: expect == the returned code.
            "preview_draw" => {
                let code = v.preview_draw(U128(units(args, "amount")));
                if !code.is_empty() {
                    panic!("E_{code}: preview");
                }
            }
            "preview_deploy" => {
                let id = hash_hex(fixture(args["template"].as_str().unwrap()));
                let code = v.preview_deploy(id, args["name"].as_str().unwrap().into());
                if !code.is_empty() {
                    panic!("E_{code}: preview");
                }
            }
            x => panic!("unknown op {x:?}"),
        });

        if result.is_err() {
            self.ctx(&who, t).set();
            assert_eq!(snapshot(&self.v), before, "a failing {op} changed state");
        } else {
            self.account_effects(op, args);
        }
        Outcome { result, preview }
    }

    /// Reads the receipts of the call that just succeeded; updates balance / received.
    fn account_effects(&mut self, op: &str, args: &Value) {
        self.storage_usage = env::storage_usage();
        let receipts = get_created_receipts();
        if op == "deposit" {
            self.balance += units(args, "amount") / SCALE;
        }
        let mut sent_total = 0u128;
        let mut saw_deploy = false;
        for r in &receipts {
            let transfers: u128 = r
                .actions
                .iter()
                .map(|a| match a {
                    MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
                    _ => 0,
                })
                .sum();
            sent_total += transfers;
            let has_deploy = r
                .actions
                .iter()
                .any(|a| matches!(a, MockAction::DeployContract { .. }));
            if has_deploy {
                saw_deploy = true;
                assert_eq!(op, "deploy");
                self.assert_deploy_batch(r, args);
            } else if let Some(role) = account_role(r.receiver_id.as_str()) {
                *self.received.entry(role.to_string()).or_insert(0) += unscale(transfers);
            } else if !r.actions.is_empty() && transfers > 0 {
                // The callback receipt carries no value; any other value-bearing receipt is a bug.
                panic!("unexpected value transfer to {}", r.receiver_id);
            }
        }
        match op {
            "draw" => {
                assert_eq!(receipts.len(), 1, "draw creates exactly one receipt");
                let bound = self.v.mandate().expect("mandate").agent;
                assert_eq!(
                    receipts[0].receiver_id, bound,
                    "draw pays mandate.agent only"
                );
            }
            "withdraw" => {
                assert_eq!(receipts.len(), 1);
                assert!(
                    receipts[0].receiver_id.as_str() == OWNER
                        || receipts[0].receiver_id.as_str() == NEW_OWNER
                );
            }
            "deploy" => assert!(saw_deploy, "deploy must create the batch receipt"),
            _ => {}
        }
        self.balance -= unscale(sent_total);
    }

    fn assert_deploy_batch(&mut self, r: &near_sdk::mock::Receipt, args: &Value) {
        self.deploy_batches += 1;
        let name = args["name"].as_str().unwrap();
        assert_eq!(r.receiver_id.as_str(), format!("{name}.{VAULT}"));
        let kinds: Vec<&str> = r
            .actions
            .iter()
            .map(|a| match a {
                MockAction::CreateAccount { .. } => "create_account",
                MockAction::Transfer { .. } => "transfer",
                MockAction::DeployContract { .. } => "deploy_contract",
                MockAction::FunctionCallWeight { method_name, .. } => {
                    assert_eq!(method_name.as_slice(), b"new");
                    "function_call"
                }
                other => panic!("forbidden action in deploy batch: {other:?}"),
            })
            .collect();
        assert_eq!(
            kinds,
            [
                "create_account",
                "transfer",
                "deploy_contract",
                "function_call"
            ]
        );
    }

    fn check_state(&self, state: &Value, t: u64, who: &str) {
        self.ctx(who, t).set();
        let v = &self.v;
        for (key, want) in state.as_object().unwrap() {
            match key.as_str() {
                "available" => assert_eq!(unscale(v.available().0), want.as_u64().unwrap().into()),
                "total_spent" => {
                    assert_eq!(
                        unscale(v.usage().total_spent.0),
                        want.as_u64().unwrap().into()
                    )
                }
                "period_spent" => {
                    let ps = v.period_state(Some(U64(t))).expect("mandate");
                    assert_eq!(unscale(ps.period_spent.0), want.as_u64().unwrap().into());
                }
                "deploys" => assert_eq!(u64::from(v.usage().deploys), want.as_u64().unwrap()),
                "epoch" => assert_eq!(v.config().epoch.0, want.as_u64().unwrap()),
                "paused" => assert_eq!(v.config().paused, want.as_bool().unwrap()),
                "revoked" => assert_eq!(
                    v.mandate().expect("mandate").revoked,
                    want.as_bool().unwrap()
                ),
                "received" => {
                    for (role, amount) in want.as_object().unwrap() {
                        let got = self.received.get(role.as_str()).copied().unwrap_or(0);
                        assert_eq!(
                            got,
                            u128::from(amount.as_u64().unwrap()),
                            "received[{role}]"
                        );
                    }
                }
                "agent_received" => {
                    let got = self.received.get("agent").copied().unwrap_or(0);
                    assert_eq!(got, u128::from(want.as_u64().unwrap()), "agent_received");
                }
                k => panic!("unknown state key {k:?}: the harness would silently skip it"),
            }
        }
    }
}

fn expected(step: &Value) -> Result<(), String> {
    match &step["expect"] {
        Value::String(s) if s == "ok" => Ok(()),
        Value::Object(o) => Err(o["err"].as_str().unwrap().to_string()),
        other => panic!("bad expect {other:?}"),
    }
}

#[test]
fn error_list_matches_the_contract() {
    let f: Value = serde_json::from_str(FILE).unwrap();
    let file: Vec<&str> = f["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e.as_str().unwrap())
        .collect();
    let code: Vec<&str> = Code::ALL.iter().map(|c| c.as_str()).collect();
    assert_eq!(file, code);
}

#[test]
fn near_conformance_all_scenarios() {
    let f: Value = serde_json::from_str(FILE).unwrap();
    assert_eq!(f["version"], 1);
    let mut ran = Vec::new();
    let mut skipped = Vec::new();
    let mut steps_run = 0usize;
    let mut codes_seen = BTreeSet::new();
    let mut batches = 0usize;
    for sc in f["scenarios"].as_array().unwrap() {
        let name = sc["name"].as_str().unwrap();
        match sc["only"].as_str() {
            None | Some("near") => {}
            Some("evm") => {
                skipped.push(name.to_string());
                continue;
            }
            Some(x) => panic!("unknown chain tag {x:?} in {name}"),
        }
        let mut run = Run::new(sc["setup"]["balance"].as_u64().unwrap().into());
        for tpl in sc["setup"]["templates"].as_array().unwrap() {
            fixture(tpl.as_str().unwrap()); // fails loudly when a fixture is missing
        }
        for (i, step) in sc["steps"].as_array().unwrap().iter().enumerate() {
            let at = format!("{name} step {i} ({} {})", step["as"], step["op"]);
            let out = run.step(step);
            let want = expected(step);
            assert_eq!(out.result, want, "{at}: result");
            if let Err(c) = &want {
                codes_seen.insert(c.clone());
            }
            // Preview parity.
            if let Some(pv) = &out.preview {
                match &out.result {
                    Ok(()) => {
                        assert_eq!(pv, "", "{at}: preview says {pv:?} but the call succeeded")
                    }
                    Err(c) if c == "Unauthorized" || c == "CodeMismatch" => {
                        assert_ne!(pv, c, "{at}: previews never return {c}")
                    }
                    Err(c) => assert_eq!(pv, c, "{at}: preview != real error"),
                }
            }
            steps_run += 1;
            if let Some(state) = step.get("state") {
                run.check_state(state, secs(step, "t"), OWNER);
            }
        }
        batches += run.deploy_batches;
        ran.push(name.to_string());
    }
    let total = f["scenarios"].as_array().unwrap().len();
    assert_eq!(ran.len() + skipped.len(), total);
    assert!(ran.len() >= 10, "suspiciously few scenarios ran: {ran:?}");
    assert_eq!(skipped, ["evm_template_deposit_must_be_zero"]);
    assert!(batches >= 4, "deploy batches were not exercised");
    println!(
        "NEAR conformance: {} scenarios / {steps_run} steps ran, {} skipped (only=evm): {skipped:?}",
        ran.len(),
        skipped.len()
    );
    println!("ran: {ran:?}");
    println!("error codes asserted by scenarios: {codes_seen:?}");
}
