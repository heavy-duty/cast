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
6. **When the round passes, the author hands the PR to the maintainer** in
   three acts, in this order: post the tagged round summary, request the
   maintainer's review, then set `state:needs-human` yourself — removing the
   state label it replaces. The review request is what *earns* the label,
   provided the PR carries **no `blocker:*` label**. A blocker means the work
   is still yours whatever the round said, so on a conflicted or red PR
   neither the request nor your own label write will stick — the sweep takes
   it straight back off. With three formal head-current approvals the labels
   workflow requests the maintainer automatically; when part of the panel is
   comment-only, reading their agreement is the author's judgment, so the
   author makes the request.

   Writing the label by hand is an **optimistic write, not a transfer of
   ownership**. The machine stays the authority — but because the workflow
   wakes on `labeled`, the author's own write fires the sweep that validates
   it, and a handoff that had not earned the label is corrected seconds later.
   Forgetting the write is not a failure either; it only means the label waits
   for the cron, which is the lag this replaced.
7. **Checks must be green**: `npm run check`, `npm run build`, and
   `npm test` locally mirror what CI runs.
8. **Feature PRs land their changelog entry as part of the PR** (box's
   convention): add it under `CHANGELOG.md`'s `## Unreleased` heading —
   that section becomes the release notes verbatim when a release is cut.

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

A release is a PR, and merging it IS the release
([#111](https://github.com/heavy-duty/cast/issues/111); box#96's design,
on box#83's shape):

1. A small PR — `release: X.Y.Z`, labeled `release` — bumps `package.json`'s
   `version` (and `package-lock.json`; `npm install --package-lock-only`
   keeps them in step) and stamps `CHANGELOG.md`'s Unreleased section as
   `## X.Y.Z — YYYY-MM-DD`. **Then re-arm: add a fresh, empty
   `## Unreleased` immediately above the section you just stamped.** The
   same PR, the same diff — stamping without re-arming leaves main with no
   `## Unreleased`, and the next PR that was authored before the release
   and merged after has its entry land *inside the shipped section*, which
   git does cleanly, with no conflict to warn anyone
   (heavy-duty/rig#66 — it happened there). `test/release.test.ts` keys
   this to the version, and checks both halves of the stamp:
   - while `package.json` is bare, the top section may be the stamp or the
     re-armed `## Unreleased`, but a `## X.Y.Z` section for the version you
     are shipping **must exist and extract non-empty** — a bump without a
     stamp is red here rather than after the merge, in release.yml;
   - the moment step 4's `-dev` bump lands, the top section must be
     `## Unreleased` or CI is red.

   The empty `## Unreleased` this step adds is deliberately tolerated: what
   must extract non-empty is the section that SHIPS, not the top one. CI
   green on it, same loop as any PR.
2. **Drill, and record it.** Before the PR can be handed over, run the full
   real-hardware drill — two live Coolify instances, the whole A→B promotion:
   team, apply, an idempotent diff, smoke, inventory, emit-draft, fleet,
   destroy, and the read-only guard — and record it in a file named for the
   version, one record per version:

       drills/X.Y.Z.md

   The name matches `package.json`'s `version` exactly, and the file must hold
   at least one non-whitespace character. See
   [drills/README.md](drills/README.md) for what a record contains.

   [.github/scripts/drill-recorded.sh](.github/scripts/drill-recorded.sh)
   enforces this on every release PR (a `-dev` tree has no ship claim and
   passes trivially). It is **not a thing a reviewer has to remember** — that
   is precisely how every release in this family shipped without one until a
   bot blocked on it.

   So the release flow is: **draft → ready → bot round → drill →
   `state:needs-human` → maintainer merge (which IS the release).**

   **The three repos' drills are independent.** Run them in any order, on any
   schedule, in separate sittings. They are not three phases of one script.

   What makes that safe is that every drill **pins the same fixed set of
   candidate refs**, so each one exercises exactly the combination that will
   ship rather than whatever `main` happens to be that afternoon. The run
   drills **candidate refs, not released artifacts**: `RIG_REPO` and `RIG_REF`
   are mint-time environment variables (default `heavy-duty/rig@main`), so a
   run pins the exact commits under test.

   That pinning — **not sequencing** — is what dissolves the box↔rig
   recursion. box and rig *are* mutually recursive: rig builds the host that
   runs box, and box's seed calls rig back to converge the guest. But
   candidate refs are static identifiers that exist as soon as the release
   branches do, long before any drill runs, so a cycle at runtime becomes
   independent tests against one fixed pair. No repo has to be released
   before another can be drilled, and there is **no fixed order in which the
   three releases must be published.**

   Each repo also drills a **different thing**: box asserts the isolation
   contract (the VM trust boundary), rig asserts convergence (a machine
   reaches its role, idempotently), cast asserts promotion (A→B reproduces,
   and the diff is idempotent). Three different exercises sharing a
   substrate — which is exactly why the records are per-repo.

   cast's legs are the **least coupled** of the three: two Coolify instances
   can be stood up by hand, as the July drill did for instance B via a
   parameterised compose file. Within a single drill you of course bring the
   substrate up before probing it — a host before a guest before Coolify —
   but that is how you run *a* drill, not an ordering rule *between repos*.

   Drilling the candidate **is** drilling the release. A release PR's diff is
   the version file and `CHANGELOG.md` — nothing executable differs between
   the tree that was drilled and the tree that ships, so the evidence carries
   across the ceremony commit.

   Each repo records ITS OWN legs in its own `drills/X.Y.Z.md`, citing the
   shared **run ID** that names the pinned set and the other two repos' commit
   SHAs — which is what lets separate records be reassembled into one picture.
   The guard still reads only this repo's files: cast never queries box's or
   rig's drill records to decide whether cast may ship, because a cross-repo
   lookup degrades to "pass" the moment it fails to resolve — the
   unreadable-rollup bug wearing a different hat.

   If a defect shows up only in the combination: patch, re-drill, re-record.
   The three releases converge on a set that holds together; they are not
   required to be right in one pass.

   A maintainer **waiver** is possible — but it must be RECORDED in
   `drills/X.Y.Z.md` for that version, saying who waived it and what is
   untested. The guard requires a *record*, not a passing result, so skipping
   the drill stays possible and stays visible and deliberate.
3. **Merge. That's the ship decision — nothing else to do.**
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
4. **The release re-arms main itself**: the same workflow run bumps
   `package.json` (and `package-lock.json`) to `X.Y.(Z+1)-dev` and pushes
   the commit straight to main — no follow-up PR (it opens one only if
   branch protection refuses the direct push, and says so loudly).
   Installs are versioned by the tree's `package.json` version, so a
   `CAST_REF=main` install between releases must land as
   `versions/X.Y.(Z+1)-dev`, never as `versions/X.Y.Z` — main's tree must
   not impersonate the release it merely descends from. On the *manual*
   tag path the bump stays yours: open the one-line PR after publishing.
   This step re-arms the **version** only — the `## Unreleased` heading is
   step 1's, in the ceremony PR's own diff, because no workflow ever writes
   `CHANGELOG.md`. The two halves meet in `test/release.test.ts`: once this
   bump makes the version `-dev`, a missing `## Unreleased` is CI-red.

## Labels — who sets what

The full taxonomy lives in [LABELS.md](LABELS.md). What matters day to day is
who sets each kind — most of it is machinery, and hand-moving a
machine-owned label just gets corrected on the next pass:

| Labels | Set by |
|---|---|
| `state:*` | the labels workflow ([.github/workflows/labels.yml](.github/workflows/labels.yml)) — recomputed from GitHub's own facts on PR events (label changes included) and every 15 minutes. Machine-owned, with one exception: the author sets `state:needs-human` at handoff (step 6) and the workflow reconciles it. Otherwise never by hand. Exactly one per PR: *whose ball is it.* |
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
