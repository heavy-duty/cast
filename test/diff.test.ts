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

// The destination can never be diffed the way a field is: Coolify 4.1.2 takes
// destination_uuid on write and returns destination_id on read, with nothing
// mapping between them. So it is REPORTED rather than compared — and the one
// thing that IS comparable (a project's live resources against each other)
// carries the check that matters.
//
// Placement is measured against the live side ALONE, so these fixtures pair each
// live resource with a matching desired one: otherwise every resource is an
// orphan, and `clean` would be false for reasons that have nothing to do with
// the destination.
const want = (name: string) => ({
  kind: "application" as const,
  name,
  fields: {},
});
const got = (name: string, destinationId?: number) => ({
  kind: "application" as const,
  name,
  uuid: `u-${name}`,
  fields: {},
  destinationId,
});

describe("computeDiff placement", () => {
  it("is not split when every resource shares one destination", () => {
    const r = computeDiff(
      [want("a"), want("b")],
      [got("a", 3), got("b", 3)],
      "structural",
    );
    expect(r.placement.split).toBe(false);
    expect(r.placement.groups).toEqual([
      { destinationId: 3, resources: ["application a", "application b"] },
    ]);
    expect(r.clean).toBe(true);
  });

  // A project whose resources straddle two networks is a project whose
  // isolation is broken — drift, not silence. Same disposition as an orphan:
  // reported, counted, never repaired.
  it("reports a split project as drift, and is not clean", () => {
    const r = computeDiff(
      [want("a"), want("b")],
      [got("a", 3), got("b", 7)],
      "structural",
    );
    expect(r.placement.split).toBe(true);
    expect(r.placement.groups).toEqual([
      { destinationId: 3, resources: ["application a"] },
      { destinationId: 7, resources: ["application b"] },
    ]);
    expect(r.clean).toBe(false);
    // ...and apply is not offered a way to "fix" it.
    expect(r.changes).toHaveLength(0);
  });

  // A resource Coolify reports no destination for is no evidence of a split.
  it("ignores resources with no destination rather than grouping them", () => {
    const r = computeDiff(
      [want("a"), want("b")],
      [got("a", 3), got("b")],
      "structural",
    );
    expect(r.placement.split).toBe(false);
    expect(r.placement.groups).toEqual([
      { destinationId: 3, resources: ["application a"] },
    ]);
    expect(r.clean).toBe(true);
  });

  it("carries the declared destination through without comparing it", () => {
    const r = computeDiff([want("a")], [got("a", 3)], "structural", {
      declaredDestination: "dest-abc",
    });
    expect(r.placement.declared).toBe("dest-abc");
    // Declaring one does not make the project dirty — there is nothing to
    // compare it against, and a phantom "update" would never clear.
    expect(r.clean).toBe(true);
    expect(r.changes).toHaveLength(0);
  });
});

describe("renderDiff placement", () => {
  it("says out loud that a declared destination was NOT compared", () => {
    const out = renderDiff(
      computeDiff([want("a")], [got("a", 3)], "structural", {
        declaredDestination: "dest-abc",
      }),
    );
    expect(out).toContain("dest-abc");
    expect(out).toMatch(/NOT compared/);
    expect(out).toMatch(/placement: all resources on destination 3/);
  });

  // The whole reason placement is in the report at all: a destination that read
  // back as absent rather than wrong is the failure shape #12/#14/#17/#18 are
  // about.
  //
  // This test used to assert the opposite — that an undeclared, unsplit box says
  // NOTHING about placement, on the grounds that a line on every diff is how a
  // report stops being read. #41 reversed it. Declaring nothing is not the absence
  // of a placement decision, it is a placement decision: cast sends no
  // destination_uuid and Coolify picks. Leaving that inference in a source comment
  // is what made it invisible until the day it was wrong — a first apply against a
  // multi-destination server, 400ing after the run had already created the project
  // and the environment. It is a fact about what the next create will do, so it is
  // on screen while it is still true.
  it("says out loud that an undeclared placement is the server's default", () => {
    const out = renderDiff(
      computeDiff([want("a")], [got("a", 3)], "structural"),
    );
    expect(out).toMatch(
      /placement: server's default destination \(none declared\)/,
    );
    // ...and the consequence, which is the only part that can hurt: on a server
    // with more than one destination this is not a default, it is a 400.
    expect(out).toMatch(/refuses the create/);
    // Still clean: an undeclared destination is an assumption, not drift.
    expect(out).toContain("clean");
  });

  // The claim above is about the UNDECLARED case only. A declared destination
  // makes the opposite statement (it was sent, and cannot be verified) and must
  // never make both.
  it("does not call a declared destination the server's default", () => {
    const out = renderDiff(
      computeDiff([want("a")], [got("a", 3)], "structural", {
        declaredDestination: "dest-abc",
      }),
    );
    expect(out).toMatch(/NOT compared/);
    expect(out).not.toMatch(/none declared/);
  });

  it("names every resource on each side of a split", () => {
    const out = renderDiff(
      computeDiff(
        [want("core"), want("landing")],
        [got("core", 3), got("landing", 7)],
        "structural",
      ),
    );
    expect(out).toMatch(/split placement: these resources sit on 2 different/);
    expect(out).toContain("destination 3: application core");
    expect(out).toContain("destination 7: application landing");
    expect(out).toMatch(/apply never moves a live resource between networks/);
    expect(out).toMatch(/split placement$/m);
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
