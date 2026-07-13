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

## Known gap: a resource's destination is write-only (verified 2026-07-13)

The **destination** (the Docker network a resource is created on — a
`StandaloneDocker`, not the S3 thing above) can be *set* by the API and never
*read back*. Three separate facts, all verified at tag `v4.1.2`:

- **No destinations API at all.** `routes/api.php` has zero routes matching
  `destination` — not list, not read, not create. So a destination name cannot
  be resolved to anything; only a raw UUID, read out of the UI, identifies one.
  (Same shape as the S3 gap above, same consequence: `environments.yaml` records
  the UUID, and cast has no resolver.)
- **Write accepts `destination_uuid`** on create for applications
  (`/applications/*`), all eight database types, and `/services`; and on PATCH
  for applications and services.
- **Read returns `destination_id` + `destination_type`** — the integer primary
  key and the morph class (`App\Models\StandaloneDocker`), never the UUID. They
  survive serialization (none of the three controllers' `removeSensitiveData()`
  hides them), but `ProjectController@environment_details` does not eager-load
  the `destination` relation, and nothing else exposes it.

**Nothing maps an int to a UUID**, so a declared `destination_uuid` cannot be
compared against the live resource it was sent for. `diff` therefore *reports*
placement rather than comparing it (see `Placement` in `src/diff.ts`): it groups
live resources by `destination_id` — which is comparable to itself — so a
project whose resources do not all share one network is still caught, and it
says plainly that the declared UUID was not verified.

Coolify's own create-time behavior, identical in `ApplicationsController`
(~L1003), `DatabasesController` (~L1700) and `ServicesController` (~L378):

| server has | `destination_uuid` sent | result |
| --- | --- | --- |
| 0 destinations | anything | `400 Server has no destinations.` |
| exactly 1 | omitted | `$destinations->first()` — the default network |
| exactly 1 | **any value** | **ignored, never validated** — `first()` again |
| >1 | omitted | `400 Server has multiple destinations and you do not set destination_uuid.` |
| >1 | not on that server | `422 Provided destination_uuid does not belong to the specified server.` |

Two consequences worth keeping in mind. A **single-destination server silently
accepts a wrong UUID** — neither Coolify nor cast can catch that, and it is why
the declared value is never trusted as verified. And a **multi-destination
server rejects a create that omits it**, which is why cast could not deploy onto
a shared box at all until it could send this field.
