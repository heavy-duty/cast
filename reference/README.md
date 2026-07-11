# API reference (pinned)

`coolify-openapi-4.1.2.json` is the OpenAPI spec at the pinned Coolify tag.
The executor is written against THIS file plus controller behavior verified
2026-07-10 (the published spec omits `is_buildtime`/`is_runtime` on env
write endpoints; the controllers accept them — `infra smoke` guards this).
On any Coolify upgrade: re-vendor at the new tag, diff, re-run `infra smoke`.

## Known gap: S3 storage destinations have no API surface (verified 2026-07-10)

Coolify 4.1.2 exposes **no endpoint at all** — not list, not create, not
read — for S3 storage destinations (the backup-target resource referenced
by `s3_storage_uuid` on database-backup payloads). Verified two ways:

- The vendored spec has zero `/storages`-as-a-resource paths; the only
  `storages` paths are `/applications/{uuid}/storages`,
  `/databases/{uuid}/storages`, `/services/{uuid}/storages` — these are
  per-resource Docker volume mounts, a different Coolify concept.
- Upstream `routes/api.php` at tag `v4.1.2` imports only these Api
  controllers: Applications, CloudProviderTokens, Databases, Deploy,
  Github, Hetzner, Other, Project, Resources, ScheduledTasks, Security,
  Sentinel, Servers, Services, Team. There is no Storage/S3 controller —
  the route table has zero routes matching `storage` or `s3` outside the
  three per-resource-type volume-mount groups above.

S3 storage destinations are UI-only in this Coolify version (Settings → S3
Storages). No S3 storage API exists in 4.1.2 — the destination UUID is
recorded in environments.yaml by the bootstrap runbook; the client
deliberately has no storage resolver. Re-check on any Coolify upgrade
re-vendor.
