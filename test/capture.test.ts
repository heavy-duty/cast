import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GENERATED_PLACEHOLDER,
  type GeneratedSource,
  assertGeneratedComplete,
  classify,
  generatedPlanRefuses,
  planGenerated,
  renderCapturePlan,
  renderGeneratedPlan,
  resolveGeneratedSources,
} from "../src/capture.js";
import { requiredSecrets } from "../src/resolve.js";
import { tmp } from "./helpers/tmp.js";

const CTX = {
  orgRepo: "heavy-duty/incubator",
  env: "prod",
  instance: "legacy",
  store: "/s/secrets/incubator.prod.env.age",
  recipient: "age1abc",
};

// The live case, shrunk: an app whose env template needs a generated database
// URL, a carried-over API key, and an address that must NOT be carried over.
const REQUIRED = [
  { ref: "DATABASE_URL_PROD", resource: "core", key: "DATABASE_URL" },
  { ref: "MAILGUN_API_KEY", resource: "core", key: "MAILGUN_API_KEY" },
  { ref: "ADMIN_EMAIL", resource: "core", key: "ADMIN_EMAIL" },
];
const LIVE = {
  core: {
    DATABASE_URL: "postgres://SOURCE-BOX-INTERNAL/db",
    MAILGUN_API_KEY: "key-abc123-REAL-SECRET",
    ADMIN_EMAIL: "founder@real-company.com",
  },
};

describe("classify", () => {
  it("captures a live value, and records where it came from", () => {
    const c = classify([REQUIRED[1]], [], LIVE, {});
    expect(c.plan).toEqual([
      {
        ref: "MAILGUN_API_KEY",
        provenance: "captured",
        value: "key-abc123-REAL-SECRET",
        sites: [{ resource: "core", key: "MAILGUN_API_KEY" }],
      },
    ]);
  });

  // The failure this verb exists to prevent: the source box's DATABASE_URL
  // points at the SOURCE box's Postgres. Copying it over is confidently wrong
  // in a way that looks entirely plausible.
  it("placeholds a generated name, never copying the source's value", () => {
    const c = classify([REQUIRED[0]], ["DATABASE_URL_PROD"], LIVE, {});
    expect(c.plan[0]).toMatchObject({
      ref: "DATABASE_URL_PROD",
      provenance: "generated",
      value: GENERATED_PLACEHOLDER,
    });
    expect(c.plan[0].value).not.toContain("SOURCE-BOX");
  });

  // staging and prod share a Mailgun domain, so a staging box carrying the
  // real ADMIN_EMAIL can mail real users.
  it("takes an override from the operator, over the source's value", () => {
    const c = classify([REQUIRED[2]], [], LIVE, {
      ADMIN_EMAIL: "operator@example.com",
    });
    expect(c.plan[0]).toMatchObject({
      provenance: "overridden",
      value: "operator@example.com",
    });
  });

  it("an override beats a generated declaration too", () => {
    const c = classify([REQUIRED[0]], ["DATABASE_URL_PROD"], LIVE, {
      DATABASE_URL_PROD: "postgres://explicit",
    });
    expect(c.plan[0]).toMatchObject({
      provenance: "overridden",
      value: "postgres://explicit",
    });
  });

  // Required by the template, absent from the source: refuse rather than write
  // an empty. An empty substitutes to nothing and the app boots misconfigured.
  it("refuses on a name required by the template but absent from the source", () => {
    const c = classify(
      [{ ref: "TURNSTILE_SECRET", resource: "core", key: "TURNSTILE_SECRET" }],
      [],
      LIVE,
      {},
    );
    expect(c.plan).toEqual([]);
    expect(c.missing).toEqual([
      {
        ref: "TURNSTILE_SECRET",
        sites: [{ resource: "core", key: "TURNSTILE_SECRET" }],
      },
    ]);
  });

  it("a missing name can be rescued by an override", () => {
    const c = classify(
      [{ ref: "TURNSTILE_SECRET", resource: "core", key: "TURNSTILE_SECRET" }],
      [],
      LIVE,
      { TURNSTILE_SECRET: "supplied" },
    );
    expect(c.missing).toEqual([]);
    expect(c.plan[0].provenance).toBe("overridden");
  });

  // One name, two resources, two different live values. The store holds one
  // value per name; picking wrong would be silent.
  it("refuses when one name carries different values on two resources", () => {
    const c = classify(
      [
        { ref: "SHARED", resource: "core", key: "SHARED" },
        { ref: "SHARED", resource: "worker", key: "SHARED" },
      ],
      [],
      { core: { SHARED: "a" }, worker: { SHARED: "b" } },
      {},
    );
    expect(c.plan).toEqual([]);
    expect(c.conflicts).toEqual([
      {
        ref: "SHARED",
        values: [
          { resource: "core", key: "SHARED" },
          { resource: "worker", key: "SHARED" },
        ],
      },
    ]);
  });

  it("is fine when one name carries the SAME value on two resources", () => {
    const c = classify(
      [
        { ref: "SHARED", resource: "core", key: "SHARED" },
        { ref: "SHARED", resource: "worker", key: "SHARED" },
      ],
      [],
      { core: { SHARED: "same" }, worker: { SHARED: "same" } },
      {},
    );
    expect(c.conflicts).toEqual([]);
    expect(c.plan[0].value).toBe("same");
  });

  // The acceptance criterion: exactly the names the manifest requires, no more
  // and no fewer. A live var the manifest does not ask for is not the store's
  // business.
  it("writes exactly the required names — ignoring live vars nobody asked for", () => {
    const c = classify(
      REQUIRED,
      ["DATABASE_URL_PROD"],
      {
        core: { ...LIVE.core, SOME_OTHER_LIVE_VAR: "not in the manifest" },
      },
      {},
    );
    expect(c.plan.map((d) => d.ref).sort()).toEqual([
      "ADMIN_EMAIL",
      "DATABASE_URL_PROD",
      "MAILGUN_API_KEY",
    ]);
  });
});

describe("renderCapturePlan", () => {
  // THE invariant. "No secret value is ever written to stdout" — so the plan
  // is names and provenance, and the test asserts on the actual live values
  // rather than on a pattern that could drift away from them.
  it("never prints a secret value", () => {
    const c = classify(REQUIRED, ["DATABASE_URL_PROD"], LIVE, {
      ADMIN_EMAIL: "operator@example.com",
    });
    const out = renderCapturePlan(c, CTX);
    for (const secret of [
      "postgres://SOURCE-BOX-INTERNAL/db",
      "key-abc123-REAL-SECRET",
      "founder@real-company.com",
      "operator@example.com",
    ]) {
      expect(out).not.toContain(secret);
    }
  });

  it("shows every name with its provenance and where it lands", () => {
    const c = classify(REQUIRED, ["DATABASE_URL_PROD"], LIVE, {
      ADMIN_EMAIL: "operator@example.com",
    });
    const out = renderCapturePlan(c, CTX);
    expect(out).toMatch(/MAILGUN_API_KEY\s+captured\s+core\.MAILGUN_API_KEY/);
    expect(out).toMatch(/DATABASE_URL_PROD\s+generated/);
    expect(out).toContain(GENERATED_PLACEHOLDER);
    expect(out).toMatch(/ADMIN_EMAIL\s+overridden/);
    expect(out).toContain("CAST_CAPTURE_ADMIN_EMAIL");
    expect(out).toMatch(/3 name\(s\) to write/);
    expect(out).toContain("/s/secrets/incubator.prod.env.age");
    expect(out).toContain("age1abc");
  });

  it("names what is missing, and says why an empty would be worse", () => {
    const c = classify(
      [{ ref: "TURNSTILE_SECRET", resource: "core", key: "TURNSTILE_SECRET" }],
      [],
      LIVE,
      {},
    );
    const out = renderCapturePlan(c, CTX);
    expect(out).toMatch(/TURNSTILE_SECRET\s+MISSING/);
    expect(out).toMatch(/refusing to write the store/);
    expect(out).toMatch(/--override/);
  });

  it("names a conflict rather than picking a side", () => {
    const c = classify(
      [
        { ref: "SHARED", resource: "core", key: "SHARED" },
        { ref: "SHARED", resource: "worker", key: "SHARED" },
      ],
      [],
      { core: { SHARED: "a" }, worker: { SHARED: "b" } },
      {},
    );
    const out = renderCapturePlan(c, CTX);
    expect(out).toMatch(/SHARED\s+CONFLICT/);
    expect(out).toMatch(/core\.SHARED and worker\.SHARED/);
    expect(out).not.toMatch(/\ba\b.*\bb\b/);
  });
});

// requiredSecrets is what makes "no more, no fewer" true: the set comes from
// the manifest's own templates, read by the same parser apply uses.
describe("requiredSecrets", () => {
  function checkout(manifest: string, templates: Record<string, string>) {
    const dir = tmp("cast-cap-");
    mkdirSync(join(dir, ".infra", "env"), { recursive: true });
    writeFileSync(join(dir, ".infra", "manifest.yaml"), manifest);
    for (const [name, body] of Object.entries(templates)) {
      writeFileSync(join(dir, ".infra", "env", name), body);
    }
    return dir;
  }

  const MANIFEST = `project: incubator
environments:
  prod:
    generated_secrets: [DATABASE_URL_PROD]
    applications:
      core:
        source: { repo: heavy-duty/incubator, branch: main }
        build: { pack: dockercompose, base_directory: /, compose_file: /docker-compose.yaml }
        service_domains:
          api: ["https://api.example.com"]
        env_template: core.prod.env.template
    services:
      umami:
        type: umami
        env_template: umami.prod.env.template
`;

  it("collects the ${...} refs from every app and service template", () => {
    const dir = checkout(MANIFEST, {
      "core.prod.env.template":
        "NODE_ENV=production\nDATABASE_URL=${DATABASE_URL_PROD}\nMAILGUN_API_KEY=${MAILGUN_API_KEY}\n",
      "umami.prod.env.template": "APP_SECRET=${UMAMI_APP_SECRET}\n",
    });
    const { required, generated } = requiredSecrets(dir, "prod");
    expect(required).toEqual([
      { ref: "DATABASE_URL_PROD", resource: "core", key: "DATABASE_URL" },
      { ref: "MAILGUN_API_KEY", resource: "core", key: "MAILGUN_API_KEY" },
      { ref: "UMAMI_APP_SECRET", resource: "umami", key: "APP_SECRET" },
    ]);
    expect(generated).toEqual(["DATABASE_URL_PROD"]);
  });

  // A non-placeholder line (NODE_ENV=production) is not a secret and must not
  // land in the store — the store holds the ${...} refs, nothing else.
  it("ignores literal template values — only ${...} refs are secrets", () => {
    const dir = checkout(MANIFEST, {
      "core.prod.env.template":
        "NODE_ENV=production\nREPORTING_ENABLED=false\nDATABASE_URL=${DATABASE_URL_PROD}\n",
      "umami.prod.env.template": "",
    });
    const { required } = requiredSecrets(dir, "prod");
    expect(required.map((r) => r.ref)).toEqual(["DATABASE_URL_PROD"]);
  });

  // Dead config in THIS list is dangerous, not merely untidy: it reads like a
  // guard standing over a name while standing over nothing, and the likeliest
  // cause is a typo whose real name is then CAPTURED from the source box.
  it("refuses a generated_secrets entry that no template refers to", () => {
    const dir = checkout(
      MANIFEST.replace(
        "generated_secrets: [DATABASE_URL_PROD]",
        "generated_secrets: [DATABASE_URL_TYPO]",
      ),
      {
        "core.prod.env.template": "DATABASE_URL=${DATABASE_URL_PROD}\n",
        "umami.prod.env.template": "",
      },
    );
    expect(() => requiredSecrets(dir, "prod")).toThrow(
      /generated_secrets names DATABASE_URL_TYPO/,
    );
  });
});

// ---------------------------------------------------------------------------
// Pass 2 — capture --generated-only
// ---------------------------------------------------------------------------

// The live shape this verb exists for: the incubator, mid-bootstrap. Two
// databases in the project+environment, and a third Postgres that belongs to
// umami — the row the hand-run `jq | head` had to be careful not to pick, and
// the one a name-directed lookup across `GET /databases` would eventually take.
const PG: GeneratedSource = {
  resource: "incubator-db",
  type: "postgresql",
  url: "postgres://u:REAL-PG-PASSWORD@abc123:5432/app",
};
const REDIS: GeneratedSource = {
  resource: "incubator-redis",
  type: "redis",
  url: "redis://default:REAL-REDIS-PASSWORD@def456:6379/0",
};

// Pass 1 left these two placeheld; every other name is real and must survive.
const STORE = {
  DATABASE_URL: GENERATED_PLACEHOLDER,
  REDIS_URL: GENERATED_PLACEHOLDER,
  MAILGUN_API_KEY: "key-REAL",
  ADMIN_EMAIL: "operator@example.com",
};
const GENERATED = ["DATABASE_URL", "REDIS_URL"];

const GCTX = {
  orgRepo: "heavy-duty/incubator",
  env: "prod",
  instance: "default",
  store: "/s/secrets/incubator.prod.env.age",
  recipient: "age1abc",
  project: "incubator",
  environment: "production",
};

// The mapping is stated, then the plan is built from it.
const planWith = (
  from: Record<string, string>,
  store = STORE,
  databases = [PG, REDIS],
  opts?: { force: boolean },
) => {
  const { mapping, unmapped } = resolveGeneratedSources(
    GENERATED,
    databases,
    from,
  );
  return planGenerated(GENERATED, store, mapping, unmapped, opts);
};

describe("resolveGeneratedSources", () => {
  // The whole point: the value comes off the DATABASE, not off an app.
  it("maps each generated name to the database the operator named", () => {
    const { mapping, unmapped } = resolveGeneratedSources(
      GENERATED,
      [PG, REDIS],
      { DATABASE_URL: "incubator-db", REDIS_URL: "incubator-redis" },
    );
    expect(unmapped).toEqual([]);
    expect(mapping.DATABASE_URL).toEqual(PG);
    expect(mapping.REDIS_URL).toEqual(REDIS);
  });

  // #29 wearing a different hat. Nothing anywhere says DATABASE_URL comes from
  // the postgres one — inferring it from the NAME is exactly the silent wrong
  // pick this refuses, because what it writes is a well-formed URL to somebody
  // else's database.
  it("refuses to guess when more than one database could be meant", () => {
    const { mapping, unmapped } = resolveGeneratedSources(
      GENERATED,
      [PG, REDIS],
      {},
    );
    expect(mapping).toEqual({});
    expect(unmapped.map((u) => u.ref)).toEqual(["DATABASE_URL", "REDIS_URL"]);
    expect(unmapped[0].why).toMatch(/will not pick by name/);
    // It names the candidates rather than picking one.
    expect(unmapped[0].why).toContain("incubator-db:postgresql");
    expect(unmapped[0].why).toContain("incubator-redis:redis");
  });

  // The one inference that cannot be wrong: nothing else it could be.
  it("infers the only database when there is exactly one, for one name", () => {
    const { mapping, unmapped } = resolveGeneratedSources(
      ["DATABASE_URL"],
      [PG],
      {},
    );
    expect(unmapped).toEqual([]);
    expect(mapping.DATABASE_URL).toEqual(PG);
  });

  // ...and still refuses two names against that one database: filling REDIS_URL
  // from the Postgres would be a perfectly well-formed lie.
  it("does not infer when one database must serve two generated names", () => {
    const { unmapped } = resolveGeneratedSources(GENERATED, [PG], {});
    expect(unmapped.map((u) => u.ref)).toEqual(["DATABASE_URL", "REDIS_URL"]);
  });

  it("refuses a --from naming a database that is not in this project+env", () => {
    const { unmapped } = resolveGeneratedSources(GENERATED, [PG, REDIS], {
      DATABASE_URL: "umami-db",
      REDIS_URL: "incubator-redis",
    });
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0].why).toMatch(/no database named "umami-db" exists/);
  });

  it("refuses when the environment holds no database at all", () => {
    const { unmapped } = resolveGeneratedSources(["DATABASE_URL"], [], {});
    expect(unmapped[0].why).toMatch(/no database exists/);
  });
});

describe("planGenerated", () => {
  it("fills the generated names and keeps every other one byte for byte", () => {
    const p = planWith({
      DATABASE_URL: "incubator-db",
      REDIS_URL: "incubator-redis",
    });
    expect(p.fills).toEqual([
      {
        ref: "DATABASE_URL",
        from: { resource: "incubator-db", type: "postgresql" },
        value: PG.url,
      },
      {
        ref: "REDIS_URL",
        from: { resource: "incubator-redis", type: "redis" },
        value: REDIS.url,
      },
    ]);
    // Untouched — and NOT re-read from the box, which is what makes pass 2 safe
    // to run against an environment whose other secrets were rotated by hand.
    expect(p.kept).toEqual(["ADMIN_EMAIL", "MAILGUN_API_KEY"]);
    expect(p.occupied).toEqual([]);
    expect(p.absent).toEqual([]);
    expect(p.stillPending).toEqual([]);
  });

  // The refusal that stops a silent credential rotation: someone already filled
  // it (a previous pass 2, or by hand) and the value is live.
  it("refuses to overwrite a generated name that already holds a real value", () => {
    const p = planWith(
      { DATABASE_URL: "incubator-db", REDIS_URL: "incubator-redis" },
      { ...STORE, DATABASE_URL: "postgres://already:filled@live/db" },
    );
    expect(p.occupied).toEqual(["DATABASE_URL"]);
    expect(p.fills.map((f) => f.ref)).toEqual(["REDIS_URL"]);
    expect(generatedPlanRefuses(p)).toBe(true);
  });

  it("--force fills it anyway, deliberately", () => {
    const p = planWith(
      { DATABASE_URL: "incubator-db", REDIS_URL: "incubator-redis" },
      { ...STORE, DATABASE_URL: "postgres://already:filled@live/db" },
      [PG, REDIS],
      { force: true },
    );
    expect(p.occupied).toEqual([]);
    expect(p.fills.map((f) => f.ref)).toEqual(["DATABASE_URL", "REDIS_URL"]);
    expect(generatedPlanRefuses(p)).toBe(false);
  });

  // Pass 2 FILLS names; it does not add them. A store missing one did not come
  // from pass 1, and the name-count postcondition could not hold anyway.
  it("refuses a generated name the store does not carry at all", () => {
    const { REDIS_URL, ...withoutRedis } = STORE;
    const p = planWith(
      { DATABASE_URL: "incubator-db", REDIS_URL: "incubator-redis" },
      withoutRedis,
    );
    expect(p.absent).toEqual(["REDIS_URL"]);
    expect(generatedPlanRefuses(p)).toBe(true);
  });

  // A placeholder standing in a name nothing here fills: the run would
  // "succeed" and the store would still be a lie.
  it("refuses when a name nobody fills would be left still pending", () => {
    const p = planWith(
      { DATABASE_URL: "incubator-db", REDIS_URL: "incubator-redis" },
      { ...STORE, SESSION_SECRET: GENERATED_PLACEHOLDER },
    );
    expect(p.stillPending).toEqual(["SESSION_SECRET"]);
    expect(generatedPlanRefuses(p)).toBe(true);
  });

  it("a refused name is not also reported as kept", () => {
    const p = planWith({});
    expect(p.kept).toEqual(["ADMIN_EMAIL", "MAILGUN_API_KEY"]);
    expect(p.unmapped).toHaveLength(2);
  });
});

describe("renderGeneratedPlan", () => {
  // capture.ts:166's rule, unchanged: names, provenance, and the resource a
  // value came FROM. The only value-shaped thing printed is the placeholder
  // literal being replaced.
  it("prints names and never a value", () => {
    const out = renderGeneratedPlan(
      planWith({ DATABASE_URL: "incubator-db", REDIS_URL: "incubator-redis" }),
      GCTX,
    );
    expect(out).not.toContain("REAL-PG-PASSWORD");
    expect(out).not.toContain("REAL-REDIS-PASSWORD");
    expect(out).not.toContain("key-REAL");
    expect(out).toContain("DATABASE_URL");
    expect(out).toContain("incubator-db (postgresql) internal_db_url");
    expect(out).toContain(GENERATED_PLACEHOLDER);
    // The store is not being rewritten around the names it keeps, and says so.
    expect(out).toMatch(/MAILGUN_API_KEY\s+keep/);
  });

  it("hands back a ready-to-paste --from when it will not guess", () => {
    const out = renderGeneratedPlan(planWith({}), GCTX);
    expect(out).toMatch(/refusing to write the store/);
    expect(out).toContain("--from DATABASE_URL=<database name>");
    expect(out).toContain("--from REDIS_URL=<database name>");
  });

  it("says a fill would rotate a live credential", () => {
    const out = renderGeneratedPlan(
      planWith(
        { DATABASE_URL: "incubator-db", REDIS_URL: "incubator-redis" },
        { ...STORE, DATABASE_URL: "postgres://live" },
      ),
      GCTX,
    );
    expect(out).toMatch(/OCCUPIED/);
    expect(out).toMatch(/rotate a live credential/);
    expect(out).not.toContain("postgres://live");
  });
});

// The assertion that was a line in a human runbook ("assert 14 names / zero
// placeholders"), which is to say a step that could be skipped.
describe("assertGeneratedComplete", () => {
  it("passes when every placeholder is gone and the name set is unchanged", () => {
    const after = { ...STORE, DATABASE_URL: PG.url, REDIS_URL: REDIS.url };
    expect(assertGeneratedComplete(STORE, after)).toEqual([]);
  });

  it("catches a placeholder left standing", () => {
    const after = { ...STORE, DATABASE_URL: PG.url };
    const v = assertGeneratedComplete(STORE, after);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(
      /still hold the pending-coolify-generated literal: REDIS_URL/,
    );
  });

  // A store that LOST a name re-encrypts perfectly and reads back perfectly.
  // The failure surfaces at the next apply, in an environment whose plaintext
  // nobody has any more.
  it("catches a name dropped on the way through", () => {
    const { MAILGUN_API_KEY, ...lost } = {
      ...STORE,
      DATABASE_URL: PG.url,
      REDIS_URL: REDIS.url,
    };
    const v = assertGeneratedComplete(STORE, lost);
    expect(v.join(" ")).toMatch(/went in with 4 name\(s\) and came out with 3/);
    expect(v.join(" ")).toMatch(/names LOST: MAILGUN_API_KEY/);
  });

  it("catches a name that was never supposed to be added", () => {
    const after = {
      ...STORE,
      DATABASE_URL: PG.url,
      REDIS_URL: REDIS.url,
      SURPRISE: "x",
    };
    expect(assertGeneratedComplete(STORE, after).join(" ")).toMatch(
      /names ADDED: SURPRISE/,
    );
  });
});
