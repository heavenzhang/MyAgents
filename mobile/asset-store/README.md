# Scoped native asset byte store

`moxbots-asset-store` is a pure Rust byte/receipt owner. It has no executor, HTTP,
WSS, transcript owner, runtime or credentials. The Host/native integration supplies
an authenticated `AssetScope`; no RPC accepts an issuer, caller identity or path.
The separate `session.assets.v1` data profile uses at most 24 KiB raw chunks.

## Native integration

- `AssetStore::open(private_app_root)` requires an existing absolute, nonsymlink
  native app directory. Unix checks the current effective UID and mode 0700.
  Windows ACL provisioning belongs to the native app-directory owner.
- `execute(&scope, &RemoteAssetRequest)` validates request/Agent scope and performs
  the closed upload/list/read operation. Project `StoreError.code` into the typed
  version-1 error result; never return filesystem errors/paths to the client.
- `ready_asset_lease(&scope, asset_id)` returns a native-only verified immutable
  receipt plus internal `path()`/read-only `file()`. Hold the lease through admission
  and byte consumption: its shared lock blocks cancel/TTL cleanup. The parent must
  reauthorize the current remote session and pass only a verified ready asset into
  the original SessionEngine attachment owner. The lease does not execute anything.
- `TrustedArtifactSource::from_owner(root, relative)` is ONLY for the trusted
  transcript/output owner, never RPC JSON. It permits normal relative components
  under that capability root. `register_artifact(scope, session_id, source, label,
  mime)` copies bounded actual bytes into private owned storage and returns the
  scoped artifact descriptor. This does not discover or register transcript output
  automatically; parent owns that bridge and chooses authorized output roots.
- `cleanup_expired(scope, native_now_seconds, limit)` is explicit, scoped and capped
  at 32 records per call. Upload TTL is one hour since last acknowledged progress;
  ready/cancelled/output TTL is 24 hours. Live leases and nonexpired unknown uploads
  are never evicted to satisfy quotas.

`AssetScope` includes issuer, service/environment/network/principal, controller
identity+key generation, target device and Agent. Session identity further scopes
output list/read. Upload IDs and immutable ready asset IDs differ; output artifact
IDs belong to registered transcript output and cannot substitute for uploaded input.
Names are labels only and never enter filesystem paths. All owned directories use
hashed scope plus canonical UUIDs; capability handles and no-follow operations
reject symlink escapes, including scope/record/data/meta/lock paths. Unix rejects
multiply linked regular data/lock files before writes or permission changes.

## Persistence and limits

A global filesystem lock serializes reservations and metadata mutations across
independent store instances. Each data write is synchronized before its progress
metadata is atomically replaced and synchronized, then acknowledged. Restart checks
all acknowledged chunk hashes against actual bytes. It truncates an unacknowledged
crash tail to the last durable receipt, rejects missing/corrupt acknowledged bytes,
and never invents progress. Exact chunk duplicates are idempotent; changed duplicate,
interior-offset, gap, oversized and hash-mismatched writes are rejected. Finish
requires exact total size and complete SHA-256 before the immutable ready receipt.

Limits are 20 MiB per asset, 8 active uploads and 160 MiB reserved bytes per complete
scope, 1 GiB globally, 128 records per scope, 1024 total records, and 256 scopes.
Cancellation leaves a durable tombstone and removes bytes; after an interrupted
cancel, retained bytes still count against quota until explicit idempotent cancel or
TTL cleanup removes them. Unknown pending records are not silently evicted. The
parent should schedule authorized scoped cleanup and expose expiry clearly.

Directory and file synchronization errors are fatal; there is no success downgrade.
The implemented filesystem API is portable, but this worker has run only macOS
filesystem tests. Windows directory-flush/ACL behavior and Linux/iPhone/Android
integration still need actual platform validation; unsupported durability must stay
fail-closed. No native/Host execution acceptance is claimed by this crate alone.

## Checks

```
cargo test --manifest-path mobile/asset-store/Cargo.toml --locked
cargo clippy --manifest-path mobile/asset-store/Cargo.toml --locked --all-targets -- -D warnings
```

Ten real TempDir tests cover bytes/restart/digest/duplicates/order/limits, foreign
scope, cancellation/leases, source registration/read, symlink/hardlink escapes,
concurrent store instances, quotas and cancelled-crash storage accounting.
