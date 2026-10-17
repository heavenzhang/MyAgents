//! Owned opt-in mobile admission projection. Legacy session.remote DTOs stay frozen.
use crate::{CanonicalUuid, CodecError, RemoteReceiptStatus};
use serde::{Deserialize, Serialize};
pub const REMOTE_MOBILE_BYTES: usize = 48 * 1024;
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum RemoteMobileRequest {
    #[serde(rename = "mobile.capabilities")]
    Capabilities { version: u8, agent_id: String },
    #[serde(rename = "mobile.models")]
    Models { version: u8, agent_id: String },
    #[serde(rename = "mobile.suggestions")]
    Suggestions {
        version: u8,
        agent_id: String,
        session_id: String,
        revision: String,
    },
    #[serde(rename = "mobile.start")]
    Start {
        version: u8,
        agent_id: String,
        operation_id: CanonicalUuid,
        text: String,
        asset_ids: Vec<CanonicalUuid>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "optional_string"
        )]
        model_id: Option<String>,
    },
    #[serde(rename = "mobile.send")]
    Send {
        version: u8,
        agent_id: String,
        session_id: String,
        operation_id: CanonicalUuid,
        text: String,
        asset_ids: Vec<CanonicalUuid>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "optional_string"
        )]
        model_id: Option<String>,
    },
    #[serde(rename = "mobile.receipt")]
    Receipt {
        version: u8,
        agent_id: String,
        operation_id: CanonicalUuid,
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
pub struct RemoteMobileModel {
    pub id: String,
    pub label: String,
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum RemoteMobileResult {
    #[serde(rename = "mobile.capabilities")]
    Capabilities {
        version: u8,
        agent_id: String,
        attachments: bool,
        model_selection: bool,
        next_suggestions: bool,
        max_assets: u8,
    },
    #[serde(rename = "mobile.models")]
    Models {
        version: u8,
        agent_id: String,
        items: Vec<RemoteMobileModel>,
    },
    #[serde(rename = "mobile.suggestions")]
    Suggestions {
        version: u8,
        agent_id: String,
        session_id: String,
        revision: String,
        suggestions: Vec<String>,
    },
    #[serde(rename = "mobile.receipt")]
    Receipt {
        version: u8,
        agent_id: String,
        operation_id: CanonicalUuid,
        #[serde(deserialize_with = "required_nullable")]
        session_id: Option<String>,
        status: RemoteReceiptStatus,
        #[serde(deserialize_with = "required_nullable")]
        code: Option<String>,
    },
    #[serde(rename = "mobile.error")]
    Error { version: u8, code: String },
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
fn length(s: &str, max: usize) -> bool {
    s.encode_utf16().count() <= max
}
fn label(s: &str) -> bool {
    !s.is_empty() && length(s, 256) && !s.chars().any(char::is_control)
}
fn code(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}
fn bounded<T: Serialize>(value: &T) -> bool {
    serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= REMOTE_MOBILE_BYTES)
}
impl RemoteMobileRequest {
    pub fn agent_id(&self) -> &str {
        match self {
            Self::Capabilities { agent_id, .. }
            | Self::Models { agent_id, .. }
            | Self::Suggestions { agent_id, .. }
            | Self::Start { agent_id, .. }
            | Self::Send { agent_id, .. }
            | Self::Receipt { agent_id, .. } => agent_id,
        }
    }
    pub fn operation_id(&self) -> Option<CanonicalUuid> {
        match self {
            Self::Start { operation_id, .. }
            | Self::Send { operation_id, .. }
            | Self::Receipt { operation_id, .. } => Some(*operation_id),
            _ => None,
        }
    }
    pub fn session_id(&self) -> Option<&str> {
        match self {
            Self::Send { session_id, .. } | Self::Suggestions { session_id, .. } => {
                Some(session_id)
            }
            _ => None,
        }
    }
    pub fn mutation(&self) -> bool {
        matches!(self, Self::Start { .. } | Self::Send { .. })
    }
    pub fn validate(&self) -> Result<(), CodecError> {
        let version = match self {
            Self::Capabilities { version, .. }
            | Self::Models { version, .. }
            | Self::Suggestions { version, .. }
            | Self::Start { version, .. }
            | Self::Send { version, .. }
            | Self::Receipt { version, .. } => *version,
        };
        let valid = version == 1
            && agent(self.agent_id())
            && self.session_id().is_none_or(session)
            && match self {
                Self::Suggestions { revision, .. } => length(revision, 128),
                Self::Start {
                    text,
                    asset_ids,
                    model_id,
                    ..
                }
                | Self::Send {
                    text,
                    asset_ids,
                    model_id,
                    ..
                } => {
                    length(text, 16000)
                        && (!text.is_empty() || !asset_ids.is_empty())
                        && asset_ids.len() <= 8
                        && asset_ids
                            .iter()
                            .collect::<std::collections::HashSet<_>>()
                            .len()
                            == asset_ids.len()
                        && model_id.as_deref().is_none_or(label)
                }
                _ => true,
            };
        if valid && bounded(self) {
            Ok(())
        } else {
            Err(CodecError::InvalidFrame)
        }
    }
}
impl RemoteMobileResult {
    pub fn validate(&self) -> Result<(), CodecError> {
        let valid = match self {
            Self::Capabilities {
                version,
                agent_id,
                attachments,
                model_selection,
                next_suggestions,
                max_assets,
            } => {
                *version == 1
                    && agent(agent_id)
                    && *attachments
                    && *model_selection
                    && *next_suggestions
                    && *max_assets == 8
            }
            Self::Models {
                version,
                agent_id,
                items,
            } => {
                *version == 1
                    && agent(agent_id)
                    && items.len() <= 30
                    && items.iter().all(|m| label(&m.id) && label(&m.label))
                    && items
                        .iter()
                        .map(|m| &m.id)
                        .collect::<std::collections::HashSet<_>>()
                        .len()
                        == items.len()
            }
            Self::Suggestions {
                version,
                agent_id,
                session_id,
                revision,
                suggestions,
            } => {
                *version == 1
                    && agent(agent_id)
                    && session(session_id)
                    && length(revision, 128)
                    && suggestions.len() <= 3
                    && suggestions.iter().all(|s| !s.is_empty() && length(s, 512))
            }
            Self::Receipt {
                version,
                agent_id,
                session_id,
                code: receipt_code,
                ..
            } => {
                *version == 1
                    && agent(agent_id)
                    && session_id.as_deref().is_none_or(session)
                    && receipt_code.as_deref().is_none_or(code)
            }
            Self::Error {
                version,
                code: error_code,
            } => *version == 1 && code(error_code),
        };
        if valid && bounded(self) {
            Ok(())
        } else {
            Err(CodecError::InvalidFrame)
        }
    }
}
impl std::fmt::Debug for RemoteMobileRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RemoteMobileRequest { content: [REDACTED] }")
    }
}
impl std::fmt::Debug for RemoteMobileResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RemoteMobileResult { content: [REDACTED] }")
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_mobile_fixtures_are_closed_bounded_and_do_not_expand_legacy() {
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/remote-mobile-v1.json")).unwrap();
        for v in f["requests"].as_array().unwrap() {
            serde_json::from_value::<RemoteMobileRequest>(v.clone())
                .unwrap()
                .validate()
                .unwrap();
            assert!(serde_json::from_value::<crate::RemoteSessionRequest>(v.clone()).is_err());
        }
        for v in f["results"].as_array().unwrap() {
            serde_json::from_value::<RemoteMobileResult>(v.clone())
                .unwrap()
                .validate()
                .unwrap();
        }
        for v in f["invalidRequests"].as_array().unwrap() {
            assert!(
                serde_json::from_value::<RemoteMobileRequest>(v.clone())
                    .map(|v| v.validate().is_err())
                    .unwrap_or(true)
            );
        }
        for v in f["invalidResults"].as_array().unwrap() {
            assert!(
                serde_json::from_value::<RemoteMobileResult>(v.clone())
                    .map(|v| v.validate().is_err())
                    .unwrap_or(true)
            );
        }
    }
}
