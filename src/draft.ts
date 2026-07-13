import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { GENERATED_PLACEHOLDER } from "./capture.js";
import { encryptSecrets } from "./secrets.js";

// `inventory` can already SEE a whole instance (#22). This is it writing down
// what it saw, in the shape of cast's own inputs — a manifest per project, an
// env template per resource, a bindings file with the registry, an age store,
// and UNCAPTURED.md.
//
// The verb is only allowed to exist because of one boundary, and everything in
// this file is bent around it:
//
//   **A draft is a PROPOSAL. It is never desired state, and `apply` never
//   reads it.**
//
//   sweep → emit draft → a human reads it → manifest PR → capture → apply
//
// Same shape as `terraform import` → HCL. It is emitted, reviewed, and lands in
// a product repo as a PR; the repo stays the source of truth. Which is why a
// draft is NEVER emitted into a repo that already has a manifest: for a declared
// project the manifest *is* the truth, and regenerating it from a live box would
// let that box's accumulated cruft overwrite the reviewed spec, silently, in the
// one direction nobody reviews. Adoption is one-way.
//
// Two things would make a draft actively dangerous, and they are the two things
// this file spends its length on:
//
// 1. COPIED PROVIDER-GENERATED VALUES. A `DATABASE_URL` read off the source
//    points at the SOURCE box's Postgres. Emit it, rebuild elsewhere, and the
//    new box comes up WORKING — reading and writing the old box's database. You
//    find out the day the old box is deleted. So the draft applies `capture`'s
//    discipline (see classify): a provider-generated name is placeheld with the
//    same `pending-coolify-generated` literal and listed for disposition, and
//    the source's value is not written anywhere. A draft that is confidently
//    wrong in four entries out of seventeen is worse than one that is obviously
//    incomplete.
//
// 2. SILENT LOSSES. cast cannot express everything a Coolify holds — service
//    hostnames, destinations (#21), Basic Auth, build toggles, whole database
//    kinds. A blueprint that omits them WITHOUT SAYING SO is worse than no
//    blueprint, because in a disaster you would trust it and rebuild a
//    *different box*. Hence UNCAPTURED.md, which is emitted on every run, even
//    when it has little to say.

// --- Provider-generated names -------------------------------------------------
//
// The single most consequential judgment in this file, and it is made by NAME —
// never by value, and never by "it looks like a URL".
//
// Two families:
//
//   1. Coolify's own magic vars. `SERVICE_FQDN_*`, `SERVICE_URL_*`,
//      `SERVICE_PASSWORD_*`, `SERVICE_USER_*`, `SERVICE_BASE64_*` are generated
//      per-instance by Coolify when it creates a service, and mean nothing
//      anywhere else — a `SERVICE_PASSWORD_UMAMI` carried to a new box is the
//      OLD box's password, sitting in the new box's config next to a database
//      that has a different one.
//
//   2. Connection coordinates for a datastore the PROVIDER creates. A name that
//      carries both a datastore word (DATABASE, POSTGRES, REDIS, …) and a
//      connection word (URL, HOST, PASSWORD, …) as segments — `DATABASE_URL`,
//      `UMAMI_DATABASE_URL`, `REDIS_URL_PROD`, `DB_HOST`. Coolify mints these
//      when it creates the resource; the target's real value does not exist
//      until it does.
//
// Deliberately erring WIDE. The two errors are not symmetric:
//
//   - Over-match a name that was really a secret: it is placeheld, listed in
//     UNCAPTURED.md for disposition, and the operator puts the value back. The
//     source box is still there. Noisy, recoverable, LOUD.
//   - Under-match one that was really provider-generated: it is copied, the
//     rebuilt box boots working against the old box's database, and nobody finds
//     out until the old box is deleted. Silent, unrecoverable, QUIET.
//
// A name-pattern rule is not a promise, and the docs say so: a var that points
// at the source box under a name cast does not recognize WILL be copied. That is
// what the disposition table printed at the end of a run is for — read it.
const COOLIFY_MAGIC =
  /^SERVICE_(FQDN|URL|USER|PASSWORD|BASE64|REALBASE64)(_|$)/;

const DATASTORE_WORDS = new Set([
  "DATABASE",
  "DB",
  "POSTGRES",
  "POSTGRESQL",
  "PG",
  "MYSQL",
  "MARIADB",
  "MONGO",
  "MONGODB",
  "REDIS",
  "VALKEY",
  "KEYDB",
  "DRAGONFLY",
  "CLICKHOUSE",
]);

const CONNECTION_WORDS = new Set([
  "URL",
  "URI",
  "DSN",
  "HOST",
  "HOSTNAME",
  "PORT",
  "PASSWORD",
  "PASS",
  "USER",
  "USERNAME",
]);

export function isProviderGenerated(key: string): boolean {
  if (COOLIFY_MAGIC.test(key)) return true;
  const words = key.split("_");
  return (
    words.some((w) => DATASTORE_WORDS.has(w)) &&
    words.some((w) => CONNECTION_WORDS.has(w))
  );
}

// --- Names -------------------------------------------------------------------

// A box names things for a human reading a UI ("La Familia Site", "Incubator
// Stack v2"); a repo path and an age-store key cannot hold that. Slugs are used
// for PATHS only — the manifest keeps the box's own name as the resource key,
// because a draft that renamed everything to our vocabulary and never mentioned
// theirs would be unusable against the UI it describes (see inventory.ts).
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unnamed"
  );
}

const constCase = (name: string) => slug(name).toUpperCase().replace(/-/g, "_");

// `<org>/<repo>` out of whatever Coolify recorded as the app's git remote — the
// only place on a live box that knows which REPO a project belongs to, and the
// registry (#25) is keyed by exactly that.
//
// Three shapes, all real: Coolify stores a bare `org/repo` for an application
// created through a GitHub App (the shape `apply` itself posts), and a full URL —
// https or scp-style — for a public one. The last two segments are the answer in
// every case; anything with no `/` in it at all is not a repo, and gets
// `undefined` rather than a guess.
export function repoFromGitUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  const m = raw
    .trim()
    .replace(/\.git$/, "")
    .match(/([^/:\s]+)\/([^/\s]+)$/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

// A cast env template's grammar is `KEY=value` with KEY matching this (see
// parseTemplate in envtemplate.ts — ONE grammar, shared by every reader). A live
// var whose key does not match cannot be written into a template at all, so it
// is not silently dropped: it is listed in UNCAPTURED.md.
const TEMPLATE_KEY = /^[A-Z][A-Z0-9_]*$/;

// --- Inputs ------------------------------------------------------------------

export type DraftResourceKind = "application" | "database" | "service";

export type DraftResource = {
  kind: DraftResourceKind;
  // The BOX's name for it. There is no other.
  name: string;
  uuid: string;
  // The live Coolify object, as it came off the wire. Kept whole, because the
  // uncaptured pass's whole job is to notice fields cast has no home for — and
  // it cannot notice what a projection already threw away.
  raw: Record<string, unknown>;
  // Live env vars. Empty for databases (their URL is what the apps reference,
  // and that name is generated, not captured).
  env: Record<string, string>;
};

export type DraftProject = {
  // The Coolify project's own name.
  name: string;
  // The BOX's environment the resources below were read from.
  coolifyEnv: string;
  resources: DraftResource[];
  // Resources of a kind cast cannot model AT ALL (a MySQL, a MongoDB): seen,
  // named, and left out — the loudest possible silent loss if it went unsaid.
  unreadable: Array<{ kind: string; name: string }>;
  // Environments on this project that this draft does NOT carry.
  otherEnvironments: Array<{ name: string; resources: number }>;
  // Why nothing was drafted from this project. A project the draft passes over
  // gets no manifest and no registry entry — and an entry in UNCAPTURED.md
  // saying so, because a reader who takes this draft for "the box" would
  // otherwise never learn the project was there. (The sweep printed it; a file
  // on disk outlives a terminal.)
  skipReason?: string;
};

// The live environment document, split into what cast can model and what it
// cannot. `fetchLive` maps the same response, but through a projection — and the
// uncaptured pass cannot notice a field a projection has already discarded, so
// the draft reads the RAW document instead.
//
// The `unreadable` half is the point. Coolify's environment_details eager-loads
// mysqls, mariadbs, mongodbs, keydbs, dragonflies and clickhouses too
// (ProjectController@environment_details, v4.1.2); cast's manifest speaks
// postgresql and redis only. A MySQL on the box is therefore invisible to every
// other verb — and a blueprint that quietly leaves out a database is the exact
// artifact that gets someone to rebuild a box and only later find out what is
// missing from it. So it is read, named, and reported as inexpressible.
const KIND_OF: Array<[string, DraftResourceKind]> = [
  ["applications", "application"],
  ["postgresqls", "database"],
  ["redis", "database"],
  ["services", "service"],
];

const UNREADABLE_KINDS = [
  "mysqls",
  "mariadbs",
  "mongodbs",
  "keydbs",
  "dragonflies",
  "clickhouses",
];

export function draftResourcesFrom(env: Record<string, unknown>): {
  resources: DraftResource[];
  unreadable: Array<{ kind: string; name: string }>;
} {
  const resources: DraftResource[] = [];
  for (const [field, kind] of KIND_OF) {
    const items = env[field];
    if (!Array.isArray(items)) continue;
    for (const raw of items as Array<Record<string, unknown>>) {
      resources.push({
        kind,
        name: String(raw.name),
        uuid: String(raw.uuid),
        raw,
        env: {},
      });
    }
  }
  const unreadable: Array<{ kind: string; name: string }> = [];
  for (const field of UNREADABLE_KINDS) {
    const items = env[field];
    if (!Array.isArray(items)) continue;
    for (const raw of items as Array<Record<string, unknown>>) {
      unreadable.push({
        kind: field.replace(/s$/, ""),
        name: String(raw.name),
      });
    }
  }
  return { resources, unreadable };
}

export type DraftContext = {
  // OUR environment name (--env): the key every emitted artifact is filed under.
  env: string;
  instance: string;
  baseUrl: string;
  team: { id: number; name: string };
  server?: string;
  // The GitHub Apps configured on the instance, by name. NOT a property of any
  // resource: nothing Coolify returns about an application says which App clones
  // it. With exactly one on the instance there is no other it could be, and cast
  // binds every repo to it; with none or several it writes a REVIEW marker
  // instead of picking. See bindingsDoc.
  githubApps?: string[];
  recipient?: string;
  generatedAt: string;
};

export type Provenance = "captured" | "generated";

export type DraftDisposition = {
  project: string;
  ref: string;
  provenance: Provenance;
  sites: string[];
  // Never rendered. Held so emitDraft can encrypt it, and nowhere else.
  value: string;
};

export type UncapturedItem = {
  project: string;
  resource?: string;
  setting: string;
  detail: string;
};

export type DraftFile = { path: string; content: string };

export type DraftPlan = {
  files: DraftFile[];
  // project slug -> the age store's contents. Kept out of `files` because it is
  // the one artifact that is not text on the way out.
  stores: Array<{
    project: string;
    path: string;
    vars: Record<string, string>;
  }>;
  dispositions: DraftDisposition[];
  uncaptured: UncapturedItem[];
};

// --- Headers -----------------------------------------------------------------
//
// Every emitted file says what it is, in its own body. The artifacts leave this
// process and are read by a person deciding whether to TRUST them — as a
// blueprint of a box they may have to rebuild — and a file that does not say it
// was machine-generated from a live box will be read as if someone meant it.

function header(
  ctx: DraftContext,
  lines: string[],
  // UNCAPTURED.md carries the same header, minus the line telling you to go and
  // read UNCAPTURED.md. It IS the thing being pointed at.
  opts: { self?: boolean } = {},
): string[] {
  return [
    "PROPOSAL — not desired state. `apply` does not read this file.",
    "",
    "Machine-generated by `cast inventory --emit-draft` from a LIVE box:",
    `  instance:   ${ctx.instance} (${ctx.baseUrl})`,
    `  team:       ${ctx.team.id} (${ctx.team.name})`,
    `  generated:  ${ctx.generatedAt}`,
    "",
    ...lines,
    "",
    "Everything a box accumulates that nobody meant — a hand-edited var, a resource",
    "somebody made once — is in here too. Review it, decide what should be declared",
    "and what is cruft that must not travel, and land it as a PR. Then: capture → apply.",
    ...(opts.self
      ? []
      : [
          "",
          "Read UNCAPTURED.md first: it lists what cast SAW on this box and could not",
          "express. A blueprint that omits things without saying so is worse than none.",
        ]),
  ];
}

const comment = (lines: string[]) =>
  lines.map((l) => (l ? `# ${l}` : "#")).join("\n");

// --- The manifest ------------------------------------------------------------

const PACKS = new Set(["nixpacks", "static", "dockerfile", "dockercompose"]);

type Spec = Record<string, unknown>;

function applicationSpec(
  r: DraftResource,
  ctx: DraftContext,
  project: string,
  hasEnv: boolean,
  uncaptured: UncapturedItem[],
): Spec | undefined {
  const flag = (setting: string, detail: string) =>
    uncaptured.push({ project, resource: r.name, setting, detail });

  const pack = String(r.raw.build_pack ?? "");
  if (!PACKS.has(pack)) {
    // NOT "pick the closest pack". An application cast's manifest cannot express
    // is left OUT of the manifest and named here — a fabricated build pack would
    // rebuild a different application, which is the exact failure UNCAPTURED.md
    // exists to prevent, dressed up as coverage.
    flag(
      "the whole application",
      `build pack "${pack || "(none)"}" — cast's manifest supports ${[...PACKS].join(", ")}. This application is NOT in the draft; it cannot be expressed, and guessing a pack would rebuild a different app. Its env vars WERE read, and are in the store and an env template beside it — the values are not lost, only the structure.`,
    );
    return undefined;
  }

  const repo = repoFromGitUrl(r.raw.git_repository);
  if (!repo) {
    flag(
      "source.repo",
      `git remote "${String(r.raw.git_repository ?? "")}" — cast could not read an <org>/<repo> out of it, and wrote it through verbatim. \`apply\` resolves a GitHub App by that slug; fix it before you trust this.`,
    );
  }
  const branch = r.raw.git_branch;
  if (typeof branch !== "string" || branch === "") {
    flag(
      "source.branch",
      "the box reports no branch for this application. `main` was written; confirm it.",
    );
  }

  const compose = pack === "dockercompose";
  const fqdn = String(r.raw.fqdn ?? "")
    .split(",")
    .filter(Boolean);
  if (compose && fqdn.length > 0) {
    flag(
      "domains",
      `the box has a flat fqdn (${fqdn.join(", ")}) on this compose application; a compose app's hostnames are expressed per-container (service_domains) and cast cannot map one onto the other.`,
    );
  }
  if (!compose && fqdn.length === 0) {
    flag(
      "domains",
      "no hostname is set on this application; `domains: []` was written, which `apply` would create it with — a rebuilt box would serve nothing here.",
    );
  }

  // Real settings, present on the live object, that the manifest has no field
  // for. Each one changes what the application IS, and each would be silently
  // absent from a rebuild.
  const NO_HOME: Array<[string, string]> = [
    ["custom_labels", "custom Traefik/Docker labels (Basic Auth lives here)"],
    ["ports_mappings", "host port mappings"],
    ["install_command", "a custom install command"],
    ["build_command", "a custom build command"],
    ["start_command", "a custom start command"],
    ["pre_deployment_command", "a pre-deployment command"],
    ["post_deployment_command", "a post-deployment command"],
    ["dockerfile", "an inline Dockerfile"],
    ["dockerfile_location", "a non-default Dockerfile location"],
    ["watch_paths", "watch paths (which changes trigger a deploy)"],
    ["redirect", "a www/non-www redirect policy"],
  ];
  for (const [field, what] of NO_HOME) {
    const v = r.raw[field];
    if (v === undefined || v === null || v === "") continue;
    flag(field, `${what} is set on the box. The manifest has no field for it.`);
  }

  // `port` is one number in a manifest and a comma-separated list on the wire.
  // The draft writes the first and says so — a rebuilt app exposing one of the
  // three ports it used to is the kind of difference that surfaces as a broken
  // healthcheck weeks later.
  const exposed = String(r.raw.ports_exposes ?? "")
    .split(",")
    .filter(Boolean);
  if (exposed.length > 1) {
    flag(
      "port",
      `the box exposes ${exposed.join(", ")}; a manifest declares ONE port, so only ${exposed[0]} is in the draft.`,
    );
  }

  return {
    source: {
      repo: repo ?? String(r.raw.git_repository ?? ""),
      branch: typeof branch === "string" && branch ? branch : "main",
    },
    build: {
      pack,
      base_directory: String(r.raw.base_directory ?? "/"),
      ...(compose
        ? {
            compose_file: String(
              r.raw.docker_compose_location ?? "/docker-compose.yaml",
            ),
          }
        : {}),
      ...(!compose && r.raw.publish_directory
        ? { publish_directory: String(r.raw.publish_directory) }
        : {}),
    },
    ...(compose
      ? {}
      : {
          ...(r.raw.ports_exposes
            ? { port: Number(String(r.raw.ports_exposes).split(",")[0]) }
            : {}),
          ...(r.raw.health_check_path
            ? { healthcheck: String(r.raw.health_check_path) }
            : {}),
          domains: fqdn,
        }),
    ...(compose
      ? { service_domains: composeDomains(r, project, uncaptured) }
      : {}),
    ...(hasEnv
      ? { env_template: `env/${slug(r.name)}.${ctx.env}.env.template` }
      : {}),
  };
}

function composeDomains(
  r: DraftResource,
  project: string,
  uncaptured: UncapturedItem[],
): Record<string, string[]> {
  const raw = r.raw.docker_compose_domains;
  const map: Record<string, string[]> = {};
  if (typeof raw === "string" && raw !== "") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const e of parsed) {
          const name = (e as { name?: unknown })?.name;
          const domain = (e as { domain?: unknown })?.domain;
          if (typeof name === "string" && typeof domain === "string") {
            map[name] = domain.split(",").filter(Boolean);
          }
        }
      }
    } catch {
      // Unreadable, not absent. Say so rather than write {} and move on.
    }
  }
  if (Object.keys(map).length === 0) {
    uncaptured.push({
      project,
      resource: r.name,
      setting: "service_domains",
      detail:
        "this compose application exposes no readable per-container domains; `service_domains: {}` was written. A rebuilt stack would serve no hostnames until they are declared.",
    });
  }
  return map;
}

function databaseSpec(
  r: DraftResource,
  project: string,
  uncaptured: UncapturedItem[],
): Spec {
  const flag = (setting: string, detail: string) =>
    uncaptured.push({ project, resource: r.name, setting, detail });
  const rawType = String(r.raw.database_type ?? r.raw.type ?? "");
  const type =
    rawType === "standalone-postgresql"
      ? "postgresql"
      : rawType === "standalone-redis"
        ? "redis"
        : rawType;
  const image = typeof r.raw.image === "string" ? r.raw.image : undefined;
  const version = image?.split(":")[1]?.match(/^(\d+(?:\.\d+)*)/)?.[1];
  if (image && !version) {
    flag(
      "version",
      `image "${image}" — no version could be read from its tag, so none was written and \`apply\` would create this database on Coolify's default image.`,
    );
  }
  // Coolify exposes no backup schedule on a database's GET, so a `backup:` block
  // cannot be recovered. It is create-time-only in cast (see README's known
  // limitations), so a rebuild from this draft would come up with NO BACKUPS —
  // the quietest possible loss, and the one you discover at the worst moment.
  flag(
    "backup",
    "backup schedules are not exposed by Coolify's API and are NOT in this draft. If this database is backed up, a rebuild from here would not be. Check the Coolify UI (Backups tab) and declare `backup: { frequency, retention }` yourself.",
  );
  return { type, ...(version ? { version } : {}) };
}

function serviceSpec(
  r: DraftResource,
  ctx: DraftContext,
  project: string,
  hasEnv: boolean,
  uncaptured: UncapturedItem[],
): Spec {
  // Coolify 4.1.2's Service model carries no flat `domains` — hostnames live
  // per-container on `service.applications[].fqdn`, which no endpoint cast uses
  // returns (see projectLiveFields / serviceApiFields in cli.ts, and
  // desiredFromManifest's warning). Not readable, not writable, not in the
  // draft: a service that serves a hostname today would come back serving none.
  uncaptured.push({
    project,
    resource: r.name,
    setting: "domains (hostnames)",
    detail:
      "Coolify 4.1.2 exposes no flat `domains` on a service — hostnames live per-container on service.applications[].fqdn, which cast can neither read nor write. Whatever hostnames this service answers on are NOT in this draft. Read them off the Coolify UI and set them there after a rebuild.",
  });
  return {
    type: String(r.raw.service_type ?? r.raw.type ?? ""),
    ...(hasEnv
      ? { env_template: `env/${slug(r.name)}.${ctx.env}.env.template` }
      : {}),
  };
}

// --- Secrets -----------------------------------------------------------------
//
// Every live var becomes a `${REF}` in the template, and its value goes to the
// age store. NOTHING is written as a template literal.
//
// That is a deliberate one-way bet. cast cannot know which of a box's vars are
// secret — nobody wrote it down, which is why this verb exists — and the two
// mistakes are not symmetric: a non-secret in the encrypted store is untidy, and
// a live API key written as a literal into a manifest is a key in a git repo.
// So: no heuristic decides where a VALUE goes. Only where a NAME goes (see
// isProviderGenerated), and that decision withholds the value rather than
// publishing it.
function planSecrets(
  p: DraftProject,
  uncaptured: UncapturedItem[],
): {
  // resource name -> [KEY, ref][]
  templates: Map<string, Array<[string, string]>>;
  dispositions: DraftDisposition[];
  generated: string[];
} {
  const templates = new Map<string, Array<[string, string]>>();
  // key -> sites, and the distinct values seen for it across the project
  const byKey = new Map<string, Array<{ resource: string; value: string }>>();

  for (const r of p.resources) {
    const usable: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(r.env)) {
      if (!TEMPLATE_KEY.test(key)) {
        // A cast template cannot hold this name at all — one grammar, shared by
        // every reader of a template (envtemplate.ts). Dropping it quietly would
        // rebuild the resource without a var it has today.
        uncaptured.push({
          project: p.name,
          resource: r.name,
          setting: `env var ${key}`,
          detail: `this box sets an env var named "${key}", which is not a name a cast env template can express (KEY must match ${TEMPLATE_KEY.source}). It is NOT in this draft.`,
        });
        continue;
      }
      const sites = byKey.get(key) ?? [];
      sites.push({ resource: r.name, value });
      byKey.set(key, sites);
      usable.push([key, ""]);
    }
    if (usable.length > 0) templates.set(r.name, usable);
  }

  const dispositions: DraftDisposition[] = [];
  const generated: string[] = [];
  const refOf = new Map<string, string>(); // `${resource}::${key}` -> ref

  for (const [key, sites] of byKey) {
    const provenance: Provenance = isProviderGenerated(key)
      ? "generated"
      : "captured";
    // A provider-generated name is placeheld everywhere it appears, so two
    // resources disagreeing about its value is not a conflict cast has to
    // resolve — neither value is being carried.
    const distinct = new Set(sites.map((s) => s.value));
    const split = provenance === "captured" && distinct.size > 1;
    if (split) {
      // The store holds ONE value per name (see classify's CONFLICT refusal), and
      // this key carries two. cast will not pick — so it does not: each site gets
      // its own ref, both values survive, and the reviewer collapses them if they
      // were meant to be the same thing.
      uncaptured.push({
        project: p.name,
        setting: `env var ${key}`,
        detail: `${sites.map((s) => `"${s.resource}"`).join(" and ")} each set ${key}, to DIFFERENT values. One store holds one value per name, so cast split them into ${sites.map((s) => `${constCase(s.resource)}_${key}`).join(" and ")} rather than pick. Collapse them if they were meant to be one.`,
      });
    }
    for (const s of sites) {
      const ref = split ? `${constCase(s.resource)}_${key}` : key;
      refOf.set(`${s.resource}::${key}`, ref);
      if (!split && dispositions.some((d) => d.ref === ref)) {
        // Same ref, same value, second site: record the site, not a second entry.
        const d = dispositions.find((x) => x.ref === ref);
        d?.sites.push(`${s.resource}.${key}`);
        continue;
      }
      dispositions.push({
        project: p.name,
        ref,
        provenance,
        sites: [`${s.resource}.${key}`],
        // THE line this whole file is bent around: a provider-generated name is
        // placeheld with the same literal `capture` writes, and the source box's
        // value is not written anywhere — not into a template, not into a store,
        // not into a log.
        value: provenance === "generated" ? GENERATED_PLACEHOLDER : s.value,
      });
      if (provenance === "generated" && !generated.includes(ref))
        generated.push(ref);
    }
  }

  for (const [resource, pairs] of templates) {
    templates.set(
      resource,
      pairs.map(([key]) => [key, refOf.get(`${resource}::${key}`) ?? key]),
    );
  }
  return { templates, dispositions, generated: generated.sort() };
}

// --- Uncaptured, the parts that are not per-resource ---------------------------

function placementItems(p: DraftProject, uncaptured: UncapturedItem[]): void {
  const ids = new Set(
    p.resources
      .map((r) => r.raw.destination_id)
      .filter((v): v is number => typeof v === "number"),
  );
  if (ids.size === 0) return;
  // #21: `destination_id` is the ONLY thing Coolify tells us about placement —
  // an integer primary key. `destination_uuid:` (the binding `apply` needs) takes
  // the UUID, and Coolify 4.1.2 has no destinations API at all, so cast cannot
  // resolve one to the other. On a server with one destination this is inert; on
  // a server with two — which is exactly the box you are draining — it decides
  // which Docker network a resource can reach, and getting it wrong builds a
  // stack whose app cannot see its own database.
  uncaptured.push({
    project: p.name,
    setting: "destination (Docker network)",
    detail: `these resources sit on destination_id ${[...ids].sort().join(", ")}${ids.size > 1 ? " — MORE THAN ONE, so this project is split across Docker networks" : ""}. cast cannot turn that integer into the UUID \`environments.<env>.projects.<repo>.destination_uuid\` needs: Coolify 4.1.2 has no destinations API (see reference/README.md). Read the UUID off the Coolify UI and bind it yourself, or a rebuild lands on whichever network Coolify picks first.`,
  });
}

const NO_API_COVERAGE: Array<[string, string]> = [
  [
    "destinations",
    "Coolify 4.1.2 serves no destinations endpoint. A resource's `destination_id` comes back; the UUID that names it never does. Placement must be read from the UI (#21).",
  ],
  [
    "service hostnames",
    "no flat `domains` on a service — they live per-container on `service.applications[].fqdn`, which cast can neither read nor write (Coolify 4.1.2).",
  ],
  [
    "Basic Auth / custom Traefik labels",
    "carried as raw container labels. cast's manifest has no field for them, so a rebuilt resource is UNPROTECTED where the original was not.",
  ],
  [
    '"Include Source Commit in Build"',
    "and its neighbours on a resource's Settings tab: no API coverage in 4.1.2, and not returned by the endpoints cast reads.",
  ],
  [
    "backup schedules",
    "a database's backup config is not exposed on its GET. A rebuild from this draft has NO backups until you declare them.",
  ],
  [
    "database kinds cast does not model",
    "MySQL, MariaDB, MongoDB, KeyDB, Dragonfly, ClickHouse. cast's manifest speaks postgresql and redis only; any of the others found on the box are named above and are NOT in this draft.",
  ],
  [
    "which GitHub App clones a repo",
    "nothing Coolify returns about an application says so. cast binds every repo to the instance's only App when there is exactly one, and writes a REVIEW marker when there is not.",
  ],
  [
    "anything configured in the UI with no manifest field",
    "this list is what cast KNOWS it cannot express. It is not a proof that nothing else is missing.",
  ],
];

// The table that stops "rebuild from the repo" being over-claimed. Two of these
// six rows are `❌`, and they are the two that decide whether a DR runbook is
// true: they are not in the repo (correctly — it holds no live credentials) and
// they cannot be regenerated from it.
const CANNOT_RESTORE: Array<[string, string]> = [
  ["control plane", "`rig coolify install` ✅"],
  ["structure", "this draft → a manifest PR → `apply` ✅"],
  ["secret **values**", "the age store + your key ✅"],
  ["**data**", "Coolify's DB backups → S3 ✅ (a separate path — not this one)"],
  [
    "**the GitHub App private key**",
    "❌ re-create by hand. It is not in the repo and cannot be regenerated from it.",
  ],
  [
    "**S3 access keys**",
    "❌ re-mint by hand. Same reason: the repo holds no live credentials.",
  ],
];

export function renderUncaptured(
  items: UncapturedItem[],
  projects: DraftProject[],
  ctx: DraftContext,
): string {
  const lines = [
    "# UNCAPTURED — what this draft does NOT carry",
    "",
    // Fenced, not quoted: the header is aligned text, and a markdown blockquote
    // would reflow it into one paragraph.
    "```",
    ...header(
      ctx,
      ["This file is the reason the draft beside it is allowed to exist."],
      { self: true },
    ),
    "```",
    "",
    "cast cannot express everything a Coolify holds. A blueprint that omits those",
    "things **without saying so** is worse than no blueprint at all — in a disaster",
    "you would trust it, rebuild from it, and get a *different box*, without ever",
    "being told. So everything cast saw on this instance and could not write down is",
    "listed here, by resource. Nothing on this page is in the draft.",
    "",
    "## Seen on this box, not in the draft",
    "",
  ];

  if (items.length === 0) {
    lines.push(
      "Nothing — cast expressed every setting it could see on every resource it",
      "drafted. That is a statement about what cast can SEE (the sections below say",
      "what it cannot), not a clean bill of health.",
      "",
    );
  }

  for (const p of projects) {
    const mine = items.filter((i) => i.project === p.name);
    if (mine.length === 0) continue;
    lines.push(`### ${p.name}  —  Coolify environment \`${p.coolifyEnv}\``, "");
    const projectWide = mine.filter((i) => !i.resource);
    for (const i of projectWide) {
      lines.push(`- **${i.setting}** — ${i.detail}`);
    }
    if (projectWide.length > 0) lines.push("");
    const resources = [...new Set(mine.map((i) => i.resource))].filter(
      (r): r is string => r !== undefined,
    );
    for (const resource of resources) {
      lines.push(`**${resource}**`, "");
      for (const i of mine.filter((x) => x.resource === resource)) {
        lines.push(`- \`${i.setting}\` — ${i.detail}`);
      }
      lines.push("");
    }
    if (p.otherEnvironments.length > 0) {
      lines.push(
        `- **other environments** — this project also has ${p.otherEnvironments
          .map((e) => `\`${e.name}\` (${e.resources} resource(s))`)
          .join(
            ", ",
          )} on the box. This draft carries \`${p.coolifyEnv}\` only.`,
        "",
      );
    }
  }

  lines.push(
    "## Cannot be seen at all — no API coverage in Coolify 4.1.2",
    "",
    "Not gaps in this draft: gaps in the API it was read through. Nothing cast can",
    "do would recover these, so a rebuild must set them by hand.",
    "",
    "| setting | why |",
    "| --- | --- |",
    ...NO_API_COVERAGE.map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "## What a rebuild from this draft still cannot restore",
    "",
    "| | |",
    "| --- | --- |",
    ...CANNOT_RESTORE.map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "The last two rows are the ones a DR runbook has to say out loud. They are not",
    "in the state repo — correctly, it holds no live credentials — and they cannot be",
    "regenerated from it. Re-create them by hand, and expect to.",
    "",
    "## How values were treated",
    "",
    "Every live env var in this draft became a `${REF}` in a template, with its",
    "value in the age store — never a literal in a committed file. Names that look",
    "**provider-generated** (Coolify's `SERVICE_*` magic vars; anything carrying a",
    "datastore word and a connection word, like `DATABASE_URL` or `DB_HOST`) were",
    `**placeheld** with \`${GENERATED_PLACEHOLDER}\` and their live values were NOT`,
    "read into any artifact: a `DATABASE_URL` copied off this box points at THIS",
    "box's Postgres, and a rebuilt box carrying it would come up *working*, reading",
    "and writing the old box's database — until the day the old box is deleted.",
    "",
    "That rule is by NAME. A var that points at this box under a name cast does not",
    "recognize **will have been copied**. The disposition table printed at the end of",
    "the run is the list to read.",
    "",
  );
  return lines.join("\n");
}

// --- The plan ----------------------------------------------------------------

export function planDraft(
  projects: DraftProject[],
  ctx: DraftContext,
): DraftPlan {
  const files: DraftFile[] = [];
  const stores: DraftPlan["stores"] = [];
  const dispositions: DraftDisposition[] = [];
  const uncaptured: UncapturedItem[] = [];

  for (const p of projects) {
    const dir = projectDir(p);
    for (const u of p.unreadable) {
      uncaptured.push({
        project: p.name,
        resource: u.name,
        setting: "the whole resource",
        detail: `a ${u.kind} — cast's manifest speaks postgresql and redis only. It is NOT in this draft, and a rebuild from here would not have it.`,
      });
    }
    // Nothing to express: no manifest, no store, and NO REGISTRY ENTRY — a
    // registry that claimed a project this draft carries nothing for would send
    // every future fleet run at a project with no manifest to run against. It is
    // still named, in UNCAPTURED.md, because it is on the box.
    if (p.resources.length === 0) {
      uncaptured.push({
        project: p.name,
        setting: "the whole project",
        detail: `nothing was drafted from it: ${p.skipReason ?? "it has no resources cast can express"}. It EXISTS on this box${p.otherEnvironments.length > 0 ? "" : " and is not in this draft"}.`,
      });
      continue;
    }
    placementItems(p, uncaptured);

    const secrets = planSecrets(p, uncaptured);
    dispositions.push(...secrets.dispositions);

    const applications: Record<string, Spec> = {};
    const databases: Record<string, Spec> = {};
    const services: Record<string, Spec> = {};
    for (const r of p.resources) {
      const hasEnv = secrets.templates.has(r.name);
      if (r.kind === "application") {
        const spec = applicationSpec(r, ctx, p.name, hasEnv, uncaptured);
        if (spec) applications[r.name] = spec;
      } else if (r.kind === "database") {
        databases[r.name] = databaseSpec(r, p.name, uncaptured);
      } else {
        services[r.name] = serviceSpec(r, ctx, p.name, hasEnv, uncaptured);
      }
    }

    const manifest = {
      // The BOX's project name, not a slug: it is what `--project` takes, and the
      // one string that connects this file to the UI it was read from.
      project: p.name,
      environments: {
        [ctx.env]: {
          applications,
          ...(Object.keys(databases).length > 0 ? { databases } : {}),
          ...(Object.keys(services).length > 0 ? { services } : {}),
          ...(secrets.generated.length > 0
            ? { generated_secrets: secrets.generated }
            : {}),
        },
      },
    };
    files.push({
      path: join(dir, ".infra", "manifest.yaml"),
      content: `${comment(
        header(ctx, [
          `  project:    "${p.name}"`,
          `  environment: "${p.coolifyEnv}" on the box  →  filed here under \`${ctx.env}\`, YOUR name for it`,
          "",
          "Resources keep the names the BOX gives them. They are what someone typed into",
          "a UI, and renaming them here would make this file unusable against that UI —",
          "so a rename is a review decision, made with `--resource <manifest>=<live>` on",
          "the read side until the names agree.",
        ]),
      )}\n\n${stringify(manifest)}`,
    });

    for (const [resource, pairs] of secrets.templates) {
      files.push({
        path: join(
          dir,
          ".infra",
          "env",
          `${slug(resource)}.${ctx.env}.env.template`,
        ),
        content: `${comment(
          header(ctx, [
            `  resource:  "${resource}"`,
            "",
            "Every live var is a ${REF}: the VALUES are in the age store, never here. cast",
            "cannot know which of a box's vars are secret — nobody wrote it down, which is",
            "why this verb exists — and a live key written as a literal is a key in a git",
            "repo. Move the ones that are plainly not secret back to literals yourself.",
          ]),
        )}\n${pairs.map(([key, ref]) => `${key}=\${${ref}}`).join("\n")}\n`,
      });
    }

    const vars = Object.fromEntries(
      secrets.dispositions.map((d) => [d.ref, d.value]),
    );
    if (Object.keys(vars).length > 0) {
      stores.push({
        project: p.name,
        path: join("secrets", `${storeKey(p)}.${ctx.env}.env.age`),
        vars,
      });
    }
  }

  files.push({
    path: "environments.yaml",
    content: `${comment(
      header(ctx, [
        "The state file this instance implies — bindings as far as they can be READ, plus",
        "`projects:`, the registry: the list of what exists, which nothing before a",
        "whole-instance sweep was able to write down.",
        "",
        "`github_apps` is NOT readable from a box: nothing Coolify returns about an",
        `application says which App clones it. This instance has ${ctx.githubApps?.length ?? 0}, so cast`,
        ctx.githubApps?.length === 1
          ? `bound every repo to the only one there is (${ctx.githubApps[0]}) — there is no other it could be.`
          : "left a REVIEW marker on every repo rather than pick. `apply` will refuse until you fix them.",
        "",
        "Do not copy it over a state file you already have. Merge the registry into",
        "yours, by hand, having decided which of these projects are yours to declare.",
      ]),
    )}\n\n${stringify(bindingsDoc(projects, ctx))}`,
  });

  files.push({
    path: "UNCAPTURED.md",
    content: renderUncaptured(uncaptured, projects, ctx),
  });

  return { files, stores, dispositions, uncaptured };
}

// The repo short name when the box knows the repo, else the project's slug —
// `incubator/`, `la-familia-site/`. Only a path; nothing resolves by it.
function projectDir(p: DraftProject): string {
  const repo = registryKey(p);
  const short = repo.includes("/") ? repo.split("/")[1] : repo;
  return slug(short);
}

const storeKey = (p: DraftProject) => projectDir(p);

// The `<org>/<repo>` slug the registry is keyed by — and the box only knows it
// through an APPLICATION's git remote. A project with no application (a lone
// service, a database somebody made once) has no repo on the box at all, so cast
// writes the bare project name and the registry's own parse-time refusal ("a
// registry key has no meaning without its org", #25) stops the file being used
// until a human supplies the org.
//
// That refusal is the right outcome, and deliberately not worked around: the
// alternatives are inventing an org, or leaving the project out of the list — and
// a project missing from the registry is a project every fleet run skips in
// silence, which reads exactly like a clean one.
function registryKey(p: DraftProject): string {
  for (const r of p.resources) {
    if (r.kind !== "application") continue;
    const repo = repoFromGitUrl(r.raw.git_repository);
    if (repo) return repo;
  }
  return slug(p.name);
}

// The bindings the box implies — plus `projects:`, THE REGISTRY (#25): the list
// of what exists, which nothing before a whole-instance sweep was in a position
// to write down. A rebuild cannot even be attempted without it, because you
// cannot restore what you cannot enumerate.
function bindingsDoc(projects: DraftProject[], ctx: DraftContext) {
  const registry: Record<string, { environments: string[] }> = {};
  const githubApps: Record<string, string> = {};
  // With exactly one GitHub App on the instance there is no other one an
  // application could have been cloned by, so binding every repo to it is a fact,
  // not a guess. With none or several it IS a guess, and cast does not make it:
  // a wrong App resolves to a real uuid and clones the wrong repo, silently
  // (githubAppNameFor, #12). A REVIEW marker resolves to nothing, and `apply`
  // says so.
  const onlyApp = ctx.githubApps?.length === 1 ? ctx.githubApps[0] : undefined;
  for (const p of projects) {
    // Only what the draft actually carries a manifest for. See planDraft.
    if (p.resources.length === 0) continue;
    const repo = registryKey(p);
    registry[repo] = { environments: [ctx.env] };
    githubApps[repo] =
      onlyApp ?? "REVIEW-which-github-app-in-coolify-clones-this-repo";
  }
  return {
    environments: {
      [ctx.env]: {
        // NOT readable off a resource: Coolify's environment_details response
        // carries no server. What is written here is the server the environment
        // you swept UNDER is bound to — a fact about your state file, not about
        // this box. With no binding to read it from, it is left for review, and
        // cast's own schema will refuse the file until it is filled in.
        server: ctx.server ?? "REVIEW-no-server-is-readable-from-a-live-box",
        team: { id: ctx.team.id, name: ctx.team.name },
        instance: ctx.instance,
        ...(ctx.recipient ? { age_recipient: ctx.recipient } : {}),
      },
    },
    projects: registry,
    github_apps: githubApps,
  };
}

// --- Refusals ----------------------------------------------------------------

// A draft is emitted into a NEW directory, and only ever into one.
//
// The refusal is not tidiness. `--emit-draft .` inside a product repo would write
// a manifest generated from a live box straight over the reviewed one — and a
// manifest regenerated from a box carries everything that box has accumulated
// that nobody meant. Adoption is one-way: the repo is the truth for a project it
// already declares, and the draft is a proposal for one it does not.
export function assertEmptyTarget(dir: string): void {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir);
  if (entries.length === 0) return;
  throw new Error(
    [
      `refusing to emit a draft: ${dir} is not empty`,
      "",
      "  looked for:  an empty or non-existent directory",
      `  found:       ${entries.slice(0, 8).join(", ")}${entries.length > 8 ? `, … (${entries.length} entries)` : ""}`,
      "",
      "A draft is a PROPOSAL, machine-generated from a live box, and it is written",
      "into a directory of its own so that it can be READ before any of it is",
      "believed. Emitted over a repo that already has a manifest, it would overwrite",
      "a reviewed spec with whatever that box has accumulated — the one direction",
      "nobody reviews. Adoption is one-way.",
      "",
      "Point --emit-draft at a new directory, and land what survives review as a PR.",
    ].join("\n"),
  );
}

// The same rule, once more at the file. Unreachable through the CLI (an empty
// target cannot hold a manifest) and kept anyway: it is the invariant, not the
// check that happens to enforce it today, and the next caller of emitDraft will
// not have read assertEmptyTarget.
export function assertNoExistingManifest(path: string): void {
  if (!existsSync(path)) return;
  throw new Error(
    [
      `refusing to emit a draft: ${path} already exists`,
      "",
      "For a declared project the manifest IS the truth. Regenerating it from a live",
      "box would let that box's cruft overwrite a reviewed spec, silently. A draft is",
      "for a project that has NO manifest; for one that has, `cast inventory <org>/<repo>`",
      "reconciles the two and you decide, key by key, what the manifest should gain.",
    ].join("\n"),
  );
}

// `--emit-draft` with a repo positional. Not an argument-parsing nicety: the two
// flags mean opposite things about the same box, and the combination is the one
// that would do damage.
export function renderRepoWithDraft(orgRepo: string, dir: string): string {
  return [
    "refusing to emit a draft: --emit-draft is a SWEEP-mode flag, and a repo was given",
    "",
    `  looked at:   ${orgRepo}`,
    `  emitting to: ${dir}`,
    "",
    "With a repo, `inventory` reconciles a box against a manifest that ALREADY EXISTS.",
    "That is precisely the case where a draft must not be written: for a declared",
    "project the manifest is the truth, and one regenerated from a live box would",
    "carry back everything that box has accumulated that nobody meant — over the top",
    "of a reviewed spec, in the one direction nobody reviews. Adoption is one-way.",
    "",
    "To reconcile a project that has a manifest:",
    "",
    `    cast inventory ${orgRepo} --env <env> [--project <name>] [--environment <name>]`,
    "",
    "To draft the projects that have none:",
    "",
    `    cast inventory --env <env> --emit-draft ${dir}`,
  ].join("\n");
}

// No recipient, and no explicit opt-out. Refuse — never quietly emit a draft
// with no store in it.
//
// A draft whose secrets were silently skipped looks COMPLETE: a manifest, env
// templates full of ${REF}s, an UNCAPTURED.md — and not one value anywhere. You
// would find out when `apply` refused for want of a store, which is some time
// after the box those values were on stopped existing.
export function renderNoRecipient(envName: string): string {
  return [
    `refusing to emit a draft: no age recipient for ${envName}`,
    "",
    `  looked for:  --recipient, then environments.${envName}.age_recipient`,
    "",
    "The draft's stores are encrypted to a recipient you NAME. cast will not skip",
    "them for you: a draft with templates full of ${REF}s and no store behind them",
    "looks complete, and the values it did not write are on a box you are about to",
    "stop paying for.",
    "",
    "Name one:",
    "",
    "    cast inventory --env <env> --emit-draft <dir> --recipient age1…",
    "",
    "or bind it (it is the public half — safe to commit next to the bindings):",
    "",
    "  environments:",
    `    ${envName}:`,
    "      age_recipient: age1…",
    "",
    "or say, explicitly, that you want the structure without the values:",
    "",
    "    cast inventory --env <env> --emit-draft <dir> --no-secrets",
  ].join("\n");
}

// A project with resources in two environments. cast will not pick one.
//
// Picking would produce a blueprint of HALF A BOX that says nothing about the
// other half — the exact artifact this verb exists to not produce. And the
// likeliest split is the one that has already bitten this project once: a
// Coolify-auto-created `production` beside the `staging` where everything
// actually runs (#22).
export function renderAmbiguousEnvironments(
  projects: Array<{ name: string; environments: string[] }>,
  envName: string,
): string {
  return [
    `refusing to emit a draft: ${projects.length} project(s) have resources in MORE THAN ONE environment`,
    "",
    ...projects.flatMap((p) => [
      `  ${p.name}`,
      ...p.environments.map((e) => `    ${e}`),
    ]),
    "",
    "A draft carries ONE environment per project. Picking for you would emit a",
    "blueprint of half a box that says nothing about the other half — and the box",
    "you are looking at is the one where that already happened once: Coolify",
    "auto-creates `production` in every project, so the environment things actually",
    "run in is whatever someone typed instead.",
    "",
    "Say which:",
    "",
    `    cast inventory --env ${envName} --emit-draft <dir> --environment <name>`,
    "",
    "and run it once per environment you mean to keep, into a directory each.",
  ].join("\n");
}

// --- Emit --------------------------------------------------------------------

export function emitDraft(
  dir: string,
  plan: DraftPlan,
  opts: { recipient?: string },
): string[] {
  assertEmptyTarget(dir);
  const written: string[] = [];
  for (const f of plan.files) {
    const path = join(dir, f.path);
    if (path.endsWith("manifest.yaml")) assertNoExistingManifest(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.content);
    written.push(f.path);
  }
  if (opts.recipient) {
    for (const s of plan.stores) {
      const path = join(dir, s.path);
      mkdirSync(dirname(path), { recursive: true });
      encryptSecrets(opts.recipient, path, s.vars);
      written.push(s.path);
    }
  }
  return written;
}

// --- The plan, printed -------------------------------------------------------
//
// Names and provenance. NEVER values — same contract as renderCapturePlan, and
// for the same reason: this output is meant to be pasted into a PR discussion.
// The one value-shaped thing here is the GENERATED_PLACEHOLDER literal, which
// carries no information about the box.
export function renderDraftPlan(
  plan: DraftPlan,
  ctx: DraftContext,
  opts: { dir: string; recipient?: string; written: string[] },
): string {
  const lines = [
    "",
    `draft — emitted to ${opts.dir}`,
    "",
    `  source:     instance ${ctx.instance} (${ctx.baseUrl}) — read LIVE`,
    `  filed as:   environment ${ctx.env}`,
    `  secrets:    ${opts.recipient ? `encrypted to ${opts.recipient}` : "NOT WRITTEN (--no-secrets)"}`,
    "",
    ...opts.written.map((w) => `  + ${w}`),
    "",
  ];

  if (plan.dispositions.length > 0) {
    const width = Math.max(...plan.dispositions.map((d) => d.ref.length));
    lines.push(
      "every value cast read, and what it did with it — names and provenance, never values:",
      "",
    );
    for (const d of [...plan.dispositions].sort((a, b) =>
      a.project === b.project
        ? a.ref.localeCompare(b.ref)
        : a.project.localeCompare(b.project),
    )) {
      const note =
        d.provenance === "generated" ? `  → ${GENERATED_PLACEHOLDER}` : "";
      lines.push(
        `  ${d.ref.padEnd(width)}  ${d.provenance.padEnd(9)}  ${d.sites.join(", ")}${note}`,
      );
    }
    const generated = plan.dispositions.filter(
      (d) => d.provenance === "generated",
    ).length;
    lines.push(
      "",
      `${plan.dispositions.length} name(s): ${plan.dispositions.length - generated} captured, ${generated} placeheld as provider-generated.`,
      "",
      "A placeheld name's LIVE VALUE WAS NOT READ INTO ANY FILE. A DATABASE_URL copied",
      "off this box points at THIS box's Postgres: a rebuilt box carrying it comes up",
      "working, against the old box's database, and you find out the day the old box is",
      "deleted. The rule is by NAME — read the captured list above and decide whether",
      "anything in it is really a pointer at this box.",
      "",
    );
  }

  lines.push(
    `${plan.uncaptured.length} setting(s) cast SAW and could not express — every one is in ${join(opts.dir, "UNCAPTURED.md")}.`,
    "Read it before you treat this as a blueprint.",
    "",
    "This is a PROPOSAL. `apply` does not read it. The path from here:",
    "",
    "  review it → land the manifest in the product repo as a PR → capture → apply",
  );
  return lines.join("\n");
}
