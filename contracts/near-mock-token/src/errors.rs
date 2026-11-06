//! Error codes. Every revert caused by a rule of this contract panics with `E_<Code>: <detail>`.
//! (Reverts inside the NEP-141 standard library keep the standard library's own messages.)

use near_sdk::env;

pub fn fail(code: &str, detail: &str) -> ! {
    env::panic_str(&format!("{code}: {detail}"))
}
