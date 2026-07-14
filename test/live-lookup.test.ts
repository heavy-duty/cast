import { describe, expect, it, vi } from "vitest";
import { attachBackup, fetchLive, renderAbsentTarget } from "../src/cli.js";
import { CoolifyClient } from "../src/coolify.js";

// A Coolify that answers GET /projects with `projects`, and
// GET /projects/{uuid}/{env} with whatever `envByProject` holds for it
// (undefined → 404, which is how Coolify says "no such environment").
function coolify(
  projects: Array<{ uuid: string; name: string }>,
  envByProject: Record<string, unknown> = {},
): CoolifyClient {
  const fetchImpl = vi.fn(async (url: string | URL) => {
    const path = new URL(String(url)).pathname.replace("/api/v1", "");
    if (path === "/projects") {
      return new Response(JSON.stringify(projects), { status: 200 });
    }
    const m = path.match(/^\/projects\/([^/]+)\/(.+)$/);
    if (m) {
      const body = envByProject[`${m[1]}/${m[2]}`];
      return body === undefined
        ? new Response(JSON.stringify({ message: "Not found." }), {
            status: 404,
          })
        : new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
  return new CoolifyClient("https://coolify.test", "tok", fetchImpl);
}

describe("fetchLive", () => {
  it("returns the live resources when project and environment both exist", async () => {
    const client = coolify([{ uuid: "p1", name: "incubator" }], {
      "p1/prod": {
        applications: [{ name: "core", uuid: "a1" }],
        postgresqls: [{ name: "db", uuid: "d1" }],
      },
    });
    const r = await fetchLive(client, "incubator", "prod");
    expect(r.found).toBe(true);
    if (!r.found) throw new Error("unreachable");
    expect(r.live.map((l) => l.name).sort()).toEqual(["core", "db"]);
  });

  // The bug this whole change exists for: an absent project used to come back
  // as [], which computeDiff reads as "every desired resource is missing" and
  // renders as a confident full-create plan. Absence must be its own answer,
  // distinguishable from an empty-but-real environment.
  it("reports an ABSENT project as absent, not as empty", async () => {
    const client = coolify([
      { uuid: "p1", name: "incubator-prod" },
      { uuid: "p2", name: "umami" },
    ]);
    const r = await fetchLive(client, "incubator", "prod");
    expect(r).toEqual({
      found: false,
      missing: "project",
      project: "incubator",
      available: ["incubator-prod", "umami"],
    });
  });

  // Same lie, a different road: the project is real but the environment name
  // is not. A hand-built project is very often `production`, not `prod`.
  it("reports an ABSENT environment as absent, not as empty", async () => {
    const client = coolify([{ uuid: "p1", name: "incubator" }], {
      "p1/production": { applications: [] },
    });
    const r = await fetchLive(client, "incubator", "prod");
    expect(r).toEqual({
      found: false,
      missing: "environment",
      project: "incubator",
      environment: "prod",
    });
  });

  // The distinction has to be real in BOTH directions, or the gate would just
  // trade a false pass for a false alarm: a project whose environment exists
  // and is genuinely empty is `found`, with zero resources.
  it("distinguishes a real-but-empty environment from an absent one", async () => {
    const client = coolify([{ uuid: "p1", name: "incubator" }], {
      "p1/prod": { applications: [], postgresqls: [], services: [] },
    });
    const r = await fetchLive(client, "incubator", "prod");
    expect(r).toEqual({ found: true, live: [] });
  });

  // #60: a database carries its internal_db_url onto Live (what an app's
  // ${resource:<name>.url} derives from); an application does not. This is the
  // plumbing runProject reads to build its URL map, so it is worth pinning.
  it("plumbs a database's internal_db_url onto Live, and only for databases", async () => {
    const client = coolify([{ uuid: "p1", name: "incubator" }], {
      "p1/prod": {
        applications: [
          { name: "core", uuid: "a1", internal_db_url: "nonsense" },
        ],
        postgresqls: [
          {
            name: "db",
            uuid: "d1",
            internal_db_url: "postgres://u:p@d1:5432/app",
          },
        ],
        redis: [{ name: "cache", uuid: "r1" }],
      },
    });
    const r = await fetchLive(client, "incubator", "prod");
    if (!r.found) throw new Error("unreachable");
    const byName = Object.fromEntries(r.live.map((l) => [l.name, l]));
    expect(byName.db.internalDbUrl).toBe("postgres://u:p@d1:5432/app");
    // An application never carries it — even if the raw record has the key.
    expect(byName.core.internalDbUrl).toBeUndefined();
    // A database whose read carried no URL simply has none (not "").
    expect(byName.cache.internalDbUrl).toBeUndefined();
  });
});

describe("renderAbsentTarget", () => {
  it("names what it looked for, where the name came from, and what exists", () => {
    const msg = renderAbsentTarget(
      {
        found: false,
        missing: "project",
        project: "incubator",
        available: ["incubator-prod", "umami"],
      },
      { orgRepo: "heavy-duty/incubator", overridden: false },
    );
    expect(msg).toMatch(/no project named "incubator"/);
    expect(msg).toMatch(/derived from the repo slug heavy-duty\/incubator/);
    expect(msg).toMatch(/incubator-prod, umami/);
    expect(msg).toMatch(/--project <name>/);
    // The reader must not be able to walk away thinking a clean diff was a pass.
    expect(msg).toMatch(/verified\s+nothing/);
  });

  it("says the name came from --project when it was overridden", () => {
    const msg = renderAbsentTarget(
      {
        found: false,
        missing: "project",
        project: "typo",
        available: ["incubator"],
      },
      { orgRepo: "heavy-duty/incubator", overridden: true },
    );
    expect(msg).toMatch(/\(--project\)/);
  });

  it("points at the UI-naming gotcha when the environment is what is missing", () => {
    const msg = renderAbsentTarget(
      {
        found: false,
        missing: "environment",
        project: "incubator",
        environment: "prod",
      },
      { orgRepo: "heavy-duty/incubator", overridden: false },
    );
    expect(msg).toMatch(/has no environment "prod"/);
    expect(msg).toMatch(/production/);
    expect(msg).toMatch(/--env/);
  });
});

// The read half of #51: a database's backup schedule is on its own route, so
// the live side has to go and get it. These pin the mapping from what that
// route answers onto what the diff is allowed to conclude.
describe("attachBackup", () => {
  const db = () => ({
    kind: "database" as const,
    name: "postgres",
    uuid: "db-1",
    fields: { type: "postgresql" },
  });
  // A Coolify whose GET /databases/db-1/backups answers with `body` (or a
  // status, to exercise the unreachable path).
  const client = (body: unknown, status = 200) =>
    new CoolifyClient(
      "https://coolify.test",
      "tok",
      vi.fn(
        async () =>
          new Response(status === 200 ? JSON.stringify(body) : "boom", {
            status,
          }),
      ) as unknown as typeof fetch,
    );

  it("reads a schedule onto the live fields, in the desired key order", async () => {
    const l = db();
    await attachBackup(
      client([
        {
          uuid: "s1",
          frequency: "0 3 * * *",
          database_backup_retention_amount_locally: 7,
          enabled: true,
        },
      ]),
      l,
    );
    // Key order matters: computeDiff compares by JSON.stringify, against the
    // object resolve.ts builds. Same keys, same order, or every run drifts.
    expect(JSON.stringify(l.fields.backup)).toBe(
      JSON.stringify({ frequency: "0 3 * * *", retention: 7 }),
    );
    expect(l.backupNotCompared).toBeUndefined();
  });

  it("leaves fields.backup absent when the database genuinely has none", async () => {
    const l = db();
    await attachBackup(client([]), l);
    // Absence IS the answer here, and a trustworthy one: a declared backup is
    // then real drift, and apply creates the schedule.
    expect("backup" in l.fields).toBe(false);
    expect(l.backupNotCompared).toBeUndefined();
  });

  it("carries a disabled schedule through as disabled", async () => {
    const l = db();
    await attachBackup(
      client([
        {
          uuid: "s1",
          frequency: "0 3 * * *",
          database_backup_retention_amount_locally: 7,
          enabled: false,
        },
      ]),
      l,
    );
    // The row exists (so apply PATCHes rather than POSTing a second one) but it
    // backs nothing up (so it must not compare equal to a declared block).
    expect(l.fields.backup).toEqual({
      frequency: "0 3 * * *",
      retention: 7,
      enabled: false,
    });
  });

  it("marks the read not-compared when Coolify cannot be read", async () => {
    const l = db();
    await attachBackup(client(null, 500), l);
    expect("backup" in l.fields).toBe(false);
    expect(l.backupNotCompared).toMatch(/unreachable|does not recognize/);
  });

  it("marks the read not-compared when a database carries several schedules", async () => {
    const l = db();
    await attachBackup(
      client([
        {
          uuid: "s1",
          frequency: "0 3 * * *",
          database_backup_retention_amount_locally: 7,
        },
        {
          uuid: "s2",
          frequency: "0 9 * * *",
          database_backup_retention_amount_locally: 2,
        },
      ]),
      l,
    );
    // A manifest declares one schedule. Picking one of two to compare against
    // would be a coin toss reported as a fact.
    expect(l.backupNotCompared).toMatch(/2 schedules/);
    expect("backup" in l.fields).toBe(false);
  });
});
