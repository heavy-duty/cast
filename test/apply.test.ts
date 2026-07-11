import { describe, expect, it } from "vitest";
import {
  type Executor,
  applyHostnameOverlay,
  applyPlan,
} from "../src/apply.js";
import { type Desired, computeDiff } from "../src/diff.js";

const desired: Desired[] = [
  {
    kind: "application",
    name: "core-api",
    fields: { build_pack: "nixpacks", domains: ["https://api.example.com"] },
    env: { vars: { PORT: { value: "3000", secret: false } } },
  },
];

function recorder() {
  const calls: string[] = [];
  const exec: Executor = {
    createResource: async (c) => {
      calls.push(`create ${c.name}`);
      return "new-uuid";
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
