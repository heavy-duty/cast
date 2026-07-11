import { describe, expect, it } from "vitest";
import { computeDiff, renderDiff } from "../src/diff.js";

const desiredApp = {
  kind: "application" as const,
  name: "core-api",
  fields: { build_pack: "nixpacks", domains: ["https://api.example.com"] },
  env: {
    vars: {
      PORT: { value: "3000", secret: false },
      MAILGUN_KEY: { value: "mk-123", secret: true },
    },
  },
};

describe("computeDiff", () => {
  it("plans a create when live is missing", () => {
    const r = computeDiff([desiredApp], [], "full");
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].op).toBe("create");
    expect(r.clean).toBe(false);
  });
  it("is clean when live matches", () => {
    const r = computeDiff(
      [desiredApp],
      [
        {
          kind: "application",
          name: "core-api",
          uuid: "u1",
          fields: { ...desiredApp.fields },
          env: { PORT: "3000", MAILGUN_KEY: "mk-123" },
        },
      ],
      "full",
    );
    expect(r.clean).toBe(true);
  });
  it("marks build_pack drift as non-updatable", () => {
    const r = computeDiff(
      [desiredApp],
      [
        {
          kind: "application",
          name: "core-api",
          uuid: "u1",
          fields: { build_pack: "static", domains: desiredApp.fields.domains },
          env: { PORT: "3000", MAILGUN_KEY: "mk-123" },
        },
      ],
      "full",
    );
    expect(r.changes[0].fieldDiffs).toEqual([
      {
        field: "build_pack",
        desired: "nixpacks",
        live: "static",
        updatable: false,
      },
    ]);
  });
  it("full mode diffs env; structural mode does not", () => {
    const live = [
      {
        kind: "application" as const,
        name: "core-api",
        uuid: "u1",
        fields: { ...desiredApp.fields },
        env: { PORT: "3000", MAILGUN_KEY: "OLD", EXTRA: "x" },
      },
    ];
    const full = computeDiff([desiredApp], live, "full");
    expect(full.changes[0].envDiffs).toEqual([
      { key: "MAILGUN_KEY", state: "change", secret: true },
      { key: "EXTRA", state: "remove-candidate", secret: false },
    ]);
    expect(computeDiff([desiredApp], live, "structural").clean).toBe(true);
  });
  it("reports orphans, never plans deletion", () => {
    const r = computeDiff(
      [],
      [{ kind: "service", name: "old-thing", uuid: "u9", fields: {} }],
      "full",
    );
    expect(r.changes).toHaveLength(0);
    expect(r.orphans).toEqual([
      { kind: "service", name: "old-thing", uuid: "u9" },
    ]);
    expect(r.clean).toBe(false);
  });
});

describe("renderDiff", () => {
  it("never prints secret values", () => {
    const live = [
      {
        kind: "application" as const,
        name: "core-api",
        uuid: "u1",
        fields: { ...desiredApp.fields },
        env: { PORT: "3000", MAILGUN_KEY: "OLD-SECRET" },
      },
    ];
    const out = renderDiff(computeDiff([desiredApp], live, "full"));
    expect(out).toContain("secret MAILGUN_KEY differs");
    expect(out).not.toContain("mk-123");
    expect(out).not.toContain("OLD-SECRET");
  });
  it("structural mode says env was not compared", () => {
    const out = renderDiff(computeDiff([desiredApp], [], "structural"));
    expect(out).toMatch(/env vars not compared \(structural mode/);
  });
});
