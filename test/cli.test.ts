import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tmp } from "./helpers/tmp.js";

// Spawned ASYNCHRONOUSLY, and that is load-bearing: the stub Coolify below
// runs in THIS process, so a blocking execFileSync would hold the event loop
// and the stub could never answer the CLI it just launched — the two would
// deadlock until the test timed out.
function runCli(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["dist/cli.js", ...args], {
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

// A Coolify that answers the two calls these paths make, and RECORDS what it
// was asked. The recording is the point: "which instance did cast actually
// talk to" is the question #14 exists to make answerable, so the tests below
// answer it from the wire rather than from cast's own console output.
type Stub = { url: string; hits: string[]; close: () => Promise<void> };
const stubs: Stub[] = [];

async function stubCoolify(): Promise<Stub> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const body =
      req.url === "/api/v1/teams/current"
        ? JSON.stringify({ id: 0, name: "Root Team" })
        : "[]";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
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

const coolifyEnv = (url: string, readOnly = false) =>
  `COOLIFY_BASE_URL="${url}"\nCOOLIFY_ACCESS_TOKEN="t"\n${
    readOnly ? "COOLIFY_READ_ONLY=true\n" : ""
  }`;

// A state dir: the default instance, plus any named ones, plus bindings.
function stateWith(opts: {
  default?: string;
  named?: Record<string, string>;
  boundInstance?: string;
}): string {
  const dir = tmp("cast-cli-");
  if (opts.default) writeFileSync(join(dir, ".coolify.env"), opts.default);
  if (opts.named) {
    mkdirSync(join(dir, ".coolify"));
    for (const [name, body] of Object.entries(opts.named)) {
      writeFileSync(join(dir, ".coolify", `${name}.env`), body);
    }
  }
  writeFileSync(
    join(dir, "environments.yaml"),
    [
      "environments:",
      "  prod:",
      "    server: prod-box",
      "    team: { id: 0, name: Root Team }",
      ...(opts.boundInstance ? [`    instance: ${opts.boundInstance}`] : []),
      "    projects:",
      "      heavy-duty/incubator:",
      "        smoke_target: core",
      "github_apps:",
      "  incubator: hdb-coolify",
      "",
    ].join("\n"),
  );
  return dir;
}

describe("infra cli", () => {
  it("refuses apply --path with --env prod, exit non-zero", async () => {
    const r = await runCli([
      "apply",
      "acme/widget",
      "--env",
      "prod",
      "--path",
      "/tmp/x",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/--path.*prod/);
  });
  it("prints usage on unknown command", async () => {
    const r = await runCli(["frobnicate"]);
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/usage: cast (apply|diff)/i);
  });
  // Both of these reach a live Coolify and mutate — `server add` registers a
  // server into the token's team (permanently: a server belongs to exactly one
  // team), and `smoke` writes env vars onto a live app. Neither may run without
  // an environment to assert the token's team against.
  it("refuses server add without --env, exit non-zero", async () => {
    const r = await runCli([
      "server",
      "add",
      "prod-box",
      "--ip",
      "10.0.0.1",
      "--key",
      "/tmp/k",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/--env/);
  });
  it("refuses smoke without --env, exit non-zero", async () => {
    const r = await runCli(["smoke", "heavy-duty/incubator"]);
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/--env/);
  });
  // The repo is the PROJECT, and the project is half of the only scope in which
  // `smoke_target: core` names anything (#29). `cast smoke --env prod` used to
  // run — resolving the name against every application on the instance — which
  // is precisely the invocation that could write prod's `core` while smoking
  // staging. It is now a usage error, before any state is even read.
  it("refuses smoke without the <org>/<repo> positional, exit non-zero", async () => {
    const r = await runCli(["smoke", "--env", "prod"]);
    expect(r.code).toBe(2);
    expect(r.output).toMatch(/cast smoke\s+<org>\/<repo>/);
  });
});

describe("--instance (multiple Coolify instances)", () => {
  // The acceptance criterion from #14, end to end: a command against a named
  // instance reaches THAT Coolify, with no edit to .coolify.env — which still
  // sits there, untouched, pointing somewhere else entirely.
  it("talks to the named instance, leaving .coolify.env untouched", async () => {
    const [main, legacy] = [await stubCoolify(), await stubCoolify()];
    const dir = stateWith({
      default: coolifyEnv(main.url),
      named: { legacy: coolifyEnv(legacy.url) },
    });
    const r = await runCli(["team", "--state", dir, "--instance", "legacy"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain(`instance legacy → ${legacy.url}`);
    // The wire is the witness, not the log line.
    expect(legacy.hits).toContain("/api/v1/teams/current");
    expect(main.hits).toEqual([]);
  });

  it("uses .coolify.env when no instance is named — unchanged behavior", async () => {
    const [main, legacy] = [await stubCoolify(), await stubCoolify()];
    const dir = stateWith({
      default: coolifyEnv(main.url),
      named: { legacy: coolifyEnv(legacy.url) },
    });
    const r = await runCli(["team", "--state", dir]);
    expect(r.code).toBe(0);
    expect(r.output).toContain(`instance default → ${main.url}`);
    expect(main.hits).toContain("/api/v1/teams/current");
    expect(legacy.hits).toEqual([]);
  });

  // environments.yaml binds the instance, so --env prod selects the right
  // control plane with no flag and no file edit at all.
  it("honors an environment's instance binding with no flag", async () => {
    const [main, prodCp] = [await stubCoolify(), await stubCoolify()];
    const dir = stateWith({
      default: coolifyEnv(main.url),
      named: { "prod-cp": coolifyEnv(prodCp.url) },
      boundInstance: "prod-cp",
    });
    const r = await runCli(["team", "--state", dir, "--env", "prod"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain(`instance prod-cp → ${prodCp.url}`);
    expect(prodCp.hits).toContain("/api/v1/teams/current");
    expect(main.hits).toEqual([]);
  });

  it("lets an explicit --instance beat the environment's binding", async () => {
    const [prodCp, legacy] = [await stubCoolify(), await stubCoolify()];
    const dir = stateWith({
      named: {
        "prod-cp": coolifyEnv(prodCp.url),
        legacy: coolifyEnv(legacy.url),
      },
      boundInstance: "prod-cp",
    });
    const r = await runCli([
      "team",
      "--state",
      dir,
      "--env",
      "prod",
      "--instance",
      "legacy",
    ]);
    expect(r.code).toBe(0);
    expect(legacy.hits).toContain("/api/v1/teams/current");
    expect(prodCp.hits).toEqual([]);
  });

  it("refuses an unknown instance, names the known ones, and touches nothing", async () => {
    const main = await stubCoolify();
    const dir = stateWith({
      default: coolifyEnv(main.url),
      named: { legacy: coolifyEnv(main.url) },
    });
    const r = await runCli(["team", "--state", dir, "--instance", "typo"]);
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/no Coolify instance named "typo"/);
    expect(r.output).toMatch(/configured:\s+legacy/);
    // Refuse, don't guess: it must not have fallen back to the default.
    expect(main.hits).toEqual([]);
  });

  // The nice-to-have that turns "I pointed the wrong token at the wrong box"
  // into an exit code: the refusal lands BEFORE the first call, so a read-only
  // instance never even gets asked.
  it("refuses a writing verb against a read-only instance, before any call", async () => {
    const legacy = await stubCoolify();
    const dir = stateWith({
      named: { legacy: coolifyEnv(legacy.url, true) },
    });
    const r = await runCli([
      "smoke",
      "heavy-duty/incubator",
      "--state",
      dir,
      "--env",
      "prod",
      "--instance",
      "legacy",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/refusing to smoke.*read-only/s);
    expect(legacy.hits).toEqual([]);
  });

  it("still allows a read-only instance to be read", async () => {
    const legacy = await stubCoolify();
    const dir = stateWith({ named: { legacy: coolifyEnv(legacy.url, true) } });
    const r = await runCli(["team", "--state", dir, "--instance", "legacy"]);
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/read-only/);
    expect(legacy.hits).toContain("/api/v1/teams/current");
  });
});
