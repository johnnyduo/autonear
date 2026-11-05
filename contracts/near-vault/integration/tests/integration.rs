//! REAL integration test: runs the built vault wasm (and the registry wasm, deployed THROUGH the
//! vault) on a local NEAR sandbox (nearcore, via near-workspaces). Nothing here is mocked.
//!
//! Prerequisites: `scripts/near-vault-build.sh` and `scripts/near-build.sh` have been run, so
//! `contracts/near-vault/dist/autonear_vault.wasm` and
//! `contracts/near-registry/dist/autonear_registry.wasm` exist. The first run downloads the
//! near-sandbox binary (network access needed). Run: `cargo test` inside this directory.

use base64::Engine;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

const MAX_GAS_NOTE: &str = "300 Tgas attached (transact().max_gas())";

fn read_wasm(env_var: &str, rel: &str) -> Vec<u8> {
    let p = std::env::var(env_var)
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel));
    std::fs::read(&p).unwrap_or_else(|e| {
        panic!(
            "cannot read {} ({e}); run scripts/near-vault-build.sh and scripts/near-build.sh first",
            p.display()
        )
    })
}

fn sha_hex(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

struct Env {
    worker: Worker<near_workspaces::network::Sandbox>,
    vault: Contract,
    owner: Account,
    agent: Account,
    other: Account,
    registry_wasm: Vec<u8>,
}

fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}

async fn setup() -> Env {
    let worker = near_workspaces::sandbox().await.expect("sandbox starts");
    let root = worker.root_account().unwrap();
    let mk = |name: &'static str, n: u128| {
        let root = root.clone();
        async move {
            root.create_subaccount(name)
                .initial_balance(near(n))
                .transact()
                .await
                .unwrap()
                .into_result()
                .unwrap()
        }
    };
    let owner = mk("owner", 50).await;
    let agent = mk("agent", 20).await;
    let other = mk("other", 20).await;
    let vault_acc = mk("vault", 100).await;
    let vault = vault_acc
        .deploy(&read_wasm("VAULT_WASM", "../dist/autonear_vault.wasm"))
        .await
        .unwrap()
        .into_result()
        .unwrap();
    vault
        .call("new")
        .args_json(json!({"owner": owner.id(), "network_id": "sandbox"}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .expect("vault init");
    Env {
        worker,
        vault,
        owner,
        agent,
        other,
        registry_wasm: read_wasm(
            "REGISTRY_WASM",
            "../../near-registry/dist/autonear_registry.wasm",
        ),
    }
}

impl Env {
    async fn view(&self, c: &AccountId, method: &str, args: Value) -> Value {
        self.worker
            .view(c, method)
            .args_json(args)
            .await
            .unwrap_or_else(|e| panic!("view {method}: {e:?}"))
            .json()
            .unwrap()
    }
    async fn vview(&self, method: &str, args: Value) -> Value {
        self.view(self.vault.id(), method, args).await
    }
    async fn available(&self) -> u128 {
        self.vview("available", json!({}))
            .await
            .as_str()
            .unwrap()
            .parse()
            .unwrap()
    }
    async fn now_secs(&self) -> u64 {
        self.worker.view_block().await.unwrap().timestamp() / 1_000_000_000
    }
    async fn allow_registry(&self, deposit: NearToken, init_args: Value) -> String {
        let id = sha_hex(&self.registry_wasm);
        self.owner
            .call(self.vault.id(), "allow_template")
            .args_json(json!({
                "template_id": id, "label": "registry-v1", "deposit": deposit.as_yoctonear().to_string(),
                "init_args": init_args, "init_gas": (30u64 * 1_000_000_000_000).to_string()
            }))
            .transact()
            .await
            .unwrap()
            .into_result()
            .expect("allow_template");
        id
    }
    async fn set_mandate(&self, max_deploys: u32) {
        self.set_mandate_for(self.agent.id(), max_deploys).await
    }
    async fn set_mandate_for(&self, agent: &AccountId, max_deploys: u32) {
        let exp = self.now_secs().await + 3600;
        self.owner
            .call(self.vault.id(), "set_mandate")
            .args_json(json!({
                "agent": agent, "expires_at": exp.to_string(),
                "per_draw_cap": near(5).as_yoctonear().to_string(), "period_secs": "3600",
                "period_cap": near(20).as_yoctonear().to_string(),
                "total_cap": near(50).as_yoctonear().to_string(), "max_deploys": max_deploys
            }))
            .transact()
            .await
            .unwrap()
            .into_result()
            .expect("set_mandate");
    }
    async fn deploy_as(
        &self,
        who: &Account,
        id: &str,
        name: &str,
        code: &[u8],
    ) -> near_workspaces::result::ExecutionFinalResult {
        who.call(self.vault.id(), "deploy")
            .args_json(json!({
                "template": id, "name": name,
                "code": base64::engine::general_purpose::STANDARD.encode(code)
            }))
            .max_gas()
            .transact()
            .await
            .unwrap()
    }
}

/// `E_<code>:` must appear in the failure of the (real) transaction.
fn assert_code(res: near_workspaces::result::ExecutionFinalResult, code: &str) {
    assert!(
        res.is_failure(),
        "expected E_{code} but the transaction succeeded"
    );
    let msg = format!("{:?}", res.into_result().unwrap_err());
    assert!(
        msg.contains(&format!("E_{code}:")),
        "expected E_{code}, got {msg}"
    );
}

#[tokio::test]
async fn registry_deployed_through_vault_is_keyless_correctly_initialised_and_budgeted() {
    let env = setup().await;
    let owner = env.owner.id().clone();
    let agent = env.agent.id().clone();
    let id = env
        .allow_registry(
            near(5),
            json!({"owner_id": owner, "proposer_id": agent, "network_id": "sandbox"}),
        )
        .await;
    env.set_mandate(3).await;
    let tpl = env.vview("template", json!({"template_id": id})).await;
    assert_eq!(tpl["deposit"], near(5).as_yoctonear().to_string());
    assert_eq!(
        env.vview("preview_deploy", json!({"template": id, "name": "reg1"}))
            .await,
        ""
    );

    let avail0 = env.available().await;
    let res = env
        .deploy_as(&env.agent, &id, "reg1", &env.registry_wasm)
        .await;
    println!(
        "deploy: {MAX_GAS_NOTE}; total gas burnt (whole receipt tree) = {} Tgas",
        res.total_gas_burnt.as_gas() / 1_000_000_000_000
    );
    for o in res.outcomes() {
        println!(
            "  receipt executor={} gas_burnt={:.2} Tgas",
            o.executor_id,
            o.gas_burnt.as_gas() as f64 / 1e12
        );
    }
    let logs = res.logs().join("\n");
    assert!(res.is_success(), "deploy failed: {:?}", res.failures());
    assert!(logs.contains("\"event\":\"deployed\""), "{logs}");
    assert!(
        logs.contains("\"event\":\"deploy_confirmed\""),
        "callback must confirm: {logs}"
    );
    assert!(!logs.contains("deploy_failed"));

    // The sub-account: right code hash, no keys, vault-created.
    let sub: AccountId = format!("reg1.{}", env.vault.id()).parse().unwrap();
    let acc = env
        .worker
        .view_account(&sub)
        .await
        .expect("sub-account exists");
    let want = Sha256::digest(&env.registry_wasm);
    match &acc.contract_state {
        near_workspaces::ContractState::LocalHash(h) => {
            assert_eq!(
                h.0.as_slice(),
                want.as_slice(),
                "sub-account code hash == sha256(template wasm)"
            )
        }
        other => panic!("expected a locally deployed contract, got {other:?}"),
    }
    let keys = env.worker.view_access_keys(&sub).await.unwrap();
    assert!(
        keys.is_empty(),
        "the sub-account must have NO access keys, found {keys:?}"
    );
    assert!(
        acc.balance > near(1)
            && acc.balance.as_yoctonear() < near(5).as_yoctonear() + near(1).as_yoctonear() / 10,
        "balance ~ forwarded deposit (+ the contract gas reward of `new`): {}",
        acc.balance
    );

    // The registry was initialised with the OWNER's fixed init args (agent chose none).
    let cfg = env.view(&sub, "config", json!({})).await;
    assert_eq!(cfg["owner_id"], owner.as_str());
    assert_eq!(cfg["proposer_id"], agent.as_str());
    assert_eq!(cfg["network_id"], "sandbox");
    assert_eq!(cfg["registry_id"], sub.as_str());
    // ...and its owner power really is the owner's: owner can allowlist, the agent cannot.
    let ok = env
        .owner
        .call(&sub, "allowlist_add")
        .args_json(json!({"target": "dex.test.near", "method": "swap"}))
        .transact()
        .await
        .unwrap();
    assert!(ok.is_success(), "{:?}", ok.failures());
    let denied = env
        .agent
        .call(&sub, "allowlist_add")
        .args_json(json!({"target": "evil.test.near", "method": "swap"}))
        .transact()
        .await
        .unwrap();
    assert!(denied.is_failure());

    // Vault accounting.
    let u = env.vview("usage", json!({})).await;
    assert_eq!(u["total_spent"], near(5).as_yoctonear().to_string());
    assert_eq!(u["deploys"], 1);
    let spent = avail0 - env.available().await;
    let tol = near(1).as_yoctonear() / 100; // gas rewards credited to the vault, storage of the name set
    assert!(
        spent + tol >= near(5).as_yoctonear() && spent < near(5).as_yoctonear() + tol,
        "vault paid ~the deposit: {spent}"
    );

    // Real-runtime rule checks (E_<Code>: in the transaction failure).
    assert_code(
        env.deploy_as(&env.agent, &id, "reg1", &env.registry_wasm)
            .await,
        "AddressTaken",
    );
    assert_code(
        env.deploy_as(&env.agent, &id, "reg2", &[0, 97, 115, 109, 1, 0, 0, 0])
            .await,
        "CodeMismatch",
    );
    assert_code(
        env.deploy_as(&env.agent, &id, "Bad.Name", &env.registry_wasm)
            .await,
        "BadName",
    );
    assert_code(
        env.deploy_as(&env.other, &id, "reg3", &env.registry_wasm)
            .await,
        "Unauthorized",
    );
    assert_code(
        env.deploy_as(
            &env.agent,
            &sha_hex(b"not allowed"),
            "reg3",
            &env.registry_wasm,
        )
        .await,
        "TemplateNotAllowed",
    );
    let r = env
        .other
        .call(env.vault.id(), "draw")
        .args_json(json!({"amount": "1"}))
        .transact()
        .await
        .unwrap();
    assert_code(r, "Unauthorized");
    let r = env
        .agent
        .call(env.vault.id(), "draw")
        .args_json(json!({"amount": near(6).as_yoctonear().to_string()}))
        .transact()
        .await
        .unwrap();
    assert_code(r, "PerDrawCap");
    for m in ["revoke", "pause", "unpause"] {
        let r = env.agent.call(env.vault.id(), m).transact().await.unwrap();
        assert_code(r, "Unauthorized");
    }
    let r = env
        .agent
        .call(env.vault.id(), "withdraw")
        .args_json(json!({"amount": "1"}))
        .transact()
        .await
        .unwrap();
    assert_code(r, "Unauthorized");

    // Generated guards (cannot be exercised by unit tests): #[private] callback, non-payable methods.
    let r = env.agent.call(env.vault.id(), "on_deployed")
        .args_json(json!({"epoch": "1", "period_index": "0", "template": id, "name": "reg1", "deposit": "0"}))
        .transact().await.unwrap();
    assert!(
        r.is_failure() && format!("{:?}", r.into_result().unwrap_err()).contains("private"),
        "on_deployed must be #[private]"
    );
    let r = env
        .agent
        .call(env.vault.id(), "on_drawn")
        .args_json(
            json!({"epoch": "1", "period_index": "0", "agent": env.agent.id(), "amount": "0"}),
        )
        .transact()
        .await
        .unwrap();
    assert!(
        r.is_failure() && format!("{:?}", r.into_result().unwrap_err()).contains("private"),
        "on_drawn must be #[private]"
    );
    let r = env
        .agent
        .call(env.vault.id(), "draw")
        .args_json(json!({"amount": "1"}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await
        .unwrap();
    assert!(r.is_failure(), "draw must reject an attached deposit");

    // draw pays the bound agent, never the caller's choice.
    let before = env.agent.view_account().await.unwrap().balance;
    let r = env
        .agent
        .call(env.vault.id(), "draw")
        .args_json(json!({"amount": near(3).as_yoctonear().to_string()}))
        .transact()
        .await
        .unwrap();
    assert!(r.is_success(), "{:?}", r.failures());
    let after = env.agent.view_account().await.unwrap().balance;
    assert!(
        after.as_yoctonear() + near(1).as_yoctonear() / 10
            > before.as_yoctonear() + near(3).as_yoctonear(),
        "agent received ~3 NEAR"
    );

    // Owner withdraw goes to the owner only.
    let ob = env.owner.view_account().await.unwrap().balance;
    let r = env
        .owner
        .call(env.vault.id(), "withdraw")
        .args_json(json!({"amount": near(10).as_yoctonear().to_string()}))
        .transact()
        .await
        .unwrap();
    assert!(r.is_success(), "{:?}", r.failures());
    let oa = env.owner.view_account().await.unwrap().balance;
    assert!(
        oa.as_yoctonear() + near(1).as_yoctonear() / 10
            > ob.as_yoctonear() + near(10).as_yoctonear()
    );
    // Pause blocks the agent, never the owner's withdraw.
    env.owner
        .call(env.vault.id(), "pause")
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    assert_code(
        env.deploy_as(&env.agent, &id, "reg9", &env.registry_wasm)
            .await,
        "Paused",
    );
    let r = env
        .owner
        .call(env.vault.id(), "withdraw")
        .args_json(json!({"amount": near(1).as_yoctonear().to_string()}))
        .transact()
        .await
        .unwrap();
    assert!(r.is_success());
}

#[tokio::test]
async fn failed_batch_is_reversed_by_the_callback_and_leaves_no_account() {
    let env = setup().await;
    let owner = env.owner.id().clone();
    let agent = env.agent.id().clone();
    // (a) deposit too small to pay for the 200 KB wasm's storage => the batch fails.
    let id = env
        .allow_registry(
            NearToken::from_millinear(100),
            json!({"owner_id": owner, "proposer_id": agent, "network_id": "sandbox"}),
        )
        .await;
    env.set_mandate(3).await;
    let avail0 = env.available().await;
    let res = env
        .deploy_as(&env.agent, &id, "poor", &env.registry_wasm)
        .await;
    // The outer tx succeeds (the promise was dispatched); the failure is in the batch receipt.
    assert!(res.is_success(), "{:?}", res.failures());
    let logs = res.logs().join("\n");
    assert!(logs.contains("\"event\":\"deployed\""));
    assert!(
        logs.contains("\"event\":\"deploy_failed\"") && logs.contains("\"reversed\":true"),
        "{logs}"
    );
    let sub: AccountId = format!("poor.{}", env.vault.id()).parse().unwrap();
    assert!(
        env.worker.view_account(&sub).await.is_err(),
        "failed batch must leave NO sub-account"
    );
    let u = env.vview("usage", json!({})).await;
    assert_eq!(
        (
            u["total_spent"].as_str().unwrap(),
            u["deploys"].as_u64().unwrap()
        ),
        ("0", 0),
        "counters reversed"
    );
    assert_eq!(
        env.vview("period_state", json!({})).await["period_spent"],
        "0",
        "period spend reversed"
    );
    assert_eq!(
        env.vview("preview_deploy", json!({"template": id, "name": "poor"}))
            .await,
        "",
        "name released"
    );
    let avail1 = env.available().await;
    assert!(
        avail1 + near(1).as_yoctonear() / 100 >= avail0,
        "deposit refunded: {avail0} -> {avail1}"
    );

    // (b) deposit is enough but `new` panics (owner_id = system): atomic rollback, deposit refunded.
    let id = env
        .allow_registry(
            near(5),
            json!({"owner_id": "system", "proposer_id": agent, "network_id": "sandbox"}),
        )
        .await;
    let res = env
        .deploy_as(&env.agent, &id, "badinit", &env.registry_wasm)
        .await;
    assert!(res.is_success(), "{:?}", res.failures());
    assert!(res
        .logs()
        .join("\n")
        .contains("\"event\":\"deploy_failed\""));
    let sub: AccountId = format!("badinit.{}", env.vault.id()).parse().unwrap();
    assert!(
        env.worker.view_account(&sub).await.is_err(),
        "failed init must roll back the account creation"
    );
    let u = env.vview("usage", json!({})).await;
    assert_eq!(
        (
            u["total_spent"].as_str().unwrap(),
            u["deploys"].as_u64().unwrap()
        ),
        ("0", 0)
    );
    let avail2 = env.available().await;
    assert!(
        avail2 + near(1).as_yoctonear() / 100 >= avail0,
        "refund: {avail0} -> {avail2}"
    );

    // (c) after the reversals the full budget is available again and a good template deploys.
    let id = env
        .allow_registry(
            near(5),
            json!({"owner_id": owner, "proposer_id": agent, "network_id": "sandbox"}),
        )
        .await;
    let res = env
        .deploy_as(&env.agent, &id, "poor", &env.registry_wasm)
        .await;
    assert!(
        res.is_success() && res.logs().join("\n").contains("deploy_confirmed"),
        "{:?}",
        res.failures()
    );
}

/// Static property of the deployed artifact: the host functions it imports and the methods it exports.
#[test]
fn vault_wasm_imports_no_key_or_account_destroying_host_functions_and_has_no_upgrade_export() {
    use wasmparser::{Parser, Payload};
    let wasm = read_wasm("VAULT_WASM", "../dist/autonear_vault.wasm");
    let (mut imports, mut exports) = (vec![], vec![]);
    for p in Parser::new(0).parse_all(&wasm) {
        match p.expect("valid wasm") {
            Payload::ImportSection(s) => {
                for i in s {
                    imports.push(i.expect("import").name.to_string());
                }
            }
            Payload::ExportSection(s) => {
                for e in s {
                    exports.push(e.expect("export").name.to_string());
                }
            }
            _ => {}
        }
    }
    for forbidden in [
        "promise_batch_action_add_key_with_full_access",
        "promise_batch_action_add_key_with_function_call",
        "promise_batch_action_delete_key",
        "promise_batch_action_delete_account",
        "promise_batch_action_stake",
        "promise_yield_create",
        "promise_create",
        "promise_then",
        "validator_stake",
    ] {
        assert!(
            !imports.iter().any(|i| i == forbidden),
            "wasm imports {forbidden}"
        );
    }
    for needed in [
        "promise_batch_action_create_account",
        "promise_batch_action_deploy_contract",
        "promise_batch_action_transfer",
    ] {
        assert!(
            imports.iter().any(|i| i == needed),
            "sanity: {needed} should be imported"
        );
    }
    let mut methods: Vec<&str> = exports
        .iter()
        .map(String::as_str)
        .filter(|e| {
            !matches!(
                *e,
                "memory" | "contract_source_metadata" | "__data_end" | "__heap_base"
            )
        })
        .collect();
    methods.sort_unstable();
    let mut want = vec![
        "new",
        "set_mandate",
        "revoke",
        "pause",
        "unpause",
        "allow_template",
        "disallow_template",
        "withdraw",
        "transfer_ownership",
        "accept_ownership",
        "deposit",
        "draw",
        "deploy",
        "on_deployed",
        "on_drawn",
        "config",
        "mandate",
        "usage",
        "template",
        "templates",
        "available",
        "period_state",
        "preview_draw",
        "preview_deploy",
    ];
    want.sort_unstable();
    assert_eq!(
        methods, want,
        "exported methods are exactly the documented API (no upgrade/migrate/call-anything)"
    );
}

/// The bound agent is a named account that deletes itself in the same receipt that calls `draw`
/// (fixture `draw_then_self_delete.wasm`, see its .wat). The vault's Transfer to the now-deleted
/// account fails in the next block, the runtime refunds the vault, and `on_drawn` must restore the budget.
#[tokio::test]
async fn draw_to_a_deleted_agent_account_is_refunded_and_the_budget_restored() {
    let env = setup().await;
    assert_eq!(
        env.vault.id().as_str(),
        "vault.test.near",
        "fixture hard-codes the vault id"
    );
    assert_eq!(
        env.owner.id().as_str(),
        "owner.test.near",
        "fixture hard-codes the beneficiary"
    );
    let root = env.worker.root_account().unwrap();
    let wallet = root
        .create_subaccount("sweeper")
        .initial_balance(near(5))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap()
        .deploy(include_bytes!("../fixtures/draw_then_self_delete.wasm"))
        .await
        .unwrap()
        .into_result()
        .unwrap();
    env.set_mandate_for(wallet.id(), 1).await;
    let avail0 = env.available().await;
    assert_eq!(
        env.vview(
            "preview_draw",
            json!({"amount": near(2).as_yoctonear().to_string()})
        )
        .await,
        ""
    );

    let res = wallet
        .call("go")
        .args_json(json!({"amount": near(2).as_yoctonear().to_string()}))
        .max_gas()
        .transact()
        .await
        .unwrap();
    let logs = res.logs().join("\n");
    assert!(
        logs.contains("\"event\":\"drawn\""),
        "the vault accepted the draw first: {logs} / {:?}",
        res.failures()
    );
    assert!(
        env.worker.view_account(wallet.id()).await.is_err(),
        "the agent account must be gone, otherwise the transfer would not fail"
    );
    assert!(
        logs.contains("\"event\":\"draw_failed\"") && logs.contains("\"reversed\":true"),
        "on_drawn must report the reversal: {logs}"
    );
    let u = env.vview("usage", json!({})).await;
    assert_eq!(u["total_spent"], "0", "total restored");
    assert_eq!(u["period_spent"], "0", "period restored");
    let ps = env.vview("period_state", json!({})).await;
    assert_eq!(ps["period_spent"], "0");
    let avail1 = env.available().await;
    let tol = near(1).as_yoctonear() / 100;
    assert!(
        avail1 + tol >= avail0,
        "the refund came back to the vault: {avail0} -> {avail1}"
    );
    assert_eq!(
        env.vview(
            "preview_draw",
            json!({"amount": near(5).as_yoctonear().to_string()})
        )
        .await,
        ""
    );
}
