import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// `cast smoke`, end to end, against the instance shape #29 is actually about.
//
// ONE Coolify, carrying:
//
//   project incubator    / environment prod     → application `core`  (a-prod-core)
//   project incubator    / environment staging  → application `core`  (a-staging-core)
//                                               → database    `db`
//   project client-site  / environment staging  → application `core`  (a-client-core)
//
// Three applications called `core`. That is not a contrived box — `instance:` is
// a per-environment binding, so with none set, prod and staging read the same
// .coolify.env and live on the same control plane. Until this fix, smoke resolved
// its target against GET /applications (every app the token can see, all projects,
// all environments) and wrote to the FIRST name match — so this stub lists prod's
// `core` first, which is what `cast smoke --env staging` would have written its
// canary vars onto, and (on the failure path) left them on.
//
// The wire is the witness in every test below: which uuid was written to, and —
// just as load-bearing — that the instance-wide list was never asked for at all.

type Stub = {
  url: string;
  hits: string[];
  writes: string[];
  close: () => Promise<void>;
};
const stubs: Stub[] = [];

type EnvVar = { key: string; value: string; is_buildtime: boolean };

async function stubCoolify(): Promise<Stub> {
  const hits: string[] = [];
  const writes: string[] = [];
  // One env store per application, so a write to the wrong `core` is visible as
  // a write to the wrong uuid rather than as nothing at all.
  const envs: Record<string, Array<EnvVar & { uuid: string }>> = {
    "a-prod-core": [],
    "a-staging-core": [],
    "a-client-core": [],
  };
  let nextUuid = 1;

  const server = createServer((req, res) => {
    const method = req.method ?? "GET";
    const path = (req.url ?? "").replace("/api/v1", "");
    hits.push(`${method} ${path}`);
    if (method !== "GET") writes.push(`${method} ${path}`);
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const app = (name: string, uuid: string) => ({ name, uuid });

    if (path === "/teams/current") return json({ id: 0, name: "Root Team" });
    if (path === "/version") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("4.1.2");
    }
    if (path === "/projects")
      return json([
        { uuid: "p-inc", name: "incubator" },
        { uuid: "p-cli", name: "client-site" },
      ]);
    // The lookup this fix REPLACES. Answered anyway (prod's `core` first, as
    // Coolify would list the older resource) so the tests can assert cast never
    // asks for it — a stub that 404'd here would prove only that cast survives
    // the 404.
    if (path === "/applications")
      return json([
        app("core", "a-prod-core"),
        app("core", "a-client-core"),
        app("core", "a-staging-core"),
      ]);
    if (path === "/projects/p-inc/prod")
      return json({ applications: [app("core", "a-prod-core")] });
    if (path === "/projects/p-inc/staging")
      return json({
        applications: [app("core", "a-staging-core")],
        postgresqls: [app("db", "d-staging")],
      });
    if (path === "/projects/p-cli/staging")
      return json({ applications: [app("core", "a-client-core")] });

    const env = path.match(/^\/applications\/([^/]+)\/envs(\/(.+))?$/);
    if (env) {
      const store = envs[env[1]];
      if (!store) {
        res.writeHead(404);
        return res.end("{}");
      }
      const rest = env[3];
      if (method === "GET" && !rest) return json(store);
      if (method === "POST" && !rest) {
        let body = "";
        req.on("data", (d) => {
          body += String(d);
        });
        return req.on("end", () => {
          const v = JSON.parse(body) as EnvVar;
          const created = { ...v, uuid: `e-${nextUuid++}` };
          store.push(created);
          json(created);
        });
      }
      // Upsert, mirroring verified Coolify 4.1.2 behavior — the property `smoke`
      // exists to keep checking (see src/smoke.ts).
      if (method === "PATCH" && rest === "bulk") {
        let body = "";
        req.on("data", (d) => {
          body += String(d);
        });
        return req.on("end", () => {
          const { data } = JSON.parse(body) as { data: EnvVar[] };
          for (const v of data) {
            const existing = store.find((e) => e.key === v.key);
            if (existing) Object.assign(existing, v);
            else store.push({ ...v, uuid: `e-${nextUuid++}` });
          }
          json({ ok: true });
        });
      }
      if (method === "DELETE" && rest) {
        envs[env[1]] = store.filter((e) => e.uuid !== rest);
        res.writeHead(204);
        return res.end();
      }
    }
    res.writeHead(404);
    res.end("{}");
  });

  await new Promise<void>((r) => {
    server.listen(0, "127.0.0.1", r);
  });
  const stub: Stub = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    writes,
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

// `targets` is the knob: what each project's binding says `smoke` should write
// to. smoke needs no manifest, no checkout, no secret store and no age key — it
// reads the state file and the live box, and nothing else.
function state(
  url: string,
  targets: Record<string, string> = {
    "heavy-duty/incubator": "core",
    "acme/client-site": "core",
  },
): string {
  const dir = mkdtempSync(join(tmpdir(), "cast-smoke-"));
  writeFileSync(
    join(dir, ".coolify.env"),
    `COOLIFY_BASE_URL="${url}"\nCOOLIFY_ACCESS_TOKEN="t"\n`,
  );
  const projects = Object.entries(targets).flatMap(([repo, target]) => [
    `      ${repo}:`,
    `        smoke_target: ${target}`,
  ]);
  writeFileSync(
    join(dir, "environments.yaml"),
    [
      "environments:",
      "  staging:",
      "    server: shared-box",
      "    team: { id: 0, name: Root Team }",
      "    projects:",
      ...projects,
      "  prod:",
      "    server: shared-box",
      "    team: { id: 0, name: Root Team }",
      "    projects:",
      ...projects,
      "github_apps:",
      "  incubator: hdb-coolify",
      "",
    ].join("\n"),
  );
  return dir;
}

function run(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["dist/cli.js", "smoke", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
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

describe("cast smoke — resolved inside its project + environment (#29)", () => {
  it("writes to THIS environment's app, not the first `core` the instance lists", async () => {
    const stub = await stubCoolify();
    const r = await run([
      "heavy-duty/incubator",
      "--state",
      state(stub.url),
      "--env",
      "staging",
    ]);
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/smoke OK/);
    // THE POINT. Every mutation landed on staging's `core` — and prod's, which
    // the instance-wide lookup would have picked first, was never touched.
    expect(stub.writes.length).toBeGreaterThan(0);
    for (const w of stub.writes) expect(w).toContain("a-staging-core");
    expect(stub.writes.join("\n")).not.toContain("a-prod-core");
    expect(stub.writes.join("\n")).not.toContain("a-client-core");
    // And the namespace that made prod reachable at all was never even asked
    // for: the target is resolved through the project, like every other verb's.
    expect(stub.hits).not.toContain("GET /applications");
    expect(stub.hits).toContain("GET /projects/p-inc/staging");
  });

  it("follows --env to the other environment of the same project", async () => {
    const stub = await stubCoolify();
    const r = await run([
      "heavy-duty/incubator",
      "--state",
      state(stub.url),
      "--env",
      "prod",
    ]);
    expect(r.code).toBe(0);
    for (const w of stub.writes) expect(w).toContain("a-prod-core");
    expect(stub.writes.join("\n")).not.toContain("a-staging-core");
  });

  // The other half of the coordinate: same environment, same instance, same app
  // name — a different project, and therefore a different application.
  it("follows the repo to the other project's app of the same name", async () => {
    const stub = await stubCoolify();
    const r = await run([
      "acme/client-site",
      "--state",
      state(stub.url),
      "--env",
      "staging",
    ]);
    expect(r.code).toBe(0);
    for (const w of stub.writes) expect(w).toContain("a-client-core");
    expect(stub.writes.join("\n")).not.toContain("a-staging-core");
  });

  it("reads the box's project and environment names when they are not ours", async () => {
    const stub = await stubCoolify();
    const r = await run([
      "heavy-duty/incubator",
      "--state",
      state(stub.url),
      "--env",
      "staging",
      // `staging` is OURS: it selects the binding and the team to assert. The
      // box calls this project's environment `prod`, and only the box's name
      // goes on the wire.
      "--project",
      "incubator",
      "--environment",
      "prod",
    ]);
    expect(r.code).toBe(0);
    for (const w of stub.writes) expect(w).toContain("a-prod-core");
  });
});

describe("cast smoke — refusing rather than guessing (#29)", () => {
  it("refuses when this project + environment holds no app of that name, and says what it does hold", async () => {
    const stub = await stubCoolify();
    const r = await run([
      "heavy-duty/incubator",
      "--state",
      state(stub.url, { "heavy-duty/incubator": "web" }),
      "--env",
      "staging",
    ]);
    expect(r.code).toBe(2);
    expect(r.output).toContain('holds no application named "web"');
    // What IS there — the finding, and the whole reason this is not a 404.
    expect(r.output).toMatch(/exists here:\s+core/);
    expect(r.output).toContain("smoke_target");
    // Not "…so I looked on the rest of the instance and found one". An app in
    // another project is a different app, and this verb writes.
    expect(stub.hits).not.toContain("GET /applications");
    expect(stub.writes).toEqual([]);
  });

  it("refuses a target that exists here but is not an application", async () => {
    const stub = await stubCoolify();
    const r = await run([
      "heavy-duty/incubator",
      "--state",
      state(stub.url, { "heavy-duty/incubator": "db" }),
      "--env",
      "staging",
    ]);
    expect(r.code).toBe(2);
    // smoke POSTs to /applications/<uuid>/envs. Pointed at the postgres, it
    // would 404 on an endpoint that does not exist for a database, and the
    // operator would debug the status code instead of the name.
    expect(r.output).toMatch(/"db" DOES exist here — as a database/);
    expect(r.output).toMatch(/not an\s+application/);
    expect(r.output).toContain("/envs endpoint");
    expect(stub.writes).toEqual([]);
  });

  // The project/environment refusal, reached through the same fetchLive every
  // read-side verb uses — so smoke inherits it verbatim (see renderAbsentTarget).
  it("refuses an absent environment as absent, naming --environment", async () => {
    const stub = await stubCoolify();
    const r = await run([
      "heavy-duty/incubator",
      "--state",
      state(stub.url),
      "--env",
      "staging",
      "--environment",
      "production",
    ]);
    expect(r.code).toBe(2);
    expect(r.output).toContain("refusing to smoke");
    expect(r.output).toContain('has no environment "production"');
    expect(stub.writes).toEqual([]);
  });

  it("refuses when the project declares no smoke_target at all", async () => {
    const stub = await stubCoolify();
    const r = await run([
      "heavy-duty/incubator",
      "--state",
      state(stub.url, { "acme/client-site": "core" }),
      "--env",
      "staging",
    ]);
    expect(r.code).toBe(2);
    expect(r.output).toContain("no smoke_target for heavy-duty/incubator");
    expect(r.output).toContain("smoke_target: <the application's name>");
    expect(stub.writes).toEqual([]);
  });
});
