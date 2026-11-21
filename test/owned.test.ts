import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Executor, applyPlan } from "../src/apply.js";
import { GENERATED_PLACEHOLDER } from "../src/capture.js";
import {
  type Desired,
  type Live,
  computeDiff,
  renderDiff,
} from "../src/diff.js";
import { loadManifest } from "../src/manifest.js";
import { resolveOwnedKeys } from "../src/owned.js";
import { desiredFromManifest, requiredSecrets } from "../src/resolve.js";
import { tmp } from "./helpers/tmp.js";

// Env keys owned by the app (cast#177): the schema, the pointer file, and what
// diff and apply do with them. The wire-level proof is owned-keys-cli.test.ts.

const parse = (text: string) => loadManifest("m.yaml", { overrideText: text });

const app = (extra: string) => `project: x
environments:
  prod:
    applications:
      admin:
        image: { name: ghcr.io/acme/admin, tag: stable }
        build: { pack: dockerimage }
        port: 8787
        domains: []
${extra}`;

describe("owned_keys — the manifest schema", () => {
  it("accepts an inline list and a file pointer", () => {
    expect(
      parse(
        app(
          "        env_template: a.env.template\n        owned_keys: [MCP_ENABLED, MAILGUN_API_KEY]\n",
        ),
      ).environments.prod.applications.admin.owned_keys,
    ).toEqual(["MCP_ENABLED", "MAILGUN_API_KEY"]);
    expect(
      parse(
        app(
          "        env_template: a.env.template\n        owned_keys: { file: .infra/admin-editable.json }\n",
        ),
      ).environments.prod.applications.admin.owned_keys,
    ).toEqual({ file: ".infra/admin-editable.json" });
  });
  it("refuses owned_keys without an env_template", () => {
    expect(() => parse(app("        owned_keys: [A]\n"))).toThrow(
      /owned_keys needs an env_template/,
    );
  });
  it("refuses an unknown key in the pointer, and a wrong shape", () => {
    expect(() =>
      parse(
        app(
          "        env_template: a.env.template\n        owned_keys: { file: a.json, keys: [A] }\n",
        ),
      ),
    ).toThrow(/owned_keys: Unrecognized key\(s\) in object: 'keys'/);
    expect(() =>
      parse(
        app("        env_template: a.env.template\n        owned_keys: A\n"),
      ),
    ).toThrow(/owned_keys is a list/);
  });
  it("refuses a name that is not an env var name, and a duplicate", () => {
    expect(() =>
      parse(
        app(
          "        env_template: a.env.template\n        owned_keys: [MCP-ENABLED]\n",
        ),
      ),
    ).toThrow(/"MCP-ENABLED" is not an env var name/);
    expect(() =>
      parse(
        app(
          "        env_template: a.env.template\n        owned_keys: [A, A]\n",
        ),
      ),
    ).toThrow(/A is listed twice/);
  });
  it("refuses a file path that leaves the repo or is not JSON", () => {
    for (const file of ["/etc/x.json", "../x.json", ".infra/x.yaml"])
      expect(() =>
        parse(
          app(
            `        env_template: a.env.template\n        owned_keys: { file: "${file}" }\n`,
          ),
        ),
      ).toThrow(/owned_keys.file must be a relative path to a .json file/);
  });
  it("is accepted on a service with an env_template", () => {
    const m = parse(`project: x
environments:
  prod:
    applications: {}
    services:
      umami:
        type: umami
        env_template: umami.env.template
        owned_keys: [APP_SECRET]
`);
    expect(m.environments.prod.services?.umami.owned_keys).toEqual([
      "APP_SECRET",
    ]);
  });
});

// A checkout shaped like la-familia-site's: two tiers, one admin template
// each, the pointer file with a shared list one tier's template lacks.
function checkout(opts: {
  file?: unknown;
  prodOwned?: string;
  stagingOwned?: string;
}) {
  const dir = tmp("cast-owned-");
  mkdirSync(join(dir, ".infra", "env"), { recursive: true });
  const pointer = "{ file: .infra/admin-editable.json }";
  writeFileSync(
    join(dir, ".infra", "manifest.yaml"),
    `project: x
environments:
  prod:
    applications:
      admin:
        image: { name: ghcr.io/acme/admin, tag: stable }
        build: { pack: dockerimage }
        port: 8787
        domains: []
        env_template: admin.prod.env.template
        owned_keys: ${opts.prodOwned ?? pointer}
      site:
        image: { name: ghcr.io/acme/site, tag: stable }
        build: { pack: dockerimage }
        port: 80
        domains: []
        env_template: site.prod.env.template
  staging:
    applications:
      admin:
        image: { name: ghcr.io/acme/admin, tag: main }
        build: { pack: dockerimage }
        port: 8787
        domains: []
        env_template: admin.staging.env.template
        owned_keys: ${opts.stagingOwned ?? pointer}
`,
  );
  writeFileSync(
    join(dir, ".infra", "env", "admin.prod.env.template"),
    "MCP_ENABLED=true\nMAILGUN_API_KEY=${MAILGUN_API_KEY}\nUMAMI_API_KEY=${UMAMI_API_KEY}\nTOKEN_SECRET=${TOKEN_SECRET}\n",
  );
  writeFileSync(
    join(dir, ".infra", "env", "admin.staging.env.template"),
    "MCP_ENABLED=false\nMAILGUN_API_KEY=${MAILGUN_API_KEY}\nTOKEN_SECRET=${TOKEN_SECRET}\n",
  );
  writeFileSync(
    join(dir, ".infra", "env", "site.prod.env.template"),
    "ADMIN_HOST=admin.example.com\n",
  );
  if (opts.file !== undefined)
    writeFileSync(
      join(dir, ".infra", "admin-editable.json"),
      typeof opts.file === "string" ? opts.file : JSON.stringify(opts.file),
    );
  return dir;
}

const LA_FAMILIA_SHAPE = {
  _why: "What the admin may change, by template.",
  _secretos_why: "Credentials the admin accepts a drop for, in any tier.",
  _secretos: ["MAILGUN_API_KEY", "UMAMI_API_KEY"],
  "admin.prod.env.template": ["MCP_ENABLED"],
  "admin.staging.env.template": ["MCP_ENABLED"],
};
const load = (dir: string) => loadManifest(join(dir, ".infra/manifest.yaml"));

describe("owned_keys — the pointer file", () => {
  it("resolves the template's own list plus the shared lists it mentions", () => {
    const dir = checkout({ file: LA_FAMILIA_SHAPE });
    expect(resolveOwnedKeys(dir, load(dir), "prod")).toEqual({
      "application:admin": ["MAILGUN_API_KEY", "MCP_ENABLED", "UMAMI_API_KEY"],
    });
    // Staging's template has no UMAMI_API_KEY: the shared list is filtered,
    // not refused — prod carries it.
    expect(resolveOwnedKeys(dir, load(dir), "staging")).toEqual({
      "application:admin": ["MAILGUN_API_KEY", "MCP_ENABLED"],
    });
  });
  it("refuses a missing file, clearly", () => {
    const dir = checkout({});
    expect(() => resolveOwnedKeys(dir, load(dir), "prod")).toThrow(
      /owned_keys file missing: \.infra\/admin-editable\.json \(named by application admin in prod, application admin in staging\)/,
    );
  });
  it("refuses a file that is not JSON, or not an object", () => {
    const bad = checkout({ file: '{ "SECRET_LOOKING": nope' });
    let message = "";
    try {
      resolveOwnedKeys(bad, load(bad), "prod");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/is not valid JSON/);
    // The parser's own message quotes the file; cast's never does.
    expect(message).not.toContain("nope");
    expect(message).not.toContain("SECRET_LOOKING");
    const arr = checkout({ file: ["MCP_ENABLED"] });
    expect(() => resolveOwnedKeys(arr, load(arr), "prod")).toThrow(
      /must be a JSON object/,
    );
  });
  it("refuses a template entry naming a key that template does not declare", () => {
    const dir = checkout({
      file: {
        ...LA_FAMILIA_SHAPE,
        "admin.staging.env.template": ["MCP_ENABLD"],
      },
    });
    // Per environment: a staging typo does not refuse a prod run...
    expect(resolveOwnedKeys(dir, load(dir), "prod")).toEqual({
      "application:admin": ["MAILGUN_API_KEY", "MCP_ENABLED", "UMAMI_API_KEY"],
    });
    // ...and refuses staging's.
    expect(() => resolveOwnedKeys(dir, load(dir), "staging")).toThrow(
      /manifest environment staging: application admin: owned_keys file \.infra\/admin-editable\.json \("admin\.staging\.env\.template"\) names MCP_ENABLD, which its env template admin\.staging\.env\.template does not declare/,
    );
  });
  it("refuses a shared name no template pointing at the file declares", () => {
    const dir = checkout({
      file: { ...LA_FAMILIA_SHAPE, _secretos: ["MAILGUN_API_KEY", "NOPE_KEY"] },
    });
    expect(() => resolveOwnedKeys(dir, load(dir), "prod")).toThrow(
      /"_secretos" names NOPE_KEY, which no env template pointing at the file declares/,
    );
  });
  it("refuses an entry that is no pointing template's file name", () => {
    const dir = checkout({
      file: { ...LA_FAMILIA_SHAPE, "site.prod.env.template": ["ADMIN_HOST"] },
    });
    expect(() => resolveOwnedKeys(dir, load(dir), "prod")).toThrow(
      /"site\.prod\.env\.template" is not the env_template of any resource that points at this file/,
    );
  });
  it("refuses an entry that is not an array of names", () => {
    const dir = checkout({ file: { ...LA_FAMILIA_SHAPE, _secretos: [1] } });
    expect(() => resolveOwnedKeys(dir, load(dir), "prod")).toThrow(
      /"_secretos" must be an array of env var names/,
    );
  });
  it("a prod run with inline lists never opens staging's template", () => {
    const dir = checkout({
      prodOwned: "[MCP_ENABLED]",
      stagingOwned: "[MCP_ENABLED]",
    });
    rmSync(join(dir, ".infra", "env", "admin.staging.env.template"));
    expect(resolveOwnedKeys(dir, load(dir), "prod")).toEqual({
      "application:admin": ["MCP_ENABLED"],
    });
  });
  it("the shared-list check names another environment's missing template, and why it opened it", () => {
    const dir = checkout({ file: LA_FAMILIA_SHAPE });
    rmSync(join(dir, ".infra", "env", "admin.staging.env.template"));
    expect(resolveOwnedKeys(dir, load(dir), "prod")).toEqual({
      "application:admin": ["MAILGUN_API_KEY", "MCP_ENABLED", "UMAMI_API_KEY"],
    });
    // MAILGUN_API_KEY is in prod's template, so it resolves without staging's;
    // a name only staging could vouch for needs staging's template.
    const onlyStaging = checkout({
      file: { ...LA_FAMILIA_SHAPE, _secretos: ["MAILGUN_API_KEY", "NOPE"] },
    });
    rmSync(join(onlyStaging, ".infra", "env", "admin.staging.env.template"));
    expect(() =>
      resolveOwnedKeys(onlyStaging, load(onlyStaging), "prod"),
    ).toThrow(
      /env template missing: .*admin\.staging\.env\.template \(referenced by application admin in staging\) — opened because "_secretos" in \.infra\/admin-editable\.json is a shared list/,
    );
  });
  it("refuses a pointer that symlinks out of the checkout", () => {
    const dir = checkout({});
    const outside = tmp("cast-outside-");
    writeFileSync(join(outside, "x.json"), JSON.stringify(LA_FAMILIA_SHAPE));
    symlinkSync(
      join(outside, "x.json"),
      join(dir, ".infra", "admin-editable.json"),
    );
    expect(() => resolveOwnedKeys(dir, load(dir), "prod")).toThrow(
      /resolves outside the repo checkout/,
    );
  });
  it("warns, and does not refuse, when a resource resolves to no owned keys", () => {
    const dir = checkout({
      file: {
        _why: "nothing yet",
        "admin.prod.env.template": [],
        "admin.staging.env.template": [],
      },
    });
    const warnings: string[] = [];
    expect(
      resolveOwnedKeys(dir, load(dir), "prod", (m) => warnings.push(m)),
    ).toEqual({});
    expect(warnings).toEqual([
      "manifest environment prod: application admin: owned_keys resolves to no keys for env template admin.prod.env.template — cast manages every key of it as usual",
    ]);
  });
  it("checks an inline list against its own template", () => {
    const ok = checkout({
      prodOwned: "[MCP_ENABLED, TOKEN_SECRET]",
      stagingOwned: "[MCP_ENABLED]",
    });
    expect(resolveOwnedKeys(ok, load(ok), "prod")).toEqual({
      "application:admin": ["MCP_ENABLED", "TOKEN_SECRET"],
    });
    const dead = checkout({
      prodOwned: "[UMAMI_API_KEY]",
      stagingOwned: "[UMAMI_API_KEY]",
    });
    expect(resolveOwnedKeys(dead, load(dead), "prod")).toEqual({
      "application:admin": ["UMAMI_API_KEY"],
    });
    expect(() => resolveOwnedKeys(dead, load(dead), "staging")).toThrow(
      /environment staging: application admin: owned_keys names UMAMI_API_KEY, which its env template admin\.staging\.env\.template does not declare/,
    );
  });
});

const SECRETS = {
  MAILGUN_API_KEY: "store-mailgun",
  UMAMI_API_KEY: "store-umami",
  TOKEN_SECRET: "store-token",
};

describe("owned_keys — resolution, capture", () => {
  it("desiredFromManifest carries the owned keys beside the full env", () => {
    const dir = checkout({ file: LA_FAMILIA_SHAPE });
    const { desired } = desiredFromManifest(dir, "prod", SECRETS);
    const admin = desired.find((d) => d.name === "admin") as Desired;
    expect(admin.ownedEnv).toEqual([
      "MAILGUN_API_KEY",
      "MCP_ENABLED",
      "UMAMI_API_KEY",
    ]);
    // The env itself is whole: a create writes every key.
    expect(Object.keys(admin.env?.vars ?? {}).sort()).toEqual([
      "MAILGUN_API_KEY",
      "MCP_ENABLED",
      "TOKEN_SECRET",
      "UMAMI_API_KEY",
    ]);
    const site = desired.find((d) => d.name === "site") as Desired;
    expect(site.ownedEnv).toBeUndefined();
  });
  it("capture is unchanged: owned secrets are still required from the live box", () => {
    const dir = checkout({ file: LA_FAMILIA_SHAPE });
    const { required } = requiredSecrets(dir, "prod");
    expect(required.map((r) => r.ref).sort()).toEqual([
      "MAILGUN_API_KEY",
      "TOKEN_SECRET",
      "UMAMI_API_KEY",
    ]);
  });
  it("capture still refuses a broken declaration, like every verb", () => {
    const dir = checkout({});
    expect(() => requiredSecrets(dir, "prod")).toThrow(
      /owned_keys file missing/,
    );
  });
});

describe("owned_keys — diff and apply", () => {
  const desired: Desired[] = [
    {
      kind: "application",
      name: "admin",
      fields: { build_pack: "dockerimage" },
      env: {
        vars: {
          NODE_ENV: { value: "production", secret: false },
          MCP_ENABLED: { value: "true", secret: false },
          MAILGUN_API_KEY: { value: "store-value", secret: true },
        },
      },
      ownedEnv: ["MAILGUN_API_KEY", "MCP_ENABLED"],
    },
  ];
  const live = (env: Record<string, string>): Live[] => [
    {
      kind: "application",
      name: "admin",
      uuid: "u1",
      fields: { build_pack: "dockerimage" },
      env: Object.fromEntries(
        Object.entries(env).map(([k, v]) => [k, { value: v, realValue: v }]),
      ),
    },
  ];
  function recorder() {
    const envs: Record<string, string[]> = {};
    const calls: string[] = [];
    const exec: Executor = {
      createResource: async () => "new-uuid",
      updateFields: async () => {},
      syncEnv: async (uuid, _k, env) => {
        envs[uuid] = Object.keys(env.vars).sort();
      },
      redeploy: async (uuid) => {
        calls.push(`redeploy ${uuid}`);
      },
    };
    return { envs, calls, exec };
  }

  it("an existing resource: owned keys are not compared, and not written", async () => {
    const report = computeDiff(
      desired,
      live({
        NODE_ENV: "development",
        MCP_ENABLED: "false",
        MAILGUN_API_KEY: "rotated-by-the-admin",
      }),
      "full",
    );
    expect(report.changes[0].envDiffs.map((e) => e.key)).toEqual(["NODE_ENV"]);
    expect(report.ownedNotCompared).toEqual([
      {
        kind: "application",
        name: "admin",
        keys: ["MAILGUN_API_KEY", "MCP_ENABLED"],
      },
    ]);
    const { envs, exec } = recorder();
    await applyPlan(report, desired, exec);
    expect(envs.u1).toEqual(["NODE_ENV"]);
  });
  it("an existing resource where only owned keys differ is clean, and apply writes nothing", async () => {
    const report = computeDiff(
      desired,
      live({
        NODE_ENV: "production",
        MCP_ENABLED: "false",
        MAILGUN_API_KEY: "rotated-by-the-admin",
      }),
      "full",
    );
    expect(report.clean).toBe(true);
    const text = renderDiff(report);
    expect(text).toContain(
      "env on application admin: MAILGUN_API_KEY, MCP_ENABLED owned by the app — not compared",
    );
    expect(text).not.toContain("rotated-by-the-admin");
    expect(text).not.toContain("store-value");
    const { envs, calls, exec } = recorder();
    const r = await applyPlan(report, desired, exec);
    expect(envs).toEqual({});
    expect(calls).toEqual([]);
    expect(r.mutated).toEqual([]);
  });
  it("an owned key absent live is written once, alone; a present one is no orphan and not written", async () => {
    const report = computeDiff(
      desired,
      live({ NODE_ENV: "production", MAILGUN_API_KEY: "x" }),
      "full",
    );
    expect(report.clean).toBe(false);
    expect(report.changes[0].envDiffs).toEqual([
      { key: "MCP_ENABLED", state: "add", secret: false, owned: true },
    ]);
    expect(report.ownedNotCompared).toEqual([
      { kind: "application", name: "admin", keys: ["MAILGUN_API_KEY"] },
    ]);
    const text = renderDiff(report);
    expect(text).toContain(
      "  env MCP_ENABLED: add — owned by the app; absent live, written once, never overwritten after",
    );
    expect(text).not.toContain("true");
    const { envs, exec } = recorder();
    await applyPlan(report, desired, exec);
    // NODE_ENV rides along (it matches live; the bulk route upserts it to the
    // same value) — what matters is that the present owned key does not.
    expect(envs.u1).toEqual(["MCP_ENABLED", "NODE_ENV"]);
  });
  it("a generated-secret placeholder in an owned key is no conflict: nothing would be written", () => {
    const d: Desired[] = [
      {
        ...desired[0],
        env: {
          vars: {
            ...desired[0].env?.vars,
            MAILGUN_API_KEY: { value: GENERATED_PLACEHOLDER, secret: true },
          },
        },
      },
    ];
    const report = computeDiff(
      d,
      live({ NODE_ENV: "production", MCP_ENABLED: "x", MAILGUN_API_KEY: "y" }),
      "full",
    );
    expect(report.changes).toEqual([]);
  });
  it("a created resource: owned keys are written, and the plan says so per key", async () => {
    const report = computeDiff(desired, [], "full");
    const text = renderDiff(report);
    expect(text).toContain(
      "  env MCP_ENABLED: add — owned by the app; written now because apply creates the resource, never overwritten after",
    );
    expect(text).toContain(
      "  env MAILGUN_API_KEY: add — owned by the app; written now because apply creates the resource, never overwritten after",
    );
    expect(text).not.toContain("store-value");
    expect(report.ownedNotCompared).toEqual([]);
    const { envs, exec } = recorder();
    await applyPlan(report, desired, exec);
    expect(envs["new-uuid"]).toEqual([
      "MAILGUN_API_KEY",
      "MCP_ENABLED",
      "NODE_ENV",
    ]);
  });
  it("a structural diff says nothing about owned keys (no env is read)", () => {
    const report = computeDiff(desired, live({}), "structural");
    expect(report.ownedNotCompared).toEqual([]);
  });
});

describe("owned_keys — services", () => {
  const svc: Desired[] = [
    {
      kind: "service",
      name: "umami",
      fields: { type: "umami" },
      env: {
        vars: {
          DISABLE_TELEMETRY: { value: "1", secret: false },
          APP_SECRET: { value: "store-secret", secret: true },
        },
      },
      ownedEnv: ["APP_SECRET"],
    },
  ];
  const envsOf = async (report: ReturnType<typeof computeDiff>) => {
    const envs: Record<string, string[]> = {};
    await applyPlan(report, svc, {
      createResource: async () => "svc-new",
      updateFields: async () => {},
      syncEnv: async (uuid, _k, env) => {
        envs[uuid] = Object.keys(env.vars).sort();
      },
      redeploy: async () => {},
    });
    return envs;
  };
  it("an existing service: the owned key is not compared and not written", async () => {
    const report = computeDiff(
      svc,
      [
        {
          kind: "service",
          name: "umami",
          uuid: "svc-1",
          fields: { type: "umami" },
          env: {
            DISABLE_TELEMETRY: { value: "0" },
            APP_SECRET: { value: "x", realValue: "set-by-the-app" },
          },
        },
      ],
      "full",
    );
    expect(report.changes[0].envDiffs.map((e) => e.key)).toEqual([
      "DISABLE_TELEMETRY",
    ]);
    expect(renderDiff(report)).toContain(
      "env on service umami: APP_SECRET owned by the app — not compared",
    );
    expect(await envsOf(report)).toEqual({ "svc-1": ["DISABLE_TELEMETRY"] });
  });
  it("a created service: the owned key is written", async () => {
    const report = computeDiff(svc, [], "full");
    expect(renderDiff(report)).toContain(
      "  env APP_SECRET: add — owned by the app; written now because apply creates the resource",
    );
    expect(await envsOf(report)).toEqual({
      "svc-new": ["APP_SECRET", "DISABLE_TELEMETRY"],
    });
  });
});
