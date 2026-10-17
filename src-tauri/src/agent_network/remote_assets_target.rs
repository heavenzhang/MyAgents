//! Same-account asset RPC adapter. Original session artifacts are resolved by
//! the session owner; bytes are copied into the private native AssetStore.
use super::remote_session_target::{global, post, session};
use super::{
    memory::{Allocation, MemoryBudget},
    NetworkError,
};
use crate::sidecar::ManagedSidecarManager;
use moxbots_asset_store::{AssetScope, AssetStore, TrustedArtifactSource};
use myagents_agent_network_protocol::DeviceScope;
use myagents_host_management_protocol::{
    CanonicalUuid, RemoteArtifactDescriptor, RemoteAssetRequest, RemoteAssetResult, ResponseResult,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerArtifactPage {
    agent_id: String,
    session_id: String,
    items: Vec<OwnerArtifact>,
    has_more: bool,
    next_before: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerArtifact {
    root: String,
    relative: String,
    name: String,
    mime_type: String,
}

enum StoreFailure {
    Owner(NetworkError),
    Store(&'static str),
}

fn guard(
    account: &super::account::NetworkAccountSession,
    lifetime: &AtomicBool,
) -> Result<(), NetworkError> {
    account.ensure_current()?;
    if !lifetime.load(Ordering::Acquire) {
        return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
    }
    Ok(())
}

pub(super) fn scope_from_verified(
    agent_id: &str,
    account: &super::account::NetworkAccountSession,
    controller: &DeviceScope,
    local: &DeviceScope,
) -> Result<AssetScope, NetworkError> {
    let service_id = account.service_id()?;
    let principal_id = account.principal_id()?;
    let issuer = account.issuer();
    let environment = account.environment();
    if controller.service_id != service_id
        || local.service_id != service_id
        || controller.environment != environment
        || local.environment != environment
        || controller.principal_id != principal_id
        || local.principal_id != principal_id
        || controller.network_id != local.network_id
        || controller.device_id.is_empty()
        || local.device_id.is_empty()
        || controller.key_generation == 0
        || local.key_generation == 0
    {
        return Err(NetworkError::new("CHANNEL_SCOPE_MISMATCH"));
    }
    Ok(AssetScope {
        issuer: issuer.to_owned(),
        service_id: CanonicalUuid::parse(service_id)
            .map_err(|_| NetworkError::new("IDENTITY_SCOPE_MISMATCH"))?,
        environment: environment.to_owned(),
        network_id: CanonicalUuid::parse(&local.network_id)
            .map_err(|_| NetworkError::new("IDENTITY_SCOPE_MISMATCH"))?,
        principal_id: principal_id.to_owned(),
        controller_device_id: CanonicalUuid::parse(&controller.device_id)
            .map_err(|_| NetworkError::new("CHANNEL_SCOPE_MISMATCH"))?,
        controller_key_generation: controller.key_generation,
        target_device_id: CanonicalUuid::parse(&local.device_id)
            .map_err(|_| NetworkError::new("CHANNEL_SCOPE_MISMATCH"))?,
        agent_id: agent_id.to_owned(),
    })
}

fn response(data: RemoteAssetResult) -> Result<ResponseResult, NetworkError> {
    data.validate()
        .map_err(|_| NetworkError::new("TARGET_RECEIPT_INVALID"))?;
    Ok(ResponseResult::RemoteAssets { data })
}

fn typed_store_error(code: &'static str) -> Option<RemoteAssetResult> {
    match code {
        "ASSET_NOT_FOUND"
        | "ASSET_READ_RANGE"
        | "ASSET_UPLOAD_CANCELLED"
        | "ASSET_UPLOAD_CONFLICT"
        | "ASSET_UPLOAD_INCOMPLETE"
        | "ASSET_CHUNK_CONFLICT"
        | "ASSET_CHUNK_HASH_MISMATCH"
        | "ASSET_CHUNK_INVALID"
        | "ASSET_CHUNK_ORDER"
        | "ASSET_HASH_MISMATCH"
        | "ASSET_PATH_INVALID"
        | "ASSET_SIZE_LIMIT"
        | "ASSET_SOURCE_CHANGED" => Some(RemoteAssetResult::Error {
            version: 1,
            code: code.to_owned(),
        }),
        // Scope/authentication and infrastructure failures must remain outer
        // failures. In particular, only an exact typed NOT_FOUND can resolve
        // an UNKNOWN upload status at the caller.
        _ => None,
    }
}

async fn precheck(
    manager: &ManagedSidecarManager,
    request: &RemoteAssetRequest,
    memory: &MemoryBudget,
) -> Result<(), NetworkError> {
    let dispatch = global(manager)?;
    let mut body = json!({"localAgentId": request.agent_id()});
    if let RemoteAssetRequest::List { session_id, .. }
    | RemoteAssetRequest::Read { session_id, .. } = request
    {
        body["localSessionId"] = json!(session_id);
    }
    let (identity, _) = post(&dispatch, "/api/admin/agent/network-precheck", body, memory).await?;
    let identity: super::local_owner::TargetIdentity = serde_json::from_value(identity)
        .map_err(|_| NetworkError::new("TARGET_RECEIPT_INVALID"))?;
    let expected_session = match request {
        RemoteAssetRequest::List { session_id, .. }
        | RemoteAssetRequest::Read { session_id, .. } => Some(session_id.as_str()),
        _ => None,
    };
    if identity.local_agent_id != request.agent_id()
        || identity.local_session_id.as_deref() != expected_session
    {
        return Err(NetworkError::new("TARGET_OWNER_SCOPE_MISMATCH"));
    }
    Ok(())
}

async fn list_from_owner(
    manager: &ManagedSidecarManager,
    request: &RemoteAssetRequest,
    scope: AssetScope,
    store: Arc<AssetStore>,
    memory: &MemoryBudget,
) -> Result<(RemoteAssetResult, Allocation), NetworkError> {
    let RemoteAssetRequest::List {
        agent_id,
        session_id,
        limit,
        before,
        ..
    } = request
    else {
        unreachable!()
    };
    let dispatch = session(manager, session_id)?
        .ok_or_else(|| NetworkError::new("TARGET_OWNER_UNAVAILABLE"))?;
    let mut body = json!({"agentId":agent_id,"sessionId":session_id,"limit":limit});
    if let Some(before) = before {
        body["before"] = json!(before);
    }
    let (value, allocation) = post(&dispatch, "/api/remote-assets/resolve", body, memory).await?;
    let page: OwnerArtifactPage =
        serde_json::from_value(value).map_err(|_| NetworkError::new("TARGET_RECEIPT_INVALID"))?;
    if page.agent_id != *agent_id
        || page.session_id != *session_id
        || page.items.len() > *limit as usize
        || page.has_more && page.items.is_empty()
        || (page.has_more != page.next_before.is_some())
        || page
            .next_before
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 256)
        || page.has_more && page.next_before.as_ref() == before.as_ref()
    {
        return Err(NetworkError::new("TARGET_OWNER_SCOPE_MISMATCH"));
    }
    let result_session_id = session_id.clone();
    let worker_session_id = result_session_id.clone();
    let descriptors = tauri::async_runtime::spawn_blocking(move || {
        let mut result: Vec<RemoteArtifactDescriptor> = Vec::with_capacity(page.items.len());
        for item in page.items {
            if !Path::new(&item.root).is_absolute() {
                return Err(StoreFailure::Owner(NetworkError::new(
                    "TARGET_RECEIPT_INVALID",
                )));
            }
            let source =
                TrustedArtifactSource::from_owner(Path::new(&item.root), Path::new(&item.relative))
                    .map_err(|e| StoreFailure::Store(e.code))?;
            let descriptor = store
                .register_artifact(
                    &scope,
                    &worker_session_id,
                    &source,
                    &item.name,
                    &item.mime_type,
                )
                .map_err(|e| StoreFailure::Store(e.code))?;
            result.push(descriptor);
        }
        Ok::<_, StoreFailure>((result, page.has_more, page.next_before))
    })
    .await
    .map_err(|_| NetworkError::new("ASSET_IO_FAILED"))?;
    let descriptors = match descriptors {
        Ok(value) => value,
        Err(StoreFailure::Owner(error)) => return Err(error),
        Err(StoreFailure::Store(code)) => {
            return typed_store_error(code)
                .map(|error| (error, allocation))
                .ok_or_else(|| NetworkError::new(code));
        }
    };
    let (items, has_more, next_before) = descriptors;
    Ok((
        RemoteAssetResult::List {
            version: 1,
            agent_id: agent_id.clone(),
            session_id: result_session_id,
            items,
            has_more,
            next_before,
        },
        allocation,
    ))
}

pub(crate) async fn execute(
    _app: &tauri::AppHandle,
    manager: &ManagedSidecarManager,
    request: RemoteAssetRequest,
    memory: MemoryBudget,
    account: super::account::NetworkAccountSession,
    lifetime: Arc<AtomicBool>,
    controller: DeviceScope,
    local: DeviceScope,
    store: Arc<AssetStore>,
) -> Result<(ResponseResult, Allocation), NetworkError> {
    request
        .validate()
        .map_err(|_| NetworkError::new("HOST_MANAGEMENT_REQUEST_INVALID"))?;
    let guard = || guard(&account, &lifetime);
    guard()?;
    let scope = scope_from_verified(request.agent_id(), &account, &controller, &local)?;
    precheck(manager, &request, &memory).await?;
    guard()?;
    let (data, allocation) = if matches!(request, RemoteAssetRequest::List { .. }) {
        list_from_owner(manager, &request, scope.clone(), store.clone(), &memory).await?
    } else {
        let store_for_worker = store.clone();
        let request_for_worker = request.clone();
        let scope_for_worker = scope.clone();
        let stored = tauri::async_runtime::spawn_blocking(move || {
            store_for_worker.execute(&scope_for_worker, &request_for_worker)
        })
        .await
        .map_err(|_| NetworkError::new("ASSET_IO_FAILED"))?;
        let data = match stored {
            Ok(data) => data,
            Err(error) => match typed_store_error(error.code) {
                Some(data) => data,
                None => return Err(NetworkError::new(error.code)),
            },
        };
        (data, memory.reserve(64 * 1024)?)
    };
    guard()?;
    Ok((response(data)?, allocation))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allowlisted_store_domain_errors_become_typed_asset_results() {
        let missing = typed_store_error("ASSET_NOT_FOUND").expect("typed missing result");
        assert!(matches!(
            &missing,
            RemoteAssetResult::Error { version: 1, code } if code == "ASSET_NOT_FOUND"
        ));
        missing.validate().expect("valid typed protocol error");
        assert!(matches!(
            response(missing),
            Ok(ResponseResult::RemoteAssets {
                data: RemoteAssetResult::Error { version: 1, code }
            }) if code == "ASSET_NOT_FOUND"
        ));

        assert!(typed_store_error("ASSET_SCOPE_MISMATCH").is_none());
        assert!(typed_store_error("ASSET_SCOPE_INVALID").is_none());
        assert!(typed_store_error("ASSET_IO_FAILED").is_none());
    }
}
