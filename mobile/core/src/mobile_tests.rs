//! Real shared-channel TLS and durable-journal tests; no Host admission success claim.
use super::*;
use crate::tests::{pair, session_rpc, start};
use myagents_host_management_protocol::{
    RemoteReceiptStatus, RemoteSessionResult, RemoteSessionState,
};
use std::io::Write;
fn mobile_start(id: CanonicalUuid) -> RemoteMobileRequest {
    RemoteMobileRequest::Start {
        version: 1,
        agent_id: "agent".into(),
        operation_id: id,
        text: "original text\n原文".into(),
        asset_ids: vec![CanonicalUuid::parse("00000000-0000-4000-8000-000000000001").unwrap()],
        model_id: Some("catalog/model-a".into()),
    }
}
fn mobile_receipt(id: CanonicalUuid, status: RemoteReceiptStatus) -> RemoteMobileResult {
    RemoteMobileResult::Receipt {
        version: 1,
        agent_id: "agent".into(),
        operation_id: id,
        session_id: Some("mobile-session".into()),
        status,
        code: None,
    }
}
fn legacy_receipt(id: CanonicalUuid, status: RemoteReceiptStatus) -> RemoteSessionResult {
    RemoteSessionResult::Receipt {
        agent_id: "agent".into(),
        operation_id: id,
        session_id: Some("mobile-session".into()),
        status,
        code: None,
    }
}
fn requests(
    client: &mut MobileClient,
    host: &mut Channel,
    sequences: &mut PairSequences,
) -> Vec<(CanonicalUuid, ManagementMethod, RequestParams)> {
    let mut out = vec![];
    while let Some(frame) = client.drain_frame().unwrap() {
        for event in host
            .feed_management(decode_tls_frame(&frame).unwrap().1, sequences)
            .unwrap()
        {
            if let ManagementEvent::Request {
                request_id,
                method,
                params,
            } = event
            {
                out.push((request_id, method, params));
            }
        }
    }
    out
}
fn respond(
    client: &mut MobileClient,
    host: &mut Channel,
    id: CanonicalUuid,
    result: ResponseResult,
) -> Result<Vec<Value>, NetworkError> {
    host.send_management(ManagementMessage::Response {
        request_id: id,
        result,
    })
    .unwrap();
    let mut out = vec![];
    while let Some(frame) = host.drain_frame().unwrap() {
        out.extend(client.feed(&frame)?["events"].as_array().unwrap().clone());
    }
    Ok(out)
}
fn negotiate(client: &mut MobileClient, host: &mut Channel, sequences: &mut PairSequences) {
    client
        .call(Intent::MobileRequest {
            request: RemoteMobileRequest::Capabilities {
                version: 1,
                agent_id: "agent".into(),
            },
        })
        .unwrap();
    let req = requests(client, host, sequences);
    assert_eq!(req.len(), 1);
    assert_eq!(req[0].1, ManagementMethod::RemoteMobile);
    assert_eq!(
        req[0].2,
        RequestParams::RemoteMobile {
            remote_mobile: RemoteMobileRequest::Capabilities {
                version: 1,
                agent_id: "agent".into()
            }
        }
    );
    let events = respond(
        client,
        host,
        req[0].0,
        ResponseResult::RemoteMobile {
            data: RemoteMobileResult::Capabilities {
                version: 1,
                agent_id: "agent".into(),
                attachments: true,
                model_selection: true,
                next_suggestions: true,
                max_assets: 8,
            },
        },
    )
    .unwrap();
    assert_eq!(events[0]["kind"], "mobile-response");
    assert!(client.mobile_negotiated);
}
fn prepared(client: &mut MobileClient, id: CanonicalUuid) -> JournalRecord {
    let value = client
        .call(Intent::PrepareMobile {
            request: mobile_start(id),
        })
        .unwrap();
    serde_json::from_value(value["record"].clone()).unwrap()
}
#[test]
fn mobile_caps_persist_commit_receipt_then_original_v1_snapshot_same_tls() {
    let (mut client, mut host, mut sequences) = pair();
    client.profile = MobileProfile::Combined;
    let channel = client.channel.id.clone();
    let id = CanonicalUuid::new(uuid::Uuid::new_v4());
    assert_eq!(
        client
            .call(Intent::PrepareMobile {
                request: mobile_start(id)
            })
            .unwrap_err()
            .code,
        "MOBILE_CAPABILITY_REQUIRED"
    );
    assert!(client.journal.is_empty());
    negotiate(&mut client, &mut host, &mut sequences);
    let record = prepared(&mut client, id);
    assert!(client.drain_frame().unwrap().is_none());
    // Native owner must really persist before commit; exercise an fsync/read round trip.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("opaque-journal.json");
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(&serde_json::to_vec(&record).unwrap())
        .unwrap();
    file.sync_all().unwrap();
    std::fs::File::open(dir.path()).unwrap().sync_all().unwrap();
    let persisted: JournalRecord = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert!(
        matches!(&persisted.request,JournalRequest::Mobile(RemoteMobileRequest::Start{asset_ids,model_id,..})if asset_ids.len()==1&&model_id.as_deref()==Some("catalog/model-a"))
    );
    client
        .call(Intent::Commit {
            operation_id: id,
            digest: persisted.digest,
        })
        .unwrap();
    let req = requests(&mut client, &mut host, &mut sequences);
    assert_eq!(req.len(), 1);
    assert_eq!(req[0].1, ManagementMethod::RemoteMobile);
    assert_eq!(
        req[0].2,
        RequestParams::RemoteMobile {
            remote_mobile: mobile_start(id)
        }
    );
    let events = respond(
        &mut client,
        &mut host,
        req[0].0,
        ResponseResult::RemoteMobile {
            data: mobile_receipt(id, RemoteReceiptStatus::Accepted),
        },
    )
    .unwrap();
    assert_eq!(events[0]["kind"], "mobile-response");
    assert!(client.journal.is_empty());
    assert!(client.confirmed.contains(&id.as_uuid().to_string()));
    assert_eq!(
        client
            .call(Intent::Prepare { request: start(id) })
            .unwrap_err()
            .code,
        "MOBILE_RECEIPT_REQUIRED"
    );
    let snapshot = session_rpc(
        &mut client,
        &mut host,
        &mut sequences,
        RemoteSessionRequest::Get {
            agent_id: "agent".into(),
            session_id: "mobile-session".into(),
            limit: 1,
            before: None,
        },
        RemoteSessionResult::Snapshot {
            agent_id: "agent".into(),
            session_id: "mobile-session".into(),
            generation: None,
            turn_id: None,
            revision: "r1".into(),
            state: RemoteSessionState::Idle,
            title: "fixture".into(),
            runtime: "fixture".into(),
            model: Some("catalog/model-a".into()),
            terminal: None,
            messages: vec![],
            interactions: vec![],
            has_more_before: false,
            next_before: None,
        },
    );
    assert_eq!(snapshot["events"][0]["data"]["kind"], "snapshot");
    assert_eq!(client.channel.id, channel);
    assert_eq!(host.id, channel);
}
#[test]
fn digest_conflicts_cover_raw_text_assets_model_and_cross_protocol_uuid() {
    let (mut client, mut host, mut sequences) = pair();
    client.profile = MobileProfile::Combined;
    negotiate(&mut client, &mut host, &mut sequences);
    let id = CanonicalUuid::new(uuid::Uuid::new_v4());
    let original = prepared(&mut client, id);
    for field in 0..3 {
        let mut changed = mobile_start(id);
        if let RemoteMobileRequest::Start {
            text,
            asset_ids,
            model_id,
            ..
        } = &mut changed
        {
            match field {
                0 => *text = "different raw text".into(),
                1 => asset_ids[0] = CanonicalUuid::new(uuid::Uuid::new_v4()),
                _ => *model_id = Some("catalog/model-b".into()),
            }
        }
        assert_eq!(
            client
                .call(Intent::PrepareMobile { request: changed })
                .unwrap_err()
                .code,
            "MOBILE_OPERATION_CONFLICT"
        );
    }
    assert_eq!(
        client
            .call(Intent::Prepare { request: start(id) })
            .unwrap_err()
            .code,
        "MOBILE_OPERATION_CONFLICT"
    );
    assert_eq!(
        client.journal[&id.as_uuid().to_string()].record.digest,
        original.digest
    );
    assert!(client.drain_frame().unwrap().is_none());
    assert_eq!(
        client
            .call(Intent::MobileRequest {
                request: mobile_start(CanonicalUuid::new(uuid::Uuid::new_v4()))
            })
            .unwrap_err()
            .code,
        "MOBILE_JOURNAL_REQUIRED"
    );
}
#[test]
fn legacy_and_mobile_receipts_cannot_confirm_the_other_journal_protocol() {
    let (mut client, mut host, mut sequences) = pair();
    client.profile = MobileProfile::Combined;
    negotiate(&mut client, &mut host, &mut sequences);
    let mobile_id = CanonicalUuid::new(uuid::Uuid::new_v4());
    let record = prepared(&mut client, mobile_id);
    client
        .call(Intent::Commit {
            operation_id: mobile_id,
            digest: record.digest,
        })
        .unwrap();
    let sent = requests(&mut client, &mut host, &mut sequences);
    let mobile_request_id = sent[0].0;
    client
        .call(Intent::Request {
            request: RemoteSessionRequest::Receipt {
                agent_id: "agent".into(),
                operation_id: mobile_id,
            },
        })
        .unwrap();
    let query = requests(&mut client, &mut host, &mut sequences);
    respond(
        &mut client,
        &mut host,
        query[0].0,
        ResponseResult::RemoteSession {
            data: legacy_receipt(mobile_id, RemoteReceiptStatus::Accepted),
        },
    )
    .unwrap();
    assert!(client
        .journal
        .contains_key(&mobile_id.as_uuid().to_string()));
    assert!(!client.confirmed.contains(&mobile_id.as_uuid().to_string()));
    respond(
        &mut client,
        &mut host,
        mobile_request_id,
        ResponseResult::RemoteMobile {
            data: mobile_receipt(mobile_id, RemoteReceiptStatus::Accepted),
        },
    )
    .unwrap();
    assert!(!client
        .journal
        .contains_key(&mobile_id.as_uuid().to_string()));
    let legacy_id = CanonicalUuid::new(uuid::Uuid::new_v4());
    let value = client
        .call(Intent::Prepare {
            request: start(legacy_id),
        })
        .unwrap();
    let record: JournalRecord = serde_json::from_value(value["record"].clone()).unwrap();
    client
        .call(Intent::Commit {
            operation_id: legacy_id,
            digest: record.digest,
        })
        .unwrap();
    let sent = requests(&mut client, &mut host, &mut sequences);
    let legacy_request_id = sent[0].0;
    client
        .call(Intent::MobileRequest {
            request: RemoteMobileRequest::Receipt {
                version: 1,
                agent_id: "agent".into(),
                operation_id: legacy_id,
            },
        })
        .unwrap();
    let query = requests(&mut client, &mut host, &mut sequences);
    respond(
        &mut client,
        &mut host,
        query[0].0,
        ResponseResult::RemoteMobile {
            data: mobile_receipt(legacy_id, RemoteReceiptStatus::Accepted),
        },
    )
    .unwrap();
    assert!(client
        .journal
        .contains_key(&legacy_id.as_uuid().to_string()));
    assert!(!client.confirmed.contains(&legacy_id.as_uuid().to_string()));
    respond(
        &mut client,
        &mut host,
        legacy_request_id,
        ResponseResult::RemoteSession {
            data: legacy_receipt(legacy_id, RemoteReceiptStatus::Rejected),
        },
    )
    .unwrap();
    assert!(client.journal.is_empty());
}
#[test]
fn legacy_frozen_journal_json_digest_and_unknown_recovery_stay_compatible() {
    let bytes = include_bytes!("../tests/fixtures/legacy-journal-v1.json");
    let frozen: Value = serde_json::from_slice(bytes).unwrap();
    let record: JournalRecord = serde_json::from_slice(bytes).unwrap();
    assert!(matches!(record.request, JournalRequest::Legacy(_)));
    assert_eq!(
        MobileClient::digest(&record.request, &record.target, &record.issuer).unwrap(),
        frozen["digest"]
    );
    assert_eq!(serde_json::to_value(&record).unwrap(), frozen);
    let (mut client, _, _) = pair();
    client.profile = MobileProfile::Combined;
    client
        .call(Intent::Recover {
            records: vec![record.clone()],
        })
        .unwrap();
    assert_eq!(
        client
            .call(Intent::Commit {
                operation_id: record.operation_id,
                digest: record.digest
            })
            .unwrap_err()
            .code,
        "MOBILE_RECEIPT_REQUIRED"
    );
}
#[test]
fn mobile_unknown_recovery_is_atomic_query_only_and_profile_scoped() {
    let (mut source, mut host, mut sequences) = pair();
    source.profile = MobileProfile::Combined;
    negotiate(&mut source, &mut host, &mut sequences);
    let id = CanonicalUuid::new(uuid::Uuid::new_v4());
    let record = prepared(&mut source, id);
    let (mut client, mut host, mut sequences) = pair();
    client.profile = MobileProfile::Combined;
    let mut foreign = record.clone();
    if let JournalRequest::Mobile(RemoteMobileRequest::Start {
        agent_id,
        operation_id,
        ..
    }) = &mut foreign.request
    {
        *agent_id = "foreign".into();
        *operation_id = CanonicalUuid::new(uuid::Uuid::new_v4());
        foreign.operation_id = *operation_id;
    }
    foreign.digest =
        MobileClient::digest(&foreign.request, &foreign.target, &foreign.issuer).unwrap();
    assert_eq!(
        client
            .call(Intent::Recover {
                records: vec![record.clone(), foreign]
            })
            .unwrap_err()
            .code,
        "MOBILE_COMBINED_AGENT_MISMATCH"
    );
    assert!(client.journal.is_empty() && client.combined_agent.is_none());
    client
        .call(Intent::Recover {
            records: vec![record.clone()],
        })
        .unwrap();
    assert_eq!(
        client
            .call(Intent::Commit {
                operation_id: id,
                digest: record.digest.clone()
            })
            .unwrap_err()
            .code,
        "MOBILE_RECEIPT_REQUIRED"
    );
    assert_eq!(
        client
            .call(Intent::MobileRequest {
                request: RemoteMobileRequest::Receipt {
                    version: 1,
                    agent_id: "agent".into(),
                    operation_id: id
                }
            })
            .unwrap_err()
            .code,
        "MOBILE_CAPABILITY_REQUIRED"
    );
    negotiate(&mut client, &mut host, &mut sequences);
    client
        .call(Intent::MobileRequest {
            request: RemoteMobileRequest::Receipt {
                version: 1,
                agent_id: "agent".into(),
                operation_id: id,
            },
        })
        .unwrap();
    let query = requests(&mut client, &mut host, &mut sequences);
    respond(
        &mut client,
        &mut host,
        query[0].0,
        ResponseResult::RemoteMobile {
            data: mobile_receipt(id, RemoteReceiptStatus::NotFound),
        },
    )
    .unwrap();
    assert_eq!(
        client
            .call(Intent::Commit {
                operation_id: id,
                digest: record.digest.clone()
            })
            .unwrap_err()
            .code,
        "MOBILE_RECEIPT_REQUIRED"
    );
    for profile in [MobileProfile::Session, MobileProfile::Assets] {
        let (mut other, _, _) = pair();
        other.profile = profile;
        assert!(other
            .call(Intent::Recover {
                records: vec![record.clone()]
            })
            .is_err());
        assert!(other.journal.is_empty());
        assert_eq!(
            other
                .call(Intent::MobileRequest {
                    request: RemoteMobileRequest::Capabilities {
                        version: 1,
                        agent_id: "agent".into()
                    }
                })
                .unwrap_err()
                .code,
            "MOBILE_PROFILE_MISMATCH"
        );
    }
    let mut invalid = frozen_value(&record);
    invalid["request"]["providerEndpoint"] = json!("https://evil.invalid");
    assert!(serde_json::from_value::<JournalRecord>(invalid).is_err());
}
fn frozen_value(record: &JournalRecord) -> Value {
    serde_json::to_value(record).unwrap()
}
#[test]
fn mobile_reply_revision_session_and_protocol_are_exact_and_fail_closed() {
    let (mut client, mut host, mut sequences) = pair();
    client.profile = MobileProfile::Combined;
    negotiate(&mut client, &mut host, &mut sequences);
    assert_eq!(
        client
            .call(Intent::MobileRequest {
                request: RemoteMobileRequest::Models {
                    version: 1,
                    agent_id: "foreign".into()
                }
            })
            .unwrap_err()
            .code,
        "MOBILE_COMBINED_AGENT_MISMATCH"
    );
    client
        .call(Intent::MobileRequest {
            request: RemoteMobileRequest::Suggestions {
                version: 1,
                agent_id: "agent".into(),
                session_id: "session".into(),
                revision: "r1".into(),
            },
        })
        .unwrap();
    let query = requests(&mut client, &mut host, &mut sequences);
    assert_eq!(
        respond(
            &mut client,
            &mut host,
            query[0].0,
            ResponseResult::RemoteMobile {
                data: RemoteMobileResult::Suggestions {
                    version: 1,
                    agent_id: "agent".into(),
                    session_id: "session".into(),
                    revision: "r2".into(),
                    suggestions: vec!["next".into()]
                }
            }
        )
        .unwrap_err()
        .code,
        "MOBILE_RESPONSE_SCOPE_MISMATCH"
    );
    assert!(client.execute(Intent::Status {}).is_err());
    let id = CanonicalUuid::new(uuid::Uuid::new_v4());
    let request = RemoteMobileRequest::Send {
        version: 1,
        agent_id: "agent".into(),
        session_id: "session".into(),
        operation_id: id,
        text: "send".into(),
        asset_ids: vec![],
        model_id: None,
    };
    assert!(MobileClient::validate_mobile_response(
        &request,
        &mobile_receipt(id, RemoteReceiptStatus::Accepted)
    )
    .is_err());
    let (mut client, mut host, mut sequences) = pair();
    client.profile = MobileProfile::Combined;
    negotiate(&mut client, &mut host, &mut sequences);
    let record = prepared(&mut client, id);
    client
        .call(Intent::Commit {
            operation_id: id,
            digest: record.digest,
        })
        .unwrap();
    let query = requests(&mut client, &mut host, &mut sequences);
    assert!(respond(
        &mut client,
        &mut host,
        query[0].0,
        ResponseResult::RemoteSession {
            data: legacy_receipt(id, RemoteReceiptStatus::Accepted)
        }
    )
    .is_err());
    assert!(client.journal.contains_key(&id.as_uuid().to_string()));
    assert!(!client.confirmed.contains(&id.as_uuid().to_string()));
}

#[test]
fn recovered_mobile_send_receipt_query_requires_original_session() {
    for reported_session in [None, Some("foreign-session")] {
        let (mut source, mut host, mut sequences) = pair();
        source.profile = MobileProfile::Combined;
        negotiate(&mut source, &mut host, &mut sequences);
        let id = CanonicalUuid::new(uuid::Uuid::new_v4());
        let value = source
            .call(Intent::PrepareMobile {
                request: RemoteMobileRequest::Send {
                    version: 1,
                    agent_id: "agent".into(),
                    session_id: "original-session".into(),
                    operation_id: id,
                    text: "send".into(),
                    asset_ids: vec![],
                    model_id: None,
                },
            })
            .unwrap();
        let record: JournalRecord = serde_json::from_value(value["record"].clone()).unwrap();
        let (mut client, mut host, mut sequences) = pair();
        client.profile = MobileProfile::Combined;
        client
            .call(Intent::Recover {
                records: vec![record],
            })
            .unwrap();
        negotiate(&mut client, &mut host, &mut sequences);
        client
            .call(Intent::MobileRequest {
                request: RemoteMobileRequest::Receipt {
                    version: 1,
                    agent_id: "agent".into(),
                    operation_id: id,
                },
            })
            .unwrap();
        let query = requests(&mut client, &mut host, &mut sequences);
        let result = RemoteMobileResult::Receipt {
            version: 1,
            agent_id: "agent".into(),
            operation_id: id,
            session_id: reported_session.map(String::from),
            status: RemoteReceiptStatus::Accepted,
            code: None,
        };
        assert_eq!(
            respond(
                &mut client,
                &mut host,
                query[0].0,
                ResponseResult::RemoteMobile { data: result }
            )
            .unwrap_err()
            .code,
            "MOBILE_RESPONSE_SCOPE_MISMATCH"
        );
        assert!(client.journal.contains_key(&id.as_uuid().to_string()));
        assert!(!client.confirmed.contains(&id.as_uuid().to_string()));
        assert!(client.execute(Intent::Status {}).is_err());
    }
}
