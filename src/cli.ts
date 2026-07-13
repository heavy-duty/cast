#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { type Executor, applyHostnameOverlay, applyPlan } from "./apply.js";
import {
  githubAppNameFor,
  loadBindings,
  projectBindingFor,
  smokeTargetFor,
} from "./bindings.js";
import {
  type LiveEnvs,
  absentResources,
  classify,
  renderAbsentResources,
  renderCapturePlan,
} from "./capture.js";
import {
  type CoolifyInstance,
  DEFAULT_INSTANCE,
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
import {
  type LiveResource,
  type SweepEnvironment,
  type SweepProject,
  reconcile,
  renderInventory,
  renderSweep,
} from "./inventory.js";
import {
  desiredFromManifest,
  manifestResources,
  requiredSecrets,
  resolveCheckout,
} from "./resolve.js";
import {
  decryptSecrets,
  encryptSecrets,
  keyFileFor,
  secretsFileFor,
} from "./secrets.js";
import { serverAdd } from "./server.js";
import { smoke } from "./smoke.js";
import { assertTeam, formatTeam } from "./team.js";

const USAGE = `usage: cast apply     <org>/<repo> --env <env> [--path <dir>] [--project <name>] [--environment <name>] [--hostname-overlay <file>]
       cast diff      <org>/<repo> --env <env> [--full] [--project <name>] [--environment <name>]
       cast capture   <org>/<repo> --env <env> [--path <dir>] [--project <name>] [--environment <name>] [--generated <NAME>] [--override <NAME>] [--force]
       cast inventory <org>/<repo> --env <env> [--path <dir>] [--project <name>] [--environment <name>] [--resource <m>=<l>]
       cast inventory --env <env> [--instance <name>]     # no repo: SWEEP the whole instance
       cast server add <name> --ip <ip> --key <file> --env <env> [--user root] [--port 22]
       cast smoke     <org>/<repo> --env <env> [--project <name>] [--environment <name>]
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
                  the real name.
  --environment <name>
                  the Coolify environment to act on, when it is not named after
                  --env (the default). Same problem as --project, one level down:
                  a box built by hand has whatever Coolify defaulted to, which is
                  \`production\`, not \`prod\`. This changes ONLY the name on the
                  wire — --env still selects the manifest block, the
                  environments.yaml binding, the age key and the store path.
  --resource <manifest-name>=<live-name>
                  the same problem, one level further down: a hand-built box
                  names resources for a human reading a UI ("Incubator Stack v2"),
                  a manifest names them for a diff (\`core\`). Repeatable. Read-side
                  only (\`diff\`, \`capture\`, \`inventory\`) — \`apply\` creates under the
                  manifest's names and refuses this flag.

capture (adopt a hand-built instance into the age secret store):
  --generated <NAME>   force NAME to the \`pending-coolify-generated\` placeholder,
                       for a manifest that has not declared generated_secrets yet.
                       Repeatable.
  --override <NAME>    supply NAME yourself instead of copying the source's value.
                       The VALUE is read from \$CAST_CAPTURE_<NAME>, never from the
                       command line — argv is visible in \`ps\`. Repeatable.
  --force              overwrite an existing store (refused by default).`;

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
      // The one thing Coolify will tell us about placement. `destination_id` is
      // a plain column on all three resource tables and none of the three
      // controllers' removeSensitiveData() hides it (v4.1.2), so it survives
      // into this response — whereas the destination's UUID never appears in
      // any response at all, because environment_details does not eager-load
      // the `destination` relation and no endpoint exposes it. See Placement.
      destinationId:
        typeof i.destination_id === "number" ? i.destination_id : undefined,
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
  ctx: {
    orgRepo: string;
    overridden: boolean;
    envOverridden?: boolean;
    verb?: string;
  },
): string {
  // `capture` takes the same position as `diff`, and for the same reason: it
  // is only ever a claim about something that already exists. Against an
  // absent target it would read back zero live values and call every required
  // secret "missing" — an alarming-but-meaningless report about the wrong box.
  const verb = ctx.verb ?? "diff";
  const origin = ctx.overridden
    ? "--project"
    : `derived from the repo slug ${ctx.orgRepo}`;
  const envOrigin = ctx.envOverridden ? "--environment" : "derived from --env";
  const head =
    lookup.missing === "project"
      ? [
          `refusing to ${verb}: no project named "${lookup.project}" exists in this team`,
          "",
          `  looked for:  project "${lookup.project}"  (${origin})`,
          `  exists here: ${lookup.available.join(", ") || "(no projects at all)"}`,
        ]
      : [
          `refusing to ${verb}: project "${lookup.project}" has no environment "${lookup.environment}"`,
          "",
          `  looked for:  environment "${lookup.environment}" in project "${lookup.project}"  (${envOrigin})`,
          "  note:        a project built by hand in the Coolify UI may well use a",
          "               different name for the same tier — Coolify's own default is",
          "               `production`, not `prod`.",
        ];
  return [
    ...head,
    "",
    "An absent target reads back exactly like an empty one, so continuing would diff",
    'it as "nothing exists — create everything": a clean-looking report that verified',
    `nothing. \`apply\` may create a target; \`${verb}\` may only ever describe one that is`,
    "already there.",
    "",
    lookup.missing === "project"
      ? "Pass --project <name> if this instance names it differently."
      : // NOT "rename your environment to match the box". The box does not get to
        // name our environments: --env selects the manifest block, the binding, the
        // age key and the store path, and a hand-built box being evicted next week
        // must not decide any of them. --environment is the coordinate for reading
        // it, and it changes nothing on our side of the line.
        "Pass --environment <name> if this instance names it differently.",
  ].join("\n");
}

// The same disposition as renderAbsentTarget, one level deeper, and for the one
// verb that WRITES: the project and the environment are both there, and hold no
// application of the name `smoke` was told to write to.
//
// Until #29, `smoke` never got here. It resolved its target against
// GET /applications — every application the token can see, across every project
// and every environment of the instance — and wrote to the first name match. So
// `smoke_target: core` did not name an application; it named whichever `core`
// Coolify happened to list first, and one instance carrying prod and staging is
// enough for that to be prod's. The canary vars land on an app nobody named, and
// on the failure path they stay there.
//
// This message therefore does NOT offer to look elsewhere, and the code behind it
// does not either. An application in another project is not the same application
// seen from a different angle — it is a different application, and this verb
// writes. The only thing worth saying is: here is where I looked, here is what is
// actually in there, and here is which coordinate to correct.
export function renderAbsentSmokeTarget(
  target: string,
  live: Array<{ kind: ResourceKind; name: string }>,
  ctx: { orgRepo: string; env: string; project: string; environment: string },
): string {
  const apps = live.filter((l) => l.kind === "application").map((l) => l.name);
  // A service or a database of that name is not a near-miss to be accommodating
  // about — smoke POSTs to /applications/<uuid>/envs, so being pointed at one
  // would 404 on an endpoint that does not exist for that kind, and the operator
  // would spend the afternoon on an HTTP status instead of on the name.
  const sameName = live.find((l) => l.name === target);
  const wrongKind =
    sameName && sameName.kind !== "application"
      ? [
          "",
          `  but note:    "${target}" DOES exist here — as a ${sameName.kind}, not an`,
          "               application. `smoke` writes to an application's /envs endpoint;",
          `               a ${sameName.kind} of the same name is a different resource behind a`,
          "               different endpoint, not this one seen sideways.",
        ]
      : [];
  return [
    `refusing to smoke: project "${ctx.project}" / environment "${ctx.environment}" holds no application named "${target}"`,
    "",
    `  looked for:  application "${target}"`,
    `               (environments.${ctx.env}.projects["${ctx.orgRepo}"].smoke_target)`,
    `  in:          project "${ctx.project}", environment "${ctx.environment}"`,
    `  exists here: ${apps.join(", ") || "(no applications at all)"}`,
    ...wrongKind,
    "",
    "cast will not go looking for that name anywhere else on this instance. A bare",
    "application name is unique only INSIDE a project and an environment, so the first",
    `\`${target}\` the API lists may belong to another project — or to prod, while you are`,
    "smoking staging (#29). `smoke` POSTs two canary env vars to the application it",
    "resolves, and deletes them again; on the failure path it leaves them behind. An",
    "app it was not pointed at is not a fallback.",
    "",
    "Name the application as it exists here, or pass --project / --environment if this",
    "instance names the project or the environment differently.",
  ].join("\n");
}

// The third name a hand-built box does not share with you: the RESOURCE.
//
// `--project` and `--environment` are coordinates for finding the target;
// `--resource` is the coordinate for finding the things inside it. A box built
// by hand names its resources for humans reading a UI ("Incubator Stack v2"),
// while a manifest names them for machines reading a diff (`core`). Neither is
// wrong, and neither gets to overwrite the other — so the mapping is stated at
// the call site and applied at the boundary.
//
// It is deliberately NOT a manifest field: a manifest that recorded its own
// legacy names would carry a dead box's vocabulary forever, which is the exact
// failure #17 exists to prevent. This is an argument to a one-off read.
export function parseResourceAliases(
  pairs: string[],
  declared: string[],
): Record<string, string> {
  const alias: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0 || eq === pair.length - 1) {
      throw new Error(
        `--resource expects <manifest-name>=<live-name>, got "${pair}"`,
      );
    }
    const from = pair.slice(0, eq).trim();
    const to = pair.slice(eq + 1).trim();
    // A typo here would be silent and expensive: the alias would map nothing,
    // the manifest's real resource would still be looked up under its own name,
    // and the run would refuse (or capture) with no hint that the flag missed.
    if (!declared.includes(from)) {
      throw new Error(
        [
          `--resource ${from}=${to}: the manifest declares no resource named "${from}"`,
          "",
          `  declares:  ${declared.join(", ") || "(nothing)"}`,
          "",
          "The left side is the MANIFEST's name; the right side is what this box",
          "calls the same thing.",
        ].join("\n"),
      );
    }
    alias[from] = to;
  }
  return alias;
}

// Rename live resources to the manifest's vocabulary, once, at the boundary.
// Everything downstream — computeDiff, classify, reconcile — then matches by
// name as it always has, and none of them needs to know a box was involved.
export function aliasLive<T extends { name: string }>(
  live: T[],
  alias: Record<string, string>,
): Array<T & { sourceName?: string }> {
  const toManifestName = new Map(
    Object.entries(alias).map(([manifest, box]) => [box, manifest]),
  );
  return live.map((l) => {
    const manifestName = toManifestName.get(l.name);
    return manifestName ? { ...l, name: manifestName, sourceName: l.name } : l;
  });
}

// A live resource's env vars, by key. `real_value` is the decrypted one and
// needs a token with read:sensitive; `value` is what a lesser token sees.
//
// A 404 (a resource we just listed no longer having an envs endpoint — not
// expected in practice, but consistent with treating "gone" as "no env vars")
// collapses to {}; anything else (401, 5xx, network) must surface. Swallowing
// it would make a live resource's env look EMPTY, which turns every one of its
// vars into a spurious create in a diff, and into a spurious "missing" in a
// capture.
async function fetchEnv(
  client: CoolifyClient,
  l: Live,
): Promise<Record<string, string>> {
  const base = l.kind === "database" ? "databases" : `${l.kind}s`;
  const envs = (await client.get(`/${base}/${l.uuid}/envs`).catch((err) => {
    if (err instanceof HttpError && err.status === 404) return [];
    throw err;
  })) as Array<{ key: string; real_value?: string; value: string }>;
  return Object.fromEntries(envs.map((e) => [e.key, e.real_value ?? e.value]));
}

// The value for an --override, read from the ENVIRONMENT rather than argv.
//
// A secret passed as a command-line argument is visible in `ps` to every
// process on the box, and lands in shell history — the same class of leak the
// clone-auth fix (#13) exists to avoid. So --override names the secret and the
// environment carries it.
function readOverrides(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const varName = `CAST_CAPTURE_${name}`;
    const value = process.env[varName];
    if (value === undefined) {
      throw new Error(
        [
          `--override ${name}: no value supplied.`,
          "",
          `cast reads an override's value from ${varName}, never from the command`,
          "line — an argv value is visible in `ps` to every process on this box.",
          "",
          `  ${varName}=… cast capture …`,
        ].join("\n"),
      );
    }
    out[name] = value;
  }
  return out;
}

// Typed confirmation, and deliberately NOT a --yes flag.
//
// This verb writes an environment's secret store, once, off a box nobody is
// going to rebuild. The entire reason it exists is that the hand-run version
// was easy to get subtly wrong — so the last gate is a human who has read the
// provenance column typing the environment's own name. Nothing shorter counts:
// not "y", not a flag. Automating it means deliberately echoing the
// environment name into cast, which is an explicit act rather than an absent
// one.
//
// EOF (a closed or empty stdin) resolves to `null` and aborts. Without that
// race, a `< /dev/null` run would hang forever on a question nobody can answer.
async function confirmCapture(envName: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string | null>((resolve) => {
    rl.question(
      `\ntype the environment name to write this store (${envName}): `,
    ).then(resolve, () => resolve(null));
    rl.once("close", () => resolve(null));
  });
  rl.close();
  return answer?.trim() === envName;
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
        environment: { type: "string" },
        resource: { type: "string", multiple: true },
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
    // Up front, before a clone or a decrypt or a single call: `apply` creates
    // resources under the MANIFEST's names, so an alias there would have to mean
    // "adopt the existing resource called X instead" — updating in place rather
    // than creating. That is a different operation, nobody has asked for it, and
    // guessing at it would silently create a duplicate beside the very resource
    // the operator was pointing at.
    if (command === "apply" && (values.resource?.length ?? 0) > 0) {
      console.error(
        [
          "refusing to apply: --resource is a read-side coordinate",
          "",
          "It exists so `diff`, `capture` and `inventory` can READ a box whose",
          "resources are named differently. `apply` creates resources under the",
          "manifest's own names, so an alias here would have to mean 'adopt the",
          "existing one instead' — which is not what this flag does.",
        ].join("\n"),
      );
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
    // Exactly the same split, one level down. `--env` is OUR name for the
    // environment: it selects the manifest block, the environments.yaml
    // binding, the age key, the store path, the team to assert. `--environment`
    // is THEIR name for it on the wire, and nothing else. Collapsing the two
    // (as cast did until now) means a box built by hand in someone's UI gets to
    // name our environment — and since apply creates the environment from this
    // value, a legacy box's accident would be inherited by the new one forever.
    const coolifyEnv = values.environment ?? envName;
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
    // Keyed by the REPO, not by --project: --project is the name Coolify's own
    // UI happens to use for this project, and cast's state is keyed by the name
    // WE own (same split as the secrets file — see the --project note above).
    const projectBinding = projectBindingFor(bindings, envName, orgRepo);
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
    const lookup = await fetchLive(client, projectName, coolifyEnv);
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
          envOverridden: values.environment !== undefined,
        }),
      );
      return 2;
    }
    const aliases = parseResourceAliases(
      values.resource ?? [],
      desired.map((d) => d.name),
    );
    // Without this, a diff against a box that names things differently reports
    // every manifest resource as "to create" and every live one as unknown —
    // the D-237 lie by another route: a confident full-create plan that verified
    // nothing, against a box that has all of it under other names.
    const live = lookup.found ? aliasLive(lookup.live, aliases) : [];
    if (mode === "full") {
      for (const l of live) {
        l.env = await fetchEnv(client, l);
      }
    }
    const report = computeDiff(desired, live, mode, {
      declaredDestination: projectBinding?.destination_uuid,
    });
    console.log(renderDiff(report));
    if (command === "diff") return report.clean ? 0 : 1;
    const serverUuid = await client.serverUuid(binding.server);
    const githubAppUuid = await client.githubAppUuid(
      githubAppNameFor(bindings, orgRepo),
    );
    const exec = buildExecutor(client, {
      projectName,
      // The name the environment gets ON COOLIFY when apply creates it — so an
      // apply that adopts an existing hand-named environment writes into that
      // one, rather than creating a second environment beside it.
      envName: coolifyEnv,
      serverUuid,
      githubAppUuid,
      destinationUuid: projectBinding?.destination_uuid,
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
  if (command === "capture") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        env: { type: "string" },
        state: { type: "string" },
        path: { type: "string" },
        project: { type: "string" },
        environment: { type: "string" },
        resource: { type: "string", multiple: true },
        instance: { type: "string" },
        generated: { type: "string", multiple: true },
        override: { type: "string", multiple: true },
        force: { type: "boolean", default: false },
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
    const projectName = values.project ?? repoShort;
    // Their name for the environment, on the wire. The store below stays keyed
    // by OUR name (--env) — capture is the verb most likely to be pointed at a
    // hand-built box, and the store it writes must not inherit that box's
    // vocabulary.
    const coolifyEnv = values.environment ?? envName;
    const store = secretsFileFor(stateDir, repoShort, envName);
    // Never overwrite a store by accident. `apply` never deletes; the verb
    // that WRITES the store gets the same disposition, because the thing it
    // would destroy is the only copy of values that may not exist anywhere
    // else any more.
    if (existsSync(store) && !values.force) {
      console.error(
        [
          `refusing to capture: ${store} already exists`,
          "",
          "That store may hold the only copy of values the source box no longer has.",
          "Pass --force to overwrite it deliberately, or move it aside first.",
        ].join("\n"),
      );
      return 2;
    }
    const bindings = loadBindings(join(stateDir, "environments.yaml"));
    const binding = bindings.environments[envName];
    if (!binding) {
      console.error(`environment ${envName} not in environments.yaml`);
      return 2;
    }
    const recipient = binding.age_recipient;
    if (!recipient) {
      console.error(
        [
          `environment ${envName} has no age_recipient in environments.yaml`,
          "",
          "capture encrypts the store TO that recipient (the public half of the",
          "environment's age key — safe to commit next to the bindings). Add it:",
          "",
          "  environments:",
          `    ${envName}:`,
          "      age_recipient: age1…",
        ].join("\n"),
      );
      return 2;
    }
    // Same rule as apply (resolveCheckout enforces it): prod always reads the
    // default branch. A feature-branch manifest must not be able to decide
    // which names land in the prod store.
    const checkout = resolveCheckout(orgRepo, {
      env: envName,
      path: values.path,
    });
    const { required, generated } = requiredSecrets(checkout, envName);
    const overrides = readOverrides(values.override ?? []);
    const { client } = openCoolify(stateDir, values.instance, binding);
    // capture READS Coolify and writes only to the local store, so it is
    // allowed against a read-only instance — inspecting a legacy box is
    // precisely what such an instance is for. It still takes the team assert:
    // a wrong-team token reads back nothing, and "nothing" here would render
    // as "every secret is missing" against a box that is fine.
    const team = await assertTeam(client, binding.team, envName);
    console.log(`team ${formatTeam(team)} ✓`);
    const lookup = await fetchLive(client, projectName, coolifyEnv);
    if (!lookup.found) {
      console.error(
        renderAbsentTarget(lookup, {
          orgRepo,
          overridden: values.project !== undefined,
          envOverridden: values.environment !== undefined,
          verb: "capture",
        }),
      );
      return 2;
    }
    const aliases = parseResourceAliases(
      values.resource ?? [],
      manifestResources(checkout, envName).map((r) => r.name),
    );
    const aliased = aliasLive(lookup.live, aliases);
    // Databases hold no manifest-templated env of their own — their URL is what
    // the APPS reference, and that name is generated, not captured.
    const envBearing = aliased.filter((l) => l.kind !== "database");
    // Before reading a single env: does every resource the manifest requires a
    // secret FROM actually exist here? An absent resource reads back exactly
    // like one with no env vars set — every name it declares reports MISSING —
    // and the suggested remedy for MISSING (--override) would then have the
    // operator hand-carry values that are sitting right there under a different
    // name, burying the real finding. Same lie as the absent project, one level
    // deeper. See absentResources.
    const absent = absentResources(
      required,
      envBearing.map((l) => l.name),
    );
    if (absent.length > 0) {
      console.error(
        renderAbsentResources(absent, lookup.live, {
          project: projectName,
          environment: coolifyEnv,
        }),
      );
      return 2;
    }
    const liveEnvs: LiveEnvs = {};
    for (const l of envBearing) {
      liveEnvs[l.name] = await fetchEnv(client, l);
    }
    const classification = classify(
      required,
      [...generated, ...(values.generated ?? [])],
      liveEnvs,
      overrides,
    );
    console.log(
      renderCapturePlan(classification, {
        orgRepo,
        env: envName,
        instance: values.instance ?? binding.instance ?? "default",
        store,
        recipient,
      }),
    );
    // Refuse, don't write a wrong store. Both of these are stop conditions,
    // and the plan above has already named every offending entry.
    if (
      classification.missing.length > 0 ||
      classification.conflicts.length > 0
    )
      return 2;
    if (!(await confirmCapture(envName))) {
      console.error("aborted — nothing written");
      return 2;
    }
    encryptSecrets(
      recipient,
      store,
      Object.fromEntries(classification.plan.map((d) => [d.ref, d.value])),
    );
    console.log(
      `wrote ${store} — ${classification.plan.length} name(s), encrypted to ${recipient}`,
    );
    return 0;
  }
  if (command === "inventory") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        env: { type: "string" },
        state: { type: "string" },
        path: { type: "string" },
        project: { type: "string" },
        environment: { type: "string" },
        resource: { type: "string", multiple: true },
        instance: { type: "string" },
      },
    });
    const orgRepo = positionals[0];
    const envName = values.env;
    if (!envName) {
      console.error(USAGE);
      return 2;
    }
    const stateDir = stateDirFrom(values.state);
    const sweepBindings = loadBindings(join(stateDir, "environments.yaml"));
    const sweepBinding = sweepBindings.environments[envName];
    if (!sweepBinding) {
      console.error(`environment ${envName} not in environments.yaml`);
      return 2;
    }
    // NO REPO → SWEEP. There is nothing to reconcile against, so don't pretend
    // to: just show what is on the box. This is the pass that has to come first
    // when the box is one you did not build, and requiring coordinates for it
    // made inventory a discovery verb that needed you to have already
    // discovered.
    if (!orgRepo) {
      const { instance, client } = openCoolify(
        stateDir,
        values.instance,
        sweepBinding,
      );
      // The team assert matters MORE here than anywhere: Coolify scopes what a
      // token can see to its team, so a wrong-team token sweeps an instance and
      // truthfully reports that it is empty.
      const team = await assertTeam(client, sweepBinding.team, envName);
      console.log(`team ${formatTeam(team)} ✓`);
      const projects: SweepProject[] = [];
      for (const p of await client.projects()) {
        const environments: SweepEnvironment[] = [];
        for (const name of await client.environments(p.uuid)) {
          const found = await fetchLive(client, p.name, name);
          environments.push({
            name,
            resources: found.found
              ? found.live.map((l) => ({ kind: l.kind, name: l.name }))
              : [],
          });
        }
        projects.push({ name: p.name, environments });
      }
      console.log(
        renderSweep(projects, {
          instance: instance.name,
          baseUrl: instance.baseUrl,
        }),
      );
      return 0;
    }
    const repoShort = orgRepo.split("/")[1];
    const projectName = values.project ?? repoShort;
    const coolifyEnv = values.environment ?? envName;
    const bindings = loadBindings(join(stateDir, "environments.yaml"));
    const binding = bindings.environments[envName];
    if (!binding) {
      console.error(`environment ${envName} not in environments.yaml`);
      return 2;
    }
    // Deliberately NOT resolveCheckout's prod ban, no secrets, no age key, no
    // age_recipient: inventory runs BEFORE any store exists — that is the whole
    // point of it — and it reads nothing it could leak. A read token is enough.
    const checkout = resolveCheckout(orgRepo, {
      env: envName,
      path: values.path,
    });
    const manifest = manifestResources(checkout, envName);
    const { client } = openCoolify(stateDir, values.instance, binding);
    // Read-only instances are exactly what this verb is for. It still takes the
    // team assert: a wrong-team token reads back nothing, and "nothing" would
    // render here as "the box is empty" — the same lie, dressed as a report.
    const team = await assertTeam(client, binding.team, envName);
    console.log(`team ${formatTeam(team)} ✓`);
    const lookup = await fetchLive(client, projectName, coolifyEnv);
    if (!lookup.found) {
      console.error(
        renderAbsentTarget(lookup, {
          orgRepo,
          overridden: values.project !== undefined,
          envOverridden: values.environment !== undefined,
          verb: "inventory",
        }),
      );
      return 2;
    }
    // With --resource, inventory stops reporting "these five are missing / these
    // five are unknown" and starts reporting what you actually want to know:
    // for each PAIR, which env keys differ. The report keeps the box's own name
    // beside ours, because losing it would make the document unusable against
    // the UI it describes.
    const inventoryAliases = parseResourceAliases(
      values.resource ?? [],
      manifest.map((r) => r.name),
    );
    const live: LiveResource[] = [];
    for (const l of aliasLive(lookup.live, inventoryAliases)) {
      // Keys, never values — see renderInventory. Databases carry no env of
      // their own worth reconciling (their URL is what the apps reference).
      const envKeys =
        l.kind === "database" ? [] : Object.keys(await fetchEnv(client, l));
      live.push({
        kind: l.kind,
        name: l.name,
        envKeys,
        ...(l.sourceName ? { sourceName: l.sourceName } : {}),
      });
    }
    console.log(
      renderInventory(reconcile(manifest, live), {
        orgRepo,
        env: envName,
        instance: values.instance ?? binding.instance ?? DEFAULT_INSTANCE,
        project: projectName,
        environment: coolifyEnv,
      }),
    );
    // Always 0: this is a report, not a gate. `diff` is the gate.
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
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        state: { type: "string" },
        env: { type: "string" },
        project: { type: "string" },
        environment: { type: "string" },
        instance: { type: "string" },
      },
    });
    // REQUIRED, like every other verb's — because the repo IS the project, and
    // the project is half of the only scope in which the target's name means
    // anything (#29). `cast smoke --env prod` with no repo used to work by
    // reading the state-file-scoped `smoke_target`, which named an application
    // from a key that could not say which project or which environment it was
    // in; that key is gone (see BindingsSchema), and so is the invocation.
    const orgRepo = positionals[0];
    const envName = values.env;
    if (!orgRepo || !envName) {
      console.error(USAGE);
      return 2;
    }
    const stateDir = stateDirFrom(values.state);
    const repoShort = orgRepo.split("/")[1];
    // The same two read-side coordinates diff/capture/inventory take, for the
    // same two reasons: a project built by hand in the UI is called whatever
    // someone typed, and an environment built by hand is called whatever Coolify
    // defaulted to (`production`, not `prod`). --env still selects the manifest
    // block, the environments.yaml binding and the team to assert; --project and
    // --environment change ONLY the names cast looks the target up under.
    const projectName = values.project ?? repoShort;
    const coolifyEnv = values.environment ?? envName;
    const bindings = loadBindings(join(stateDir, "environments.yaml"));
    const binding = bindings.environments[envName];
    if (!binding) {
      console.error(`environment ${envName} not in environments.yaml`);
      return 2;
    }
    const { instance, client } = openCoolify(
      stateDir,
      values.instance,
      binding,
    );
    // smoke writes: it POSTs two env vars onto the live smoke_target app and
    // deletes them again. That is a mutation, so it takes both gates — the
    // read-only instance refusal and the team assert — before the first call.
    // Without the assert, a wrong-team token that happened to own an app of the
    // same name would have that app written to instead.
    assertWritable(instance, "smoke");
    const team = await assertTeam(client, binding.team, envName);
    console.log(`team ${formatTeam(team)} ✓`);
    const target = smokeTargetFor(bindings, envName, orgRepo);
    if (!target) {
      console.error(
        [
          `no smoke_target for ${orgRepo} in ${envName}`,
          "",
          `  looked for:  environments.${envName}.projects["${orgRepo}"].smoke_target`,
          `               (a bare "${repoShort}" key resolves too)`,
          "",
          "`smoke` writes two canary env vars to one application and deletes them",
          "again — it has to be told which one, under the project that owns it:",
          "",
          "  environments:",
          `    ${envName}:`,
          "      projects:",
          `        ${orgRepo}:`,
          "          smoke_target: <the application's name>",
        ].join("\n"),
      );
      return 2;
    }
    // The fix for #29, and the whole of it: the target is resolved in the project
    // and the environment it was DECLARED under — the same lookup every read-side
    // verb makes — instead of by name against GET /applications, which is every
    // application on the instance and answers with whichever one it lists first.
    const lookup = await fetchLive(client, projectName, coolifyEnv);
    if (!lookup.found) {
      console.error(
        renderAbsentTarget(lookup, {
          orgRepo,
          overridden: values.project !== undefined,
          envOverridden: values.environment !== undefined,
          verb: "smoke",
        }),
      );
      return 2;
    }
    // Applications only. fetchLive returns every kind in the environment, and a
    // service or database called `core` is not a smoke target — it is a 404 on an
    // endpoint that does not exist for it (see renderAbsentSmokeTarget).
    const app = lookup.live.find(
      (l) => l.kind === "application" && l.name === target,
    );
    if (!app) {
      console.error(
        renderAbsentSmokeTarget(target, lookup.live, {
          orgRepo,
          env: envName,
          project: projectName,
          environment: coolifyEnv,
        }),
      );
      return 2;
    }
    await smoke(client, app.uuid);
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
    // The Docker network to create resources on. A raw UUID from
    // environments.yaml for the same reason s3DestinationUuid is one: Coolify
    // 4.1.2 has no destinations API, so there is no name for cast to resolve.
    //
    // Create-time ONLY, and every kind gets it (Coolify's three controllers run
    // identical destination logic). Undefined means "the server's only
    // destination", which is what Coolify picks anyway — and, until a server
    // hosts two projects, is the right answer.
    destinationUuid?: string;
    s3DestinationUuid?: string; // raw UUID from environments.yaml — no storage API exists to resolve names
    backupSchedules: Record<string, { frequency: string; retention: number }>;
  },
): Executor {
  // Coolify resolves this identically for applications, databases and services
  // (ApplicationsController ~1003, DatabasesController ~1700,
  // ServicesController ~378 @ v4.1.2):
  //
  //   0 destinations              -> 400, whatever we send
  //   >1 and no destination_uuid  -> 400 "Server has multiple destinations and
  //                                  you do not set destination_uuid"
  //   >1 and a foreign uuid       -> 422 "does not belong to the specified server"
  //   exactly 1                   -> $destinations->first(), and anything we
  //                                  send here is IGNORED, not validated
  //
  // So this field is what makes cast able to create resources on a server that
  // has more than one destination AT ALL — without it, apply simply 400s there,
  // which is the state of things before this change. On a single-destination
  // server it is inert (and so, note, a WRONG uuid is silently accepted there —
  // nothing on either side can catch that; see renderDiff's placement note).
  const destination = ctx.destinationUuid
    ? { destination_uuid: ctx.destinationUuid }
    : {};
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
          ...destination,
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
            ...destination,
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
        ...destination,
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
