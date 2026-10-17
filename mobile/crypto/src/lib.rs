//! Mobile secure-store adapter over the original shared Rust crypto source.
//! Keep the desktop reader source closure byte-for-byte unchanged.
#[path = "../../../src-tauri/agent-network-crypto/src/lib.rs"]
mod shared;
pub use shared::*;

#[cfg(feature = "native-store")]
impl DevicePrivateKey {
    /// Restore a bounded PKCS8 record owned by native Keychain/Keystore code.
    /// The full KeyScope and lifetime remain the native caller's responsibility.
    pub fn from_native_pkcs8(der: zeroize::Zeroizing<Vec<u8>>) -> Result<Self, CryptoError> {
        Self::from_der(der)
    }
    /// Borrow only during native persistence; never serialize a key into JS.
    pub fn with_native_pkcs8<T>(&self, store: impl FnOnce(&[u8]) -> T) -> T {
        store(&self.der)
    }
}

#[cfg(all(test, feature = "native-store"))]
mod native_store_tests {
    use super::*;
    use zeroize::Zeroizing;
    #[test]
    fn round_trip_preserves_identity_and_rejects_invalid_records() {
        let original = DevicePrivateKey::generate().unwrap();
        let saved = original.with_native_pkcs8(|bytes| Zeroizing::new(bytes.to_vec()));
        let restored = DevicePrivateKey::from_native_pkcs8(saved).unwrap();
        assert_eq!(original.public_fingerprint().unwrap(), restored.public_fingerprint().unwrap());
        assert_eq!(original.public_thumbprint().unwrap(), restored.public_thumbprint().unwrap());
        for invalid in [vec![], vec![0; 4097], b"not a PKCS8 device key".to_vec()] {
            assert!(DevicePrivateKey::from_native_pkcs8(Zeroizing::new(invalid)).is_err());
        }
    }
}
