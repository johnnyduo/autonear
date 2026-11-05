//! Unit, negative-matrix, golden-vector and property tests.
//! Run: `cargo test --locked`. Regenerate vectors: `UPDATE_VECTORS=1 cargo test --locked golden`.

use super::*;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::testing_env;
use std::collections::{HashMap, HashSet};
use std::panic::{catch_unwind, AssertUnwindSafe};

const OWNER: &str = "owner.testnet";
const PROPOSER: &str = "agent.testnet";
const OUTSIDER: &str = "mallory.testnet";
const NEW_OWNER: &str = "newowner.testnet";
const REGISTRY: &str = "registry.testnet";
const TARGET: &str = "dex.testnet";
const METHOD: &str = "swap";
const HASH: &str = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
const T0: u64 = 1_700_000_000_000_000_000;
const DAY: u64 = 86_400_000_000_000;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn set_ctx(who: &str, ts: u64) {
    set_ctx_at(REGISTRY, who, ts);
}

fn set_ctx_at(registry: &str, who: &str, ts: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acct(registry))
        .signer_account_id(acct(who))
        .predecessor_account_id(acct(who))
        .block_timestamp(ts)
        .build());
}

/// Asserts that `f` reverts with a message containing `msg`.
fn fails<R>(msg: &str, f: impl FnOnce() -> R) {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(_) => panic!("expected revert containing {msg:?}, but the call succeeded"),
        Err(e) => {
            let m = if let Some(s) = e.downcast_ref::<String>() {
                s.clone()
            } else if let Some(s) = e.downcast_ref::<&str>() {
                (*s).to_string()
            } else {
                String::from("<non-string panic>")
            };
            assert!(m.contains(msg), "expected {msg:?} in panic, got {m:?}");
        }
    }
}

#[derive(Clone)]
struct P {
    target: &'static str,
    method: &'static str,
    max_spend: u128,
    expiry: u64,
    nonce: u64,
    hash: &'static str,
}

struct Fx {
    c: Registry,
    now: u64,
}

impl Fx {
    fn new() -> Self {
        set_ctx(OWNER, T0);
        let mut c = Registry::new(acct(OWNER), acct(PROPOSER), "testnet".into(), None);
        c.allowlist_add(acct(TARGET), METHOD.into());
        Fx { c, now: T0 }
    }
    fn as_(&self, who: &str) {
        set_ctx(who, self.now);
    }
    fn spec(&self) -> P {
        P {
            target: TARGET,
            method: METHOD,
            max_spend: 10 * NEAR,
            expiry: self.now + DAY,
            nonce: self.c.next_nonce,
            hash: HASH,
        }
    }
    fn propose_as(&mut self, who: &str, p: &P) -> String {
        self.as_(who);
        self.c.propose(
            acct(p.target),
            p.method.into(),
            U128(p.max_spend),
            U64(p.expiry),
            U64(p.nonce),
            p.hash.into(),
        )
    }
    fn proposed(&mut self) -> String {
        let p = self.spec();
        self.propose_as(PROPOSER, &p)
    }
    fn approved(&mut self) -> String {
        let id = self.proposed();
        self.as_(OWNER);
        self.c.approve(id.clone());
        id
    }
    fn executed(&mut self) -> String {
        let id = self.approved();
        self.as_(OWNER);
        self.c
            .mark_executed(id.clone(), U128(NEAR), "tx:abc".into());
        id
    }
    fn status(&self, id: &str) -> StatusView {
        self.c.status_of(id.to_string()).unwrap()
    }
}

// ------------------------------------------------------------------ happy path

#[test]
fn happy_path_propose_approve_execute() {
    let mut fx = Fx::new();
    let id = fx.proposed();
    assert_eq!(id.len(), 64);
    assert_eq!(fx.status(&id), StatusView::Pending);
    fx.now += 10;
    fx.as_(OWNER);
    fx.c.approve(id.clone());
    assert_eq!(fx.status(&id), StatusView::Approved);
    fx.now += 10;
    fx.as_(OWNER);
    fx.c.mark_executed(id.clone(), U128(7 * NEAR), "tx:abc".into());
    let v = fx.c.get_proposal(id.clone()).unwrap();
    assert_eq!(v.status, StatusView::Executed);
    assert_eq!(v.spent, Some(U128(7 * NEAR)));
    assert_eq!(v.receipt_ref.as_deref(), Some("tx:abc"));
    assert_eq!(v.created_at, U64(T0));
    assert_eq!(v.approved_at, Some(U64(T0 + 10)));
    assert_eq!(v.executed_at, Some(U64(T0 + 20)));
    assert_eq!(v.proposer, acct(PROPOSER));
    assert_eq!(fx.c.proposals_count(), U64(1));
}

#[test]
fn owner_may_also_propose() {
    let mut fx = Fx::new();
    let p = fx.spec();
    let id = fx.propose_as(OWNER, &p);
    assert_eq!(fx.status(&id), StatusView::Pending);
    fx.as_(OWNER);
    fx.c.cancel(id.clone());
    assert_eq!(fx.status(&id), StatusView::Cancelled);
}

#[test]
fn spend_exactly_at_max_and_zero_are_allowed_at_execute() {
    let mut fx = Fx::new();
    let a = fx.approved();
    fx.as_(OWNER);
    fx.c.mark_executed(a.clone(), U128(10 * NEAR), "r".into());
    let b = fx.approved();
    fx.as_(OWNER);
    fx.c.mark_executed(b, U128(0), "r".into());
    assert_eq!(fx.status(&a), StatusView::Executed);
}

#[test]
fn proposer_cancels_own_pending() {
    let mut fx = Fx::new();
    let id = fx.proposed();
    fx.as_(PROPOSER);
    fx.c.cancel(id.clone());
    assert_eq!(fx.status(&id), StatusView::Cancelled);
}

#[test]
fn owner_cancels_approved() {
    let mut fx = Fx::new();
    let id = fx.approved();
    fx.as_(OWNER);
    fx.c.cancel(id.clone());
    assert_eq!(fx.status(&id), StatusView::Cancelled);
}

// ------------------------------------------------- unauthorized signers (matrix)

macro_rules! owner_only {
    ($name:ident, $who:expr, |$c:ident, $id:ident| $call:expr) => {
        #[test]
        fn $name() {
            let mut fx = Fx::new();
            let $id = fx.approved_for_auth_tests();
            fx.as_($who);
            let $c = &mut fx.c;
            fails("only owner", || {
                $call;
            });
        }
    };
}

impl Fx {
    /// A fresh Pending proposal (so approve etc. can be attempted).
    fn approved_for_auth_tests(&mut self) -> String {
        self.proposed()
    }
}

owner_only!(approve_by_outsider_rejected, OUTSIDER, |c, id| c
    .approve(id));
owner_only!(approve_by_proposer_rejected, PROPOSER, |c, id| c
    .approve(id));
owner_only!(mark_executed_by_outsider_rejected, OUTSIDER, |c, id| c
    .mark_executed(id, U128(1), "r".into()));
owner_only!(mark_executed_by_proposer_rejected, PROPOSER, |c, id| c
    .mark_executed(id, U128(1), "r".into()));
owner_only!(pause_by_outsider_rejected, OUTSIDER, |c, _id| c.pause());
owner_only!(pause_by_proposer_rejected, PROPOSER, |c, _id| c.pause());
owner_only!(unpause_by_outsider_rejected, OUTSIDER, |c, _id| c.unpause());
owner_only!(unpause_by_proposer_rejected, PROPOSER, |c, _id| c.unpause());
owner_only!(allowlist_add_by_outsider_rejected, OUTSIDER, |c, _id| c
    .allowlist_add(acct("x.testnet"), "m".into()));
owner_only!(allowlist_add_by_proposer_rejected, PROPOSER, |c, _id| c
    .allowlist_add(acct("x.testnet"), "m".into()));
owner_only!(allowlist_remove_by_outsider_rejected, OUTSIDER, |c, _id| c
    .allowlist_remove(acct(TARGET), METHOD.into()));
owner_only!(allowlist_remove_by_proposer_rejected, PROPOSER, |c, _id| c
    .allowlist_remove(acct(TARGET), METHOD.into()));
owner_only!(set_proposer_by_outsider_rejected, OUTSIDER, |c, _id| c
    .set_proposer(acct(OUTSIDER)));
owner_only!(set_proposer_by_proposer_rejected, PROPOSER, |c, _id| c
    .set_proposer(acct(PROPOSER)));
owner_only!(set_cap_by_outsider_rejected, OUTSIDER, |c, _id| c
    .set_max_spend_cap(U128(1)));
owner_only!(set_cap_by_proposer_rejected, PROPOSER, |c, _id| c
    .set_max_spend_cap(U128(1)));
owner_only!(
    transfer_ownership_by_outsider_rejected,
    OUTSIDER,
    |c, _id| c.transfer_ownership(acct(OUTSIDER))
);
owner_only!(
    transfer_ownership_by_proposer_rejected,
    PROPOSER,
    |c, _id| c.transfer_ownership(acct(PROPOSER))
);

#[test]
fn propose_by_outsider_rejected() {
    let mut fx = Fx::new();
    let p = fx.spec();
    fails("only proposer or owner", || {
        fx.propose_as(OUTSIDER, &p);
    });
    assert_eq!(fx.c.proposals_count(), U64(0));
}

#[test]
fn propose_by_old_proposer_after_rotation_rejected() {
    let mut fx = Fx::new();
    fx.as_(OWNER);
    fx.c.set_proposer(acct("agent2.testnet"));
    let p = fx.spec();
    fails("only proposer or owner", || {
        fx.propose_as(PROPOSER, &p);
    });
    let id = fx.propose_as("agent2.testnet", &p);
    // The rotated-out proposer can no longer cancel its old proposals either.
    fx.as_(PROPOSER);
    fails("not authorized to cancel", || fx.c.cancel(id));
}

#[test]
fn proposer_cannot_approve_or_execute_or_change_config() {
    let mut fx = Fx::new();
    let id = fx.proposed();
    fx.as_(PROPOSER);
    fails("only owner", || fx.c.approve(id.clone()));
    fails("only owner", || {
        fx.c.mark_executed(id.clone(), U128(1), "r".into())
    });
    fails("only owner", || fx.c.set_proposer(acct(PROPOSER)));
    fails("only owner", || fx.c.set_max_spend_cap(U128(u128::MAX)));
    fails("only owner", || {
        fx.c.allowlist_add(acct("x.testnet"), "m".into())
    });
    assert_eq!(fx.status(&id), StatusView::Pending);
}

// ------------------------------------------------------ identity / altered fields

#[test]
fn altered_field_yields_different_id_and_unknown_proposal() {
    let mut fx = Fx::new();
    fx.as_(OWNER);
    fx.c.allowlist_add(acct("other.testnet"), "swap".into());
    let p = fx.spec();
    let id = fx.propose_as(PROPOSER, &p);
    fx.as_(OWNER);
    let alt = |t: &str, m: &str, ms: u128, ex: u64, n: u64, h: &str| {
        fx.c.compute_proposal_id(acct(t), m.into(), U128(ms), U64(ex), U64(n), h.into())
    };
    let same = alt(TARGET, METHOD, p.max_spend, p.expiry, p.nonce, HASH);
    assert_eq!(same, id);
    let other_hash = "00bbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    let variants = [
        alt(
            "other.testnet",
            METHOD,
            p.max_spend,
            p.expiry,
            p.nonce,
            HASH,
        ),
        alt(TARGET, "swap2", p.max_spend, p.expiry, p.nonce, HASH),
        alt(TARGET, METHOD, p.max_spend + 1, p.expiry, p.nonce, HASH),
        alt(TARGET, METHOD, p.max_spend, p.expiry + 1, p.nonce, HASH),
        alt(TARGET, METHOD, p.max_spend, p.expiry, p.nonce + 1, HASH),
        alt(TARGET, METHOD, p.max_spend, p.expiry, p.nonce, other_hash),
    ];
    let mut all: HashSet<String> = variants.iter().cloned().collect();
    all.insert(id.clone());
    assert_eq!(all.len(), 7, "every altered field must change the id");
    for v in &variants {
        assert!(fx.c.get_proposal(v.clone()).is_none());
        assert!(fx.c.status_of(v.clone()).is_none());
        let v2 = v.clone();
        fails("unknown proposal", || fx.c.approve(v2));
    }
    // The approval path for the original id is untouched.
    assert_eq!(fx.status(&id), StatusView::Pending);
}

#[test]
fn id_depends_on_network_and_registry_account() {
    let mut fx = Fx::new();
    let id = fx.proposed();
    // Same fields, same network, different registry account.
    set_ctx_at("registry2.testnet", OWNER, T0);
    let c2 = Registry::new(acct(OWNER), acct(PROPOSER), "testnet".into(), None);
    let p = fx.spec();
    let other_registry = c2.compute_proposal_id(
        acct(TARGET),
        METHOD.into(),
        U128(10 * NEAR),
        U64(T0 + DAY),
        U64(0),
        p.hash.into(),
    );
    assert_ne!(other_registry, id);
    // Same registry account, different network id.
    set_ctx(OWNER, T0);
    let c3 = Registry::new(acct(OWNER), acct(PROPOSER), "mainnet".into(), None);
    let other_net = c3.compute_proposal_id(
        acct(TARGET),
        METHOD.into(),
        U128(10 * NEAR),
        U64(T0 + DAY),
        U64(0),
        p.hash.into(),
    );
    assert_ne!(other_net, id);
    assert_ne!(other_net, other_registry);
}

#[test]
fn malformed_id_and_hash_rejected() {
    let mut fx = Fx::new();
    fx.as_(OWNER);
    fails("invalid hex32", || fx.c.approve("zz".into()));
    fails("invalid hex32", || fx.c.approve(HASH.to_uppercase()));
    assert!(fx.c.get_proposal("short".into()).is_none());
    let mut p = fx.spec();
    p.hash = "abcd";
    fails("invalid hex32", || {
        fx.propose_as(PROPOSER, &p);
    });
    p.hash = "AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899";
    fails("invalid hex32", || {
        fx.propose_as(PROPOSER, &p);
    });
}

// ------------------------------------------------ allowlist: target and method

#[test]
fn wrong_target_rejected() {
    let mut fx = Fx::new();
    let mut p = fx.spec();
    p.target = "evil.testnet";
    fails("not allowlisted", || {
        fx.propose_as(PROPOSER, &p);
    });
}

#[test]
fn wrong_method_rejected() {
    let mut fx = Fx::new();
    let mut p = fx.spec();
    p.method = "drain";
    fails("not allowlisted", || {
        fx.propose_as(PROPOSER, &p);
    });
}

#[test]
fn invalid_method_names_rejected() {
    let mut fx = Fx::new();
    let mut p = fx.spec();
    p.method = "";
    fails("invalid method", || {
        fx.propose_as(PROPOSER, &p);
    });
    p.method = "sw ap";
    fails("invalid method", || {
        fx.propose_as(PROPOSER, &p);
    });
    fx.as_(OWNER);
    fails("invalid method", || {
        fx.c.allowlist_add(acct(TARGET), "*".into())
    });
}

#[test]
fn allowlist_pair_is_exact_not_cross_product() {
    let mut fx = Fx::new();
    fx.as_(OWNER);
    fx.c.allowlist_add(acct("b.testnet"), "other".into());
    assert!(fx.c.is_allowed(acct("b.testnet"), "other".into()));
    assert!(!fx.c.is_allowed(acct("b.testnet"), METHOD.into()));
    assert!(!fx.c.is_allowed(acct(TARGET), "other".into()));
    fails("already allowlisted", || {
        fx.c.allowlist_add(acct("b.testnet"), "other".into())
    });
    fails("not allowlisted", || {
        fx.c.allowlist_remove(acct("c.testnet"), "other".into())
    });
}

#[test]
fn allowlist_removal_after_creation_blocks_approval_but_not_cancel() {
    let mut fx = Fx::new();
    let id = fx.proposed();
    fx.as_(OWNER);
    fx.c.allowlist_remove(acct(TARGET), METHOD.into());
    fails("not allowlisted", || fx.c.approve(id.clone()));
    assert_eq!(fx.status(&id), StatusView::Pending);
    fx.c.cancel(id.clone());
    assert_eq!(fx.status(&id), StatusView::Cancelled);
}

#[test]
fn allowlist_removal_after_approval_does_not_block_mark_executed() {
    // Documented behaviour: only `approve` re-checks the allowlist. An owner who wants to
    // revoke an already Approved proposal must cancel it.
    let mut fx = Fx::new();
    let id = fx.approved();
    fx.as_(OWNER);
    fx.c.allowlist_remove(acct(TARGET), METHOD.into());
    fx.c.mark_executed(id.clone(), U128(1), "r".into());
    assert_eq!(fx.status(&id), StatusView::Executed);
}

// ---------------------------------------------------------------- spend limits

#[test]
fn exceeded_cap_at_propose_rejected() {
    let mut fx = Fx::new();
    let mut p = fx.spec();
    p.max_spend = DEFAULT_MAX_SPEND_CAP + 1;
    fails("max_spend exceeds cap", || {
        fx.propose_as(PROPOSER, &p);
    });
    p.max_spend = DEFAULT_MAX_SPEND_CAP;
    fx.propose_as(PROPOSER, &p);
}

#[test]
fn zero_max_spend_rejected() {
    let mut fx = Fx::new();
    let mut p = fx.spec();
    p.max_spend = 0;
    fails("max_spend must be > 0", || {
        fx.propose_as(PROPOSER, &p);
    });
}

#[test]
fn lowered_cap_applies_to_new_proposals() {
    let mut fx = Fx::new();
    fx.as_(OWNER);
    fx.c.set_max_spend_cap(U128(5 * NEAR));
    let p = fx.spec(); // 10 NEAR
    fails("max_spend exceeds cap", || {
        fx.propose_as(PROPOSER, &p);
    });
    fx.as_(OWNER);
    fails("cap must be > 0", || fx.c.set_max_spend_cap(U128(0)));
}

#[test]
fn exceeded_spend_at_mark_executed_rejected() {
    let mut fx = Fx::new();
    let id = fx.approved();
    fx.as_(OWNER);
    fails("spent exceeds max_spend", || {
        fx.c.mark_executed(id.clone(), U128(10 * NEAR + 1), "r".into())
    });
    assert_eq!(fx.status(&id), StatusView::Approved);
}

#[test]
fn receipt_ref_bounds_enforced() {
    let mut fx = Fx::new();
    let id = fx.approved();
    fx.as_(OWNER);
    fails("invalid receipt_ref", || {
        fx.c.mark_executed(id.clone(), U128(1), String::new())
    });
    fails("invalid receipt_ref", || {
        fx.c.mark_executed(id.clone(), U128(1), "x".repeat(MAX_RECEIPT_REF_LEN + 1))
    });
    fx.c.mark_executed(id.clone(), U128(1), "x".repeat(MAX_RECEIPT_REF_LEN));
    assert_eq!(fx.status(&id), StatusView::Executed);
}

// ----------------------------------------------------------------------- expiry

#[test]
fn expiry_in_past_or_now_rejected_at_propose() {
    let mut fx = Fx::new();
    let mut p = fx.spec();
    p.expiry = fx.now;
    fails("expiry must be in the future", || {
        fx.propose_as(PROPOSER, &p);
    });
    p.expiry = fx.now - 1;
    fails("expiry must be in the future", || {
        fx.propose_as(PROPOSER, &p);
    });
}

#[test]
fn expiry_beyond_max_ttl_rejected_and_boundary_accepted() {
    let mut fx = Fx::new();
    let mut p = fx.spec();
    p.expiry = fx.now + MAX_TTL_NS + 1;
    fails("expiry exceeds max ttl", || {
        fx.propose_as(PROPOSER, &p);
    });
    p.expiry = fx.now + MAX_TTL_NS;
    fx.propose_as(PROPOSER, &p);
    let mut p2 = fx.spec();
    p2.expiry = u64::MAX;
    fails("expiry exceeds max ttl", || {
        fx.propose_as(PROPOSER, &p2);
    });
}

#[test]
fn expired_at_approve_rejected_time_travel() {
    let mut fx = Fx::new();
    let id = fx.proposed();
    let expiry = fx.c.get_proposal(id.clone()).unwrap().expiry.0;
    // now == expiry is still valid (expired iff now > expiry).
    fx.now = expiry;
    fx.as_(OWNER);
    assert_eq!(fx.status(&id), StatusView::Pending);
    fx.now = expiry + 1;
    fx.as_(OWNER);
    assert_eq!(fx.status(&id), StatusView::Expired);
    fails("proposal expired", || fx.c.approve(id.clone()));
}

#[test]
fn expired_at_mark_executed_rejected_time_travel() {
    let mut fx = Fx::new();
    let at_boundary = fx.approved();
    let too_late = fx.approved();
    let e1 = fx.c.get_proposal(at_boundary.clone()).unwrap().expiry.0;
    let e2 = fx.c.get_proposal(too_late.clone()).unwrap().expiry.0;
    assert_eq!(e1, e2);
    // now == expiry: still executable.
    fx.now = e1;
    fx.as_(OWNER);
    fx.c.mark_executed(at_boundary.clone(), U128(1), "r".into());
    assert_eq!(fx.status(&at_boundary), StatusView::Executed);
    // now == expiry + 1: expired, execution reverts and state is unchanged.
    fx.now = e1 + 1;
    fx.as_(OWNER);
    fails("proposal expired", || {
        fx.c.mark_executed(too_late.clone(), U128(1), "r".into())
    });
    assert_eq!(fx.status(&too_late), StatusView::Expired);
    assert_eq!(fx.status(&at_boundary), StatusView::Executed);
}

#[test]
fn expired_proposal_cannot_be_cancelled_or_revived() {
    let mut fx = Fx::new();
    let id = fx.proposed();
    fx.now = fx.c.get_proposal(id.clone()).unwrap().expiry.0 + 1;
    fx.as_(OWNER);
    fails("proposal expired", || fx.c.cancel(id.clone()));
    fx.as_(PROPOSER);
    fails("proposal expired", || fx.c.cancel(id.clone()));
    assert_eq!(fx.status(&id), StatusView::Expired);
}

#[test]
fn terminal_states_are_not_reported_expired() {
    let mut fx = Fx::new();
    let done = fx.executed();
    let gone = fx.proposed();
    fx.as_(OWNER);
    fx.c.cancel(gone.clone());
    fx.now += 100 * DAY;
    fx.as_(OWNER);
    assert_eq!(fx.status(&done), StatusView::Executed);
    assert_eq!(fx.status(&gone), StatusView::Cancelled);
}

// ----------------------------------------------------------------------- nonce

#[test]
fn replay_of_identical_proposal_rejected() {
    let mut fx = Fx::new();
    let p = fx.spec();
    let id = fx.propose_as(PROPOSER, &p);
    fails("bad nonce", || {
        fx.propose_as(PROPOSER, &p);
    });
    assert_eq!(fx.c.proposals_count(), U64(1));
    assert_eq!(fx.status(&id), StatusView::Pending);
}

#[test]
fn replay_after_terminal_state_still_rejected() {
    let mut fx = Fx::new();
    let p = fx.spec();
    let id = fx.propose_as(PROPOSER, &p);
    fx.as_(OWNER);
    fx.c.cancel(id);
    fails("bad nonce", || {
        fx.propose_as(PROPOSER, &p);
    });
}

#[test]
fn bad_nonce_too_low_too_high_and_reuse() {
    let mut fx = Fx::new();
    let mut p = fx.spec();
    p.nonce = 1;
    fails("bad nonce", || {
        fx.propose_as(PROPOSER, &p);
    });
    p.nonce = u64::MAX;
    fails("bad nonce", || {
        fx.propose_as(PROPOSER, &p);
    });
    p.nonce = 0;
    fx.propose_as(PROPOSER, &p);
    // too low (0 already used)
    fails("bad nonce", || {
        fx.propose_as(PROPOSER, &p);
    });
    // too high (skips 1)
    p.nonce = 2;
    fails("bad nonce", || {
        fx.propose_as(PROPOSER, &p);
    });
    p.nonce = 1;
    fx.propose_as(PROPOSER, &p);
    assert_eq!(fx.c.config().next_nonce, U64(2));
}

#[test]
fn failed_propose_does_not_consume_nonce() {
    let mut fx = Fx::new();
    let mut p = fx.spec();
    p.max_spend = 0;
    fails("max_spend must be > 0", || {
        fx.propose_as(PROPOSER, &p);
    });
    assert_eq!(fx.c.config().next_nonce, U64(0));
}

// ---------------------------------------------------------- state machine order

#[test]
fn double_execute_rejected() {
    let mut fx = Fx::new();
    let id = fx.executed();
    fx.as_(OWNER);
    fails("not approved", || {
        fx.c.mark_executed(id.clone(), U128(1), "again".into())
    });
    let v = fx.c.get_proposal(id).unwrap();
    assert_eq!(v.receipt_ref.as_deref(), Some("tx:abc"));
    assert_eq!(v.spent, Some(U128(NEAR)));
}

#[test]
fn execute_before_approve_rejected() {
    let mut fx = Fx::new();
    let id = fx.proposed();
    fx.as_(OWNER);
    fails("not approved", || {
        fx.c.mark_executed(id.clone(), U128(1), "r".into())
    });
    assert_eq!(fx.status(&id), StatusView::Pending);
}

#[test]
fn approve_after_cancel_rejected() {
    let mut fx = Fx::new();
    let id = fx.proposed();
    fx.as_(OWNER);
    fx.c.cancel(id.clone());
    fails("not pending", || fx.c.approve(id.clone()));
    assert_eq!(fx.status(&id), StatusView::Cancelled);
}

#[test]
fn double_approve_rejected() {
    let mut fx = Fx::new();
    let id = fx.approved();
    fx.as_(OWNER);
    fails("not pending", || fx.c.approve(id));
}

#[test]
fn cancel_after_execute_or_cancel_rejected() {
    let mut fx = Fx::new();
    let done = fx.executed();
    fx.as_(OWNER);
    fails("not cancellable", || fx.c.cancel(done.clone()));
    let id = fx.proposed();
    fx.as_(OWNER);
    fx.c.cancel(id.clone());
    fails("not cancellable", || fx.c.cancel(id));
    fx.as_(PROPOSER);
    let other = fx.proposed();
    fx.as_(OWNER);
    fx.c.cancel(other.clone());
    fx.as_(PROPOSER);
    fails("only pending", || fx.c.cancel(other));
}

#[test]
fn cancel_by_outsider_rejected() {
    let mut fx = Fx::new();
    let id = fx.proposed();
    fx.as_(OUTSIDER);
    fails("not authorized to cancel", || fx.c.cancel(id.clone()));
    let id2 = fx.approved();
    fx.as_(OUTSIDER);
    fails("not authorized to cancel", || fx.c.cancel(id2.clone()));
    assert_eq!(fx.status(&id), StatusView::Pending);
    assert_eq!(fx.status(&id2), StatusView::Approved);
}

#[test]
fn cancel_approved_by_proposer_rejected() {
    let mut fx = Fx::new();
    let id = fx.approved();
    fx.as_(PROPOSER);
    fails("only pending", || fx.c.cancel(id.clone()));
    assert_eq!(fx.status(&id), StatusView::Approved);
}

#[test]
fn unknown_id_rejected_everywhere() {
    let mut fx = Fx::new();
    let ghost = HASH.to_string();
    fx.as_(OWNER);
    fails("unknown proposal", || fx.c.approve(ghost.clone()));
    fails("unknown proposal", || {
        fx.c.mark_executed(ghost.clone(), U128(1), "r".into())
    });
    fails("unknown proposal", || fx.c.cancel(ghost.clone()));
}

// ----------------------------------------------------------------------- pause

#[test]
fn pause_blocks_propose_approve_execute_but_not_cancel_or_views() {
    let mut fx = Fx::new();
    let pending = fx.proposed();
    let approved = fx.approved();
    let to_cancel_by_proposer = fx.proposed();
    fx.as_(OWNER);
    fx.c.pause();
    assert!(fx.c.config().paused);
    let p = fx.spec();
    fails("paused", || {
        fx.propose_as(PROPOSER, &p);
    });
    fails("paused", || {
        fx.propose_as(OWNER, &p);
    });
    fx.as_(OWNER);
    fails("paused", || fx.c.approve(pending.clone()));
    fails("paused", || {
        fx.c.mark_executed(approved.clone(), U128(1), "r".into())
    });
    // cancel still works for owner (Approved) and proposer (Pending); views work.
    fx.c.cancel(approved.clone());
    fx.as_(PROPOSER);
    fx.c.cancel(to_cancel_by_proposer.clone());
    assert_eq!(fx.status(&approved), StatusView::Cancelled);
    assert_eq!(fx.status(&to_cancel_by_proposer), StatusView::Cancelled);
    assert!(fx.c.get_proposal(pending).is_some());
    assert_eq!(fx.c.list(None, None).len(), 3);
}

#[test]
fn unpause_restores_operation() {
    let mut fx = Fx::new();
    let id = fx.proposed();
    fx.as_(OWNER);
    fx.c.pause();
    fails("paused", || fx.c.approve(id.clone()));
    fx.c.unpause();
    assert!(!fx.c.config().paused);
    fx.c.approve(id.clone());
    fx.c.mark_executed(id.clone(), U128(1), "r".into());
    let p = fx.spec();
    fx.propose_as(PROPOSER, &p);
    assert_eq!(fx.status(&id), StatusView::Executed);
}

#[test]
fn pause_unpause_are_not_idempotent_noops() {
    let mut fx = Fx::new();
    fx.as_(OWNER);
    fails("not paused", || fx.c.unpause());
    fx.c.pause();
    fails("already paused", || fx.c.pause());
}

#[test]
fn admin_actions_still_work_while_paused() {
    let mut fx = Fx::new();
    fx.as_(OWNER);
    fx.c.pause();
    fx.c.allowlist_add(acct("z.testnet"), "m".into());
    fx.c.set_max_spend_cap(U128(NEAR));
    fx.c.set_proposer(acct("agent2.testnet"));
    fx.c.transfer_ownership(acct(NEW_OWNER));
    fx.c.unpause();
}

// ------------------------------------------------------------------- ownership

#[test]
fn two_step_ownership_transfer() {
    let mut fx = Fx::new();
    fx.as_(OWNER);
    fx.c.transfer_ownership(acct(NEW_OWNER));
    // Pending only: the old owner is still owner, the new one has no powers yet.
    assert_eq!(fx.c.config().pending_owner, Some(acct(NEW_OWNER)));
    assert_eq!(fx.c.config().owner_id, acct(OWNER));
    let id = fx.proposed();
    fx.as_(NEW_OWNER);
    fails("only owner", || fx.c.approve(id.clone()));
    fx.c.accept_ownership();
    let cfg = fx.c.config();
    assert_eq!(cfg.owner_id, acct(NEW_OWNER));
    assert_eq!(cfg.pending_owner, None);
    fx.c.approve(id.clone());
    // The previous owner lost its powers.
    fx.as_(OWNER);
    fails("only owner", || fx.c.cancel_or_pause_probe());
    fails("not authorized to cancel", || fx.c.cancel(id));
}

impl Registry {
    fn cancel_or_pause_probe(&mut self) {
        self.pause();
    }
}

#[test]
fn accept_ownership_by_wrong_account_rejected() {
    let mut fx = Fx::new();
    fx.as_(OWNER);
    fx.c.transfer_ownership(acct(NEW_OWNER));
    for who in [OUTSIDER, PROPOSER, OWNER] {
        fx.as_(who);
        fails("only pending owner", || fx.c.accept_ownership());
    }
    assert_eq!(fx.c.config().owner_id, acct(OWNER));
}

#[test]
fn accept_ownership_without_pending_rejected() {
    let mut fx = Fx::new();
    fx.as_(NEW_OWNER);
    fails("no pending owner", || fx.c.accept_ownership());
}

#[test]
fn accept_ownership_cannot_be_replayed() {
    let mut fx = Fx::new();
    fx.as_(OWNER);
    fx.c.transfer_ownership(acct(NEW_OWNER));
    fx.as_(NEW_OWNER);
    fx.c.accept_ownership();
    fails("no pending owner", || fx.c.accept_ownership());
}

#[test]
fn transfer_to_self_or_zero_like_accounts_rejected() {
    let mut fx = Fx::new();
    fx.as_(OWNER);
    fails("new owner is current owner", || {
        fx.c.transfer_ownership(acct(OWNER))
    });
    fails("invalid account", || {
        fx.c.transfer_ownership(acct("system"))
    });
    fails("invalid account", || {
        fx.c.transfer_ownership(acct(&"0".repeat(64)))
    });
    fails("invalid account", || {
        fx.c.transfer_ownership(acct(REGISTRY))
    });
    assert_eq!(fx.c.config().pending_owner, None);
}

#[test]
fn transfer_ownership_can_be_overwritten_before_acceptance() {
    let mut fx = Fx::new();
    fx.as_(OWNER);
    fx.c.transfer_ownership(acct(NEW_OWNER));
    fx.c.transfer_ownership(acct(OUTSIDER));
    fx.as_(NEW_OWNER);
    fails("only pending owner", || fx.c.accept_ownership());
    fx.as_(OUTSIDER);
    fx.c.accept_ownership();
    assert_eq!(fx.c.config().owner_id, acct(OUTSIDER));
}

#[test]
fn init_rejects_zero_like_accounts_and_bad_config() {
    set_ctx(OWNER, T0);
    fails("invalid account", || {
        Registry::new(acct("system"), acct(PROPOSER), "testnet".into(), None)
    });
    fails("invalid account", || {
        Registry::new(acct(OWNER), acct(&"0".repeat(64)), "testnet".into(), None)
    });
    fails("invalid network_id", || {
        Registry::new(acct(OWNER), acct(PROPOSER), String::new(), None)
    });
    fails("cap must be > 0", || {
        Registry::new(acct(OWNER), acct(PROPOSER), "testnet".into(), Some(U128(0)))
    });
}

#[test]
fn set_proposer_rejects_zero_like_accounts() {
    let mut fx = Fx::new();
    fx.as_(OWNER);
    fails("invalid account", || fx.c.set_proposer(acct("system")));
}

// ------------------------------------------------------------------------ views

#[test]
fn list_is_paginated_in_creation_order_and_capped() {
    let mut fx = Fx::new();
    let ids: Vec<String> = (0..5).map(|_| fx.proposed()).collect();
    let all = fx.c.list(None, None);
    assert_eq!(all.iter().map(|v| v.id.clone()).collect::<Vec<_>>(), ids);
    let page = fx.c.list(Some(U64(1)), Some(U64(2)));
    assert_eq!(page.len(), 2);
    assert_eq!(page[0].id, ids[1]);
    assert_eq!(page[1].id, ids[2]);
    assert!(fx.c.list(Some(U64(5)), None).is_empty());
    assert!(fx
        .c
        .list(Some(U64(u64::MAX)), Some(U64(u64::MAX)))
        .is_empty());
    assert_eq!(fx.c.list(Some(U64(4)), Some(U64(100))).len(), 1);
    assert_eq!(fx.c.list(None, Some(U64(0))).len(), 0);
}

#[test]
fn list_limit_is_capped_at_max_page() {
    let mut fx = Fx::new();
    fx.as_(OWNER);
    fx.c.set_max_spend_cap(U128(NEAR));
    for i in 0..(MAX_PAGE + 5) {
        let mut p = fx.spec();
        p.max_spend = 1;
        p.nonce = i;
        fx.propose_as(PROPOSER, &p);
    }
    assert_eq!(fx.c.list(None, Some(U64(10_000))).len() as u64, MAX_PAGE);
    assert_eq!(fx.c.list(None, None).len() as u64, DEFAULT_PAGE);
}

#[test]
fn config_view_reports_defaults() {
    let fx = Fx::new();
    let cfg = fx.c.config();
    assert_eq!(cfg.owner_id, acct(OWNER));
    assert_eq!(cfg.proposer_id, acct(PROPOSER));
    assert_eq!(cfg.network_id, "testnet");
    assert_eq!(cfg.registry_id, acct(REGISTRY));
    assert_eq!(cfg.max_spend_cap, U128(DEFAULT_MAX_SPEND_CAP));
    assert_eq!(cfg.max_ttl_ns, U64(MAX_TTL_NS));
    assert_eq!(cfg.state_version, STATE_VERSION);
    assert!(!cfg.paused);
}

#[test]
fn api_json_shapes_use_string_integers() {
    let mut fx = Fx::new();
    let id = fx.proposed();
    let v = serde_json::to_value(fx.c.get_proposal(id).unwrap()).unwrap();
    assert_eq!(v["expiry"], json!((T0 + DAY).to_string()));
    assert_eq!(v["max_spend"], json!((10 * NEAR).to_string()));
    assert_eq!(v["nonce"], json!("0"));
    assert_eq!(v["status"], json!("Pending"));
    assert_eq!(v["approved_at"], Value::Null);
    let s = serde_json::to_value(StatusView::Expired).unwrap();
    assert_eq!(s, json!("Expired"));
}

// ------------------------------------------------- no external calls / callbacks

#[test]
fn no_promises_or_receipts_are_ever_created() {
    let mut fx = Fx::new();
    let a = fx.executed();
    let b = fx.proposed();
    fx.as_(OWNER);
    fx.c.cancel(b);
    fx.c.pause();
    fx.c.unpause();
    fx.c.transfer_ownership(acct(NEW_OWNER));
    assert!(get_created_receipts().is_empty());
    assert_eq!(fx.status(&a), StatusView::Executed);
}

// ----------------------------------------------------------------------- events

fn events(logs: &[String]) -> Vec<Value> {
    logs.iter()
        .map(|l| {
            let j = l.strip_prefix("EVENT_JSON:").expect("NEP-297 prefix");
            serde_json::from_str(j).unwrap()
        })
        .collect()
}

#[test]
fn events_are_nep297_json_for_every_mutation() {
    let mut fx = Fx::new();
    let p = fx.spec();
    let id = fx.propose_as(PROPOSER, &p);
    let ev = events(&get_logs());
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["standard"], "autonear_registry");
    assert_eq!(ev[0]["version"], "1.0.0");
    assert_eq!(ev[0]["event"], "proposed");
    assert_eq!(ev[0]["data"]["id"], json!(id));
    assert_eq!(ev[0]["data"]["expiry"], json!(p.expiry.to_string()));
    assert_eq!(ev[0]["data"]["nonce"], json!("0"));
    assert_eq!(ev[0]["data"]["proposer"], json!(PROPOSER));

    macro_rules! one_event {
        ($who:expr, $call:expr, $name:expr) => {{
            fx.as_($who);
            $call;
            let ev = events(&get_logs());
            assert_eq!(ev.len(), 1, "exactly one event for {}", $name);
            assert_eq!(ev[0]["event"], $name);
            assert_eq!(ev[0]["standard"], "autonear_registry");
            ev
        }};
    }
    let ev = one_event!(OWNER, fx.c.approve(id.clone()), "approved");
    assert_eq!(ev[0]["data"]["id"], json!(id));
    let ev = one_event!(
        OWNER,
        fx.c.mark_executed(id.clone(), U128(5), "tx:1".into()),
        "executed"
    );
    assert_eq!(ev[0]["data"]["spent"], json!("5"));
    assert_eq!(ev[0]["data"]["receipt_ref"], json!("tx:1"));
    let id2 = fx.proposed();
    one_event!(OWNER, fx.c.cancel(id2), "cancelled");
    one_event!(OWNER, fx.c.pause(), "paused");
    one_event!(OWNER, fx.c.unpause(), "unpaused");
    one_event!(
        OWNER,
        fx.c.allowlist_add(acct("q.testnet"), "m".into()),
        "allowlist_added"
    );
    one_event!(
        OWNER,
        fx.c.allowlist_remove(acct("q.testnet"), "m".into()),
        "allowlist_removed"
    );
    one_event!(
        OWNER,
        fx.c.set_proposer(acct("agent2.testnet")),
        "proposer_set"
    );
    one_event!(
        OWNER,
        fx.c.set_max_spend_cap(U128(NEAR)),
        "max_spend_cap_set"
    );
    one_event!(
        OWNER,
        fx.c.transfer_ownership(acct(NEW_OWNER)),
        "ownership_transfer_started"
    );
    one_event!(NEW_OWNER, fx.c.accept_ownership(), "ownership_transferred");
}

#[test]
fn init_emits_event_and_reverts_emit_nothing() {
    set_ctx(OWNER, T0);
    let _c = Registry::new(acct(OWNER), acct(PROPOSER), "testnet".into(), None);
    let ev = events(&get_logs());
    assert_eq!(ev[0]["event"], "initialized");
    let mut fx = Fx::new();
    let p = fx.spec();
    fx.as_(OUTSIDER);
    fails("only proposer or owner", || {
        fx.c.propose(
            acct(p.target),
            p.method.into(),
            U128(p.max_spend),
            U64(p.expiry),
            U64(p.nonce),
            p.hash.into(),
        )
    });
    // A reverted call may not leave a success event behind in the contract's own flow.
    assert!(events(&get_logs()).is_empty());
}

// ----------------------------------------------------------------------- migrate

#[test]
fn migrate_reloads_v1_state() {
    let mut fx = Fx::new();
    let id = fx.executed();
    set_ctx(REGISTRY, fx.now);
    let Fx { c, now } = fx;
    env::state_write(&c);
    drop(c); // store collections flush their caches on drop
    set_ctx(REGISTRY, now);
    // NOTE: the `#[private]` guard is generated into the wasm export wrapper by the
    // near-sdk macro, so it cannot be exercised by direct calls in unit tests.
    let m = Registry::migrate();
    assert_eq!(m.state_version, STATE_VERSION);
    assert_eq!(m.next_nonce, 1);
    assert_eq!(m.status_of(id), Some(StatusView::Executed));
}

// ---------------------------------------------------------------------- storage

#[test]
fn storage_bytes_per_proposal_is_small_and_bounded() {
    let mut fx = Fx::new();
    let measure = |fx: &mut Fx| {
        fx.c.proposals.flush();
        fx.c.ids.flush();
        env::storage_usage()
    };
    let base = measure(&mut fx);
    let id = fx.proposed();
    let pending = measure(&mut fx) - base;
    // `testing_env!` resets the mocked storage_usage counter, so measure the delta separately.
    fx.as_(OWNER);
    let before = measure(&mut fx);
    fx.c.approve(id.clone());
    fx.c.mark_executed(id, U128(1), "x".repeat(66));
    let executed = pending + (measure(&mut fx) - before);
    println!("storage bytes per proposal: pending={pending} executed(66B receipt)={executed}");
    assert!(pending < 450 && executed < 600, "{pending} {executed}");
}

// ------------------------------------------------------------------ gas (host side)

#[test]
fn host_side_gas_is_far_below_the_default_30_tgas_budget() {
    // `used_gas` in unit tests counts host-function / storage costs only, NOT wasm instruction
    // cost, so this is a lower bound used as a smoke check, not a benchmark.
    let mut fx = Fx::new();
    let mut measure = |label: &str, f: &mut dyn FnMut(&mut Fx)| {
        fx.as_(OWNER);
        let before = env::used_gas();
        f(&mut fx);
        let used = env::used_gas().as_gas() - before.as_gas();
        println!("host-side gas {label}: {:.2} Tgas", used as f64 / 1e12);
        assert!(used < 30_000_000_000_000, "{label} used {used}");
    };
    let mut id = String::new();
    measure("propose", &mut |fx| id = fx.proposed());
    measure("approve", &mut |fx| fx.c.approve(id.clone()));
    measure("mark_executed", &mut |fx| {
        fx.c.mark_executed(id.clone(), U128(1), "tx:abc".into())
    });
    measure("cancel", &mut |fx| {
        let i = fx.proposed();
        fx.as_(OWNER);
        fx.c.cancel(i)
    });
}

// ------------------------------------------------------------ golden test vectors

struct Vector {
    name: &'static str,
    network_id: &'static str,
    registry: &'static str,
    target: &'static str,
    method: &'static str,
    max_spend: u128,
    expiry: u64,
    nonce: u64,
    artifact_hash: &'static str,
}

fn vectors() -> Vec<Vector> {
    vec![
        Vector {
            name: "testnet_basic",
            network_id: "testnet",
            registry: "registry.testnet",
            target: "dex.testnet",
            method: "swap",
            max_spend: 10 * NEAR,
            expiry: 1_700_086_400_000_000_000,
            nonce: 0,
            artifact_hash: HASH,
        },
        Vector {
            name: "mainnet_other_registry_nonce_7",
            network_id: "mainnet",
            registry: "autonear-registry.near",
            target: "v2.ref-finance.near",
            method: "ft_transfer_call",
            max_spend: 1,
            expiry: 1_800_000_000_000_000_000,
            nonce: 7,
            artifact_hash: "0000000000000000000000000000000000000000000000000000000000000000",
        },
        Vector {
            name: "extreme_numeric_bounds",
            network_id: "testnet",
            registry: "registry.testnet",
            target: "a.b.c.testnet",
            method: "m",
            max_spend: u128::MAX,
            expiry: u64::MAX,
            nonce: u64::MAX,
            artifact_hash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        },
        Vector {
            name: "implicit_account_target_long_method",
            network_id: "sandbox",
            registry: "r.test.near",
            target: "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de",
            method: "a_very_long_method_name_with_digits_0123456789",
            max_spend: 123_456_789_012_345_678_901_234_567_890,
            expiry: 1_234_567_890_123_456_789,
            nonce: 4_294_967_296,
            artifact_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
    ]
}

fn vector_json(v: &Vector) -> Value {
    let hash = id::parse_hex32(v.artifact_hash).unwrap();
    let pre = id::id_preimage(
        v.network_id,
        v.registry,
        v.target,
        v.method,
        v.max_spend,
        v.expiry,
        v.nonce,
        &hash,
    );
    let idv = id::compute_id(
        v.network_id,
        v.registry,
        v.target,
        v.method,
        v.max_spend,
        v.expiry,
        v.nonce,
        &hash,
    );
    json!({
        "name": v.name,
        "network_id": v.network_id,
        "registry": v.registry,
        "target": v.target,
        "method": v.method,
        "max_spend": v.max_spend.to_string(),
        "expiry": v.expiry.to_string(),
        "nonce": v.nonce.to_string(),
        "artifact_hash": v.artifact_hash,
        "preimage_hex": id::to_hex(&pre),
        "id": id::to_hex(&idv),
    })
}

fn vector_file() -> Value {
    json!({
        "description": "Golden vectors for the AutoNEAR registry proposal id. id = sha256(preimage); \
                        preimage = concat(u32_be(len(f)) || f) over fields: domain, network_id, registry, \
                        target, method, max_spend(u128 BE 16B), expiry(u64 BE 8B), nonce(u64 BE 8B), \
                        artifact_hash(32B). See README.md. Generated by `UPDATE_VECTORS=1 cargo test --locked golden`.",
        "domain": String::from_utf8(id::ID_DOMAIN.to_vec()).unwrap(),
        "vectors": vectors().iter().map(vector_json).collect::<Vec<_>>(),
    })
}

#[test]
fn golden_vectors_match_committed_file() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/test-vectors.json");
    let fresh = serde_json::to_string_pretty(&vector_file()).unwrap() + "\n";
    if std::env::var("UPDATE_VECTORS").as_deref() == Ok("1") {
        std::fs::write(path, &fresh).unwrap();
    }
    let on_disk = std::fs::read_to_string(path).expect("test-vectors.json missing");
    assert_eq!(on_disk, fresh, "test-vectors.json is stale; regenerate");
    assert!(vectors().len() >= 3);
}

#[test]
fn golden_vectors_are_distinct_and_contract_computes_the_same_ids() {
    let mut seen = HashSet::new();
    for v in vectors() {
        let expected = vector_json(&v)["id"].as_str().unwrap().to_string();
        assert!(seen.insert(expected.clone()), "duplicate id for {}", v.name);
        set_ctx_at(v.registry, OWNER, T0);
        let c = Registry::new(acct(OWNER), acct(PROPOSER), v.network_id.into(), None);
        let got = c.compute_proposal_id(
            acct(v.target),
            v.method.into(),
            U128(v.max_spend),
            U64(v.expiry),
            U64(v.nonce),
            v.artifact_hash.into(),
        );
        assert_eq!(got, expected, "{}", v.name);
    }
}

#[test]
fn id_encoding_is_length_prefixed_so_field_boundaries_cannot_shift() {
    let h = [7u8; 32];
    // "ab"+"c" vs "a"+"bc" must not collide.
    let a = id::compute_id("testnet", "r.testnet", "ab.testnet", "c", 1, 2, 3, &h);
    let b = id::compute_id("testnet", "r.testnet", "a.testnet", "bc", 1, 2, 3, &h);
    assert_ne!(a, b);
    let pre = id::id_preimage("n", "r", "t", "m", 1, 2, 3, &h);
    // domain prefix present, with its 4-byte big-endian length.
    assert_eq!(&pre[..4], &(id::ID_DOMAIN.len() as u32).to_be_bytes());
    assert_eq!(&pre[4..4 + id::ID_DOMAIN.len()], id::ID_DOMAIN);
    // total length = sum of (4 + len)
    let expect = 4 * 9 + id::ID_DOMAIN.len() + 1 + 1 + 1 + 1 + 16 + 8 + 8 + 32;
    assert_eq!(pre.len(), expect);
}

// -------------------------------------------------------- property / fuzz test

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn is_frozen(s: StatusView) -> bool {
    matches!(
        s,
        StatusView::Executed | StatusView::Cancelled | StatusView::Expired
    )
}

fn sweep(fx: &Fx, frozen: &mut HashMap<String, ProposalView>) {
    let total = fx.c.proposals_count().0;
    assert_eq!(total, fx.c.config().next_nonce.0, "ids.len == next_nonce");
    let mut seen = HashSet::new();
    let mut idx = 0;
    while idx < total {
        for v in fx.c.list(Some(U64(idx)), Some(U64(MAX_PAGE))) {
            idx += 1;
            assert!(seen.insert(v.id.clone()), "duplicate id");
            assert_eq!(v.nonce.0, idx - 1, "nonce order");
            if let Some(s) = v.spent {
                assert!(s.0 <= v.max_spend.0, "spent <= max_spend");
                assert_eq!(v.status, StatusView::Executed);
            }
            assert!(v.max_spend.0 > 0);
            match v.status {
                StatusView::Executed => {
                    assert!(v.spent.is_some() && v.receipt_ref.is_some());
                    assert!(v.approved_at.is_some() && v.executed_at.is_some());
                }
                StatusView::Pending => assert!(v.approved_at.is_none()),
                _ => {}
            }
            if let Some(old) = frozen.get(&v.id) {
                assert_eq!(*old, v, "frozen proposal changed");
            } else if is_frozen(v.status) {
                frozen.insert(v.id.clone(), v);
            }
        }
    }
    assert_eq!(seen.len() as u64, total);
}

#[test]
fn property_random_state_machine_never_violates_invariants() {
    let mut rng = Lcg(0x5eed_1234_abcd_ef01);
    let mut fx = Fx::new();
    const BURST: u32 = 50;
    let mut actor = OWNER;
    let methods = [METHOD, "other_method", "third"];
    let targets = [TARGET, "other.testnet"];
    let mut frozen: HashMap<String, ProposalView> = HashMap::new();
    let mut ids: Vec<String> = Vec::new();
    let (mut ok_calls, mut reverted) = (0u32, 0u32);

    for step in 0..20_000u32 {
        // Rebuilding the mocked blockchain costs ~20ms, so the actor and the clock only
        // change at burst boundaries (every BURST steps).
        if step % BURST == 0 {
            actor = match rng.below(10) {
                0..=3 => OWNER,
                4..=7 => PROPOSER,
                _ => OUTSIDER,
            };
            fx.now += rng.below(2 * DAY);
            fx.as_(actor);
        }
        let cfg = fx.c.config();
        let action = rng.below(13);
        let pick = |rng: &mut Lcg, ids: &Vec<String>| -> String {
            if ids.is_empty() || rng.below(25) == 0 {
                HASH.to_string()
            } else if rng.below(4) == 0 {
                ids[rng.below(ids.len() as u64) as usize].clone()
            } else {
                // bias towards recent proposals so they actually progress
                let back = rng.below(ids.len().min(6) as u64) as usize;
                ids[ids.len() - 1 - back].clone()
            }
        };
        match action {
            0..=3 => {
                let cap = cfg.max_spend_cap.0;
                let nonce = if rng.below(10) < 8 {
                    cfg.next_nonce.0
                } else {
                    rng.below(cfg.next_nonce.0 + 3)
                };
                let max_spend = u128::from(rng.next()) % (cap + cap / 4 + 1);
                let expiry = fx.now + rng.below(32 * DAY).max(1);
                let target = targets[rng.below(2) as usize];
                let method = methods[rng.below(3) as usize];
                let hash_byte = rng.below(256) as u8;
                let hash = id::to_hex(&[hash_byte; 32]);
                let args = (
                    acct(target),
                    method.to_string(),
                    U128(max_spend),
                    U64(expiry),
                    U64(nonce),
                    hash.clone(),
                );
                let before_count = fx.c.proposals_count().0;
                let res = catch_unwind(AssertUnwindSafe(|| {
                    fx.c.propose(
                        args.0.clone(),
                        args.1.clone(),
                        args.2,
                        args.3,
                        args.4,
                        args.5.clone(),
                    )
                }));
                match res {
                    Ok(id) => {
                        ok_calls += 1;
                        assert!(actor == OWNER || actor == PROPOSER);
                        assert!(!cfg.paused);
                        assert!(fx.c.is_allowed(args.0.clone(), args.1.clone()));
                        assert!(max_spend > 0 && max_spend <= cap);
                        assert_eq!(nonce, cfg.next_nonce.0);
                        assert!(expiry > fx.now && expiry <= fx.now + MAX_TTL_NS);
                        assert_eq!(fx.c.proposals_count().0, before_count + 1);
                        assert_eq!(fx.status(&id), StatusView::Pending);
                        ids.push(id);
                    }
                    Err(_) => {
                        reverted += 1;
                        assert_eq!(fx.c.proposals_count().0, before_count);
                    }
                }
            }
            4..=9 => {
                let id = pick(&mut rng, &ids);
                let before = fx.c.get_proposal(id.clone());
                let spent = before
                    .as_ref()
                    .map(|v| u128::from(rng.next()) % (v.max_spend.0 + v.max_spend.0 / 8 + 1))
                    .unwrap_or(1);
                let kind = match action {
                    4..=6 => "approve",
                    7 | 8 => "execute",
                    _ => "cancel",
                };
                let res = catch_unwind(AssertUnwindSafe(|| match kind {
                    "approve" => fx.c.approve(id.clone()),
                    "execute" => {
                        fx.c.mark_executed(id.clone(), U128(spent), format!("r{step}"))
                    }
                    _ => fx.c.cancel(id.clone()),
                }));
                let after = fx.c.get_proposal(id.clone());
                match res {
                    Ok(()) => {
                        ok_calls += 1;
                        let b = before.expect("success requires an existing proposal");
                        let a = after.unwrap();
                        assert!(b.expiry.0 >= fx.now, "never mutate an expired proposal");
                        match kind {
                            "approve" => {
                                assert_eq!(actor, OWNER);
                                assert!(!cfg.paused);
                                assert_eq!(b.status, StatusView::Pending);
                                assert_eq!(a.status, StatusView::Approved);
                                assert!(fx.c.is_allowed(b.target.clone(), b.method.clone()));
                            }
                            "execute" => {
                                assert_eq!(actor, OWNER);
                                assert!(!cfg.paused);
                                assert_eq!(b.status, StatusView::Approved);
                                assert_eq!(a.status, StatusView::Executed);
                                assert!(spent <= b.max_spend.0);
                                assert_eq!(a.spent, Some(U128(spent)));
                            }
                            _ => {
                                assert!(matches!(
                                    b.status,
                                    StatusView::Pending | StatusView::Approved
                                ));
                                assert_eq!(a.status, StatusView::Cancelled);
                                assert!(
                                    actor == OWNER
                                        || (actor == PROPOSER && b.status == StatusView::Pending)
                                );
                            }
                        }
                    }
                    Err(_) => {
                        reverted += 1;
                        assert_eq!(before, after, "a reverted call must not change state");
                    }
                }
            }
            10 => {
                if rng.below(4) == 0 {
                    let _ = catch_unwind(AssertUnwindSafe(|| fx.c.pause()));
                }
            }
            11 => {
                if rng.below(2) == 0 {
                    let _ = catch_unwind(AssertUnwindSafe(|| fx.c.unpause()));
                }
            }
            _ => match rng.below(4) {
                0 => {
                    let _ = catch_unwind(AssertUnwindSafe(|| {
                        fx.c.allowlist_add(
                            acct(targets[rng.below(2) as usize]),
                            methods[rng.below(3) as usize].into(),
                        )
                    }));
                }
                1 => {
                    let _ = catch_unwind(AssertUnwindSafe(|| {
                        fx.c.allowlist_remove(
                            acct(targets[rng.below(2) as usize]),
                            methods[rng.below(3) as usize].into(),
                        )
                    }));
                }
                2 => {
                    let cap = (1 + u128::from(rng.below(120))) * NEAR;
                    let _ = catch_unwind(AssertUnwindSafe(|| fx.c.set_max_spend_cap(U128(cap))));
                }
                _ => {
                    // keep the (target, method) the generator proposes most often available
                    let _ = catch_unwind(AssertUnwindSafe(|| {
                        fx.c.allowlist_add(acct(TARGET), METHOD.into())
                    }));
                }
            },
        }
        if step % 1000 == 0 {
            sweep(&fx, &mut frozen);
        }
    }
    sweep(&fx, &mut frozen);
    println!(
        "property run: ok={ok_calls} reverted={reverted} frozen={}",
        frozen.len()
    );
    assert!(
        ok_calls > 500 && reverted > 500,
        "ok={ok_calls} reverted={reverted}"
    );
    assert!(frozen.len() > 20, "frozen={}", frozen.len());
    let executed = frozen
        .values()
        .filter(|v| v.status == StatusView::Executed)
        .count();
    let cancelled = frozen
        .values()
        .filter(|v| v.status == StatusView::Cancelled)
        .count();
    assert!(executed > 5 && cancelled > 5, "e={executed} c={cancelled}");
}
