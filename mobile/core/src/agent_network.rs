//! Reuse the exact desktop TLS channel and JOSE verifier with a native account port.
#![allow(dead_code)]
pub(crate) mod crypto {
    pub use myagents_agent_network_crypto::*;
}
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct NetworkError {
    pub code: String,
}
impl NetworkError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self { code: code.into() }
    }
    pub(crate) fn cloud(code: &str, _status: u16) -> Self {
        let safe = !code.is_empty()
            && code.len() <= 128
            && code
                .bytes()
                .all(|v| v.is_ascii_uppercase() || v.is_ascii_digit() || v == b'_');
        Self {
            code: if safe {
                code.into()
            } else {
                "NATIVE_TRUST_UNAVAILABLE".into()
            },
        }
    }
}
impl From<crypto::CryptoError> for NetworkError {
    fn from(value: crypto::CryptoError) -> Self {
        Self {
            code: value.to_string(),
        }
    }
}
pub(crate) mod account {
    use super::NetworkError;
    use crate::space_cloud::agent_network::AccountOperation;
    use serde_json::Value;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    #[derive(Clone)]
    pub(crate) struct NetworkAccountSession {
        pub issuer: String,
        pub service_id: String,
        pub environment: String,
        pub principal_id: String,
        pub expires_at: u64,
        pub current: Arc<AtomicBool>,
        // Native fetches this from the configured issuer using platform HTTPS trust.
        // A new JWKS snapshot requires a new native auth epoch, never JS input.
        pub jwks: Value,
    }
    impl NetworkAccountSession {
        pub(crate) fn ensure_current(&self) -> Result<(), NetworkError> {
            if !self.current.load(Ordering::Acquire)
                || jsonwebtoken::get_current_timestamp() >= self.expires_at
            {
                Err(NetworkError::new("MOBILE_AUTHORIZATION_REQUIRED"))
            } else {
                Ok(())
            }
        }
        pub(crate) fn issuer(&self) -> &str {
            &self.issuer
        }
        pub(crate) fn service_id(&self) -> Result<&str, NetworkError> {
            self.ensure_current()?;
            Ok(&self.service_id)
        }
        pub(crate) fn principal_id(&self) -> Result<&str, NetworkError> {
            self.ensure_current()?;
            Ok(&self.principal_id)
        }
        pub(crate) fn environment(&self) -> &str {
            &self.environment
        }
        pub(crate) async fn request(
            &self,
            _operation: AccountOperation,
            _body: Option<Value>,
        ) -> Result<Value, NetworkError> {
            self.ensure_current()?;
            Ok(self.jwks.clone())
        }
    }
}
// Preserve the original published constructor signatures, as headless-network does.
#[allow(clippy::too_many_arguments)]
#[path = "../../../src-tauri/src/agent_network/channel.rs"]
pub(crate) mod channel;
#[path = "../../../src-tauri/src/agent_network/jwt.rs"]
pub(crate) mod jwt;
