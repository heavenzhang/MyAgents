//! Owned bounded asset data profile; independent from session.remote/v1.
use crate::{CanonicalUuid, CodecError};
use serde::{Deserialize, Serialize};
pub const ASSET_MAX_BYTES: u64 = 20 * 1024 * 1024;
pub const ASSET_CHUNK_BYTES: usize = 24 * 1024;
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum RemoteAssetRequest {
    #[serde(rename = "capabilities")]
    Capabilities { version: u8, agent_id: String },
    #[serde(rename = "upload.begin")]
    UploadBegin {
        version: u8,
        agent_id: String,
        upload_id: CanonicalUuid,
        name: String,
        mime_type: String,
        size_bytes: u64,
        sha256: String,
    },
    #[serde(rename = "upload.chunk")]
    UploadChunk {
        version: u8,
        agent_id: String,
        upload_id: CanonicalUuid,
        offset: u64,
        data_base64: String,
        sha256: String,
    },
    #[serde(rename = "upload.status")]
    UploadStatus {
        version: u8,
        agent_id: String,
        upload_id: CanonicalUuid,
    },
    #[serde(rename = "upload.finish")]
    UploadFinish {
        version: u8,
        agent_id: String,
        upload_id: CanonicalUuid,
    },
    #[serde(rename = "upload.cancel")]
    UploadCancel {
        version: u8,
        agent_id: String,
        upload_id: CanonicalUuid,
    },
    #[serde(rename = "list")]
    List {
        version: u8,
        agent_id: String,
        session_id: String,
        limit: u8,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "optional_string"
        )]
        before: Option<String>,
    },
    #[serde(rename = "read")]
    Read {
        version: u8,
        agent_id: String,
        session_id: String,
        artifact_id: CanonicalUuid,
        offset: u64,
        max_bytes: u32,
    },
}
fn optional_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}
fn required_nullable<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteArtifactDescriptor {
    pub artifact_id: CanonicalUuid,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub sha256: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UploadState {
    Uploading,
    Ready,
    Cancelled,
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RemoteAssetResult {
    Capabilities {
        version: u8,
        agent_id: String,
        max_bytes: u64,
        max_chunk_bytes: u32,
    },
    Upload {
        version: u8,
        agent_id: String,
        upload_id: CanonicalUuid,
        received_bytes: u64,
        total_bytes: u64,
        state: UploadState,
    },
    Asset {
        version: u8,
        agent_id: String,
        upload_id: CanonicalUuid,
        asset_id: CanonicalUuid,
        name: String,
        mime_type: String,
        size_bytes: u64,
        sha256: String,
    },
    List {
        version: u8,
        agent_id: String,
        session_id: String,
        items: Vec<RemoteArtifactDescriptor>,
        has_more: bool,
        #[serde(deserialize_with = "required_nullable")]
        next_before: Option<String>,
    },
    Chunk {
        version: u8,
        agent_id: String,
        session_id: String,
        artifact_id: CanonicalUuid,
        offset: u64,
        data_base64: String,
        sha256: String,
        eof: bool,
    },
    Error {
        version: u8,
        code: String,
    },
}
pub fn asset_label(s: &str) -> bool {
    !s.is_empty()
        && s.encode_utf16().count() <= 256
        && !s.chars().any(|c| c.is_control() || c == '/' || c == '\\')
        && s != "."
        && s != ".."
}
pub fn asset_mime(s: &str) -> bool {
    s.len() <= 128
        && s.split_once('/').is_some_and(|(a, b)| {
            !a.is_empty()
                && !b.is_empty()
                && a.bytes()
                    .chain(b.bytes())
                    .all(|c| c.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&c))
        })
}
pub fn asset_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn agent(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn session(s: &str) -> bool {
    !s.is_empty() && s.len() <= 99 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
/// Canonical padded RFC4648; pad bits must be zero. No URL alphabet/whitespace.
pub fn asset_base64_len(s: &str) -> Option<usize> {
    if s.len() > 32768 || !s.len().is_multiple_of(4) {
        return None;
    }
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = s.as_bytes();
    let pad = bytes.iter().rev().take_while(|b| **b == b'=').count();
    if pad > 2
        || bytes[..bytes.len() - pad]
            .iter()
            .any(|b| !alphabet.contains(b))
    {
        return None;
    }
    if pad > 0 {
        let last = *bytes.get(bytes.len() - pad - 1)?;
        let value = alphabet.iter().position(|b| *b == last)?;
        if (pad == 2 && value & 15 != 0) || (pad == 1 && value & 3 != 0) {
            return None;
        }
    }
    Some(s.len() / 4 * 3 - pad)
}
impl RemoteAssetRequest {
    pub fn agent_id(&self) -> &str {
        match self {
            Self::Capabilities { agent_id, .. }
            | Self::UploadBegin { agent_id, .. }
            | Self::UploadChunk { agent_id, .. }
            | Self::UploadStatus { agent_id, .. }
            | Self::UploadFinish { agent_id, .. }
            | Self::UploadCancel { agent_id, .. }
            | Self::List { agent_id, .. }
            | Self::Read { agent_id, .. } => agent_id,
        }
    }
    pub fn version(&self) -> u8 {
        match self {
            Self::Capabilities { version, .. }
            | Self::UploadBegin { version, .. }
            | Self::UploadChunk { version, .. }
            | Self::UploadStatus { version, .. }
            | Self::UploadFinish { version, .. }
            | Self::UploadCancel { version, .. }
            | Self::List { version, .. }
            | Self::Read { version, .. } => *version,
        }
    }
    pub fn upload_id(&self) -> Option<CanonicalUuid> {
        match self {
            Self::UploadBegin { upload_id, .. }
            | Self::UploadChunk { upload_id, .. }
            | Self::UploadStatus { upload_id, .. }
            | Self::UploadFinish { upload_id, .. }
            | Self::UploadCancel { upload_id, .. } => Some(*upload_id),
            _ => None,
        }
    }
    pub fn validate(&self) -> Result<(), CodecError> {
        let ok = self.version() == 1
            && agent(self.agent_id())
            && match self {
                Self::UploadBegin {
                    name,
                    mime_type,
                    size_bytes,
                    sha256,
                    ..
                } => {
                    asset_label(name)
                        && asset_mime(mime_type)
                        && (1..=ASSET_MAX_BYTES).contains(size_bytes)
                        && asset_hash(sha256)
                }
                Self::UploadChunk {
                    offset,
                    data_base64,
                    sha256,
                    ..
                } => {
                    *offset < ASSET_MAX_BYTES
                        && asset_base64_len(data_base64)
                            .is_some_and(|n| (1..=ASSET_CHUNK_BYTES).contains(&n))
                        && asset_hash(sha256)
                }
                Self::List {
                    session_id,
                    limit,
                    before,
                    ..
                } => {
                    session(session_id)
                        && (1..=30).contains(limit)
                        && before
                            .as_ref()
                            .is_none_or(|s| !s.is_empty() && s.len() <= 256)
                }
                Self::Read {
                    session_id,
                    offset,
                    max_bytes,
                    ..
                } => {
                    session(session_id)
                        && *offset <= ASSET_MAX_BYTES
                        && (1..=ASSET_CHUNK_BYTES as u32).contains(max_bytes)
                }
                _ => true,
            };
        if ok {
            Ok(())
        } else {
            Err(CodecError::InvalidFrame)
        }
    }
}
impl RemoteArtifactDescriptor {
    pub fn validate(&self) -> bool {
        asset_label(&self.name)
            && asset_mime(&self.mime_type)
            && (1..=ASSET_MAX_BYTES).contains(&self.size_bytes)
            && asset_hash(&self.sha256)
    }
}
impl RemoteAssetResult {
    pub fn validate(&self) -> Result<(), CodecError> {
        let ok = match self {
            Self::Capabilities {
                version,
                agent_id,
                max_bytes,
                max_chunk_bytes,
            } => {
                *version == 1
                    && agent(agent_id)
                    && *max_bytes == ASSET_MAX_BYTES
                    && *max_chunk_bytes == ASSET_CHUNK_BYTES as u32
            }
            Self::Upload {
                version,
                agent_id,
                received_bytes,
                total_bytes,
                ..
            } => {
                *version == 1
                    && agent(agent_id)
                    && (1..=ASSET_MAX_BYTES).contains(total_bytes)
                    && received_bytes <= total_bytes
            }
            Self::Asset {
                version,
                agent_id,
                name,
                mime_type,
                size_bytes,
                sha256,
                ..
            } => {
                *version == 1
                    && agent(agent_id)
                    && asset_label(name)
                    && asset_mime(mime_type)
                    && (1..=ASSET_MAX_BYTES).contains(size_bytes)
                    && asset_hash(sha256)
            }
            Self::List {
                version,
                agent_id,
                session_id,
                items,
                has_more,
                next_before,
            } => {
                *version == 1
                    && agent(agent_id)
                    && session(session_id)
                    && items.len() <= 30
                    && items.iter().all(RemoteArtifactDescriptor::validate)
                    && (*has_more == next_before.is_some())
                    && next_before
                        .as_ref()
                        .is_none_or(|s| !s.is_empty() && s.len() <= 256)
            }
            Self::Chunk {
                version,
                agent_id,
                session_id,
                offset,
                data_base64,
                sha256,
                eof,
                ..
            } => {
                *version == 1
                    && agent(agent_id)
                    && session(session_id)
                    && *offset <= ASSET_MAX_BYTES
                    && asset_base64_len(data_base64).is_some_and(|n| {
                        n <= ASSET_CHUNK_BYTES
                            && (n > 0 || *eof)
                            && *offset + n as u64 <= ASSET_MAX_BYTES
                    })
                    && asset_hash(sha256)
            }
            Self::Error { version, code } => {
                *version == 1
                    && !code.is_empty()
                    && code.len() <= 128
                    && code
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            }
        };
        if ok {
            Ok(())
        } else {
            Err(CodecError::InvalidFrame)
        }
    }
}

// File bytes and user labels are deliberately absent from Debug/log projections.
impl std::fmt::Debug for RemoteAssetRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RemoteAssetRequest { content: [REDACTED] }")
    }
}
impl std::fmt::Debug for RemoteAssetResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RemoteAssetResult { content: [REDACTED] }")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_rust_zod_asset_fixtures_are_closed_and_bounded() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/remote-assets-v1.json")).unwrap();
        for value in fixture["requests"].as_array().unwrap() {
            serde_json::from_value::<RemoteAssetRequest>(value.clone())
                .unwrap()
                .validate()
                .unwrap();
        }
        for value in fixture["results"].as_array().unwrap() {
            serde_json::from_value::<RemoteAssetResult>(value.clone())
                .unwrap()
                .validate()
                .unwrap();
        }
        for value in fixture["invalidRequests"].as_array().unwrap() {
            assert!(
                serde_json::from_value::<RemoteAssetRequest>(value.clone())
                    .map(|v| v.validate().is_err())
                    .unwrap_or(true)
            );
        }
        for value in fixture["invalidResults"].as_array().unwrap() {
            assert!(
                serde_json::from_value::<RemoteAssetResult>(value.clone())
                    .map(|v| v.validate().is_err())
                    .unwrap_or(true)
            );
        }
    }
}
