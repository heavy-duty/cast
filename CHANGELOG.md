# Changelog

History before 0.1.0 lives in git. Feature PRs land their entry in
`## Unreleased` as part of the PR; a release PR stamps that section with
the version and date (see cast#96 — the release flow shared with
heavy-duty/box#83).

## Unreleased

### Added

- **Versioned installs: tagged releases with a prebuilt dist asset** (#96) —
  cast now has a release surface. `cast --version` prints the version from
  `package.json` (the single source of truth — no separate `VERSION` file)
  plus the install root. On a bare `X.Y.Z` tag push, `release.yml` asserts
  the tag matches `package.json`, builds once in CI (`npm ci`, `npm run
  build`, `npm prune --omit=dev`), tars the runnable tree into
  `cast-X.Y.Z.tgz`, and creates the GitHub release with that version's
  changelog section as the body and the tarball attached. The installer now
  defaults to the **latest release asset** — resolved via the
  `releases/latest` redirect, no API, no token — so a default install
  compiles nothing on the operator's machine and answers "what cast is
  this?" with a version. `CAST_REF=X.Y.Z` pins (uses that tag's asset when
  it exists), `CAST_REF=main` stays the dev channel: build-from-source,
  exactly the old path.
