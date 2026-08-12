//! The rulings an in-place update has to make before it replaces anything:
//! which version is newer, where the reversibility copy goes, and whether
//! restarting now would end an agent nobody agreed to end.
//!
//!     cargo test --test update -- --nocapture

#[path = "../src/store.rs"]
mod store;
#[path = "../src/update.rs"]
mod update;
