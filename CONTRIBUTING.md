# Contributing

How change lands in this repo. The short version: PRs are born as drafts,
three reviewer bots take the first rounds, a human takes the last word — and
labels tell you where everything is without opening anything.

## The PR loop

1. **Fork and branch.** Contributors work from forks; upstream branches are
   for maintainers. Title the PR conventionally (`feat:`, `fix:`, `docs:`).
2. **Open as a draft** while you build. Drafts are invisible to the reviewer
   bots on purpose.
3. **When it's ready**: mark ready-for-review and request all three bots —
   `claude-bot-andresmgsl`, `codex-bot-andresmgsl`, `grok-bot-andresmgsl`.
   They poll roughly every 15 minutes.
4. **Rounds are answered whole.** Wait until all three have reviewed, then
   answer the entire round in a **single reply**, push the fixes, and
   re-request the bots that didn't approve. Prefer verification over
   argument: a test settles what a comment thread can't.
5. **Reviews end in a verdict.** A reviewer — bot or human — either
   **approves** or **requests changes**, never a bare comment. A
   comment-only review is a non-verdict: it doesn't say whether the round
   passed, and the state machine (and anyone scanning the board) has to
   guess. The verdict carries *blockingness only*, the body carries the
   feedback: non-blocking nits ride an **approval** and the author addresses
   them at their discretion; anything blocking — including a question that
   gates the verdict — is **request changes**, saying what unblocks it. The
   reconciler treats a comment-only review as not-approved, so commenting
   without a verdict only stalls the PR. The machine never reads review
   bodies: when a comment-only reviewer's line is really an agreement, that
   judgment belongs to the **author** — escalate by requesting the
   maintainer's review (step 6), and the reconciler flips the label on that
   request, because an explicit request is a fact it can trust.
6. **When the round passes, the author hands the PR to the maintainer** by
   requesting their review — that request is what flips `state:needs-human`.
   With three formal head-current approvals the labels workflow requests it
   automatically; when part of the panel is comment-only, reading their
   agreement is the author's judgment, so the author makes the request.
7. **Checks must be green**: `npm run check`, `npm run build`, and
   `npm test` locally mirror what CI runs.
8. **Feature PRs land their changelog entry as part of the PR** (box's
   convention): add it under `CHANGELOG.md`'s `## Unreleased` heading —
   that section becomes the release notes verbatim when a release is cut.

## Releasing

A release is a PR, and merging it IS the release
([#111](https://github.com/heavy-duty/cast/issues/111); box#96's design,
on box#83's shape):

1. A small PR — `release: X.Y.Z`, labeled `release` — bumps `package.json`'s
   `version` (and `package-lock.json`; `npm install --package-lock-only`
   keeps them in step) and stamps `CHANGELOG.md`'s Unreleased section as
   `## X.Y.Z — YYYY-MM-DD`. CI green on it, same loop as any PR.
2. **Merge. That's the ship decision — nothing else to do.**
   [release.yml](.github/workflows/release.yml) fires on the merged,
   `release`-labeled PR and asserts, in order, each fail-loud and creating
   nothing: the merged version is non-`-dev`; the version *changed in this
   PR* (the `-dev` transition is the interlock — a mislabeled ordinary PR
   fails here); that version's changelog section extracts non-empty
   ([.github/scripts/release-notes.sh](.github/scripts/release-notes.sh));
   and no tag or release exists for it yet. Then, in the same job, it tags
   the merge commit bare `X.Y.Z` (no `v` prefix — box's tag scheme), builds
   the package once (`npm ci && npm run build && npm prune --omit=dev`), and
   publishes the release with the runnable tree — `bin/`, `dist/`,
   production `node_modules/`, `package.json` — attached as
   `cast-X.Y.Z.tgz`. That asset is what the installer's release channels
   download: the build happens once, in CI, never on an operator's machine.
   *Manual fallback and backfill:* push a bare `X.Y.Z` tag on the merge
   commit yourself — the same workflow runs the same asserts, build, and
   publish from the tag.
3. **The release re-arms main itself**: the same workflow run bumps
   `package.json` (and `package-lock.json`) to `X.Y.(Z+1)-dev` and pushes
   the commit straight to main — no follow-up PR (it opens one only if
   branch protection refuses the direct push, and says so loudly).
   Installs are versioned by the tree's `package.json` version, so a
   `CAST_REF=main` install between releases must land as
   `versions/X.Y.(Z+1)-dev`, never as `versions/X.Y.Z` — main's tree must
   not impersonate the release it merely descends from. On the *manual*
   tag path the bump stays yours: open the one-line PR after publishing.

## Labels — who sets what

The full taxonomy lives in [LABELS.md](LABELS.md). What matters day to day is
who sets each kind — most of it is machinery, and hand-moving a
machine-owned label just gets corrected on the next pass:

| Labels | Set by |
|---|---|
| `state:*` | the labels workflow ([.github/workflows/labels.yml](.github/workflows/labels.yml)) — recomputed from GitHub's own facts every 15 minutes and on PR events. Never by hand. |
| `stale` | the same workflow — 48h without commits, comments, or reviews. `blocked` PRs are exempt: they are quiet legitimately. |
| `scope:*` on PRs | actions/labeler, from the changed paths ([.github/labeler.yml](.github/labeler.yml)). Additive — you may add more, the machine won't remove them. |
| `scope:*` on issues | you, when opening or triaging — issues have no paths to derive from. |
| `blocked`, `release` | you — automation never guesses intent. |
| `bug` / `enhancement` / `documentation` | you, on issues only — a PR's type already lives in its title. |

## Issues

Give issues the same care as PR titles: say the surface in the title, apply a
`scope:` label and a type label (`bug` / `enhancement` / `documentation`) when
you open one, and `blocked` when it waits on something — that is what keeps
the board navigable as the issue count grows.
