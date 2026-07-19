import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { tmp } from "./helpers/tmp.js";

// When does `apply` need a GitHub App at all? (#103, found live in the
// 2026-07-19 release drill.)
//
// A GitHub App exists to clone application source, and cast reads it in exactly
// one call — the application create. But apply used to resolve it
// unconditionally, after the plan had already rendered: a manifest declaring
// only databases printed its creates and then died in preflight on "no GitHub
// App bound", over a binding nothing in the run would ever have used. That
// gates infra-only projects (databases shared by other projects) behind the
// GitHub-App browser-registration ceremony for no reason.
//
// Both directions are pinned here, end to end against a stub Coolify:
// a databases-only manifest applies with NO github_apps binding and the stub
// never sees a /github-apps request — and a manifest that DOES declare an
// application still refuses on the missing binding, with the same message.

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

type Stub = { url: string; hits: string[]; close: () => Promise<void> };
const stubs: Stub[] = [];

// A box holding the project and its (empty) environment, so the plan is pure
// creates — the drill's shape. `hits` records "METHOD path" so a test can
// assert which routes a run touched, and which it never did.
async function stubCoolify(): Promise<Stub> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "", "http://x").pathname.replace(
      "/api/v1",
      "",
    );
    hits.push(`${req.method} ${path}`);
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/teams/current") return json({ id: 0, name: "Root Team" });
    if (path === "/servers") return json([{ uuid: "s1", name: "drill-box" }]);
    if (path === "/projects" && req.method === "GET")
      return json([{ uuid: "p1", name: "drill-widget" }]);
    if (path === "/projects/p1/staging") return json({});
    if (path === "/projects/p1/environments")
      return json([{ name: "staging" }]);
    // The domain preflight's instance-wide read (only an application plan asks).
    if (path === "/applications" && req.method === "GET") return json([]);
    if (path === "/databases/redis" && req.method === "POST")
      return json({ uuid: "db-9" });
    if (path === "/deploy") return json({});
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((r) => {
    server.listen(0, "127.0.0.1", r);
  });
  const stub: Stub = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
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

// The drill's manifest: applications declared, and empty — this project IS its
// databases.
const DATABASES_ONLY = `project: drill-widget
environments:
  staging:
    applications: {}
    databases:
      cache:
        type: redis
`;

const WITH_APPLICATION = `project: drill-widget
environments:
  staging:
    applications:
      web:
        source: { repo: heavy-duty/drill-widget, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: ["http://web.example.com"]
    databases:
      cache:
        type: redis
`;

// The state file the issue is about: no github_apps entry for this repo at all.
function fixture(url: string, manifest: string) {
  const checkout = tmp("cast-co-");
  mkdirSync(join(checkout, ".infra", "env"), { recursive: true });
  writeFileSync(join(checkout, ".infra", "manifest.yaml"), manifest);

  const state = tmp("cast-state-");
  mkdirSync(join(state, "secrets"));
  writeFileSync(
    join(state, ".coolify.env"),
    `COOLIFY_BASE_URL="${url}"\nCOOLIFY_ACCESS_TOKEN="t"\n`,
  );
  // No template refs any secret, but the store still has to exist and open.
  execFileSync("age", ["-r", recipient, "-o", "drill-widget.staging.env.age"], {
    input: "\n",
    cwd: join(state, "secrets"),
    stdio: ["pipe", "pipe", "pipe"],
  });
  writeFileSync(
    join(state, "environments.yaml"),
    [
      "environments:",
      "  staging:",
      "    server: drill-box",
      "    team: { id: 0, name: Root Team }",
      "github_apps: {}",
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
        "apply",
        "heavy-duty/drill-widget",
        "--env",
        "staging",
        "--path",
        f.checkout,
        "--state",
        f.state,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
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

describe("cast apply — GitHub App resolved only for applications (#103)", () => {
  it("applies a databases-only manifest with no github_apps binding, never asking for one", async () => {
    const stub = await stubCoolify();
    const f = fixture(stub.url, DATABASES_ONLY);
    const r = await run(f);
    expect(r.code).toBe(0);
    // The apply went all the way through: the database was created and
    // redeployed, not merely planned.
    expect(r.output).toContain("applied + redeployed: cache");
    expect(stub.hits).toContain("POST /databases/redis");
    // The load-bearing absence: nothing in this run may ask Coolify for a
    // GitHub App — the resolution, not just the create, must be skipped.
    expect(stub.hits.some((h) => h.includes("/github-apps"))).toBe(false);
    expect(r.output).not.toContain("no GitHub App bound");
  });

  it("still refuses a manifest WITH an application when the binding is missing", async () => {
    const stub = await stubCoolify();
    const f = fixture(stub.url, WITH_APPLICATION);
    const r = await run(f);
    expect(r.code).toBe(1);
    // The message githubAppNameFor has always thrown, unchanged.
    expect(r.output).toContain(
      "no GitHub App bound for heavy-duty/drill-widget",
    );
    expect(r.output).toContain('github_apps["heavy-duty/drill-widget"]');
    expect(r.output).toContain("bound repos: (none)");
    // Refused in preflight: nothing was created — not even the database the
    // manifest also declares.
    expect(stub.hits.some((h) => h.startsWith("POST /databases"))).toBe(false);
    expect(
      stub.hits.some((h) => h.includes("/applications/private-github-app")),
    ).toBe(false);
  });
});
