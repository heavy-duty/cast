# cast

Point it at a repo and a state directory; it makes a **Coolify** instance match
what the repo declares. One-way, idempotent, never deletes.

Philosophy (shared with [rig](https://github.com/heavy-duty/rig) and
[claudebox](https://github.com/heavy-duty/claudebox)): **public tool, private
state.** cast holds no hostnames, no bindings, no secrets, nothing about *your*
infrastructure. It reads what you point it at and stores nothing, ever.

`rig` builds the boxes. `cast` fills them.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/heavy-duty/cast/main/install.sh | bash
```

Needs `node` >= 22.12 and [`age`](https://github.com/FiloSottile/age) (secrets
are decrypted by shelling out to it). Re-run any time to upgrade. Unlike rig —
which is pure bash so it can run on a bare box — cast runs on **your** machine:
it is an API client, and a server should never install it.

The installer symlinks `cast` into `~/.local/bin` (or `/usr/local/bin` as root)
and, if that directory is not already on your `PATH`, appends it to your shell
profile — `.zshrc`, `.bashrc`/`.bash_profile`, or `config.fish`, whichever your
`$SHELL` reads — marked `# added by cast-install` and written only once. The
shell you ran the installer from does not inherit it (a `curl | bash` pipeline
is a subshell), so open a new shell or `source` the profile it names. Set
`CAST_NO_MODIFY_PATH=1` to be left alone and wire `PATH` yourself.

## The two inputs

cast joins a **manifest** (what to deploy) with **state** (where, and with what
values). Neither knows about the other, which is the whole point: a manifest can
live in a product repo without leaking your infrastructure, and your
infrastructure can be re-pointed at a new Coolify without touching a product.

**1. The product repo's `.infra/`** — committed, instance-blind:

```
.infra/
  manifest.yaml                  # applications, databases, services, per environment
  env/<app>.<env>.env.template   # var NAMES + non-secret values; ${SECRET} placeholders
```

**2. A state directory** — private, yours:

```
environments.yaml               # bindings: the team each env's token must belong to,
                                #   which server it deploys onto, the S3 destination,
                                #   GitHub App name, guards — and, per project,
                                #   the destination it deploys onto + its smoke target
                                #   …plus `projects:`, the registry: which projects
                                #   exist, and in which environments
secrets/<repo>.<env>.env.age    # age-encrypted values for the ${…} placeholders
.coolify.env                    # COOLIFY_BASE_URL + COOLIFY_ACCESS_TOKEN (never commit)
.coolify/<name>.env             # …the same, for a NAMED instance (see below)
```

Pass it with `--state <dir>`, or set `CAST_STATE`. Defaults to the cwd.

## Commands

```sh
cast apply     <org>/<repo> --env <env> [--path <dir>] [--hostname-overlay <file>]
cast apply     --env <env> --all                # no repo: EVERY registered project
cast diff      <org>/<repo> --env <env> [--full]
cast diff      --env <env> --all [--full]       # no repo: EVERY registered project
cast capture   <org>/<repo> --env <env> [--generated <NAME>] [--override <NAME>]
cast inventory <org>/<repo> --env <env>
cast inventory --env <env> [--emit-draft <dir> [--recipient age1…] [--no-secrets]]
cast server add <name> --ip <ip> --key <file> --env <env> [--user root] [--port 22]
cast smoke     <org>/<repo> --env <env> [--project <name>] [--environment <name>]
cast team [--env <env>]
```

- **`apply`** — idempotent create-or-update of every manifest resource, then
  redeploy what changed. One-way: it never deletes a resource that Coolify has
  and the manifest doesn't. It creates the **project** and its **environment**
  when they are absent — the two things a resource create has to name — and then
  removes the empty `production` that Coolify hands every new project, which is
  the single delete cast performs and never touches a project built by hand
  ([docs/semantics.md](docs/semantics.md)). Clones the repo's default branch
  unless `--path` points at a local checkout (refused with `--env prod` — prod
  always reads the default branch).
- **`diff`** — reports drift, manifest → Coolify. Structural by default; `--full`
  also compares env vars. Exits non-zero when dirty, so CI can gate on it.
- **`--all`** — on `apply`/`diff`, act on **every project the registry lists for
  this environment** instead of one named repo. See *The whole environment at
  once* below.
- **`inventory`** — what is actually *on* a box. **With no repo it sweeps the
  instance** (every project, every environment, every resource — no manifest
  involved); with a repo it reconciles, showing resources and env var **keys**
  (never values) sorted into on-both / manifest-only / box-only. Needs no store,
  no age key, and no recipient — it runs *before* adoption, which is the point of
  it. A document, read by a person; nothing here is consumed by `apply`. See
  *Adopting a hand-built instance*.
- **`inventory --emit-draft <dir>`** — the sweep, written down as a **draft of
  cast's own inputs**: a manifest per project, env templates, an
  `environments.yaml` with the registry, an age store, and `UNCAPTURED.md`. A
  **proposal**, never desired state — `apply` does not read it. It is how a
  project that has *no* manifest gets its first one, and how you take a
  point-in-time blueprint of a box. See *Drafting a box that was never declared*.
- **`capture`** — the adoption path: reads a hand-built instance's live env and
  writes the environment's age store from it. See *Adopting a hand-built
  instance* below.
- **`server add`** — uploads a server's private key and registers it with Coolify.
- **`smoke`** — contract test against the project's `smoke_target`: proves
  Coolify's bulk env endpoint still *upserts* rather than replacing. Run it after
  every Coolify upgrade — `apply`'s never-delete guarantee rests on that behavior,
  and the published OpenAPI does not describe it accurately. It **writes** (two
  canary env vars onto that one application, then deletes them), so the repo is
  required: the target is resolved *inside the project and environment it was
  declared under*, with `--project` / `--environment` if the box names either
  differently, and it refuses rather than guessing when no application of that
  name is there. A bare app name is unique nowhere else — one instance carrying
  prod and staging is enough for the first `core` on it to be prod's.
- **`team`** — prints the team the configured token acts as. With `--env`, also
  checks it against that environment's `team:` binding and exits non-zero on a
  mismatch — the dry run for "would `apply` refuse?", answered without touching
  anything.

Every command that reaches a live Coolify takes an `--env`, because every one of
them first asserts the token's team (below).

`--hostname-overlay` swaps domains for a pre-flight run against temporary
hostnames; re-applying **without** it is the cutover.

## Cloning: cast authenticates, and never prompts

`apply`, `diff` and `capture` clone the product repo (unless `--path` points at a
local checkout — refused for prod, which always reads the default branch). For a
private repo that needs credentials, and cast resolves them itself:

1. **`gh`**, borrowed as a credential helper for that one invocation — it does
   not touch your global git config.
2. **`GITHUB_TOKEN` / `GH_TOKEN`** from the environment (the CI path).
3. Whatever git's own credential helper does, if you have one.

Being logged into `gh` is enough. You do **not** need `gh auth setup-git` —
that separate act is what wires git's helper, and not running it is exactly how
you end up at git's interactive username/password prompt, which GitHub no longer
accepts. cast sets `GIT_TERMINAL_PROMPT=0` on every path, so it can never hang
there or hide a credentials failure behind an error about *the repository*. With
no credentials at all it says so, and names the fix.

The token is never put in the clone URL or in `http.extraheader` — both leak it
into `ps`, and the latter persists it into the clone's git config.

## Many Coolifys

`--instance <name>` reads `<state>/.coolify/<name>.env` instead of
`<state>/.coolify.env`. Every verb that reaches Coolify takes it.

```sh
cast diff heavy-duty/incubator --env prod --full --instance legacy
```

An environment can bind one, so `--env` selects the right control plane with no
flag at all:

```yaml
environments:
  prod:
    server: prod-box
    team: { id: 1, name: heavy-duty }
    instance: prod-cp        # → <state>/.coolify/prod-cp.env
```

An explicit `--instance` still wins, so a one-off read against a legacy box needs
no edit to that file either. **With no flag and no binding, nothing changes** —
`.coolify.env` is read exactly as before.

Two properties, both deliberate:

- **An unknown `--instance` refuses**, and names the instances that do exist.
  Falling back to the default is how a diff meant for a legacy box gets run
  against production.
- **An instance may declare `COOLIFY_READ_ONLY=true`**, and then `apply`,
  `smoke` and `server add` refuse it — *before their first call*, and even
  though the token itself would permit the writes. That turns "I pointed the
  wrong token at the wrong box" from a live incident into an exit code.

Every command that reaches a Coolify now says which one, next to the team
assert. It is the most consequential input to any run, and the least visible.

## Adopting a hand-built instance

cast is otherwise scoped to the steady state: manifest → Coolify, forever.
Adoption is the one way in, and it has two verbs and a fixed order:

**`inventory` → you read it → a manifest PR → `capture` → `apply`**

**Look before you adopt.** A box nobody declared does not use your vocabulary:
its project is called whatever someone typed, its environment is Coolify's
default (`production`, not `prod`), and its resources are named by whoever
clicked *New Resource* that afternoon. `inventory` shows you both sides at once,
so those differences arrive together, as a document — instead of one at a time,
as refusals from a verb that is already halfway through a migration.

**First, sweep it — you cannot aim at coordinates you do not have yet:**

```sh
cast inventory --env prod --instance legacy
```

```
sweep — instance legacy (https://coolify.example.com)

  Incubator
    production     (empty)
    staging        2 applications, 2 databases, 1 service
      application  Incubator Stack v2
      application  Incubator Landing
      database     Incubator Database v2
      …
  La Familia Site
    production     1 application
      application  lafamilia-web
```

Note what that costs you to *not* have: Coolify auto-creates a `production`
environment in every project, so the obvious guess is empty and the live system
is somewhere else entirely — under a name someone typed, in a project you may
not have known was there. An environment with **zero** resources is far more
often the wrong coordinate than an empty one, and `inventory` says so rather than
quietly reporting that the manifest has five things the box lacks.

**Then reconcile**, against a target you now know exists:

```sh
cast inventory heavy-duty/incubator --env prod --instance legacy \
  --project Incubator --environment staging \
  --resource core="Incubator Stack v2"
```

It never reads a value, needs no store and no key, and its output is **not**
desired state. What you do with it is decide, resource by resource and key by
key, what the manifest should *gain* and what is cruft that must not travel —
and land that as a manifest PR. Only then:

```sh
CAST_CAPTURE_ADMIN_EMAIL=me@example.com \
  cast capture heavy-duty/incubator --env prod --instance legacy \
    --override ADMIN_EMAIL
```

It reads the required secret **names** from the manifest's own env templates (the
`${…}` refs — the manifest already declares exactly this set), reads the live
values off the instance, and classifies every name:

| | |
| --- | --- |
| **captured** | found live, value taken |
| **generated** | the manifest's `generated_secrets` declares it provider-made → written as the literal `pending-coolify-generated`, never the live value |
| **overridden** | supplied by you, for a value that must *not* be carried over |
| **missing** | required by a template, absent live → **refuses** |

Then it prints a plan of **names and provenance — never values** — and waits for
you to type the environment's name.

Before any of that, it checks that the resources the manifest names **exist**.
An absent resource reads back exactly like one with no env vars set: every name
it declares reports *missing*, and `--override` would then have you hand-carry
values that are sitting right there under a different name — writing a perfectly
valid store while the actual finding (the manifest and the box disagree about
what this thing is called) is never discovered. So a resource that isn't there
refuses, and names what is. `inventory` is how you reconcile it.

### Three names that are not yours

A hand-built box names things without asking you, at three levels, and cast takes
each as a coordinate to *read* with — never as a reason to rename anything of
yours:

| flag | when |
| --- | --- |
| `--project <name>` | the project isn't named after the repo (`Incubator`, not `incubator`) |
| `--environment <name>` | the environment isn't named after `--env` (Coolify's default is `production`, not `prod`) |
| `--resource <manifest>=<live>` | a resource isn't named after the manifest's (`core` is `Incubator Stack v2` over there). Repeatable |

None of them is ever a manifest field: they are arguments to a single run, because
a manifest that recorded a legacy box's names would carry a dead machine's
vocabulary forever.

`--project` and `--environment` are how a verb that must *find* a target says
where to look — `diff`, `capture`, `inventory`, `apply`, and `smoke`, which
resolves its `smoke_target` in exactly that project and that environment, and
refuses when it is not there (#29). `--resource` is **read-side only** (`diff`,
`capture`, `inventory`): `apply` refuses it outright, because it creates
resources under the manifest's own names — an alias there could only mean *adopt
the existing one instead*, which is a different operation and would otherwise
silently create a duplicate beside the resource you were pointing at.

`--env` stays **ours**: it selects the manifest block, the `environments.yaml`
binding, the age key, the store path. `--environment` is *theirs*, on the wire,
and nothing else. Collapsing the two lets a box that is being deleted next week
name the environment of the box that replaces it — `apply` creates the
environment from that value, so it would be inherited permanently.

The mapping is not mechanical, and that is the whole design. A `DATABASE_URL`
copied off the source box points at the *source box's* Postgres: confidently
wrong, entirely plausible, and the target's real URL does not exist until Coolify
creates the resource. So the manifest declares those names, and cast placeholds
them:

```yaml
environments:
  prod:
    generated_secrets: [DATABASE_URL_PROD, REDIS_URL_PROD, UMAMI_DATABASE_URL]
```

It is a manifest property rather than a flag you have to remember, because the
manifest is what knows `DATABASE_URL` comes from a database it declares. (A
`generated_secrets` entry no template refers to is a schema error — a guard
standing over nothing is worse than no guard, because it reads like one.
`--generated <NAME>` covers a manifest that hasn't declared them yet.)

An **`--override`**'s value is read from `$CAST_CAPTURE_<NAME>`, never from the
command line: argv is visible in `ps` to every process on the box. It exists for
values that must not survive the copy — staging and prod sharing a Mailgun
domain means a staging box carrying the real `ADMIN_EMAIL` can mail real users.

The store is encrypted to the environment's `age_recipient` (add it to
`environments.yaml` — it's the public half, safe to commit). Plaintext goes to
`age` on stdin: it is never a temp file, never on stdout, never in your shell
history. An existing store is not overwritten without `--force`.

**[docs/semantics.md](docs/semantics.md)** is the contract behind those
commands: what `apply` guarantees (never deletes, never recreates a database,
fails loudly rather than recreating on un-updatable drift), the `dockercompose`
build pack, the hostname-overlay shapes, and the places Coolify 4.1.2 does not
cooperate — each citation verified against `coollabsio/coolify` v4.1.2 and the
vendored OpenAPI in `reference/`. Read it before changing `apply`.

## Drafting a box that was never declared

`inventory` can see a whole instance. `--emit-draft` makes it **write down what
it sees**, in the shape of cast's own inputs:

```sh
cast inventory --env prod --instance box-b --emit-draft ./draft --recipient age1…
```

```
draft/
  environments.yaml                    # bindings as far as they can be read — with the projects: registry
  incubator/.infra/manifest.yaml       # one per project
  incubator/.infra/env/*.env.template
  la-familia/.infra/manifest.yaml      # …including the client sites nobody ever declared
  secrets/<project>.<env>.env.age      # encrypted to a recipient you name
  UNCAPTURED.md                        # ← the important file
```

Two uses: **bootstrapping a project that has no manifest** (the third-party sites
on the box being drained were never declared, and never will be unless something
writes the first draft — hand-transcribing them from a UI is exactly the work
cast exists to eliminate), and **a point-in-time blueprint** you could rebuild an
instance from.

### A draft is a PROPOSAL

**It is never desired state, and `apply` never reads it.** It is emitted,
reviewed by a human, and lands in a repo as a PR — the same shape as
`terraform import` → HCL:

**sweep → emit draft → you read it → manifest PR → `capture` → `apply`**

That boundary is the only reason the verb is allowed to exist, and it is
enforced, not merely documented:

- It **never emits into a repo that already has a manifest.** For a declared
  project the manifest *is* the truth, and one regenerated from a live box would
  let that box's accumulated cruft overwrite the reviewed spec — in the one
  direction nobody reviews. Adoption is one-way. A non-empty target directory is
  refused, and so is writing a manifest over an existing one.
- `--emit-draft` is **sweep-mode only**. With a repo, `inventory` is reconciling
  against a manifest that already exists, which is exactly the case where a draft
  must not be written. Refused.

### Two things would make a draft actively dangerous

**1. Copied provider-generated values.** A `DATABASE_URL` read off the source
points at the *source box's* Postgres. Emit it, rebuild elsewhere, and the new
box comes up **working** — reading and writing the old box's database. You find
out the day the old box is deleted. Same for `REDIS_URL`, and for Coolify's own
magic vars (`SERVICE_FQDN_*`, `SERVICE_URL_*`, `SERVICE_PASSWORD_*`), which are
generated per-instance and mean nothing anywhere else.

So the draft applies **`capture`'s discipline**: a provider-generated name is
**placeheld** with the same `pending-coolify-generated` literal, its live value
is not written into any artifact, and it is listed for disposition. The emitted
manifest declares it under `generated_secrets:`, so a later `capture` placeholds
it again with no flag to remember. A draft that is confidently wrong in four
entries out of seventeen is worse than one that is obviously incomplete.

The rule is **by name** — two families: Coolify's `SERVICE_*` magic vars, and any
name carrying a *datastore* word (`DATABASE`, `DB`, `POSTGRES`, `REDIS`, …) and a
*connection* word (`URL`, `HOST`, `PASSWORD`, …) as segments. It errs **wide** on
purpose, because the two errors are not symmetric: over-matching a real secret
placeholds it loudly and you put it back, while under-matching a generated one
copies it silently and rebuilds a box that quietly uses a dead machine's
database. Every value cast read is printed with its disposition — names and
provenance, never values — and a var that points at the source box under a name
cast does not recognize **will** have been copied. Read the table.

Every other live var becomes a `${REF}`, with its value in the **age store** —
never a literal in a committed file. cast cannot know which of a box's vars are
secret (nobody wrote it down; that is why this verb exists), and a live API key
written as a literal is a key in a git repo. Move the plainly-not-secret ones
back to literals yourself, in review.

The store is encrypted to a recipient you **name** — `--recipient age1…`, or the
environment's `age_recipient` binding. With neither, cast **refuses**: a draft
whose secrets were silently skipped looks complete and holds not one value.
`--no-secrets` says so deliberately.

**2. Silent losses.** cast cannot express everything a Coolify holds:
destinations (which Docker network a resource sits on — no API at all in 4.1.2),
service hostnames (they live per-container on `service.applications[].fqdn`),
Basic Auth and custom Traefik labels, the *Include Source Commit in Build*
toggle, whole database kinds (a MySQL is invisible to cast's manifest), backup
schedules, and anything else configured in the UI with no manifest field.

A blueprint that omits these **without saying so** is worse than no blueprint,
because in a disaster you would trust it and rebuild a *different box*. So
**`UNCAPTURED.md` is a first-class output**, listing per resource every live
setting cast saw and could not express — and it is **written on every run**, even
when it has little to say.

### What a blueprint still cannot restore

Worth stating plainly, because "rebuild from the repo" is routinely over-claimed:

| | |
| --- | --- |
| control plane | `rig coolify install` ✅ |
| structure | draft → manifest PR → `apply` ✅ |
| secret **values** | the age store + your key ✅ |
| **data** | Coolify's DB backups → S3 ✅ (a separate path) |
| **the GitHub App private key** | ❌ re-create by hand |
| **S3 access keys** | ❌ re-mint by hand |

The last two are **not in the repo** — correctly; it holds no live credentials —
and cannot be regenerated from it. A DR runbook has to say so. The same table is
emitted into every `UNCAPTURED.md`, because that is the file someone will be
reading at the worst possible moment.

One project per Coolify environment: a project with resources in **two**
populated environments is a tie cast will not break (picking would emit a
blueprint of half a box), so it refuses and `--environment <name>` says which. It
is a tiebreak, not a filter — a project with only one populated environment is
drafted from it either way, which is what keeps the client sites (each alone in
Coolify's default `production`) in a blueprint that claims to describe the box.

## Secrets, and attended applies

An environment's age identity is resolved in exactly two ways:

1. `$CAST_AGE_KEY_FILE_<ENV>` — injected for this invocation
2. `~/.config/cast/age-<env>.key` — a standing key on this machine

That is the whole mechanism behind attended vs unattended applies: **an
environment whose key you never leave on disk can only be applied by someone who
injects it.** Keep a standing key for staging if you like; keep prod's in a
password manager and pass it per apply, straight from the manager with a
process substitution:

```sh
CAST_AGE_KEY_FILE_PROD=<(pm read cast-prod-key) cast apply heavy-duty/incubator --env prod …
```

cast reads the identity itself and hands it to age on stdin, so this works even
though `<(…)` yields a path only cast's own process can resolve — and the key
never becomes a file, never appears in argv, and never enters the environment.

The state directory holds ciphertext. It must never hold the identity that opens
it.

## Teams: the one assert cast makes before it touches anything

Coolify API tokens are **team-scoped**, and a token pointed at another team's
resources **does not error**. The API resolves what the token cannot see to
`null` — and to a tool like cast, `null` is indistinguishable from *"this
resource does not exist yet"*, which is an invitation to create it. An `apply`
run with a wrong-team token would not fail; it would silently provision a
**duplicate set of resources into the wrong team**, on whatever server that team
owns. Silent, mutating, discovered late.

So every environment declares the team its token must belong to, and cast
refuses to do anything at all until it has checked:

```yaml
environments:
  prod:
    server: prod-box
    team: { id: 1, name: heavy-duty }
```

Give `id`, `name`, or both — both are compared when both are given. `id` is the
true identity (names can be renamed); `name` is what makes the file readable.
Run `cast team` to print the values for the token you currently have configured.

The check is **fail-closed**: an environment with no `team:` is one whose token
cannot be verified, so it is a schema error, not a warning. It runs before the
first *read*, not merely before the first write — an unasserted `diff` against
the wrong team would report "everything is absent", which is precisely the lie
that an `apply` would then act on.

Nothing below the team scopes a token. A Coolify environment has no team of its
own (it hangs off a project) and no API path scopes by one: **Coolify
environments are an organizational construct, not an auth boundary.** The team
is the only boundary there is, so it is the one cast asserts.

## The registry: which projects exist

`environments.yaml` says where things deploy *to*, and how a project you have
already named is placed once it is there. Until the `projects:` block, nothing in
it said **which projects exist at all** — "every project" was a thing the
operator remembered:

```yaml
projects:
  heavy-duty/incubator:
    environments: [prod, staging]
  acme/client-site:
    environments: [prod]
```

Keyed by the **full `<org>/<repo>` slug**, and the key *is* the repo — there is
no `repo:` field inside, because a second place to write the same string is a
second place for it to be wrong. Unlike `github_apps`, a bare `<repo>` key is
**refused** rather than resolved: this block is new, so it has no state files in
the wild to keep working, and a bare `<repo>` is unique only *within* an org —
which is exactly why it is not a key. `environments:` lists **our** environment
names (the values `--env` takes), never Coolify's.

The block is optional; a state file written before it loads unchanged.

**It has to be true, so cast checks that it is — at parse time, for every verb.**
Two ways it could quietly stop being true, both refused:

- an environment name that no `environments:` block defines (a typo). The project
  is real and its environment imaginary, so a fleet run visits nothing for it,
  reports nothing, and exits clean.
- an `environments.<env>.projects.<repo>` binding — a destination, a smoke target
  — in an environment the registry does not register that project for. The two
  blocks then describe two different fleets: state real enough for a direct
  `cast apply` to use, invisible to every fleet run. (Checked only when
  `projects:` is present.)

Both refusals defend one failure: **a silently skipped project reads exactly like
a clean one.** Silence is the one report that must never be ambiguous.

What it unlocks, neither of which was possible without a list to iterate:

- **fleet operations** — `cast diff --all` / `apply --all` over every project in
  an environment (below).
- **rebuild-from-state** — "restore this Coolify from the state repo" cannot even
  be *attempted* without knowing what was on it. The registry is the difference
  between a documented recovery and an archaeology exercise.

## The whole environment at once: `--all`

Every other cast verb is single-project, so *"do this to the whole instance"* was
a shell loop the operator wrote from memory — **and the project they forgot is the
one that drifted.** `--all` iterates the registry instead:

```sh
cast diff  --env prod --all      # every project registered for prod
cast apply --env prod --all
```

It runs the **same per-project path** the single-repo form runs (there is one
implementation of what a project run *is*), reports each project under its own
heading, and then prints an aggregate that leads with **coverage**:

```
fleet diff — prod

  registered:   3  (heavy-duty/incubator, acme/client-site, acme/landing)
  read:         2 of 3
  clean:        1  heavy-duty/incubator
  drift:        1  acme/landing
  UNREACHABLE:  1  acme/client-site
                   acme/client-site: refusing to diff: no project named "client-site" …
```

**A registered project cast cannot reach is an ERROR, not a skip** — the clone
failing, no manifest block for this environment, a missing or undecryptable
store, an absent Coolify project or environment, any HTTP error. A skipped
project reads exactly like a clean one, which would make the one report you get
most often (silence) the one you cannot trust. So the fleet **fails closed**: a
clean fleet diff means *every* project was read, not that the ones cast happened
to look at were fine.

| | |
|---|---|
| `diff --all` exit 0 | every registered project was **read**, and every one is clean |
| `diff --all` exit 1 | every one was read, and at least one has drift |
| `diff --all` exit 2 | a project could not be read — **outranks drift**, because an unread project is not a diff result, it is the absence of one |
| `apply --all` exit 0 | every registered project applied |
| `apply --all` non-zero | anything else |

The two verbs take opposite dispositions on failure, and both are deliberate:

- **`diff --all` runs every project to completion.** Stopping early would hide the
  drift in the projects it never reached — a partial read is exactly the report
  this flag exists to make impossible.
- **`apply --all` stops at the first failure**, and says which projects it
  applied and which it did not touch. Continuing to *mutate* a fleet after an
  unexplained failure is not a thing cast gets to do. `apply` is idempotent, so
  re-running after a fix is a no-op over the ones that already applied.

**An empty or absent registry refuses** (exit 2). `--all` over a state file with
no `projects:` block does *not* print "0 projects, clean" and exit 0 — an empty
fleet reading as a clean fleet is the whole failure this feature is against. The
refusal names what it looked for and prints the YAML to write.

**`--all` is mutually exclusive** with the repo positional and with every
single-project coordinate — `--path`, `--project`, `--environment`, `--resource`,
`--hostname-overlay`. Each of those names ONE project's checkout, ONE project's
Coolify name, ONE box's resource names; fleet-wide they are meaningless at best
and dangerous at worst (`--project X` applied to every project in the registry
would point them all at the same Coolify project — a false report on `diff`, and
on `apply` every manifest in the fleet written into one project). The refusal
names the offending flag.

## Two projects, one box: destinations

A **destination** is the Docker network a resource is created on. A server has a
default one, and while a server hosts a single project that default is the right
answer — which is why cast went so long without naming it.

The moment a server hosts *two* projects, it stops being: they share one network,
and "isolated" becomes a thing you believe rather than a thing that is true. So
the destination is declared per **project**, inside the environment — an
environment-scoped key could not express it, because `server:` is precisely the
thing two projects share:

```yaml
environments:
  prod:
    server: shared-box
    team: { id: 1, name: heavy-duty }
    projects:
      heavy-duty/incubator:
        destination_uuid: <uuid>     # the network THIS project's resources go on
        smoke_target: core           # the app `cast smoke` writes its canary to
      acme/client-site:
        destination_uuid: <other>
```

Keyed by repo, full `<org>/<repo>` slug first, exactly like `github_apps` — a
bare `<repo>` key still resolves, so existing state files keep working. Both
fields are optional, and an environment whose server hosts one project needs
neither.

A **UUID and not a name**, unlike `server:` right above it. Coolify 4.1.2 has no
destinations API whatsoever — no list, no read, nothing — so there is no name for
cast to resolve. You read the UUID out of the Coolify UI, the same way you do for
`s3_destination`.

**What cast can and cannot promise here.** It sends `destination_uuid` on create,
for applications, databases and services alike. It can never check it afterwards:
Coolify takes a UUID on write and hands back an integer `destination_id` on read,
and nothing maps between them. So `diff` does the one honest thing left — it
groups the live resources by the id Coolify *does* report, and a project whose
resources do not all share one network is **drift**:

```
split placement: these resources sit on 2 different destinations
  destination 1: application landing, database postgres
  destination 4: application core
  a project's resources must share one destination — that is what the isolation IS.
  apply never moves a live resource between networks: resolve manually (runbook act).
```

…and when you declare a destination, every `diff` says, out loud, that it did not
verify it. That is deliberate. A setting that reads back as *absent* rather than
*wrong* is the failure this whole file keeps trying not to be.

When you declare **nothing**, every `diff` says that too:

```
placement: server's default destination (none declared) — cast sends no destination_uuid,
  so Coolify picks; a server with more than one destination refuses the create outright.
```

Declaring nothing is not the absence of a placement decision. It is one, and it
used to be the only one cast made silently — the inference sat in a source comment
("the server's only destination, which is what Coolify picks anyway"), which is
exactly where an assumption is invisible until it is wrong.

One sharp edge worth knowing: on a server with exactly **one** destination,
Coolify ignores the `destination_uuid` you send and never validates it — a typo
there is invisible until a second destination exists. On a server with more than
one, a create that omits it is a hard `400`, which is why cast could not deploy
onto a shared box at all until it could send this. The asymmetry hides itself:
the day a server gains its second destination, every project on it that declared
no destination stops being able to create.

cast cannot warn you before that create — Coolify 4.1.2 serves no destinations
API, so a server's destination *count* is not knowable until a create has already
been attempted, and the 400 therefore lands **after** apply has made the project
and the environment. What cast does instead is answer it:

```
cannot create application core: prod-box has multiple destinations, so a create must say which one to use.

  Coolify said: POST /applications/private-github-app → 400: {"message":"Server has multiple destinations and you do not set destination_uuid."}

Read the destination UUID from the Coolify UI (4.1.2 exposes no API for it) and
declare it as:

    environments.prod.projects.heavy-duty/incubator.destination_uuid

Placement is create-time — a resource cannot be moved between networks later, so a
wrong or missing destination is repaired by delete + recreate, never by a later apply.

Re-run this apply once the UUID is declared: anything it already created (the project,
its environment) is adopted, not made twice — apply reads before it writes.
```

Details, with citations: [reference/README.md](reference/README.md).

## Guarding an environment

An environment may refuse variables by name pattern:

```yaml
environments:
  prod:
    server: prod-box
    team: { id: 1, name: heavy-duty }
    forbidden_var_patterns: ["^ALLOW_"]
```

`apply` then refuses if any such var is **present** on any resource, regardless
of value. `ALLOW_SEED=false` still fails: a var that exists can be flipped on
later in the Coolify UI without touching a manifest, so "off" has to mean absent.

This guard lives in your private state deliberately — not in the product's
manifest. A product-side change must not be able to lower its own guard.

## Scripts

Operational helpers, all argument-driven (`scripts/`): register a GitHub App with
Coolify, restore a database backup into a target container.

**They run where cast runs — off the box.** They drive the Coolify API, or reach a
box over SSH; none of them expects to be executing *on* a server. Anything that
belongs on a box, as root, under a scheduler is [rig](https://github.com/heavy-duty/rig)'s
job, not cast's — including the nightly age-encrypted dump of the control-plane
database, which is now `rig coolify backup install`.

## Development

```sh
npm ci && npm run build && npm test
npm run check          # biome
```
