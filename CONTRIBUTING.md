# Contributing

This repo is governed by
[heavy-duty/ceremony](https://github.com/heavy-duty/ceremony). **Agents:
read [`.ceremony/AGENTS.md`](.ceremony/AGENTS.md) first** — it routes you to
your role file (builder, reviewer, triage), vendored beside it,
byte-identical to ceremony at the pin named in
[`.github/workflows/release.yml`](.github/workflows/release.yml) and
guarded by the `docs-sync` step in CI. The review-round doctrine — drafts,
whole-round replies, verdicts, the handoff — lives there and in
[`.ceremony/LABELS.md`](.ceremony/LABELS.md); this file keeps only what is
genuinely cast's.

## The PR loop, cast specifics

1. **Fork and branch.** Contributors work from forks; upstream branches are
   for maintainers. Title the PR conventionally (`feat:`, `fix:`, `docs:`).
2. **The review panel** (`.github/labels.conf`'s `panel=` line):
   `claude-bot-andresmgsl`, `codex-bot-andresmgsl`, `grok-bot-andresmgsl`,
   `kimi-bot-andresmgsl` —
   the required verdicts for a PR are the panel minus its author. The
   maintainer (`danmt`) takes the last word and merges.
3. **Checks must be green**: `npm run check`, `npm run build`, and
   `npm test` locally mirror what CI runs, plus the shellcheck sweep
   (`npm run check:shell`). The release guards (`changelog-armed`,
   `changelog-monotonic`, `drill-recorded`, `docs-sync`) run as ceremony's
   pinned actions.
4. **Feature PRs land their changelog entry as part of the PR**: add it
   under `CHANGELOG.md`'s `## Unreleased` heading — that section becomes
   the release notes verbatim when a release is cut.

## Changelog entries

Every PR that changes behaviour adds one line to `## Unreleased`. One line is
the whole rule — if it wraps more than twice in your editor, cut it down.

- **Say what changed, and stop.** Why it was wrong, how it was found, what it
  cost, what it implies — that belongs in the PR body and the commit message,
  which is where anyone chasing the reasoning already goes. This file answers
  one question: what is different in this version.
- **Any word that can be removed, is removed.**
- **Lead with the surface, not the mechanism.** "`state:needs-human` is set at
  handoff" beats "the labels workflow now also wakes on `labeled`".
- **Cite the issue or PR** — `(#131)` — and let the reader follow it for the
  rest.
- **Mark a breaking change** with a leading `BREAKING:`.
- Group under `### Added` / `### Changed` / `### Fixed` / `### Removed`.
- No bold run-in headings, no sub-paragraphs, no code blocks, no prose essays.

Good:

- `state:needs-human` is set at handoff, not by the cron (#131)
- An unreadable check rollup no longer reads as "nothing is failing" (#128)
- BREAKING: `scripts/register-github-app.sh` is gone; use `cast github-app` (#7)

Not an entry — that is a PR body:

- **`state:needs-human` no longer waits on the cron to become true** (#131) —
  the labels workflow now also wakes on `pull_request_target: labeled` and
  `unlabeled`, and the author sets it themselves when handing a PR over. A
  review landing was never a trigger. There is no `pull_request_review_target`,
  and on fork PRs — which is all of them here — ...

## Releasing

A release is a PR, and merging it is the release. The ceremony — the two
doors, the decide table, the stamps, the post-release re-arm — is
heavy-duty/ceremony's machinery, consumed by reference:
[its README](https://github.com/heavy-duty/ceremony/blob/main/README.md)
is the doctrine, `.github/workflows/release.yml` here is the ≤20-line
caller pinning it (`version-source: package-json` — the version lives in
`package.json`, and the post-release bump keeps `package-lock.json` in
step), and the guards run in `ci.yml` from the same pin. Bare `X.Y.Z`
tags, no `v`.

What stays cast's beyond that pin:

- **The prebuilt asset** —
  [`.github/actions/release-artifact/`](.github/actions/release-artifact/action.yml),
  the artifact hook both doors invoke: the build happens ONCE, in CI, and
  `cast-X.Y.Z.tgz` is the runnable tree (`bin/`, `dist/`, production
  `node_modules/`, `package.json`). That asset is what the installer's
  release channels download — never a source tarball, never an
  operator-machine build.
- **The drill** — the real-hardware gate before the handoff of a release
  PR. Cast's drill asserts **promotion**: two live Coolify instances, the
  full A→B run (team, apply, an idempotent diff, smoke, inventory,
  emit-draft, fleet, destroy, the read-only guard) — A→B reproduces, and
  the diff is idempotent. The full meaning — the fixed candidate-ref
  pinning that dissolves the box↔rig recursion, the per-version record
  files, the waiver rule — is [`drills/README.md`](drills/README.md); the
  `drill-recorded` guard enforces the record on every release tree.

## Labels — who sets what

The taxonomy and state machine are
[`.ceremony/LABELS.md`](.ceremony/LABELS.md); cast's `scope:*` rows live in
`.github/labels.conf` (reconciled by the labels caller) and their path map
in `.github/labeler.yml`. What matters day to day is who sets each kind —
most of it is machinery, and hand-moving a machine-owned label just gets
corrected on the next pass:

| Labels | Set by |
|---|---|
| `state:*` | the labels workflow ([.github/workflows/labels.yml](.github/workflows/labels.yml)) — recomputed from GitHub's own facts on PR events (label changes included) and every 15 minutes. Machine-owned, with one exception: the author sets `state:needs-human` at handoff and the workflow reconciles it. Otherwise never by hand. Exactly one per PR: *whose ball is it.* |
| `blocker:*` | the same workflow, from the same facts — *what is in the way.* Any number per PR, or none. Never by hand: applying one does not stop a merge, and removing one does not unblock anything. Fix the thing and the next sweep drops the label. |
| `stale` | the same workflow — 48h without commits, comments, or reviews. `blocked` PRs are exempt: they are quiet legitimately. |
| `scope:*` on PRs | actions/labeler, from the changed paths ([.github/labeler.yml](.github/labeler.yml)). Additive — you may add more, the machine won't remove them. |
| `scope:*` on issues | you, when opening or triaging — issues have no paths to derive from. |
| `blocked`, `release` | you — automation never guesses intent. |
| `merge-next` | you or the agent owning the queue. Which PR lands first is a judgement about how they conflict, so the workflow never sets it — it only **clears** it, the moment the PR stops being something a human could merge. |
| `bug` / `enhancement` / `documentation` | you, on issues only — a PR's type already lives in its title. |

## Issues

Give issues the same care as PR titles: say the surface in the title, apply a
`scope:` label and a type label (`bug` / `enhancement` / `documentation`) when
you open one, and `blocked` when it waits on something — that is what keeps
the board navigable as the issue count grows.
