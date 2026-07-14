import { describe, expect, it } from "vitest";
import { GENERATED_PLACEHOLDER } from "../src/capture.js";
import { computeDiff, placeholderConflicts, renderDiff } from "../src/diff.js";

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

// The second pass of the two-pass bootstrap (#47). The store holds the literal
// `pending-coolify-generated` for a provider-generated secret; once the first
// apply has run, Coolify holds the real one. Every fixture here is that state.
const REAL_URL = "postgres://real:secret@db:5432/app";
const generatedApp = {
  kind: "application" as const,
  name: "core-api",
  fields: {},
  env: {
    vars: {
      // The env var KEY. In the real manifest the store REF behind it is
      // `DATABASE_URL_PROD` — the two differ, which is why the guard is keyed
      // on the store's VALUE and not on the `generated_secrets:` name list.
      DATABASE_URL: { value: GENERATED_PLACEHOLDER, secret: true },
      PORT: { value: "3000", secret: false },
    },
  },
};
const liveGenerated = (env: Record<string, string>) => [
  {
    kind: "application" as const,
    name: "core-api",
    uuid: "u1",
    fields: {},
    env,
  },
];

describe("computeDiff generated-secret placeholder", () => {
  it("flags a placeholder-in-store vs real-value-live as a conflict, not a change", () => {
    const r = computeDiff(
      [generatedApp],
      liveGenerated({ DATABASE_URL: REAL_URL, PORT: "3000" }),
      "full",
    );
    expect(r.changes[0].envDiffs).toEqual([
      { key: "DATABASE_URL", state: "placeholder-conflict", secret: true },
    ]);
    expect(r.clean).toBe(false);
    expect(placeholderConflicts(r)).toEqual([
      { kind: "application", name: "core-api", key: "DATABASE_URL" },
    ]);
  });
  it("is clean when the live value is the placeholder too (first apply landed, resource not created yet)", () => {
    const r = computeDiff(
      [generatedApp],
      liveGenerated({ DATABASE_URL: GENERATED_PLACEHOLDER, PORT: "3000" }),
      "full",
    );
    expect(r.clean).toBe(true);
    expect(placeholderConflicts(r)).toEqual([]);
  });
  it("is a plain add — not a conflict — when the var is absent live (the FIRST apply's path)", () => {
    const r = computeDiff(
      [generatedApp],
      liveGenerated({ PORT: "3000" }),
      "full",
    );
    expect(r.changes[0].envDiffs).toEqual([
      { key: "DATABASE_URL", state: "add", secret: true },
    ]);
    expect(placeholderConflicts(r)).toEqual([]);
  });
  it("is a plain add on a create — Coolify replaces the placeholder when it makes the resource", () => {
    const r = computeDiff([generatedApp], [], "full");
    expect(r.changes[0].op).toBe("create");
    expect(r.changes[0].envDiffs).toContainEqual({
      key: "DATABASE_URL",
      state: "add",
      secret: true,
    });
    expect(placeholderConflicts(r)).toEqual([]);
  });
  it("leaves an ordinary secret rotation a plain change", () => {
    const r = computeDiff(
      [desiredApp],
      [
        {
          kind: "application" as const,
          name: "core-api",
          uuid: "u1",
          fields: { ...desiredApp.fields },
          env: { PORT: "3000", MAILGUN_KEY: "mk-OLD" },
        },
      ],
      "full",
    );
    expect(r.changes[0].envDiffs).toEqual([
      { key: "MAILGUN_KEY", state: "change", secret: true },
    ]);
    expect(placeholderConflicts(r)).toEqual([]);
  });
  // A non-secret template literal that happens to read `pending-coolify-generated`
  // came from the template, not the store — nothing generated it, and writing it
  // is what the manifest asked for.
  it("does not flag a non-secret var whose literal value happens to be the placeholder", () => {
    const r = computeDiff(
      [
        {
          kind: "application" as const,
          name: "core-api",
          fields: {},
          env: {
            vars: { NOTE: { value: GENERATED_PLACEHOLDER, secret: false } },
          },
        },
      ],
      liveGenerated({ NOTE: "something-else" }),
      "full",
    );
    expect(r.changes[0].envDiffs).toEqual([
      { key: "NOTE", state: "change", secret: false },
    ]);
    expect(placeholderConflicts(r)).toEqual([]);
  });
  it("is invisible to a structural diff, which reads no env at all", () => {
    const r = computeDiff(
      [generatedApp],
      liveGenerated({ DATABASE_URL: REAL_URL }),
      "structural",
    );
    expect(placeholderConflicts(r)).toEqual([]);
    expect(r.clean).toBe(true);
  });
});

describe("renderDiff generated-secret placeholder", () => {
  it("says it in words no rotation prints, and never prints the live value", () => {
    const out = renderDiff(
      computeDiff(
        [generatedApp],
        liveGenerated({ DATABASE_URL: REAL_URL, PORT: "3000" }),
        "full",
      ),
    );
    expect(out).toContain(
      "secret DATABASE_URL: store holds the generated-secret PLACEHOLDER, live holds a real value — apply would OVERWRITE it",
    );
    // The old line — the one a rotation prints — must NOT be what this reports.
    expect(out).not.toContain("secret DATABASE_URL differs");
    // Loud in the tail as well: the summary is the line read before typing apply.
    expect(out).toContain(
      "1 generated-secret PLACEHOLDER conflict(s) — apply will REFUSE",
    );
    // Names the key, never the value — capture's rule (a secret printed to a
    // terminal is a secret in a scrollback buffer).
    expect(out).not.toContain(REAL_URL);
    expect(out).not.toContain("real:secret");
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

// A database's backup schedule is a field like any other — the whole point of
// #51. These pin the four answers a live read can give, and above all pin the
// two that must never be confused: "there is no schedule" (drift, fixable) and
// "cast could not read the schedule" (not drift, not clean, said out loud).
describe("backup schedules", () => {
  const wantBackup = {
    kind: "database" as const,
    name: "postgres",
    fields: {
      type: "postgresql",
      backup: { frequency: "0 3 * * *", retention: 7 },
    },
  };
  const liveDb = (fields: Record<string, unknown>, extra = {}) => ({
    kind: "database" as const,
    name: "postgres",
    uuid: "db-1",
    fields: { type: "postgresql", ...fields },
    ...extra,
  });

  it("is clean when the live schedule matches", () => {
    const r = computeDiff(
      [wantBackup],
      [liveDb({ backup: { frequency: "0 3 * * *", retention: 7 } })],
      "full",
    );
    expect(r.clean).toBe(true);
    expect(r.backupsNotCompared).toEqual([]);
  });

  it("reports drift when the schedule differs", () => {
    const r = computeDiff(
      [wantBackup],
      [liveDb({ backup: { frequency: "0 5 * * *", retention: 3 } })],
      "full",
    );
    expect(r.changes[0].fieldDiffs).toEqual([
      {
        field: "backup",
        desired: { frequency: "0 3 * * *", retention: 7 },
        live: { frequency: "0 5 * * *", retention: 3 },
        updatable: true,
      },
    ]);
    expect(r.clean).toBe(false);
  });

  // The defect in one test: a live database with NO schedule, declared in the
  // manifest, used to be invisible. It is drift, and apply can fix it.
  it("reports drift when the database has no schedule at all", () => {
    const r = computeDiff([wantBackup], [liveDb({})], "full");
    expect(r.clean).toBe(false);
    expect(r.changes[0].fieldDiffs[0]).toMatchObject({
      field: "backup",
      live: undefined,
      updatable: true,
    });
  });

  // A schedule row that exists but is switched off backs nothing up. It must
  // not read as clean, and it must not read as absent (apply PATCHes it rather
  // than POSTing a second one).
  it("reports drift when the schedule exists but is disabled", () => {
    const r = computeDiff(
      [wantBackup],
      [
        liveDb({
          backup: { frequency: "0 3 * * *", retention: 7, enabled: false },
        }),
      ],
      "full",
    );
    expect(r.clean).toBe(false);
    expect(r.changes[0].fieldDiffs[0].field).toBe("backup");
  });

  // The shape-mismatch path — the one that must not lie in EITHER direction.
  it("invents no drift when the live schedule could not be read", () => {
    const r = computeDiff(
      [wantBackup],
      [liveDb({}, { backupNotCompared: "unrecognized shape" })],
      "full",
    );
    // Not drift: cast read nothing, so it may claim nothing. In particular it
    // must NOT diff the declared block against `undefined` and report a
    // confident change on a database that may be perfectly backed up.
    expect(r.changes).toEqual([]);
    // And not silence either.
    expect(r.backupsNotCompared).toEqual([
      { name: "postgres", reason: "unrecognized shape" },
    ]);
  });

  it("says so on screen, on a run that is otherwise clean", () => {
    const out = renderDiff(
      computeDiff(
        [wantBackup],
        [liveDb({}, { backupNotCompared: "unrecognized shape" })],
        "full",
      ),
    );
    expect(out).toContain(
      "backup schedule for database postgres declared, NOT compared — verify in the Coolify UI",
    );
    expect(out).toContain("(unrecognized shape)");
    // Reported, but not counted as drift — an absence of evidence is not
    // evidence of drift, and a run that fails on it is a run operators learn
    // to force past.
    expect(out).toMatch(/^clean$/m);
  });

  it("says nothing about backups when none is declared", () => {
    // An undeclared schedule is uncompared, not deleted: a live schedule on a
    // database whose manifest is silent is left alone, and unremarked.
    const out = renderDiff(
      computeDiff(
        [
          {
            kind: "database" as const,
            name: "postgres",
            fields: { type: "postgresql" },
          },
        ],
        [liveDb({}, { backupNotCompared: "unrecognized shape" })],
        "full",
      ),
    );
    expect(out).not.toContain("backup");
    expect(out).toMatch(/^clean$/m);
  });
});
