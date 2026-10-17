//! Opt-in mobile admission still enters the original desktop Session owner.
//! Only authenticated native AssetStore leases supply attachment source paths.
use super::remote_session_target::{admission_permit, global, post, post_with_timeout, session};
use super::{
    memory::{Allocation, MemoryBudget},
    NetworkError,
};
use crate::sidecar::{ManagedSidecarManager, SidecarOwner};
use moxbots_asset_store::{AssetStore, ReadyAssetLease};
use myagents_agent_network_protocol::DeviceScope;
use myagents_host_management_protocol::{
    RemoteMobileRequest as Request, RemoteMobileResult as ResultData, RemoteReceiptStatus,
    ResponseResult,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepared {
    agent_id: String,
    session_id: String,
    workspace_path: String,
}
struct AdmissionOwner {
    manager: ManagedSidecarManager,
    session: String,
    owner: SidecarOwner,
    // Drop only after admission evidence, not when a transport/HTTP future ends.
    _assets: Vec<ReadyAssetLease>,
}
impl Drop for AdmissionOwner {
    fn drop(&mut self) {
        crate::sidecar::schedule_release_session_sidecar(
            self.manager.clone(),
            self.session.clone(),
            self.owner.clone(),
        );
    }
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
fn checked(request: &Request, data: ResultData) -> Result<ResponseResult, NetworkError> {
    data.validate()
        .map_err(|_| NetworkError::new("TARGET_RECEIPT_INVALID"))?;
    let matches = match (request, &data) {
        (_, ResultData::Error { .. }) => true,
        (
            Request::Capabilities { agent_id, .. },
            ResultData::Capabilities { agent_id: got, .. },
        )
        | (Request::Models { agent_id, .. }, ResultData::Models { agent_id: got, .. }) => {
            agent_id == got
        }
        (
            Request::Suggestions {
                agent_id,
                session_id,
                revision,
                ..
            },
            ResultData::Suggestions {
                agent_id: got,
                session_id: sid,
                revision: rev,
                ..
            },
        ) => agent_id == got && session_id == sid && revision == rev,
        (
            Request::Start { .. } | Request::Send { .. } | Request::Receipt { .. },
            ResultData::Receipt {
                agent_id,
                operation_id,
                session_id,
                ..
            },
        ) => {
            request.agent_id() == agent_id
                && request.operation_id() == Some(*operation_id)
                && request
                    .session_id()
                    .is_none_or(|sid| session_id.as_deref() == Some(sid))
        }
        _ => false,
    };
    if !matches {
        return Err(NetworkError::new("TARGET_OWNER_SCOPE_MISMATCH"));
    }
    Ok(ResponseResult::RemoteMobile { data })
}
fn result(request: &Request, value: Value) -> Result<ResponseResult, NetworkError> {
    checked(
        request,
        serde_json::from_value(value).map_err(|_| NetworkError::new("TARGET_RECEIPT_INVALID"))?,
    )
}
async fn admission_state(
    manager: &ManagedSidecarManager,
    sid: &str,
    receipt: &Request,
    generation: u64,
    memory: &MemoryBudget,
) -> super::remote_admission::AdmissionState {
    use super::remote_admission::AdmissionState;
    if manager.lock().is_ok_and(|m| !m.is_live(sid, generation)) {
        return AdmissionState::Exited;
    }
    let Ok(Some(dispatch)) = session(manager, sid) else {
        return AdmissionState::Pending;
    };
    if dispatch.generation() != generation {
        return AdmissionState::Exited;
    }
    let Ok((value, _)) = post(
        &dispatch,
        "/api/remote-mobile",
        json!({"request":receipt,"generation":generation.to_string()}),
        memory,
    )
    .await
    else {
        return AdmissionState::Pending;
    };
    let Ok(ResponseResult::RemoteMobile {
        data:
            ResultData::Receipt {
                session_id: Some(receipt_sid),
                status,
                ..
            },
    }) = result(receipt, value)
    else {
        return AdmissionState::Pending;
    };
    if receipt_sid != sid {
        return AdmissionState::Pending;
    }
    // Session-wide running state is not evidence for this operation: it may
    // describe an unrelated turn already executing before this send arrived.
    super::remote_admission::exact_receipt_state(&status)
}
fn retain(
    app: tauri::AppHandle,
    owner: AdmissionOwner,
    request: &Request,
    generation: u64,
    memory: MemoryBudget,
) -> Result<(), NetworkError> {
    let permit = admission_permit()?;
    let allocation = memory.reserve(super::memory::measure(request)?.0 * 3 + 8192)?;
    let receipt = Request::Receipt {
        version: 1,
        agent_id: request.agent_id().into(),
        operation_id: request
            .operation_id()
            .ok_or_else(|| NetworkError::new("TARGET_RECEIPT_INVALID"))?,
    };
    // Deliberately independent of the transport/account observer lifetime.
    // The original Session may already be configuring or running an admitted
    // request; dropping its only SidecarOwner on a disconnect/logout can kill
    // that work. This local receipt observer grants no further remote control,
    // holds the existing bounded permit, and expires after one hour or owner exit.
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let _allocation = allocation;
        let manager = owner.manager.clone();
        let sid = owner.session.clone();
        let (owner, state) = super::remote_admission::retain_owner(
            owner,
            Duration::from_secs(3600),
            Duration::from_secs(2),
            || admission_state(&manager, &sid, &receipt, generation, &memory),
        )
        .await;
        if matches!(state, super::remote_admission::AdmissionState::Accepted) {
            let _ = crate::sidecar::start_headless_background_completion(&app, &manager, &sid);
        }
        drop(owner);
    });
    Ok(())
}
pub(crate) async fn execute(
    app: &tauri::AppHandle,
    manager: &ManagedSidecarManager,
    request: Request,
    memory: MemoryBudget,
    account: super::account::NetworkAccountSession,
    lifetime: Arc<AtomicBool>,
    controller: DeviceScope,
    local: DeviceScope,
    store: Arc<AssetStore>,
) -> Result<(ResponseResult, Allocation), NetworkError> {
    guard(&account, &lifetime)?;
    request
        .validate()
        .map_err(|_| NetworkError::new("HOST_MANAGEMENT_REQUEST_INVALID"))?;
    let global_dispatch = global(manager)?;
    let mut precheck = json!({"localAgentId":request.agent_id()});
    if let Some(sid) = request.session_id() {
        precheck["localSessionId"] = json!(sid);
    }
    let (identity, _) = post(
        &global_dispatch,
        "/api/admin/agent/network-precheck",
        precheck,
        &memory,
    )
    .await?;
    let identity: super::local_owner::TargetIdentity = serde_json::from_value(identity)
        .map_err(|_| NetworkError::new("TARGET_RECEIPT_INVALID"))?;
    if identity.local_agent_id != request.agent_id()
        || identity.local_session_id.as_deref() != request.session_id()
    {
        return Err(NetworkError::new("TARGET_OWNER_SCOPE_MISMATCH"));
    }
    guard(&account, &lifetime)?;
    let scope = super::remote_assets_target::scope_from_verified(
        request.agent_id(),
        &account,
        &controller,
        &local,
    )?;
    let asset_ids = match &request {
        Request::Start { asset_ids, .. } | Request::Send { asset_ids, .. } => asset_ids.clone(),
        _ => vec![],
    };
    let leases = tokio::task::spawn_blocking(move || {
        asset_ids
            .into_iter()
            .map(|id| store.ready_asset_lease(&scope, id).map(|lease| (id, lease)))
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|_| NetworkError::new("ASSET_IO_FAILED"))?
    .map_err(|e| NetworkError::new(e.code))?;
    let assets:Vec<Value>=leases.iter().map(|(id,lease)|json!({"assetId":id,"sourcePath":lease.path(),"name":lease.name,"mimeType":lease.mime_type,"sizeBytes":lease.size_bytes,"sha256":lease.sha256})).collect();
    let mut prepared = None;
    if request.mutation() {
        let (value, allocation) = post(
            &global_dispatch,
            "/api/remote-mobile/prepare",
            json!({"request":request}),
            &memory,
        )
        .await?;
        if let Some(receipt) = value.get("receipt") {
            return Ok((result(&request, receipt.clone())?, allocation));
        }
        let p: Prepared = serde_json::from_value(value)
            .map_err(|_| NetworkError::new("TARGET_RECEIPT_INVALID"))?;
        if p.agent_id != request.agent_id()
            || p.workspace_path != identity.workspace_path
            || uuid::Uuid::parse_str(&p.session_id).is_err()
            || request.session_id().is_some_and(|sid| sid != p.session_id)
        {
            return Err(NetworkError::new("TARGET_OWNER_SCOPE_MISMATCH"));
        }
        prepared = Some(p);
    }
    drop(global_dispatch);
    guard(&account, &lifetime)?;
    let sid = prepared
        .as_ref()
        .map(|p| p.session_id.as_str())
        .or(request.session_id());
    let mut owner = None;
    let mut lifecycle = None;
    if request.mutation() || matches!(&request, Request::Suggestions { .. }) {
        let sid = sid.ok_or_else(|| NetworkError::new("TARGET_OWNER_SCOPE_MISMATCH"))?;
        let held = Arc::new(crate::sidecar::acquire_session_lifecycle(&[sid]).await);
        let sidecar_owner = SidecarOwner::Agent(format!("remote-mobile-{}", uuid::Uuid::new_v4()));
        owner = Some(AdmissionOwner {
            manager: manager.clone(),
            session: sid.into(),
            owner: sidecar_owner.clone(),
            _assets: leases.into_iter().map(|(_, lease)| lease).collect(),
        });
        if crate::sidecar::resolve_session_runtime_identity_full(sid).is_none() {
            return Err(NetworkError::new("TARGET_SESSION_IDENTITY_MISSING"));
        }
        crate::sidecar::ensure_session_sidecar_with_runtime_identity_override_lifecycle_held(
            held.clone(),
            app.clone(),
            manager.clone(),
            sid.into(),
            PathBuf::from(&identity.workspace_path),
            sidecar_owner,
            None,
            None,
        )
        .await
        .map_err(|_| NetworkError::new("TARGET_PREPARATION_FAILED"))?;
        lifecycle = Some(held);
    }
    let dispatch = if let Some(sid) = sid {
        session(manager, sid)?.ok_or_else(|| NetworkError::new("TARGET_OWNER_UNAVAILABLE"))?
    } else {
        global(manager)?
    };
    let generation = dispatch.generation();
    let mut body = json!({"request":request,"generation":generation.to_string()});
    if let Some(p) = prepared.as_ref() {
        body["preparedSessionId"] = json!(p.session_id);
        body["assets"] = json!(assets);
    }
    guard(&account, &lifetime)?;
    // As with legacy Session admission, transport cancellation cannot destroy a
    // configuring Session or cancel the private files that it is still reading.
    if request.mutation() {
        if let Some(owner) = owner.take() {
            retain(app.clone(), owner, &request, generation, memory.clone())?;
        }
    }
    let timeout = if matches!(&request, Request::Suggestions { .. }) {
        Duration::from_secs(25)
    } else {
        Duration::from_secs(8)
    };
    let response = post_with_timeout(&dispatch, "/api/remote-mobile", body, &memory, timeout).await;
    let (value, allocation) = match response {
        Ok(value) => value,
        Err(error) if request.mutation() => {
            let data = ResultData::Receipt {
                version: 1,
                agent_id: request.agent_id().into(),
                operation_id: request
                    .operation_id()
                    .ok_or_else(|| NetworkError::new("TARGET_RECEIPT_INVALID"))?,
                session_id: sid.map(str::to_owned),
                status: RemoteReceiptStatus::Unconfirmed,
                code: Some(error.code),
            };
            return Ok((checked(&request, data)?, memory.reserve(1024)?));
        }
        Err(error) => return Err(error),
    };
    guard(&account, &lifetime)?;
    let data = result(&request, value)?;
    drop(dispatch);
    drop(lifecycle);
    drop(owner);
    Ok((data, allocation))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mobile_send_result_must_match_original_session_and_operation() {
        let operation_id = myagents_host_management_protocol::CanonicalUuid::parse(
            "00000000-0000-4000-8000-000000000001",
        )
        .unwrap();
        let request = Request::Send {
            version: 1,
            agent_id: "agent".into(),
            session_id: "session-one".into(),
            operation_id,
            text: "hello".into(),
            asset_ids: vec![],
            model_id: None,
        };
        let receipt = |session_id| ResultData::Receipt {
            version: 1,
            agent_id: "agent".into(),
            operation_id,
            session_id,
            status: RemoteReceiptStatus::Accepted,
            code: None,
        };
        assert!(checked(&request, receipt(Some("session-one".into()))).is_ok());
        assert!(checked(&request, receipt(Some("session-two".into()))).is_err());
        assert!(checked(&request, receipt(None)).is_err());
        assert!(checked(
            &request,
            ResultData::Error {
                version: 1,
                code: "REMOTE_AGENT_UNAVAILABLE".into()
            }
        )
        .is_ok());
    }
}
