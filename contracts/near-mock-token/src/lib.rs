//! AutoNEAR Mock USDC: a TESTNET-ONLY NEP-141 fungible token.
//!
//! Purpose: give the AutoNEAR mandate vault a stablecoin-shaped asset to pay out on testnet without
//! touching real money. One build serves any symbol ("USDC" now, "USDT" later): name, symbol and
//! decimals are set at `new`.
//!
//! Non-negotiables:
//! - `new` aborts unless `network_id` is exactly `testnet` or `localnet` AND the account the contract
//!   is deployed on matches that network: `testnet` requires a current account ending in `.testnet`;
//!   `localnet` requires `test.near` or an account ending in `.test.near` (the nearcore sandbox root).
//!   The `network_id` argument is only a label chosen by the initializer; the account suffix is what is
//!   actually enforced. This is a best-effort guard that keeps a labelled testnet mock from being
//!   initialised on mainnet by accident or by a casual deployer. It is NOT a security boundary for real
//!   value: nothing on-chain stops someone from deploying a different contract on mainnet, and this one
//!   must never be given real value or treated as a real stablecoin.
//! - `mint` is open to ANYONE, capped per call (10,000 whole tokens). That is the point of a faucet
//!   token; it is also why the name returned by `ft_metadata` must say so.
//! - No owner, no upgrade method, no `AddKey`/`DeleteAccount`, no arbitrary calls.
//!
//! Storage on `mint`: the contract never spends its own NEAR on a stranger's storage. Minting to an
//! account that is already registered needs no deposit (any attached deposit is refunded to the
//! caller). Minting to an unregistered account requires an attached deposit of at least
//! `storage_balance_bounds().min`; that deposit becomes the receiver's storage balance (exactly like
//! `storage_deposit`), the excess is refunded to the caller, and a deposit that is too small aborts
//! with `E_StorageDeposit`. A later `storage_unregister` by the receiver therefore refunds what was
//! paid for it, not the contract's own funds.

pub mod errors;

use errors::fail;
use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::serde_json;
use near_sdk::{
    assert_one_yocto, env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault,
};

/// Networks on which `new` may run.
pub const ALLOWED_NETWORKS: [&str; 2] = ["testnet", "localnet"];

/// Whether `account` is a legitimate home for a token labelled `network_id`.
fn account_matches_network(network_id: &str, account: &str) -> bool {
    match network_id {
        "testnet" => account.ends_with(".testnet"),
        "localnet" => account == "test.near" || account.ends_with(".test.near"),
        _ => false,
    }
}
/// Per-call mint ceiling, in whole tokens.
pub const MAX_MINT_WHOLE_TOKENS: u128 = 10_000;
/// Largest `decimals` accepted (keeps `10_000 * 10^decimals` far below `u128::MAX`).
pub const MAX_DECIMALS: u8 = 24;
pub const MAX_TEXT_BYTES: usize = 64;
/// Gas kept back by `ft_transfer_call` for itself and the resolver (same values as the standard).
const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(5);
const GAS_FOR_FT_TRANSFER_CALL: Gas = Gas::from_tgas(30);
const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Accounts,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
    network_id: String,
    max_mint: u128,
}

#[near]
impl Contract {
    /// One-time init. Aborts unless `network_id` is exactly `testnet` or `localnet`.
    #[init]
    pub fn new(name: String, symbol: String, decimals: u8, network_id: String) -> Self {
        if !ALLOWED_NETWORKS.contains(&network_id.as_str()) {
            fail(
                "E_BadNetwork",
                "this mock token only initialises on testnet or localnet",
            );
        }
        let account = env::current_account_id();
        if !account_matches_network(&network_id, account.as_str()) {
            fail(
                "E_BadNetwork",
                "network_id testnet requires a contract account ending in .testnet; network_id localnet requires test.near or an account ending in .test.near",
            );
        }
        if name.is_empty() || name.len() > MAX_TEXT_BYTES {
            fail("E_BadMetadata", "name must be 1 to 64 bytes");
        }
        if symbol.is_empty() || symbol.len() > MAX_TEXT_BYTES {
            fail("E_BadMetadata", "symbol must be 1 to 64 bytes");
        }
        if decimals > MAX_DECIMALS {
            fail("E_BadMetadata", "decimals must be at most 24");
        }
        let max_mint = MAX_MINT_WHOLE_TOKENS * 10u128.pow(u32::from(decimals));
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name,
            symbol,
            icon: None,
            reference: None,
            reference_hash: None,
            decimals,
        };
        metadata.assert_valid();
        Self {
            token: FungibleToken::new(StorageKey::Accounts),
            metadata,
            network_id,
            max_mint,
        }
    }

    /// Open faucet: anyone may mint `amount` base units to `account_id`, `0 < amount <= max_mint_per_call`.
    /// Payable only for storage: an unregistered receiver needs an attached deposit of at least
    /// `storage_balance_bounds().min` (kept as the receiver's storage balance, the excess goes back
    /// to the caller); for a registered receiver any attached deposit is refunded.
    #[payable]
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        if amount.0 == 0 {
            fail("E_BadAmount", "amount must be greater than 0");
        }
        if amount.0 > self.max_mint {
            fail(
                "E_MintCeiling",
                "amount exceeds the per-call mint ceiling of 10000 whole tokens",
            );
        }
        let attached = env::attached_deposit();
        let caller = env::predecessor_account_id();
        if self.token.accounts.contains_key(&account_id) {
            refund(&caller, attached);
        } else {
            let min_balance = self.token.storage_balance_bounds().min;
            if attached < min_balance {
                fail(
                    "E_StorageDeposit",
                    "receiver is not registered: attach at least storage_balance_bounds().min to pay its storage",
                );
            }
            self.token.internal_register_account(&account_id);
            refund(&caller, attached.saturating_sub(min_balance));
        }
        self.token.internal_deposit(&account_id, amount.0);
        FtMint {
            owner_id: &account_id,
            amount,
            memo: None,
        }
        .emit();
    }

    /// The network this token was initialised for (`testnet` or `localnet`).
    pub fn network_id(&self) -> String {
        self.network_id.clone()
    }

    /// Per-call mint ceiling in base units (10,000 whole tokens).
    pub fn max_mint_per_call(&self) -> U128 {
        U128(self.max_mint)
    }
}

// NEP-141 / NEP-145 surface. The method names, arguments and results are exactly those of the
// standard (`FungibleTokenCore`, `FungibleTokenResolver`, `StorageManagement`). The methods that send
// promises are written with raw `env::promise_batch_*` calls instead of the SDK's high-level promise
// builder, because that builder links every action kind, including the key and account-destroying
// ones, into the wasm. This way the wasm imports only the host functions it uses (checked by
// scripts/near-mock-token-build.sh).
#[near]
impl Contract {
    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    /// Standard `ft_transfer_call`: moves the funds, calls `ft_on_transfer` on the receiver, and
    /// resolves with `ft_resolve_transfer` (which refunds whatever the receiver reports as unused).
    /// The result of the whole call is the resolver's `U128` (the amount actually used).
    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) {
        assert_one_yocto();
        require!(
            env::prepaid_gas() > GAS_FOR_FT_TRANSFER_CALL,
            "More gas is required"
        );
        let sender_id = env::predecessor_account_id();
        self.token
            .internal_transfer(&sender_id, &receiver_id, amount.0, memo);
        let receiver_gas = env::prepaid_gas()
            .checked_sub(GAS_FOR_FT_TRANSFER_CALL)
            .unwrap_or_else(|| env::panic_str("Prepaid gas overflow"));
        let on_transfer_args = serde_json::to_vec(&serde_json::json!({
            "sender_id": sender_id,
            "amount": amount,
            "msg": msg,
        }))
        .unwrap_or_else(|_| env::panic_str("ft_on_transfer args"));
        let resolve_args = serde_json::to_vec(&serde_json::json!({
            "sender_id": sender_id,
            "receiver_id": receiver_id,
            "amount": amount,
        }))
        .unwrap_or_else(|_| env::panic_str("ft_resolve_transfer args"));
        let call = env::promise_batch_create(&receiver_id);
        env::promise_batch_action_function_call(
            call,
            "ft_on_transfer",
            &on_transfer_args,
            NO_DEPOSIT,
            receiver_gas,
        );
        let resolve = env::promise_batch_then(call, &env::current_account_id());
        env::promise_batch_action_function_call(
            resolve,
            "ft_resolve_transfer",
            &resolve_args,
            NO_DEPOSIT,
            GAS_FOR_RESOLVE_TRANSFER,
        );
        env::promise_return(resolve);
    }

    pub fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }

    /// Callback of `ft_transfer_call`. Returns the amount the receiver actually used.
    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used_amount, _burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used_amount.into()
    }

    /// NEP-145. Registers `account_id` (default: the caller); any excess over the minimum is
    /// refunded to the caller, and so is the whole deposit if the account is already registered.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        #[allow(unused_variables)] registration_only: Option<bool>,
    ) -> StorageBalance {
        let amount = env::attached_deposit();
        let account_id = account_id.unwrap_or_else(env::predecessor_account_id);
        if self.token.accounts.contains_key(&account_id) {
            log!("The account is already registered, refunding the deposit");
            refund(&env::predecessor_account_id(), amount);
        } else {
            let min_balance = self.token.storage_balance_bounds().min;
            if amount < min_balance {
                env::panic_str("The attached deposit is less than the minimum storage balance");
            }
            self.token.internal_register_account(&account_id);
            refund(
                &env::predecessor_account_id(),
                amount.saturating_sub(min_balance),
            );
        }
        self.token
            .storage_balance_of(account_id)
            .unwrap_or_else(|| env::panic_str("unreachable"))
    }

    /// NEP-145. Registration costs a fixed amount (min == max), so nothing is ever withdrawable.
    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    /// NEP-145. Unregisters the caller and refunds the storage minimum (+1 yocto). Refuses a non-zero
    /// balance unless `force`, in which case the balance is burned.
    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let account_id = env::predecessor_account_id();
        let force = force.unwrap_or(false);
        let Some(balance) = self.token.accounts.get(&account_id) else {
            log!("The account {} is not registered", &account_id);
            return false;
        };
        if balance != 0 && !force {
            env::panic_str("Can't unregister the account with the positive balance without force");
        }
        self.token.accounts.remove(&account_id);
        self.token.total_supply -= balance;
        refund(
            &account_id,
            self.token
                .storage_balance_bounds()
                .min
                .saturating_add(NearToken::from_yoctonear(1)),
        );
        true
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

/// One `Transfer` action to `to` (no-op for zero).
fn refund(to: &AccountId, amount: NearToken) {
    if amount.as_yoctonear() > 0 {
        let p = env::promise_batch_create(to);
        env::promise_batch_action_transfer(p, amount);
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests;
