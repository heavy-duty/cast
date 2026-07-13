# Behavior

The guarantees `cast apply` makes, the shapes it accepts, and the places
Coolify 4.1.2 does not cooperate. Extracted from the substrate repo this tool
was born in; the Coolify-source citations were verified against
`coollabsio/coolify` v4.1.2 and the vendored OpenAPI in `reference/`.


The command surface itself is in the README; this file is the behavior behind it.

## Team scoping

**A Coolify API token is scoped to exactly one team, and nothing below the team
scopes it.** `User::createToken` overrides Sanctum's and stamps the session's
team onto the token (`'team_id' => session('currentTeam')->id`); the API then
resolves every request through it — `getResourceByUuid($uuid,
getTeamIdFromToken())`, which walks `resource → environment → project →
team_id`.

The consequence that matters: **a wrong-team token does not error.**
`getResourceByUuid` returns `null` on a team mismatch, and `null` is
indistinguishable from *"this resource does not exist yet"* — which, to `apply`,
is an invitation to **create** it. An apply run with a token minted under the
wrong team would not fail loudly; it would provision a duplicate set of
resources into the wrong team, against whatever server that team owns. That is
why the team assert is a correctness guarantee and not a hardening nicety, and
why it is **fail-closed**:

- Every environment in `environments.yaml` **must** declare `team:` (`id`,
  `name`, or both). A missing team is a schema error — an environment whose
  token cannot be verified is exactly the failure the binding exists to prevent.
- Every command that reaches a live Coolify (`apply`, `diff`, `server add`,
  `smoke`) resolves `GET /teams/current` — the only endpoint that answers *"what
  team does this token act as?"*, resolved from the token itself
  (`TeamController@current_team` → `getTeamIdFromToken()`) — and compares it to
  the binding **before its first read**, aborting on mismatch. Before the first
  *read*, not merely the first write: a wrong-team `diff` reports "everything is
  absent", which is the very lie an `apply` would then act on.
- An unreadable or unauthorized answer aborts too. It is not "no team"; it is an
  unknown answer to the one question cast must not guess at.

**An Environment is not an auth boundary.** It has no `team_id` of its own (it
belongs to a project) and no API path scopes by it — Coolify environments are an
organizational construct. The team is the only boundary there is.

**A server belongs to exactly one team.** There is no pivot table and — unlike
`GithubApp` — no `is_system_wide` escape hatch; upstream confirms teams cannot
share a server and defers it to v5 (coollabsio/coolify#1820, #3235). Registering
a server under the wrong team is not fixable with a PATCH, which is why
`server add` takes `--env` and inherits the same assert.

**GitHub Apps, unlike servers, *can* be shared across teams** —
`is_system_wide` is the supported mechanism, on both the read and write side:

```php
// GithubController@list_github_apps (backs GET /github-apps)
$githubApps = GithubApp::where(function ($query) use ($teamId) {
    $query->where('team_id', $teamId)
        ->orWhere('is_system_wide', true);
    // …
```

`POST /github-apps` validates and accepts `is_system_wide` (boolean), stamping
`team_id` from the token. So **one App flagged system-wide is visible and usable
from every team, and per-team App duplication is unnecessary.** Note the
corollary for cast: because `GET /github-apps` deliberately includes other
teams' system-wide Apps, **resolving a GitHub App by name is not a proxy for
being in the right team** — which is the second reason the team assert has to be
explicit.

**`dockercompose` build pack** (compose apps, box-B parity): a manifest
application whose `build.pack` is `dockercompose` declares
`build.compose_file` (path to the compose file in the checkout) and
`service_domains` (map of compose service name → `string[]` of URLs) instead
of the plain-app `port`/`healthcheck`/`domains` trio — those three live in the
compose file itself and are rejected by the manifest schema on a compose app;
conversely `service_domains`/`compose_file` are rejected on a non-compose app.
`domains` is schema-optional at the top level for this reason, but still
required (via a `superRefine`) for every non-compose app — no existing
manifest needs to change.

```yaml
core:
  source: { repo: acme/widget, branch: main }
  build: { pack: dockercompose, base_directory: /, compose_file: docker-compose.yaml }
  service_domains:
    api: ["https://api.widget.example.com"]
  env_template: core.prod.env.template
```

Internally cast keeps the map vocabulary (`docker_compose_domains:
{service: string[]}`) all the way through `resolve.ts`/`apply.ts`/diffing;
only `cli.ts`'s wire-translation layer (`applicationApiFields`) flattens it to
the Coolify request shape — an array of `{name, domain}` where `domain` is
that service's URLs comma-joined (verified against the
`/applications/private-github-app` and `PATCH /applications/{uuid}` request
schemas in `reference/coolify-openapi-4.1.2.json`). A compose app's create
payload also sets `connect_to_docker_network: true` — without it the stack
cannot reach the environment's managed Postgres/Redis resources at all, which
fails at runtime rather than at apply time.

Live-state projection (`projectLiveFields`) reads both fields back for a
compose app: `docker_compose_location` (a plain string on the GET model) and
`docker_compose_domains`, which the GET model documents as a nullable
**string**, not the structured array the write side accepts — parsed
defensively as JSON back into the internal map, degrading to "field omitted"
(not a crash) on anything that doesn't parse as a well-formed array of
`{name, domain}`. Projecting both is what keeps a matching re-apply a true
no-op instead of a spurious PATCH + stack redeploy every run. **This parsing
path is unverified against a real Coolify instance** — the read-back is only
confirmed by an overlay apply followed by an overlay-edit re-apply against a
live instance, which has not yet happened. If a live instance turns out not to expose
`docker_compose_domains` on read, apply's idempotency guarantee for the
domains half breaks and needs the same warn-and-drop treatment as service
domains below — that also removes the cutover mechanism (domains no longer
flip via re-apply), so it would need a runbook amendment, not a silent fix.

**Hostname overlay, compose apps:** `--hostname-overlay <file>` accepts a
per-service map value for a compose app's entry instead of the plain-app
`string[]`:

```yaml
core:
  api: ["http://api.<PROD-IP>.sslip.io"]
landing: ["http://landing.<PROD-IP>.sslip.io"]
```

Only the named services' domain lists are replaced; other services in the
same app keep their manifest values. A map value naming an unknown service
errors, listing the app's known services; a map value against a non-compose
app errors (`hostname overlay gave a service map for non-compose app <name>`)
— the plain `string[]` shape keeps working unchanged for non-compose apps.

**Structural vs. full diff** are tied to what the configured token can do,
not a flag alone: **structural** diff needs only a standing read-only token
and never compares env values (output says so explicitly); **full** diff
(and `apply`, which always requires full) needs a session token with
`read:sensitive` and compares secret values too — but the output only ever
says `secret FOO differs`, never the value on either side.

**Apply semantics** (verbatim from the spec's Global Constraints — never
softened by an implementation detail):

- Apply never deletes. Resource removal or rename is a manual runbook act;
  `diff` reports the orphan as such until that act happens.
- Apply never recreates a database resource under any circumstances.
- On drift in a field the API cannot update in place (`build_pack`, a
  database's `type`/`version`, a service's `type`), apply **fails loudly
  naming the field** rather than recreating.
- Apply ends every mutated resource with a restart/redeploy
  (`instant_deploy` on create, `/deploy` or `/restart` on update) — API
  mutations land in Coolify's DB, not in running containers, so a create or
  update that skipped this would silently not take effect.
- Direction is one-way, manifest → Coolify, always.
- **Environment guards:** `apply` refuses if a var matching that environment's
  `forbidden_var_patterns` is present in the resolved env **at all, regardless
  of value** — "off" means absent, not `false` (see the README). `apply` also
  refuses `--path` combined with `--env prod`: prod always reads the default
  branch, so a feature-branch checkout can never reach it.

## The registry (`projects:`)

The top-level `projects:` block is the list of **which projects exist**, and in
which environments. It is the only place that says so: `environments:` says where
things deploy to, `environments.<env>.projects.<repo>` says how an already-named
project is placed, `github_apps` says how to clone one you have already named.

```yaml
projects:
  heavy-duty/incubator:
    environments: [prod, staging]
```

- **Keyed by the full `<org>/<repo>` slug, with no bare-`<repo>` fallback.** The
  key is the repo; there is no `repo:` field. `github_apps` and
  `environments.<env>.projects` accept a bare key because state files in the wild
  are written that way; this block is new and has none, so it requires the slug —
  a bare `<repo>` is unique only *within* an org.
- **`environments:` names OUR environments** — the keys of the `environments:`
  block, the values `--env` takes — never Coolify's. Non-empty.
- **Optional.** A state file with no `projects:` block loads unchanged, and
  `projectsIn` reports `[]` for every environment.

**Validated at parse time, so every verb refuses a registry that lies.** Two
refusals, both defending the same failure — *a silently skipped project reads
exactly like a clean one*, which makes silence, the most common report there is,
ambiguous:

1. **An environment that does not exist** (a typo in `projects.<slug>.environments`)
   is an error naming the unknown environment and listing the known ones. Left
   alone, the project would be registered into an environment no command can
   visit: a fleet run skips it, reports nothing, exits clean.
2. **A binding the registry does not register.** Every
   `environments.<env>.projects.<slug>` key must be a project the registry
   registers *for that environment*. Otherwise the two blocks describe two
   different fleets: a `destination_uuid` or `smoke_target` real enough for a
   direct `cast apply <repo> --env <env>` to act on, and invisible to every
   fleet run over that environment. Enforced **only when `projects:` is
   present**, so pre-registry state files keep loading.

The registry is what makes two things possible, neither of which can be attempted
without a list to iterate: **fleet operations** (`--all`), and
**rebuild-from-state** — restoring a Coolify from the state repo, which is
otherwise an assumption, since you cannot restore what you cannot enumerate.

## Placement (destinations)

A **destination** is the Docker network a resource is created on. It is declared
per project — `environments.<env>.projects.<repo>.destination_uuid` — because a
destination is scoped project × environment, and the environment block above it
says `server:`, which is exactly what two projects share.

**Enforced once, at create.** `apply` sends `destination_uuid` on every create
(applications, databases, services — Coolify runs identical destination logic in
all three controllers). It is never sent on update, and `apply` never moves a
live resource between networks.

**Not comparable, and therefore reported rather than compared.** Coolify 4.1.2
accepts a `destination_uuid` on write and returns a `destination_id` (an integer
primary key) on read, exposes no endpoint mapping one to the other, and in fact
has no destinations API at all (zero routes at `v4.1.2`). So the declared UUID
**cannot be verified against the live resource it was sent for** — by cast or by
anything else. Two consequences, both deliberate:

- `diff` never diffs the destination as a field. Doing so would compare a UUID
  against an int and report drift that could never be resolved — a phantom
  "update" on every run.
- `diff` instead groups live resources by the `destination_id` Coolify *does*
  report. That int is opaque, but it is comparable **to itself**, which catches
  the thing worth catching: a project whose resources do not all sit on one
  network is a project whose isolation is broken. That is `split placement`, and
  it is drift — non-clean, reported, and **not repaired** (same disposition as an
  orphan).
- Whenever a destination is declared, `diff` says explicitly that it was *not*
  compared. Silence would make an unverified setting read as a verified one —
  the failure shape this document exists to avoid.

**Coolify's create-time behavior** (`ApplicationsController` ~L1003,
`DatabasesController` ~L1700, `ServicesController` ~L378 @ v4.1.2): a server with
**one** destination uses it and *ignores* any `destination_uuid` sent, never
validating it — so a typo is invisible there. A server with **more than one**
rejects a create that omits it (`400`), and rejects a UUID that belongs to
another server (`422`). The second case is why cast could not apply to a shared
box at all before this field existed. Citations: `reference/README.md`.

## Instance selection

**The Coolify a command talks to is an explicit, named value** — not a property
of whatever `<state>/.coolify.env` happens to contain at the moment. Resolution
order, highest first:

1. `--instance <name>` → `<state>/.coolify/<name>.env`
2. the environment's `instance:` binding in `environments.yaml`
3. `<state>/.coolify.env` (the default; unchanged when neither of the above is
   used)

Two refusals, both fail-closed:

- **An unknown `--instance` aborts**, naming the instances that do exist. It
  does *not* fall back to the default — that fallback is how a `--full` diff
  meant for a legacy box gets run against production.
- **`COOLIFY_READ_ONLY=true` in an instance file makes it read-only**, and
  `apply` / `smoke` / `server add` refuse it *before their first call*. The
  guard is the **declaration**, not the token's scope: an instance configured
  for inspection must not be writable even when the token it holds would permit
  the writes. `diff`, `team` and `capture` still work against it — they read.

Every command that reaches a live Coolify prints which one, next to the team
assert.

## Adoption (`capture`)

`capture` is the only verb that writes *into* the state directory rather than
into Coolify, and the only one that reads a hand-built instance as a **source**
rather than as a target. It exists because cast is otherwise scoped to the
steady state and has no bootstrap path for a box that predates its manifest.

**The required set comes from the manifest, not from the box.** The names are
the `${…}` refs in that environment's env templates, read by the same parser
`apply` uses to demand them (`parseTemplate`, shared by `resolveTemplate` and
`templateRefs` — deliberately one grammar, because a drift between the two
would mean `capture` collects a different set than `apply` will later require,
which is the "a name silently missed" failure it exists to remove). So the store
it writes contains **exactly** the names the manifest requires: a live var
nobody asked for is not the store's business, and a template literal
(`NODE_ENV=production`) is not a secret.

**The mapping is not mechanical, and must not be.** Some entries encode
migration decisions rather than facts about the source box:

- A `DATABASE_URL` / `REDIS_URL` read off the source points at the **source
  box's** Postgres/Redis. Copying it is confidently wrong in a way that looks
  entirely plausible, and the target's real URL does not exist until Coolify
  creates the resource. These are declared `generated_secrets:` in the manifest
  environment and written as the literal `pending-coolify-generated`.
- staging's `ADMIN_EMAIL` must be the operator, not the source's value: staging
  and prod share a Mailgun domain, so a staging box carrying the real address
  can mail real users. That is `--override`.

A "capture everything" verb would therefore be silently wrong in a handful of
entries out of seventeen — worse than being wrong in all of them. So every
required name is **forced into a disposition**, and two of the four stop the
run:

| disposition | source | outcome |
| --- | --- | --- |
| captured | found live | value taken |
| generated | manifest `generated_secrets` (or `--generated`) | `pending-coolify-generated` |
| overridden | `$CAST_CAPTURE_<NAME>` | operator's value |
| **missing** | required by a template, absent live | **refuses** |
| **conflict** | one name, different live values on two resources | **refuses** |

`generated_secrets` is a **manifest** property, not a flag: the manifest is what
knows `DATABASE_URL` comes from a database it declares. An entry naming
something no template refs is a hard error — dead config here is not untidy but
dangerous, because it reads like a guard standing over a name while standing
over nothing, and the likeliest cause is a typo whose real name is then
*captured* from the source box instead of placeheld.

**Secret hygiene**, all enforced by tests against real values:

- The plan prints **names and provenance, never values**. (The one value-shaped
  thing it prints is the `pending-coolify-generated` literal, which carries no
  information about the source.)
- An `--override`'s value is read from `$CAST_CAPTURE_<NAME>`, **never from
  argv** — a command-line value is visible in `ps` to every process on the box.
- Plaintext is piped to `age` on **stdin**: never a temp file, never stdout,
  never shell history. The hand-run recipe this replaces wrote
  `/dev/shm/prod.env` and relied on remembering to `shred -u` it.
- An existing store is **not overwritten** without `--force`: it may hold the
  only copy of values the source box no longer has. Same disposition as apply's
  never-delete.

**`capture` takes `diff`'s position on an absent target** (see `LiveLookup`),
and refuses one: against a project or environment that isn't there it would read
back zero live values and report every required secret as *missing* — an
alarming, meaningless report about the wrong box. It also inherits the team
assert (a wrong-team token reads back `null` for everything, producing the same
lie) and the `--path`-with-`--env prod` refusal (a feature-branch manifest must
not decide which names land in the prod store).

The final gate is a **typed confirmation** — the environment's own name, after
the plan. There is no `--yes`: a store written without someone reading the
provenance column is the outcome the verb exists to prevent. A closed stdin
aborts rather than hanging.

## Drafts (`inventory --emit-draft`)

`inventory` with no repo sweeps an instance. `--emit-draft <dir>` writes that
sweep down as a draft of cast's **own inputs** — a manifest per project, env
templates, an `environments.yaml` carrying the `projects:` registry, an age store
per project, and `UNCAPTURED.md`.

**A draft is a PROPOSAL. It is never desired state, and `apply` never reads it.**

    sweep → emit draft → a human reads it → manifest PR → capture → apply

Same shape as `terraform import` → HCL. Every other rule in this section follows
from that one, and each is enforced rather than merely stated:

| refusal | why |
| --- | --- |
| a **non-empty** target directory | emitted over a repo that has a manifest, a draft would overwrite a reviewed spec with a live box's accumulated cruft — the one direction nobody reviews. **Adoption is one-way.** |
| an **existing manifest** at the path it would write | the same invariant, once more at the file (`assertNoExistingManifest`). For a declared project the manifest *is* the truth; `cast inventory <org>/<repo>` reconciles it instead. |
| `--emit-draft` with a **repo positional** | with a repo, inventory reconciles against a manifest that already exists — exactly the case where a draft must not be written. |
| **no age recipient** (and no `--no-secrets`) | a draft whose store was silently skipped *looks complete*: a manifest, templates full of `${REF}`s, and not one value anywhere. You would find out when `apply` refused, some time after the box those values were on stopped existing. |
| a project with **two populated environments** | a draft carries one environment per project. Picking would emit a blueprint of *half a box* that says nothing about the other half. `--environment` breaks the tie — as a **tiebreak, not a filter**: a project with one populated environment is drafted from it either way, or filtering by name would drop whole projects (each client site sits alone in Coolify's default `production`) out of a blueprint that claims to describe the box. |

**Provider-generated names are placeheld, never copied.** This is `capture`'s
discipline (see above), applied to a verb that has no manifest to tell it which
names are generated — so it decides **by name**, in two families:

1. Coolify's per-instance magic vars — `SERVICE_FQDN_*`, `SERVICE_URL_*`,
   `SERVICE_PASSWORD_*`, `SERVICE_USER_*`, `SERVICE_BASE64_*`.
2. Any name carrying a **datastore** word (`DATABASE`, `DB`, `POSTGRES`, `PG`,
   `REDIS`, `MONGO`, …) *and* a **connection** word (`URL`, `URI`, `DSN`, `HOST`,
   `PORT`, `PASSWORD`, `USER`, …) as underscore-delimited segments —
   `DATABASE_URL`, `UMAMI_DATABASE_URL`, `REDIS_URL_PROD`, `DB_HOST`.

Each such name is written as the literal `pending-coolify-generated`, listed in
the run's disposition table, and declared under the emitted manifest's
`generated_secrets:` — so a later `capture` placeholds it again with no flag to
remember. **Its live value is not written into any artifact.**

The rule errs **wide**, deliberately, because the two errors are not symmetric:

- over-match a real secret → it is placeheld, reported, and you put the value
  back. Noisy, recoverable, **loud**.
- under-match a generated one → it is copied, and a box rebuilt from the draft
  comes up **working**, reading and writing the *source box's* database, until
  the day that box is deleted. Silent, unrecoverable, **quiet**.

It is a name-pattern rule, not a promise: a var that points at the source box
under a name cast does not recognize **will** be copied. The disposition table
(names and provenance, **never values** — same contract as the capture plan) is
what a reviewer reads to catch it.

**Every other live var becomes a `${REF}`**, with its value in the age store —
never a template literal. cast cannot know which of a box's vars are secret
(nobody wrote it down, which is why the verb exists), and the two mistakes are
again asymmetric: a non-secret in an encrypted store is untidy, a live API key
written as a literal into a manifest is a key in a git repo. One name carrying
**different values** on two resources is not a conflict cast resolves (one store
holds one value per name — see `capture`'s CONFLICT refusal): both are kept,
under `<RESOURCE>_<KEY>` refs, and the split is reported.

**`UNCAPTURED.md` is a first-class output, emitted on every run.** cast cannot
express everything a Coolify holds, and a blueprint that omits those things
without saying so is worse than no blueprint — in a disaster you would trust it
and rebuild a *different box*. Per resource, it names what was seen and could not
be written: `destination_id` (which Docker network — no destinations API in 4.1.2
to resolve it to the UUID `destination_uuid:` wants, #21), service hostnames (no
flat `domains` on a Coolify 4.1.2 service), Basic Auth / custom Traefik labels,
build and deploy command overrides, backup schedules (not exposed on a database's
GET — **a rebuild has no backups until you declare them**), database kinds cast
does not model (MySQL, MariaDB, MongoDB, KeyDB, Dragonfly, ClickHouse — named,
never silently dropped), env var names a cast template cannot express, and
applications whose build pack the manifest has no vocabulary for (left *out* of
the manifest rather than fabricated into the nearest pack).

It also carries the table below, because that is the file someone will be reading
at the worst possible moment.

### What a blueprint still cannot restore

| | |
| --- | --- |
| control plane | `rig coolify install` ✅ |
| structure | draft → manifest PR → `apply` ✅ |
| secret **values** | the age store + your key ✅ |
| **data** | Coolify's DB backups → S3 ✅ (a separate path) |
| **the GitHub App private key** | ❌ re-create by hand |
| **S3 access keys** | ❌ re-mint by hand |

The last two are not in the state repo — correctly, it holds no live credentials
— and cannot be regenerated from it. A DR runbook that does not say so is not a
runbook.

**What the box cannot tell you, and cast therefore does not invent:** the
`<org>/<repo>` slug comes from an application's git remote (the only place a live
box knows it), so a project with **no application** — a lone service — has no repo
on the box at all. cast writes the bare project name as the registry key, and the
registry's own parse-time refusal (*"a registry key has no meaning without its
org"*) then stops the file being used until a human supplies it. That refusal is
the design: the alternatives are inventing an org, or leaving the project out of
the registry — and a project missing from the registry is one every fleet run
skips **in silence**. Likewise `github_apps`: nothing Coolify returns about an
application says which App cloned it, so cast binds every repo to the instance's
only GitHub App when there is exactly one (there is no other it could be), and
writes a `REVIEW-…` marker when there is not.

## Cloning a private manifest

`resolveCheckout` resolves git credentials **inside cast**, in a fixed order —
`gh` borrowed as a per-invocation credential helper, then
`GITHUB_TOKEN`/`GH_TOKEN`, then the ambient helper — rather than leaving it to
whatever the workstation's git config happens to do.

It matters because `gh auth login` **does not** wire git's credential helper
(that is `gh auth setup-git`, a separate act most people never run), so a
perfectly logged-in operator still fell through to git's interactive
username/password prompt — which GitHub no longer accepts — and got an error
about *the repository* rather than about the missing credentials. There is no
routing around it for prod: `--path` is refused there, so the clone is the only
path and its auth is mandatory.

`GIT_TERMINAL_PROMPT=0` is set on every path, so cast can never hang on or fall
into that prompt. The token is never placed in the clone URL or in
`http.extraheader` — both leak it into `ps`, and the latter persists it into the
clone's `.git/config`; the helper reads it from the environment at run time, so
what lands in argv is the literal text `$CAST_GIT_TOKEN`. Note that the empty
`credential.helper=` reset clears **URL-scoped** helpers
(`credential.https://github.com.helper`, which is what `gh auth setup-git`
writes) as well as generic ones, so cast's chosen credential is genuinely the
one used — verified against a live private clone.

**Known limitations, not defects:**

- **Backup schedules are create-time only.** A manifest database's `backup`
  block (`frequency`, `retention`) is applied only when the database is
  first created; it is deliberately kept out of the diffed `fields` (live
  Coolify state doesn't expose it back, so diffing it would flag spurious
  drift every run — breaking idempotency). Changing a schedule on an
  existing database is a runbook act, done by hand in the Coolify UI.
- **A service's `domains` cannot be applied via the API in Coolify 4.1.2,
  and is deliberately kept out of the diffed `fields` for the same
  idempotency reason as backup schedules above.** The `/services`
  create/update payload takes a structured per-container `urls` list, not
  the manifest's flat `domains: string[]`, and the manifest has no
  per-container name to build that list correctly from — so cast
  drops it rather than send a malformed payload. Live Coolify service state
  doesn't expose a flat `domains` back either, so if it stayed in `fields`
  every domain-bearing service would diff as a perpetual update and every
  `apply` would needlessly restart it — `desiredFromManifest` drops
  `domains` from the service's `fields` and **warns**
  (`service <name> declares domains (...), but apply cannot set them on
  Coolify 4.1.2 services — configure hostnames manually in the Coolify UI`)
  once per run for every service that declared any. Set service hostnames
  in the Coolify UI by hand.
- **The redis default image is an unverified extrapolation.** Coolify's
  "New Resource" wizard drives PostgreSQL version selection through a
  verified `postgres:<version>-alpine` image string; Redis has no version
  picker in that same wizard, so cast's `redis:<version>-alpine`
  guess for a manifest-declared `version` is the same Docker Hub tag
  convention applied by analogy, **not confirmed against a live Coolify
  instance**. Recommendation: leave a manifest database's `version` unset
  for `redis` until this has been verified once against bootstrap, letting
  Coolify pick its own default image instead of risking a bad tag.
