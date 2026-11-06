//! Unit tests for the mock token (run with `cargo test --locked`).

use super::*;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, Gas, PromiseResult};

const TOKEN: &str = "usdc.testnet";
const ALICE: &str = "alice.testnet";
const BOB: &str = "bob.testnet";
const CAROL: &str = "carol.testnet";
const DECIMALS: u8 = 6;
const ONE: u128 = 1_000_000;
const CEILING: u128 = 10_000 * ONE;
const NAME: &str = "Mock USDC (testnet, anyone can mint)";

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn set_ctx(who: &str, deposit: u128, prepaid_tgas: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acct(TOKEN))
        .signer_account_id(acct(who))
        .predecessor_account_id(acct(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(prepaid_tgas))
        .build());
}

fn ctx(who: &str) {
    set_ctx(who, 0, 300);
}

fn ctx_1y(who: &str) {
    set_ctx(who, 1, 300);
}

fn token() -> Contract {
    ctx(ALICE);
    Contract::new(
        NAME.to_string(),
        "USDC".to_string(),
        DECIMALS,
        "testnet".to_string(),
    )
}

fn min_storage(c: &Contract) -> u128 {
    c.storage_balance_bounds().min.as_yoctonear()
}

const MINTER: &str = "minter.testnet";

/// Mints as `MINTER`, attaching exactly the storage minimum when the receiver is not registered yet.
fn mint_to(c: &mut Contract, to: &str, amount: u128) {
    let deposit = if c.storage_balance_of(acct(to)).is_some() {
        0
    } else {
        min_storage(c)
    };
    set_ctx(MINTER, deposit, 300);
    c.mint(acct(to), U128(amount));
}

// ---- init ----------------------------------------------------------------------------------------

#[test]
fn init_accepts_testnet_and_localnet() {
    for net in ["testnet", "localnet"] {
        ctx(ALICE);
        let c = Contract::new(NAME.to_string(), "USDC".to_string(), 6, net.to_string());
        assert_eq!(c.network_id(), net);
    }
}

fn init_with_network(net: &str) {
    ctx(ALICE);
    let _ = Contract::new(NAME.to_string(), "USDC".to_string(), 6, net.to_string());
}

#[test]
#[should_panic(expected = "E_BadNetwork")]
fn init_refuses_mainnet() {
    init_with_network("mainnet");
}

#[test]
#[should_panic(expected = "E_BadNetwork")]
fn init_refuses_empty_network() {
    init_with_network("");
}

#[test]
#[should_panic(expected = "E_BadNetwork")]
fn init_refuses_testnet2() {
    init_with_network("testnet2");
}

#[test]
#[should_panic(expected = "E_BadNetwork")]
fn init_refuses_wrong_case_and_whitespace() {
    init_with_network("Testnet ");
}

#[test]
#[should_panic(expected = "E_BadMetadata")]
fn init_refuses_absurd_decimals() {
    ctx(ALICE);
    let _ = Contract::new(
        NAME.to_string(),
        "USDC".to_string(),
        25,
        "testnet".to_string(),
    );
}

#[test]
fn metadata_is_exactly_what_init_was_given() {
    let c = token();
    let m = c.ft_metadata();
    assert_eq!(m.spec, "ft-1.0.0");
    assert_eq!(m.name, "Mock USDC (testnet, anyone can mint)");
    assert_eq!(m.symbol, "USDC");
    assert_eq!(m.decimals, 6);
    assert!(m.icon.is_none());
    assert!(m.reference.is_none() && m.reference_hash.is_none());
    m.assert_valid();
    let json = serde_json::to_value(&m).unwrap();
    assert_eq!(json["name"], NAME);
}

#[test]
fn views() {
    let c = token();
    assert_eq!(c.network_id(), "testnet");
    assert_eq!(c.max_mint_per_call(), U128(CEILING));
    assert_eq!(c.ft_total_supply(), U128(0));
    assert_eq!(c.ft_balance_of(acct(ALICE)), U128(0));
}

#[test]
fn ceiling_scales_with_decimals() {
    ctx(ALICE);
    let c = Contract::new("T".to_string(), "T".to_string(), 0, "localnet".to_string());
    assert_eq!(c.max_mint_per_call(), U128(10_000));
    let c = Contract::new("T".to_string(), "T".to_string(), 24, "localnet".to_string());
    assert_eq!(c.max_mint_per_call().0, 10_000 * 10u128.pow(24));
}

// ---- mint ----------------------------------------------------------------------------------------

#[test]
fn mint_exactly_at_ceiling_is_ok() {
    let mut c = token();
    mint_to(&mut c, ALICE, CEILING);
    assert_eq!(c.ft_balance_of(acct(ALICE)), U128(CEILING));
}

#[test]
#[should_panic(expected = "E_MintCeiling")]
fn mint_one_over_ceiling_aborts() {
    let mut c = token();
    mint_to(&mut c, ALICE, CEILING + 1);
}

#[test]
#[should_panic(expected = "E_BadAmount")]
fn mint_zero_aborts() {
    let mut c = token();
    mint_to(&mut c, ALICE, 0);
}

#[test]
#[should_panic(expected = "E_MintCeiling")]
fn mint_u128_max_aborts() {
    let mut c = token();
    mint_to(&mut c, ALICE, u128::MAX);
}

#[test]
fn mint_to_unregistered_with_enough_deposit_registers_it_and_refunds_the_excess() {
    let mut c = token();
    let min = min_storage(&c);
    assert!(c.storage_balance_of(acct(BOB)).is_none());
    set_ctx(CAROL, min + 12_345, 300);
    c.mint(acct(BOB), U128(25 * ONE));
    assert_eq!(c.ft_balance_of(acct(BOB)), U128(25 * ONE));
    assert_eq!(c.ft_total_supply(), U128(25 * ONE));
    let sb = c.storage_balance_of(acct(BOB)).expect("registered by mint");
    assert_eq!(sb.total.as_yoctonear(), min);
    assert_eq!(sb.available.as_yoctonear(), 0);
    // Exactly one receipt: a transfer of the excess back to the minter (not to the receiver).
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 1, "{receipts:?}");
    assert_eq!(receipts[0].receiver_id.as_str(), CAROL);
    assert!(format!("{receipts:?}").contains("12345"), "{receipts:?}");
}

#[test]
fn mint_to_unregistered_with_exact_minimum_has_no_refund() {
    let mut c = token();
    let min = min_storage(&c);
    set_ctx(CAROL, min, 300);
    c.mint(acct(BOB), U128(ONE));
    assert!(c.storage_balance_of(acct(BOB)).is_some());
    assert!(get_created_receipts().is_empty());
}

#[test]
#[should_panic(expected = "E_StorageDeposit")]
fn mint_to_unregistered_without_deposit_aborts() {
    let mut c = token();
    set_ctx(CAROL, 0, 300);
    c.mint(acct(BOB), U128(ONE));
}

#[test]
#[should_panic(expected = "E_StorageDeposit")]
fn mint_to_unregistered_with_insufficient_deposit_aborts() {
    let mut c = token();
    let min = min_storage(&c);
    set_ctx(CAROL, min - 1, 300);
    c.mint(acct(BOB), U128(ONE));
}

#[test]
fn failed_storage_check_leaves_no_trace() {
    let mut c = token();
    set_ctx(CAROL, 0, 300);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.mint(acct(BOB), U128(ONE));
    }));
    assert!(r.is_err());
    assert!(c.storage_balance_of(acct(BOB)).is_none());
    assert_eq!(c.ft_total_supply(), U128(0));
}

#[test]
fn mint_to_registered_needs_no_deposit() {
    let mut c = token();
    let min = min_storage(&c);
    set_ctx(BOB, min, 300);
    c.storage_deposit(None, Some(true));
    set_ctx(CAROL, 0, 300);
    c.mint(acct(BOB), U128(3 * ONE));
    assert_eq!(c.ft_balance_of(acct(BOB)), U128(3 * ONE));
    assert_eq!(c.ft_total_supply(), U128(3 * ONE));
    assert!(get_created_receipts().is_empty());
}

#[test]
fn mint_to_registered_refunds_any_attached_deposit_to_the_caller() {
    let mut c = token();
    mint_to(&mut c, BOB, ONE);
    set_ctx(CAROL, 54_321, 300);
    c.mint(acct(BOB), U128(2 * ONE));
    assert_eq!(c.ft_balance_of(acct(BOB)), U128(3 * ONE));
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 1, "{receipts:?}");
    assert_eq!(receipts[0].receiver_id.as_str(), CAROL);
    assert!(format!("{receipts:?}").contains("54321"), "{receipts:?}");
}

#[test]
fn minting_never_changes_the_receivers_registration_cost_or_pays_from_contract() {
    // Every receipt a mint creates is a refund to the caller; nothing is ever sent to the receiver.
    let mut c = token();
    let min = min_storage(&c);
    for (i, extra) in [0u128, 7, 99].into_iter().enumerate() {
        let who = format!("fresh{i}.testnet");
        set_ctx(CAROL, min + extra, 300);
        c.mint(acct(&who), U128(ONE));
        for r in get_created_receipts() {
            assert_eq!(r.receiver_id.as_str(), CAROL);
        }
    }
    assert_eq!(c.ft_total_supply(), U128(3 * ONE));
}

#[test]
fn repeated_mints_accumulate_and_do_not_reregister() {
    let mut c = token();
    mint_to(&mut c, BOB, 5 * ONE);
    mint_to(&mut c, BOB, 7 * ONE);
    mint_to(&mut c, ALICE, ONE);
    assert_eq!(c.ft_balance_of(acct(BOB)), U128(12 * ONE));
    assert_eq!(c.ft_total_supply(), U128(13 * ONE));
}

#[test]
fn mint_registration_is_paid_by_the_minter_and_unregister_refunds_the_receiver_only_that() {
    let mut c = token();
    mint_to(&mut c, BOB, ONE);
    ctx_1y(BOB);
    assert!(c.storage_unregister(Some(true)));
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].receiver_id.as_str(), BOB);
}

fn event_of(log: &str) -> Value {
    let body = log.strip_prefix("EVENT_JSON:").expect("NEP-297 prefix");
    serde_json::from_str(body).expect("valid JSON")
}

#[test]
fn mint_emits_valid_nep297_ft_mint() {
    let mut c = token();
    mint_to(&mut c, BOB, 25 * ONE);
    let logs = get_logs();
    assert_eq!(logs.len(), 1, "exactly one log: {logs:?}");
    let ev = event_of(&logs[0]);
    assert_eq!(ev["standard"], "nep141");
    assert_eq!(ev["version"], "1.0.0");
    assert_eq!(ev["event"], "ft_mint");
    let data = ev["data"].as_array().expect("data is an array");
    assert_eq!(data.len(), 1);
    assert_eq!(data[0]["owner_id"], BOB);
    assert_eq!(data[0]["amount"], "25000000");
    assert!(data[0].get("memo").is_none());
    // NEP-297: exactly these top-level keys.
    let mut keys: Vec<&str> = ev.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["data", "event", "standard", "version"]);
}

#[test]
fn rejected_mint_emits_no_event_and_changes_nothing() {
    let mut c = token();
    let before = get_logs().len();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        mint_to(&mut c, BOB, CEILING + 1);
    }));
    assert!(r.is_err());
    assert_eq!(get_logs().len(), before);
    assert_eq!(c.ft_total_supply(), U128(0));
    assert!(c.storage_balance_of(acct(BOB)).is_none());
}

// ---- ft_transfer ---------------------------------------------------------------------------------

#[test]
fn ft_transfer_moves_balance_and_emits_event() {
    let mut c = token();
    mint_to(&mut c, ALICE, 100 * ONE);
    mint_to(&mut c, BOB, 1);
    ctx_1y(ALICE);
    c.ft_transfer(acct(BOB), U128(40 * ONE), Some("rent".to_string()));
    assert_eq!(c.ft_balance_of(acct(ALICE)), U128(60 * ONE));
    assert_eq!(c.ft_balance_of(acct(BOB)), U128(40 * ONE + 1));
    assert_eq!(c.ft_total_supply(), U128(100 * ONE + 1));
    let ev = event_of(get_logs().last().unwrap());
    assert_eq!(ev["event"], "ft_transfer");
    assert_eq!(ev["data"][0]["old_owner_id"], ALICE);
    assert_eq!(ev["data"][0]["new_owner_id"], BOB);
    assert_eq!(ev["data"][0]["memo"], "rent");
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn ft_transfer_without_yocto_aborts() {
    let mut c = token();
    mint_to(&mut c, ALICE, 10 * ONE);
    mint_to(&mut c, BOB, 1);
    ctx(ALICE);
    c.ft_transfer(acct(BOB), U128(ONE), None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn ft_transfer_with_two_yocto_aborts() {
    let mut c = token();
    mint_to(&mut c, ALICE, 10 * ONE);
    mint_to(&mut c, BOB, 1);
    set_ctx(ALICE, 2, 300);
    c.ft_transfer(acct(BOB), U128(ONE), None);
}

#[test]
#[should_panic(expected = "The account carol.testnet is not registered")]
fn ft_transfer_to_unregistered_receiver_aborts() {
    let mut c = token();
    mint_to(&mut c, ALICE, 10 * ONE);
    ctx_1y(ALICE);
    c.ft_transfer(acct(CAROL), U128(ONE), None);
}

#[test]
#[should_panic(expected = "doesn't have enough balance")]
fn ft_transfer_over_balance_aborts() {
    let mut c = token();
    mint_to(&mut c, ALICE, ONE);
    mint_to(&mut c, BOB, 1);
    ctx_1y(ALICE);
    c.ft_transfer(acct(BOB), U128(ONE + 1), None);
}

#[test]
#[should_panic(expected = "The amount should be a positive number")]
fn ft_transfer_zero_aborts() {
    let mut c = token();
    mint_to(&mut c, ALICE, ONE);
    mint_to(&mut c, BOB, 1);
    ctx_1y(ALICE);
    c.ft_transfer(acct(BOB), U128(0), None);
}

#[test]
#[should_panic(expected = "Sender and receiver should be different")]
fn ft_transfer_to_self_aborts() {
    let mut c = token();
    mint_to(&mut c, ALICE, ONE);
    ctx_1y(ALICE);
    c.ft_transfer(acct(ALICE), U128(1), None);
}

// ---- ft_transfer_call and its resolver -------------------------------------------------------------

fn resolver_ctx(result: PromiseResult) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acct(TOKEN))
            .predecessor_account_id(acct(TOKEN))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn transfer_call_setup() -> Contract {
    let mut c = token();
    mint_to(&mut c, ALICE, 100 * ONE);
    let min = min_storage(&c);
    set_ctx(BOB, min, 300);
    c.storage_deposit(None, Some(true));
    c
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn ft_transfer_call_needs_one_yocto() {
    let mut c = transfer_call_setup();
    ctx(ALICE);
    c.ft_transfer_call(acct(BOB), U128(ONE), None, "x".to_string());
}

#[test]
#[should_panic(expected = "More gas is required")]
fn ft_transfer_call_needs_enough_gas() {
    let mut c = transfer_call_setup();
    set_ctx(ALICE, 1, 30);
    c.ft_transfer_call(acct(BOB), U128(ONE), None, "x".to_string());
}

#[test]
fn ft_transfer_call_moves_funds_then_schedules_receiver_and_resolver() {
    let mut c = transfer_call_setup();
    ctx_1y(ALICE);
    c.ft_transfer_call(acct(BOB), U128(40 * ONE), None, "hello".to_string());
    // Optimistic transfer happened already.
    assert_eq!(c.ft_balance_of(acct(ALICE)), U128(60 * ONE));
    assert_eq!(c.ft_balance_of(acct(BOB)), U128(40 * ONE));
    let receipts = get_created_receipts();
    assert_eq!(
        receipts.len(),
        2,
        "ft_on_transfer + ft_resolve_transfer: {receipts:?}"
    );
    let method = |r: &near_sdk::mock::Receipt| match &r.actions[0] {
        near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. } => {
            String::from_utf8(method_name.clone()).unwrap()
        }
        other => panic!("unexpected action {other:?}"),
    };
    assert_eq!(receipts[0].receiver_id.as_str(), BOB);
    assert_eq!(method(&receipts[0]), "ft_on_transfer");
    assert_eq!(receipts[1].receiver_id.as_str(), TOKEN);
    assert_eq!(method(&receipts[1]), "ft_resolve_transfer");
}

#[test]
fn resolve_with_partial_unused_refunds_only_the_unused_part() {
    let mut c = transfer_call_setup();
    ctx_1y(ALICE);
    c.ft_transfer_call(acct(BOB), U128(40 * ONE), None, "x".to_string());
    // The receiver returns 15 unused.
    resolver_ctx(PromiseResult::Successful(
        format!("\"{}\"", 15 * ONE).into_bytes(),
    ));
    let used = c.ft_resolve_transfer(acct(ALICE), acct(BOB), U128(40 * ONE));
    assert_eq!(used, U128(25 * ONE));
    assert_eq!(c.ft_balance_of(acct(ALICE)), U128((60 + 15) * ONE));
    assert_eq!(c.ft_balance_of(acct(BOB)), U128(25 * ONE));
    assert_eq!(c.ft_total_supply(), U128(100 * ONE));
    let ev = event_of(get_logs().last().unwrap());
    assert_eq!(ev["event"], "ft_transfer");
    assert_eq!(ev["data"][0]["old_owner_id"], BOB);
    assert_eq!(ev["data"][0]["new_owner_id"], ALICE);
    assert_eq!(ev["data"][0]["memo"], "refund");
}

#[test]
fn resolve_with_zero_unused_keeps_the_transfer() {
    let mut c = transfer_call_setup();
    ctx_1y(ALICE);
    c.ft_transfer_call(acct(BOB), U128(40 * ONE), None, "x".to_string());
    resolver_ctx(PromiseResult::Successful(b"\"0\"".to_vec()));
    let used = c.ft_resolve_transfer(acct(ALICE), acct(BOB), U128(40 * ONE));
    assert_eq!(used, U128(40 * ONE));
    assert_eq!(c.ft_balance_of(acct(ALICE)), U128(60 * ONE));
    assert_eq!(c.ft_balance_of(acct(BOB)), U128(40 * ONE));
}

#[test]
fn resolve_when_receiver_call_failed_refunds_everything() {
    let mut c = transfer_call_setup();
    ctx_1y(ALICE);
    c.ft_transfer_call(acct(BOB), U128(40 * ONE), None, "x".to_string());
    resolver_ctx(PromiseResult::Failed);
    let used = c.ft_resolve_transfer(acct(ALICE), acct(BOB), U128(40 * ONE));
    assert_eq!(used, U128(0));
    assert_eq!(c.ft_balance_of(acct(ALICE)), U128(100 * ONE));
    assert_eq!(c.ft_balance_of(acct(BOB)), U128(0));
    assert_eq!(c.ft_total_supply(), U128(100 * ONE));
}

#[test]
fn resolve_never_refunds_more_than_the_receiver_still_holds() {
    let mut c = transfer_call_setup();
    ctx_1y(ALICE);
    c.ft_transfer_call(acct(BOB), U128(40 * ONE), None, "x".to_string());
    // The receiver spent 30 meanwhile (moves its own tokens to alice), then claims 40 unused.
    ctx_1y(BOB);
    c.ft_transfer(acct(ALICE), U128(30 * ONE), None);
    resolver_ctx(PromiseResult::Successful(
        format!("\"{}\"", 40 * ONE).into_bytes(),
    ));
    let used = c.ft_resolve_transfer(acct(ALICE), acct(BOB), U128(40 * ONE));
    assert_eq!(used, U128(30 * ONE));
    assert_eq!(c.ft_balance_of(acct(BOB)), U128(0));
    assert_eq!(c.ft_balance_of(acct(ALICE)), U128(100 * ONE));
}

// ---- NEP-145 storage management --------------------------------------------------------------------

#[test]
fn storage_bounds_are_fixed_and_positive() {
    let c = token();
    let b = c.storage_balance_bounds();
    assert!(b.min.as_yoctonear() > 0);
    assert_eq!(b.max, Some(b.min));
}

#[test]
fn storage_deposit_registers_and_refunds_excess() {
    let mut c = token();
    let min = min_storage(&c);
    set_ctx(BOB, min + 777, 300);
    let sb = c.storage_deposit(None, None);
    assert_eq!(sb.total.as_yoctonear(), min);
    assert_eq!(sb.available.as_yoctonear(), 0);
    assert!(c.storage_balance_of(acct(BOB)).is_some());
    assert_eq!(c.ft_balance_of(acct(BOB)), U128(0));
    // The excess went back to the caller as a transfer receipt.
    let dump = format!("{:?}", get_created_receipts());
    assert!(dump.contains("777"), "{dump}");
}

#[test]
fn storage_deposit_for_another_account() {
    let mut c = token();
    let min = min_storage(&c);
    set_ctx(ALICE, min, 300);
    c.storage_deposit(Some(acct(CAROL)), Some(true));
    assert!(c.storage_balance_of(acct(CAROL)).is_some());
    assert!(c.storage_balance_of(acct(ALICE)).is_none());
}

#[test]
#[should_panic(expected = "less than the minimum storage balance")]
fn storage_deposit_below_minimum_aborts() {
    let mut c = token();
    let min = min_storage(&c);
    set_ctx(BOB, min - 1, 300);
    c.storage_deposit(None, None);
}

#[test]
fn storage_deposit_when_already_registered_refunds_whole_deposit() {
    let mut c = token();
    mint_to(&mut c, BOB, ONE);
    let min = min_storage(&c);
    set_ctx(BOB, min, 300);
    let sb = c.storage_deposit(None, None);
    assert_eq!(sb.total.as_yoctonear(), min);
    assert_eq!(c.ft_balance_of(acct(BOB)), U128(ONE));
    assert_eq!(get_created_receipts().len(), 1);
}

#[test]
fn storage_balance_of_unregistered_is_none() {
    let c = token();
    assert!(c.storage_balance_of(acct(CAROL)).is_none());
}

#[test]
fn storage_unregister_needs_zero_balance_unless_forced() {
    let mut c = token();
    mint_to(&mut c, BOB, ONE);
    ctx_1y(BOB);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.storage_unregister(None)));
    assert!(r.is_err(), "positive balance without force must abort");
    ctx_1y(BOB);
    assert!(c.storage_unregister(Some(true)));
    assert!(c.storage_balance_of(acct(BOB)).is_none());
    assert_eq!(c.ft_total_supply(), U128(0));
}

#[test]
fn storage_unregister_of_empty_account_succeeds_and_unknown_returns_false() {
    let mut c = token();
    let min = min_storage(&c);
    set_ctx(BOB, min, 300);
    c.storage_deposit(None, None);
    ctx_1y(BOB);
    assert!(c.storage_unregister(None));
    ctx_1y(CAROL);
    assert!(!c.storage_unregister(None));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn storage_unregister_needs_one_yocto() {
    let mut c = token();
    mint_to(&mut c, BOB, 1);
    ctx(BOB);
    c.storage_unregister(Some(true));
}

#[test]
fn storage_withdraw_has_nothing_to_give() {
    let mut c = token();
    mint_to(&mut c, BOB, ONE);
    ctx_1y(BOB);
    let sb = c.storage_withdraw(None);
    assert_eq!(sb.available.as_yoctonear(), 0);
}

// ---- surface: what the contract does NOT have ------------------------------------------------------

#[test]
fn no_privileged_or_upgrade_surface_in_the_source() {
    let src = include_str!("lib.rs");
    // Only look at the code above the test module declaration.
    let code = src.split("#[cfg(test)]").next().unwrap();
    for needle in [
        "add_full_access_key",
        "add_access_key",
        "delete_account",
        "deploy_contract",
        "promise_batch_action_add_key",
        "set_owner",
        "fn upgrade",
        "Promise::new",
        "Promise",
        "ext_contract",
    ] {
        assert!(
            !code.contains(needle),
            "unexpected `{needle}` in contract code"
        );
    }
}
