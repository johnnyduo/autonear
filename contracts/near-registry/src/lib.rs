//! AutoNEAR Proposal Registry v1 (NEAR implementation).
//!
//! An attestation registry: it binds an off-chain, policy-bound proposal to an
//! owner-approved on-chain record. It never holds funds and makes NO external
//! calls (no `Promise`, no cross-contract calls, no callbacks), so there is no
//! reentrancy surface. See README.md and docs/contracts-spec.md.

pub mod events;
pub mod id;

use events::Event;
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

/// Maximum proposal lifetime: 30 days in nanoseconds.
pub const MAX_TTL_NS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;
/// Default `max_spend` cap: 100 NEAR in yoctoNEAR.
pub const DEFAULT_MAX_SPEND_CAP: u128 = 100_000_000_000_000_000_000_000_000;
pub const MAX_METHOD_LEN: usize = 128;
pub const MAX_NETWORK_ID_LEN: usize = 32;
pub const MAX_RECEIPT_REF_LEN: usize = 256;
pub const DEFAULT_PAGE: u64 = 50;
pub const MAX_PAGE: u64 = 100;
/// Layout version of the persisted state; bump together with `migrate()`.
pub const STATE_VERSION: u32 = 1;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Allowlist,
    Proposals,
    Ids,
}

/// Persisted status. "Expired" is derived and never stored.
#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Pending,
    Approved,
    Executed,
    Cancelled,
}

/// Status as reported by views: stored status plus derived `Expired`.
#[near(serializers=[json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StatusView {
    Pending,
    Approved,
    Executed,
    Cancelled,
    Expired,
}

#[near(serializers=[borsh])]
#[derive(Clone, Debug)]
struct Proposal {
    proposer: AccountId,
    target: AccountId,
    method: String,
    max_spend: u128,
    expiry: u64,
    nonce: u64,
    artifact_hash: [u8; 32],
    status: Status,
    created_at: u64,
    approved_at: Option<u64>,
    executed_at: Option<u64>,
    spent: Option<u128>,
    receipt_ref: Option<String>,
}

#[near(serializers=[json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProposalView {
    pub id: String,
    pub proposer: AccountId,
    pub target: AccountId,
    pub method: String,
    pub max_spend: U128,
    /// Expiry, nanoseconds since the unix epoch (same unit as block timestamp).
    pub expiry: U64,
    pub nonce: U64,
    pub artifact_hash: String,
    /// Derived: reports `Expired` when `now > expiry` and not terminal.
    pub status: StatusView,
    pub created_at: U64,
    pub approved_at: Option<U64>,
    pub executed_at: Option<U64>,
    pub spent: Option<U128>,
    pub receipt_ref: Option<String>,
}

#[near(serializers=[json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigView {
    pub owner_id: AccountId,
    pub pending_owner: Option<AccountId>,
    pub proposer_id: AccountId,
    pub paused: bool,
    pub network_id: String,
    pub registry_id: AccountId,
    pub next_nonce: U64,
    pub max_spend_cap: U128,
    pub max_ttl_ns: U64,
    pub state_version: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    state_version: u32,
    owner_id: AccountId,
    pending_owner: Option<AccountId>,
    proposer_id: AccountId,
    paused: bool,
    network_id: String,
    next_nonce: u64,
    max_spend_cap: u128,
    allowlist: LookupSet<(AccountId, String)>,
    proposals: LookupMap<[u8; 32], Proposal>,
    /// `ids[n]` is the id of the proposal with nonce `n` (nonces are contiguous from 0).
    ids: Vector<[u8; 32]>,
}

fn validate_method(method: &str) {
    require!(
        !method.is_empty()
            && method.len() <= MAX_METHOD_LEN
            && method
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_'),
        "invalid method"
    );
}

/// Rejects the NEAR analogues of the zero address (`system` and the all-zero
/// implicit account) and the registry's own account (which holds no key).
fn validate_principal(account: &AccountId) {
    let s = account.as_str();
    require!(
        s != "system" && s != "0".repeat(64) && *account != env::current_account_id(),
        "invalid account"
    );
}

fn parse_hash(hex: &str) -> [u8; 32] {
    id::parse_hex32(hex).unwrap_or_else(|| env::panic_str("invalid hex32"))
}

#[near]
impl Registry {
    #[init]
    pub fn new(
        owner_id: AccountId,
        proposer_id: AccountId,
        network_id: String,
        max_spend_cap: Option<U128>,
    ) -> Self {
        require!(!env::state_exists(), "already initialized");
        require!(
            !network_id.is_empty() && network_id.len() <= MAX_NETWORK_ID_LEN,
            "invalid network_id"
        );
        validate_principal(&owner_id);
        validate_principal(&proposer_id);
        let cap = max_spend_cap.map_or(DEFAULT_MAX_SPEND_CAP, |c| c.0);
        require!(cap > 0, "cap must be > 0");
        Event::Initialized {
            owner_id: owner_id.clone(),
            proposer_id: proposer_id.clone(),
            network_id: network_id.clone(),
            max_spend_cap: U128(cap),
        }
        .emit();
        Self {
            state_version: STATE_VERSION,
            owner_id,
            pending_owner: None,
            proposer_id,
            paused: false,
            network_id,
            next_nonce: 0,
            max_spend_cap: cap,
            allowlist: LookupSet::new(StorageKey::Allowlist),
            proposals: LookupMap::new(StorageKey::Proposals),
            ids: Vector::new(StorageKey::Ids),
        }
    }

    /// Upgrade hook: call right after redeploying code (`with-init-call migrate`).
    /// v1 -> v1 is a no-op reload; a future version reads the old layout here.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let state: Self =
            env::state_read().unwrap_or_else(|| env::panic_str("no state to migrate"));
        require!(
            state.state_version == STATE_VERSION,
            "unsupported state version"
        );
        Event::Migrated {
            from_version: state.state_version,
            to_version: STATE_VERSION,
        }
        .emit();
        state
    }

    // ---------------------------------------------------------------- proposals

    /// Creates a Pending proposal and returns its id (64 lowercase hex chars).
    pub fn propose(
        &mut self,
        target: AccountId,
        method: String,
        max_spend: U128,
        expiry: U64,
        nonce: U64,
        artifact_hash: String,
    ) -> String {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.proposer_id || caller == self.owner_id,
            "only proposer or owner"
        );
        self.assert_not_paused();
        validate_method(&method);
        let hash = parse_hash(&artifact_hash);
        require!(
            self.allowlist.contains(&(target.clone(), method.clone())),
            "target/method not allowlisted"
        );
        let now = env::block_timestamp();
        require!(expiry.0 > now, "expiry must be in the future");
        require!(
            expiry.0 <= now.saturating_add(MAX_TTL_NS),
            "expiry exceeds max ttl"
        );
        require!(max_spend.0 > 0, "max_spend must be > 0");
        require!(max_spend.0 <= self.max_spend_cap, "max_spend exceeds cap");
        require!(nonce.0 == self.next_nonce, "bad nonce");
        let pid = self.id_for(&target, &method, max_spend.0, expiry.0, nonce.0, &hash);
        require!(
            !self.proposals.contains_key(&pid),
            "proposal id already exists"
        );

        self.next_nonce += 1;
        self.ids.push(pid);
        self.proposals.insert(
            pid,
            Proposal {
                proposer: caller.clone(),
                target: target.clone(),
                method: method.clone(),
                max_spend: max_spend.0,
                expiry: expiry.0,
                nonce: nonce.0,
                artifact_hash: hash,
                status: Status::Pending,
                created_at: now,
                approved_at: None,
                executed_at: None,
                spent: None,
                receipt_ref: None,
            },
        );
        let id_hex = id::to_hex(&pid);
        Event::Proposed {
            id: id_hex.clone(),
            proposer: caller,
            target,
            method,
            max_spend,
            expiry,
            nonce,
            artifact_hash,
        }
        .emit();
        id_hex
    }

    /// Owner approves a Pending, unexpired proposal. Re-checks the allowlist.
    pub fn approve(&mut self, id: String) {
        let caller = self.assert_owner();
        self.assert_not_paused();
        let key = parse_hash(&id);
        let (target, method) = {
            let p = self.live(&key);
            require!(p.status == Status::Pending, "not pending");
            (p.target.clone(), p.method.clone())
        };
        require!(
            self.allowlist.contains(&(target, method)),
            "target/method not allowlisted"
        );
        let now = env::block_timestamp();
        let p = self.proposals.get_mut(&key).unwrap_or_else(|| env::abort());
        p.status = Status::Approved;
        p.approved_at = Some(now);
        Event::Approved { id, by: caller }.emit();
    }

    /// Owner records an out-of-band execution of an Approved, unexpired proposal.
    pub fn mark_executed(&mut self, id: String, spent: U128, receipt_ref: String) {
        let caller = self.assert_owner();
        self.assert_not_paused();
        let key = parse_hash(&id);
        require!(
            !receipt_ref.is_empty() && receipt_ref.len() <= MAX_RECEIPT_REF_LEN,
            "invalid receipt_ref"
        );
        let max_spend = {
            let p = self.live(&key);
            require!(p.status == Status::Approved, "not approved");
            p.max_spend
        };
        require!(spent.0 <= max_spend, "spent exceeds max_spend");
        let now = env::block_timestamp();
        let p = self.proposals.get_mut(&key).unwrap_or_else(|| env::abort());
        p.status = Status::Executed;
        p.executed_at = Some(now);
        p.spent = Some(spent.0);
        p.receipt_ref = Some(receipt_ref.clone());
        Event::Executed {
            id,
            by: caller,
            spent,
            receipt_ref,
        }
        .emit();
    }

    /// Owner: Pending or Approved. Proposer: own Pending only. Works while paused.
    /// Expired proposals cannot be mutated (they are already inert).
    pub fn cancel(&mut self, id: String) {
        let caller = env::predecessor_account_id();
        let key = parse_hash(&id);
        {
            let p = self.live(&key);
            if caller == self.owner_id {
                require!(
                    matches!(p.status, Status::Pending | Status::Approved),
                    "not cancellable"
                );
            } else {
                require!(
                    caller == self.proposer_id && caller == p.proposer,
                    "not authorized to cancel"
                );
                require!(
                    p.status == Status::Pending,
                    "proposer may cancel only pending"
                );
            }
        }
        let p = self.proposals.get_mut(&key).unwrap_or_else(|| env::abort());
        p.status = Status::Cancelled;
        Event::Cancelled { id, by: caller }.emit();
    }

    // --------------------------------------------------------------- admin

    pub fn pause(&mut self) {
        let by = self.assert_owner();
        require!(!self.paused, "already paused");
        self.paused = true;
        Event::Paused { by }.emit();
    }

    pub fn unpause(&mut self) {
        let by = self.assert_owner();
        require!(self.paused, "not paused");
        self.paused = false;
        Event::Unpaused { by }.emit();
    }

    pub fn allowlist_add(&mut self, target: AccountId, method: String) {
        let by = self.assert_owner();
        validate_method(&method);
        require!(
            self.allowlist.insert((target.clone(), method.clone())),
            "already allowlisted"
        );
        Event::AllowlistAdded { target, method, by }.emit();
    }

    pub fn allowlist_remove(&mut self, target: AccountId, method: String) {
        let by = self.assert_owner();
        require!(
            self.allowlist.remove(&(target.clone(), method.clone())),
            "not allowlisted"
        );
        Event::AllowlistRemoved { target, method, by }.emit();
    }

    pub fn set_proposer(&mut self, proposer_id: AccountId) {
        let by = self.assert_owner();
        validate_principal(&proposer_id);
        let old = std::mem::replace(&mut self.proposer_id, proposer_id.clone());
        Event::ProposerSet {
            old,
            new: proposer_id,
            by,
        }
        .emit();
    }

    pub fn set_max_spend_cap(&mut self, cap: U128) {
        let by = self.assert_owner();
        require!(cap.0 > 0, "cap must be > 0");
        let old = std::mem::replace(&mut self.max_spend_cap, cap.0);
        Event::MaxSpendCapSet {
            old: U128(old),
            new: cap,
            by,
        }
        .emit();
    }

    /// Step 1 of two-step ownership transfer.
    pub fn transfer_ownership(&mut self, new_owner: AccountId) {
        let owner = self.assert_owner();
        require!(new_owner != owner, "new owner is current owner");
        validate_principal(&new_owner);
        self.pending_owner = Some(new_owner.clone());
        Event::OwnershipTransferStarted {
            owner,
            pending: new_owner,
        }
        .emit();
    }

    /// Step 2: must be called by the pending owner.
    pub fn accept_ownership(&mut self) {
        let caller = env::predecessor_account_id();
        let pending = self
            .pending_owner
            .clone()
            .unwrap_or_else(|| env::panic_str("no pending owner"));
        require!(caller == pending, "only pending owner");
        let old = std::mem::replace(&mut self.owner_id, caller.clone());
        self.pending_owner = None;
        Event::OwnershipTransferred { old, new: caller }.emit();
    }

    // --------------------------------------------------------------- views

    pub fn get_proposal(&self, id: String) -> Option<ProposalView> {
        let key = id::parse_hex32(&id)?;
        self.proposals.get(&key).map(|p| self.view_of(&key, p))
    }

    /// Status including derived `Expired`; `None` for an unknown id.
    pub fn status_of(&self, id: String) -> Option<StatusView> {
        let key = id::parse_hex32(&id)?;
        self.proposals.get(&key).map(|p| self.derive_status(p))
    }

    /// Proposals in creation (nonce) order. `limit` defaults to 50, capped at 100.
    pub fn list(&self, from_index: Option<U64>, limit: Option<U64>) -> Vec<ProposalView> {
        let from = from_index.map_or(0, |v| v.0);
        let limit = limit.map_or(DEFAULT_PAGE, |v| v.0).min(MAX_PAGE);
        let total = u64::from(self.ids.len());
        let end = from.saturating_add(limit).min(total);
        (from..end)
            .filter_map(|i| {
                let key = self.ids.get(u32::try_from(i).ok()?)?;
                self.proposals.get(key).map(|p| self.view_of(key, p))
            })
            .collect()
    }

    pub fn proposals_count(&self) -> U64 {
        U64(u64::from(self.ids.len()))
    }

    pub fn is_allowed(&self, target: AccountId, method: String) -> bool {
        self.allowlist.contains(&(target, method))
    }

    pub fn config(&self) -> ConfigView {
        ConfigView {
            owner_id: self.owner_id.clone(),
            pending_owner: self.pending_owner.clone(),
            proposer_id: self.proposer_id.clone(),
            paused: self.paused,
            network_id: self.network_id.clone(),
            registry_id: env::current_account_id(),
            next_nonce: U64(self.next_nonce),
            max_spend_cap: U128(self.max_spend_cap),
            max_ttl_ns: U64(MAX_TTL_NS),
            state_version: self.state_version,
        }
    }

    /// Computes the id the contract would assign to these fields (hex).
    pub fn compute_proposal_id(
        &self,
        target: AccountId,
        method: String,
        max_spend: U128,
        expiry: U64,
        nonce: U64,
        artifact_hash: String,
    ) -> String {
        let hash = parse_hash(&artifact_hash);
        id::to_hex(&self.id_for(&target, &method, max_spend.0, expiry.0, nonce.0, &hash))
    }
}

impl Registry {
    fn assert_owner(&self) -> AccountId {
        let caller = env::predecessor_account_id();
        require!(caller == self.owner_id, "only owner");
        caller
    }

    fn assert_not_paused(&self) {
        require!(!self.paused, "paused");
    }

    fn id_for(
        &self,
        target: &AccountId,
        method: &str,
        max_spend: u128,
        expiry: u64,
        nonce: u64,
        hash: &[u8; 32],
    ) -> [u8; 32] {
        id::compute_id(
            &self.network_id,
            env::current_account_id().as_str(),
            target.as_str(),
            method,
            max_spend,
            expiry,
            nonce,
            hash,
        )
    }

    fn is_expired(p: &Proposal) -> bool {
        env::block_timestamp() > p.expiry
    }

    /// Loads a proposal for mutation: must exist and must not be expired.
    fn live(&self, key: &[u8; 32]) -> &Proposal {
        let p = self
            .proposals
            .get(key)
            .unwrap_or_else(|| env::panic_str("unknown proposal"));
        require!(
            !(matches!(p.status, Status::Pending | Status::Approved) && Self::is_expired(p)),
            "proposal expired"
        );
        p
    }

    fn derive_status(&self, p: &Proposal) -> StatusView {
        match p.status {
            Status::Pending | Status::Approved if Self::is_expired(p) => StatusView::Expired,
            Status::Pending => StatusView::Pending,
            Status::Approved => StatusView::Approved,
            Status::Executed => StatusView::Executed,
            Status::Cancelled => StatusView::Cancelled,
        }
    }

    fn view_of(&self, key: &[u8; 32], p: &Proposal) -> ProposalView {
        ProposalView {
            id: id::to_hex(key),
            proposer: p.proposer.clone(),
            target: p.target.clone(),
            method: p.method.clone(),
            max_spend: U128(p.max_spend),
            expiry: U64(p.expiry),
            nonce: U64(p.nonce),
            artifact_hash: id::to_hex(&p.artifact_hash),
            status: self.derive_status(p),
            created_at: U64(p.created_at),
            approved_at: p.approved_at.map(U64),
            executed_at: p.executed_at.map(U64),
            spent: p.spent.map(U128),
            receipt_ref: p.receipt_ref.clone(),
        }
    }
}

#[cfg(test)]
mod tests;
