;; Test fixture (NOT a product artifact): a smart-wallet-like "agent" whose single method `go`
;;   1. forwards its raw input (e.g. {"amount":"1000"}) as `draw` to vault.test.near, and
;;   2. deletes its OWN account in the same receipt (beneficiary owner.test.near).
;; Both child receipts run in the next block; the vault's Transfer back to this (now deleted,
;; named) account therefore fails one block later, which exercises the vault's `on_drawn` callback.
;; Hard-coded ids: vault.test.near / owner.test.near (the sandbox root account is test.near).
;; Build: wasm-tools parse draw_then_self_delete.wat -o draw_then_self_delete.wasm
(module
  (import "env" "input" (func $input (param i64)))
  (import "env" "register_len" (func $register_len (param i64) (result i64)))
  (import "env" "read_register" (func $read_register (param i64 i64)))
  (import "env" "current_account_id" (func $current_account_id (param i64)))
  (import "env" "promise_batch_create" (func $batch_create (param i64 i64) (result i64)))
  (import "env" "promise_batch_action_function_call"
    (func $function_call (param i64 i64 i64 i64 i64 i64 i64)))
  (import "env" "promise_batch_action_delete_account" (func $delete_account (param i64 i64 i64)))
  (memory (export "memory") 1)
  (data (i32.const 0) "vault.test.near")   ;; 15 bytes
  (data (i32.const 16) "draw")             ;; 4 bytes
  (data (i32.const 32) "owner.test.near")  ;; 15 bytes (beneficiary)
  ;; 64..80: 16 zero bytes = attached deposit 0
  (func (export "go")
    (local $p i64) (local $n i64)
    (call $input (i64.const 0))
    (local.set $n (call $register_len (i64.const 0)))
    (call $read_register (i64.const 0) (i64.const 128))
    (local.set $p (call $batch_create (i64.const 15) (i64.const 0)))
    (call $function_call (local.get $p) (i64.const 4) (i64.const 16)
      (local.get $n) (i64.const 128) (i64.const 64) (i64.const 100000000000000))
    (call $current_account_id (i64.const 1))
    (local.set $n (call $register_len (i64.const 1)))
    (call $read_register (i64.const 1) (i64.const 512))
    (local.set $p (call $batch_create (local.get $n) (i64.const 512)))
    (call $delete_account (local.get $p) (i64.const 15) (i64.const 32))))
