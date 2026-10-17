//! Native mobile account, identity and authenticated relay owner.
#![allow(dead_code)] // Shared original modules include desktop-only operations.
mod agent_network;
mod ffi;
mod runtime;
pub use ffi::*;
pub use myagents_agent_network_crypto::{CryptoError, DevicePrivateKey, IdentityStore, KeyScope};
pub use runtime::{MobileConnection, NativeConfig, SecureStore};
#[path = "../../../src-tauri/src/keyed_lifecycle.rs"]
mod keyed_lifecycle;
#[cfg(test)]
#[path = "../../../src-tauri/src/local_http.rs"]
mod local_http;
#[path = "../../../src-tauri/src/network_diagnostics.rs"]
mod network_diagnostics;
mod proxy_config {
    pub fn build_client_with_proxy(
        builder: reqwest::ClientBuilder,
    ) -> Result<reqwest::Client, reqwest::Error> {
        builder.build()
    }
}
#[macro_export]
macro_rules! ulog_warn { ($message:ident; request_id = $id:ident) => { eprintln!("{} requestId={}", $message, $id) }; ($($args:tt)*) => { eprintln!($($args)*) }; }
#[macro_export]
macro_rules! ulog_info { ($($args:tt)*) => { eprintln!($($args)*) }; }
mod device_identity {
    #[derive(Clone)]
    pub struct DeviceIdentity {
        pub device_id: String,
        pub device_name: Option<String>,
        pub platform: String,
        pub os_version: Option<String>,
        pub app_version: String,
    }
    pub fn current_device_identity() -> Result<DeviceIdentity, ()> {
        Ok(DeviceIdentity {
            device_id: uuid::Uuid::nil().to_string(),
            device_name: Some("MoXBots Mobile".into()),
            platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
            os_version: None,
            app_version: env!("CARGO_PKG_VERSION").into(),
        })
    }
}
mod space_cloud {
    pub(crate) mod agent_network {
        pub(crate) use crate::agent_network::account_operation::AccountOperation;
        pub(crate) use crate::official::{read_account_response_body, OfficialAccountSession};
    }
}
// Mobile supports only explicitly configured owned accounts. These compatibility
// ports cannot capture a desktop/official identity or read global credentials.
mod official {
    use crate::{
        agent_network::{account_operation::AccountOperation, NetworkError},
        network_diagnostics::RequestDiagnostic,
    };
    use serde_json::Value;
    #[derive(Clone)]
    pub struct OfficialAccountSession;
    impl OfficialAccountSession {
        pub fn capture() -> Result<Self, NetworkError> {
            Err(NetworkError::new("MOBILE_OWNED_ACCOUNT_REQUIRED"))
        }
        pub fn binding_id(&self) -> &str {
            ""
        }
        pub fn issuer(&self) -> &str {
            ""
        }
        pub fn environment(&self) -> &str {
            ""
        }
        pub fn principal_id(&self) -> Result<&str, NetworkError> {
            Err(NetworkError::new("MOBILE_OWNED_ACCOUNT_REQUIRED"))
        }
        pub fn service_id(&self) -> Result<&str, NetworkError> {
            Err(NetworkError::new("MOBILE_OWNED_ACCOUNT_REQUIRED"))
        }
        pub fn ensure_current(&self) -> Result<(), NetworkError> {
            Err(NetworkError::new("MOBILE_OWNED_ACCOUNT_REQUIRED"))
        }
        pub async fn request(
            &self,
            _: AccountOperation,
            _: Option<Value>,
        ) -> Result<Value, NetworkError> {
            Err(NetworkError::new("MOBILE_OWNED_ACCOUNT_REQUIRED"))
        }
    }
    pub async fn read_account_response_body(
        response: &mut reqwest::Response,
        _: &RequestDiagnostic,
    ) -> Result<Vec<u8>, NetworkError> {
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| NetworkError::new("NETWORK_ACCOUNT_UNAVAILABLE"))?
        {
            if bytes.len() + chunk.len() > 65536 {
                return Err(NetworkError::new("NETWORK_ACCOUNT_RESPONSE_INVALID"));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
}
