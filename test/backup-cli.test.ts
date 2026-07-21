import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { tmp } from "./helpers/tmp.js";

// Backup schedules, end to end: manifest -> `cast diff` -> what it prints and
// what it exits with. The unit tests prove each half (coolify.ts parses the
// route's body; computeDiff compares it; the executor writes it) — this proves
// they are wired to each other through the real binary, which is the half a
// type checker cannot see.
//
// The case that matters most is the third one. Before #51, a live database with
// NO backup schedule and a manifest that declared one produced a CLEAN diff:
// the field was never read, so the drift did not exist. A `--full` diff gating a
// production cutover passed on an unbacked-up production database.

let recipient: string;
let keyFile: string;

beforeAll(() => {
  const dir = tmp("cast-age-");
  keyFile = join(dir, "age.key");
  execFileSync("age-keygen", ["-o", keyFile], { stdio: "pipe" });
  recipient = execFileSync("age-keygen", ["-y", keyFile], {
    encoding: "utf8",
  }).trim();
});

type Stub = { url: string; close: () => Promise<void> };
const stubs: Stub[] = [];

// `backups` is the knob: what GET /databases/db-1/backups answers. The live
// payload is otherwise a byte-for-byte match for the manifest below, so anything
// the diff reports is the backup schedule and nothing else.
//
//   an array -> Coolify's real answer shape (raw ScheduledDatabaseBackup rows)
//   "boom"   -> a 500, i.e. cast asked and could not be answered
async function stubCoolify(backups: unknown[] | "boom"): Promise<Stub> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").replace("/api/v1", "");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/teams/current") return json({ id: 0, name: "Root Team" });
    if (path === "/projects") return json([{ uuid: "p1", name: "incubator" }]);
    if (path === "/projects/p1/staging")
      return json({
        postgresqls: [
          {
            name: "postgres",
            uuid: "db-1",
            database_type: "standalone-postgresql",
            image: "postgres:17-alpine",
            destination_id: 1,
          },
        ],
      });
    if (path === "/databases/db-1/backups") {
      if (backups === "boom") {
        res.writeHead(500);
        return res.end("boom");
      }
      return json(backups);
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((r) => {
    server.listen(0, "127.0.0.1", r);
  });
  const stub: Stub = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  };
  stubs.push(stub);
  return stub;
}

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((s) => s.close()));
});

// A row as Coolify serializes one (DatabasesController@database_backup_details_uuid
// returns raw Eloquent rows, v4.1.2).
const row = (over: Record<string, unknown> = {}) => ({
  uuid: "sched-1",
  enabled: true,
  save_s3: true,
  frequency: "0 3 * * *",
  database_backup_retention_amount_locally: 7,
  ...over,
});

const MANIFEST = `project: incubator
environments:
  staging:
    applications: {}
    databases:
      postgres:
        type: postgresql
        version: "17"
        backup: { frequency: "0 3 * * *", retention: 7 }
`;

function fixture(url: string) {
  const checkout = tmp("cast-co-");
  mkdirSync(join(checkout, ".infra", "env"), { recursive: true });
  writeFileSync(join(checkout, ".infra", "manifest.yaml"), MANIFEST);

  const state = tmp("cast-state-");
  mkdirSync(join(state, "secrets"));
  writeFileSync(
    join(state, ".coolify.env"),
    `COOLIFY_BASE_URL="${url}"\nCOOLIFY_ACCESS_TOKEN="t"\n`,
  );
  execFileSync("age", ["-r", recipient, "-o", "incubator.staging.env.age"], {
    input: "\n",
    cwd: join(state, "secrets"),
    stdio: ["pipe", "pipe", "pipe"],
  });
  writeFileSync(
    join(state, "environments.yaml"),
    [
      "environments:",
      "  staging:",
      "    server: shared-box",
      "    team: { id: 0, name: Root Team }",
      "    s3_destination: s3-abc",
      "github_apps:",
      "  incubator: hdb-coolify",
      "",
    ].join("\n"),
  );
  return { checkout, state };
}

function run(f: {
  checkout: string;
  state: string;
}): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      [
        "dist/cli.js",
        "diff",
        "heavy-duty/incubator",
        "--env",
        "staging",
        "--path",
        f.checkout,
        "--state",
        f.state,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CAST_AGE_KEY_FILE_STAGING: keyFile },
      },
    );
    let output = "";
    child.stdout.on("data", (d) => {
      output += String(d);
    });
    child.stderr.on("data", (d) => {
      output += String(d);
    });
    child.on("close", (code) => resolve({ code: code ?? 0, output }));
  });
}

describe("cast diff — backup schedules (#51)", () => {
  it("is clean when the live schedule matches the manifest", async () => {
    const r = await run(fixture((await stubCoolify([row()])).url));
    expect(r.code).toBe(0);
    expect(r.output).toContain("clean");
    // Compared, so it says nothing. Silence here is now EARNED, which is the
    // whole difference: before #51 it was silence about a read never made.
    expect(r.output).not.toMatch(/NOT compared/);
  });

  // The defect, end to end.
  it("reports drift when the live database has no schedule at all", async () => {
    const r = await run(fixture((await stubCoolify([])).url));
    expect(r.code).toBe(1); // this exact run used to exit 0
    expect(r.output).toContain("update database postgres");
    expect(r.output).toMatch(/backup:/);
    expect(r.output).toContain('"frequency":"0 3 * * *"');
  });

  it("reports drift when the live schedule differs", async () => {
    const r = await run(
      fixture(
        (
          await stubCoolify([
            row({
              frequency: "0 9 * * *",
              database_backup_retention_amount_locally: 2,
            }),
          ])
        ).url,
      ),
    );
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/backup:/);
  });

  it("reports drift when the schedule exists but is switched off", async () => {
    const r = await run(
      fixture((await stubCoolify([row({ enabled: false })])).url),
    );
    // A disabled schedule backs nothing up. It must not read as clean.
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/backup:/);
  });

  // The honest fallback. cast asked, could not be answered, and says so — on a
  // run it still calls clean, because an absence of evidence is not evidence of
  // drift. What it must never do is stay quiet and let the clean line imply a
  // backed-up database.
  it("says 'declared, NOT compared' out loud when the read fails", async () => {
    const r = await run(fixture((await stubCoolify("boom")).url));
    expect(r.output).toContain(
      "backup schedule for database postgres declared, NOT compared — verify in the Coolify UI",
    );
    // Not invented drift: cast read nothing, so it claims nothing.
    expect(r.output).not.toContain("update database postgres");
    expect(r.code).toBe(0);
  });

  // The same failure to read, but from a body cast does not recognize rather
  // than a transport error — including the literal placeholder the vendored
  // OpenAPI documents for this route.
  it("says 'NOT compared' on a body it cannot recognize, rather than guessing", async () => {
    const r = await run(
      fixture(
        (
          await stubCoolify([
            "Content is very complex. Will be implemented later.",
          ])
        ).url,
      ),
    );
    expect(r.output).toMatch(/NOT compared/);
    expect(r.output).not.toContain("update database postgres");
    expect(r.code).toBe(0);
  });
});
