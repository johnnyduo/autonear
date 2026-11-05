//! NEP-297 events. Every state mutation emits exactly one event (an idempotent no-op such as a
//! repeated `revoke` emits none):
//! `EVENT_JSON:{"standard":"autonear_vault","version":"1.0.0","event":"<name>","data":{...}}`
//! `data` is an object; u64/u128 values are decimal JSON strings; times are seconds.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::Value;
use near_sdk::{near, AccountId};

#[near(event_json(standard = "autonear_vault"))]
pub enum Event {
    #[event_version("1.0.0")]
    Initialized {
        owner: AccountId,
        network_id: String,
    },
    #[event_version("1.0.0")]
    MandateSet {
        agent: AccountId,
        epoch: U64,
        start: U64,
        expires_at: U64,
        per_draw_cap: U128,
        period_secs: U64,
        period_cap: U128,
        total_cap: U128,
        max_deploys: u32,
        by: AccountId,
    },
    #[event_version("1.0.0")]
    MandateRevoked {
        agent: AccountId,
        epoch: U64,
        by: AccountId,
    },
    #[event_version("1.0.0")]
    Paused { by: AccountId },
    #[event_version("1.0.0")]
    Unpaused { by: AccountId },
    #[event_version("1.0.0")]
    TemplateAllowed {
        template: String,
        label: String,
        deposit: U128,
        init_gas: U64,
        init_args: Value,
        updated: bool,
        by: AccountId,
    },
    #[event_version("1.0.0")]
    TemplateDisallowed { template: String, by: AccountId },
    #[event_version("1.0.0")]
    Drawn {
        agent: AccountId,
        amount: U128,
        epoch: U64,
        total_spent: U128,
        period_spent: U128,
    },
    /// The deploy batch was dispatched and its deposit charged to the budget (optimistic).
    /// Confirmation is `DeployConfirmed`; failure is `DeployFailed`.
    #[event_version("1.0.0")]
    Deployed {
        agent: AccountId,
        template: String,
        name: String,
        target: AccountId,
        deposit: U128,
        epoch: U64,
        deploys: u32,
        total_spent: U128,
        period_spent: U128,
    },
    #[event_version("1.0.0")]
    DeployConfirmed {
        template: String,
        name: String,
        target: AccountId,
    },
    /// The batch failed: charge reversed (`reversed = true`) unless the mandate epoch changed meanwhile.
    #[event_version("1.0.0")]
    DeployFailed {
        template: String,
        name: String,
        target: AccountId,
        deposit: U128,
        epoch: U64,
        reversed: bool,
    },
    /// The transfer of a `draw` failed (refunded to the vault): charge reversed unless the epoch changed.
    #[event_version("1.0.0")]
    DrawFailed {
        agent: AccountId,
        amount: U128,
        epoch: U64,
        reversed: bool,
    },
    #[event_version("1.0.0")]
    Withdrawn { to: AccountId, amount: U128 },
    #[event_version("1.0.0")]
    Deposited { from: AccountId, amount: U128 },
    #[event_version("1.0.0")]
    OwnershipTransferStarted {
        owner: AccountId,
        pending: AccountId,
    },
    #[event_version("1.0.0")]
    OwnershipTransferred { old: AccountId, new: AccountId },
}
