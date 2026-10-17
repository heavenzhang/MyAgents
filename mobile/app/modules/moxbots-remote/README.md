# Native remote owner

`MoxBotsRemote.request` accepts closed JSON intents. Account keys, tokens,
pending operation bodies, file URLs and raw attachment bytes stay native.

Additional local attachment intents (version 1):

- `attachment.pick`, `source: "file" | "image"`: present the system picker;
  import one file into account-scoped app storage. Cancel is an explicit error.
- `attachment.list`: return the current native account's local drafts.
- `attachment.remove`, `localId`: remove an owned local draft.

An attachment projection contains `kind: "attachment"`, `localId`, `name`,
`mimeType`, `sizeBytes`, `sha256`, and `image`. List returns
`{kind:"attachments",items:[...]}`; removal returns
`{kind:"attachment-removed",localId}`. No arbitrary path/URI or byte-read intent
exists. The native account owner supplies issuer and principal scope, checks it
again after import, and refuses signed-out/changed accounts.

Files are limited to 20 MiB, selected images to 10 MiB / 40 million pixels,
and local drafts to eight per account. iOS excludes them from backup and uses
device file protection; Android uses its private no-backup directory. The
metadata index uses Keychain / Keystore-encrypted native records. Upload
scheduling uses native-only 24 KiB reads; the Host independently checks full
size and hash before admission.

These picker/byte-owner changes are implementation in progress. Neither native
device picker acceptance nor upload-to-original-session admission is implied by
their source. They must be verified with the built native app.
