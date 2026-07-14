import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Desired } from "./diff.js";
import {
  type ResolvedEnv,
  fillDerivedEnv,
  resolveTemplate,
  templateKeys,
  templateRefs,
  templateResourceRefs,
} from "./envtemplate.js";
import { loadManifest } from "./manifest.js";
import {
  type ReservedHit,
  assertNoReservedEnvNames,
  reservedHits,
} from "./reserved.js";

// How cast authenticated (or failed to authenticate) a clone.
//
//   gh      — `gh` is installed and holds a token; borrowed as a credential
//             helper for this invocation only
//   token   — GITHUB_TOKEN / GH_TOKEN in the environment (the CI path)
//   ambient — neither; whatever git's own credential helper does, if anything
export type GitAuth = {
  source: "gh" | "token" | "ambient";
  configArgs: string[];
  env: Record<string, string>;
};

// A credential helper reads the token from the ENVIRONMENT at run time. The
// alternatives both leak it: a token in the clone URL shows up in `ps` and in
// git's own error messages, and `http.extraheader` additionally persists into
// the clone's .git/config. What lands in argv here is the literal text
// `$CAST_GIT_TOKEN`, never its value.
const TOKEN_HELPER =
  '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$CAST_GIT_TOKEN"; }; f';

// `gh auth login` alone does NOT wire git's credential helper — that is
// `gh auth setup-git`, a separate act most people never run. So being logged
// into `gh` does not make `git clone` work, which is exactly the trap #13
// fell into. Borrowing gh as a helper for this one invocation closes that gap
// without mutating the operator's global git config.
const GH_HELPER = "!gh auth git-credential";

function ghHasToken(): boolean {
  try {
    // A local keyring/config read, not a network call. We never keep the
    // value — the helper re-reads it inside git.
    execFileSync("gh", ["auth", "token"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// Resolve clone credentials INSIDE cast, in a fixed order, rather than leaving
// it to whatever the ambient git config happens to do. `credential.helper=`
// (empty) first RESETS the inherited helper list — otherwise a helper
// configured globally is consulted before ours and silently decides the
// outcome, which is the same "the connection target is implicit in a file's
// contents" problem #14 is about.
export function resolveGitAuth(
  env: NodeJS.ProcessEnv = process.env,
  hasGh: () => boolean = ghHasToken,
): GitAuth {
  if (hasGh()) {
    return {
      source: "gh",
      configArgs: [
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${GH_HELPER}`,
      ],
      env: {},
    };
  }
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (token) {
    return {
      source: "token",
      configArgs: [
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${TOKEN_HELPER}`,
      ],
      env: { CAST_GIT_TOKEN: token },
    };
  }
  return { source: "ambient", configArgs: [], env: {} };
}

// GitHub answers "you cannot see this" with a 404, not a 403 — so a private
// repo you lack access to and a repo that does not exist are the same message
// on the wire. The failure text must not pick one; it has to name both, and
// name the credential cast actually used, or the operator debugs the wrong
// half. (The original bug reported *the repository* when the real fault was
// cast's missing credentials.)
export function cloneFailureMessage(
  orgRepo: string,
  auth: GitAuth,
  stderr: string,
): string {
  const detail = stderr.trim();
  const tail = detail
    ? ["", "git said:", ...detail.split("\n").map((l) => `  ${l}`)]
    : [];
  if (auth.source === "ambient") {
    return [
      `cannot clone ${orgRepo}: no GitHub credentials.`,
      "",
      "cast looked for, in order:",
      "  1. `gh` — not installed, or not logged in (`gh auth token` failed)",
      "  2. GITHUB_TOKEN / GH_TOKEN — not set in the environment",
      "  3. git's own credential helper — did not supply credentials either",
      "",
      "Run `gh auth login`, or set GITHUB_TOKEN. (`gh auth setup-git` also works,",
      "but cast borrows `gh` as a credential helper on its own, so logging in is",
      "enough — you do not need to change your global git config.)",
      ...tail,
    ].join("\n");
  }
  const used =
    auth.source === "gh"
      ? "`gh` (borrowed as a credential helper for this clone)"
      : "GITHUB_TOKEN / GH_TOKEN from the environment";
  return [
    `cannot clone ${orgRepo}: authenticated with ${used}, and GitHub still refused.`,
    "",
    "GitHub answers 'you cannot see this' with a 404, so this is one of:",
    `  - ${orgRepo} does not exist (check the slug)`,
    "  - it is private and this credential has no access to it",
    "  - the credential is expired, or lacks the `repo` scope",
    ...tail,
  ].join("\n");
}

// Holds for every verb that reads a manifest (apply, diff, capture, inventory):
// a feature-branch checkout must not be able to decide what prod runs, nor which
// secret names land in prod's store.
//
// The rule is a value, not only a throw inside resolveCheckout, because the CLI
// refuses this combination UP FRONT — before it opens a state file, a store or a
// Coolify. A flag pairing that can never be honored must not need the rest of the
// invocation to be well-formed in order to be caught (it used to be caught late,
// and only by accident of resolveCheckout running before the bindings load). One
// rule, one string, two call sites — never two spellings of the same refusal.
export const PATH_IN_PROD_REFUSAL =
  "refuses --path with --env prod: prod always reads the default branch";

export function refusesPathInProd(opts: {
  env: string;
  path?: string;
}): boolean {
  return opts.path !== undefined && opts.env === "prod";
}

export function resolveCheckout(
  orgRepo: string,
  opts: { env: string; path?: string },
): string {
  if (refusesPathInProd(opts)) {
    throw new Error(PATH_IN_PROD_REFUSAL);
  }
  if (opts.path) return opts.path;
  const dir = mkdtempSync(join(tmpdir(), "infra-checkout-"));
  const auth = resolveGitAuth();
  try {
    execFileSync(
      "git",
      [
        ...auth.configArgs,
        "clone",
        "--depth",
        "1",
        `https://github.com/${orgRepo}.git`,
        dir,
      ],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          ...auth.env,
          // Belt and braces: whatever credential path we took, git may NEVER
          // fall through to its interactive username/password prompt. GitHub
          // stopped accepting passwords there years ago, so it cannot succeed
          // — it can only hang cast, or (in the original report) hand back an
          // error about the repository that hides the real fault.
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer | string })?.stderr ?? "");
    throw new Error(cloneFailureMessage(orgRepo, auth, stderr));
  }
  return dir;
}

// One secret the manifest requires: the ${REF} a template names (the key it
// gets in the age store), the resource that needs it, and the env var it lands
// on there. That last pair is what `capture` reads the live value from — the
// store is keyed by REF, but the live box knows it as `resource.key`.
export type RequiredSecret = { ref: string; resource: string; key: string };

// The dead-reference check, pointed at derived edges instead of generated
// secrets (#60). The same failure the generated_secrets check below catches — a
// name that resolves against nothing, dressed up as config that guards or
// derives something — and refused in the same voice, wherever a template is
// opened: `apply`, `diff`, and `capture` all validate before they act, because a
// `${resource:X.url}` naming a database the manifest does not declare is broken
// for all three, not just the verb about to write.
//
//   - an attr other than `.url`: nothing else is derivable, so it can only be a
//     mistake — named here rather than resolved to `undefined` and written blank.
//   - a resource the manifest does not declare: the URL would resolve against
//     nothing on every box, forever. The likeliest cause is a typo.
function assertResourceRefs(
  envName: string,
  databases: Set<string>,
  refs: Array<{ key: string; resource: string; attr: string }>,
): void {
  for (const r of refs) {
    if (r.attr !== "url") {
      throw new Error(
        [
          `manifest environment ${envName}: ${r.key} refers to \${resource:${r.resource}.${r.attr}}, an unknown resource attribute`,
          "",
          "Only `.url` is derivable — the internal URL of a database the manifest",
          "declares. Fix the attribute, or make it a plain ${SECRET} the store holds.",
        ].join("\n"),
      );
    }
    if (!databases.has(r.resource)) {
      throw new Error(
        [
          `manifest environment ${envName}: ${r.key} refers to \${resource:${r.resource}.url}, but the manifest declares no database named ${r.resource}`,
          "",
          `  declares:   ${[...databases].sort().join(", ") || "(no databases)"}`,
          "",
          "A ${resource:…} ref derives the URL of a database this manifest creates. One",
          "that names a database the manifest does not declare derives nothing, on every",
          "box, forever — the likeliest cause is a typo. Fix the name, or declare the",
          "database.",
        ].join("\n"),
      );
    }
  }
}

// Exactly the set of secret names an environment's manifest demands — the same
// set `apply` will later insist on, read from the same templates by the same
// parser. `capture` uses this to know what to go and fetch; nothing else has to
// be told, and nothing can be silently missed.
//
// Deliberately does NOT take a secrets map: at capture time the store does not
// exist yet. That is the whole point of the verb.
export function requiredSecrets(
  checkoutDir: string,
  envName: string,
): { required: RequiredSecret[]; generated: string[] } {
  const manifest = loadManifest(join(checkoutDir, ".infra", "manifest.yaml"));
  const envSpec = manifest.environments[envName];
  if (!envSpec) {
    throw new Error(
      `environment ${envName} not in manifest (has: ${Object.keys(manifest.environments).join(", ") || "none"})`,
    );
  }
  const required: RequiredSecret[] = [];
  const resourceRefs: Array<{ key: string; resource: string; attr: string }> =
    [];
  // Reserved names are checked HERE, and in manifestResources, and in
  // desiredFromManifest — every function in this file that opens an env
  // template, rather than once in the verb that writes. The rule is a property
  // of cast, not of `apply`: a template that declares SOURCE_COMMIT is broken
  // whether the verb about to run is going to write it (`apply`), store its live
  // value (`capture`), or merely compare it (`diff`, `inventory`). Refusing in
  // one place and reporting in another would leave `capture` writing a store for
  // a manifest `apply` will refuse — a green run that guarantees a red one. See
  // reserved.ts. (Reads ALL template keys, not just the ${…} refs: a bare
  // `SOURCE_COMMIT=` literal suppresses the injection exactly as well.)
  const reserved: ReservedHit[] = [];
  const collect = (resource: string, template?: string) => {
    if (!template) return;
    const file = join(checkoutDir, ".infra", "env", template);
    if (!existsSync(file))
      throw new Error(
        `env template missing: ${file} (referenced by ${resource})`,
      );
    const text = readFileSync(file, "utf8");
    reserved.push(...reservedHits(resource, templateKeys(text)));
    resourceRefs.push(...templateResourceRefs(text));
    for (const { key, ref } of templateRefs(text)) {
      required.push({ ref, resource, key });
    }
  };
  for (const [name, app] of Object.entries(envSpec.applications)) {
    collect(name, app.env_template);
  }
  for (const [name, svc] of Object.entries(envSpec.services ?? {})) {
    collect(name, svc.env_template);
  }
  assertNoReservedEnvNames(reserved);
  assertResourceRefs(
    envName,
    new Set(Object.keys(envSpec.databases ?? {})),
    resourceRefs,
  );
  const generated = envSpec.generated_secrets ?? [];
  // A generated_secrets entry naming something no template refs is dead
  // config — and dead config in THIS list is not merely untidy, it is
  // dangerous: it reads like a guard standing over a name while standing over
  // nothing. The likeliest cause is a typo, and the consequence of the typo is
  // that the real name gets CAPTURED from the source box instead of placeheld.
  const refs = new Set(required.map((r) => r.ref));
  const dead = generated.filter((g) => !refs.has(g));
  if (dead.length > 0) {
    throw new Error(
      [
        `manifest environment ${envName}: generated_secrets names ${dead.join(", ")}, which no env template refers to`,
        "",
        `  declared:   ${generated.join(", ")}`,
        `  templates:  ${[...refs].sort().join(", ") || "(no ${...} refs at all)"}`,
        "",
        "A generated name that matches nothing guards nothing — and if this is a",
        "typo, the name it was meant to guard is being captured from the source",
        "box instead of placeheld. Fix the spelling, or drop the entry.",
      ].join("\n"),
    );
  }
  return { required, generated };
}

// What the manifest declares for an environment, as names only — no secrets, no
// age key, no store. `inventory` runs BEFORE any of those exist (that is the
// point of it: you read the box before you can possibly have adopted it), so it
// must be able to describe the manifest side without resolving a single value.
export type ManifestResource = {
  kind: "application" | "database" | "service";
  name: string;
  envKeys: string[];
};

export function manifestResources(
  checkoutDir: string,
  envName: string,
): ManifestResource[] {
  const manifest = loadManifest(join(checkoutDir, ".infra", "manifest.yaml"));
  const envSpec = manifest.environments[envName];
  if (!envSpec) {
    throw new Error(
      `environment ${envName} not in manifest (has: ${Object.keys(manifest.environments).join(", ") || "none"})`,
    );
  }
  const reserved: ReservedHit[] = [];
  const keysOf = (resource: string, template?: string): string[] => {
    if (!template) return [];
    const file = join(checkoutDir, ".infra", "env", template);
    if (!existsSync(file))
      throw new Error(
        `env template missing: ${file} (referenced by ${resource})`,
      );
    const keys = templateKeys(readFileSync(file, "utf8"));
    reserved.push(...reservedHits(resource, keys));
    return keys;
  };
  const resources = [
    ...Object.entries(envSpec.applications).map(([name, app]) => ({
      kind: "application" as const,
      name,
      envKeys: keysOf(name, app.env_template),
    })),
    ...Object.entries(envSpec.databases ?? {}).map(([name]) => ({
      kind: "database" as const,
      name,
      envKeys: [],
    })),
    ...Object.entries(envSpec.services ?? {}).map(([name, svc]) => ({
      kind: "service" as const,
      name,
      envKeys: keysOf(name, svc.env_template),
    })),
  ];
  assertNoReservedEnvNames(reserved);
  return resources;
}

export function desiredFromManifest(
  checkoutDir: string,
  envName: string,
  secrets: Record<string, string>,
): {
  desired: Desired[];
  resolvedEnvs: Record<string, ResolvedEnv>;
} {
  const manifest = loadManifest(join(checkoutDir, ".infra", "manifest.yaml"));
  const envSpec = manifest.environments[envName];
  if (!envSpec) {
    throw new Error(
      `environment ${envName} not in manifest (has: ${Object.keys(manifest.environments).join(", ") || "none"})`,
    );
  }
  const desired: Desired[] = [];
  const resolvedEnvs: Record<string, ResolvedEnv> = {};
  const reserved: ReservedHit[] = [];
  const resourceRefs: Array<{ key: string; resource: string; attr: string }> =
    [];
  const resolveEnvFile = (
    name: string,
    template?: string,
  ): ResolvedEnv | undefined => {
    if (!template) return undefined;
    const file = join(checkoutDir, ".infra", "env", template);
    if (!existsSync(file))
      throw new Error(`env template missing: ${file} (referenced by ${name})`);
    const text = readFileSync(file, "utf8");
    const env = resolveTemplate(text, secrets);
    reserved.push(...reservedHits(name, Object.keys(env.vars)));
    resourceRefs.push(...templateResourceRefs(text));
    resolvedEnvs[name] = env;
    return env;
  };
  for (const [name, app] of Object.entries(envSpec.applications)) {
    if (app.build.pack === "dockercompose") {
      // Coolify gates the SOURCE_COMMIT *build arg* behind a per-application
      // setting — `ApplicationSetting.include_source_commit_in_build`, default
      // false — and in 4.1.2 that setting has NO API surface. Verified against
      // the v4.1.2 source: it appears in zero API controllers, and both the
      // create and the PATCH allowlists in ApplicationsController.php (l.914,
      // l.2368) reject unrecognized keys outright ("This field is not
      // allowed."), so sending it would fail the whole request rather than be
      // quietly ignored. Its only writer is the Livewire Advanced tab
      // (app/Livewire/Project/Application/Advanced.php:128) — i.e. a human, in
      // the UI. Do NOT add it to `fields` below expecting apply to set it the
      // way it sets `connect_to_docker_network` (which *is* in the allowlist,
      // which is why that one works): apply would 422 on every run. Warning is
      // the only honest move — a manual step the tool knows about and does not
      // mention is one that gets forgotten, and this one fails green.
      //
      // Scope: the toggle gates the BUILD-time arg only. Coolify's *runtime*
      // injection of SOURCE_COMMIT is unconditional with respect to it
      // (ApplicationDeploymentJob.php:2949 — `if (! $forBuildTime || ...)`,
      // which short-circuits true at runtime), so a service that reads
      // process.env.SOURCE_COMMIT per request does not need this toggle at all.
      // What *does* silently suppress that runtime value is an application-level
      // env var of the same name (ApplicationDeploymentJob.php:2950) — a
      // different bug, tracked separately.
      console.warn(
        `application ${name} builds with dockercompose, but apply cannot enable "Include Source Commit in Build" on Coolify 4.1.2 — the setting is absent from the API's field allowlist. If the build consumes SOURCE_COMMIT as a build arg, enable it in the Coolify UI and redeploy; Coolify injects SOURCE_COMMIT at runtime regardless.`,
      );
    }
    desired.push({
      kind: "application",
      name,
      fields: {
        git_repository: app.source.repo,
        git_branch: app.source.branch,
        build_pack: app.build.pack,
        base_directory: app.build.base_directory,
        ...(app.build.publish_directory
          ? { publish_directory: app.build.publish_directory }
          : {}),
        ...(app.build.pack === "dockercompose"
          ? {
              docker_compose_location: app.build.compose_file,
              docker_compose_domains: app.service_domains,
            }
          : {
              ...(app.port !== undefined ? { port: app.port } : {}),
              ...(app.healthcheck ? { healthcheck: app.healthcheck } : {}),
              domains: app.domains,
              // Emitted only when the manifest DECLARES `static:` — like the
              // three commands, not unconditionally. Emitting `is_static:false`
              // on every non-compose app would make the first apply after this
              // ships PATCH `is_static=false` onto any static/SPA app configured
              // in the UI whose manifest has not yet been migrated — silently
              // disabling static serving and re-creating the #63 crash, now
              // caused by cast. And a `pack: static` app that Coolify couples to
              // is_static=true would drift-and-revert forever. So managing
              // is_static is opt-in: declare `static: true` to serve, `static:
              // false` to actively guard against a UI flip to true, or omit it to
              // leave the field alone. (Coolify keeps pack and is_static
              // independent, which is why this stays an explicit field, not a
              // heuristic off `pack`.)
              ...(app.build.static !== undefined
                ? { is_static: app.build.static }
                : {}),
              ...(app.build.install_command !== undefined
                ? { install_command: app.build.install_command }
                : {}),
              ...(app.build.build_command !== undefined
                ? { build_command: app.build.build_command }
                : {}),
              ...(app.build.start_command !== undefined
                ? { start_command: app.build.start_command }
                : {}),
            }),
      },
      env: resolveEnvFile(name, app.env_template),
    });
  }
  for (const [name, db] of Object.entries(envSpec.databases ?? {})) {
    desired.push({
      kind: "database",
      name,
      fields: {
        type: db.type,
        ...(db.version ? { version: db.version } : {}),
        // `backup` is a DIFFED FIELD, like any other.
        //
        // It used to be routed around `fields` into a side channel, on the
        // stated grounds that "live Coolify state doesn't expose it back" — so
        // diffing it would flag spurious drift forever. That premise was false:
        // it is not on the database's own GET, but GET /databases/{uuid}/backups
        // is a route (cast has always POSTed to it), and frequency/retention
        // round-trip verbatim through it. The side channel is what made a
        // `backup:` block added to an EXISTING database do nothing, silently,
        // and made `diff --full` pass on a production database with no backups.
        //
        // Key order matters: computeDiff compares by JSON.stringify, and the
        // live side (fetchLive in cli.ts) builds this same object in this same
        // order. Do not reorder one without the other.
        ...(db.backup
          ? {
              backup: {
                frequency: db.backup.frequency,
                retention: db.backup.retention,
              },
            }
          : {}),
      },
    });
  }
  for (const [name, svc] of Object.entries(envSpec.services ?? {})) {
    if (svc.domains && svc.domains.length > 0) {
      // Coolify 4.1.2's service executor has no flat `domains` concept —
      // hostnames live per-container on `urls` (see serviceApiFields in
      // cli.ts) — so a manifest-declared service `domains` list is silently
      // unhonorable by apply. Warn at build time, once per run, while the
      // service name is still in scope.
      console.warn(
        `service ${name} declares domains (${svc.domains.join(", ")}), but apply cannot set them on Coolify 4.1.2 services — configure hostnames manually in the Coolify UI`,
      );
    }
    desired.push({
      kind: "service",
      name,
      // domains dropped from fields: the live side (projectLiveFields in
      // cli.ts) can't read service domains and the write side
      // (serviceApiFields) drops them, so keeping domains in fields makes
      // every domain-bearing service diff as a perpetual update. Hostnames
      // stay a manual Coolify UI act (warned above).
      //
      // This USED to cite database `backup` as its precedent. It no longer
      // can: `backup` was dropped on the same reasoning and the reasoning
      // turned out to be false there (a read route existed, unlooked-for —
      // see the databases loop above). The difference is that this one was
      // re-checked: Coolify 4.1.2 genuinely exposes no flat `domains` on a
      // service, on any route. If that is ever disproved the same way, this
      // belongs in `fields` too.
      fields: { type: svc.type },
      env: resolveEnvFile(name, svc.env_template),
    });
  }
  // Before the caller can diff it, and long before apply can write it: a
  // resolved env that carries a reserved name is not desired state, it is a
  // suppression of the platform's own value dressed up as one. See reserved.ts.
  assertNoReservedEnvNames(reserved);
  assertResourceRefs(
    envName,
    new Set(Object.keys(envSpec.databases ?? {})),
    resourceRefs,
  );
  return { desired, resolvedEnvs };
}

// Fill the derived vars in a desired set against a URL map keyed by MANIFEST
// resource name. Used twice, with two different maps, and that is the whole
// point of it being one function: diff/apply fills first against the resources
// that already exist on the box (so an app whose DATABASE_URL already equals the
// live database's URL shows no drift — the "differs on every plan" noise #60
// deletes), and the executor fills again against a database it has just created
// (the from-nothing case, where nothing existed to resolve against at plan
// time). A ref whose resource is in neither map stays unresolved; the executor
// is the one place that refuses to WRITE one that never resolved.
export function fillDesiredDerived(
  desired: Desired[],
  urls: Record<string, string>,
): Desired[] {
  return desired.map((d) =>
    d.env ? { ...d, env: fillDerivedEnv(d.env, urls) } : d,
  );
}
