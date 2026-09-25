# Changelog

History before 0.1.0 lives in git — cast has said `0.1.0` in `package.json`
since its first commit, but grew its release surface (this file,
`cast --version`, tagged releases with a prebuilt asset) on the way to
actually cutting it, and this file starts there.

## Unreleased

### Added

- `storages:` on a non-compose application declares its persistent volumes: created through `POST /applications/{uuid}/storages`, compared by name, moved in place, and an undeclared one reported and never deleted; `draft` emits them (#167)

## 0.3.0 — 2026-09-24

### Added

- `build.pack: dockerimage`: an application deployed from a registry image,
  declared as `image: { name, tag }`, created through
  `POST /applications/dockerimage` with no GitHub App, its tag diffed and
  moved in place (#161)
- `service_domains: { <service>: [] }` declares a compose service with no
  hostname, and it reads back clean (#161)
- `cast --help` and the README show `--path` and `--hostname-overlay` on
  `diff`, and a test keeps every command's flags on its usage lines (#151)

### Changed

- A declared `healthcheck` now enables Coolify's health check, and a check
  switched off under a declared path is drift `apply` repairs (#161)
- `draft` emits a Docker Image application by its image, not the git remote
  Coolify stamps on it (#161)
- The release flow and labels automation now run heavy-duty/ceremony's shared
  machinery at 0.1.0; the prebuilt-asset build moves to the release-artifact
  hook (heavy-duty/ceremony#15)

### Fixed

- `install.sh` refuses node 22.0–22.11: the gate compares the minor version
  its message always named, and one test binds the floor across
  `package.json`, `README.md`, `bin/cast` and the installer (#154)
- `ci.yml` declares `permissions: contents: read`, the token the workflow
  needs and no more (#157)
- `capture` refuses a multi-line value, overridden or captured, before the
  confirmation, and the store's reader names the malformed line and its key
  (#163)

## 0.2.0 — 2026-07-21

### Added

- CI refuses a release PR with no drill record at `drills/<version>.md`
- An application can declare HTTP basic auth, and `apply` sets it (#76)
- `cast github-app create` / `cast github-app register` run the App Manifest
  flow (#7)

### Changed

- `state:needs-human` is set at handoff, not by the cron (#131)
- PR labels split into two axes: `state:*` (whose ball) and `blocker:*` (what
  is in the way); `state:needs-rebase` is retired (heavy-duty/box#138)
- The `NO_API_COVERAGE` row for Basic Auth now says services (#76)
- Changelog entries are one line each, and the whole file now follows the rule
  (#136)

### Removed

- BREAKING: `scripts/register-github-app.sh` is gone; use `cast github-app
  register` (#7)

### Fixed

- Three test files from #124/#125 allocate through `tmp()`, not raw
  `mkdtempSync` (#135)
- A PR that deletes a shipped release heading is now CI-red (#133,
  heavy-duty/box#122)
- A duplicate release heading is caught even where the guard cannot see the
  base (#133, heavy-duty/box#143)
- A label the repo does not have no longer takes the whole label edit down
  with it
- An unreadable check rollup no longer reads as "nothing is failing"
- `state:needs-human` no longer appears on PRs a human cannot merge (#127,
  heavy-duty/box#136)
- CI lints every tracked shell script, and proves the set is complete (#118)
- The shellcheck sweep covers extensionless scripts such as `bin/cast` (#121)
- `cast` no longer leaves a full repo clone in the temp dir on every run (#117)
- The test suite reaps its temp directories (#117)

## 0.1.1 — 2026-07-19

### Fixed

- The release ceremony re-arms `## Unreleased`, and CI is red when it does not
  (#113)

## 0.1.0 — 2026-07-19

### Fixed

- The release suite accepts the ceremony's own tree (#108)
- `apply` no longer demands a GitHub App for a manifest that declares no
  applications (#103)
- A manifest with no `${…}` refs applies without a secret store (#104)
- `CAST_AGE_KEY_FILE_<ENV>` is settable for every environment name (#102)

### Added

- Merging a release-labeled PR is the release, and the release re-arms main
  itself (#111)
- Tagged releases with a prebuilt dist asset, and an installer that installs
  them (#96)
