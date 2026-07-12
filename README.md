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
environments.yaml               # bindings: which server each env deploys onto, the S3
                                #   destination, GitHub App name, smoke target, guards
secrets/<repo>.<env>.env.age    # age-encrypted values for the ${…} placeholders
.coolify.env                    # COOLIFY_BASE_URL + COOLIFY_ACCESS_TOKEN (never commit)
```

Pass it with `--state <dir>`, or set `CAST_STATE`. Defaults to the cwd.

## Commands

```sh
cast apply <org>/<repo> --env <env> [--path <dir>] [--hostname-overlay <file>]
cast diff  <org>/<repo> --env <env> [--full]
cast server add <name> --ip <ip> --key <file> [--user root] [--port 22]
cast smoke
```

- **`apply`** — idempotent create-or-update of every manifest resource, then
  redeploy what changed. One-way: it never deletes a resource that Coolify has
  and the manifest doesn't. Clones the repo's default branch unless `--path`
  points at a local checkout (refused with `--env prod` — prod always reads the
  default branch).
- **`diff`** — reports drift, manifest → Coolify. Structural by default; `--full`
  also compares env vars. Exits non-zero when dirty, so CI can gate on it.
- **`server add`** — uploads a server's private key and registers it with Coolify.
- **`smoke`** — contract test against `smoke_target`: proves Coolify's bulk env
  endpoint still *upserts* rather than replacing. Run it after every Coolify
  upgrade — `apply`'s never-delete guarantee rests on that behavior, and the
  published OpenAPI does not describe it accurately.

`--hostname-overlay` swaps domains for a pre-flight run against temporary
hostnames; re-applying **without** it is the cutover.

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

## Guarding an environment

An environment may refuse variables by name pattern:

```yaml
environments:
  prod:
    server: prod-box
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
