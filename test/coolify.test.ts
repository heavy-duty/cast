import { describe, expect, it, vi } from "vitest";
import { CoolifyClient, parseBackupSchedules } from "../src/coolify.js";

// A row as Coolify actually serializes one: a raw ScheduledDatabaseBackup
// Eloquent model (DatabasesController@database_backup_details_uuid, v4.1.2),
// so every column is present and `executions` is eager-loaded alongside.
const row = (over: Record<string, unknown> = {}) => ({
  id: 3,
  uuid: "sched-1",
  team_id: 1,
  enabled: true,
  save_s3: true,
  frequency: "0 3 * * *",
  database_backup_retention_amount_locally: 7,
  database_id: 9,
  database_type: "App\\Models\\StandalonePostgresql",
  s3_storage_id: 2,
  executions: [],
  ...over,
});

function mockFetch(routes: Record<string, unknown>) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`;
    if (!(key in routes)) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("CoolifyClient", () => {
  it("sends bearer auth and resolves servers by name", async () => {
    const fetchImpl = mockFetch({
      "GET /api/v1/servers": [{ uuid: "srv-1", name: "prod-box" }],
    });
    const c = new CoolifyClient("https://coolify.test", "tok", fetchImpl);
    expect(await c.serverUuid("prod-box")).toBe("srv-1");
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect((call[1].headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
  });
  it("throws a named error when a resolver misses", async () => {
    const c = new CoolifyClient(
      "https://coolify.test",
      "tok",
      mockFetch({ "GET /api/v1/servers": [] }),
    );
    await expect(c.serverUuid("nope")).rejects.toThrow(
      /not found in Coolify: server nope/,
    );
  });
  it("surfaces API errors with method, path and status", async () => {
    const c = new CoolifyClient("https://coolify.test", "tok", mockFetch({}));
    await expect(c.get("/projects")).rejects.toThrow(/GET \/projects → 404/);
  });
  it("reads the token's team from /teams/current", async () => {
    const c = new CoolifyClient(
      "https://coolify.test",
      "tok",
      mockFetch({
        "GET /api/v1/teams/current": {
          id: 1,
          name: "heavy-duty",
          personal_team: false,
        },
      }),
    );
    await expect(c.currentTeam()).resolves.toEqual({
      id: 1,
      name: "heavy-duty",
    });
  });
  it("reads version as plain text, not JSON", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("4.1.2", { status: 200 }),
    ) as unknown as typeof fetch;
    const c = new CoolifyClient("https://coolify.test", "tok", fetchImpl);
    await expect(c.version()).resolves.toBe("4.1.2");
  });
  it("reads a database's backup schedules", async () => {
    const c = new CoolifyClient(
      "https://coolify.test",
      "tok",
      mockFetch({ "GET /api/v1/databases/db-1/backups": [row()] }),
    );
    await expect(c.databaseBackupSchedules("db-1")).resolves.toEqual([
      {
        uuid: "sched-1",
        frequency: "0 3 * * *",
        retention: 7,
        enabled: true,
        saveS3: true,
      },
    ]);
  });
  // The dangerous 404. fetchLive reads a 404 as "no live environment" three
  // routes up, and that instinct is WRONG here: Coolify answers a database with
  // no schedules with 200 [], never 404 — a 404 means the database wasn't found.
  // Reading it as "no backups" would report an unbacked-up database as clean and
  // make apply POST a duplicate schedule onto one that already had one.
  it("does not turn a failed read into 'this database has no backups'", async () => {
    const c = new CoolifyClient("https://coolify.test", "tok", mockFetch({}));
    await expect(c.databaseBackupSchedules("db-1")).resolves.toBeUndefined();
  });
});

// The shape cast cannot afford to be wrong about. Every unreadable answer must
// land on `undefined` ("cast cannot say"), and ONLY a genuinely empty list may
// land on `[]` ("there are none") — the two mean opposite things to every
// caller downstream, and to the operator staring at a cutover.
describe("parseBackupSchedules", () => {
  it("reads a well-formed collection", () => {
    expect(parseBackupSchedules([row()])).toEqual([
      {
        uuid: "sched-1",
        frequency: "0 3 * * *",
        retention: 7,
        enabled: true,
        saveS3: true,
      },
    ]);
  });
  it("reads an empty list as a trustworthy 'no schedule', not as unknown", () => {
    expect(parseBackupSchedules([])).toEqual([]);
  });
  it("reads the spec's own placeholder body as unknown, not as 'no schedule'", () => {
    // What the vendored OpenAPI literally documents for this route. If Coolify
    // ever really answered this, cast must not read it as "no backups".
    expect(
      parseBackupSchedules(
        "Content is very complex. Will be implemented later.",
      ),
    ).toBeUndefined();
  });
  it.each([
    ["a non-array object", { data: [] }],
    ["null", null],
    ["a row that is not an object", ["nope"]],
    ["a row with no frequency", [row({ frequency: undefined })]],
    ["a row with a non-string frequency", [row({ frequency: 3 })]],
    [
      "a row with a null retention",
      [row({ database_backup_retention_amount_locally: null })],
    ],
    [
      "a row with a non-numeric retention",
      [row({ database_backup_retention_amount_locally: "many" })],
    ],
  ])("reads %s as unknown", (_label, body) => {
    expect(parseBackupSchedules(body)).toBeUndefined();
  });
  it("collapses the WHOLE read when any one row is unreadable", () => {
    // A partial list is indistinguishable from a complete one downstream, and
    // the caller worth protecting is the one asking "is this backed up?".
    expect(
      parseBackupSchedules([row(), row({ uuid: 7, frequency: null })]),
    ).toBeUndefined();
  });
  it("reads a disabled schedule as disabled, however Coolify spells it", () => {
    // `enabled` has no cast on the model (v4.1.2 casts() covers only the two
    // float storage fields), so a tinyint column can serialize as 1/0.
    expect(parseBackupSchedules([row({ enabled: 0 })])?.[0].enabled).toBe(
      false,
    );
    expect(parseBackupSchedules([row({ enabled: false })])?.[0].enabled).toBe(
      false,
    );
    expect(parseBackupSchedules([row({ enabled: 1 })])?.[0].enabled).toBe(true);
    // Absent reads as enabled: Coolify's create path defaults it to true.
    expect(
      parseBackupSchedules([row({ enabled: undefined })])?.[0].enabled,
    ).toBe(true);
  });
  it("reads save_s3 however Coolify spells it — and absent as false", () => {
    // Same tinyint-with-no-cast story as `enabled`, opposite default: "this
    // backup lands in S3" must never be claimed off a field the row lacks.
    expect(parseBackupSchedules([row({ save_s3: 1 })])?.[0].saveS3).toBe(true);
    expect(parseBackupSchedules([row({ save_s3: 0 })])?.[0].saveS3).toBe(false);
    expect(parseBackupSchedules([row({ save_s3: false })])?.[0].saveS3).toBe(
      false,
    );
    expect(
      parseBackupSchedules([row({ save_s3: undefined })])?.[0].saveS3,
    ).toBe(false);
  });
  it("accepts an integer retention however it is serialized", () => {
    expect(
      parseBackupSchedules([
        row({ database_backup_retention_amount_locally: "7" }),
      ])?.[0].retention,
    ).toBe(7);
  });
});
