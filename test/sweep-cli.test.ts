import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The sweep, against a stub shaped like the box that made it necessary.
//
// Three projects — one ours, two unrelated third-party client sites nobody knew
// were there. Our project has TWO environments: `production`, which Coolify
// auto-created and which is EMPTY, and `staging`, which is where the live
// founder-facing system has been running the whole time because nobody ever
// swapped it.
//
// Pointed at `production`, the old inventory reported "5 differences" against a
// box whose resources were alive and serving production — the manifest talking
// to itself, and an impression ("the box has nothing") that is exactly how a
// full-create plan gets laundered into a pass.

type Stub = { url: string; close: () => Promise<void> };
const stubs: Stub[] = [];

async function stubCoolify(): Promise<Stub> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").replace("/api/v1", "");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/teams/current") return json({ id: 0, name: "Root Team" });
    if (path === "/projects")
      return json([
        { uuid: "p1", name: "Incubator" },
        { uuid: "p2", name: "La Familia Site" },
        { uuid: "p3", name: "Martin Reyes Barber Shop" },
      ]);
    if (path === "/projects/p1/environments")
      return json([{ name: "production" }, { name: "staging" }]);
    if (path === "/projects/p2/environments")
      return json([{ name: "production" }]);
    if (path === "/projects/p3/environments")
      return json([{ name: "production" }]);
    // Coolify auto-creates `production`. It is empty. Everything real lives in
    // `staging`, under names a human typed.
    if (path === "/projects/p1/production") return json({});
    if (path === "/projects/p1/staging")
      return json({
        applications: [
          { name: "Incubator Stack v2", uuid: "a1" },
          { name: "Incubator Landing", uuid: "a2" },
        ],
        postgresqls: [{ name: "Incubator Database v2", uuid: "d1" }],
        services: [{ name: "Incubator Umami", uuid: "s1" }],
      });
    if (path === "/projects/p2/production")
      return json({ applications: [{ name: "lafamilia-web", uuid: "a9" }] });
    if (path === "/projects/p3/production")
      return json({ applications: [{ name: "barber-web", uuid: "a8" }] });
    if (path.endsWith("/envs")) return json([]);
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

const MANIFEST = `project: incubator
environments:
  staging:
    applications:
      core:
        source: { repo: heavy-duty/incubator, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: ["http://core.example.com"]
`;

function fixture(url: string) {
  const checkout = mkdtempSync(join(tmpdir(), "cast-co-"));
  mkdirSync(join(checkout, ".infra", "env"), { recursive: true });
  writeFileSync(join(checkout, ".infra", "manifest.yaml"), MANIFEST);
  const state = mkdtempSync(join(tmpdir(), "cast-state-"));
  mkdirSync(join(state, "secrets"));
  writeFileSync(
    join(state, ".coolify.env"),
    `COOLIFY_BASE_URL="${url}"\nCOOLIFY_ACCESS_TOKEN="t"\n`,
  );
  writeFileSync(
    join(state, "environments.yaml"),
    [
      "environments:",
      "  staging:",
      "    server: staging-box",
      "    team: { id: 0, name: Root Team }",
      "github_apps:",
      "  incubator: hdb-coolify",
      "",
    ].join("\n"),
  );
  return { checkout, state };
}

function run(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["dist/cli.js", "inventory", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => {
      output += String(d);
    });
    child.stderr.on("data", (d) => {
      output += String(d);
    });
    child.stdin.end();
    child.on("close", (code) => resolve({ code: code ?? 0, output }));
  });
}

describe("cast inventory — the sweep (#22)", () => {
  it("with no repo, shows every project, environment and resource", async () => {
    const f = fixture((await stubCoolify()).url);
    const r = await run(["--env", "staging", "--state", f.state]);
    expect(r.code).toBe(0);

    // Every project the token can see — including the two nobody knew were on
    // the box. (On the real instance, that discovery is what stopped a plan
    // whose next step would have deleted the box.)
    expect(r.output).toContain("Incubator");
    expect(r.output).toContain("La Familia Site");
    expect(r.output).toContain("Martin Reyes Barber Shop");

    // Both environments, and the empty one is SHOWN, not hidden — an operator
    // who assumes `production` is where things live aims every later command at
    // nothing.
    expect(r.output).toContain("production");
    expect(r.output).toContain("(empty)");
    expect(r.output).toContain("staging");

    // And the resources, under the names the box actually uses.
    expect(r.output).toContain("Incubator Stack v2");
    expect(r.output).toContain("Incubator Database v2");
  });

  it("needs no repo, no manifest, no store — it runs before adoption exists", async () => {
    const f = fixture((await stubCoolify()).url);
    // No org/repo positional at all: nothing is cloned, no manifest is read.
    const r = await run(["--env", "staging", "--state", f.state]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("No manifest involved");
  });

  it("still asserts the team — a wrong-team token would sweep an empty instance", async () => {
    const f = fixture((await stubCoolify()).url);
    writeFileSync(
      join(f.state, "environments.yaml"),
      [
        "environments:",
        "  staging:",
        "    server: staging-box",
        "    team: { id: 9, name: Some Other Team }",
        "",
      ].join("\n"),
    );
    const r = await run(["--env", "staging", "--state", f.state]);
    // Coolify scopes what a token can see to its team, so an unasserted sweep
    // would truthfully report that the instance is empty.
    expect(r.code).not.toBe(0);
    expect(r.output).not.toContain("La Familia Site");
  });
});

describe("an empty environment shouts (#22)", () => {
  it("says NOTHING is here, and names the sweep — not '5 differences'", async () => {
    const f = fixture((await stubCoolify()).url);
    const r = await run([
      "heavy-duty/incubator",
      "--env",
      "staging",
      "--state",
      f.state,
      "--path",
      f.checkout,
      "--project",
      "Incubator",
      "--environment",
      "production", // auto-created by Coolify, and empty
    ]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("NOTHING");
    expect(r.output).toContain("WRONG COORDINATE");
    expect(r.output).toContain("cast inventory --env staging");
    // NOT the old output, whose overall impression was "the box has nothing and
    // the manifest has five things" — a full-create plan in all but name.
    expect(r.output).not.toContain("difference(s) between the manifest");
  });
});
