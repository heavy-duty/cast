import { describe, expect, it } from "vitest";
import {
  type Executor,
  KIND_ORDER,
  applyHostnameOverlay,
  applyPlan,
} from "../src/apply.js";
import { type Desired, type Live, computeDiff } from "../src/diff.js";

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
        env: { PORT: "3000" },
      },
    ];
    await expect(
      applyPlan(computeDiff(desired, live, "full"), desired, exec),
    ).rejects.toThrow(/build_pack.*core-api|core-api.*build_pack/s);
    expect(calls).toEqual([]);
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
        env: { PORT: "3000" },
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
        env: { PORT: "3000", LEGACY_VAR: "keep-me" },
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
        env: { DATABASE_URL: "postgres://x" },
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
