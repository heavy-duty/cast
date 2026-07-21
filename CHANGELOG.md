# Changelog

History before 0.1.0 lives in git — cast has said `0.1.0` in `package.json`
since its first commit, but grew its release surface (this file,
`cast --version`, tagged releases with a prebuilt asset) on the way to
actually cutting it, and this file starts there.

## Unreleased

### Added

- CI refuses a release PR with no drill record in `drill/RUNS.md`
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
