#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { type Executor, applyHostnameOverlay, applyPlan } from "./apply.js";
import {
  type Bindings,
  githubAppNameFor,
  loadBindings,
  projectBindingFor,
  projectsIn,
  smokeTargetFor,
} from "./bindings.js";
import {
  type GeneratedSource,
  type LiveEnvs,
  absentResources,
  assertGeneratedComplete,
  classify,
  generatedPlanRefuses,
  planGenerated,
  renderAbsentResources,
  renderCapturePlan,
  renderGeneratedPlan,
  resolveGeneratedSources,
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
  type BackupState,
  type DestroyExecutor,
  executeDestroy,
  planDestroy,
  readBackupState,
  renderAbsentDestroyTarget,
  renderDestroyAllRefusal,
  renderDestroyPlan,
  renderDestroyResult,
  renderNoInterlock,
  renderNothingDeclaredHere,
  renderProjectNotEmptiable,
} from "./destroy.js";
import {
  type Change,
  type Live,
  type LiveEnvVar,
  type ResourceKind,
  computeDiff,
  renderDiff,
} from "./diff.js";
import {
  type DraftProject,
  assertEmptyTarget,
  draftResourcesFrom,
  emitDraft,
  planDraft,
  renderAmbiguousEnvironments,
  renderDraftPlan,
  renderNoRecipient,
  renderRepoWithDraft,
} from "./draft.js";
import {
  type ResolvedEnv,
  assertEnvVarPolicy,
  fillDerivedEnv,
  unresolvedDerived,
} from "./envtemplate.js";
import {
  type ProjectOutcome,
  fleetConflict,
  fleetExitCode,
  renderEmptyRegistry,
  renderFleetApply,
  renderFleetConflict,
  renderFleetDiff,
  renderProjectHeading,
} from "./fleet.js";
import {
  type LiveResource,
  type SweepEnvironment,
  type SweepProject,
  reconcile,
  renderInventory,
  renderSweep,
} from "./inventory.js";
import { assertNoReservedEnvNames, reservedHits } from "./reserved.js";
import {
  PATH_IN_PROD_REFUSAL,
  canonicalizeServiceDomains,
  desiredFromManifest,
  fillDesiredDerived,
  manifestResources,
  refusesPathInProd,
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
       cast apply     --env <env> --all                   # no repo: EVERY registered project
       cast diff      <org>/<repo> --env <env> [--full] [--project <name>] [--environment <name>]
       cast diff      --env <env> --all [--full]          # no repo: EVERY registered project
       cast capture   <org>/<repo> --env <env> [--path <dir>] [--project <name>] [--environment <name>] [--generated <NAME>] [--override <NAME>] [--force]
       cast capture   <org>/<repo> --env <env> --generated-only [--from <NAME>=<db>] [--force]   # pass 2, AFTER apply
       cast inventory <org>/<repo> --env <env> [--path <dir>] [--project <name>] [--environment <name>] [--resource <m>=<l>]
       cast inventory --env <env> [--instance <name>]     # no repo: SWEEP the whole instance
       cast inventory --env <env> --emit-draft <dir> [--recipient age1…] [--no-secrets]
       cast destroy   <org>/<repo> --env <env> [--instance <name>] [--path <dir>] [--with-project]
       cast server add <name> --ip <ip> --key <file> --env <env> [--user root] [--port 22]
       cast smoke     <org>/<repo> --env <env> [--project <name>] [--environment <name>]
       cast team [--env <env>]
       cast --version                                     # version + install root

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
  --all           (\`apply\`/\`diff\`) act on EVERY project the \`projects:\` registry
                  lists for this environment, instead of one named repo — the loop
                  the operator used to write from memory, and the project they
                  forgot is the one that drifted. Reports per project and fails
                  CLOSED on the aggregate: a registered project cast cannot reach
                  is an ERROR, never a skip, because a skipped project reads
                  exactly like a clean one. \`diff --all\` runs every project to
                  completion and exits 2 if any could not be read (which outranks
                  drift's 1 — an unread project is not a diff result); \`apply --all\`
                  stops at the first failure and says what it did and did not
                  touch. An empty (or absent) registry refuses. Mutually exclusive
                  with the repo positional and with every single-project
                  coordinate: --path, --project, --environment, --resource,
                  --hostname-overlay.

capture (adopt a hand-built instance into the age secret store):
  --generated <NAME>   force NAME to the \`pending-coolify-generated\` placeholder,
                       for a manifest that has not declared generated_secrets yet.
                       Repeatable.
  --override <NAME>    supply NAME yourself instead of copying the source's value.
                       The VALUE is read from \$CAST_CAPTURE_<NAME>, never from the
                       command line — argv is visible in \`ps\`. Repeatable.
  --force              overwrite an existing store (refused by default).

capture --generated-only (PASS 2 — run it AFTER \`apply\` has created the resources):
  a manifest with \`generated_secrets:\` bootstraps in two passes, because the value
  does not exist until Coolify makes it: pass 1 \`capture\` placeholds those names,
  \`apply\` creates the database, and this fills the store with the URL Coolify then
  generated. It INVERTS capture's rule — it fills the generated names and leaves
  every other name in the store exactly as it is. The store must already exist.
  The value is read from the DATABASE that owns it (\`internal_db_url\`), resolved
  inside this project+environment only — never from a consuming app's env, where a
  generated URL never appears, and never from the instance-wide database list.
  --from <NAME>=<db>   which live database NAME is filled from. Required whenever
                       more than one database could be meant: nothing in the
                       manifest, the templates or the box says that DATABASE_URL
                       comes from the postgres one, and cast refuses to guess by
                       name rather than write another database's credentials into
                       your store. Repeatable.
  --force              fill a generated name that already holds a REAL value
                       (refused by default — it is a silent credential rotation).

destroy (the only verb that deletes what a manifest declared):
  --with-project       after the resources, remove the environment and then the
                       project — both only if they are EMPTY. Refused up front when
                       anything cast did not declare is still in either of them.
  MANIFEST-SCOPED, always: it deletes the resources this manifest declares in this
  project and this environment, in reverse dependency order, and REPORTS anything
  else it finds without touching it. It takes no --project/--environment/--resource
  (the coordinates for a box somebody else named by hand), refuses --all outright,
  refuses a read-only instance, and refuses any environment whose environments.yaml
  binding does not carry \`destroy_allowed: true\`. The last gate is typing the
  environment's name at the plan.

inventory --emit-draft (write down what a box has, as a PROPOSAL):
  --emit-draft <dir>   emit what the sweep saw as a draft of cast's own inputs — a
                       manifest per project, env templates, an environments.yaml
                       carrying the \`projects:\` registry, an age store per project,
                       and UNCAPTURED.md. Into a NEW directory, always: a draft is a
                       proposal, reviewed by a human and landed as a PR, and \`apply\`
                       never reads one. SWEEP MODE ONLY — with a repo there is already
                       a manifest, and a manifest regenerated from a live box would
                       overwrite a reviewed spec with that box's accumulated cruft.
  --recipient age1…    the age recipient the draft's stores are encrypted to. Defaults
                       to the environment's \`age_recipient\` binding.
  --no-secrets         emit no stores. Required when no recipient is available: cast
                       will not silently drop the values it read off the box.
  --environment <name> a TIEBREAK, not a filter: which environment to draft for a
                       project that has resources in more than one (cast refuses to
                       pick). A project with only one populated environment is drafted
                       from it either way — filtering the instance by an environment
                       name would drop whole projects out of a blueprint that claims to
                       describe the box.`;

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
// the structured array the create/update request bodies accept (~line 353).
// The REAL read shape on a live Coolify 4.1.2 (cast#68) is NOT that array
// JSON-encoded — it is a service-KEYED OBJECT, JSON-encoded:
//   {"api":{"domain":"https://api…"},"admin":{"domain":"https://…,https://…"}}
// i.e. { "<service>": { "domain": "<comma-joined string>" }, … }. The
// original assumption (an array of {name,domain}) was wrong; a live probe
// pinned this as one of the two idempotency breaks in #68 — cast diffed the
// desired map against `undefined` forever because the object bailed out.
// Parses BOTH shapes into cast's internal `Record<string,string[]>`:
//   - object shape (real read):   map[service] = domain.split(",")
//   - legacy array shape (what applicationApiFields still WRITES, and what
//     the vendored OpenAPI implies): map[name] = domain.split(",")
// Keeping the array branch keeps the write-side round-trip and its tests
// working. Anything that is not one of these two well-formed shapes (a JSON
// scalar, a parse error, an empty string) collapses to `undefined` rather
// than throwing — "field omitted", not a crash.
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
  const map: Record<string, string[]> = {};
  if (Array.isArray(parsed)) {
    // Legacy / write-side shape: [{ name, domain }].
    for (const entry of parsed) {
      const name = (entry as { name?: unknown } | null)?.name;
      const domain = (entry as { domain?: unknown } | null)?.domain;
      if (typeof name === "string" && typeof domain === "string") {
        map[name] = domain.split(",").filter(Boolean);
      }
    }
    return map;
  }
  if (parsed !== null && typeof parsed === "object") {
    // Real read shape: { "<service>": { "domain": "<comma-joined>" } }.
    for (const [service, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      const domain = (value as { domain?: unknown } | null)?.domain;
      if (typeof domain === "string") {
        map[service] = domain.split(",").filter(Boolean);
      }
    }
    return map;
  }
  return undefined;
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
      // is_static is read so it is there to compare WHEN a manifest declares
      // `static:`. computeDiff compares only fields the DESIRED side declares,
      // so an app whose manifest omits `static` never diffs on it (which is
      // what keeps this from PATCHing is_static off an un-migrated static app),
      // and the three commands are the same.
      //
      // ABSENT-BY-DESIGN (cast#68): `is_static` is NOT an `applications` column —
      // it lives on the `ApplicationSetting` relation (`Application::settings()`
      // hasOne). Coolify 4.1.2 never serializes that relation on any read: the
      // Application model has no `$with`/`$appends`, neither `GET /applications`
      // nor the by-uuid GET `->load('settings')`, and `@environment_details`
      // eager-loads `applications` but not `applications.settings`
      // (ProjectController v4.1.2). So the key is simply ABSENT — `raw.is_static`
      // is undefined — verified against the coolify v4.1.2 source and a live
      // probe. Projecting `false` from that made cast diff false→true and redeploy
      // on every apply (#68's second idempotency break). So when the live value is
      // UNREADABLE (null/undefined), omit is_static: fetchLive flags the app
      // `staticNotCompared` and computeDiff skips the comparison (mirroring
      // backup's not-compared path), degrading is_static to a CREATE-TIME-ONLY
      // setting — the create path still sends it (applicationApiFields), so a
      // later change to an EXISTING app's is_static is a UI act cast cannot
      // reconcile. Preserves #63's intent as far as the read API allows. If a
      // future Coolify DOES serialize a real boolean (true/false, or 1/0), project
      // and diff it normally.
      ...(raw.is_static == null
        ? {}
        : { is_static: raw.is_static === true || raw.is_static === 1 }),
      ...(raw.install_command ? { install_command: raw.install_command } : {}),
      ...(raw.build_command ? { build_command: raw.build_command } : {}),
      ...(raw.start_command ? { start_command: raw.start_command } : {}),
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

// Attach the live backup schedule to a database, or the reason there isn't one
// to attach. Split out from fetchLive so the "cast could not read this" paths —
// the ones that must never lie in either direction — are all visible together.
//
// The four answers, and why each is what it is:
//
//   unreadable      -> backupNotCompared. Says nothing, claims nothing, prints.
//   no schedule     -> no `backup` in fields. Read cleanly: a declared backup is
//                      then REAL drift, and apply creates the schedule. This is
//                      the case the old side-channel design could never see, and
//                      the reason a rebuilt database silently had no backups.
//   one schedule    -> compared, like any other field.
//   >1 schedule     -> backupNotCompared. cast's manifest declares ONE schedule;
//                      a database carrying several is outside that vocabulary,
//                      and picking one to compare against would be a coin toss
//                      reported as a fact.
//
// A DISABLED schedule is deliberately NOT treated as "no schedule": the row
// exists (so apply must PATCH it, not POST a second one) but it backs nothing
// up (so it must not read as clean). Carrying `enabled: false` into the compared
// value gets both — it diffs against a desired block that implies enabled, and
// the update path re-enables it.
export async function attachBackup(
  client: CoolifyClient,
  db: Live,
): Promise<void> {
  const read = await client.databaseBackupSchedules(db.uuid);
  if (read === undefined) {
    db.backupNotCompared =
      "GET /databases/{uuid}/backups was unreachable or returned a shape cast does not recognize";
    return;
  }
  if (read.length > 1) {
    db.backupNotCompared = `Coolify holds ${read.length} schedules for this database; a manifest declares one`;
    return;
  }
  const schedule = read[0];
  if (!schedule) return; // read cleanly: no schedule. Absence IS the answer.
  db.fields.backup = {
    // Same key order as the desired side (resolve.ts) — computeDiff compares
    // by JSON.stringify. `enabled` rides along only when false, so the ordinary
    // healthy case is a two-key object on both sides and compares equal.
    frequency: schedule.frequency,
    retention: schedule.retention,
    ...(schedule.enabled ? {} : { enabled: false }),
  };
}

// Project GET /services/{uuid}'s body into the manifest's `service_domains`
// shape: `applications[].fqdn` → a canonicalized map of container name → URLs.
// THE one projection, shared by the diff/apply read (attachServiceDomains,
// below) and the draft (#83) — two projections of the same wire shape would
// drift, and a drafted manifest that disagrees with the diff's read-back by so
// much as URL order would diff dirty the moment it is applied.
//
// The two answers stay distinct, because they mean opposite things to every
// caller (the BackupRead lesson, on a different route):
//
//   undefined -> NOT READ: no body, or no applications array. Says nothing.
//   a map     -> read cleanly. `{}` is an ANSWER — this service serves no
//                hostnames — not a failure; a caller must not flatten it into
//                the unreadable case.
export function projectServiceDomains(
  raw: unknown,
): Record<string, string[]> | undefined {
  const body = raw as {
    applications?: Array<{ name?: unknown; fqdn?: unknown }>;
  } | null;
  if (!body || !Array.isArray(body.applications)) return undefined;
  const map: Record<string, string[]> = {};
  for (const app of body.applications) {
    const name = typeof app.name === "string" ? app.name : undefined;
    const fqdn = typeof app.fqdn === "string" ? app.fqdn : "";
    const urls = fqdn
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    if (name && urls.length > 0) map[name] = urls;
  }
  return canonicalizeServiceDomains(map);
}

// Read a service's per-container hostnames off GET /services/{uuid} and project
// them into `service_domains` on the Live's fields, so a declared hostname diffs
// like any other field (cast#72). The environment-list GET fetchLive reads does
// not eager-load `service.applications`, so this is a supplementary per-service
// read (see serviceByUuid).
//
// Unlike backup's not-compared escape, this FAILS CLOSED: a service whose domains
// cannot be read is NOT projected empty — that would diff a declared hostname as
// "will set" and let apply re-PATCH it every run — the read throws and aborts.
// GET /services/{uuid} for a service the environment list just named is not
// expected to fail; when it does, refusing beats a confident-but-blind plan
// (#12/#14/#17). A service with genuinely NO hostnames leaves service_domains
// absent, so a manifest declaring none stays clean and one declaring some drifts.
// (The draft takes the opposite position on the same unreadable answer — it
// REPORTS in UNCAPTURED.md rather than aborting a whole-instance sweep — which
// is exactly why the projection above is a separate function.)
export async function attachServiceDomains(
  client: CoolifyClient,
  svc: Live,
): Promise<void> {
  const map = projectServiceDomains(await client.serviceByUuid(svc.uuid));
  if (map === undefined) {
    throw new Error(
      `GET /services/${svc.uuid} returned no applications array — cannot read service ${svc.name}'s hostnames to diff them`,
    );
  }
  if (Object.keys(map).length > 0) {
    svc.fields.service_domains = map;
  }
}

export async function fetchLive(
  client: CoolifyClient,
  projectName: string,
  envName: string,
  // Backups and service hostnames each cost one extra GET per resource, so only
  // the callers that actually compare them ask: `diff` and `apply`. The read-side
  // sweeps (inventory, capture, smoke) walk every project on a box and would pay
  // it on every resource for an answer they never look at.
  opts: { backups?: boolean; serviceDomains?: boolean } = {},
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
      // The URL an application's ${resource:<name>.url} derives from (#60). Only
      // databases carry `internal_db_url` (an appended model attribute on
      // StandalonePostgresql/StandaloneRedis — see fetchGeneratedSources for the
      // provenance); it rides on Live rather than in `fields` because it is never
      // a database field cast writes or diffs. aliasLive preserves it while
      // renaming to the manifest's vocabulary, so the URL map built downstream is
      // keyed by the name a ref actually uses.
      ...(kind === "database" && typeof i.internal_db_url === "string"
        ? { internalDbUrl: i.internal_db_url }
        : {}),
      // is_static lives on the ApplicationSetting relation, which Coolify 4.1.2
      // never serializes on any read endpoint — so it is absent here (cast#68,
      // source-verified). Flag the application so computeDiff skips the is_static
      // comparison rather than reporting phantom false→true drift and redeploying
      // every run. Only applications carry is_static, and only flag when the live
      // value is truly absent — a real boolean (a future Coolify) is projected
      // into `fields` above and diffed normally.
      ...(kind === "application" && i.is_static == null
        ? { staticNotCompared: true }
        : {}),
    }));
  const live = [
    ...map("application", env.applications),
    ...map("database", env.postgresqls),
    ...map("database", env.redis),
    ...map("service", env.services),
  ];
  if (opts.backups) {
    for (const db of live.filter((l) => l.kind === "database")) {
      await attachBackup(client, db);
    }
  }
  if (opts.serviceDomains) {
    for (const svc of live.filter((l) => l.kind === "service")) {
      await attachServiceDomains(client, svc);
    }
  }
  return { found: true, live };
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

// `--from <NAME>=<database>` — the edge nothing else in the system carries.
//
// The right side is the database as COOLIFY names it, in this project and
// environment (which is what `capture --generated-only`'s own refusal prints
// for you). Not the manifest's name: --resource exists to reconcile those two
// vocabularies for the diff, and pass 2 reads its value straight off the live
// resource, so the live name is the one that can be checked.
export function parseFromPairs(
  pairs: string[],
  generated: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0 || eq === pair.length - 1) {
      throw new Error(`--from expects <NAME>=<database-name>, got "${pair}"`);
    }
    const ref = pair.slice(0, eq).trim();
    const db = pair.slice(eq + 1).trim();
    // A --from naming something that is not a generated secret is a no-op that
    // LOOKS like it did something: pass 2 fills generated names and nothing
    // else, so the flag would be silently ignored and the operator would walk
    // away believing they had set a value.
    if (!generated.includes(ref)) {
      throw new Error(
        [
          `--from ${ref}=${db}: ${ref} is not a generated secret in this environment`,
          "",
          `  generated:  ${generated.join(", ") || "(none declared)"}`,
          "",
          "--generated-only fills the generated names only. A name that is not one of",
          "them is carried over from the store untouched, and --from cannot change that.",
          "Declare it in the manifest's `generated_secrets:` (or pass --generated <NAME>)",
          "if it really is provider-generated.",
        ].join("\n"),
      );
    }
    out[ref] = db;
  }
  return out;
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

// A live resource's env vars, by key, each carrying both forms Coolify returns:
// `value` (fresh after every write, but masked for a secret to a plain token)
// and `realValue` (the decrypted plaintext, needs a token with read:sensitive).
// The diff picks between them per var (see LiveEnvVar, diffEnv); callers that
// only need one flattened string use flattenEnv below.
//
// PREVIEW ROWS ARE DROPPED, and that is load-bearing rather than tidy.
//
// GET /applications/{uuid}/envs does NOT return one row per key. It MERGES two
// parallel sets into one flat array — the production vars and the PREVIEW ones
// (`environment_variables->merge(environment_variables_preview)`,
// ApplicationsController@envs v4.1.2) — and the two relations are complements
// split on `is_preview`, with a unique index per (key, resource, is_preview). So
// the SAME KEY legitimately arrives TWICE, and keying by `key` alone kept
// whichever row Coolify happened to serialize last.
//
// That is #85, and it is why #78 looked like a "stale read": both rows are born
// equal (Coolify seeds a preview twin), and syncEnv below only ever PATCHes the
// PRODUCTION row — so the two diverge for exactly the vars that were updated in
// place. Five prod flags flipped false->true re-proposed as `change` on every
// diff forever, while created-once vars (NODE_ENV, …) stayed clean because their
// twins still agreed. Nothing was stale; cast was reading the other deployment's
// value.
//
// cast declares PRODUCTION env, and already says so on every WRITE — syncEnv
// sends `is_preview: false` on each bulk upsert. This is the read finally saying
// the same thing. A preview var is another deployment's value for the same name:
// not cast's to compare, and not cast's to write. Services and databases have no
// preview relation at all (their controllers map a single set), so this is a
// no-op for them.
//
// A 404 (a resource we just listed no longer having an envs endpoint — not
// expected in practice, but consistent with treating "gone" as "no env vars")
// collapses to {}; anything else (401, 5xx, network) must surface. Swallowing
// it would make a live resource's env look EMPTY, which turns every one of its
// vars into a spurious create in a diff, and into a spurious "missing" in a
// capture.
export async function fetchEnv(
  client: CoolifyClient,
  l: Pick<Live, "kind" | "uuid">,
): Promise<Record<string, LiveEnvVar>> {
  const base = l.kind === "database" ? "databases" : `${l.kind}s`;
  const envs = (await client.get(`/${base}/${l.uuid}/envs`).catch((err) => {
    if (err instanceof HttpError && err.status === 404) return [];
    throw err;
  })) as Array<{
    key: string;
    real_value?: string;
    value: string;
    is_preview?: boolean;
  }>;
  return Object.fromEntries(
    envs
      .filter((e) => e.is_preview !== true)
      .map((e) => [e.key, { value: e.value, realValue: e.real_value }]),
  );
}

// Collapse a live env map to one string per key, preferring the decrypted
// `realValue` — what capture writes into a store and what draft scaffolds from,
// where the plaintext of a secret is the point and the diff's stale-`realValue`
// hazard (#78) does not apply (nothing is compared against a manifest literal).
function flattenEnv(env: Record<string, LiveEnvVar>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([k, e]) => [k, e.realValue ?? e.value]),
  );
}

// The databases inside ONE project+environment, each carrying the value it
// OWNS. This is `capture --generated-only`'s only read of the box.
//
// Deliberately NOT `GET /databases`. That route lists every database on the
// INSTANCE — other projects', and umami's own bundled Postgres — so finding
// ours in it means matching by name across a list where a collision is both
// possible and silent (#29 in another hat; the hand-run jq this verb replaces
// had a comment warning not to pick the third row). `GET /projects/{uuid}/{env}`
// cannot express that bug: it eager-loads `postgresqls` and `redis` for THIS
// environment and nothing else (ProjectController@environment_details,
// coollabsio/coolify v4.1.2), so the scoping is structural rather than a filter
// cast has to remember to get right.
//
// `internal_db_url` is an appended model attribute — `protected $appends =
// ['internal_db_url', 'external_db_url', 'database_type', 'server_status']` on
// BOTH app/Models/StandalonePostgresql.php and app/Models/StandaloneRedis.php
// @ v4.1.2. Same key on both; only the URL it builds differs
// (`postgres://user:pw@{uuid}:5432/{db}` vs `redis://user:pw@{uuid}:6379/0`).
// environment_details serializes the models whole — serializeApiResponse
// (bootstrap/helpers/api.php) only sorts keys, and unlike DatabasesController
// it calls no removeSensitiveData() — so the field is present here WITHOUT the
// sensitive-read token permission that `GET /databases` gates it behind
// (`can_read_sensitive` → makeHidden(['internal_db_url', …])). The vendored
// OpenAPI documents neither route's body ("Content is very complex. Will be
// implemented later."); the spec's silence is not evidence of absence (#46).
async function fetchGeneratedSources(
  client: CoolifyClient,
  projectName: string,
  envName: string,
): Promise<{ sources: GeneratedSource[]; urlless: string[] }> {
  const uuid = await client.projectUuid(projectName);
  const raw = (await client.get(
    `/projects/${uuid}/${encodeURIComponent(envName)}`,
  )) as {
    postgresqls?: Array<Record<string, unknown>>;
    redis?: Array<Record<string, unknown>>;
  } | null;
  const sources: GeneratedSource[] = [];
  const urlless: string[] = [];
  const take = (type: string, items: Array<Record<string, unknown>> = []) => {
    for (const i of items) {
      const url = i.internal_db_url;
      // A database that is THERE but will not tell us its URL. Never a fill of
      // "" — that re-encrypts cleanly and boots the app pointed at nothing.
      if (typeof url !== "string" || url === "") {
        urlless.push(String(i.name));
        continue;
      }
      sources.push({ resource: String(i.name), type, url });
    }
  };
  take("postgresql", raw?.postgresqls);
  take("redis", raw?.redis);
  return { sources, urlless };
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
async function confirmTypedName(
  expected: string,
  question: string,
): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string | null>((resolve) => {
    rl.question(question).then(resolve, () => resolve(null));
    rl.once("close", () => resolve(null));
  });
  rl.close();
  return answer?.trim() === expected;
}

async function confirmCapture(envName: string): Promise<boolean> {
  return confirmTypedName(
    envName,
    `\ntype the environment name to write this store (${envName}): `,
  );
}

// The same ceremony, for the verb it was really invented for. Everything said
// above applies twice over here: `destroy` deletes resources and the volumes
// under them, Coolify's delete is a queued job that nothing recalls, and the
// operator has just been shown a plan whose database lines say whether each one
// can ever come back. Typing the environment's name is the act of having read it.
async function confirmDestroy(envName: string): Promise<boolean> {
  return confirmTypedName(
    envName,
    `\ntype the environment name to DESTROY the resources above (${envName}): `,
  );
}

// Everything ONE project run needs that is the same for every project in a
// fleet run: the instance it talks to (one client, one asserted team), the
// bindings, the environment. The single-project coordinates are here too and are
// always undefined under --all — the refusal above is what guarantees that, and
// it is why this one function can serve both paths without a branch inside it.
type ProjectRunContext = {
  command: "apply" | "diff";
  stateDir: string;
  envName: string;
  bindings: Bindings;
  binding: Bindings["environments"][string];
  client: CoolifyClient;
  mode: "structural" | "full";
  path?: string;
  projectOverride?: string;
  environmentOverride?: string;
  resources: string[];
  hostnameOverlay?: string;
};

// What one project's run came to. `absent` is the one failure this function
// RETURNS rather than throws, because it is the one the caller has always
// handled itself (renderAbsentTarget, exit 2) — everything else throws, and the
// fleet loop turns a throw into an unreachable project.
type ProjectResult =
  | { status: "clean" }
  | { status: "drift" }
  | { status: "applied"; mutated: string[] }
  | { status: "absent"; message: string };

// ONE project, end to end: checkout → secrets → desired → bindings → live →
// diff → (apply). There is exactly one implementation of what a project run IS,
// and both `cast diff <repo>` and `cast diff --all` call it — a second, parallel
// fleet path would be a second thing to keep true, and the two would drift the
// first time either was touched. That drift is the whole subject of this tool.
async function runProject(
  ctx: ProjectRunContext,
  orgRepo: string,
): Promise<ProjectResult> {
  const repoShort = orgRepo.split("/")[1];
  // The Coolify project name and the secrets-file key are different things
  // that happen to default to the same string. Only the former is a name
  // some other system chose: a project built by hand in the UI is called
  // whatever someone typed. --project overrides that one, and nothing else —
  // secrets stay keyed by the repo (a state-repo convention we own).
  const projectName = ctx.projectOverride ?? repoShort;
  // Exactly the same split, one level down. `--env` is OUR name for the
  // environment: it selects the manifest block, the environments.yaml
  // binding, the age key, the store path, the team to assert. `--environment`
  // is THEIR name for it on the wire, and nothing else. Collapsing the two
  // (as cast did until now) means a box built by hand in someone's UI gets to
  // name our environment — and since apply creates the environment from this
  // value, a legacy box's accident would be inherited by the new one forever.
  const coolifyEnv = ctx.environmentOverride ?? ctx.envName;
  const checkout = resolveCheckout(orgRepo, {
    env: ctx.envName,
    path: ctx.path,
  });
  const store = secretsFileFor(ctx.stateDir, repoShort, ctx.envName);
  // Named, rather than left to `age` to fail on. A registered project whose
  // store was never written is a project a fleet run cannot read — and under
  // --all the headline of this message is what the summary carries, so it has to
  // say which project and which file rather than "Command failed: age -d".
  if (!existsSync(store)) {
    throw new Error(
      [
        `no secret store for ${orgRepo} in ${ctx.envName}`,
        "",
        `  looked for:  ${store}`,
        "",
        "The manifest's ${…} refs are resolved from that store, so there is nothing to",
        "diff or apply without it. `cast capture` writes one from a live box.",
      ].join("\n"),
    );
  }
  const secrets = decryptSecrets(store, keyFileFor(ctx.envName));
  let { desired, resolvedEnvs } = desiredFromManifest(
    checkout,
    ctx.envName,
    secrets,
  );
  assertEnvVarPolicy(
    ctx.envName,
    resolvedEnvs,
    ctx.binding.forbidden_var_patterns,
  );
  // Keyed by the REPO, not by --project: --project is the name Coolify's own
  // UI happens to use for this project, and cast's state is keyed by the name
  // WE own (same split as the secrets file — see the --project note above).
  const projectBinding = projectBindingFor(ctx.bindings, ctx.envName, orgRepo);
  if (ctx.hostnameOverlay) {
    desired = applyHostnameOverlay(
      desired,
      parseYaml(readFileSync(ctx.hostnameOverlay, "utf8")),
    );
  }
  // `backups`/`serviceDomains` — diff and apply are the one path that compares
  // each, and each costs a supplementary GET per resource (see fetchLive).
  const lookup = await fetchLive(ctx.client, projectName, coolifyEnv, {
    backups: true,
    serviceDomains: true,
  });
  // apply and diff take opposite (and both correct) positions on absence:
  // apply is *allowed* to be the thing that brings a project into existence,
  // so [] is a legitimate starting point. diff is only ever a claim about
  // something that already exists — for it, absence is not an empty diff, it
  // is the absence of anything to diff against, and reporting a full-create
  // plan would launder that into a pass. See LiveLookup.
  //
  // That split holds under --all unchanged: a fleet diff counts an absent
  // project as UNREACHABLE (it read nothing, so it may claim nothing), while a
  // fleet apply creates it, exactly as a single apply would.
  if (!lookup.found && ctx.command === "diff") {
    return {
      status: "absent",
      message: renderAbsentTarget(lookup, {
        orgRepo,
        overridden: ctx.projectOverride !== undefined,
        envOverridden: ctx.environmentOverride !== undefined,
      }),
    };
  }
  const aliases = parseResourceAliases(
    ctx.resources,
    desired.map((d) => d.name),
  );
  // Without this, a diff against a box that names things differently reports
  // every manifest resource as "to create" and every live one as unknown —
  // the D-237 lie by another route: a confident full-create plan that verified
  // nothing, against a box that has all of it under other names.
  const live = lookup.found ? aliasLive(lookup.live, aliases) : [];
  if (ctx.mode === "full") {
    for (const l of live) {
      l.env = await fetchEnv(ctx.client, l);
    }
  }
  // Resolve ${resource:<name>.url} against the databases that ALREADY exist on
  // the box (#60). On a re-apply this is the whole story — the app's live
  // DATABASE_URL already equals its database's URL, so the derived var shows no
  // drift, which is what stops the "secret DATABASE_URL differs" noise that ran
  // on every plan. On a from-nothing apply the databases are not here yet, so
  // their refs stay unresolved through the diff (rendered "apply will set it")
  // and the executor fills them after it creates the databases. Keyed by manifest
  // name: aliasLive has already renamed live resources, and internalDbUrl rode
  // along (see fetchLive).
  const resourceUrls = Object.fromEntries(
    live
      .filter((l) => l.kind === "database" && l.internalDbUrl)
      .map((l) => [l.name, l.internalDbUrl as string]),
  );
  desired = fillDesiredDerived(desired, resourceUrls);
  const report = computeDiff(desired, live, ctx.mode, {
    declaredDestination: projectBinding?.destination_uuid,
  });
  console.log(renderDiff(report));
  if (ctx.command === "diff")
    return report.clean ? { status: "clean" } : { status: "drift" };
  // Before ANYTHING is written — the project and the environment are created lazily
  // by the first create, so this is the last moment at which a refusal still costs
  // nothing. A create whose domains are already claimed elsewhere on the instance
  // will be refused by Coolify no matter what cast does (#44); the only question is
  // whether the operator learns it now or half-way through an apply that has already
  // built a project. One GET, and only on a plan that creates an application with a
  // domain — a first apply, and nothing else.
  const visibleUuids = new Set(live.map((l) => l.uuid));
  const domainConflicts = await preflightDomainConflicts(
    ctx.client,
    report.changes,
  );
  if (domainConflicts.length > 0) {
    throw new Error(
      domainConflictRemedy(domainConflicts, {
        project: projectName,
        env: coolifyEnv,
        visible: visibleUuids,
        stage: "preflight",
      }),
    );
  }
  const serverUuid = await ctx.client.serverUuid(ctx.binding.server);
  const githubAppUuid = await ctx.client.githubAppUuid(
    githubAppNameFor(ctx.bindings, orgRepo),
  );
  const exec = buildExecutor(ctx.client, {
    projectName,
    // The name the environment gets ON COOLIFY when apply creates it — so an
    // apply that adopts an existing hand-named environment writes into that
    // one, rather than creating a second environment beside it.
    envName: coolifyEnv,
    serverUuid,
    githubAppUuid,
    // Not the wire names above (see buildExecutor): the names the operator wrote,
    // and the state-file path a missing destination has to be declared at.
    serverName: ctx.binding.server,
    orgRepo,
    bindingEnv: ctx.envName,
    destinationUuid: projectBinding?.destination_uuid,
    s3DestinationUuid: ctx.binding.s3_destination,
    visibleUuids,
  });
  const { mutated } = await applyPlan(report, desired, exec);
  console.log(
    mutated.length === 0
      ? "no-op (clean)"
      : `applied + redeployed: ${mutated.join(", ")}`,
  );
  return { status: "applied", mutated };
}

// The version lives in package.json — the tree's single source of truth
// (cast#96, deliberately no separate VERSION file). dist/cli.js sits one
// level below it in a source checkout and in an installed release asset
// alike, so resolving from import.meta.url answers for both without
// caring how this tree got here. The install root rides along in the
// output (the family's shape — rig prints its ROOT too) because "which
// cast is this" and "where does it run from" are the same question when
// several trees exist on one machine.
function formatVersion(): string {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const version: unknown = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  return `cast ${typeof version === "string" ? version : "unknown"} (${dirname(pkgPath)})`;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (command === "-V" || command === "--version") {
    console.log(formatVersion());
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
        all: { type: "boolean", default: false },
      },
    });
    const orgRepo = positionals[0];
    const envName = values.env;
    // --all IS the target, so it replaces the positional rather than joining it.
    if (!envName || (!orgRepo && !values.all)) {
      console.error(USAGE);
      return 2;
    }
    // Before anything is read: --all names a fleet, and every coordinate below
    // names ONE project's checkout, ONE project's Coolify name, ONE box's
    // resource names. See SINGLE_PROJECT_COORDINATES — each refusal says which
    // flag it was and what applying it fleet-wide would actually do.
    if (values.all) {
      const conflict = fleetConflict({
        "<org>/<repo>": orgRepo,
        "--path": values.path,
        "--project": values.project,
        "--environment": values.environment,
        "--resource": values.resource,
        "--hostname-overlay": values["hostname-overlay"],
      });
      if (conflict) {
        console.error(renderFleetConflict(command, conflict));
        return 2;
      }
    }
    // A checkout cannot decide what prod runs. Refused here, before a state file
    // is opened, and enforced again where it is actually honored (resolveCheckout)
    // — same rule, same string, no second spelling of it.
    if (refusesPathInProd({ env: envName, path: values.path })) {
      console.error(PATH_IN_PROD_REFUSAL);
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
    const bindingsPath = join(stateDir, "environments.yaml");
    const bindings = loadBindings(bindingsPath);
    const binding = bindings.environments[envName];
    if (!binding) {
      console.error(`environment ${envName} not in environments.yaml`);
      return 2;
    }
    // The fleet, or the one repo that was named. `projectsIn` is the ONLY place
    // "every project" comes from: a registry that does not list a project is a
    // registry that has never heard of it, and cast does not go looking for one
    // behind the operator's back.
    const targets = values.all ? projectsIn(bindings, envName) : [orgRepo];
    if (values.all && targets.length === 0) {
      console.error(
        renderEmptyRegistry(command, envName, bindings, bindingsPath),
      );
      return 2;
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
    //
    // Hoisted OUT of runProject deliberately, and it changes nothing about when
    // it lands: the instance is one instance and the team is one team for the
    // whole run, so asserting once here is asserting strictly before the FIRST
    // project's first read. Re-asserting per project would be the same call with
    // the same answer, N times.
    const team = await assertTeam(client, binding.team, envName);
    console.log(`team ${formatTeam(team)} ✓`);
    const ctx: ProjectRunContext = {
      command,
      stateDir,
      envName,
      bindings,
      binding,
      client,
      mode: command === "apply" || values.full ? "full" : "structural",
      path: values.path,
      projectOverride: values.project,
      environmentOverride: values.environment,
      resources: values.resource ?? [],
      hostnameOverlay: values["hostname-overlay"],
    };
    if (!values.all) {
      const result = await runProject(ctx, targets[0]);
      if (result.status === "absent") {
        console.error(result.message);
        return 2;
      }
      if (command === "diff") return result.status === "clean" ? 0 : 1;
      return 0;
    }
    const outcomes: ProjectOutcome[] = [];
    for (const [i, repo] of targets.entries()) {
      console.log(renderProjectHeading(repo, i + 1, targets.length));
      try {
        const result = await runProject(ctx, repo);
        if (result.status === "absent") {
          console.error(result.message);
          outcomes.push({
            repo,
            status: "unreachable",
            message: result.message,
          });
        } else if (result.status === "applied") {
          outcomes.push({ repo, status: "applied", mutated: result.mutated });
        } else {
          outcomes.push({ repo, status: result.status });
        }
      } catch (err) {
        // Every way a project can fail to answer — a clone that will not clone,
        // a manifest with no block for this environment, a store that will not
        // decrypt, a 500 from Coolify — arrives here, and NONE of them is a skip.
        // The single-project path lets these throw to main's handler; a fleet run
        // cannot, or the first bad project would take the rest of the report with
        // it (`diff`) or leave it un-summarized (`apply`).
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        outcomes.push({ repo, status: "unreachable", message });
      }
      // `diff --all` runs every project to completion: stopping early hides the
      // drift in the projects it never reached, and a partial read is exactly the
      // report this flag exists to make impossible. `apply --all` does the
      // opposite and stops — continuing to MUTATE a fleet after an unexplained
      // failure is not a thing cast gets to do. The two dispositions differ
      // because a read that continues costs nothing and a write that continues
      // costs everything.
      if (
        command === "apply" &&
        outcomes[outcomes.length - 1].status === "unreachable"
      ) {
        break;
      }
    }
    console.log(
      command === "diff"
        ? renderFleetDiff(envName, targets, outcomes)
        : renderFleetApply(envName, targets, outcomes),
    );
    return fleetExitCode(command, targets, outcomes);
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
        "generated-only": { type: "boolean", default: false },
        from: { type: "string", multiple: true },
      },
    });
    const orgRepo = positionals[0];
    const envName = values.env;
    if (!orgRepo || !envName) {
      console.error(USAGE);
      return 2;
    }
    // Pass 2 of a two-pass bootstrap. Not a different verb: same ceremony, same
    // store-writing code path, one inverted disposition rule. See capture.ts.
    const generatedOnly = values["generated-only"];
    const stateDir = stateDirFrom(values.state);
    const repoShort = orgRepo.split("/")[1];
    const projectName = values.project ?? repoShort;
    // Their name for the environment, on the wire. The store below stays keyed
    // by OUR name (--env) — capture is the verb most likely to be pointed at a
    // hand-built box, and the store it writes must not inherit that box's
    // vocabulary.
    const coolifyEnv = values.environment ?? envName;
    const store = secretsFileFor(stateDir, repoShort, envName);
    // Flag pairings that can never be honored, refused up front — before a state
    // file, a store, an age key or a Coolify is opened (same disposition as
    // PATH_IN_PROD_REFUSAL). --override supplies a value for a name cast would
    // otherwise CAPTURE, and --generated-only captures nothing; --from names the
    // database a GENERATED name comes from, and only pass 2 fills those.
    if (generatedOnly && (values.override ?? []).length > 0) {
      console.error(
        "refuses --override with --generated-only: pass 2 fills the generated names and leaves every other name exactly as the store has it — there is nothing for an override to override. Set the value in pass 1 (`cast capture --override`), or edit it there.",
      );
      return 2;
    }
    if (!generatedOnly && (values.from ?? []).length > 0) {
      console.error(
        "refuses --from without --generated-only: --from names the database a generated secret is filled FROM, and plain `capture` never fills one — it placeholds them (that is the point of pass 1).",
      );
      return 2;
    }
    // --resource reconciles the MANIFEST's vocabulary with the box's for the
    // env-reading pass, and pass 2 reads no env: it takes its value straight off
    // the live database, which --from names in the box's own vocabulary. Left
    // accepted, the flag would be silently ignored — the exact "the flag missed
    // and nothing said so" failure parseResourceAliases refuses for.
    if (generatedOnly && (values.resource ?? []).length > 0) {
      console.error(
        "refuses --resource with --generated-only: pass 2 reads no application env, so there is no manifest-to-box name mapping for it to use. --from names the live database directly, in the box's own vocabulary.",
      );
      return 2;
    }
    // The two passes take OPPOSITE positions on the store, and both are the same
    // rule: never destroy values that exist nowhere else.
    //
    // Pass 1 writes the store from nothing, so an existing one is something it
    // must not clobber. Pass 2 fills names INTO the store pass 1 wrote, so an
    // absent one is not a blank slate — it means this run is pointed somewhere
    // unexpected, and writing would produce a store holding two names out of
    // fourteen.
    if (generatedOnly && !existsSync(store)) {
      console.error(
        [
          `refusing to capture --generated-only: ${store} does not exist`,
          "",
          "Pass 2 FILLS the generated names in a store that pass 1 already wrote — it does",
          "not create one. A store written from here would hold only the generated names,",
          "and every other name the manifest requires would be silently absent from it.",
          "",
          "Run `cast capture` first (pass 1), then `apply`, then this.",
        ].join("\n"),
      );
      return 2;
    }
    // Never overwrite a store by accident. `apply` never deletes; the verb
    // that WRITES the store gets the same disposition, because the thing it
    // would destroy is the only copy of values that may not exist anywhere
    // else any more. (Pass 2 is exempt: it REQUIRES the store to exist, and
    // reuses --force for the finer refusal — overwriting a generated name that
    // already holds a real value. See planGenerated.)
    if (!generatedOnly && existsSync(store) && !values.force) {
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
    if (generatedOnly) {
      // Pass 2 needs the age IDENTITY, not just the recipient: it fills names
      // into a store it must first read. Everything it does not fill is carried
      // over from here byte for byte — never re-read from the box, which is what
      // makes this safe to run against a live environment whose other secrets
      // have since been rotated by hand.
      const keyFile = keyFileFor(envName);
      const before = decryptSecrets(store, keyFile);
      const generatedNames = [
        ...new Set([...generated, ...(values.generated ?? [])]),
      ];
      const { sources, urlless } = await fetchGeneratedSources(
        client,
        projectName,
        coolifyEnv,
      );
      // A database that exists but will not report its URL. The only way this
      // happens on this route is a Coolify whose shape we do not know — so it
      // stops, rather than filling a name with something that is not a URL.
      if (urlless.length > 0) {
        console.error(
          [
            `refusing to capture --generated-only: ${urlless.length} database(s) report no internal_db_url`,
            "",
            `  ${urlless.join(", ")}`,
            "",
            "`internal_db_url` is an appended attribute on Coolify's StandalonePostgresql /",
            "StandaloneRedis models (v4.1.2) and this route serializes them whole, so its",
            "absence means this Coolify is not the shape cast knows. Filling a secret with an",
            "empty value would re-encrypt cleanly and boot the app pointed at nothing.",
          ].join("\n"),
        );
        return 2;
      }
      const { mapping, unmapped } = resolveGeneratedSources(
        generatedNames,
        sources,
        parseFromPairs(values.from ?? [], generatedNames),
      );
      const plan = planGenerated(generatedNames, before, mapping, unmapped, {
        force: values.force,
      });
      console.log(
        renderGeneratedPlan(plan, {
          orgRepo,
          env: envName,
          instance: values.instance ?? binding.instance ?? "default",
          store,
          recipient,
          project: projectName,
          environment: coolifyEnv,
        }),
      );
      if (generatedPlanRefuses(plan)) return 2;
      if (plan.fills.length === 0) {
        console.log(
          "\nnothing to fill — this environment declares no generated secrets, and no name in the store is still pending.",
        );
        return 0;
      }
      if (!(await confirmCapture(envName))) {
        console.error("aborted — nothing written");
        return 2;
      }
      encryptSecrets(recipient, store, {
        ...before,
        ...Object.fromEntries(plan.fills.map((f) => [f.ref, f.value])),
      });
      // The postcondition this verb exists for, asserted against the ciphertext
      // that is now on disk — decrypted back, not trusted from memory. In the
      // hand-run procedure this was a line in a runbook, which is to say a step
      // that could be skipped, and was only ever as good as the operator's
      // attention at the end of a long careful thing.
      const after = decryptSecrets(store, keyFile);
      const violations = assertGeneratedComplete(before, after);
      if (violations.length > 0) {
        console.error(
          [
            "",
            `POSTCONDITION FAILED — ${store} was written, and it is not what it should be:`,
            "",
            ...violations.map((v) => `  - ${v}`),
            "",
            "This store is suspect. Do not apply from it. Restore the previous ciphertext",
            "from the state repo (it is committed) and report this — cast wrote a store whose",
            "shape it does not itself accept, which is a bug in cast, not in your invocation.",
          ].join("\n"),
        );
        return 2;
      }
      console.log(
        `\nwrote ${store} — ${plan.fills.length} name(s) filled, ${Object.keys(after).length} name(s) total (unchanged), zero pending-coolify-generated remaining, encrypted to ${recipient}`,
      );
      return 0;
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
      liveEnvs[l.name] = flattenEnv(await fetchEnv(client, l));
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
        "emit-draft": { type: "string" },
        recipient: { type: "string" },
        "no-secrets": { type: "boolean", default: false },
      },
    });
    const orgRepo = positionals[0];
    const envName = values.env;
    if (!envName) {
      console.error(USAGE);
      return 2;
    }
    const draftDir = values["emit-draft"];
    // A draft is emitted from the SWEEP, and only from the sweep. With a repo,
    // inventory is reconciling against a manifest that already exists — which is
    // exactly the case where a draft must not be written: for a declared project
    // the manifest IS the truth, and one regenerated from a live box would let
    // that box's accumulated cruft overwrite the reviewed spec. Adoption is
    // one-way, so the two flags cannot be combined at all.
    if (draftDir && orgRepo) {
      console.error(renderRepoWithDraft(orgRepo, draftDir));
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
      // Both refusals BEFORE the first live call. A draft that is going to be
      // refused should be refused before an operator watches a whole instance be
      // swept for it — and, more to the point, before cast reads every env var on
      // a box it is then not going to write down.
      const recipient = values.recipient ?? sweepBinding.age_recipient;
      if (draftDir) {
        try {
          assertEmptyTarget(draftDir);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          return 2;
        }
        // No recipient, no store — and cast will not make that decision quietly.
        // Silently skipping the secrets would emit a draft that LOOKS complete: a
        // manifest, templates full of ${REF}s, and nothing anywhere holding a
        // single value. You would find out when `apply` refused, having already
        // deleted the box the values were on.
        if (!recipient && !values["no-secrets"]) {
          console.error(renderNoRecipient(envName));
          return 2;
        }
      }
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
      const live = await client.projects();
      const projects: SweepProject[] = [];
      for (const p of live) {
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
      if (!draftDir) return 0;

      // --- The draft (#27) ---
      //
      // The sweep above is a DOCUMENT. This is the same reading, written into the
      // shape of cast's own inputs — and it is still a proposal, not desired
      // state. See draft.ts for the boundary that lets this verb exist at all.
      //
      // A project with resources in TWO environments cannot be drafted without
      // picking one, and cast does not pick: a blueprint of half a box, silently
      // chosen, is the failure mode this whole issue is about. --environment says
      // which.
      //
      // --environment is a TIEBREAK here, not a filter. A project with resources
      // in exactly one environment has no tie to break, and is drafted from it
      // whatever the flag says — filtering the instance by an environment NAME
      // would drop the projects that most need drafting (the third-party sites,
      // each sitting in its own Coolify-default `production`) out of a blueprint
      // that claims to describe the box.
      const populatedIn = (p: SweepProject) =>
        p.environments.filter((e) => e.resources.length > 0);
      const pick = (p: SweepProject) => {
        const populated = populatedIn(p);
        return populated.length === 1
          ? populated[0]
          : populated.find((e) => e.name === values.environment);
      };
      const ambiguous = projects.filter(
        (p) => populatedIn(p).length > 1 && !pick(p),
      );
      if (ambiguous.length > 0) {
        console.error(
          renderAmbiguousEnvironments(
            ambiguous.map((p) => ({
              name: p.name,
              environments: populatedIn(p).map(
                (e) => `${e.name} (${e.resources.length})`,
              ),
            })),
            envName,
          ),
        );
        return 2;
      }
      const draftProjects: DraftProject[] = [];
      for (const p of live) {
        const swept = projects.find((s) => s.name === p.name);
        const populated = swept ? populatedIn(swept) : [];
        const chosen = swept ? pick(swept) : undefined;
        const others = populated
          .filter((e) => e.name !== chosen?.name)
          .map((e) => ({ name: e.name, resources: e.resources.length }));
        if (!chosen) {
          // Not drafted — and SAID, in UNCAPTURED.md, rather than left out of a
          // blueprint that a reader would take for the whole box.
          draftProjects.push({
            name: p.name,
            coolifyEnv: "(none)",
            resources: [],
            unreadable: [],
            otherEnvironments: others,
            skipReason: "every environment on it is empty",
          });
          continue;
        }
        // The RAW environment document, not fetchLive's projection: the uncaptured
        // pass's whole job is to notice fields cast has no home for, and it cannot
        // notice what a projection has already thrown away.
        const raw = (await client.get(
          `/projects/${p.uuid}/${chosen.name}`,
        )) as Record<string, unknown> | null;
        const { resources, unreadable } = draftResourcesFrom(raw ?? {});
        for (const r of resources) {
          // Databases hold no manifest-templated env of their own — their URL is
          // what the APPS reference, and that name is generated, not captured.
          // What a database DOES hold is a backup schedule, on its own route
          // (#51) — and a blueprint that omits backups is the quietest possible
          // loss, so the draft pays the one supplementary GET per DRAFTED
          // database that diff/apply pay per compared one. Ungated on purpose:
          // fetchLive's `opts.backups` gate exists because the read-side sweeps
          // never look at the answer, and the draft is the sweep that does. A
          // failed read lands on `undefined` and becomes an UNCAPTURED entry
          // (see draftBackup) — reported, never aborting the whole-instance
          // sweep the way diff/apply refuse a single-project plan.
          if (r.kind === "database") {
            r.backups = await client.databaseBackupSchedules(r.uuid);
            continue;
          }
          r.env = flattenEnv(
            await fetchEnv(client, { kind: r.kind, uuid: r.uuid }),
          );
          // A service's hostnames live behind the same kind of supplementary
          // GET as a database's backups (#83, sibling of #75 — one design, both
          // reads): GET /services/{uuid} is the only route that eager-loads
          // service.applications, so the draft pays it per DRAFTED service,
          // ungated and sequential, and projects the answer through THE
          // projection diff/apply use (projectServiceDomains) so the drafted
          // manifest diffs clean the moment it is applied. A failed read lands
          // on `undefined` and becomes an UNCAPTURED entry (see serviceSpec) —
          // where attachServiceDomains fails a one-project diff closed, a
          // whole-instance sweep reports and keeps going.
          if (r.kind === "service") {
            r.serviceDomains = projectServiceDomains(
              await client.serviceByUuid(r.uuid).catch(() => undefined),
            );
          }
        }
        draftProjects.push({
          name: p.name,
          coolifyEnv: chosen.name,
          resources,
          unreadable,
          otherEnvironments: others,
        });
      }
      // Which GitHub App clones a repo IS readable (cast#72): an application
      // carries `source_id`/`source_type` (removeSensitiveData hides neither),
      // and GET /github-apps returns each App's `id` and `name` (only the
      // secrets are hidden) — so bindingsDoc resolves the binding by matching the
      // two, instead of guessing the only App. The list is still best-effort: an
      // instance that will not answer it leaves a REVIEW marker on every repo.
      const githubApps = (await client.get("/github-apps").catch(() => [])) as
        | Array<{ id?: unknown; name?: unknown }>
        | undefined;
      const draftCtx = {
        env: envName,
        instance: instance.name,
        baseUrl: instance.baseUrl,
        team,
        server: sweepBinding.server,
        githubApps: (Array.isArray(githubApps) ? githubApps : [])
          .filter(
            (a): a is { id: number; name: string } =>
              typeof a?.id === "number" && typeof a?.name === "string",
          )
          .map((a) => ({ id: a.id, name: a.name })),
        recipient,
        generatedAt: new Date().toISOString(),
      };
      const storeRecipient = values["no-secrets"] ? undefined : recipient;
      const plan = planDraft(draftProjects, draftCtx);
      const written = emitDraft(draftDir, plan, { recipient: storeRecipient });
      console.log(
        renderDraftPlan(plan, draftCtx, {
          dir: draftDir,
          recipient: storeRecipient,
          written,
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
  // The only verb that deletes what a manifest declared — and, therefore, the
  // verb whose REFUSALS are the product. Every gate below is placed as early as
  // it can honestly be answered, so that the expensive, irreversible half of this
  // command is reached only by a run that has already been told "yes" by the
  // state repo, the instance, the team, the project, the manifest, and a human.
  if (command === "destroy") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        env: { type: "string" },
        state: { type: "string" },
        path: { type: "string" },
        instance: { type: "string" },
        "with-project": { type: "boolean", default: false },
        // Declared ONLY so that it can be refused with a sentence. Left out of
        // this list, `--all` would die as parseArgs's "Unknown option" — which
        // reads like a version skew, invites a retry, and says nothing about why
        // a fleet-wide delete is a thing cast does not have. See
        // renderDestroyAllRefusal.
        all: { type: "boolean", default: false },
      },
    });
    // FIRST, before the usage check even: `cast destroy --env prod --all` has no
    // repo positional, and answering it with a usage block would tell an operator
    // that the missing piece is the repo name.
    if (values.all) {
      console.error(renderDestroyAllRefusal());
      return 2;
    }
    const orgRepo = positionals[0];
    const envName = values.env;
    if (!orgRepo || !envName) {
      console.error(USAGE);
      return 2;
    }
    // A checkout cannot decide what prod runs — and for THIS verb, what a
    // checkout would be deciding is what gets deleted out of prod. Same rule,
    // same string, same refusal as apply's.
    if (refusesPathInProd({ env: envName, path: values.path })) {
      console.error(PATH_IN_PROD_REFUSAL);
      return 2;
    }
    const stateDir = stateDirFrom(values.state);
    const bindingsPath = join(stateDir, "environments.yaml");
    const bindings = loadBindings(bindingsPath);
    const binding = bindings.environments[envName];
    if (!binding) {
      console.error(`environment ${envName} not in environments.yaml`);
      return 2;
    }
    // THE INTERLOCK, and it is checked here — before the clone, before the
    // instance is opened, before a single call — because it is a fact about the
    // state repo and nothing on the wire can change the answer. An environment
    // that has not been deliberately opened for destruction refuses at the
    // cheapest possible moment, having touched nothing.
    if (binding.destroy_allowed !== true) {
      console.error(
        renderNoInterlock(envName, bindingsPath, binding.destroy_allowed),
      );
      return 2;
    }
    // NO --project, NO --environment, NO --resource — see renderAbsentDestroyTarget.
    // The project is the one named after the repo, the environment is the one named
    // by --env, and the resources are the ones the manifest declares under their own
    // names. Every one of those three flags exists to point cast at names SOMEBODY
    // ELSE chose in a UI, and a delete does not get to be aimed by them.
    const repoShort = orgRepo.split("/")[1];
    const projectName = repoShort;
    const coolifyEnv = envName;
    const checkout = resolveCheckout(orgRepo, {
      env: envName,
      path: values.path,
    });
    // The manifest's names, and no secrets: destroy deletes resources, it does not
    // resolve a single ${REF}, so it needs no store and no age key (which also means
    // a store that was lost with the box being torn down cannot block the teardown).
    const declared = manifestResources(checkout, envName).map((r) => ({
      kind: r.kind,
      name: r.name,
    }));
    const { instance, client } = openCoolify(
      stateDir,
      values.instance,
      binding,
    );
    // Both asserts, both before the first read. The read-only refusal is the same
    // one apply/smoke/server-add take; the team assert matters even more here than
    // it does for them, because a wrong-team token reads back an EMPTY project —
    // and an empty project is a plan that deletes nothing while the real one is
    // untouched (or, with --with-project, a delete aimed at a project in a team
    // nobody checked).
    assertWritable(instance, "destroy");
    const team = await assertTeam(client, binding.team, envName);
    console.log(`team ${formatTeam(team)} ✓`);
    const lookup = await fetchLive(client, projectName, coolifyEnv);
    if (!lookup.found) {
      console.error(
        renderAbsentDestroyTarget(lookup, { orgRepo, env: envName }),
      );
      return 2;
    }
    const plan = planDestroy(declared, lookup.live);
    // What deleting each database COSTS, asked of Coolify rather than assumed
    // from the manifest's `backup:` block: the manifest says what was declared,
    // and the only thing worth knowing at the prompt is what actually exists and
    // whether it ever ran. A failure to read it is `unknown` (see readBackupState)
    // — never "none", which is the one direction this must never round in.
    for (const target of plan.targets) {
      if (target.kind !== "database") continue;
      target.backup = await client.databaseBackups(target.uuid).then(
        readBackupState,
        (err): BackupState => ({
          state: "unknown",
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    // --with-project, pre-flighted: Coolify refuses to delete a project or an
    // environment that still holds anything, and it refuses AFTER the resources are
    // gone. Ask both questions now, while nothing has been deleted and the answer is
    // still an operator's decision rather than a 400 they read afterwards.
    let projectUuid: string | undefined;
    if (values["with-project"]) {
      projectUuid = await client.projectUuid(projectName);
      const otherEnvironments: Array<{ name: string }> = [];
      for (const name of await client.environments(projectUuid)) {
        if (name === coolifyEnv) continue;
        if (!(await client.environmentIsEmpty(projectUuid, name))) {
          otherEnvironments.push({ name });
        }
      }
      if (plan.undeclared.length > 0 || otherEnvironments.length > 0) {
        console.error(
          renderProjectNotEmptiable(
            { project: projectName, environment: coolifyEnv },
            { undeclared: plan.undeclared, otherEnvironments },
          ),
        );
        return 2;
      }
    }
    console.log(
      renderDestroyPlan(plan, {
        orgRepo,
        env: envName,
        project: projectName,
        environment: coolifyEnv,
        withProject: values["with-project"],
      }),
    );
    // A destroy with nothing to destroy is a refusal, not a clean run (D-237).
    // Under --with-project it is NOT: removing the empty project and environment a
    // half-applied first run left behind is exactly the job, and there the emptiness
    // is the point rather than the surprise.
    if (plan.targets.length === 0 && !values["with-project"]) {
      console.error(
        renderNothingDeclaredHere(plan, {
          orgRepo,
          env: envName,
          project: projectName,
          environment: coolifyEnv,
        }),
      );
      return 2;
    }
    if (!(await confirmDestroy(envName))) {
      console.error("aborted — nothing deleted");
      return 2;
    }
    const uuid = projectUuid;
    const exec: DestroyExecutor = {
      deleteResource: (t) => client.deleteResource(t.kind, t.uuid),
      // Only ever reached under --with-project, which is the only path that
      // resolves the project's uuid. The throw is not defensive noise: it is what
      // keeps a future caller from wiring these three up with a uuid it never
      // fetched, against a project it never looked at.
      environmentIsEmpty: () => {
        if (!uuid) throw new Error("no project uuid resolved");
        return client.environmentIsEmpty(uuid, coolifyEnv);
      },
      deleteEnvironment: () => {
        if (!uuid) throw new Error("no project uuid resolved");
        return client.deleteEnvironment(uuid, coolifyEnv);
      },
      deleteProject: () => {
        if (!uuid) throw new Error("no project uuid resolved");
        return client.deleteProject(uuid);
      },
    };
    const outcome = await executeDestroy(plan, exec, {
      withProject: values["with-project"],
    });
    console.log(
      renderDestroyResult(outcome, {
        project: projectName,
        environment: coolifyEnv,
      }),
    );
    // A --with-project run that could not finish exits NON-ZERO even though every
    // resource it was asked to delete is gone: what the operator asked for did not
    // happen in full, and a 0 here would say it did.
    return outcome.note ? 2 : 0;
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
): Promise<{ uuid: string; created: boolean }> {
  try {
    return { uuid: await client.projectUuid(name), created: false };
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
      return { uuid: p.uuid, created: true };
    }
    throw err;
  }
}

// The environment every resource create names in `environment_name` has to
// EXIST before the create, and cast is the only thing that can be relied on to
// make it so: POST /projects gives a new project Coolify's OWN default
// environment ("production"), not ours, so the first apply against a project
// cast itself created 404s on the first resource — "Environment not found" —
// with the project left behind, created and empty (#38).
//
// It went unseen for as long as it did because every environment cast had met
// until then was built by hand in a UI and adopted, so it already existed under
// whatever name someone typed — which is the same history that put `--environment`
// in the tool. The genuinely-from-nothing apply is the one path nobody had run.
//
// Idempotent by construction, so it is safe on EVERY apply and not just the
// first: absent -> create, present -> nothing. Reading before writing is also
// what keeps this change from being able to break an apply that works TODAY —
// an environment that already exists (every environment cast has ever touched)
// takes the read and stops, and the create route is never called at all. The
// 409 is the same answer as "present" (Coolify's create-environment 409s on a
// duplicate name), reached when something else wins the race between our read
// and our write.
//
// Coolify's default environment is then REMOVED — the one delete cast performs,
// and the exception that has to argue for itself against *apply never deletes*
// (#40).
//
// What that rule protects is things cast did not make: a resource, an env var, a
// project someone built by hand. This is none of those. It is a byproduct of
// cast's own `POST /projects` seconds earlier, in this run, holding nothing and
// having never held anything — cast declining to leave litter behind itself. The
// alternative is what #39 shipped and #40 was filed against: every project cast
// creates from nothing carries a permanently-empty `production` beside the
// environment everything actually lives in, which is *precisely* the shape that
// makes a box unreadable later. We have the live example — on the box being
// migrated away from, `production` is empty and everything runs in `staging`,
// and "the obvious guess is the wrong one" is a note we had to write down for
// ourselves. Shipping more of those is not neutrality; it is a bug with a
// changelog entry.
//
// All three conditions are load-bearing, and removeDefaultEnvironment enforces
// them jointly:
//
//   cast created the project, in THIS run — never touch a project someone built
//     by hand, whatever it happens to carry.
//   the environment is EMPTY — asked of Coolify, not assumed from the above.
//   its name is NOT ours — a project whose --environment legitimately IS
//     `production` keeps it (it is the one everything is about to live in).
//
// And it is best-effort: a delete that fails leaves the environment reported,
// exactly as #39 left it, and never fails an apply that has otherwise worked.
// Tidying is not worth a half-applied run.
async function ensureEnvironment(
  client: CoolifyClient,
  projectUuid: string,
  projectName: string,
  envName: string,
  projectWasCreated: boolean,
): Promise<void> {
  // The read that decides. On a project cast just created, it is also the list
  // of environments Coolify gave it by itself — which is what `strays` holds.
  const existing = await client.environments(projectUuid);
  if (!existing.includes(envName)) {
    try {
      await client.post(`/projects/${projectUuid}/environments`, {
        name: envName,
      });
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 409) throw err;
    }
  }
  if (!projectWasCreated) return;
  for (const stray of existing.filter((e) => e !== envName)) {
    await removeDefaultEnvironment(client, projectUuid, projectName, stray);
  }
}

// The delete itself, and the two ways it declines to happen. Nothing here throws:
// every path ends in a line of output, because the operator's project is either
// tidy or carrying an environment they now know about.
async function removeDefaultEnvironment(
  client: CoolifyClient,
  projectUuid: string,
  projectName: string,
  envName: string,
): Promise<void> {
  try {
    // Asked, not inferred. It is empty by construction — Coolify made it a
    // moment ago and only cast has written to this project since — but "it must
    // be empty" is a belief, and this is a delete. The check costs one GET and
    // is what makes the guarantee a fact rather than an argument.
    if (!(await client.environmentIsEmpty(projectUuid, envName))) {
      console.log(
        `note: left Coolify's default environment ${envName} on new project ${projectName} — it is NOT empty (cast deletes nothing that holds anything)`,
      );
      return;
    }
    await client.deleteEnvironment(projectUuid, envName);
    console.log(
      `removed Coolify's default environment ${envName} from new project ${projectName} (empty — created by Coolify's POST /projects, never by the manifest)`,
    );
  } catch (err) {
    console.log(
      `note: new project ${projectName} carries Coolify's default environment ${envName} — empty and unused, and cast could not remove it (${err instanceof Error ? err.message : String(err)}). Delete it by hand, or leave it.`,
    );
  }
}

// Project + environment, reconciled once per run and then remembered — the pair
// a resource create has to name before it can name anything else.
function projectEnvironmentResolver(
  client: CoolifyClient,
  projectName: string,
  envName: string,
): () => Promise<string> {
  let once: Promise<string> | undefined;
  return () => {
    once ??= (async () => {
      const { uuid, created } = await resolveOrCreateProject(
        client,
        projectName,
      );
      await ensureEnvironment(client, uuid, projectName, envName, created);
      return uuid;
    })();
    return once;
  };
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
    // is_static/install_command/build_command/start_command ride through `rest`
    // unchanged: they are valid API params verbatim, accepted on both the create
    // (POST /applications/private-github-app) and update (PATCH
    // /applications/{uuid}) routes — verified against the vendored OpenAPI.
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

// The desired backup schedule, narrowed out of the untyped `fields` bag that
// both createResource and updateFields are handed. Anything that is not a
// complete, well-typed schedule reads as "none declared" — the manifest schema
// (manifest.ts) already requires both keys, so a partial object here would mean
// a bug upstream, and writing half a schedule is worse than writing none.
export function desiredBackup(
  fields: Record<string, unknown>,
): { frequency: string; retention: number } | undefined {
  const b = fields.backup as
    | { frequency?: unknown; retention?: unknown }
    | undefined;
  if (!b || typeof b !== "object") return undefined;
  if (typeof b.frequency !== "string" || typeof b.retention !== "number")
    return undefined;
  return { frequency: b.frequency, retention: b.retention };
}

export function databaseApiFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  // /databases/postgresql and /databases/redis accept no `type` param (the
  // endpoint path already encodes it) and no `version` param at all — only
  // `image`, a literal Docker image string.
  //
  // `backup` is stripped because it is not a column on the database at all: it
  // is a row on a different route (/databases/{uuid}/backups), written by
  // writeBackupSchedule. It rides in `fields` so that it can be DIFFED like
  // any other field; it must never reach the database's own create/update body,
  // which rejects unknown fields.
  const { type, version, backup: _backup, ...rest } = fields;
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
  // /services accepts `urls`, a per-container list ({name, url}[]) — the create
  // (POST /services) and update (PATCH /services/{uuid}) allowlists both carry
  // it, and applyServiceUrls matches `urls[].name` to a ServiceApplication and
  // sets its `fqdn`, `url` being that container's URLs comma-joined (verified
  // against ServicesController v4.1.2, cast#72). `service_domains` speaks the
  // internal map vocabulary (container -> string[]); this is the exact shape
  // dockercompose apps' `docker_compose_domains` is written with, one route over.
  //
  // A `url` whose `name` matches no container is a 422 on update and, on CREATE,
  // deletes the just-made service before answering 422 (applyServiceUrls's
  // rollback) — so the name must be a real container. buildExecutor surfaces
  // either as-is; the operator reads the right name off a `cast diff` read-back.
  const { service_domains, ...rest } = fields;
  return {
    ...rest,
    ...(service_domains !== undefined
      ? {
          urls: Object.entries(service_domains as Record<string, string[]>).map(
            ([name, urls]) => ({ name, url: urls.join(",") }),
          ),
        }
      : {}),
  };
}

// --- Domain uniqueness: instance-wide, while cast plans project-scoped (#44) ---
//
// Coolify enforces domain uniqueness across the whole instance (every application
// and every service application of the TEAM, plus the instance fqdn:
// bootstrap/helpers/domains.php@checkIfDomainIsAlreadyUsedViaAPI, v4.1.2). cast
// plans inside ONE project + ONE environment. So apply can produce a plan that is
// internally consistent, correct against everything cast can observe, and still be
// refused — by a resource cast cannot see, for a reason invisible from its scope:
//
//   POST /applications/private-github-app → 409:
//   {"message":"Domain conflicts detected. Use force_domain_override=true to proceed.",
//    "conflicts":[{"domain":"http://api.89.167.19.110.sslip.io","resource_name":"core",
//                  "resource_uuid":"tqsmnzdde…","resource_type":"application",
//                  "service_name":"api","message":"Domain … is already in use …"}],
//    "warning":"Using the same domain for multiple resources can cause routing
//               conflicts and unpredictable behavior."}
//
// Same family as the multi-destination 400 above (#41) — an instance-wide constraint
// arriving mid-apply, after the project and the environment have been made. Unlike
// that one, this one CAN be pre-flighted (GET /applications is the same population
// Coolify checks against), so it is: see preflightDomainConflicts. The 409 handling
// stays regardless, because the pre-flight is a subset — Coolify also compares
// against service fqdns and the instance fqdn, which no list cast can read exposes.
//
// force_domain_override=true is the one thing cast will never do about any of this.
// Coolify offers it in the error text; two resources sharing a domain is a routing
// coin-flip, and Coolify says as much in the same response ("can cause routing
// conflicts and unpredictable behavior"). If cast ever gains the flag it is an
// explicit operator act, never a retry — nothing below may send it.

export type DomainConflict = {
  domain: string;
  resource_name: string;
  resource_uuid: string;
  resource_type: string;
  // The conflicting app's compose SERVICE, when it holds the domain per-service.
  service_name?: string;
  // Which resource in OUR plan wanted the domain. Not Coolify's field — cast's,
  // so a refusal listing three conflicts says which create each one blocks.
  wanted_by?: string;
};

// Coolify's comparison, exactly: strip ONE trailing slash, then compare the
// strings LITERALLY — scheme and all (domains.php ~L153-177). So `http://x` and
// `https://x` are different domains to Coolify, and cast must not be cleverer
// here than the thing it is predicting: normalizing to a bare host would make the
// pre-flight disagree with the server, in both directions (missed conflicts, and
// refusals Coolify would have allowed).
function nakedDomain(raw: string): string {
  const d = raw.trim();
  return d.endsWith("/") ? d.slice(0, -1) : d;
}

// The domains a planned CREATE would claim: an application's flat `domains` or
// compose `docker_compose_domains`, and now a service's `service_domains`
// (cast#72 — service creates send `urls`; databases have no domains). Worth
// pre-flighting for services in particular, because a service create whose
// domain conflicts does not just 409 — applyServiceUrls DELETES the half-made
// service first (v4.1.2 rollback), so catching it here costs nothing where the
// server-side failure costs a resurrection.
export function desiredDomainsOfCreate(
  change: Change,
): Array<{ domain: string; service?: string }> {
  if (change.op !== "create") return [];
  if (change.kind !== "application" && change.kind !== "service") return [];
  const fields = Object.fromEntries(
    change.fieldDiffs.map((f) => [f.field, f.desired]),
  );
  const out: Array<{ domain: string; service?: string }> = [];
  const flat = fields.domains;
  if (Array.isArray(flat)) {
    for (const d of flat)
      if (typeof d === "string" && d.length > 0)
        out.push({ domain: nakedDomain(d) });
  }
  // dockercompose apps and services share the per-container map shape
  // (docker_compose_domains / service_domains); the two never coexist on one
  // resource. A container's name rides out as `service` so a conflict can say
  // which container wanted the domain.
  const perContainer = (fields.docker_compose_domains ??
    fields.service_domains) as Record<string, string[]> | undefined;
  if (perContainer) {
    for (const [service, urls] of Object.entries(perContainer))
      for (const d of urls ?? [])
        if (typeof d === "string" && d.length > 0)
          out.push({ domain: nakedDomain(d), service });
  }
  return out;
}

// The domains a LIVE application holds, read off a raw GET /applications record.
//
// Both shapes, and they are mutually exclusive on Coolify's side: a non-compose app
// carries `fqdn` (a comma-separated string), a dockercompose app carries per-service
// domains in `docker_compose_domains` (JSON, service -> {domain: "a,b"}). The
// build_pack gate on the second one is Coolify's, not a guess (domains.php L189:
// `$app->build_pack === 'dockercompose' && ! empty($app->docker_compose_domains)`)
// — and it is load-bearing in the strict direction: a nixpacks app carrying stale
// compose-domain JSON does NOT conflict, so cast must not refuse for one either. A
// pre-flight stricter than the server is a pre-flight that blocks correct applies.
export function liveApplicationDomains(
  raw: Record<string, unknown>,
): Array<{ domain: string; service?: string }> {
  const out: Array<{ domain: string; service?: string }> = [];
  const fqdn = raw.fqdn;
  if (typeof fqdn === "string")
    for (const d of fqdn.split(",").filter(Boolean))
      out.push({ domain: nakedDomain(d) });
  if (raw.build_pack === "dockercompose") {
    const compose = parseDockerComposeDomains(raw.docker_compose_domains);
    if (compose)
      for (const [service, urls] of Object.entries(compose))
        for (const d of urls) out.push({ domain: nakedDomain(d), service });
  }
  return out;
}

// The pure half: what would Coolify refuse, given this plan and this instance?
export function findDomainConflicts(
  creates: Change[],
  liveApps: Array<Record<string, unknown>>,
): DomainConflict[] {
  const conflicts: DomainConflict[] = [];
  for (const change of creates) {
    for (const want of desiredDomainsOfCreate(change)) {
      for (const app of liveApps) {
        for (const held of liveApplicationDomains(app)) {
          if (held.domain !== want.domain) continue;
          conflicts.push({
            domain: want.domain,
            resource_name: String(app.name ?? "(unnamed)"),
            resource_uuid: String(app.uuid ?? "(unknown)"),
            resource_type: "application",
            ...(held.service ? { service_name: held.service } : {}),
            wanted_by: `${change.kind} ${change.name}${want.service ? ` (service: ${want.service})` : ""}`,
          });
        }
      }
    }
  }
  return conflicts;
}

// N+1 was the obvious shape for this and it is not needed: GET /applications is
// serialized by the same removeSensitiveData() as GET /applications/{uuid}, so the
// list already carries `fqdn` and `docker_compose_domains` (see coolify.ts). One
// call, and only on a plan that creates an application with a domain — which is a
// first apply, and nothing else.
export async function preflightDomainConflicts(
  client: CoolifyClient,
  changes: Change[],
): Promise<DomainConflict[]> {
  const creates = changes.filter(
    (c) => c.op === "create" && desiredDomainsOfCreate(c).length > 0,
  );
  if (creates.length === 0) return [];
  return findDomainConflicts(creates, await client.applications());
}

// The 409, when one still gets through — an update that moves a domain, a conflict
// with a Coolify service or the instance fqdn (neither is in GET /applications), or
// a resource created between the pre-flight and the create.
function domainConflicts409(err: unknown): DomainConflict[] | undefined {
  if (!(err instanceof HttpError) || err.status !== 409) return undefined;
  // The HttpError message is "POST /path → 409: <body>"; the body is the only part
  // that carries the conflicts, and it is JSON.
  const start = err.message.indexOf("{");
  if (start === -1) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(err.message.slice(start));
  } catch {
    return undefined;
  }
  const parsed = body as { message?: unknown; conflicts?: unknown };
  // Narrow on the CONFLICTS, not on the status: 409 is also how Coolify answers a
  // duplicate environment create (see ensureEnvironment), and this must not claim
  // that one.
  if (!Array.isArray(parsed.conflicts) || parsed.conflicts.length === 0)
    return undefined;
  return parsed.conflicts.map((c) => {
    const e = c as Record<string, unknown>;
    return {
      domain: String(e.domain ?? "(unknown)"),
      resource_name: String(e.resource_name ?? "(unknown)"),
      resource_uuid: String(e.resource_uuid ?? "(unknown)"),
      resource_type: String(e.resource_type ?? "resource"),
      ...(typeof e.service_name === "string"
        ? { service_name: e.service_name }
        : {}),
    };
  });
}

// One renderer for both paths, because the operator's question is the same one
// whether cast refused before touching anything or Coolify refused mid-apply: what
// holds my domain, where is it, and why can't I see it?
export function domainConflictRemedy(
  conflicts: DomainConflict[],
  where: {
    project: string;
    env: string;
    // The UUIDs of the live resources cast CAN see — this project, this
    // environment. The whole point of the message is the scope claim, so the scope
    // claim is checked rather than assumed: a conflict with something in the plan's
    // own project (a renamed resource, say) is a different fix, and saying "outside
    // your project" about it would be a lie.
    visible: ReadonlySet<string>;
    // Before anything was mutated, or after. It decides what the operator is
    // holding, which is the first thing they need to know.
    stage: "preflight" | "apply";
    // Coolify's own words, kept verbatim when we have them — a translation that
    // hides the original makes the next person's search fail.
    coolify?: string;
  },
): string {
  const head =
    where.stage === "preflight"
      ? `refusing to apply: ${conflicts.length === 1 ? "a domain in this plan is" : `${conflicts.length} domains in this plan are`} already claimed on this Coolify.`
      : `create rejected: Coolify refused ${conflicts.length === 1 ? "a domain" : "domains"} in this plan as already claimed.`;
  const lines = [
    head,
    "",
    "Domain uniqueness is enforced across the WHOLE Coolify instance. cast plans inside",
    `one project + one environment (${where.project} / ${where.env}), so a plan can be`,
    "correct against everything cast can see and still be refused by something it cannot.",
    "",
  ];
  for (const c of conflicts) {
    const held = c.service_name
      ? `${c.resource_type} '${c.resource_name}' (service: ${c.service_name})`
      : `${c.resource_type} '${c.resource_name}'`;
    lines.push(`  ${c.domain}`);
    if (c.wanted_by) lines.push(`    wanted by:  ${c.wanted_by}`);
    lines.push(`    claimed by: ${held}, uuid ${c.resource_uuid}`);
    if (where.visible.has(c.resource_uuid)) {
      lines.push(
        `    It IS in ${where.project} / ${where.env} — under another name, so the plan does not`,
        "    match it to anything and wants to create beside it. Rename, or free the domain;",
        "    cast never deletes what it did not plan.",
      );
    } else {
      lines.push(
        `    NOT in ${where.project} / ${where.env} — cast can neither see nor manage it.`,
        "    Most likely residue from an earlier run cleaned up by deleting a Coolify",
        "    project: deleting a project does NOT delete its resources. They survive it,",
        "    invisible to cast (no project it queries holds them), still owning the domain",
        "    instance-wide. Find it by uuid in the Coolify UI.",
      );
    }
    lines.push("");
  }
  if (where.coolify) lines.push(`  Coolify said: ${where.coolify}`, "");
  lines.push(
    "Two fixes, and cast will take neither by itself: delete the resource that holds the",
    "domain, or give this one a different domain (the manifest, or --hostname-overlay).",
    "",
    "cast will NOT retry with force_domain_override=true — the flag Coolify's own message",
    "suggests. Two resources on one domain is a routing coin-flip, and the same response",
    'says so: "can cause routing conflicts and unpredictable behavior". If that is ever',
    "what you want it is an operator act, never something a tool does on your behalf.",
  );
  if (where.stage === "preflight") {
    lines.push(
      "",
      "Nothing was created: this ran before the first write, so the refusal costs nothing.",
    );
  } else {
    lines.push(
      "",
      "This arrived mid-apply — the project and its environment may already exist. Re-run",
      "once the conflict is gone: apply reads before it writes, and adopts them.",
    );
  }
  return lines.join("\n");
}

// Coolify's answer when a server has more than one destination and the create did
// not say which one to use (all three controllers, identically, v4.1.2):
//
//   POST /applications/private-github-app → 400:
//   {"message":"Server has multiple destinations and you do not set destination_uuid."}
//
// It names neither the remedy nor the file the remedy goes in, and it arrives at
// the FIRST create — after apply has already made the project and the environment.
// So the operator is holding a half-applied run and a message about a field they
// may never have heard of. (#41)
//
// cast cannot pre-flight this and that part is not fixable here: 4.1.2 serves no
// destinations API at all — not list, not read, not create — and GET /servers/{uuid}
// does not carry them either, so a server's destination COUNT is not knowable until
// a create has already been attempted. What IS fixable is the diagnosis, and this is
// the whole of it: catch the one message, and answer the question it raises.
function isMultiDestination400(err: unknown): err is HttpError {
  return (
    err instanceof HttpError &&
    err.status === 400 &&
    err.message.includes("Server has multiple destinations")
  );
}

export function multiDestinationRemedy(where: {
  server: string;
  env: string;
  project: string;
  resource: string;
  coolify: string;
}): string {
  return [
    `cannot create ${where.resource}: ${where.server} has multiple destinations, so a create must say which one to use.`,
    "",
    `  Coolify said: ${where.coolify}`,
    "",
    "Read the destination UUID from the Coolify UI (4.1.2 exposes no API for it) and",
    "declare it as:",
    "",
    `    environments.${where.env}.projects.${where.project}.destination_uuid`,
    "",
    "Placement is create-time — a resource cannot be moved between networks later, so a",
    "wrong or missing destination is repaired by delete + recreate, never by a later apply.",
    "",
    "Re-run this apply once the UUID is declared: anything it already created (the project,",
    "its environment) is adopted, not made twice — apply reads before it writes.",
  ].join("\n");
}

export function buildExecutor(
  client: CoolifyClient,
  ctx: {
    projectName: string;
    envName: string;
    serverUuid: string;
    githubAppUuid: string;
    // The three names the multi-destination 400 has to be able to say back, and
    // the only reason they are here: none of them is on the wire. A create sends
    // `serverUuid`, but the operator wrote a server NAME — and the UUID they now
    // have to go and read lands at `environments.<env>.projects.<org>/<repo>`, a
    // path keyed by cast's OWN env name and the repo, never by the Coolify
    // project/environment names above (which `--project`/`--environment` are free
    // to make something else entirely).
    serverName: string;
    orgRepo: string;
    bindingEnv: string;
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
    // The live resources of THIS project + environment, by uuid — everything cast
    // can see. Read by exactly one thing: the domain-conflict message, which has to
    // say whether the resource holding the domain is inside the applied project or
    // outside it, and must not guess (see domainConflictRemedy). Optional because an
    // executor built without it is not wrong, only less able to place a conflict:
    // an empty set says "cast sees nothing here", which is what a caller that did
    // not read the project is in fact claiming.
    visibleUuids?: ReadonlySet<string>;
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
  // Lazy, so a run with nothing to create touches neither route, and memoized,
  // so a run with five creates reconciles the project and its environment once
  // rather than five times.
  const projectEnv = projectEnvironmentResolver(
    client,
    ctx.projectName,
    ctx.envName,
  );
  // The body of a backup-schedule write, shared by the create and update paths
  // so the two cannot drift apart — the create path having been the only one
  // for so long is precisely how the update path came to not exist.
  //
  // `save_s3` + `s3_storage_uuid` are asserted on every write, not compared:
  // Coolify returns the storage as `s3_storage_id` (an int) and takes it as a
  // uuid, the same unmappable pair as destination_id (see Placement), so cast
  // can state its intent here but can never verify it afterwards. Declaring
  // `backup:` in a manifest means "backed up, to the environment's S3" — that
  // is what this writes, on create and on update alike.
  const backupBody = (
    label: string,
    schedule: { frequency: string; retention: number },
  ): Record<string, unknown> => {
    if (!ctx.s3DestinationUuid) {
      throw new Error(
        `database ${label} declares a backup schedule but environments.yaml has no s3_destination UUID for this environment`,
      );
    }
    return {
      frequency: schedule.frequency,
      database_backup_retention_amount_locally: schedule.retention,
      save_s3: true,
      s3_storage_uuid: ctx.s3DestinationUuid,
      // Asserted on every write. A schedule row that exists with enabled=false
      // backs nothing up, and a manifest that declares `backup:` is asking for
      // backups, not for a disabled row that looks like backups.
      enabled: true,
    };
  };
  // Make a database's live schedule match the manifest — the half of this that
  // did not exist. `apply` used to write a schedule ONLY inside the create
  // branch, so adding `backup:` to an already-live database produced a clean
  // run and zero backups; that is the defect (#51).
  //
  // POST creates, PATCH updates, and which one is right depends on a read — so
  // this reads first. When the read fails it RAISES rather than guessing: the
  // alternatives are POSTing (which duplicates the schedule if one was in fact
  // there) or skipping (which is the silent no-op being fixed). An apply that
  // promised to set a backup schedule and could not must say so and stop.
  const reconcileBackupSchedule = async (
    dbUuid: string,
    schedule: { frequency: string; retention: number },
  ): Promise<void> => {
    const body = backupBody(dbUuid, schedule);
    const existing = await client.databaseBackupSchedules(dbUuid);
    if (existing === undefined) {
      throw new Error(
        `database ${dbUuid}: cannot set the declared backup schedule — GET /databases/${dbUuid}/backups was unreachable or returned an unrecognized shape, so cast cannot tell whether a schedule already exists (creating one blindly would risk a duplicate). Set it in the Coolify UI, or re-run when the API is reachable.`,
      );
    }
    if (existing.length > 1) {
      throw new Error(
        `database ${dbUuid}: Coolify holds ${existing.length} backup schedules for this database and a manifest declares one — cast will not guess which to update. Resolve in the Coolify UI (runbook act).`,
      );
    }
    const current = existing[0];
    if (current) {
      await client.patch(`/databases/${dbUuid}/backups/${current.uuid}`, body);
      return;
    }
    await client.post(`/databases/${dbUuid}/backups`, body);
  };
  // Resolve any ${resource:<name>.url} still unresolved when apply is about to
  // write an env (#60). It can only still be unresolved on a from-nothing run:
  // runProject filled every ref whose database already existed at plan time, so
  // what is left is a database THIS apply created moments ago (apply acts
  // databases-before-applications, #45, so it exists by now). Read its URL back
  // from the same environment_details route `capture --generated-only` uses, and
  // key by name — a from-nothing box has no aliases, so the live name IS the
  // manifest name the ref carries.
  //
  // Refuses to write a ref that resolved to nothing: an empty DATABASE_URL boots
  // the app pointed at nothing, the exact fill fetchGeneratedSources forbids.
  // Coolify mints a database's credentials at CREATE time and internal_db_url is
  // a model accessor built from them (not from a running container), so the URL
  // is expected the moment the create returns. If a given Coolify build only
  // populates it once the container is up, this refuses with a re-run instruction
  // rather than writing a blank — and the re-run resolves it as an ordinary
  // update, because by then the database is live and the diff fills it.
  const resolveDerivedEnv = async (env: ResolvedEnv): Promise<ResolvedEnv> => {
    if (unresolvedDerived(env).length === 0) return env;
    const { sources } = await fetchGeneratedSources(
      client,
      ctx.projectName,
      ctx.envName,
    );
    const urls = Object.fromEntries(sources.map((s) => [s.resource, s.url]));
    const filled = fillDerivedEnv(env, urls);
    const missing = unresolvedDerived(filled);
    if (missing.length > 0) {
      throw new Error(
        [
          "cannot resolve derived env var(s) after creating the database:",
          ...missing.map((m) => `  ${m.key} — from database ${m.resource}`),
          "",
          "cast created the database this run, but Coolify has not published its",
          "internal URL yet (the resource may still be starting). Nothing was written",
          "— an empty URL would boot the app pointed at nothing. Re-run `cast apply`",
          "once the database is up; the second run resolves it as an ordinary update.",
        ].join("\n"),
      );
    }
    return filled;
  };
  // The two instance-wide constraints a create can die on, both of them invisible
  // from cast's project-scoped view, both of them arriving at the FIRST create —
  // after apply has already made the project and the environment. One wrapper, and
  // wrapped around all three creates rather than around each one: Coolify runs the
  // same destination logic in ApplicationsController, DatabasesController and
  // ServicesController, so whichever kind happens to be created first is the one
  // that 400s, and which one that is depends only on the order of the manifest.
  const withCreateDiagnosis = async (
    change: Change,
    create: () => Promise<string>,
  ): Promise<string> => {
    try {
      return await create();
    } catch (err) {
      // The domain-conflict 409 the pre-flight could not have caught: a conflict
      // with a Coolify SERVICE or with the instance fqdn (neither appears in
      // GET /applications, so preflightDomainConflicts is a strict subset of
      // Coolify's own check), or a resource created between the pre-flight and this
      // create. Rare by construction — and precisely because it is rare, it must not
      // be the one that arrives untranslated. (#44)
      const conflicts = domainConflicts409(err);
      if (conflicts) {
        throw new Error(
          domainConflictRemedy(
            conflicts.map((c) => ({
              ...c,
              wanted_by: `${change.kind} ${change.name}`,
            })),
            {
              project: ctx.projectName,
              env: ctx.envName,
              visible: ctx.visibleUuids ?? new Set(),
              stage: "apply",
              coolify: err instanceof Error ? err.message : String(err),
            },
          ),
          { cause: err },
        );
      }
      if (!isMultiDestination400(err)) throw err;
      throw new Error(
        multiDestinationRemedy({
          server: ctx.serverName,
          env: ctx.bindingEnv,
          project: ctx.orgRepo,
          resource: `${change.kind} ${change.name}`,
          coolify: err.message,
        }),
        { cause: err },
      );
    }
  };
  return {
    async createResource(change) {
      return withCreateDiagnosis(change, async () => {
        // Field payloads assembled from change.fieldDiffs (desired values):
        const fields = Object.fromEntries(
          change.fieldDiffs.map((f) => [f.field, f.desired]),
        );
        const projectUuid = await projectEnv();
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
          // A database that was created a moment ago provably has no schedule,
          // so this POSTs rather than going through reconcileBackupSchedule —
          // no read to do, and no read that could fail and abort a create.
          const schedule = desiredBackup(fields);
          if (schedule) {
            await client.post(
              `/databases/${res.uuid}/backups`,
              backupBody(change.name, schedule),
            );
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
      });
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
      // A backup-only drift strips to an empty body (databaseApiFields drops
      // `backup`, which belongs to another route) — and PATCHing a database
      // with `{}` is a write that says nothing. Skip it; the schedule below is
      // the actual change.
      if (Object.keys(apiFields).length > 0) {
        await client.patch(`/${base}/${uuid}`, apiFields);
      }
      // The declared schedule is applied on UPDATE, not only on create. This is
      // what makes adding `backup:` to an existing database do what every reader
      // of that manifest already assumes it does (#51).
      if (kind === "database") {
        const schedule = desiredBackup(fields);
        if (schedule) await reconcileBackupSchedule(uuid, schedule);
      }
    },
    async syncEnv(uuid, kind, env) {
      // Fill any ${resource:<name>.url} still carrying the unresolved sentinel
      // before anything is written — the from-nothing case, where the database
      // was created earlier in this same apply (#60). A no-op read-wise for an
      // env with no derived vars (the common case), and for one already resolved
      // at plan time.
      const resolved = await resolveDerivedEnv(env);
      // The reserved-name rule at the wire (reserved.ts). Nothing can reach here
      // carrying one — resolve.ts refuses the manifest long before a diff, let
      // alone an apply — and the check is here anyway, because this is the single
      // function in cast that puts an env var on a Coolify resource, and the
      // invariant being protected is exactly "cast never writes one". A future
      // caller of buildExecutor will not have read resolve.ts; the guard it needs
      // is the one standing where the write happens.
      assertNoReservedEnvNames(
        reservedHits(`${kind} ${uuid}`, Object.keys(resolved.vars)),
      );
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
        data: Object.entries(resolved.vars).map(([key, v]) => ({
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
