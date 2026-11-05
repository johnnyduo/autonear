//! NEP-297 events. Every mutation emits exactly one event:
//! `EVENT_JSON:{"standard":"autonear_registry","version":"1.0.0","event":"<name>","data":{...}}`
//! u64/u128 values are JSON strings (decimal), timestamps are nanoseconds.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

#[near(event_json(standard = "autonear_registry"))]
pub enum Event {
    #[event_version("1.0.0")]
    Initialized {
        owner_id: AccountId,
        proposer_id: AccountId,
        network_id: String,
        max_spend_cap: U128,
    },
    #[event_version("1.0.0")]
    Proposed {
        id: String,
        proposer: AccountId,
        target: AccountId,
        method: String,
        max_spend: U128,
        expiry: U64,
        nonce: U64,
        artifact_hash: String,
    },
    #[event_version("1.0.0")]
    Approved { id: String, by: AccountId },
    #[event_version("1.0.0")]
    Executed {
        id: String,
        by: AccountId,
        spent: U128,
        receipt_ref: String,
    },
    #[event_version("1.0.0")]
    Cancelled { id: String, by: AccountId },
    #[event_version("1.0.0")]
    Paused { by: AccountId },
    #[event_version("1.0.0")]
    Unpaused { by: AccountId },
    #[event_version("1.0.0")]
    AllowlistAdded {
        target: AccountId,
        method: String,
        by: AccountId,
    },
    #[event_version("1.0.0")]
    AllowlistRemoved {
        target: AccountId,
        method: String,
        by: AccountId,
    },
    #[event_version("1.0.0")]
    ProposerSet {
        old: AccountId,
        new: AccountId,
        by: AccountId,
    },
    #[event_version("1.0.0")]
    MaxSpendCapSet { old: U128, new: U128, by: AccountId },
    #[event_version("1.0.0")]
    OwnershipTransferStarted {
        owner: AccountId,
        pending: AccountId,
    },
    #[event_version("1.0.0")]
    OwnershipTransferred { old: AccountId, new: AccountId },
    #[event_version("1.0.0")]
    Migrated { from_version: u32, to_version: u32 },
}
