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
                                #   GitHub App name, smoke target, guards
secrets/<repo>.<env>.env.age    # age-encrypted values for the ${…} placeholders
.coolify.env                    # COOLIFY_BASE_URL + COOLIFY_ACCESS_TOKEN (never commit)
.coolify/<name>.env             # …the same, for a NAMED instance (see below)
```

Pass it with `--state <dir>`, or set `CAST_STATE`. Defaults to the cwd.

## Commands

```sh
cast apply     <org>/<repo> --env <env> [--path <dir>] [--hostname-overlay <file>]
cast diff      <org>/<repo> --env <env> [--full]
cast capture   <org>/<repo> --env <env> [--generated <NAME>] [--override <NAME>]
cast inventory <org>/<repo> --env <env>
cast server add <name> --ip <ip> --key <file> --env <env> [--user root] [--port 22]
cast smoke --env <env>
cast team [--env <env>]
```

- **`apply`** — idempotent create-or-update of every manifest resource, then
  redeploy what changed. One-way: it never deletes a resource that Coolify has
  and the manifest doesn't. Clones the repo's default branch unless `--path`
  points at a local checkout (refused with `--env prod` — prod always reads the
  default branch).
- **`diff`** — reports drift, manifest → Coolify. Structural by default; `--full`
  also compares env vars. Exits non-zero when dirty, so CI can gate on it.
- **`inventory`** — what is actually *on* a box, and how it lines up with the
  manifest: resources and env var **keys** (never values), sorted into
  on-both / manifest-only / box-only. Needs no store, no age key, and no
  recipient — it runs *before* adoption, which is the point of it. A document,
  read by a person; nothing here is consumed by `apply`. See *Adopting a
  hand-built instance*.
- **`capture`** — the adoption path: reads a hand-built instance's live env and
  writes the environment's age store from it. See *Adopting a hand-built
  instance* below.
- **`server add`** — uploads a server's private key and registers it with Coolify.
- **`smoke`** — contract test against `smoke_target`: proves Coolify's bulk env
  endpoint still *upserts* rather than replacing. Run it after every Coolify
  upgrade — `apply`'s never-delete guarantee rests on that behavior, and the
  published OpenAPI does not describe it accurately.
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

```sh
cast inventory heavy-duty/incubator --env prod --instance legacy \
  --project Incubator --environment production
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
| — | a resource isn't named after the manifest's → **refuses**; reconcile with `inventory` first |

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

## Secrets, and attended applies

An environment's age identity is resolved in exactly two ways:

1. `$CAST_AGE_KEY_FILE_<ENV>` — injected for this invocation
2. `~/.config/cast/age-<env>.key` — a standing key on this machine

That is the whole mechanism behind attended vs unattended applies: **an
environment whose key you never leave on disk can only be applied by someone who
injects it.** Keep a standing key for staging if you like; keep prod's in a
password manager and pass it per apply.

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
