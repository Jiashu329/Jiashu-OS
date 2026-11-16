# One-time Sites owner migration protocol

This operation migrates only the original site's configured owner, not the other
two members. Preserve target local users, passwords, runtime secrets and migration
ledger. Never put a plaintext snapshot, credential or secret in Git, workflow
inputs, artifacts, logs or command-line arguments.

Fixed identifiers:

- migrationId: `jiashu-owner-20261116-v1`
- sourceProjectId: `appgprj_6af116465b5c8191ab7a2b62d4645f0f`
- sourceOwnerId: `y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap`
- targetOwnerId: `treefund-test-owner`
- sourceOrigin: `https://jiashu-life-os-health.jiashuh329.chatgpt.site`
- targetOrigin: `https://www.treefund.asia`

The ECS prepare operation creates a temporary RSA-3072 private key inside a
private migration directory, never in the normal application mount. Only its
SPKI PEM public key and fingerprint are returned. Fingerprint is lowercase hex
SHA-256 of SPKI DER.

Export endpoint: `POST /_migration/owner-export`, body `{}`. The Sites dispatch
requires the existing `OAI-Sites-Authorization: Bearer ...` service credential;
the handler also requires its own `Authorization: Bearer ...` transfer secret.
It is disabled unless all configuration is present, unexpired, and the fixed
source owner matches `app_owner_identity`. Public key is fixed in configuration,
never accepted from a request. During export, freeze source application mutations.

Environment names: `MIGRATION_EXPORT_SECRET`, `MIGRATION_EXPORT_PUBLIC_KEY`,
`MIGRATION_EXPORT_EXPIRES_AT`, `MIGRATION_EXPORT_FREEZE_WRITES` (`1` when frozen).
Normal default runtime is unchanged when these are absent. The freeze must have
an expiry and should block all application API mutations. GETs remain available.

Export envelope JSON has exactly `{header,wrappedKey,iv,ciphertext}`.
All binary values use canonical padded base64. `header` has ordered fields:
`{format:'jiashu-owner-migration-v1',migrationId,sourceProjectId,sourceOwnerId,targetOwnerId,keyFingerprint}`.
Encrypt payload JSON using a new random AES-256-GCM key and 12-byte IV, 128-bit
tag appended to ciphertext, with UTF-8 JSON.stringify(header) as AAD. Wrap the
32-byte AES key with RSA-OAEP SHA-256 using the configured destination public key.

Payload: `{header,exportedAt,tables,secrets}` where `tables` is sorted by table
name, and each table is `{name,columns,rows,sha256}`. Columns are sorted names;
each row is an object with exactly those keys in column order and only JSON
string/finite-number/null values. Sort rows by the lexical (< / >, not locale)
order of their JSON strings. sha256 is lowercase hex SHA-256 of UTF-8
JSON.stringify({name,columns,rows}). Verify before transforming any row.
`secrets` is `{aiKey:string|null,tmdbToken:string|null}`. Decrypt these inside the
source Worker with its existing master; plaintext is only inside the encrypted
payload. Preserve original encrypted table rows for source digest validation.

Source uses a consistent D1 batch snapshot of explicitly allowlisted application
tables, scoped to owner user_id / owner_id / owner_user_id. Related family rows
must belong to the owner's books; related managed food rows must belong to its
foods. Omit auth grants/owner identity, local users, leases and internal metadata.
Public IMDb cache can be omitted and rebuilt. Read table availability from schema
so older/missing tables are not guessed. Fail rather than silently truncate.

The service and transfer credentials arrive as a hybrid-encrypted
`migration_request` workflow input (same RSA/AES envelope scheme, header format
`jiashu-migration-request-v1`, same other identifiers). Its plaintext payload is
`{sourceBearer,transferSecret}`. The source returned 403 to a direct ECS request,
so the workflow captures the ECS-unsealed credentials in a private memory pipe
and relays the request from its runner. The runner only handles credentials and
the destination-sealed ciphertext, and never decrypts personal data. It calls only
the exact source HTTPS origin with redirects disabled and bounded response size.
No credential is logged or persisted; the encrypted dataset streams over SSH to
the ECS-only decryption and preview phase without any Artifact.

Importer verifies envelope, header/fingerprint, source hashes, allowed table names,
columns and owner scope. Explicitly map only structured identity columns from the
source owner to target owner. Re-encrypt AI/TMDB under target master and target
owner. Preserve opaque request hashes and unrelated historical text/JSON. Preserve
other target users and auth tables. Identical records may be skipped; conflicting
records must be reported in dry run and not overwritten without a resolved plan.

Workflow phases are prepare, fetch-plan, apply, verify and cleanup. Preview must
report only counts, conflict categories and hashes. Apply must be bound to the
reviewed plan hash and current release/database fingerprint. Hold deploy.lock,
stop app, make the existing consistent private SQLite backup with UID10001 and RW
data directory (WAL/SHM), build/validate a candidate, then atomically cut over.
Do not replace the target with a D1 dump or replay historical migrations. Restore
all candidate triggers, validate integrity/FKs/counts/hashes and preserve the
selfhost ledger. Close DBs and correctly checkpoint old WAL before cutover.

Post-cutover verify readiness, login, owner business counts and other target user
isolation. Retain private pre-import backup, sealed source, its ECS-only recovery
key and a nonsecret receipt. Remove plaintext staging/export credentials and
disable source export after success. Restore source writes for its other members;
the migrating owner should continue recording on the destination.
