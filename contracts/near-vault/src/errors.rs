//! Error codes (identical to docs/agent-vault-spec.md and contracts/vault-conformance.json).
//!
//! Every revert caused by a vault rule panics with `E_<Code>: <detail>`. The code is the part
//! between `E_` and the first `:`; `detail` is human text and not part of the interface.

use near_sdk::env;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Code {
    Unauthorized,
    Paused,
    NoMandate,
    MandateInactive,
    BadMandate,
    BadAmount,
    PerDrawCap,
    PeriodCap,
    TotalCap,
    InsufficientBalance,
    DeployLimit,
    TemplateNotAllowed,
    CodeMismatch,
    AddressTaken,
    BadName,
    BadTemplate,
    BadOwner,
}

impl Code {
    /// Every code, in spec order.
    pub const ALL: [Code; 17] = [
        Code::Unauthorized,
        Code::Paused,
        Code::NoMandate,
        Code::MandateInactive,
        Code::BadMandate,
        Code::BadAmount,
        Code::PerDrawCap,
        Code::PeriodCap,
        Code::TotalCap,
        Code::InsufficientBalance,
        Code::DeployLimit,
        Code::TemplateNotAllowed,
        Code::CodeMismatch,
        Code::AddressTaken,
        Code::BadName,
        Code::BadTemplate,
        Code::BadOwner,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Code::Unauthorized => "Unauthorized",
            Code::Paused => "Paused",
            Code::NoMandate => "NoMandate",
            Code::MandateInactive => "MandateInactive",
            Code::BadMandate => "BadMandate",
            Code::BadAmount => "BadAmount",
            Code::PerDrawCap => "PerDrawCap",
            Code::PeriodCap => "PeriodCap",
            Code::TotalCap => "TotalCap",
            Code::InsufficientBalance => "InsufficientBalance",
            Code::DeployLimit => "DeployLimit",
            Code::TemplateNotAllowed => "TemplateNotAllowed",
            Code::CodeMismatch => "CodeMismatch",
            Code::AddressTaken => "AddressTaken",
            Code::BadName => "BadName",
            Code::BadTemplate => "BadTemplate",
            Code::BadOwner => "BadOwner",
        }
    }
}

/// A rule violation: the spec code plus a short human detail.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Fail {
    pub code: Code,
    pub detail: &'static str,
}

pub fn fail(code: Code, detail: &'static str) -> Fail {
    Fail { code, detail }
}

impl Fail {
    /// Reverts the current call with `E_<Code>: <detail>`.
    pub fn abort(self) -> ! {
        env::panic_str(&format!("E_{}: {}", self.code.as_str(), self.detail))
    }
}

/// Unwraps a rule check or reverts with its `E_<Code>` message.
pub fn or_abort<T>(r: Result<T, Fail>) -> T {
    match r {
        Ok(v) => v,
        Err(f) => f.abort(),
    }
}
