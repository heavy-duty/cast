import { describe, expect, it } from "vitest";
import {
  type Executor,
  KIND_ORDER,
  applyHostnameOverlay,
  applyPlan,
  completeBasicAuth,
} from "../src/apply.js";
import { GENERATED_PLACEHOLDER } from "../src/capture.js";
import { type Desired, type Live, computeDiff } from "../src/diff.js";

// Wrap plain live values as Coolify's {value, realValue} pairs (here the two
// agree); computeDiff reads them per LiveEnvVar. See diffEnv / #78.
const liveEnv = (
  m: Record<string, string>,
): Record<string, { value: string }> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { value: v }]));

const desired: Desired[] = [
  {
    kind: "application",
    name: "core-api",
    fields: { build_pack: "nixpacks", domains: ["https://api.example.com"] },
    env: { vars: { PORT: { value: "3000", secret: false } } },
  },
];

function recorder(uuidFor: (name: string) => string = () => "new-uuid") {
  const calls: string[] = [];
  const exec: Executor = {
    createResource: async (c) => {
      calls.push(`create ${c.name}`);
      return uuidFor(c.name);
    },
    updateFields: async (uuid, _k, fields) => {
      calls.push(`update ${uuid} ${Object.keys(fields).join(",")}`);
    },
    syncEnv: async (uuid) => {
      calls.push(`env ${uuid}`);
    },
    redeploy: async (uuid) => {
      calls.push(`redeploy ${uuid}`);
    },
  };
  return { calls, exec };
}

describe("applyPlan", () => {
  it("creates, syncs env, then redeploys", async () => {
    const { calls, exec } = recorder();
    const r = await applyPlan(computeDiff(desired, [], "full"), desired, exec);
    expect(calls).toEqual([
      "create core-api",
      "env new-uuid",
      "redeploy new-uuid",
    ]);
    expect(r.mutated).toEqual(["core-api"]);
  });
  it("refuses a structural report before any mutation", async () => {
    const { calls, exec } = recorder();
    await expect(
      applyPlan(computeDiff(desired, [], "structural"), desired, exec),
    ).rejects.toThrow(/full diff/);
    expect(calls).toEqual([]);
  });
  it("refuses non-updatable drift before any mutation, naming the field", async () => {
    const { calls, exec } = recorder();
    const live = [
      {
        kind: "application" as const,
        name: "core-api",
        uuid: "u1",
        fields: { build_pack: "static", domains: ["https://api.example.com"] },
        env: liveEnv({ PORT: "3000" }),
      },
    ];
    await expect(
      applyPlan(computeDiff(desired, live, "full"), desired, exec),
    ).rejects.toThrow(/build_pack.*core-api|core-api.*build_pack/s);
    expect(calls).toEqual([]);
  });
  // #47 — the whole product of the guard. Every assertion here is about a
  // routine `cast apply` against a box that has ALREADY been applied once: the
  // store still holds `pending-coolify-generated` for the secrets Coolify was
  // asked to generate, and Coolify has since generated them.
  describe("generated-secret placeholder", () => {
    const REAL_URL = "postgres://real:hunter2@db:5432/app";
    const REAL_REDIS = "redis://real:hunter2@redis:6379";
    const generated: Desired[] = [
      {
        kind: "application",
        name: "core-api",
        fields: { build_pack: "nixpacks" },
        env: {
          vars: {
            DATABASE_URL: { value: GENERATED_PLACEHOLDER, secret: true },
            REDIS_URL: { value: GENERATED_PLACEHOLDER, secret: true },
            PORT: { value: "3000", secret: false },
          },
        },
      },
    ];
    const liveApp = (env: Record<string, string>) => [
      {
        kind: "application" as const,
        name: "core-api",
        uuid: "u1",
        fields: { build_pack: "nixpacks" },
        env: liveEnv(env),
      },
    ];

    it("REFUSES before any mutation — no syncEnv, no redeploy, nothing touched", async () => {
      const { calls, exec } = recorder();
      const report = computeDiff(
        generated,
        liveApp({
          DATABASE_URL: REAL_URL,
          REDIS_URL: REAL_REDIS,
          PORT: "3000",
        }),
        "full",
      );
      await expect(applyPlan(report, generated, exec)).rejects.toThrow(
        /refusing apply/,
      );
      expect(calls).toEqual([]);
    });
    it("names every conflicted key and its resource", async () => {
      const { exec } = recorder();
      const report = computeDiff(
        generated,
        liveApp({ DATABASE_URL: REAL_URL, REDIS_URL: REAL_REDIS }),
        "full",
      );
      const err = await applyPlan(report, generated, exec).catch(
        (e: Error) => e.message,
      );
      expect(err).toContain("DATABASE_URL on application core-api");
      expect(err).toContain("REDIS_URL on application core-api");
      expect(err).toContain(GENERATED_PLACEHOLDER);
    });
    it("never prints the live value it is protecting", async () => {
      const { exec } = recorder();
      const report = computeDiff(
        generated,
        liveApp({ DATABASE_URL: REAL_URL, REDIS_URL: REAL_REDIS }),
        "full",
      );
      const err = await applyPlan(report, generated, exec).catch(
        (e: Error) => e.message,
      );
      expect(err).not.toContain(REAL_URL);
      expect(err).not.toContain(REAL_REDIS);
      expect(err).not.toContain("hunter2");
    });
    it("tells the operator what to do about it (#48)", async () => {
      const { exec } = recorder();
      const report = computeDiff(
        generated,
        liveApp({ DATABASE_URL: REAL_URL, REDIS_URL: REAL_REDIS }),
        "full",
      );
      const err = await applyPlan(report, generated, exec).catch(
        (e: Error) => e.message,
      );
      expect(err).toContain("cast capture --generated-only");
      expect(err).toContain("#48");
      expect(err).toContain("generated_secrets:");
    });
    it("refuses even when the conflict rides along with legitimate drift", async () => {
      const { calls, exec } = recorder();
      const withDomain: Desired[] = [
        {
          ...generated[0],
          fields: { build_pack: "nixpacks", domains: ["https://new.example"] },
        },
      ];
      const report = computeDiff(
        withDomain,
        liveApp({
          DATABASE_URL: REAL_URL,
          REDIS_URL: REAL_REDIS,
          PORT: "3000",
        }),
        "full",
      );
      await expect(applyPlan(report, withDomain, exec)).rejects.toThrow(
        /refusing apply/,
      );
      // The updatable field drift is real and would otherwise have been applied.
      // The refusal is not a filter: nothing at all goes out.
      expect(calls).toEqual([]);
    });
    it("refuses on a conflict carried by a SECOND resource, after a clean first one", async () => {
      const { calls, exec } = recorder();
      const two: Desired[] = [
        {
          kind: "application",
          name: "web",
          fields: { build_pack: "nixpacks" },
          env: { vars: { PORT: { value: "3000", secret: false } } },
        },
        ...generated,
      ];
      const live = [
        {
          kind: "application" as const,
          name: "web",
          uuid: "u0",
          fields: { build_pack: "static" },
          env: liveEnv({ PORT: "3000" }),
        },
        ...liveApp({ DATABASE_URL: REAL_URL, REDIS_URL: REAL_REDIS }),
      ];
      // `web` also carries non-updatable drift, so if the refusals were ordered
      // the other way this would throw for the wrong reason — the data-loss
      // write is the one an operator must be told about first.
      const report = computeDiff(two, live, "full");
      await expect(applyPlan(report, two, exec)).rejects.toThrow(
        /refusing apply.*DATABASE_URL/s,
      );
      expect(calls).toEqual([]);
    });
    // The FIRST apply, which must keep working: the placeholder is what cast is
    // supposed to send, because Coolify replaces it when it creates the resource.
    it("still sends the placeholder on a create", async () => {
      const { calls, exec } = recorder();
      const r = await applyPlan(
        computeDiff(generated, [], "full"),
        generated,
        exec,
      );
      expect(calls).toEqual([
        "create core-api",
        "env new-uuid",
        "redeploy new-uuid",
      ]);
      expect(r.mutated).toEqual(["core-api"]);
    });
    // Applied once, resources not yet generated (or generated as the placeholder
    // — same thing to cast). Nothing differs, so there is nothing to refuse.
    it("proceeds when the live value is the placeholder too", async () => {
      const { calls, exec } = recorder();
      const report = computeDiff(
        generated,
        liveApp({
          DATABASE_URL: GENERATED_PLACEHOLDER,
          REDIS_URL: GENERATED_PLACEHOLDER,
          PORT: "3000",
        }),
        "full",
      );
      const r = await applyPlan(report, generated, exec);
      expect(calls).toEqual([]);
      expect(r.mutated).toEqual([]);
    });
    // A var the manifest declares and the live resource has never had: writing
    // the placeholder is the only thing cast can do, and it is what the first
    // apply's second pass needs.
    it("proceeds when the generated var is absent live", async () => {
      const { calls, exec } = recorder();
      const report = computeDiff(generated, liveApp({ PORT: "3000" }), "full");
      const r = await applyPlan(report, generated, exec);
      expect(calls).toEqual(["env u1", "redeploy u1"]);
      expect(r.mutated).toEqual(["core-api"]);
    });
    // The guard must not turn every secret rotation into a refusal — that is the
    // failure that gets a guard disabled.
    it("still applies an ordinary secret rotation", async () => {
      const { calls, exec } = recorder();
      const rotated: Desired[] = [
        {
          kind: "application",
          name: "core-api",
          fields: { build_pack: "nixpacks" },
          env: { vars: { MAILGUN_KEY: { value: "mk-NEW", secret: true } } },
        },
      ];
      const report = computeDiff(
        rotated,
        liveApp({ MAILGUN_KEY: "mk-OLD" }),
        "full",
      );
      const r = await applyPlan(report, rotated, exec);
      expect(calls).toEqual(["env u1", "redeploy u1"]);
      expect(r.mutated).toEqual(["core-api"]);
    });
  });

  it("does nothing on a clean report", async () => {
    const { calls, exec } = recorder();
    const live = [
      {
        kind: "application" as const,
        name: "core-api",
        uuid: "u1",
        fields: {
          build_pack: "nixpacks",
          domains: ["https://api.example.com"],
        },
        env: liveEnv({ PORT: "3000" }),
      },
    ];
    const r = await applyPlan(
      computeDiff(desired, live, "full"),
      desired,
      exec,
    );
    expect(calls).toEqual([]);
    expect(r.mutated).toEqual([]);
  });
  it("does nothing when the only drift is a remove-candidate env var", async () => {
    const { calls, exec } = recorder();
    const live = [
      {
        kind: "application" as const,
        name: "core-api",
        uuid: "u1",
        fields: {
          build_pack: "nixpacks",
          domains: ["https://api.example.com"],
        },
        env: liveEnv({ PORT: "3000", LEGACY_VAR: "keep-me" }),
      },
    ];
    const report = computeDiff(desired, live, "full");
    expect(report.changes).toEqual([
      {
        kind: "application",
        name: "core-api",
        uuid: "u1",
        op: "update",
        fieldDiffs: [],
        envDiffs: [
          { key: "LEGACY_VAR", state: "remove-candidate", secret: false },
        ],
      },
    ]);
    const r = await applyPlan(report, desired, exec);
    expect(calls).toEqual([]);
    expect(r.mutated).toEqual([]);
  });
});

// The order resolve.ts actually emits (`desiredFromManifest`: applications,
// then databases, then services) and `computeDiff` faithfully preserves. This
// is the input that used to build and deploy `core` against nothing.
const manifestOrder: Desired[] = [
  {
    kind: "application",
    name: "core",
    fields: { build_pack: "dockercompose" },
    env: { vars: { DATABASE_URL: { value: "postgres://x", secret: true } } },
  },
  { kind: "database", name: "postgres", fields: { type: "postgresql" } },
  { kind: "database", name: "redis", fields: { type: "redis" } },
  { kind: "service", name: "metabase", fields: { type: "metabase" } },
];
const named = (name: string) => `${name}-uuid`;

describe("applyPlan ordering (#45)", () => {
  it("creates databases, then services, then applications — never the manifest's order", async () => {
    const { calls, exec } = recorder(named);
    const report = computeDiff(manifestOrder, [], "full");
    // The report itself reads in manifest order: application first.
    expect(report.changes.map((c) => c.name)).toEqual([
      "core",
      "postgres",
      "redis",
      "metabase",
    ]);
    const r = await applyPlan(report, manifestOrder, exec);
    // …and apply ACTS in dependency order. `core` is created and deployed last,
    // by which point both databases and the service exist. Within a kind the
    // manifest's order survives (postgres before redis) — the sort is stable.
    expect(calls).toEqual([
      "create postgres",
      "redeploy postgres-uuid",
      "create redis",
      "redeploy redis-uuid",
      "create metabase",
      "redeploy metabase-uuid",
      "create core",
      "env core-uuid",
      "redeploy core-uuid",
    ]);
    expect(r.mutated).toEqual(["postgres", "redis", "metabase", "core"]);
  });

  it("orders updates too, not only creates", async () => {
    // The apply that adds a Redis and points an existing app at it: the
    // database must be created and started before the app redeploys onto it.
    const { calls, exec } = recorder(named);
    const withRedis: Desired[] = [
      {
        kind: "application",
        name: "core",
        fields: { build_pack: "dockercompose" },
        env: {
          vars: { REDIS_URL: { value: "redis://redis:6379", secret: false } },
        },
      },
      { kind: "database", name: "redis", fields: { type: "redis" } },
    ];
    const live: Live[] = [
      {
        kind: "application",
        name: "core",
        uuid: "u-core",
        fields: { build_pack: "dockercompose" },
        env: {},
      },
    ];
    const r = await applyPlan(
      computeDiff(withRedis, live, "full"),
      withRedis,
      exec,
    );
    expect(calls).toEqual([
      "create redis",
      "redeploy redis-uuid",
      "env u-core",
      "redeploy u-core",
    ]);
    expect(r.mutated).toEqual(["redis", "core"]);
  });

  it("still refuses non-updatable drift before ANY mutation, even one that now sorts first", async () => {
    // The regression the reorder could have introduced: the database sorts
    // ahead of the application, so a check folded into the ordered walk would
    // create postgres and only then refuse. The refusal is a full scan first.
    const { calls, exec } = recorder(named);
    const live: Live[] = [
      {
        kind: "application",
        name: "core",
        uuid: "u-core",
        fields: { build_pack: "nixpacks" }, // NON_UPDATABLE drift
        env: liveEnv({ DATABASE_URL: "postgres://x" }),
      },
    ];
    await expect(
      applyPlan(computeDiff(manifestOrder, live, "full"), manifestOrder, exec),
    ).rejects.toThrow(/build_pack/);
    expect(calls).toEqual([]);
  });

  it("does not reorder the report itself — the diff reads in manifest order", async () => {
    // renderDiff and the fleet summary read `report.changes`; sorting it in
    // place would silently reshuffle what the operator sees.
    const { exec } = recorder(named);
    const report = computeDiff(manifestOrder, [], "full");
    await applyPlan(report, manifestOrder, exec);
    expect(report.changes.map((c) => c.name)).toEqual([
      "core",
      "postgres",
      "redis",
      "metabase",
    ]);
    // and the rest of the report is untouched by ordering
    expect(report.clean).toBe(false);
    expect(report.orphans).toEqual([]);
  });

  it("exports the forward kind-order, whose reverse is the teardown order", () => {
    expect(KIND_ORDER).toEqual(["database", "service", "application"]);
    // `cast destroy` (#43) is the exact reverse — up in dependency order, down
    // in reverse. It defines its own constant today; a follow-up unifies them.
    expect([...KIND_ORDER].reverse()).toEqual([
      "application",
      "service",
      "database",
    ]);
  });
});

describe("applyHostnameOverlay", () => {
  it("replaces only domains of named apps", () => {
    const out = applyHostnameOverlay(desired, {
      "core-api": ["http://tmp.example.net"],
    });
    expect(out[0].fields.domains).toEqual(["http://tmp.example.net"]);
    expect(out[0].fields.build_pack).toBe("nixpacks");
    expect(desired[0].fields.domains).toEqual(["https://api.example.com"]); // input untouched
  });
  it("throws on unknown app names", () => {
    expect(() => applyHostnameOverlay(desired, { nope: ["http://x"] })).toThrow(
      /unknown.*nope/i,
    );
  });

  const composeDesired: Desired[] = [
    {
      kind: "application",
      name: "core",
      fields: {
        build_pack: "dockercompose",
        docker_compose_location: "docker-compose.yaml",
        docker_compose_domains: {
          api: ["http://api.<PROD-IP>.sslip.io"],
          landing: ["http://landing.<PROD-IP>.sslip.io"],
        },
      },
    },
  ];

  it("rewrites docker_compose_domains per-service when the overlay value is a map", () => {
    const out = applyHostnameOverlay(composeDesired, {
      core: { api: ["http://api.override.example.net"] },
    });
    expect(out[0].fields.docker_compose_domains).toEqual({
      api: ["http://api.override.example.net"],
      landing: ["http://landing.<PROD-IP>.sslip.io"],
    });
    // input untouched
    expect(composeDesired[0].fields.docker_compose_domains).toEqual({
      api: ["http://api.<PROD-IP>.sslip.io"],
      landing: ["http://landing.<PROD-IP>.sslip.io"],
    });
  });
  it("throws on an unknown service key in a map overlay, listing known services", () => {
    expect(() =>
      applyHostnameOverlay(composeDesired, {
        core: { bogus: ["http://x"] },
      }),
    ).toThrow(/bogus.*(api|landing)/is);
  });
  it("throws when a map-shaped overlay value names a non-compose app", () => {
    expect(() =>
      applyHostnameOverlay(desired, {
        "core-api": { api: ["http://x"] },
      }),
    ).toThrow(/service map for non-compose app core-api/);
  });
  it("keeps today's behavior for a string[]-shaped entry on a plain app", () => {
    const out = applyHostnameOverlay(desired, {
      "core-api": ["http://plain.example.net"],
    });
    expect(out[0].fields.domains).toEqual(["http://plain.example.net"]);
  });
});

// cast#76. An update body is built from the fields that CHANGED, and basic auth
// cannot be written that way: Coolify requires both credentials on any write
// that enables it, and the password never shows up as a change because it is
// never read back. So the payload is completed from the declared spec — and
// only when a write was already happening.
describe("completeBasicAuth", () => {
  const spec: Desired = {
    kind: "application",
    name: "admin",
    fields: {
      build_pack: "nixpacks",
      is_http_basic_auth_enabled: true,
      http_basic_auth_username: "ops",
      http_basic_auth_password: "s3cret",
    },
  };

  it("fills in the credentials when only the toggle drifted", () => {
    expect(
      completeBasicAuth({ is_http_basic_auth_enabled: true }, spec),
    ).toEqual({
      is_http_basic_auth_enabled: true,
      http_basic_auth_username: "ops",
      http_basic_auth_password: "s3cret",
    });
  });

  it("fills in the password when only the username drifted", () => {
    expect(
      completeBasicAuth(
        { is_http_basic_auth_enabled: true, http_basic_auth_username: "ops" },
        spec,
      ).http_basic_auth_password,
    ).toBe("s3cret");
  });

  it("leaves a payload that is not enabling basic auth completely alone", () => {
    // The load-bearing half: this must not MANUFACTURE a write. A run where
    // nothing about basic auth drifted sends nothing about basic auth.
    expect(completeBasicAuth({ domains: ["https://a"] }, spec)).toEqual({
      domains: ["https://a"],
    });
  });

  it("adds no credentials to a disable", () => {
    expect(
      completeBasicAuth({ is_http_basic_auth_enabled: false }, spec),
    ).toEqual({ is_http_basic_auth_enabled: false });
  });

  it("does not invent values the spec does not carry", () => {
    // Then applicationApiFields refuses at the wire — one clear error, rather
    // than a request Coolify 422s halfway through a run.
    expect(
      completeBasicAuth({ is_http_basic_auth_enabled: true }, undefined),
    ).toEqual({ is_http_basic_auth_enabled: true });
  });
});

// The honest limit, asserted rather than described: a password rotated in the
// store with nothing else changed produces NO write, because there is no field
// diff to carry it. `cast diff` prints "NOT compared" on that run — the failure
// is visible, not silent — and this test exists so the day someone makes the
// password diffable, it goes red and they read the comment.
describe("applyPlan — a password-only rotation writes nothing (#76)", () => {
  it("makes no call at all when the readable halves agree", async () => {
    const { calls, exec } = recorder();
    const declared: Desired[] = [
      {
        kind: "application",
        name: "admin",
        fields: {
          build_pack: "nixpacks",
          is_http_basic_auth_enabled: true,
          http_basic_auth_username: "ops",
          http_basic_auth_password: "the-NEW-password",
        },
      },
    ];
    const live: Live[] = [
      {
        kind: "application",
        name: "admin",
        uuid: "u1",
        fields: {
          build_pack: "nixpacks",
          is_http_basic_auth_enabled: true,
          http_basic_auth_username: "ops",
        },
        basicAuthNotCompared: "password is never read back",
      },
    ];
    const report = computeDiff(declared, live, "full");
    await applyPlan(report, declared, exec);
    expect(calls).toEqual([]);
    // …and the run says so, rather than reading as a verified match.
    expect(report.basicAuthNotCompared).toHaveLength(1);
  });
});
