# Mobile crypto adapter

This crate compiles the original `src-tauri/agent-network-crypto/src/lib.rs` as a Rust module and re-exports its types. It adds only bounded PKCS8 restore/borrow methods for the native Keychain/Keystore owner. It does not duplicate cryptography or add a key serialization or file-store fallback.

Both mobile core and connection depend on this package under the same dependency alias, so their crypto types share one owner. Desktop and headless continue to use their existing packages. The frozen signed desktop reader and its complete source digest stay unchanged; do not update release pins to accommodate mobile changes.

Native source provenance includes this adapter and the original crypto source. Android/iOS native libraries must be rebuilt after adapter changes.
