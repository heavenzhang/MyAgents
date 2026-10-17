//! Original audited AgentNet modules. Mobile supplies lifecycle and OS storage only.
#[path = "../../../../src-tauri/src/agent_network/account.rs"]
pub(crate) mod account;
#[path = "../../../../src-tauri/src/agent_network/account_operation.rs"]
pub(crate) mod account_operation;
#[path = "../../../../src-tauri/src/agent_network/community.rs"]
pub(crate) mod community;
#[path = "../../../../src-tauri/src/agent_network/connection.rs"]
pub(crate) mod connection;
#[path = "../../../../src-tauri/src/agent_network/feedback.rs"]
pub(crate) mod feedback;
#[path = "../../../../src-tauri/src/agent_network/identity.rs"]
pub(crate) mod identity;
#[path = "../../../../src-tauri/src/agent_network/jwt.rs"]
pub(crate) mod jwt;
#[path = "../../../../src-tauri/src/agent_network/memory.rs"]
pub(crate) mod memory;
#[path = "../../../../src-tauri/src/agent_network/owned_admission.rs"]
pub(crate) mod owned_admission;
// Preserve original fixed HTTP contract signature.
#[allow(clippy::too_many_arguments)]
#[path = "../../../../src-tauri/src/agent_network/owned_login.rs"]
pub(crate) mod owned_login;
#[path = "../../../../src-tauri/src/agent_network/owned_profile.rs"]
pub(crate) mod owned_profile;
#[path = "../../../../src-tauri/src/agent_network/policy.rs"]
pub(crate) mod policy;
#[path = "../../../../src-tauri/src/agent_network/reconnect.rs"]
pub(crate) mod reconnect;
#[path = "../../../../src-tauri/src/agent_network/transport.rs"]
pub(crate) mod transport;
pub(crate) mod crypto {
    pub use myagents_agent_network_crypto::*;
}
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct NetworkError {
    pub code: String,
    pub retryable: bool,
    pub details: Option<serde_json::Value>,
    #[serde(skip)]
    pub retry_after: Option<std::time::Duration>,
}
impl NetworkError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self {
            code: code.into(),
            retryable: false,
            details: None,
            retry_after: None,
        }
    }
    pub(crate) fn cloud(code: &str, status: u16) -> Self {
        let safe = !code.is_empty()
            && code.len() <= 128
            && code
                .bytes()
                .all(|v| v.is_ascii_uppercase() || v.is_ascii_digit() || v == b'_');
        Self {
            code: if safe {
                code.into()
            } else {
                "NETWORK_ACCOUNT_UNAVAILABLE".into()
            },
            retryable: status == 429 || status >= 500,
            details: None,
            retry_after: None,
        }
    }
}
impl From<crypto::CryptoError> for NetworkError {
    fn from(e: crypto::CryptoError) -> Self {
        Self::cloud(&e.to_string(), 400)
    }
}
impl std::fmt::Display for NetworkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.code)
    }
}
impl std::error::Error for NetworkError {}
