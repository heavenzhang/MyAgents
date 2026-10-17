//! Length-delimited native ABI. Pointers are native-owned and never JS values.
use crate::{error, Intent, MobileClient, NativeConfig};
use serde_json::{json, Value};
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    ptr, slice,
};
use zeroize::Zeroizing;

#[repr(C)]
pub struct MoxMobileBuffer {
    pub data: *mut u8,
    pub len: usize,
    pub status: i32,
}
#[repr(C)]
pub struct MoxMobileClient {
    inner: MobileClient,
}
impl MoxMobileBuffer {
    fn bytes(bytes: Vec<u8>, status: i32) -> Self {
        if bytes.is_empty() {
            return Self {
                data: ptr::null_mut(),
                len: 0,
                status,
            };
        }
        let mut bytes = bytes.into_boxed_slice();
        let result = Self {
            data: bytes.as_mut_ptr(),
            len: bytes.len(),
            status,
        };
        std::mem::forget(bytes);
        result
    }
    fn failure(code: &str) -> Self {
        Self::bytes(
            json!({"ok":false,"error":{"code":code}})
                .to_string()
                .into_bytes(),
            1,
        )
    }
    fn json(value: Result<Value, crate::NetworkError>) -> Self {
        match value {
            Ok(value) => Self::bytes(json!({"ok":true,"value":value}).to_string().into_bytes(), 0),
            Err(error) => Self::failure(&error.code),
        }
    }
}
unsafe fn input<'a>(
    data: *const u8,
    len: usize,
    max: usize,
) -> Result<&'a [u8], crate::NetworkError> {
    if data.is_null() || len == 0 || len > max {
        return Err(error("MOBILE_INPUT_INVALID"));
    }
    Ok(slice::from_raw_parts(data, len))
}
fn guarded(f: impl FnOnce() -> MoxMobileBuffer) -> MoxMobileBuffer {
    catch_unwind(AssertUnwindSafe(f))
        .unwrap_or_else(|_| MoxMobileBuffer::failure("MOBILE_INTERNAL_ERROR"))
}
/// # Safety
/// All pointers must name valid allocated buffers of the supplied lengths. Error
/// must be writable. No concurrent calls may operate on the same native handle.
#[no_mangle]
pub unsafe extern "C" fn mox_mobile_new(
    config: *const u8,
    config_len: usize,
    pkcs8: *const u8,
    pkcs8_len: usize,
    error_out: *mut MoxMobileBuffer,
) -> *mut MoxMobileClient {
    if error_out.is_null() {
        return ptr::null_mut();
    }
    *error_out = MoxMobileBuffer::bytes(Vec::new(), 0);
    let result = catch_unwind(AssertUnwindSafe(|| {
        let config: NativeConfig = serde_json::from_slice(input(config, config_len, 256 * 1024)?)
            .map_err(|_| error("MOBILE_CONFIG_INVALID"))?;
        let key = Zeroizing::new(input(pkcs8, pkcs8_len, 4096)?.to_vec());
        MobileClient::new_inner(config, key)
    }));
    match result {
        Ok(Ok(inner)) => Box::into_raw(Box::new(MoxMobileClient { inner })),
        Ok(Err(error)) => {
            *error_out = MoxMobileBuffer::failure(&error.code);
            ptr::null_mut()
        }
        Err(_) => {
            *error_out = MoxMobileBuffer::failure("MOBILE_INTERNAL_ERROR");
            ptr::null_mut()
        }
    }
}
/// # Safety
/// Client must be a live handle, accessed serially; input must be valid for len.
#[no_mangle]
pub unsafe extern "C" fn mox_mobile_call(
    client: *mut MoxMobileClient,
    data: *const u8,
    len: usize,
) -> MoxMobileBuffer {
    guarded(|| {
        let Some(client) = client.as_mut() else {
            return MoxMobileBuffer::failure("MOBILE_HANDLE_INVALID");
        };
        MoxMobileBuffer::json((|| {
            let intent: Intent = serde_json::from_slice(input(data, len, 64 * 1024)?)
                .map_err(|_| error("MOBILE_INTENT_INVALID"))?;
            client.inner.call(intent)
        })())
    })
}
/// # Safety
/// Same handle/input lifetime and serialization requirements as mox_mobile_call.
#[no_mangle]
pub unsafe extern "C" fn mox_mobile_feed(
    client: *mut MoxMobileClient,
    data: *const u8,
    len: usize,
) -> MoxMobileBuffer {
    guarded(|| {
        let Some(client) = client.as_mut() else {
            return MoxMobileBuffer::failure("MOBILE_HANDLE_INVALID");
        };
        MoxMobileBuffer::json(input(data, len, 256 * 1024).and_then(|data| client.inner.feed(data)))
    })
}
/// # Safety
/// Client must be live and accessed serially.
#[no_mangle]
pub unsafe extern "C" fn mox_mobile_drain(client: *mut MoxMobileClient) -> MoxMobileBuffer {
    guarded(|| {
        let Some(client) = client.as_mut() else {
            return MoxMobileBuffer::failure("MOBILE_HANDLE_INVALID");
        };
        match client.inner.drain_native() {
            Ok(Some(bytes)) => MoxMobileBuffer::bytes(bytes, 0),
            Ok(None) => MoxMobileBuffer::bytes(Vec::new(), 0),
            Err(error) => MoxMobileBuffer::failure(&error.code),
        }
    })
}
/// # Safety
/// Live native handle, serialized access; values come from authenticated relay.
#[no_mangle]
pub unsafe extern "C" fn mox_mobile_credit(
    client: *mut MoxMobileClient,
    sequence: u64,
    received_bytes: u64,
) -> MoxMobileBuffer {
    guarded(|| {
        let Some(client) = client.as_mut() else {
            return MoxMobileBuffer::failure("MOBILE_HANDLE_INVALID");
        };
        match client.inner.relay_credit(sequence, received_bytes) {
            Ok(()) => MoxMobileBuffer::json(Ok(Value::Null)),
            Err(code) => MoxMobileBuffer::failure(&code),
        }
    })
}
/// # Safety
/// Live native handle, serialized access; returned credit belongs to its scope.
#[no_mangle]
pub unsafe extern "C" fn mox_mobile_received_credit(
    client: *mut MoxMobileClient,
) -> MoxMobileBuffer {
    guarded(|| {
        let Some(client) = client.as_mut() else {
            return MoxMobileBuffer::failure("MOBILE_HANDLE_INVALID");
        };
        match client.inner.take_received_credit() {
            Ok(Some((sequence, received_bytes))) => MoxMobileBuffer::json(Ok(
                json!({"sequence":sequence,"receivedBytes":received_bytes}),
            )),
            Ok(None) => MoxMobileBuffer::json(Ok(Value::Null)),
            Err(code) => MoxMobileBuffer::failure(&code),
        }
    })
}
/// # Safety
/// Buffer must have been returned by this ABI, and must be freed exactly once.
#[no_mangle]
pub unsafe extern "C" fn mox_mobile_buffer_free(buffer: MoxMobileBuffer) {
    if !buffer.data.is_null() {
        let bytes = ptr::slice_from_raw_parts_mut(buffer.data, buffer.len);
        drop(Box::from_raw(bytes));
    }
}
/// # Safety
/// Handle must have been returned by new, freed once, with no concurrent calls.
#[no_mangle]
pub unsafe extern "C" fn mox_mobile_free(client: *mut MoxMobileClient) {
    if !client.is_null() {
        drop(Box::from_raw(client));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn abi_bounds_empty_inputs_and_constructor_errors_are_sanitized() {
        unsafe {
            assert!(input(ptr::null(), 0, 100).is_err());
            assert!(input(ptr::null(), 1, 100).is_err());
            let byte = 0u8;
            assert!(input(&byte, 0, 100).is_err());
            assert!(input(&byte, 101, 100).is_err());
            mox_mobile_buffer_free(MoxMobileBuffer {
                data: ptr::null_mut(),
                len: 0,
                status: 0,
            });
            let mut err = MoxMobileBuffer::bytes(Vec::new(), 0);
            let private_marker = br#"{"secret":"do-not-return-native-input"}"#;
            let handle = mox_mobile_new(
                private_marker.as_ptr(),
                private_marker.len(),
                &byte,
                1,
                &mut err,
            );
            assert!(handle.is_null());
            assert_eq!(err.status, 1);
            let body = std::str::from_utf8(slice::from_raw_parts(err.data, err.len)).unwrap();
            assert!(body.contains("MOBILE_CONFIG_INVALID"));
            assert!(!body.contains("do-not-return"));
            mox_mobile_buffer_free(err);
            assert!(mox_mobile_new(ptr::null(), 0, ptr::null(), 0, ptr::null_mut()).is_null());
        }
    }
}
