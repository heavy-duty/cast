import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GENERATED_PLACEHOLDER } from "../src/capture.js";
import {
  type DraftProject,
  assertEmptyTarget,
  assertNoExistingManifest,
  draftResourcesFrom,
  isProviderGenerated,
  planDraft,
  repoFromGitUrl,
} from "../src/draft.js";
import { templateKeys, templateRefs } from "../src/envtemplate.js";
import { loadManifest } from "../src/manifest.js";
import { tmp } from "./helpers/tmp.js";

const ctx = {
  env: "prod",
  instance: "box-b",
  baseUrl: "https://coolify.example.com",
  team: { id: 0, name: "Root Team" },
  server: "box-b",
  recipient: "age1example",
  generatedAt: "2026-07-13T00:00:00.000Z",
};

// The value that must never leave the box it was read from.
const POISON = "postgres://postgres:pw@incubator-db-v2.box-b.internal:5432/app";

const project = (over: Partial<DraftProject> = {}): DraftProject => ({
  name: "Incubator",
  coolifyEnv: "staging",
  resources: [
    {
      kind: "application",
      name: "Incubator Stack v2",
      uuid: "a1",
      raw: {
        git_repository: "https://github.com/heavy-duty/incubator",
        git_branch: "main",
        build_pack: "nixpacks",
        base_directory: "/",
        ports_exposes: "3000",
        fqdn: "https://app.example.com",
        destination_id: 3,
      },
      env: {
        DATABASE_URL: POISON,
        MAILGUN_KEY: "key-abc123",
        NODE_ENV: "production",
      },
    },
  ],
  unreadable: [],
  otherEnvironments: [],
  ...over,
});

describe("github_apps binding — resolved by source_id, not guessed (cast#72)", () => {
  const appProject = (
    name: string,
    repo: string,
    source?: { source_id: number; source_type: string },
  ): DraftProject => ({
    name,
    coolifyEnv: "staging",
    resources: [
      {
        kind: "application",
        name,
        uuid: `u-${name}`,
        raw: {
          git_repository: `https://github.com/${repo}`,
          git_branch: "main",
          build_pack: "nixpacks",
          base_directory: "/",
          fqdn: "https://x.example.com",
          ...source,
        },
        env: {},
      },
    ],
    unreadable: [],
    otherEnvironments: [],
  });
  const bindings = (plan: ReturnType<typeof planDraft>) =>
    plan.files.find((f) => f.path === "environments.yaml")?.content ?? "";

  // The payoff the old only-App heuristic could not deliver: with MORE THAN ONE
  // App it used to write a REVIEW marker on every repo. source_id resolves each.
  it("binds each repo to the App its source_id names, even with several Apps", () => {
    const ghApp = "App\\Models\\GithubApp";
    const plan = planDraft(
      [
        appProject("acme-api", "acme/api", {
          source_id: 7,
          source_type: ghApp,
        }),
        appProject("beta-web", "beta/web", {
          source_id: 9,
          source_type: ghApp,
        }),
      ],
      {
        ...ctx,
        githubApps: [
          { id: 7, name: "acme-app" },
          { id: 9, name: "beta-app" },
        ],
      },
    );
    const yaml = bindings(plan);
    expect(yaml).toContain("acme/api: acme-app");
    expect(yaml).toContain("beta/web: beta-app");
  });

  it("leaves a REVIEW marker for a public repo (no GithubApp source)", () => {
    const plan = planDraft([appProject("pub", "acme/public")], {
      ...ctx,
      githubApps: [{ id: 7, name: "acme-app" }],
    });
    expect(bindings(plan)).toMatch(/acme\/public: REVIEW-/);
  });

  it("does not mistake a non-GithubApp source whose id collides with an App id", () => {
    const plan = planDraft(
      [
        appProject("gitlab", "acme/gl", {
          source_id: 7,
          source_type: "App\\Models\\GitlabApp",
        }),
      ],
      { ...ctx, githubApps: [{ id: 7, name: "acme-app" }] },
    );
    // id 7 exists as a GitHub App, but this app's source is a GitlabApp — the
    // collision must not bind it to acme-app.
    expect(bindings(plan)).toMatch(/acme\/gl: REVIEW-/);
  });
});

describe("isProviderGenerated — the one judgment that must not be wrong", () => {
  it("recognizes the datastore families whose value points at the SOURCE box", () => {
    for (const key of [
      "DATABASE_URL",
      "DATABASE_URL_PROD",
      "UMAMI_DATABASE_URL",
      "REDIS_URL",
      "POSTGRES_PASSWORD",
      // The db NAME is a connection coordinate too — [POSTGRES, DB] is datastore
      // + datastore, so the pair-rule missed it until `DB` joined the connection
      // words. It is exactly what a one-click service mints for its bundled
      // Postgres (#87).
      "POSTGRES_DB",
      "DB_HOST",
      "MONGO_URI",
    ]) {
      expect(isProviderGenerated(key), key).toBe(true);
    }
  });

  it("recognizes Coolify's own per-instance magic vars", () => {
    for (const key of [
      "SERVICE_FQDN_UMAMI",
      "SERVICE_URL_UMAMI",
      "SERVICE_PASSWORD_POSTGRES",
      "SERVICE_USER_UMAMI",
      "SERVICE_BASE64_KEY",
    ]) {
      expect(isProviderGenerated(key), key).toBe(true);
    }
  });

  it("leaves an ordinary secret alone — it is captured, not placeheld", () => {
    for (const key of [
      "MAILGUN_KEY",
      "OPENROUTER_KEY",
      "ADMIN_EMAIL",
      "NODE_ENV",
      "SERVICE_NAME",
      "PORT",
    ]) {
      expect(isProviderGenerated(key), key).toBe(false);
    }
  });
});

describe("repoFromGitUrl — the only place a box knows which repo it is", () => {
  it("reads a slug out of every remote shape Coolify stores", () => {
    expect(repoFromGitUrl("https://github.com/heavy-duty/incubator")).toBe(
      "heavy-duty/incubator",
    );
    expect(repoFromGitUrl("https://github.com/heavy-duty/incubator.git")).toBe(
      "heavy-duty/incubator",
    );
    expect(repoFromGitUrl("git@github.com:heavy-duty/incubator.git")).toBe(
      "heavy-duty/incubator",
    );
    expect(repoFromGitUrl("heavy-duty/incubator")).toBe("heavy-duty/incubator");
  });

  it("answers undefined rather than guessing", () => {
    expect(repoFromGitUrl("")).toBeUndefined();
    expect(repoFromGitUrl(undefined)).toBeUndefined();
    expect(repoFromGitUrl("not-a-remote")).toBeUndefined();
  });
});

describe("draftResourcesFrom — including what cast cannot model", () => {
  it("names a MySQL rather than silently omitting it", () => {
    const { resources, unreadable } = draftResourcesFrom({
      applications: [{ name: "web", uuid: "a1" }],
      postgresqls: [{ name: "db", uuid: "d1" }],
      redis: [{ name: "cache", uuid: "d2" }],
      services: [{ name: "umami", uuid: "s1" }],
      mysqls: [{ name: "legacy-mysql", uuid: "m1" }],
      mongodbs: [{ name: "old-mongo", uuid: "m2" }],
    });
    expect(resources.map((r) => [r.kind, r.name])).toEqual([
      ["application", "web"],
      ["database", "db"],
      ["database", "cache"],
      ["service", "umami"],
    ]);
    expect(unreadable).toEqual([
      { kind: "mysql", name: "legacy-mysql" },
      { kind: "mongodb", name: "old-mongo" },
    ]);
  });
});

describe("planDraft — the emitted shape", () => {
  it("writes a manifest cast itself can load, keyed by --env", () => {
    const plan = planDraft([project()], ctx);
    const manifest = plan.files.find((f) => f.path.endsWith("manifest.yaml"));
    expect(manifest?.path).toBe("incubator/.infra/manifest.yaml");
    // A file that says what it is. It leaves this process and is read by someone
    // deciding whether to trust it.
    expect(manifest?.content).toContain("PROPOSAL");
    expect(manifest?.content).toContain("`apply` does not read this file");
    expect(manifest?.content).toContain("box-b");

    const dir = tmp("cast-draft-");
    const path = join(dir, "manifest.yaml");
    writeFileSync(path, manifest?.content ?? "");
    const loaded = loadManifest(path);
    expect(loaded.project).toBe("Incubator");
    const env = loaded.environments.prod;
    // The resource keeps the BOX's name — renaming it here would make the file
    // unusable against the UI it was read from.
    expect(Object.keys(env.applications)).toEqual(["Incubator Stack v2"]);
    expect(env.applications["Incubator Stack v2"].source).toEqual({
      repo: "heavy-duty/incubator",
      branch: "main",
    });
    // And the manifest DECLARES the placeheld name, so a later `capture` does the
    // same placeholding with no flag to remember.
    expect(env.generated_secrets).toEqual(["DATABASE_URL"]);
  });

  // #63: is_static was previously not even in NO_HOME, so a rebuild silently
  // lost it — the exact crash. draft now carries it, plus the install/build/
  // start commands that used to be flagged as NO_HOME.
  it("carries static + install/build/start commands, and does NOT flag them as uncaptured", () => {
    const p = project({
      resources: [
        {
          kind: "application",
          name: "Landing",
          uuid: "a1",
          raw: {
            git_repository: "https://github.com/heavy-duty/incubator",
            git_branch: "main",
            build_pack: "static",
            base_directory: "/",
            publish_directory: "/apps/landing-site/dist",
            fqdn: "https://landing.example.com",
            is_static: true,
            install_command: "npm ci",
            build_command: "npm run build -w apps/landing-site",
          },
          env: {},
        },
      ],
    });
    const plan = planDraft([p], ctx);
    const manifest = plan.files.find((f) => f.path.endsWith("manifest.yaml"));
    const dir = tmp("cast-draft-");
    const path = join(dir, "manifest.yaml");
    writeFileSync(path, manifest?.content ?? "");
    const build =
      loadManifest(path).environments.prod.applications.Landing.build;
    expect(build.static).toBe(true);
    expect(build.install_command).toBe("npm ci");
    expect(build.build_command).toBe("npm run build -w apps/landing-site");
    // These now have a manifest home, so they must NOT be reported as settings
    // cast could see but not express.
    for (const setting of ["is_static", "install_command", "build_command"]) {
      expect(plan.uncaptured.some((u) => u.setting === setting)).toBe(false);
    }
  });

  // A draft must only ever emit a manifest that LOADS. is_static true with no
  // publish_directory would be `static: true` with nothing to serve, which the
  // schema refuses — so draft omits `static` for that (rare, malformed) box
  // rather than writing a file that throws on load.
  it("does not emit static:true when the box has is_static but no publish_directory", () => {
    const p = project({
      resources: [
        {
          kind: "application",
          name: "Odd",
          uuid: "a1",
          raw: {
            git_repository: "https://github.com/heavy-duty/incubator",
            git_branch: "main",
            build_pack: "nixpacks",
            base_directory: "/",
            fqdn: "https://odd.example.com",
            is_static: true,
          },
          env: {},
        },
      ],
    });
    const plan = planDraft([p], ctx);
    const manifest = plan.files.find((f) => f.path.endsWith("manifest.yaml"));
    const dir = tmp("cast-draft-");
    const path = join(dir, "manifest.yaml");
    writeFileSync(path, manifest?.content ?? "");
    // The whole point: it loads (does not throw), and simply carries no `static`.
    const build = loadManifest(path).environments.prod.applications.Odd.build;
    expect(build).not.toHaveProperty("static");
  });

  // #70: Coolify 4.1.2 never returns is_static on any read (it lives on the
  // ApplicationSetting relation, cast#68), so on that Coolify the key is ABSENT
  // from the raw payload and the draft cannot know whether the box is a static
  // site. UNCAPTURED.md is the draft's honesty contract (#27): when the app
  // even looks static, the unreadable flag must be NAMED there — otherwise a
  // reviewer has no cue the field exists to lose, and the #63 crash (static
  // site rebuilt as a plain app) re-enters through the draft door.
  it("names is_static in UNCAPTURED.md when the live read cannot see it and the app looks static", () => {
    const p = project({
      resources: [
        {
          kind: "application",
          name: "Landing",
          uuid: "a1",
          raw: {
            git_repository: "https://github.com/heavy-duty/incubator",
            git_branch: "main",
            build_pack: "nixpacks",
            base_directory: "/",
            publish_directory: "/apps/landing-site/dist",
            fqdn: "https://landing.example.com",
            // no is_static at all — Coolify 4.1.2's read path
          },
          env: {},
        },
      ],
    });
    const plan = planDraft([p], ctx);
    const item = plan.uncaptured.find((u) => u.setting === "is_static");
    expect(item).toBeDefined();
    expect(item?.resource).toBe("Landing");
    // The entry tells the reviewer where the truth lives: the Coolify UI.
    expect(item?.detail).toContain("Coolify UI");
    expect(item?.detail).toContain("static: true");
    // And it reaches the page a reviewer actually reads.
    const uncap = plan.files.find((f) => f.path.endsWith("UNCAPTURED.md"));
    expect(uncap?.content).toContain("is_static");
    // The manifest itself stays silent — absent is not `true`, and a guessed
    // `static: true` would be exactly the fabrication UNCAPTURED.md exists to
    // prevent.
    const manifest = plan.files.find((f) => f.path.endsWith("manifest.yaml"));
    const dir = tmp("cast-draft-");
    const path = join(dir, "manifest.yaml");
    writeFileSync(path, manifest?.content ?? "");
    const build =
      loadManifest(path).environments.prod.applications.Landing.build;
    expect(build).not.toHaveProperty("static");
  });

  // The flag is only worth a reviewer's attention when the app is PLAUSIBLY
  // static — nixpacks/static pack serving a publish_directory (the same
  // heuristic as #70). An app with nothing to serve statically gets no entry;
  // flagging every application would bury the page in noise.
  it("does not flag is_static for an app that does not look static", () => {
    const p = project({
      resources: [
        {
          kind: "application",
          name: "Api",
          uuid: "a1",
          raw: {
            git_repository: "https://github.com/heavy-duty/incubator",
            git_branch: "main",
            build_pack: "nixpacks",
            base_directory: "/",
            fqdn: "https://api.example.com",
            // no publish_directory, no is_static
          },
          env: {},
        },
        {
          kind: "application",
          name: "Built",
          uuid: "a2",
          raw: {
            git_repository: "https://github.com/heavy-duty/incubator",
            git_branch: "main",
            build_pack: "dockerfile",
            base_directory: "/",
            publish_directory: "/dist",
            fqdn: "https://built.example.com",
            // dockerfile pack — Coolify's static toggle is a buildpack concept
          },
          env: {},
        },
      ],
    });
    const plan = planDraft([p], ctx);
    expect(plan.uncaptured.some((u) => u.setting === "is_static")).toBe(false);
  });

  // A future Coolify that DOES serialize is_static gets the old behavior
  // untouched: a real boolean is expressed in the manifest, not flagged.
  // (`static: true` emission for is_static: true is covered above; here the
  // read said `false`, which is an answer, not an absence.)
  it("does not flag is_static when the live read answered false", () => {
    const p = project({
      resources: [
        {
          kind: "application",
          name: "Plain",
          uuid: "a1",
          raw: {
            git_repository: "https://github.com/heavy-duty/incubator",
            git_branch: "main",
            build_pack: "nixpacks",
            base_directory: "/",
            publish_directory: "/dist",
            fqdn: "https://plain.example.com",
            is_static: false,
          },
          env: {},
        },
      ],
    });
    const plan = planDraft([p], ctx);
    expect(plan.uncaptured.some((u) => u.setting === "is_static")).toBe(false);
  });

  it("emits an env template every cast reader can parse", () => {
    const plan = planDraft([project()], ctx);
    const tpl = plan.files.find((f) => f.path.endsWith(".env.template"));
    expect(tpl?.path).toBe(
      "incubator/.infra/env/incubator-stack-v2.prod.env.template",
    );
    const body = tpl?.content ?? "";
    expect(templateKeys(body).sort()).toEqual([
      "DATABASE_URL",
      "MAILGUN_KEY",
      "NODE_ENV",
    ]);
    // EVERY var is a ${REF}: values live in the store, never as a literal in a
    // file that is about to be committed to a product repo.
    expect(
      templateRefs(body)
        .map((r) => r.ref)
        .sort(),
    ).toEqual(["DATABASE_URL", "MAILGUN_KEY", "NODE_ENV"]);
    expect(body).not.toContain(POISON);
    expect(body).not.toContain("key-abc123");
  });

  it("PLACEHOLDS a provider-generated value and captures an ordinary one", () => {
    const plan = planDraft([project()], ctx);
    const byRef = Object.fromEntries(plan.dispositions.map((d) => [d.ref, d]));
    expect(byRef.DATABASE_URL.provenance).toBe("generated");
    expect(byRef.DATABASE_URL.value).toBe(GENERATED_PLACEHOLDER);
    expect(byRef.MAILGUN_KEY.provenance).toBe("captured");
    expect(byRef.MAILGUN_KEY.value).toBe("key-abc123");

    // The store carries the placeholder, NOT the source box's Postgres.
    const store = plan.stores[0];
    expect(store.path).toBe("secrets/incubator.prod.env.age");
    expect(store.vars.DATABASE_URL).toBe(GENERATED_PLACEHOLDER);
    expect(JSON.stringify(plan.files)).not.toContain(POISON);
  });

  it("splits one name carrying two values rather than picking", () => {
    const p = project();
    p.resources.push({
      kind: "application",
      name: "Landing",
      uuid: "a2",
      raw: {
        git_repository: "https://github.com/heavy-duty/incubator",
        git_branch: "main",
        build_pack: "static",
        base_directory: "/",
        fqdn: "https://www.example.com",
      },
      env: { MAILGUN_KEY: "key-DIFFERENT" },
    });
    const plan = planDraft([p], ctx);
    const refs = plan.dispositions.map((d) => d.ref);
    // One store holds one value per name (capture refuses a CONFLICT for exactly
    // this reason). cast will not pick, so both survive under distinct names.
    expect(refs).toContain("INCUBATOR_STACK_V2_MAILGUN_KEY");
    expect(refs).toContain("LANDING_MAILGUN_KEY");
    expect(refs).not.toContain("MAILGUN_KEY");
    expect(
      plan.uncaptured.some((u) => u.detail.includes("DIFFERENT values")),
    ).toBe(true);
  });

  it("always emits UNCAPTURED.md — even with little to say", () => {
    const bare = project({
      resources: [
        {
          kind: "application",
          name: "web",
          uuid: "a1",
          raw: {
            git_repository: "git@github.com:acme/web.git",
            git_branch: "main",
            build_pack: "nixpacks",
            base_directory: "/",
            fqdn: "https://web.example.com",
          },
          env: {},
        },
      ],
    });
    const md = planDraft([bare], ctx).files.find(
      (f) => f.path === "UNCAPTURED.md",
    );
    expect(md).toBeDefined();
    // The standing sections are unconditional: what cast CANNOT SEE does not
    // depend on what it happened to find.
    expect(md?.content).toContain("no API coverage in Coolify 4.1.2");
    expect(md?.content).toContain("Include Source Commit in Build");
    expect(md?.content).toContain("the GitHub App private key");
    expect(md?.content).toContain("S3 access keys");
  });

  it("registers what it drafted, and only what it drafted", () => {
    const empty = project({
      name: "Empty Project",
      resources: [],
      skipReason: "every environment on it is empty",
    });
    const bindings = planDraft([project(), empty], ctx).files.find(
      (f) => f.path === "environments.yaml",
    );
    expect(bindings?.content).toContain("heavy-duty/incubator");
    expect(bindings?.content).toContain("environments:\n      - prod");
    // Not registered — a registry entry for a project with no manifest sends
    // every future fleet run at nothing.
    expect(bindings?.content).not.toContain("Empty Project");
    // …but it is not lost either.
    const md = planDraft([project(), empty], ctx).files.find(
      (f) => f.path === "UNCAPTURED.md",
    );
    expect(md?.content).toContain("Empty Project");
  });
});

describe("backup schedules — read and drafted, not hand-waved (#75)", () => {
  type Backups = DraftProject["resources"][number]["backups"];
  const withDb = (backups: Backups): DraftProject =>
    project({
      resources: [
        ...project().resources,
        {
          kind: "database",
          name: "Incubator Database v2",
          uuid: "d1",
          raw: {
            database_type: "standalone-postgresql",
            image: "postgres:16-alpine",
          },
          env: {},
          backups,
        },
      ],
    });
  const schedule = (over: Partial<NonNullable<Backups>[number]> = {}) => ({
    uuid: "sched-1",
    frequency: "0 3 * * *",
    retention: 7,
    enabled: true,
    saveS3: false,
    ...over,
  });
  const loadedDb = (plan: ReturnType<typeof planDraft>) => {
    const manifest = plan.files.find((f) => f.path.endsWith("manifest.yaml"));
    const dir = tmp("cast-draft-");
    const path = join(dir, "manifest.yaml");
    writeFileSync(path, manifest?.content ?? "");
    return loadManifest(path).environments.prod.databases?.[
      "Incubator Database v2"
    ];
  };
  const backupItems = (plan: ReturnType<typeof planDraft>) =>
    plan.uncaptured.filter((u) => u.setting.startsWith("backup"));

  it("emits a real backup block for a single enabled schedule — and nothing uncaptured", () => {
    const plan = planDraft([withDb([schedule()])], ctx);
    expect(loadedDb(plan)?.backup).toEqual({
      frequency: "0 3 * * *",
      retention: 7,
    });
    expect(backupItems(plan)).toEqual([]);
    // The stale pre-#51 claim is gone from every artifact.
    expect(JSON.stringify(plan.files)).not.toContain("does not yet read");
  });

  it("reports the S3 target it cannot map when the schedule saves to S3", () => {
    const plan = planDraft([withDb([schedule({ saveS3: true })])], ctx);
    // The block is still drafted — frequency/retention ARE readable.
    expect(loadedDb(plan)?.backup).toEqual({
      frequency: "0 3 * * *",
      retention: 7,
    });
    const items = backupItems(plan);
    expect(items).toHaveLength(1);
    expect(items[0].setting).toBe("backup S3 target");
    expect(items[0].detail).toContain("s3_storage_id");
  });

  it("emits nothing for a clean 'no schedule' read — absence IS the answer", () => {
    const plan = planDraft([withDb([])], ctx);
    expect(loadedDb(plan)?.backup).toBeUndefined();
    expect(backupItems(plan)).toEqual([]);
  });

  it("does NOT draft a disabled schedule — apply would re-enable it", () => {
    const plan = planDraft(
      [withDb([schedule({ enabled: false, saveS3: true })])],
      ctx,
    );
    expect(loadedDb(plan)?.backup).toBeUndefined();
    const items = backupItems(plan);
    expect(items).toHaveLength(1);
    expect(items[0].detail).toContain("DISABLED");
    expect(items[0].detail).toContain('"0 3 * * *"');
  });

  it("will not pick between several schedules", () => {
    const plan = planDraft(
      [withDb([schedule(), schedule({ uuid: "sched-2", frequency: "daily" })])],
      ctx,
    );
    expect(loadedDb(plan)?.backup).toBeUndefined();
    const items = backupItems(plan);
    expect(items).toHaveLength(1);
    expect(items[0].detail).toContain("2 backup schedules");
  });

  it("reports an unreadable route rather than aborting or claiming 'no backups'", () => {
    const plan = planDraft([withDb(undefined)], ctx);
    expect(loadedDb(plan)?.backup).toBeUndefined();
    const items = backupItems(plan);
    expect(items).toHaveLength(1);
    expect(items[0].detail).toContain("unreachable");
    expect(items[0].resource).toBe("Incubator Database v2");
  });
});

describe("service hostnames — read and drafted via the per-service GET (#83)", () => {
  const withService = (
    serviceDomains?: Record<string, string[]>,
  ): DraftProject =>
    project({
      resources: [
        ...project().resources,
        {
          kind: "service",
          name: "Incubator Umami",
          uuid: "s1",
          raw: { service_type: "umami" },
          env: {},
          serviceDomains,
        },
      ],
    });
  const loadedSvc = (plan: ReturnType<typeof planDraft>) => {
    const manifest = plan.files.find((f) => f.path.endsWith("manifest.yaml"));
    const dir = tmp("cast-draft-");
    const path = join(dir, "manifest.yaml");
    writeFileSync(path, manifest?.content ?? "");
    return loadManifest(path).environments.prod.services?.["Incubator Umami"];
  };
  const hostnameItems = (plan: ReturnType<typeof planDraft>) =>
    plan.uncaptured.filter((u) => u.setting === "service_domains (hostnames)");

  it("emits service_domains as the diff's own projection reads them — and nothing uncaptured", () => {
    const plan = planDraft(
      [
        withService({
          umami: ["https://umami.example.com"],
          web: ["https://a.example.com", "https://b.example.com"],
        }),
      ],
      ctx,
    );
    expect(loadedSvc(plan)?.service_domains).toEqual({
      umami: ["https://umami.example.com"],
      web: ["https://a.example.com", "https://b.example.com"],
    });
    expect(hostnameItems(plan)).toEqual([]);
    // The stale "does not yet make the per-service GET" claim is gone from
    // every artifact — UNCAPTURED's standing table included.
    expect(JSON.stringify(plan.files)).not.toContain("does not yet make");
  });

  it("emits nothing for a clean 'no hostnames' read — an answer, not a failure", () => {
    const plan = planDraft([withService({})], ctx);
    expect(loadedSvc(plan)).not.toHaveProperty("service_domains");
    expect(hostnameItems(plan)).toEqual([]);
  });

  it("reports an unreadable per-service GET rather than drafting a blank", () => {
    const plan = planDraft([withService(undefined)], ctx);
    expect(loadedSvc(plan)).not.toHaveProperty("service_domains");
    const items = hostnameItems(plan);
    expect(items).toHaveLength(1);
    expect(items[0].resource).toBe("Incubator Umami");
    expect(items[0].detail).toContain("unreachable");
    // The rest of the draft survives: a whole-instance sweep reports one
    // unreadable service, it does not abort on it.
    expect(loadedSvc(plan)?.type).toBe("umami");
  });
});

describe("the emit refusals — adoption is one-way", () => {
  it("refuses a target directory that is not empty", () => {
    const dir = tmp("cast-draft-");
    writeFileSync(join(dir, "README.md"), "a repo lives here\n");
    expect(() => assertEmptyTarget(dir)).toThrow(/is not empty/);
    expect(() => assertEmptyTarget(dir)).toThrow(/Adoption is one-way/);
  });

  it("allows a directory that does not exist yet, and an empty one", () => {
    const dir = tmp("cast-draft-");
    expect(() => assertEmptyTarget(dir)).not.toThrow();
    expect(() => assertEmptyTarget(join(dir, "new"))).not.toThrow();
  });

  it("refuses to write a manifest over one that already exists", () => {
    const dir = tmp("cast-draft-");
    mkdirSync(join(dir, ".infra"), { recursive: true });
    const path = join(dir, ".infra", "manifest.yaml");
    writeFileSync(path, "project: incubator\n");
    // For a declared project the manifest IS the truth: regenerating it from a
    // live box would let that box's cruft overwrite a reviewed spec.
    expect(() => assertNoExistingManifest(path)).toThrow(/already exists/);
    expect(() => assertNoExistingManifest(path)).toThrow(
      /the manifest IS the truth/,
    );
  });
});
