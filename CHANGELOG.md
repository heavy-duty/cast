# Changelog

History before 0.1.0 lives in git — cast has said `0.1.0` in `package.json`
since its first commit, but grew its release surface (this file,
`cast --version`, tagged releases with a prebuilt asset) on the way to
actually cutting it, and this file starts there.

## Unreleased

### Fixed

- **`apply` no longer demands a GitHub App for a manifest that declares no
  applications** (#103) — found live in the 2026-07-19 release drill, where a
  databases-only manifest (`applications: {}`) rendered its plan of two
  creates and then died in preflight on `no GitHub App bound`, over a binding
  nothing in the run would ever have used: a GitHub App exists to clone
  application source, cast reads it in exactly one call (the application
  create), and databases and services never touch it. That unconditional
  resolution gated infra-only projects — the databases a fleet's other
  projects share — behind the GitHub-App browser-registration ceremony for no
  reason. `apply` now resolves the App only when the desired state actually
  contains an application; a manifest that does declare one still refuses on
  a missing binding exactly as before, clean plan or not, because that
  binding is state the next create will need.
- **A manifest with no `${…}` refs applies without a store** (#104) — the
  greenfield manifest-first bootstrap was a chicken-and-egg with no exit,
  found by the 2026-07-19 release drill against two fresh Coolify 4.1.2
  instances: a registered project whose manifest declared databases only
  (zero `${…}` refs) could not take its first `apply` — apply refused with
  `no secret store for <org>/<repo> in <env>`, and `capture`, the documented
  way to get a store, rightly refuses a project that is absent on the box,
  because apply is the verb that would create it. The drill unblocked with a
  hand-rolled empty store (`printf '' | age -r … -o secrets/….env.age`),
  documented nowhere. Now `diff`/`apply` gate that refusal on the manifest
  actually *referencing* a secret, asked via the same parser resolution
  uses: when the templates resolve zero `${…}` refs, an absent store is
  treated as empty and the run proceeds, printing a loud one-line note
  naming the path the store would live at — and since there is nothing to
  decrypt, the age key is not demanded either. The moment any template
  gains a `${…}` ref, the refusal returns byte-identical to before.
  `capture` and `destroy` are untouched.

### Added

- **Tagged releases with a prebuilt dist asset, and an installer that
  installs them** (#96) — the cast half of the flow designed in
  heavy-duty/box#83, plus the piece unique to cast: a **prebuilt asset**,
  because cast is the one repo where the source tarball is *not* the
  package. A release is a PR, then a tag: the `release: X.Y.Z` PR bumps
  `package.json` (and `package-lock.json`) and stamps this file's Unreleased
  section with version + date; the merge commit is tagged bare `X.Y.Z`
  (box's tag scheme — no `v` prefix). `release.yml` turns the tag into the
  GitHub release — after asserting tag == `package.json` version (a
  mismatch fails loudly and creates nothing) — with that version's section
  of this file as the body, extracted by the same
  `.github/scripts/release-notes.sh` the test harness drives, and with the
  runnable tree attached as `cast-X.Y.Z.tgz`: `bin/`, compiled `dist/`,
  production `node_modules/`, `package.json`, built once in CI
  (`npm ci && npm run build && npm prune --omit=dev`). `install.sh` now
  defaults to the **latest release**: the tag is resolved by following the
  `releases/latest` redirect and reading the `Location` header — no API, no
  token — and the download is that release's asset, so **no `npm ci`, no
  `tsc`, no devDependencies ever run on the operator's machine**. `CAST_REF`
  picks the other two channels: a tag pins a release (its asset first,
  source as the fallback for a ref that has none — `refs/tags` outranks a
  same-named branch), a branch (`CAST_REF=main`) tracks the development
  tree and is the one channel that still builds from source, the only place
  `npm` is required. Until 0.1.0 is cut the default channel has nothing to
  resolve and dies saying exactly that, naming `CAST_REF=main` as the way
  to install today — it never falls back to main silently, because "I
  installed the latest release" must not quietly mean "I installed whatever
  main was that second". The channel only decides *which* tree arrives and
  whether it is built here — whatever it fetched lands in the versioned
  layout (`versions/<package.json version>`, `current` flipped atomically)
  like any other install.
