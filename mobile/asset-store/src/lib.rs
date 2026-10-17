//! Private scoped asset byte owner. No runtime, executor, network or caller paths.
use base64::{engine::general_purpose::STANDARD, Engine};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use fs2::FileExt;
use myagents_host_management_protocol::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
const SCOPE_BYTES: u64 = 160 * 1024 * 1024;
const GLOBAL_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_RECORDS: usize = 1024;
const MAX_SCOPE_RECORDS: usize = 128;
const META_LIMIT: u64 = 256 * 1024;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetScope {
    pub issuer: String,
    pub service_id: CanonicalUuid,
    pub environment: String,
    pub network_id: CanonicalUuid,
    pub principal_id: String,
    pub controller_device_id: CanonicalUuid,
    pub controller_key_generation: u64,
    pub target_device_id: CanonicalUuid,
    pub agent_id: String,
}
impl AssetScope {
    fn validate(&self) -> Result<(), StoreError> {
        let url = url::Url::parse(&self.issuer).map_err(|_| err("ASSET_SCOPE_INVALID"))?;
        if url.scheme() != "https"
            || url.origin().ascii_serialization() != self.issuer
            || !["production", "development"].contains(&self.environment.as_str())
            || self.principal_id.is_empty()
            || self.principal_id.len() > 256
            || self.controller_key_generation == 0
            || self.controller_key_generation > MAX_SAFE_SEQUENCE
        {
            return Err(err("ASSET_SCOPE_INVALID"));
        }
        RemoteAssetRequest::Capabilities {
            version: 1,
            agent_id: self.agent_id.clone(),
        }
        .validate()
        .map_err(|_| err("ASSET_SCOPE_INVALID"))
    }
    fn key(&self) -> Result<String, StoreError> {
        self.validate()?;
        Ok(hash(
            &serde_json::to_vec(self).map_err(|_| err("ASSET_SCOPE_INVALID"))?,
        ))
    }
}
#[derive(Debug)]
pub struct StoreError {
    pub code: &'static str,
}
fn err(code: &'static str) -> StoreError {
    StoreError { code }
}
impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code)
    }
}
impl std::error::Error for StoreError {}
impl From<std::io::Error> for StoreError {
    fn from(_: std::io::Error) -> Self {
        err("ASSET_IO_FAILED")
    }
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct Chunk {
    offset: u64,
    len: u32,
    sha256: String,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct Record {
    scope: AssetScope,
    id: CanonicalUuid,
    asset_id: CanonicalUuid,
    name: String,
    mime_type: String,
    size: u64,
    sha256: String,
    state: UploadState,
    received: u64,
    chunks: Vec<Chunk>,
    created: u64,
    updated: u64,
    session: Option<String>,
}
/// Native trusted output owner selects the root and relative path; never decode from RPC.
pub struct TrustedArtifactSource {
    dir: Dir,
    relative: PathBuf,
}
impl TrustedArtifactSource {
    pub fn from_owner(root: &Path, relative: &Path) -> Result<Self, StoreError> {
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(err("ASSET_PATH_INVALID"));
        }
        let dir = Dir::open_ambient_dir(root, cap_std::ambient_authority())?;
        Ok(Self {
            dir,
            relative: relative.to_owned(),
        })
    }
    fn open(&self) -> Result<File, StoreError> {
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let file = self.dir.open_with(&self.relative, &options)?;
        if !file.metadata()?.is_file() {
            return Err(err("ASSET_PATH_INVALID"));
        }
        let file = file.into_std();
        regular_file(&file)?;
        Ok(file)
    }
}
/// The held file/shared lock prevents scoped cancellation or TTL cleanup while in use.
pub struct ReadyAssetLease {
    path: PathBuf,
    file: File,
    pub name: String,
    pub mime_type: String,
    pub sha256: String,
    pub size_bytes: u64,
}
impl ReadyAssetLease {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn file(&self) -> &File {
        &self.file
    }
}
pub struct AssetStore {
    root: Dir,
    path: PathBuf,
}
impl AssetStore {
    /// Root must be provisioned by the native private-app-directory owner (Windows ACL too).
    pub fn open(root: &Path) -> Result<Self, StoreError> {
        if !root.is_absolute() {
            return Err(err("ASSET_PATH_INVALID"));
        }
        let meta = std::fs::symlink_metadata(root)?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(err("ASSET_PATH_INVALID"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
                return Err(err("ASSET_ROOT_NOT_PRIVATE"));
            }
        }
        let path = root.canonicalize()?;
        let dir = Dir::open_ambient_dir(&path, cap_std::ambient_authority())?;
        let store = Self { root: dir, path };
        let _lock = store.lock()?;
        Ok(store)
    }
    fn lock(&self) -> Result<File, StoreError> {
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create(true)
            .follow(FollowSymlinks::No);
        let file = self.root.open_with(".lock", &options)?.into_std();
        private_file(&file)?;
        file.lock_exclusive()?;
        Ok(file)
    }
    fn scope_dir(&self, scope: &AssetScope) -> Result<Dir, StoreError> {
        let key = scope.key()?;
        match self.root.create_dir(&key) {
            Ok(()) => {
                let dir = self.root.open_dir_nofollow(&key)?;
                private_dir(&dir)?;
                sync_dir(&self.root)?;
                Ok(dir)
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                Ok(self.root.open_dir_nofollow(&key)?)
            }
            Err(e) => Err(e.into()),
        }
    }
    fn record_dir(dir: &Dir, id: CanonicalUuid) -> Result<Dir, StoreError> {
        Ok(dir.open_dir_nofollow(id.as_uuid().to_string())?)
    }
    fn load(dir: &Dir) -> Result<Record, StoreError> {
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let file = dir.open_with("meta.json", &options)?.into_std();
        regular_file(&file)?;
        if !file.metadata()?.is_file() || file.metadata()?.len() > META_LIMIT {
            return Err(err("ASSET_RECORD_CORRUPT"));
        }
        let record: Record =
            serde_json::from_reader(file).map_err(|_| err("ASSET_RECORD_CORRUPT"))?;
        record
            .scope
            .validate()
            .map_err(|_| err("ASSET_RECORD_CORRUPT"))?;
        if !asset_label(&record.name)
            || !asset_mime(&record.mime_type)
            || !asset_hash(&record.sha256)
            || !(1..=ASSET_MAX_BYTES).contains(&record.size)
            || record.received > record.size
            || record.chunks.len() > 1024
        {
            return Err(err("ASSET_RECORD_CORRUPT"));
        }
        Ok(record)
    }
    fn save(dir: &Dir, record: &Record) -> Result<(), StoreError> {
        let bytes = serde_json::to_vec(record).map_err(|_| err("ASSET_RECORD_CORRUPT"))?;
        if bytes.len() as u64 > META_LIMIT {
            return Err(err("ASSET_RECORD_LIMIT"));
        }
        let temp = format!("{}.tmp", uuid::Uuid::new_v4());
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        let mut file = dir.open_with(&temp, &options)?.into_std();
        private_file(&file)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        dir.rename(&temp, dir, "meta.json")?;
        sync_dir(dir)
    }
    fn records(dir: &Dir) -> Result<Vec<(String, Record)>, StoreError> {
        let mut records = Vec::new();
        for entry in dir.entries()? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if CanonicalUuid::parse(&name).is_err() {
                continue;
            }
            if records.len() >= MAX_SCOPE_RECORDS {
                return Err(err("ASSET_RECORD_LIMIT"));
            }
            let child = dir.open_dir_nofollow(&name)?;
            records.push((name, Self::load(&child)?));
        }
        Ok(records)
    }
    fn reserved(scope_dir: &Dir, id: &str, record: &Record) -> Result<u64, StoreError> {
        if record.state == UploadState::Cancelled {
            let dir = scope_dir.open_dir_nofollow(id)?;
            match dir.symlink_metadata("data") {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
                Ok(meta) if meta.is_file() => {}
                _ => return Err(err("ASSET_PATH_INVALID")),
            }
        }
        Ok(record.size)
    }
    fn quota(&self, scope_dir: &Dir, size: u64) -> Result<(), StoreError> {
        let scope_records = Self::records(scope_dir)?;
        if scope_records.len() >= MAX_SCOPE_RECORDS {
            return Err(err("ASSET_RECORD_LIMIT"));
        }
        let active = scope_records
            .iter()
            .filter(|(_, r)| r.session.is_none() && r.state == UploadState::Uploading)
            .count();
        let mut scope_bytes = 0u64;
        for (id, record) in &scope_records {
            scope_bytes += Self::reserved(scope_dir, id, record)?;
        }
        if active >= 8
            || scope_bytes
                .checked_add(size)
                .is_none_or(|n| n > SCOPE_BYTES)
        {
            return Err(err("ASSET_SCOPE_QUOTA"));
        }
        let mut bytes = 0u64;
        let mut count = 0;
        let mut scopes = 0;
        for entry in self.root.entries()? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name == ".lock" {
                continue;
            }
            if name.len() != 64 || !name.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(err("ASSET_RECORD_CORRUPT"));
            }
            scopes += 1;
            if scopes > 256 {
                return Err(err("ASSET_GLOBAL_QUOTA"));
            }
            let scope_dir = self.root.open_dir_nofollow(name)?;
            for (id, r) in Self::records(&scope_dir)? {
                count += 1;
                bytes = bytes
                    .checked_add(Self::reserved(&scope_dir, &id, &r)?)
                    .ok_or_else(|| err("ASSET_GLOBAL_QUOTA"))?;
            }
        }
        if count >= MAX_RECORDS || bytes.checked_add(size).is_none_or(|n| n > GLOBAL_BYTES) {
            return Err(err("ASSET_GLOBAL_QUOTA"));
        }
        Ok(())
    }
    fn data(dir: &Dir, write: bool) -> Result<File, StoreError> {
        let mut options = OpenOptions::new();
        options.read(true).write(write).follow(FollowSymlinks::No);
        let file = dir.open_with("data", &options)?.into_std();
        regular_file(&file)?;
        Ok(file)
    }
    fn verify(dir: &Dir, record: &Record) -> Result<File, StoreError> {
        let mut file = Self::data(dir, record.state == UploadState::Uploading)?;
        if file.metadata()?.len() < record.received
            || record.received > record.size
            || record.chunks.len() > 1024
        {
            return Err(err("ASSET_DATA_CORRUPT"));
        }
        let mut offset = 0u64;
        for chunk in &record.chunks {
            if chunk.offset != offset || chunk.len == 0 || chunk.len as usize > ASSET_CHUNK_BYTES {
                return Err(err("ASSET_DATA_CORRUPT"));
            }
            let mut data = vec![0; chunk.len as usize];
            file.read_exact(&mut data)?;
            if hash(&data) != chunk.sha256 {
                return Err(err("ASSET_DATA_CORRUPT"));
            }
            offset += chunk.len as u64;
        }
        if offset != record.received {
            return Err(err("ASSET_DATA_CORRUPT"));
        }
        if file.metadata()?.len() > record.received {
            if record.state != UploadState::Uploading {
                return Err(err("ASSET_DATA_CORRUPT"));
            }
            file.set_len(record.received)?;
            file.sync_all()?;
        }
        Ok(file)
    }
    fn scoped_record(
        &self,
        scope: &AssetScope,
        id: CanonicalUuid,
    ) -> Result<(Dir, Record), StoreError> {
        let dir =
            Self::record_dir(&self.scope_dir(scope)?, id).map_err(|_| err("ASSET_NOT_FOUND"))?;
        let r = Self::load(&dir)?;
        if r.scope != *scope || r.id != id {
            return Err(err("ASSET_SCOPE_MISMATCH"));
        }
        Ok((dir, r))
    }
    fn upload_result(record: &Record) -> RemoteAssetResult {
        RemoteAssetResult::Upload {
            version: 1,
            agent_id: record.scope.agent_id.clone(),
            upload_id: record.id,
            received_bytes: record.received,
            total_bytes: record.size,
            state: record.state.clone(),
        }
    }
    fn asset_result(record: &Record) -> RemoteAssetResult {
        RemoteAssetResult::Asset {
            version: 1,
            agent_id: record.scope.agent_id.clone(),
            upload_id: record.id,
            asset_id: record.asset_id,
            name: record.name.clone(),
            mime_type: record.mime_type.clone(),
            size_bytes: record.size,
            sha256: record.sha256.clone(),
        }
    }
    pub fn execute(
        &self,
        scope: &AssetScope,
        request: &RemoteAssetRequest,
    ) -> Result<RemoteAssetResult, StoreError> {
        scope.validate()?;
        request
            .validate()
            .map_err(|_| err("ASSET_REQUEST_INVALID"))?;
        if request.agent_id() != scope.agent_id {
            return Err(err("ASSET_SCOPE_MISMATCH"));
        }
        let _lock = self.lock()?;
        match request {
            RemoteAssetRequest::Capabilities { .. } => Ok(RemoteAssetResult::Capabilities {
                version: 1,
                agent_id: scope.agent_id.clone(),
                max_bytes: ASSET_MAX_BYTES,
                max_chunk_bytes: ASSET_CHUNK_BYTES as u32,
            }),
            RemoteAssetRequest::UploadBegin {
                upload_id,
                name,
                mime_type,
                size_bytes,
                sha256,
                ..
            } => {
                let scope_dir = self.scope_dir(scope)?;
                let id = upload_id.as_uuid().to_string();
                if scope_dir.symlink_metadata(&id).is_ok() {
                    let dir = Self::record_dir(&scope_dir, *upload_id)?;
                    let r = Self::load(&dir)?;
                    if r.scope != *scope
                        || r.name != *name
                        || r.mime_type != *mime_type
                        || r.size != *size_bytes
                        || r.sha256 != *sha256
                        || r.session.is_some()
                    {
                        return Err(err("ASSET_UPLOAD_CONFLICT"));
                    }
                    if r.state == UploadState::Cancelled {
                        return Err(err("ASSET_UPLOAD_CANCELLED"));
                    }
                    Self::verify(&dir, &r)?;
                    return Ok(Self::upload_result(&r));
                }
                self.quota(&scope_dir, *size_bytes)?;
                scope_dir.create_dir(&id)?;
                let dir = Self::record_dir(&scope_dir, *upload_id)?;
                private_dir(&dir)?;
                let mut options = OpenOptions::new();
                options
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .follow(FollowSymlinks::No);
                let data = dir.open_with("data", &options)?.into_std();
                private_file(&data)?;
                data.sync_all()?;
                let record = Record {
                    scope: scope.clone(),
                    id: *upload_id,
                    asset_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
                    name: name.clone(),
                    mime_type: mime_type.clone(),
                    size: *size_bytes,
                    sha256: sha256.clone(),
                    state: UploadState::Uploading,
                    received: 0,
                    chunks: Vec::new(),
                    created: now(),
                    updated: now(),
                    session: None,
                };
                Self::save(&dir, &record)?;
                sync_dir(&scope_dir)?;
                Ok(Self::upload_result(&record))
            }
            RemoteAssetRequest::UploadChunk {
                upload_id,
                offset,
                data_base64,
                sha256,
                ..
            } => {
                let (dir, mut record) = self.scoped_record(scope, *upload_id)?;
                if record.session.is_some() || record.state == UploadState::Cancelled {
                    return Err(err("ASSET_UPLOAD_CANCELLED"));
                }
                let data = STANDARD
                    .decode(data_base64)
                    .map_err(|_| err("ASSET_CHUNK_INVALID"))?;
                if hash(&data) != *sha256 {
                    return Err(err("ASSET_CHUNK_HASH_MISMATCH"));
                }
                let mut file = Self::verify(&dir, &record)?;
                if *offset < record.received {
                    let duplicate = record.chunks.iter().any(|c| {
                        c.offset == *offset && c.len as usize == data.len() && c.sha256 == *sha256
                    });
                    return if duplicate {
                        Ok(Self::upload_result(&record))
                    } else {
                        Err(err("ASSET_CHUNK_CONFLICT"))
                    };
                }
                if record.state != UploadState::Uploading
                    || *offset != record.received
                    || offset
                        .checked_add(data.len() as u64)
                        .is_none_or(|n| n > record.size)
                {
                    return Err(err("ASSET_CHUNK_ORDER"));
                }
                file.seek(SeekFrom::Start(*offset))?;
                file.write_all(&data)?;
                file.sync_all()?;
                record.chunks.push(Chunk {
                    offset: *offset,
                    len: data.len() as u32,
                    sha256: sha256.clone(),
                });
                record.received += data.len() as u64;
                record.updated = now();
                Self::save(&dir, &record)?;
                Ok(Self::upload_result(&record))
            }
            RemoteAssetRequest::UploadStatus { upload_id, .. } => {
                let (dir, r) = self.scoped_record(scope, *upload_id)?;
                if r.session.is_some() {
                    return Err(err("ASSET_NOT_FOUND"));
                }
                if r.state != UploadState::Cancelled {
                    Self::verify(&dir, &r)?;
                }
                Ok(Self::upload_result(&r))
            }
            RemoteAssetRequest::UploadFinish { upload_id, .. } => {
                let (dir, mut r) = self.scoped_record(scope, *upload_id)?;
                if r.session.is_some() || r.state == UploadState::Cancelled {
                    return Err(err("ASSET_UPLOAD_CANCELLED"));
                }
                let mut file = Self::verify(&dir, &r)?;
                if r.received != r.size {
                    return Err(err("ASSET_UPLOAD_INCOMPLETE"));
                }
                file.seek(SeekFrom::Start(0))?;
                if hash_file(&mut file)? != r.sha256 {
                    return Err(err("ASSET_HASH_MISMATCH"));
                }
                r.state = UploadState::Ready;
                r.updated = now();
                Self::save(&dir, &r)?;
                Ok(Self::asset_result(&r))
            }
            RemoteAssetRequest::UploadCancel { upload_id, .. } => {
                let (dir, mut r) = self.scoped_record(scope, *upload_id)?;
                if r.session.is_some() {
                    return Err(err("ASSET_NOT_FOUND"));
                }
                if r.state != UploadState::Cancelled {
                    let data = Self::data(&dir, false)?;
                    data.try_lock_exclusive().map_err(|_| err("ASSET_IN_USE"))?;
                    r.state = UploadState::Cancelled;
                    r.updated = now();
                    Self::save(&dir, &r)?;
                    drop(data);
                }
                match dir.symlink_metadata("data") {
                    Ok(_) => {
                        let data = Self::data(&dir, false)?;
                        data.try_lock_exclusive().map_err(|_| err("ASSET_IN_USE"))?;
                        drop(data);
                        dir.remove_file("data")?;
                        sync_dir(&dir)?;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
                Ok(Self::upload_result(&r))
            }
            RemoteAssetRequest::List {
                session_id,
                limit,
                before,
                ..
            } => {
                let after = match before {
                    None => None,
                    Some(s) => Some(
                        CanonicalUuid::parse(s)
                            .map_err(|_| err("ASSET_CURSOR_INVALID"))?
                            .as_uuid()
                            .to_string(),
                    ),
                };
                let mut items: Vec<_> = Self::records(&self.scope_dir(scope)?)?
                    .into_iter()
                    .map(|(_, r)| r)
                    .filter(|r| {
                        r.scope == *scope
                            && r.session.as_ref() == Some(session_id)
                            && r.state == UploadState::Ready
                            && after
                                .as_ref()
                                .is_none_or(|id| r.id.as_uuid().to_string() > *id)
                    })
                    .map(|r| descriptor(&r))
                    .collect();
                items.sort_by_key(|d| d.artifact_id.as_uuid().to_string());
                let has_more = items.len() > *limit as usize;
                items.truncate(*limit as usize);
                let next_before = if has_more {
                    items.last().map(|d| d.artifact_id.as_uuid().to_string())
                } else {
                    None
                };
                Ok(RemoteAssetResult::List {
                    version: 1,
                    agent_id: scope.agent_id.clone(),
                    session_id: session_id.clone(),
                    items,
                    has_more,
                    next_before,
                })
            }
            RemoteAssetRequest::Read {
                session_id,
                artifact_id,
                offset,
                max_bytes,
                ..
            } => {
                let (dir, r) = self.scoped_record(scope, *artifact_id)?;
                if r.state != UploadState::Ready || r.session.as_ref() != Some(session_id) {
                    return Err(err("ASSET_NOT_FOUND"));
                }
                if *offset > r.size {
                    return Err(err("ASSET_READ_RANGE"));
                }
                let mut file = Self::data(&dir, false)?;
                file.lock_shared()?;
                file.seek(SeekFrom::Start(*offset))?;
                let mut data = vec![0; ((*max_bytes as u64).min(r.size - *offset)) as usize];
                file.read_exact(&mut data)?;
                Ok(RemoteAssetResult::Chunk {
                    version: 1,
                    agent_id: scope.agent_id.clone(),
                    session_id: session_id.clone(),
                    artifact_id: *artifact_id,
                    offset: *offset,
                    data_base64: STANDARD.encode(&data),
                    sha256: hash(&data),
                    eof: *offset + data.len() as u64 == r.size,
                })
            }
        }
    }
    pub fn ready_asset_lease(
        &self,
        scope: &AssetScope,
        asset_id: CanonicalUuid,
    ) -> Result<ReadyAssetLease, StoreError> {
        let _lock = self.lock()?;
        for (id, r) in Self::records(&self.scope_dir(scope)?)? {
            if r.scope == *scope
                && r.asset_id == asset_id
                && r.session.is_none()
                && r.state == UploadState::Ready
            {
                let dir = self.scope_dir(scope)?.open_dir_nofollow(&id)?;
                let mut file = Self::verify(&dir, &r)?;
                file.seek(SeekFrom::Start(0))?;
                if hash_file(&mut file)? != r.sha256 {
                    return Err(err("ASSET_DATA_CORRUPT"));
                }
                file.lock_shared()?;
                return Ok(ReadyAssetLease {
                    path: self.path.join(scope.key()?).join(id).join("data"),
                    file,
                    name: r.name,
                    mime_type: r.mime_type,
                    sha256: r.sha256,
                    size_bytes: r.size,
                });
            }
        }
        Err(err("ASSET_NOT_FOUND"))
    }
    pub fn register_artifact(
        &self,
        scope: &AssetScope,
        session_id: &str,
        source: &TrustedArtifactSource,
        name: &str,
        mime_type: &str,
    ) -> Result<RemoteArtifactDescriptor, StoreError> {
        RemoteAssetRequest::List {
            version: 1,
            agent_id: scope.agent_id.clone(),
            session_id: session_id.into(),
            limit: 1,
            before: None,
        }
        .validate()
        .map_err(|_| err("ASSET_REQUEST_INVALID"))?;
        if !asset_label(name) || !asset_mime(mime_type) {
            return Err(err("ASSET_REQUEST_INVALID"));
        }
        let mut source = source.open()?;
        let size = source.metadata()?.len();
        if !(1..=ASSET_MAX_BYTES).contains(&size) {
            return Err(err("ASSET_SIZE_LIMIT"));
        }
        let source_hash = hash_file(&mut source)?;
        source.seek(SeekFrom::Start(0))?;
        let _lock = self.lock()?;
        let scope_dir = self.scope_dir(scope)?;
        // Repeated owner pages must preserve opaque IDs instead of copying the
        // same immutable result and consuming quota on each refresh. Equality
        // includes the authenticated scope, session and complete file content.
        for (_, record) in Self::records(&scope_dir)? {
            if record.scope == *scope
                && record.session.as_deref() == Some(session_id)
                && record.state == UploadState::Ready
                && record.name == name
                && record.mime_type == mime_type
                && record.size == size
                && record.sha256 == source_hash
            {
                return Ok(descriptor(&record));
            }
        }
        self.quota(&scope_dir, size)?;
        let id = CanonicalUuid::new(uuid::Uuid::new_v4());
        scope_dir.create_dir(id.as_uuid().to_string())?;
        let dir = Self::record_dir(&scope_dir, id)?;
        private_dir(&dir)?;
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        let mut file = dir.open_with("data", &options)?.into_std();
        private_file(&file)?;
        let copied = std::io::copy(&mut Read::by_ref(&mut source).take(size + 1), &mut file)?;
        if copied != size {
            return Err(err("ASSET_SOURCE_CHANGED"));
        }
        file.sync_all()?;
        drop(file);
        let mut file = Self::data(&dir, false)?;
        let digest = hash_file(&mut file)?;
        if digest != source_hash {
            return Err(err("ASSET_SOURCE_CHANGED"));
        }
        let r = Record {
            scope: scope.clone(),
            id,
            asset_id: id,
            name: name.into(),
            mime_type: mime_type.into(),
            size,
            sha256: digest,
            state: UploadState::Ready,
            received: size,
            chunks: Vec::new(),
            created: now(),
            updated: now(),
            session: Some(session_id.into()),
        };
        Self::save(&dir, &r)?;
        sync_dir(&scope_dir)?;
        Ok(descriptor(&r))
    }
    /// Explicit bounded cleanup only. Nonexpired pending uploads are never quota-evicted.
    pub fn cleanup_expired(
        &self,
        scope: &AssetScope,
        at: u64,
        limit: usize,
    ) -> Result<usize, StoreError> {
        let _lock = self.lock()?;
        let dir = self.scope_dir(scope)?;
        let mut removed = 0;
        for (id, r) in Self::records(&dir)? {
            if removed >= limit.min(32) {
                break;
            }
            let ttl = if r.state == UploadState::Uploading {
                3600
            } else {
                86400
            };
            if r.scope != *scope || at < r.updated.saturating_add(ttl) {
                continue;
            }
            let child = dir.open_dir_nofollow(&id)?;
            let file = Self::data(&child, false).ok();
            if let Some(file) = &file {
                if file.try_lock_exclusive().is_err() {
                    continue;
                }
            }
            drop(file);
            child.remove_open_dir_all()?;
            removed += 1;
        }
        sync_dir(&dir)?;
        if dir.entries()?.next().is_none() {
            dir.remove_open_dir()?;
            sync_dir(&self.root)?;
        }
        Ok(removed)
    }
}
fn descriptor(r: &Record) -> RemoteArtifactDescriptor {
    RemoteArtifactDescriptor {
        artifact_id: r.id,
        name: r.name.clone(),
        mime_type: r.mime_type.clone(),
        size_bytes: r.size,
        sha256: r.sha256.clone(),
    }
}
fn hash_file(file: &mut File) -> Result<String, StoreError> {
    let mut digest = Sha256::new();
    let mut buf = [0u8; 24576];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        digest.update(&buf[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn regular_file(file: &File) -> Result<(), StoreError> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(err("ASSET_PATH_INVALID"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(err("ASSET_PATH_INVALID"));
        }
    }
    Ok(())
}
fn private_file(file: &File) -> Result<(), StoreError> {
    regular_file(file)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
fn private_dir(dir: &Dir) -> Result<(), StoreError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        dir.set_permissions(
            ".",
            cap_std::fs::Permissions::from_std(std::fs::Permissions::from_mode(0o700)),
        )?;
    }
    Ok(())
}
fn sync_dir(dir: &Dir) -> Result<(), StoreError> {
    // Linux cap-std directory handles can be O_PATH: cloning retains that
    // mode and fsync fails with EBADF. Reopen the anchored directory read-only
    // while retaining no-follow confinement and propagate durability errors.
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    dir.open_with(".", &options)?.into_std().sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope() -> AssetScope {
        AssetScope {
            issuer: "https://owned.invalid".into(),
            service_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
            environment: "development".into(),
            network_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
            principal_id: "owner".into(),
            controller_device_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
            controller_key_generation: 1,
            target_device_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
            agent_id: "agent".into(),
        }
    }
    fn setup() -> (tempfile::TempDir, AssetStore, AssetScope) {
        let root = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let store = AssetStore::open(root.path()).unwrap();
        (root, store, scope())
    }
    fn begin(s: &AssetScope, id: CanonicalUuid, data: &[u8]) -> RemoteAssetRequest {
        RemoteAssetRequest::UploadBegin {
            version: 1,
            agent_id: s.agent_id.clone(),
            upload_id: id,
            name: "safe-label.txt".into(),
            mime_type: "text/plain".into(),
            size_bytes: data.len() as u64,
            sha256: hash(data),
        }
    }
    fn chunk(s: &AssetScope, id: CanonicalUuid, offset: u64, data: &[u8]) -> RemoteAssetRequest {
        RemoteAssetRequest::UploadChunk {
            version: 1,
            agent_id: s.agent_id.clone(),
            upload_id: id,
            offset,
            data_base64: STANDARD.encode(data),
            sha256: hash(data),
        }
    }
    fn status(s: &AssetScope, id: CanonicalUuid) -> RemoteAssetRequest {
        RemoteAssetRequest::UploadStatus {
            version: 1,
            agent_id: s.agent_id.clone(),
            upload_id: id,
        }
    }
    fn finish(s: &AssetScope, id: CanonicalUuid) -> RemoteAssetRequest {
        RemoteAssetRequest::UploadFinish {
            version: 1,
            agent_id: s.agent_id.clone(),
            upload_id: id,
        }
    }
    #[test]
    fn durable_chunks_restart_exact_duplicates_and_verified_finish() {
        let (root, store, s) = setup();
        let id = CanonicalUuid::new(uuid::Uuid::new_v4());
        let data = vec![7; ASSET_CHUNK_BYTES + 13];
        store.execute(&s, &begin(&s, id, &data)).unwrap();
        let c = chunk(&s, id, 0, &data[..ASSET_CHUNK_BYTES]);
        store.execute(&s, &c).unwrap();
        drop(store);
        let store = AssetStore::open(root.path()).unwrap();
        let result = store.execute(&s, &status(&s, id)).unwrap();
        assert!(
            matches!(result,RemoteAssetResult::Upload{received_bytes,..}if received_bytes==ASSET_CHUNK_BYTES as u64)
        );
        assert_eq!(store.execute(&s, &c).unwrap(), result);
        assert_eq!(
            store
                .execute(&s, &chunk(&s, id, 0, b"conflicting"))
                .unwrap_err()
                .code,
            "ASSET_CHUNK_CONFLICT"
        );
        assert_eq!(
            store
                .execute(&s, &chunk(&s, id, ASSET_CHUNK_BYTES as u64 + 1, b"gap"))
                .unwrap_err()
                .code,
            "ASSET_CHUNK_ORDER"
        );
        assert_eq!(
            store.execute(&s, &finish(&s, id)).unwrap_err().code,
            "ASSET_UPLOAD_INCOMPLETE"
        );
        store
            .execute(
                &s,
                &chunk(&s, id, ASSET_CHUNK_BYTES as u64, &data[ASSET_CHUNK_BYTES..]),
            )
            .unwrap();
        let finished = store.execute(&s, &finish(&s, id)).unwrap();
        assert_eq!(store.execute(&s, &finish(&s, id)).unwrap(), finished);
        let RemoteAssetResult::Asset { asset_id, .. } = finished else {
            panic!()
        };
        let lease = store.ready_asset_lease(&s, asset_id).unwrap();
        assert_eq!(std::fs::read(lease.path()).unwrap(), data);
        let cancel = RemoteAssetRequest::UploadCancel {
            version: 1,
            agent_id: s.agent_id.clone(),
            upload_id: id,
        };
        assert_eq!(store.execute(&s, &cancel).unwrap_err().code, "ASSET_IN_USE");
        drop(lease);
        assert!(matches!(
            store.execute(&s, &cancel).unwrap(),
            RemoteAssetResult::Upload {
                state: UploadState::Cancelled,
                ..
            }
        ));
        assert!(store.ready_asset_lease(&s, asset_id).is_err());
        assert_eq!(
            store.execute(&s, &begin(&s, id, &data)).unwrap_err().code,
            "ASSET_UPLOAD_CANCELLED"
        );
    }
    #[test]
    fn foreign_scope_hash_size_and_canonical_chunk_limits() {
        let (_root, store, s) = setup();
        let id = CanonicalUuid::new(uuid::Uuid::new_v4());
        store.execute(&s, &begin(&s, id, b"abc")).unwrap();
        let mut foreign_principal = s.clone();
        foreign_principal.principal_id = "other".into();
        let mut foreign_target = s.clone();
        foreign_target.target_device_id = CanonicalUuid::new(uuid::Uuid::new_v4());
        let mut foreign_generation = s.clone();
        foreign_generation.controller_key_generation += 1;
        let mut foreign_network = s.clone();
        foreign_network.network_id = CanonicalUuid::new(uuid::Uuid::new_v4());
        let mut foreign_issuer = s.clone();
        foreign_issuer.issuer = "https://another.invalid".into();
        for foreign in [
            foreign_principal,
            foreign_target,
            foreign_generation,
            foreign_network,
            foreign_issuer,
        ] {
            assert!(store.execute(&foreign, &status(&s, id)).is_err());
        }
        let mut wrong = chunk(&s, id, 0, b"abc");
        if let RemoteAssetRequest::UploadChunk { sha256, .. } = &mut wrong {
            *sha256 = "0".repeat(64);
        }
        assert_eq!(
            store.execute(&s, &wrong).unwrap_err().code,
            "ASSET_CHUNK_HASH_MISMATCH"
        );
        assert!(store
            .execute(&s, &chunk(&s, id, 0, &vec![0; ASSET_CHUNK_BYTES + 1]))
            .is_err());
        assert!(store.execute(&s, &chunk(&s, id, 0, b"abcdef")).is_err());
        let mut oversized = begin(&s, CanonicalUuid::new(uuid::Uuid::new_v4()), b"x");
        if let RemoteAssetRequest::UploadBegin { size_bytes, .. } = &mut oversized {
            *size_bytes = ASSET_MAX_BYTES + 1;
        }
        assert!(store.execute(&s, &oversized).is_err());
    }
    #[test]
    fn crash_tail_is_not_acknowledged_and_acknowledged_corruption_is_rejected() {
        let (root, store, s) = setup();
        let id = CanonicalUuid::new(uuid::Uuid::new_v4());
        store.execute(&s, &begin(&s, id, b"abcdef")).unwrap();
        store.execute(&s, &chunk(&s, id, 0, b"abc")).unwrap();
        let path = root
            .path()
            .join(s.key().unwrap())
            .join(id.as_uuid().to_string())
            .join("data");
        {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap();
            f.write_all(b"unacknowledged").unwrap();
            f.sync_all().unwrap();
        }
        drop(store);
        let store = AssetStore::open(root.path()).unwrap();
        assert!(matches!(
            store.execute(&s, &status(&s, id)).unwrap(),
            RemoteAssetResult::Upload {
                received_bytes: 3,
                ..
            }
        ));
        assert_eq!(std::fs::read(&path).unwrap(), b"abc");
        std::fs::write(path, b"bad").unwrap();
        assert_eq!(
            store.execute(&s, &status(&s, id)).unwrap_err().code,
            "ASSET_DATA_CORRUPT"
        );
    }
    #[test]
    fn full_hash_mismatch_never_produces_ready_asset() {
        let (_root, store, s) = setup();
        let id = CanonicalUuid::new(uuid::Uuid::new_v4());
        store.execute(&s, &begin(&s, id, b"abc")).unwrap();
        store.execute(&s, &chunk(&s, id, 0, b"xyz")).unwrap();
        assert_eq!(
            store.execute(&s, &finish(&s, id)).unwrap_err().code,
            "ASSET_HASH_MISMATCH"
        );
    }
    #[test]
    fn scope_quota_does_not_evict_pending_and_cleanup_is_bounded() {
        let (_root, store, s) = setup();
        for _ in 0..8 {
            let id = CanonicalUuid::new(uuid::Uuid::new_v4());
            store.execute(&s, &begin(&s, id, b"pending")).unwrap();
        }
        let id = CanonicalUuid::new(uuid::Uuid::new_v4());
        assert_eq!(
            store
                .execute(&s, &begin(&s, id, b"ninth"))
                .unwrap_err()
                .code,
            "ASSET_SCOPE_QUOTA"
        );
        assert_eq!(store.cleanup_expired(&s, now(), 32).unwrap(), 0);
        assert_eq!(store.cleanup_expired(&s, now() + 3601, 2).unwrap(), 2);
        store.execute(&s, &begin(&s, id, b"ninth")).unwrap();
    }
    #[test]
    fn trusted_artifacts_are_copied_scoped_and_chunked() {
        let (_root, store, s) = setup();
        let owner = tempfile::tempdir().unwrap();
        std::fs::write(owner.path().join("output.txt"), b"real output bytes").unwrap();
        let source =
            TrustedArtifactSource::from_owner(owner.path(), Path::new("output.txt")).unwrap();
        let descriptor = store
            .register_artifact(&s, "session", &source, "output.txt", "text/plain")
            .unwrap();
        assert_eq!(
            store
                .register_artifact(&s, "session", &source, "output.txt", "text/plain")
                .unwrap(),
            descriptor
        );
        assert!(TrustedArtifactSource::from_owner(owner.path(), Path::new("../escape")).is_err());
        let list = RemoteAssetRequest::List {
            version: 1,
            agent_id: s.agent_id.clone(),
            session_id: "session".into(),
            limit: 1,
            before: None,
        };
        assert!(
            matches!(store.execute(&s,&list).unwrap(),RemoteAssetResult::List{items,..}if items==vec![descriptor.clone()])
        );
        let read = RemoteAssetRequest::Read {
            version: 1,
            agent_id: s.agent_id.clone(),
            session_id: "session".into(),
            artifact_id: descriptor.artifact_id,
            offset: 0,
            max_bytes: 4,
        };
        assert!(
            matches!(store.execute(&s,&read).unwrap(),RemoteAssetResult::Chunk{data_base64,eof:false,..}if STANDARD.decode(&data_base64).unwrap()==b"real")
        );
        let mut foreign = s.clone();
        foreign.controller_key_generation += 1;
        assert!(store.execute(&foreign, &read).is_err());
        std::fs::write(owner.path().join("output.txt"), b"updated bytes").unwrap();
        let changed = store
            .register_artifact(&s, "session", &source, "output.txt", "text/plain")
            .unwrap();
        assert_ne!(changed.artifact_id, descriptor.artifact_id);
        let other_session = store
            .register_artifact(&s, "other-session", &source, "output.txt", "text/plain")
            .unwrap();
        assert_ne!(other_session.artifact_id, changed.artifact_id);
    }
    #[test]
    fn global_reservations_and_cancel_crash_account_for_real_storage() {
        let (_root, store, s) = setup();
        let id = CanonicalUuid::new(uuid::Uuid::new_v4());
        store.execute(&s, &begin(&s, id, b"abc")).unwrap();
        let scope_dir = store.scope_dir(&s).unwrap();
        let (dir, mut record) = store.scoped_record(&s, id).unwrap();
        record.state = UploadState::Cancelled;
        AssetStore::save(&dir, &record).unwrap();
        assert_eq!(
            AssetStore::reserved(&scope_dir, &id.as_uuid().to_string(), &record).unwrap(),
            3
        );
        store
            .execute(
                &s,
                &RemoteAssetRequest::UploadCancel {
                    version: 1,
                    agent_id: s.agent_id.clone(),
                    upload_id: id,
                },
            )
            .unwrap();
        assert_eq!(
            AssetStore::reserved(&scope_dir, &id.as_uuid().to_string(), &record).unwrap(),
            0
        );
        let mut granted = 0;
        for principal in 0..7 {
            let mut scoped = s.clone();
            scoped.principal_id = format!("owner-{principal}");
            for _ in 0..8 {
                let mut request = begin(&scoped, CanonicalUuid::new(uuid::Uuid::new_v4()), b"x");
                if let RemoteAssetRequest::UploadBegin { size_bytes, .. } = &mut request {
                    *size_bytes = ASSET_MAX_BYTES;
                }
                match store.execute(&scoped, &request) {
                    Ok(_) => granted += 1,
                    Err(e) => {
                        assert_eq!(e.code, "ASSET_GLOBAL_QUOTA");
                        assert_eq!(granted, 51);
                        return;
                    }
                }
            }
        }
        panic!("global bound was not enforced");
    }
    #[test]
    fn independent_store_handles_serialize_same_upload_id() {
        let (root, store, s) = setup();
        let other = AssetStore::open(root.path()).unwrap();
        let id = CanonicalUuid::new(uuid::Uuid::new_v4());
        let request = begin(&s, id, b"abc");
        let copied_scope = s.clone();
        let copied_request = request.clone();
        let worker =
            std::thread::spawn(move || other.execute(&copied_scope, &copied_request).unwrap());
        let local = store.execute(&s, &request).unwrap();
        assert_eq!(local, worker.join().unwrap());
        assert_eq!(
            AssetStore::records(&store.scope_dir(&s).unwrap())
                .unwrap()
                .len(),
            1
        );
    }
    #[cfg(unix)]
    #[test]
    fn hardlinks_cannot_redirect_data_writes_or_lock_permission_updates() {
        use std::os::unix::fs::PermissionsExt;
        let (root, store, s) = setup();
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim");
        std::fs::write(&victim, b"outside").unwrap();
        std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o644)).unwrap();
        let id = CanonicalUuid::new(uuid::Uuid::new_v4());
        store.execute(&s, &begin(&s, id, b"abc")).unwrap();
        let data = root
            .path()
            .join(s.key().unwrap())
            .join(id.as_uuid().to_string())
            .join("data");
        std::fs::remove_file(&data).unwrap();
        std::fs::hard_link(&victim, &data).unwrap();
        assert!(store.execute(&s, &chunk(&s, id, 0, b"abc")).is_err());
        assert_eq!(std::fs::read(&victim).unwrap(), b"outside");
        std::fs::remove_file(root.path().join(".lock")).unwrap();
        std::fs::hard_link(&victim, root.path().join(".lock")).unwrap();
        assert!(AssetStore::open(root.path()).is_err());
        assert_eq!(
            std::fs::metadata(&victim).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_root_scope_record_data_and_output_escape_are_rejected() {
        use std::os::unix::fs::symlink;
        let (root, store, s) = setup();
        let outside = tempfile::tempdir().unwrap();
        let linked = outside.path().join("linked");
        symlink(root.path(), &linked).unwrap();
        assert!(AssetStore::open(&linked).is_err());
        let id = CanonicalUuid::new(uuid::Uuid::new_v4());
        store.execute(&s, &begin(&s, id, b"abc")).unwrap();
        let data = root
            .path()
            .join(s.key().unwrap())
            .join(id.as_uuid().to_string())
            .join("data");
        std::fs::remove_file(&data).unwrap();
        std::fs::write(outside.path().join("victim"), b"outside").unwrap();
        symlink(outside.path().join("victim"), &data).unwrap();
        assert!(store.execute(&s, &status(&s, id)).is_err());
        assert_eq!(
            std::fs::read(outside.path().join("victim")).unwrap(),
            b"outside"
        );
        symlink(
            outside.path().join("victim"),
            root.path().join("outside-output"),
        )
        .unwrap();
        let source =
            TrustedArtifactSource::from_owner(root.path(), Path::new("outside-output")).unwrap();
        assert!(store
            .register_artifact(&s, "session", &source, "output.txt", "text/plain")
            .is_err());
        let mut other = s.clone();
        other.principal_id = "other".into();
        symlink(outside.path(), root.path().join(other.key().unwrap())).unwrap();
        assert!(store
            .execute(
                &other,
                &begin(&other, CanonicalUuid::new(uuid::Uuid::new_v4()), b"x")
            )
            .is_err());
    }
}
