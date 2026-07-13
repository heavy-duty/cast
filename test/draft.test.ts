import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("isProviderGenerated — the one judgment that must not be wrong", () => {
  it("recognizes the datastore families whose value points at the SOURCE box", () => {
    for (const key of [
      "DATABASE_URL",
      "DATABASE_URL_PROD",
      "UMAMI_DATABASE_URL",
      "REDIS_URL",
      "POSTGRES_PASSWORD",
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

    const dir = mkdtempSync(join(tmpdir(), "cast-draft-"));
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

describe("the emit refusals — adoption is one-way", () => {
  it("refuses a target directory that is not empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "cast-draft-"));
    writeFileSync(join(dir, "README.md"), "a repo lives here\n");
    expect(() => assertEmptyTarget(dir)).toThrow(/is not empty/);
    expect(() => assertEmptyTarget(dir)).toThrow(/Adoption is one-way/);
  });

  it("allows a directory that does not exist yet, and an empty one", () => {
    const dir = mkdtempSync(join(tmpdir(), "cast-draft-"));
    expect(() => assertEmptyTarget(dir)).not.toThrow();
    expect(() => assertEmptyTarget(join(dir, "new"))).not.toThrow();
  });

  it("refuses to write a manifest over one that already exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "cast-draft-"));
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
