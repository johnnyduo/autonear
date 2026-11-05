//! Named unit / negative tests for everything the shared conformance file does not cover.
//! The conformance scenarios themselves live in `conformance.rs`.

use super::testkit::*;
use super::*;
use near_sdk::mock::{MockAction, Receipt};
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs};
use near_sdk::testing_env;
use near_sdk::PromiseResult;

use near_sdk::test_utils::VMContextBuilder;

const DAY: u64 = 86_400;

/// A vault at time `t` with `avail` spendable yoctoNEAR; tracks storage usage and value sent.
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

    /// Vault with a mandate for AGENT: per-draw 10, period 25 (1 h), total 100 NEAR, 5 deploys, 1 day.
    fn with_mandate() -> Self {
        let mut fx = Fx::new(1_000 * NEAR);
        fx.set_mandate(AGENT);
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

    fn run_attached<R>(
        &mut self,
        who: &str,
        attached: u128,
        f: impl FnOnce(&mut Vault) -> R,
    ) -> Result<R, String> {
        Ctx::new(who, self.t, self.avail)
            .su(self.su)
            .attach(attached)
            .set();
        let v = &mut self.v;
        let r = try_call(|| f(v));
        self.logs = get_logs();
        self.receipts = get_created_receipts();
        if r.is_ok() {
            self.su = env::storage_usage();
            self.avail += attached;
            let sent: u128 = self.receipts.iter().map(transfers_of).sum();
            self.avail -= sent;
        }
        r
    }

    fn run<R>(&mut self, who: &str, f: impl FnOnce(&mut Vault) -> R) -> Result<R, String> {
        self.run_attached(who, 0, f)
    }

    /// Read-only access at the current time / state.
    fn view<R>(&self, f: impl FnOnce(&Vault) -> R) -> R {
        Ctx::new(OWNER, self.t, self.avail).su(self.su).set();
        f(&self.v)
    }

    fn allow(&mut self, wasm: &[u8], deposit: u128) -> String {
        let id = hash_hex(wasm);
        let id2 = id.clone();
        self.run(OWNER, |v| {
            v.allow_template(id2, "registry-v1".into(), U128(deposit), None, None)
        })
        .unwrap();
        id
    }

    fn deploy(&mut self, id: &str, name: &str, code: &[u8]) -> Result<(), String> {
        let (id, name, code) = (id.to_string(), name.to_string(), code.to_vec());
        self.run(AGENT, |v| {
            v.deploy(id, name, code.into());
        })
    }

    fn events(&self) -> Vec<Value> {
        events_of(&self.logs)
    }
}

fn transfers_of(r: &Receipt) -> u128 {
    r.actions
        .iter()
        .map(|a| match a {
            MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
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

/// Runs the failure/success callback as the contract itself.
fn callback(fx: &mut Fx, failed: bool, epoch: u64, period: u64, id: &str, name: &str, dep: u128) {
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
    fx.v.on_deployed(
        U64(epoch),
        U64(period),
        id.to_string(),
        name.to_string(),
        U128(dep),
    );
    fx.logs = get_logs();
    fx.su = env::storage_usage();
    fx.avail += if failed { dep } else { 0 }; // the runtime refunds the failed batch's deposit
}

// ------------------------------------------------------------------ fresh state / views

#[test]
fn fresh_vault_views() {
    let fx = Fx::new(5 * NEAR);
    fx.view(|v| {
        let c = v.config();
        assert_eq!(c.owner, acct(OWNER));
        assert_eq!(c.pending_owner, None);
        assert!(!c.paused);
        assert_eq!(c.epoch, U64(0));
        assert_eq!(c.network_id, "testnet");
        assert_eq!(c.vault_id, acct(VAULT));
        assert_eq!(c.reserve, U128(RESERVE_YOCTO));
        assert!(v.mandate().is_none());
        assert_eq!(v.usage().total_spent, U128(0));
        assert!(v.period_state(None).is_none());
        assert!(v.templates(None, None).is_empty());
        assert_eq!(v.available(), U128(5 * NEAR));
        assert_eq!(v.preview_draw(U128(1)), "NoMandate");
        assert_eq!(v.preview_deploy("zz".into(), "a".into()), "NoMandate");
    });
}

#[test]
fn init_guards() {
    reset_storage();
    Ctx::new(OWNER, T0, NEAR).set();
    expect_code("BadOwner", || Vault::new(acct("system"), "testnet".into()));
    expect_code("BadOwner", || {
        Vault::new(acct(&"0".repeat(64)), "testnet".into())
    });
    expect_code("BadOwner", || Vault::new(acct(VAULT), "testnet".into()));
    let r = std::panic::catch_unwind(|| Vault::new(acct(OWNER), String::new()));
    assert!(r.is_err(), "empty network id must be rejected");
}

#[test]
fn available_is_balance_minus_storage_minus_reserve_floored_at_zero() {
    let mk = |bal: u128, su: u64| {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acct(VAULT))
            .storage_usage(su)
            .account_balance(NearToken::from_yoctonear(bal))
            .build());
        Vault::available_yocto()
    };
    assert_eq!(mk(10 * NEAR, 1000), 10 * NEAR - 1000 * BYTE_COST - NEAR);
    assert_eq!(mk(NEAR, 0), 0, "exactly the reserve => 0");
    assert_eq!(
        mk(NEAR / 2, 0),
        0,
        "below the reserve floors at 0, never underflows"
    );
    assert_eq!(
        mk(2 * NEAR, 200_000),
        0,
        "storage above balance floors at 0"
    );
}

#[test]
fn time_is_seconds_not_nanoseconds() {
    let mut fx = Fx::new(100 * NEAR);
    let t = fx.t;
    // expires_at is in seconds: a ns-looking value is far beyond the 30 day cap.
    let r = fx.run(OWNER, |v| {
        v.set_mandate(
            AGENT.into(),
            U64(t * NS_PER_SEC),
            U128(1),
            U64(60),
            U128(1),
            U128(1),
            0,
        )
    });
    assert_eq!(r, Err("BadMandate".into()));
    fx.set_mandate(AGENT);
    fx.view(|v| assert_eq!(v.mandate().unwrap().start, U64(T0)));
    assert_eq!(
        now_secs(),
        T0,
        "view context uses seconds from block_timestamp"
    );
}

#[test]
fn period_state_view_tracks_rollover() {
    let mut fx = Fx::with_mandate();
    fx.run(AGENT, |v| {
        v.draw(U128(10 * NEAR));
    })
    .unwrap();
    let ps = fx.view(|v| v.period_state(None).unwrap());
    assert_eq!(ps.period_index, U64(0));
    assert_eq!(ps.period_start, U64(T0));
    assert_eq!(ps.period_end, U64(T0 + 3600));
    assert_eq!(ps.period_spent, U128(10 * NEAR));
    assert_eq!(ps.period_remaining, U128(15 * NEAR));
    assert_eq!(ps.total_remaining, U128(90 * NEAR));
    assert_eq!(ps.deploys_remaining, 5);
    assert!(ps.active);
    let next = fx.view(|v| v.period_state(Some(U64(T0 + 3600))).unwrap());
    assert_eq!(next.period_index, U64(1));
    assert_eq!(
        next.period_spent,
        U128(0),
        "new period reads as 0 before any spend"
    );
    let after = fx.view(|v| v.period_state(Some(U64(T0 + DAY))).unwrap());
    assert!(!after.active, "now >= expires_at");
}

// ------------------------------------------------------------------ templates

#[test]
fn init_args_size_limit_is_1_kib_exactly() {
    let mut fx = Fx::new(100 * NEAR);
    let id = hash_hex(WASM_T1);
    // {"k":"<n x>"} has 8 bytes of framing: 1016 payload chars => exactly 1024 bytes.
    let args = |n: usize| json!({ "k": "x".repeat(n) });
    assert_eq!(serde_json::to_vec(&args(1016)).unwrap().len(), 1024);
    let id2 = id.clone();
    fx.run(OWNER, |v| {
        v.allow_template(id2, "ok".into(), U128(0), Some(args(1016)), None)
    })
    .expect("1024 bytes is allowed");
    let id3 = id.clone();
    let r = fx.run(OWNER, |v| {
        v.allow_template(id3, "big".into(), U128(0), Some(args(1017)), None)
    });
    assert_eq!(r, Err("BadTemplate".into()), "1025 bytes is rejected");
    // The rejected update did not replace the stored template.
    let t = fx.view(|v| v.template(id.clone())).unwrap();
    assert_eq!(t.label, "ok");
}

#[test]
fn allow_template_rejects_bad_inputs() {
    let mut fx = Fx::new(100 * NEAR);
    let id = hash_hex(WASM_T1);
    let bad = |fx: &mut Fx, id: &str, label: &str, args: Option<Value>, gas: Option<u64>| {
        let (id, label) = (id.to_string(), label.to_string());
        fx.run(OWNER, |v| {
            v.allow_template(id, label, U128(0), args, gas.map(U64))
        })
    };
    let ok = Err("BadTemplate".to_string());
    assert_eq!(bad(&mut fx, "abc", "x", None, None), ok, "short id");
    assert_eq!(
        bad(&mut fx, &id.to_uppercase(), "x", None, None),
        ok,
        "uppercase hex"
    );
    assert_eq!(
        bad(&mut fx, &"g".repeat(64), "x", None, None),
        ok,
        "non-hex"
    );
    assert_eq!(
        bad(&mut fx, &id, &"a".repeat(65), None, None),
        ok,
        "label 65 bytes"
    );
    assert!(
        bad(&mut fx, &id, &"a".repeat(64), None, None).is_ok(),
        "label 64 bytes"
    );
    assert!(
        bad(&mut fx, &id, &"é".repeat(32), None, None).is_ok(),
        "64 bytes of utf8"
    );
    assert_eq!(
        bad(&mut fx, &id, &"é".repeat(33), None, None),
        ok,
        "66 bytes of utf8"
    );
    assert_eq!(
        bad(&mut fx, &id, "x", Some(json!([1])), None),
        ok,
        "args must be an object"
    );
    assert_eq!(bad(&mut fx, &id, "x", Some(json!("s")), None), ok);
    assert_eq!(
        bad(&mut fx, &id, "x", None, Some(MIN_INIT_GAS - 1)),
        ok,
        "gas too low"
    );
    assert_eq!(
        bad(&mut fx, &id, "x", None, Some(MAX_INIT_GAS + 1)),
        ok,
        "gas too high"
    );
    assert!(bad(&mut fx, &id, "x", None, Some(MIN_INIT_GAS)).is_ok());
    assert!(bad(&mut fx, &id, "x", None, Some(MAX_INIT_GAS)).is_ok());
}

#[test]
fn template_views_and_pagination() {
    let mut fx = Fx::new(100 * NEAR);
    let mut ids = vec![];
    for i in 0..7u8 {
        let id = to_hex(&env::sha256_array(&[i]));
        let (id2, label) = (id.clone(), format!("t{i}"));
        fx.run(OWNER, |v| {
            v.allow_template(
                id2,
                label,
                U128(u128::from(i)),
                Some(json!({ "n": i })),
                Some(U64(40 * TGAS)),
            )
        })
        .unwrap();
        ids.push(id);
    }
    fx.view(|v| {
        assert_eq!(v.templates(None, None).len(), 7);
        let page = v.templates(Some(U64(2)), Some(U64(3)));
        assert_eq!(page.len(), 3);
        assert_eq!(page[0].id, ids[2]);
        assert_eq!(v.templates(Some(U64(6)), Some(U64(100))).len(), 1);
        assert!(v.templates(Some(U64(7)), None).is_empty());
        assert_eq!(
            v.templates(Some(U64(u64::MAX)), None).len(),
            0,
            "huge offset is safe"
        );
        assert_eq!(
            v.templates(None, Some(U64(u64::MAX))).len(),
            7,
            "limit is capped"
        );
        let t = v.template(ids[3].clone()).unwrap();
        assert_eq!(t.label, "t3");
        assert_eq!(t.deposit, U128(3));
        assert_eq!(t.init_args, json!({ "n": 3 }));
        assert_eq!(t.init_gas, U64(40 * TGAS));
        assert!(v.template("nope".into()).is_none());
        assert!(v.template(hash_hex(b"unknown")).is_none());
    });
    // Re-allowing updates in place and reports `updated`.
    let id0 = ids[0].clone();
    fx.run(OWNER, |v| {
        v.allow_template(id0, "renamed".into(), U128(9), None, None)
    })
    .unwrap();
    assert_eq!(fx.events()[0]["data"]["updated"], true);
    fx.view(|v| {
        assert_eq!(v.templates(None, None).len(), 7);
        let t = v.template(ids[0].clone()).unwrap();
        assert_eq!(
            (t.label.as_str(), t.deposit, t.init_args.clone()),
            ("renamed", U128(9), json!({}))
        );
        assert_eq!(t.init_gas, U64(DEFAULT_INIT_GAS));
    });
    // Disallow removes exactly one entry.
    let id1 = ids[1].clone();
    fx.run(OWNER, |v| v.disallow_template(id1)).unwrap();
    fx.view(|v| assert_eq!(v.templates(None, None).len(), 6));
}

// ------------------------------------------------------------------ deploy batch

#[test]
fn deploy_sends_stored_init_args_and_gas_verbatim_and_no_key_action() {
    let mut fx = Fx::with_mandate();
    let id = hash_hex(WASM_T1);
    let args = json!({"owner_id": "boss.testnet", "network_id": "testnet"});
    let id2 = id.clone();
    let a2 = args.clone();
    fx.run(OWNER, |v| {
        v.allow_template(
            id2,
            "r".into(),
            U128(3 * NEAR),
            Some(a2),
            Some(U64(45 * TGAS)),
        )
    })
    .unwrap();
    let avail_before = fx.avail;
    fx.deploy(&id, "reg-1", WASM_T1).unwrap();
    // One batch receipt to the sub-account, one callback receipt to the vault.
    let batch = fx
        .receipts
        .iter()
        .find(|r| r.receiver_id.as_str() == "reg-1.vault.testnet")
        .expect("batch receipt");
    let kinds: Vec<&MockAction> = batch.actions.iter().collect();
    assert!(matches!(kinds[0], MockAction::CreateAccount { .. }));
    assert!(
        matches!(kinds[1], MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == 3 * NEAR)
    );
    assert!(matches!(kinds[2], MockAction::DeployContract { code, .. } if code == WASM_T1));
    match kinds[3] {
        MockAction::FunctionCallWeight {
            method_name,
            args: a,
            attached_deposit,
            prepaid_gas,
            ..
        } => {
            assert_eq!(method_name.as_slice(), b"new");
            let sent: Value = serde_json::from_slice(a).unwrap();
            assert_eq!(
                sent, args,
                "init args come from the owner's template, byte-for-byte JSON"
            );
            assert_eq!(attached_deposit.as_yoctonear(), 0);
            assert_eq!(prepaid_gas.as_gas(), 45 * TGAS);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        kinds.len(),
        4,
        "create_account, transfer, deploy_contract, function_call and NOTHING else"
    );
    for r in &fx.receipts {
        for a in &r.actions {
            assert!(
                !matches!(
                    a,
                    MockAction::AddKeyWithFullAccess { .. }
                        | MockAction::AddKeyWithFunctionCall { .. }
                        | MockAction::DeleteKey { .. }
                        | MockAction::DeleteAccount { .. }
                        | MockAction::Stake { .. }
                ),
                "forbidden action {a:?}"
            );
        }
    }
    // The callback receipt targets the vault and carries no value.
    let cb = fx
        .receipts
        .iter()
        .find(|r| r.receiver_id.as_str() == VAULT)
        .expect("callback receipt");
    assert_eq!(transfers_of(cb), 0);
    assert!(matches!(&cb.actions[0],
        MockAction::FunctionCallWeight { method_name, prepaid_gas, .. }
            if method_name.as_slice() == b"on_deployed" && prepaid_gas.as_gas() == CALLBACK_GAS));
    assert_eq!(
        avail_before - fx.avail,
        3 * NEAR,
        "only the template deposit leaves the vault"
    );
    let e = fx.events();
    assert_eq!(ev(&e[0]), "deployed");
    assert_eq!(e[0]["data"]["target"], "reg-1.vault.testnet");
}

#[test]
fn agent_cannot_choose_init_args_gas_or_deposit() {
    // Structural: deploy() takes exactly (template, name, code); code is bound to the template hash.
    // Any code with different bytes (e.g. one embedding other behaviour) is CodeMismatch.
    let mut fx = Fx::with_mandate();
    let id = fx.allow(WASM_T1, 0);
    assert_eq!(fx.deploy(&id, "x1", WASM_T2), Err("CodeMismatch".into()));
    let mut longer = WASM_T1.to_vec();
    longer.push(0);
    assert_eq!(fx.deploy(&id, "x1", &longer), Err("CodeMismatch".into()));
    assert_eq!(fx.deploy(&id, "x1", b""), Err("CodeMismatch".into()));
    assert!(fx.deploy(&id, "x1", WASM_T1).is_ok());
}

#[test]
fn deploy_rules_run_in_spec_order() {
    let mut fx = Fx::with_mandate();
    let id1 = fx.allow(WASM_T1, 20 * NEAR);
    // TemplateNotAllowed beats everything below it.
    let unk = hash_hex(b"nope");
    assert_eq!(
        fx.deploy(&unk, "A!", WASM_T2),
        Err("TemplateNotAllowed".into())
    );
    assert_eq!(
        fx.deploy("zz", "A!", WASM_T2),
        Err("TemplateNotAllowed".into())
    );
    // CodeMismatch beats BadName / budget.
    assert_eq!(fx.deploy(&id1, "A!", WASM_T2), Err("CodeMismatch".into()));
    // Spend rules beat BadName.
    fx.run(AGENT, |v| {
        v.draw(U128(10 * NEAR));
    })
    .unwrap(); // period 10/25
    assert_eq!(fx.deploy(&id1, "A!", WASM_T1), Err("PeriodCap".into()));
    // BadName once budget allows (new period).
    fx.t += 3600;
    assert_eq!(fx.deploy(&id1, "A!", WASM_T1), Err("BadName".into()));
    assert!(fx.deploy(&id1, "good", WASM_T1).is_ok());
}

#[test]
fn deploy_limit_beats_budget_rules() {
    let mut fx = Fx::with_mandate();
    let t = fx.t;
    fx.run(OWNER, |v| {
        v.set_mandate(
            AGENT.into(),
            U64(t + DAY),
            U128(NEAR),
            U64(3600),
            U128(NEAR),
            U128(NEAR),
            0,
        )
    })
    .unwrap();
    let id = fx.allow(WASM_T1, 50 * NEAR); // deposit > period cap too
    assert_eq!(fx.deploy(&id, "x1", WASM_T1), Err("DeployLimit".into()));
}

#[test]
fn name_validation_table() {
    let good = [
        "a",
        "ab",
        "a1",
        "1a",
        "a-b",
        "a_b",
        "a-b-c",
        "x9_y",
        &"a".repeat(32),
    ];
    let bad = [
        "",
        "A",
        "aB",
        "a.b",
        ".a",
        "a.",
        "-a",
        "a-",
        "_a",
        "a_",
        "a--b",
        "a-_b",
        "a__b",
        "a b",
        "a/b",
        "é",
        "a\n",
        "a@b",
        &"a".repeat(33),
        "a*",
    ];
    for g in good {
        assert!(valid_name(g), "{g:?} should be valid");
    }
    for b in bad {
        assert!(!valid_name(b), "{b:?} should be invalid");
    }
}

#[test]
fn full_account_id_must_still_be_valid() {
    // A 33-char vault account + "." + 32-char name > 64 chars: not a valid account id => BadName.
    let long_vault = format!("{}.testnet", "v".repeat(24));
    reset_storage();
    testing_env!(VMContextBuilder::new()
        .current_account_id(acct(&long_vault))
        .predecessor_account_id(acct(OWNER))
        .block_timestamp(T0 * NS_PER_SEC)
        .account_balance(NearToken::from_yoctonear(100 * NEAR))
        .build());
    let mut v = Vault::new(acct(OWNER), "testnet".into());
    v.set_mandate(
        AGENT.into(),
        U64(T0 + 100),
        U128(1),
        U64(60),
        U128(1),
        U128(1),
        1,
    );
    let id = hash_hex(WASM_T1);
    v.allow_template(id.clone(), "x".into(), U128(0), None, None);
    assert_eq!(v.preview_deploy(id.clone(), "n".repeat(32)), "BadName");
    assert_eq!(v.preview_deploy(id, "n".repeat(8)), "");
}

#[test]
fn preview_deploy_never_reports_code_mismatch_but_real_deploy_does() {
    let mut fx = Fx::with_mandate();
    let id = fx.allow(WASM_T1, 0);
    assert_eq!(fx.view(|v| v.preview_deploy(id.clone(), "x1".into())), "");
    assert_eq!(fx.deploy(&id, "x1", WASM_T2), Err("CodeMismatch".into()));
}

#[test]
fn address_taken_and_name_reuse_across_mandates() {
    let mut fx = Fx::with_mandate();
    let id = fx.allow(WASM_T1, 0);
    fx.deploy(&id, "dup", WASM_T1).unwrap();
    fx.set_mandate(AGENT); // new epoch, usage reset...
    assert_eq!(
        fx.deploy(&id, "dup", WASM_T1),
        Err("AddressTaken".into()),
        "...but names stay used"
    );
    assert_eq!(
        fx.view(|v| v.preview_deploy(id.clone(), "dup".into())),
        "AddressTaken"
    );
}

// ------------------------------------------------------------------ on_deployed callback

#[test]
fn callback_failure_reverses_counters_releases_name_and_emits_deploy_failed() {
    let mut fx = Fx::with_mandate();
    let id = fx.allow(WASM_T1, 7 * NEAR);
    fx.deploy(&id, "reg", WASM_T1).unwrap();
    let u = fx.view(|v| v.usage());
    assert_eq!(
        (u.total_spent, u.period_spent, u.deploys),
        (U128(7 * NEAR), U128(7 * NEAR), 1)
    );
    assert_eq!(
        fx.avail,
        993 * NEAR,
        "deposit left the balance immediately (optimistic window)"
    );
    let pi = u.period_index.0;
    assert_eq!(
        fx.deploy(&id, "reg", WASM_T1),
        Err("AddressTaken".into()),
        "name reserved while in flight"
    );

    callback(&mut fx, true, 1, pi, &id, "reg", 7 * NEAR);
    let u = fx.view(|v| v.usage());
    assert_eq!(
        (u.total_spent, u.period_spent, u.deploys),
        (U128(0), U128(0), 0)
    );
    assert_eq!(fx.avail, 1000 * NEAR, "refund returned the deposit");
    let e = events_of(&fx.logs);
    assert_eq!(ev(&e[0]), "deploy_failed");
    assert_eq!(e[0]["data"]["reversed"], true);
    assert_eq!(e[0]["data"]["target"], "reg.vault.testnet");
    assert_eq!(e[0]["data"]["deposit"], (7 * NEAR).to_string());
    // The name is free again and the budget is back.
    fx.deploy(&id, "reg", WASM_T1).unwrap();
    assert_eq!(fx.view(|v| v.usage()).deploys, 1);
}

#[test]
fn callback_success_keeps_the_charge_and_confirms() {
    let mut fx = Fx::with_mandate();
    let id = fx.allow(WASM_T1, 7 * NEAR);
    fx.deploy(&id, "reg", WASM_T1).unwrap();
    let pi = fx.view(|v| v.usage().period_index.0);
    callback(&mut fx, false, 1, pi, &id, "reg", 7 * NEAR);
    let u = fx.view(|v| v.usage());
    assert_eq!((u.total_spent, u.deploys), (U128(7 * NEAR), 1));
    let e = events_of(&fx.logs);
    assert_eq!(ev(&e[0]), "deploy_confirmed");
    assert_eq!(
        fx.deploy(&id, "reg", WASM_T1),
        Err("AddressTaken".into()),
        "name stays used"
    );
}

#[test]
fn callback_failure_after_mandate_replacement_does_not_touch_the_new_epoch() {
    let mut fx = Fx::with_mandate();
    let id = fx.allow(WASM_T1, 7 * NEAR);
    fx.deploy(&id, "reg", WASM_T1).unwrap();
    fx.set_mandate(AGENT); // epoch 2, usage reset
    fx.run(AGENT, |v| {
        v.draw(U128(4 * NEAR));
    })
    .unwrap();
    callback(&mut fx, true, 1, 0, &id, "reg", 7 * NEAR);
    let u = fx.view(|v| v.usage());
    assert_eq!(
        (u.total_spent, u.period_spent, u.deploys),
        (U128(4 * NEAR), U128(4 * NEAR), 0)
    );
    let e = events_of(&fx.logs);
    assert_eq!(ev(&e[0]), "deploy_failed");
    assert_eq!(
        e[0]["data"]["reversed"], false,
        "stale epoch: reported, not applied"
    );
    // The name was still released.
    assert_eq!(fx.view(|v| v.preview_deploy(id.clone(), "reg".into())), "");
}

#[test]
fn callback_failure_after_period_rollover_reverses_total_but_not_the_new_period() {
    let mut fx = Fx::with_mandate();
    let id = fx.allow(WASM_T1, 7 * NEAR);
    fx.deploy(&id, "reg", WASM_T1).unwrap(); // period 0: 7
    fx.t += 3600;
    fx.run(AGENT, |v| {
        v.draw(U128(4 * NEAR));
    })
    .unwrap(); // period 1: 4, total 11
    callback(&mut fx, true, 1, 0, &id, "reg", 7 * NEAR);
    let u = fx.view(|v| v.usage());
    assert_eq!(u.total_spent, U128(4 * NEAR));
    assert_eq!(u.period_index, U64(1));
    assert_eq!(
        u.period_spent,
        U128(4 * NEAR),
        "period 1's spend is not reduced by a period-0 reversal"
    );
    assert_eq!(u.deploys, 0);
}

#[test]
fn double_callback_cannot_underflow() {
    let mut fx = Fx::with_mandate();
    let id = fx.allow(WASM_T1, 7 * NEAR);
    fx.deploy(&id, "reg", WASM_T1).unwrap();
    callback(&mut fx, true, 1, 0, &id, "reg", 7 * NEAR);
    callback(&mut fx, true, 1, 0, &id, "reg", 7 * NEAR); // replay: saturating, never panics
    let u = fx.view(|v| v.usage());
    assert_eq!(
        (u.total_spent, u.period_spent, u.deploys),
        (U128(0), U128(0), 0)
    );
}

// ------------------------------------------------------------------ owner liveness / agent power

#[test]
fn owner_can_still_withdraw_when_everything_else_is_blocked() {
    let mut fx = Fx::with_mandate();
    let id = fx.allow(WASM_T1, 0);
    fx.run(OWNER, |v| v.pause()).unwrap();
    fx.run(OWNER, |v| v.revoke()).unwrap();
    fx.run(OWNER, |v| v.disallow_template(id)).unwrap();
    fx.t += 10 * DAY; // mandate long expired
    fx.run(OWNER, |v| v.transfer_ownership(NEW_OWNER.into()))
        .unwrap(); // pending owner exists
    assert_eq!(
        fx.run(AGENT, |v| {
            v.draw(U128(1));
        }),
        Err("Paused".into())
    );
    let before = fx.avail;
    fx.run(OWNER, |v| {
        v.withdraw(U128(before));
    })
    .unwrap();
    assert_eq!(fx.avail, 0, "everything spendable is withdrawable");
    assert_eq!(fx.receipts.len(), 1);
    assert_eq!(fx.receipts[0].receiver_id, acct(OWNER));
    assert_eq!(transfers_of(&fx.receipts[0]), before);
    assert_eq!(fx.events()[0]["event"], "withdrawn");
}

#[test]
fn withdraw_even_after_budget_exhausted_and_no_mandate_ever() {
    let mut fx = Fx::new(50 * NEAR);
    fx.run(OWNER, |v| {
        v.withdraw(U128(50 * NEAR));
    })
    .unwrap();
    assert_eq!(fx.receipts[0].receiver_id, acct(OWNER));
    assert_eq!(
        fx.run(OWNER, |v| {
            v.withdraw(U128(1));
        }),
        Err("InsufficientBalance".into())
    );
}

#[test]
fn agent_cannot_reach_any_owner_method() {
    let mut fx = Fx::with_mandate();
    let id = fx.allow(WASM_T1, 0);
    let id2 = id.clone();
    let t = fx.t;
    let mut attempts: Vec<(&str, Result<(), String>)> = vec![];
    attempts.push((
        "set_mandate",
        fx.run(AGENT, |v| {
            v.set_mandate(
                AGENT.into(),
                U64(t + 100),
                U128(1),
                U64(60),
                U128(1),
                U128(1),
                0,
            )
        }),
    ));
    attempts.push(("revoke", fx.run(AGENT, |v| v.revoke())));
    attempts.push(("pause", fx.run(AGENT, |v| v.pause())));
    attempts.push(("unpause", fx.run(AGENT, |v| v.unpause())));
    attempts.push((
        "allow_template",
        fx.run(AGENT, |v| {
            v.allow_template(
                hash_hex(WASM_T2),
                "evil".into(),
                U128(0),
                Some(json!({"owner_id": AGENT})),
                None,
            )
        }),
    ));
    attempts.push((
        "disallow_template",
        fx.run(AGENT, |v| v.disallow_template(id2)),
    ));
    attempts.push((
        "withdraw",
        fx.run(AGENT, |v| {
            v.withdraw(U128(1));
        }),
    ));
    attempts.push((
        "transfer_ownership",
        fx.run(AGENT, |v| v.transfer_ownership(AGENT.into())),
    ));
    attempts.push(("accept_ownership", fx.run(AGENT, |v| v.accept_ownership())));
    for (name, r) in attempts {
        assert_eq!(r, Err("Unauthorized".into()), "{name} must be owner-only");
    }
    // Even if the owner nominated the agent, the agent only becomes owner by accepting (explicit).
    fx.run(OWNER, |v| v.transfer_ownership(AGENT.into()))
        .unwrap();
    fx.view(|v| assert_eq!(v.config().owner, acct(OWNER)));
    // Nothing the agent tried changed state.
    fx.view(|v| {
        assert_eq!(v.config().epoch, U64(1));
        assert!(!v.config().paused);
        assert!(!v.mandate().unwrap().revoked);
        assert!(v.template(hash_hex(WASM_T2)).is_none());
        assert!(v.template(id).is_some());
    });
}

#[test]
fn no_method_lets_the_agent_redirect_funds() {
    let mut fx = Fx::with_mandate();
    let id = fx.allow(WASM_T1, 2 * NEAR);
    let allowed = |r: &Receipt, name: Option<&str>| {
        let rid = r.receiver_id.as_str();
        rid == AGENT || rid == VAULT || name.is_some_and(|n| rid == format!("{n}.{VAULT}"))
    };
    // Draws pay the bound agent; the signature has no recipient parameter.
    fx.run(AGENT, |v| {
        v.draw(U128(3 * NEAR));
    })
    .unwrap();
    assert_eq!(fx.receipts.len(), 1);
    assert_eq!(fx.receipts[0].receiver_id, acct(AGENT));
    assert_eq!(transfers_of(&fx.receipts[0]), 3 * NEAR);
    // A mandate whose agent is somebody else: draws go to THAT account, never to the caller.
    fx.set_mandate(OTHER);
    assert_eq!(
        fx.run(AGENT, |v| {
            v.draw(U128(1));
        }),
        Err("Unauthorized".into())
    );
    fx.run(OTHER, |v| {
        v.draw(U128(NEAR));
    })
    .unwrap();
    assert_eq!(fx.receipts[0].receiver_id, acct(OTHER));
    // Deploys move value only to the new keyless sub-account.
    let (id2, c) = (id.clone(), WASM_T1.to_vec());
    fx.run(OTHER, |v| {
        v.deploy(id2, "dst".into(), c.into());
    })
    .unwrap();
    for r in &fx.receipts {
        assert!(
            allowed(r, Some("dst")),
            "unexpected receiver {}",
            r.receiver_id
        );
        if r.receiver_id.as_str() == "dst.vault.testnet" {
            assert_eq!(transfers_of(r), 2 * NEAR);
        } else {
            assert_eq!(transfers_of(r), 0);
        }
    }
    // Failed agent calls create no receipts at all.
    let r = fx.run(OTHER, |v| {
        v.draw(U128(1_000_000 * NEAR));
    });
    assert!(r.is_err());
    assert!(fx.receipts.is_empty());
}

#[test]
fn draw_never_overflows_on_huge_amounts() {
    let mut fx = Fx::with_mandate();
    for amount in [u128::MAX, u128::MAX - 1, 10 * NEAR + 1] {
        assert_eq!(
            fx.run(AGENT, |v| {
                v.draw(U128(amount));
            }),
            Err("PerDrawCap".into())
        );
    }
    let t = fx.t;
    fx.run(OWNER, |v| {
        v.set_mandate(
            AGENT.into(),
            U64(t + 10),
            U128(u128::MAX),
            U64(60),
            U128(u128::MAX),
            U128(u128::MAX),
            1,
        )
    })
    .unwrap();
    assert_eq!(
        fx.run(AGENT, |v| {
            v.draw(U128(u128::MAX));
        }),
        Err("InsufficientBalance".into())
    );
}

// ------------------------------------------------------------------ deposit / plain money

#[test]
fn deposit_requires_value_and_emits_event() {
    let mut fx = Fx::new(10 * NEAR);
    assert_eq!(
        fx.run_attached(OTHER, 0, |v| v.deposit()),
        Err("BadAmount".into())
    );
    fx.run_attached(OTHER, 5 * NEAR, |v| v.deposit()).unwrap();
    assert_eq!(fx.avail, 15 * NEAR);
    let e = fx.events();
    assert_eq!(ev(&e[0]), "deposited");
    assert_eq!(e[0]["data"]["from"], OTHER);
}

// ------------------------------------------------------------------ ownership

#[test]
fn ownership_transfer_can_be_replaced_and_clears_on_accept() {
    let mut fx = Fx::new(NEAR);
    fx.run(OWNER, |v| v.transfer_ownership(OTHER.into()))
        .unwrap();
    fx.run(OWNER, |v| v.transfer_ownership(NEW_OWNER.into()))
        .unwrap();
    fx.view(|v| assert_eq!(v.config().pending_owner, Some(acct(NEW_OWNER))));
    assert_eq!(
        fx.run(OTHER, |v| v.accept_ownership()),
        Err("Unauthorized".into()),
        "replaced nominee"
    );
    fx.run(NEW_OWNER, |v| v.accept_ownership()).unwrap();
    fx.view(|v| {
        assert_eq!(v.config().owner, acct(NEW_OWNER));
        assert_eq!(v.config().pending_owner, None);
    });
    assert_eq!(fx.run(OWNER, |v| v.pause()), Err("Unauthorized".into()));
    for bad in [
        "system",
        &"0".repeat(64),
        VAULT,
        NEW_OWNER,
        "",
        "Not An Account",
    ] {
        assert_eq!(
            fx.run(NEW_OWNER, |v| v.transfer_ownership(bad.into())),
            Err("BadOwner".into()),
            "{bad:?}"
        );
    }
}

#[test]
fn set_mandate_rejects_zero_and_self_agent() {
    let mut fx = Fx::new(NEAR);
    let t = fx.t;
    for bad in ["", "system", &"0".repeat(64), VAULT, "UPPER.testnet"] {
        let r = fx.run(OWNER, |v| {
            v.set_mandate(
                bad.into(),
                U64(t + 100),
                U128(1),
                U64(60),
                U128(1),
                U128(1),
                0,
            )
        });
        assert_eq!(r, Err("BadMandate".into()), "{bad:?}");
    }
}

// ------------------------------------------------------------------ pause / events

#[test]
fn pause_and_revoke_are_idempotent_and_emit_only_on_change() {
    let mut fx = Fx::with_mandate();
    fx.run(OWNER, |v| v.pause()).unwrap();
    assert_eq!(fx.events().len(), 1);
    fx.run(OWNER, |v| v.pause()).unwrap();
    assert!(fx.events().is_empty());
    fx.run(OWNER, |v| v.unpause()).unwrap();
    fx.run(OWNER, |v| v.unpause()).unwrap();
    assert!(fx.events().is_empty());
    fx.run(OWNER, |v| v.revoke()).unwrap();
    assert_eq!(ev(&fx.events()[0]), "mandate_revoked");
    fx.run(OWNER, |v| v.revoke()).unwrap();
    assert!(fx.events().is_empty());
}

#[test]
fn events_are_nep297_json_for_every_mutation() {
    let mut fx = Fx::new(100 * NEAR);
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
        assert_eq!(e["version"], "1.0.0");
        assert_eq!(e["event"], expect);
        assert!(e["data"].is_object(), "data is an object");
        seen.push(expect.to_string());
    };
    let id = hash_hex(WASM_T1);
    let t = fx.t;
    fx.run(OWNER, |v| {
        v.set_mandate(
            AGENT.into(),
            U64(t + DAY),
            U128(10 * NEAR),
            U64(3600),
            U128(25 * NEAR),
            U128(100 * NEAR),
            5,
        )
    })
    .unwrap();
    check(&fx, "mandate_set");
    let id2 = id.clone();
    fx.run(OWNER, |v| {
        v.allow_template(id2, "r".into(), U128(NEAR), None, None)
    })
    .unwrap();
    check(&fx, "template_allowed");
    fx.run(AGENT, |v| {
        v.draw(U128(NEAR));
    })
    .unwrap();
    check(&fx, "drawn");
    let id3 = id.clone();
    fx.run(AGENT, |v| {
        v.deploy(id3, "x1".into(), WASM_T1.to_vec().into());
    })
    .unwrap();
    check(&fx, "deployed");
    callback(&mut fx, false, 1, 0, &id, "x1", NEAR);
    check(&fx, "deploy_confirmed");
    fx.deploy(&id, "x2", WASM_T1).unwrap();
    callback(&mut fx, true, 1, 0, &id, "x2", NEAR);
    check(&fx, "deploy_failed");
    fx.run_attached(OTHER, NEAR, |v| v.deposit()).unwrap();
    check(&fx, "deposited");
    fx.run(OWNER, |v| v.pause()).unwrap();
    check(&fx, "paused");
    fx.run(OWNER, |v| v.unpause()).unwrap();
    check(&fx, "unpaused");
    fx.run(OWNER, |v| {
        v.withdraw(U128(NEAR));
    })
    .unwrap();
    check(&fx, "withdrawn");
    let id4 = id.clone();
    fx.run(OWNER, |v| v.disallow_template(id4)).unwrap();
    check(&fx, "template_disallowed");
    fx.run(OWNER, |v| v.revoke()).unwrap();
    check(&fx, "mandate_revoked");
    fx.run(OWNER, |v| v.transfer_ownership(NEW_OWNER.into()))
        .unwrap();
    check(&fx, "ownership_transfer_started");
    fx.run(NEW_OWNER, |v| v.accept_ownership()).unwrap();
    check(&fx, "ownership_transferred");
    // `initialized` is emitted by `new`.
    reset_storage();
    Ctx::new(OWNER, T0, NEAR).set();
    let _ = Vault::new(acct(OWNER), "testnet".into());
    assert_eq!(events_of(&get_logs())[0]["event"], "initialized");
    // Failed calls emit nothing.
    assert_eq!(fx.run(OWNER, |v| v.pause()), Err("Unauthorized".into()));
    assert!(fx.events().is_empty());
    assert_eq!(seen.len(), 14);
}

#[test]
fn panic_messages_start_with_e_code_for_every_code_reachable_in_a_unit_test() {
    // Direct check of the wire format (the panic payload of the mocked VM is `GuestPanic{panic_msg}`).
    for c in Code::ALL {
        let f = fail(c, "detail");
        let r = std::panic::catch_unwind(|| f.abort());
        let msg = panic_message(&r.unwrap_err());
        assert!(msg.contains(&format!("E_{}: detail", c.as_str())), "{msg}");
        assert_eq!(code_of(&msg).as_deref(), Some(c.as_str()));
    }
}

// ------------------------------------------------------------------ preview parity beyond the scenarios

#[test]
fn preview_draw_matches_real_draw_over_a_sweep() {
    let mut fx = Fx::with_mandate();
    let mut checked = 0;
    for step in 0..40u128 {
        fx.t += 200; // crosses period boundaries (3600 s) and finally expiry? (stays < 1 day)
        let amount = (step * 7919 % 13) * NEAR / 2; // includes 0 and amounts above per_draw_cap
        let pv = fx.view(|v| v.preview_draw(U128(amount)));
        let real = fx.run(AGENT, |v| {
            v.draw(U128(amount));
        });
        match real {
            Ok(()) => assert_eq!(pv, "", "amount {amount}"),
            Err(c) => assert_eq!(pv, c, "amount {amount}"),
        }
        checked += 1;
    }
    assert_eq!(checked, 40);
    // Also after revocation, pause and expiry.
    fx.run(OWNER, |v| v.pause()).unwrap();
    assert_eq!(fx.view(|v| v.preview_draw(U128(1))), "Paused");
    fx.run(OWNER, |v| v.unpause()).unwrap();
    fx.run(OWNER, |v| v.revoke()).unwrap();
    assert_eq!(fx.view(|v| v.preview_draw(U128(1))), "MandateInactive");
}

#[test]
fn preview_equals_real_for_non_agent_callers_except_unauthorized() {
    let mut fx = Fx::with_mandate();
    // Previews assume the bound agent, so a stranger's real call is Unauthorized while the preview is "".
    assert_eq!(fx.view(|v| v.preview_draw(U128(NEAR))), "");
    assert_eq!(
        fx.run(OTHER, |v| {
            v.draw(U128(NEAR));
        }),
        Err("Unauthorized".into())
    );
}

// ------------------------------------------------------------------ storage round trip

#[test]
fn state_round_trips_through_borsh_storage() {
    let mut fx = Fx::with_mandate();
    let id = fx.allow(WASM_T1, NEAR);
    fx.deploy(&id, "persist", WASM_T1).unwrap();
    fx.run(AGENT, |v| {
        v.draw(U128(2 * NEAR));
    })
    .unwrap();
    Ctx::new(OWNER, fx.t, fx.avail).su(fx.su).set();
    // Collections cache writes until flushed (the generated wrapper drops them after each call).
    fx.v.templates.flush();
    env::state_write(&fx.v);
    let back: Vault = env::state_read().expect("state");
    assert_eq!(back.config(), fx.v.config());
    assert_eq!(back.mandate(), fx.v.mandate());
    assert_eq!(back.usage(), fx.v.usage());
    assert_eq!(back.templates(None, None).len(), 1);
    assert_eq!(
        back.preview_deploy(id.clone(), "persist".into()),
        "AddressTaken"
    );
}
