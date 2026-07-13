#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { type Executor, applyHostnameOverlay, applyPlan } from "./apply.js";
import { githubAppNameFor, loadBindings } from "./bindings.js";
import {
  type CoolifyInstance,
  assertWritable,
  formatInstance,
  loadInstance,
} from "./config.js";
import { CoolifyClient, HttpError } from "./coolify.js";
import {
  type Live,
  type ResourceKind,
  computeDiff,
  renderDiff,
} from "./diff.js";
import { assertEnvVarPolicy } from "./envtemplate.js";
import { desiredFromManifest, resolveCheckout } from "./resolve.js";
import { decryptSecrets, keyFileFor, secretsFileFor } from "./secrets.js";
import { serverAdd } from "./server.js";
import { smoke } from "./smoke.js";
import { assertTeam, formatTeam } from "./team.js";

const USAGE = `usage: cast apply <org>/<repo> --env <env> [--path <dir>] [--project <name>] [--hostname-overlay <file>]
       cast diff  <org>/<repo> --env <env> [--full] [--project <name>]
       cast server add <name> --ip <ip> --key <file> --env <env> [--user root] [--port 22]
       cast smoke --env <env>
       cast team [--env <env>]

  --state <dir>   the state checkout holding environments.yaml, secrets/ and
                  .coolify.env  (default: $CAST_STATE, else the cwd)
  --env <env>     the environment to act on. Every command that reaches a live
                  Coolify takes one, because every one of them first asserts
                  the token belongs to that environment's declared team.
                  \`cast team\` alone (no --env) reports the token's team
                  without needing a binding — use it to fill environments.yaml.
  --instance <name>
                  the Coolify to talk to: <state>/.coolify/<name>.env, instead
                  of <state>/.coolify.env. Bind one per environment in
                  environments.yaml (\`instance: <name>\`) and --env selects it
                  with no flag; an explicit --instance still wins. An instance
                  may declare COOLIFY_READ_ONLY=true, and then no command that
                  writes will run against it.
  --project <name>
                  the Coolify project to act on, when it is not named after the
                  repo (the default). A project built by hand in the UI is called
                  whatever someone typed; \`diff\` refuses rather than reporting an
                  absent project as an empty one, and this is how you point it at
                  the real name.`;

// cast is stateless: every instance-scoped input is read from the state
// directory it is pointed at, never from a location the tool itself knows.
function stateDirFrom(flag: string | undefined): string {
  return flag ?? process.env.CAST_STATE ?? ".";
}

// Resolve which Coolify to talk to, announce it, and open a client on it.
//
// Precedence: --instance > the environment's `instance:` binding > the
// default .coolify.env. Every command that reaches a live Coolify goes through
// here, so every one of them SAYS which Coolify it is about to touch, right
// next to the team assert. The connection target used to be implicit in
// .coolify.env's current contents — retargeting meant hand-editing a live
// credential file and putting it back afterwards, and the failure mode of
// getting it wrong is running `apply` against production.
function openCoolify(
  stateDir: string,
  flag: string | undefined,
  binding?: { instance?: string },
): { instance: CoolifyInstance; client: CoolifyClient } {
  const instance = loadInstance(stateDir, flag ?? binding?.instance);
  console.log(formatInstance(instance));
  return {
    instance,
    client: new CoolifyClient(instance.baseUrl, instance.token),
  };
}

// Live Coolify objects use their own field vocabulary; computeDiff compares
// by the DESIRED vocabulary, so each live resource must be projected onto it
// or every run reports spurious drift (breaks idempotency, criterion 2).
// Source keys per reference/coolify-openapi-4.1.2.json, cross-checked
// against the coollabsio/coolify v4.1.2 controller/model source where the
// vendored doc is silent or wrong (see task-8-report.md for the full list).
const DATABASE_TYPE_ALIASES: Record<string, string> = {
  "standalone-postgresql": "postgresql",
  "standalone-redis": "redis",
};

export function databaseVersionFromImage(image: unknown): string | undefined {
  if (typeof image !== "string") return undefined;
  const tag = image.split(":")[1];
  const m = tag?.match(/^(\d+(?:\.\d+)*)/);
  return m?.[1];
}

// Coolify's GET application model exposes `docker_compose_domains` as a
// nullable string (reference/coolify-openapi-4.1.2.json ~line 12689), not
// the structured array the create/update request bodies accept (~line 353) —
// the live value is the same array-of-{name,domain} shape, JSON-encoded.
// Parses defensively: anything that isn't a JSON-encoded array of well-formed
// {name, domain} entries collapses to `undefined` rather than throwing, so a
// live instance that turns out not to expose this (unverified until Task 8
// step 6) degrades to "field omitted", not a crash.
export function parseDockerComposeDomains(
  raw: unknown,
): Record<string, string[]> | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const map: Record<string, string[]> = {};
  for (const entry of parsed) {
    const name = (entry as { name?: unknown } | null)?.name;
    const domain = (entry as { domain?: unknown } | null)?.domain;
    if (typeof name === "string" && typeof domain === "string") {
      map[name] = domain.split(",").filter(Boolean);
    }
  }
  return map;
}

export function projectLiveFields(
  kind: ResourceKind,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === "application") {
    const composeDomains = parseDockerComposeDomains(
      raw.docker_compose_domains,
    );
    return {
      git_repository: raw.git_repository,
      git_branch: raw.git_branch,
      build_pack: raw.build_pack,
      base_directory: raw.base_directory,
      ...(raw.publish_directory
        ? { publish_directory: raw.publish_directory }
        : {}),
      ...(raw.ports_exposes ? { port: Number(raw.ports_exposes) } : {}),
      ...(raw.health_check_path ? { healthcheck: raw.health_check_path } : {}),
      domains: String(raw.fqdn ?? "")
        .split(",")
        .filter(Boolean),
      ...(raw.docker_compose_location
        ? { docker_compose_location: raw.docker_compose_location }
        : {}),
      ...(composeDomains ? { docker_compose_domains: composeDomains } : {}),
    };
  }
  if (kind === "database") {
    // GET /projects/{uuid}/{env} returns raw Postgresql/Redis Eloquent
    // models (see fetchLive) — the vendored OpenAPI documents no schema for
    // these at all ("Content is very complex. Will be implemented later.").
    // `database_type` is a model accessor (app/Models/StandalonePostgresql.php
    // / StandaloneRedis.php @ v4.1.2) returning "standalone-postgresql" /
    // "standalone-redis"; normalized here to the manifest's plain
    // "postgresql"/"redis" vocabulary. There is no `version` field on the
    // wire — we best-effort recover it from the leading digits of the
    // `image` tag, mirroring the convention Coolify's own "New Resource"
    // wizard writes on create (see defaultDatabaseImage below).
    const rawType = String(raw.database_type ?? raw.type ?? "");
    const type = DATABASE_TYPE_ALIASES[rawType] ?? rawType;
    const version = databaseVersionFromImage(raw.image);
    return { type, ...(version ? { version } : {}) };
  }
  return {
    type: raw.type ?? raw.service_type,
    // Coolify's live `Service` model carries no flat `fqdn` — hostnames
    // live per-container on service.applications[].fqdn
    // (app/Models/Service.php @ v4.1.2), which this environment-list call
    // doesn't eager-load. We deliberately don't fabricate a `domains` value
    // here; see serviceApiFields below for the matching create/update-side
    // limitation.
  };
}

// The live side of a diff/apply is either "here are the resources" or "the
// thing I was told to look at does not exist" — and those two must NOT collapse
// into the same value.
//
// They used to: both returned []. That is right for `apply` (a first apply
// legitimately creates the project and its environment) and quietly wrong for
// `diff`, because computeDiff(desired, []) means "every desired resource is
// missing" — rendered as a confident full-create plan. So a diff pointed at a
// project name that does not exist reports a CLEAN-LOOKING plan that verified
// nothing at all. Same shape of lie as the wrong-team token in team.ts: an
// unverifiable read that answers "absent" and invites a create.
//
// Keeping the distinction in the type is what lets each caller take its own
// (opposite, and both correct) position on absence.
export type LiveLookup =
  | { found: true; live: Live[] }
  | {
      found: false;
      missing: "project";
      project: string;
      available: string[];
    }
  | {
      found: false;
      missing: "environment";
      project: string;
      environment: string;
    };

export async function fetchLive(
  client: CoolifyClient,
  projectName: string,
  envName: string,
): Promise<LiveLookup> {
  const projects = (await client.get("/projects")) as Array<{
    uuid: string;
    name: string;
  }>;
  const project = projects.find((p) => p.name === projectName);
  if (!project) {
    return {
      found: false,
      missing: "project",
      project: projectName,
      available: projects.map((p) => p.name),
    };
  }
  // GET /projects/{uuid}/{environment_name_or_uuid} eager-loads exactly
  // these relations (app/Http/Controllers/Api/ProjectController.php
  // @environment_details, coollabsio/coolify v4.1.2): applications,
  // postgresqls, redis, mongodbs, mysqls, mariadbs, services. The vendored
  // OpenAPI's `Environment` schema response omits all of them (published
  // doc gap — the brief's `env.databases` shape does not exist on the
  // wire). We only map postgresql/redis: the two database types
  // manifest.ts's DatabaseSpecSchema supports.
  const env = (await client
    .get(`/projects/${project.uuid}/${envName}`)
    .catch((err) => {
      // Missing environment (first apply into a project without it yet) is
      // a 404 and means "no live resources"; anything else (401, 5xx,
      // network) must surface, not be silently treated as an empty diff —
      // that would cause createResource to attempt duplicate resources.
      if (err instanceof HttpError && err.status === 404) {
        return null;
      }
      throw err;
    })) as {
    applications?: Array<Record<string, unknown>>;
    postgresqls?: Array<Record<string, unknown>>;
    redis?: Array<Record<string, unknown>>;
    services?: Array<Record<string, unknown>>;
  } | null;
  if (!env) {
    return {
      found: false,
      missing: "environment",
      project: projectName,
      environment: envName,
    };
  }
  const map = (
    kind: ResourceKind,
    items: Array<Record<string, unknown>> = [],
  ): Live[] =>
    items.map((i) => ({
      kind,
      name: String(i.name),
      uuid: String(i.uuid),
      fields: projectLiveFields(kind, i),
      env: undefined, // populated per-resource below only in full mode by caller
    }));
  return {
    found: true,
    live: [
      ...map("application", env.applications),
      ...map("database", env.postgresqls),
      ...map("database", env.redis),
      ...map("service", env.services),
    ],
  };
}

// Why `diff` refuses instead of reporting an empty live side: see LiveLookup.
// The message has one job — make it impossible to read "absent" as "empty" —
// so it names what was looked for, where the name came from, and what actually
// exists next to it.
export function renderAbsentTarget(
  lookup: Extract<LiveLookup, { found: false }>,
  ctx: { orgRepo: string; overridden: boolean },
): string {
  const origin = ctx.overridden
    ? "--project"
    : `derived from the repo slug ${ctx.orgRepo}`;
  const head =
    lookup.missing === "project"
      ? [
          `refusing to diff: no project named "${lookup.project}" exists in this team`,
          "",
          `  looked for:  project "${lookup.project}"  (${origin})`,
          `  exists here: ${lookup.available.join(", ") || "(no projects at all)"}`,
        ]
      : [
          `refusing to diff: project "${lookup.project}" has no environment "${lookup.environment}"`,
          "",
          `  looked for:  environment "${lookup.environment}" in project "${lookup.project}"`,
          "  note:        cast names environments after --env, so a project built by",
          "               hand in the Coolify UI may well use a different name for the",
          "               same tier (Coolify's own default is `production`).",
        ];
  return [
    ...head,
    "",
    "An absent target reads back exactly like an empty one, so continuing would diff",
    'it as "nothing exists — create everything": a clean-looking report that verified',
    "nothing. `apply` may create a target; `diff` may only ever describe one that is",
    "already there.",
    "",
    lookup.missing === "project"
      ? "Pass --project <name> if this instance names it differently."
      : "Re-run with --env naming the environment as it exists here.",
  ].join("\n");
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (command === "apply" || command === "diff") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        env: { type: "string" },
        path: { type: "string" },
        state: { type: "string" },
        project: { type: "string" },
        instance: { type: "string" },
        "hostname-overlay": { type: "string" },
        full: { type: "boolean", default: false },
      },
    });
    const orgRepo = positionals[0];
    const envName = values.env;
    if (!orgRepo || !envName) {
      console.error(USAGE);
      return 2;
    }
    const stateDir = stateDirFrom(values.state);
    const repoShort = orgRepo.split("/")[1];
    // The Coolify project name and the secrets-file key are different things
    // that happen to default to the same string. Only the former is a name
    // some other system chose: a project built by hand in the UI is called
    // whatever someone typed. --project overrides that one, and nothing else —
    // secrets stay keyed by the repo (a state-repo convention we own).
    const projectName = values.project ?? repoShort;
    const checkout = resolveCheckout(orgRepo, {
      env: envName,
      path: values.path,
    });
    const secrets = decryptSecrets(
      secretsFileFor(stateDir, repoShort, envName),
      keyFileFor(envName),
    );
    let { desired, resolvedEnvs, backupSchedules } = desiredFromManifest(
      checkout,
      envName,
      secrets,
    );
    const bindings = loadBindings(join(stateDir, "environments.yaml"));
    const binding = bindings.environments[envName];
    if (!binding) {
      console.error(`environment ${envName} not in environments.yaml`);
      return 2;
    }
    assertEnvVarPolicy(envName, resolvedEnvs, binding.forbidden_var_patterns);
    if (values["hostname-overlay"]) {
      desired = applyHostnameOverlay(
        desired,
        parseYaml(readFileSync(values["hostname-overlay"], "utf8")),
      );
    }
    const { instance, client } = openCoolify(
      stateDir,
      values.instance,
      binding,
    );
    if (command === "apply") assertWritable(instance, "apply");
    // Fail-closed, before the first live read — not merely before the first
    // write. A wrong-team token makes fetchLive come back empty (the API
    // resolves what it cannot see to null), so an unasserted `diff` would
    // cheerfully report "everything is absent" and an unasserted `apply`
    // would then create all of it in the wrong team. The read is already
    // the lie; gate it, not just the write.
    const team = await assertTeam(client, binding.team, envName);
    console.log(`team ${formatTeam(team)} ✓`);
    const mode = command === "apply" || values.full ? "full" : "structural";
    const lookup = await fetchLive(client, projectName, envName);
    // apply and diff take opposite (and both correct) positions on absence:
    // apply is *allowed* to be the thing that brings a project into existence,
    // so [] is a legitimate starting point. diff is only ever a claim about
    // something that already exists — for it, absence is not an empty diff, it
    // is the absence of anything to diff against, and reporting a full-create
    // plan would launder that into a pass. See LiveLookup.
    if (!lookup.found && command === "diff") {
      console.error(
        renderAbsentTarget(lookup, {
          orgRepo,
          overridden: values.project !== undefined,
        }),
      );
      return 2;
    }
    const live = lookup.found ? lookup.live : [];
    if (mode === "full") {
      for (const l of live) {
        const envs = (await client
          .get(
            `/${l.kind === "database" ? "databases" : `${l.kind}s`}/${l.uuid}/envs`,
          )
          .catch((err) => {
            // Same policy as fetchLive's environment fetch: a 404 (a
            // resource we just listed no longer having an envs endpoint —
            // not expected in practice, but consistent with treating
            // "gone" as "no env vars") collapses to []; anything else
            // (401, 5xx, network) must surface. Swallowing it here would
            // make a live resource's env look empty and turn every one of
            // its vars into a spurious create in the diff.
            if (err instanceof HttpError && err.status === 404) return [];
            throw err;
          })) as Array<{
          key: string;
          real_value?: string;
          value: string;
        }>;
        l.env = Object.fromEntries(
          envs.map((e) => [e.key, e.real_value ?? e.value]),
        );
      }
    }
    const report = computeDiff(desired, live, mode);
    console.log(renderDiff(report));
    if (command === "diff") return report.clean ? 0 : 1;
    const serverUuid = await client.serverUuid(binding.server);
    const githubAppUuid = await client.githubAppUuid(
      githubAppNameFor(bindings, orgRepo),
    );
    const exec = buildExecutor(client, {
      projectName,
      envName,
      serverUuid,
      githubAppUuid,
      s3DestinationUuid: binding.s3_destination,
      backupSchedules,
    });
    const { mutated } = await applyPlan(report, desired, exec);
    console.log(
      mutated.length === 0
        ? "no-op (clean)"
        : `applied + redeployed: ${mutated.join(", ")}`,
    );
    return 0;
  }
  if (command === "server" && rest[0] === "add") {
    const { values, positionals } = parseArgs({
      args: rest.slice(1),
      allowPositionals: true,
      options: {
        ip: { type: "string" },
        key: { type: "string" },
        env: { type: "string" },
        user: { type: "string" },
        port: { type: "string" },
        state: { type: "string" },
        instance: { type: "string" },
      },
    });
    // --env is required: a server is registered under the token's team and
    // belongs to exactly one team forever (Coolify has no pivot and no
    // is_system_wide escape hatch for servers). Registering it under the
    // wrong team is not a mistake you fix with a PATCH — you delete and
    // re-add. So it takes the same assert as every other command, against
    // the team of the environment the server is being registered to serve.
    if (!positionals[0] || !values.ip || !values.key || !values.env) {
      console.error(USAGE);
      return 2;
    }
    const stateDir = stateDirFrom(values.state);
    const binding = loadBindings(join(stateDir, "environments.yaml"))
      .environments[values.env];
    if (!binding) {
      console.error(`environment ${values.env} not in environments.yaml`);
      return 2;
    }
    const { instance, client } = openCoolify(
      stateDir,
      values.instance,
      binding,
    );
    assertWritable(instance, "server add");
    const team = await assertTeam(client, binding.team, values.env);
    console.log(`team ${formatTeam(team)} ✓`);
    await serverAdd(client, {
      name: positionals[0],
      ip: values.ip,
      keyFile: values.key,
      user: values.user,
      port: values.port ? Number(values.port) : undefined,
    });
    return 0;
  }
  if (command === "smoke") {
    const { values } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        state: { type: "string" },
        env: { type: "string" },
        instance: { type: "string" },
      },
    });
    // smoke writes: it POSTs two env vars onto the live smoke_target app and
    // deletes them again. That is a mutation, so it takes the assert like any
    // other. Without it, a wrong-team token that happened to own an app of
    // the same name would have that app written to instead.
    if (!values.env) {
      console.error(USAGE);
      return 2;
    }
    const stateDir = stateDirFrom(values.state);
    const bindings = loadBindings(join(stateDir, "environments.yaml"));
    const binding = bindings.environments[values.env];
    if (!binding) {
      console.error(`environment ${values.env} not in environments.yaml`);
      return 2;
    }
    const { instance, client } = openCoolify(
      stateDir,
      values.instance,
      binding,
    );
    assertWritable(instance, "smoke");
    const team = await assertTeam(client, binding.team, values.env);
    console.log(`team ${formatTeam(team)} ✓`);
    if (!bindings.smoke_target) {
      console.error(
        "environments.yaml: smoke_target (app name) required for smoke",
      );
      return 2;
    }
    // resolve app uuid by name across the project list
    const apps = (await client.get("/applications")) as Array<{
      uuid: string;
      name: string;
    }>;
    const target = apps.find((a) => a.name === bindings.smoke_target);
    if (!target) {
      console.error(`smoke_target ${bindings.smoke_target} not found`);
      return 2;
    }
    await smoke(client, target.uuid);
    return 0;
  }
  if (command === "team") {
    const { values } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        state: { type: "string" },
        env: { type: "string" },
        instance: { type: "string" },
      },
    });
    const stateDir = stateDirFrom(values.state);
    // Bindings first, but only when --env was given: an environment's
    // `instance:` binding is what selects the Coolify to ask. Without --env
    // there is no binding to read (and deliberately so — see below), so the
    // flag or the default file decides.
    const binding = values.env
      ? loadBindings(join(stateDir, "environments.yaml")).environments[
          values.env
        ]
      : undefined;
    if (values.env && !binding) {
      console.error(`environment ${values.env} not in environments.yaml`);
      return 2;
    }
    const { client } = openCoolify(stateDir, values.instance, binding);
    // Read-only, and the one command that deliberately does NOT require a
    // team binding: it is how you discover the values to write into
    // environments.yaml in the first place. Asserting here would be circular.
    // With --env it also checks the binding, which makes it the dry run for
    // "will apply refuse?" — ask the question without touching anything.
    const actual = await client.currentTeam();
    console.log(`token's team: ${formatTeam(actual)}`);
    if (!values.env || !binding) return 0;
    await assertTeam(client, binding.team, values.env);
    console.log(`matches the team ${values.env} expects ✓`);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

async function resolveOrCreateProject(
  client: CoolifyClient,
  name: string,
): Promise<string> {
  try {
    return await client.projectUuid(name);
  } catch (err) {
    // projectUuid's resolver-miss (CoolifyClient.resolve) throws this exact
    // message with no `status` — that's the only case we treat as "create
    // it"; a 401/5xx/network failure must surface, not fall through to a
    // duplicate-create attempt.
    if (
      err instanceof Error &&
      err.message === `not found in Coolify: project ${name}`
    ) {
      const p = (await client.post("/projects", { name })) as { uuid: string };
      return p.uuid;
    }
    throw err;
  }
}

// --- Desired-vocabulary -> Coolify wire-vocabulary field mapping ---
//
// `fields` (from Desired/Change) speaks the internal vocabulary used for
// diffing (see resolve.ts / diff.ts): `port`, `healthcheck`, `domains`
// (array), `type`, `version`. Coolify's actual create/update payloads use
// different field names and shapes for some of these (verified against
// reference/coolify-openapi-4.1.2.json requestBody schemas for
// /applications/private-github-app, PATCH /applications/{uuid},
// /databases/postgresql, /databases/redis, PATCH /databases/{uuid},
// POST/PATCH /services) — spreading `fields` straight into the request body
// (as an earlier draft of this executor did) would silently drop
// healthcheck/domains updates and leak unrecognized type/version keys into
// database creates. These helpers do the translation once, shared by
// createResource and updateFields.

export function applicationApiFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const { port, healthcheck, domains, docker_compose_domains, ...rest } =
    fields;
  return {
    ...rest,
    // ports_exposes wants a string; healthcheck -> health_check_path;
    // domains wants a comma-separated string, not an array.
    ...(port !== undefined ? { ports_exposes: String(port) } : {}),
    ...(healthcheck !== undefined ? { health_check_path: healthcheck } : {}),
    ...(domains !== undefined
      ? { domains: Array.isArray(domains) ? domains.join(",") : domains }
      : {}),
    // docker_compose_domains speaks the internal map vocabulary
    // (service -> string[]); the wire shape is an array of
    // {name, domain} where domain is that array comma-joined (verified
    // against the /applications/private-github-app + PATCH /applications
    // request schemas, ~line 353 of the vendored OpenAPI).
    ...(docker_compose_domains !== undefined
      ? {
          docker_compose_domains: Object.entries(
            docker_compose_domains as Record<string, string[]>,
          ).map(([name, urls]) => ({ name, domain: urls.join(",") })),
        }
      : {}),
  };
}

export function defaultDatabaseImage(type: string, version: string): string {
  // Verified against coollabsio/coolify v4.1.2 source
  // (resources/views/livewire/project/new/select.blade.php +
  // app/Livewire/Project/New/Select.php): the "New Resource" wizard's
  // PostgreSQL version picker calls setPostgresqlType('postgres:{v}-alpine')
  // for each offered version. Redis has no version picker in that wizard —
  // this half of the mapping extrapolates the same Docker Hub tag
  // convention and is UNVERIFIED against a live instance (see task-8-report.md).
  const repo = type === "postgresql" ? "postgres" : "redis";
  return `${repo}:${version}-alpine`;
}

export function databaseApiFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  // /databases/postgresql and /databases/redis accept no `type` param (the
  // endpoint path already encodes it) and no `version` param at all — only
  // `image`, a literal Docker image string.
  const { type, version, ...rest } = fields;
  return {
    ...rest,
    ...(typeof version === "string"
      ? { image: defaultDatabaseImage(String(type), version) }
      : {}),
  };
}

export function serviceApiFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  // /services accepts `urls`, a structured per-container list
  // ({name, url}[]), not the flat `domains` string list the manifest
  // speaks. manifest.ts's ServiceSpecSchema has no notion of per-container
  // name, so we can't build a correct `urls` payload from `domains` alone —
  // dropped rather than sent malformed. Known limitation: service hostnames
  // need manual Coolify UI configuration (see README, Task 10).
  const { domains: _domains, ...rest } = fields;
  return rest;
}

export function buildExecutor(
  client: CoolifyClient,
  ctx: {
    projectName: string;
    envName: string;
    serverUuid: string;
    githubAppUuid: string;
    s3DestinationUuid?: string; // raw UUID from environments.yaml — no storage API exists to resolve names
    backupSchedules: Record<string, { frequency: string; retention: number }>;
  },
): Executor {
  return {
    async createResource(change) {
      // Field payloads assembled from change.fieldDiffs (desired values):
      const fields = Object.fromEntries(
        change.fieldDiffs.map((f) => [f.field, f.desired]),
      );
      const projectUuid = await resolveOrCreateProject(client, ctx.projectName);
      if (change.kind === "application") {
        const res = (await client.post("/applications/private-github-app", {
          project_uuid: projectUuid,
          environment_name: ctx.envName,
          server_uuid: ctx.serverUuid,
          github_app_uuid: ctx.githubAppUuid,
          name: change.name,
          instant_deploy: false,
          ...applicationApiFields(fields),
          // A compose stack must reach the managed Postgres/Redis resources
          // (the box-B lesson, DEPLOY.md §0/§3) — Coolify only wires that up
          // when this flag is set on create.
          ...(fields.build_pack === "dockercompose"
            ? { connect_to_docker_network: true }
            : {}),
        })) as { uuid: string };
        return res.uuid;
      }
      if (change.kind === "database") {
        const type = String(fields.type);
        const res = (await client.post(
          `/databases/${type === "postgresql" ? "postgresql" : "redis"}`,
          {
            project_uuid: projectUuid,
            environment_name: ctx.envName,
            server_uuid: ctx.serverUuid,
            name: change.name,
            ...databaseApiFields(fields),
          },
        )) as { uuid: string };
        const schedule = ctx.backupSchedules[change.name];
        if (schedule) {
          if (!ctx.s3DestinationUuid) {
            throw new Error(
              `database ${change.name} declares a backup schedule but environments.yaml has no s3_destination UUID for this environment`,
            );
          }
          await client.post(`/databases/${res.uuid}/backups`, {
            frequency: schedule.frequency,
            database_backup_retention_amount_locally: schedule.retention,
            save_s3: true,
            s3_storage_uuid: ctx.s3DestinationUuid,
          });
        }
        return res.uuid;
      }
      const res = (await client.post("/services", {
        project_uuid: projectUuid,
        environment_name: ctx.envName,
        server_uuid: ctx.serverUuid,
        name: change.name,
        ...serviceApiFields(fields),
      })) as { uuid: string };
      return res.uuid;
    },
    async updateFields(uuid, kind, fields) {
      const base =
        kind === "application"
          ? "applications"
          : kind === "database"
            ? "databases"
            : "services";
      const apiFields =
        kind === "application"
          ? applicationApiFields(fields)
          : kind === "service"
            ? serviceApiFields(fields)
            : databaseApiFields(fields);
      await client.patch(`/${base}/${uuid}`, apiFields);
    },
    async syncEnv(uuid, kind, env) {
      // Bulk env update is an UPSERT of listed keys, not a full replace —
      // verified against app/Http/Controllers/Api/{Applications,Databases,
      // Services}Controller.php@create_bulk_envs (coollabsio/coolify
      // v4.1.2): each item is found-by-key-and-updated or created; no
      // deletion of unlisted keys occurs (audit event is literally named
      // "*.env_bulk_upserted"). Safe under the iron rule that apply never
      // deletes — no need to fall back to per-key create-or-update calls.
      const base =
        kind === "application"
          ? "applications"
          : kind === "database"
            ? "databases"
            : "services";
      await client.patch(`/${base}/${uuid}/envs/bulk`, {
        data: Object.entries(env.vars).map(([key, v]) => ({
          key,
          value: v.value,
          is_buildtime: false,
          is_preview: false,
        })),
      });
    },
    async redeploy(uuid, kind) {
      if (kind === "service") await client.restart(uuid);
      else await client.deploy(uuid);
    },
  };
}

// Guard the entrypoint so `test/wire.test.ts` can import the pure
// translation helpers above without executing the CLI (parseArgs against
// vitest's argv, process.exit mid-test-run, etc). Only runs main() when
// this file is the process entrypoint (`node dist/cli.js ...`), not when
// imported as a module.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
