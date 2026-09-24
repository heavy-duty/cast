import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tmp } from "./helpers/tmp.js";

// The dockerimage pack end to end (cast#161): manifest -> the real binary ->
// what goes on the wire. The unit tests (dockerimage.test.ts) prove each half;
// this proves they are wired together, and pins the three facts only a real
// request shows: the CREATE goes to Coolify's own route for the pack with the
// image, the port, the domains and the ENABLED health check, and with no
// GitHub App field — indeed without cast ever asking Coolify for a GitHub App;
// a moved tag is a PATCH, not a recreate; and a matching resource is a no-op.
//
// BOUNDARY: the Coolify here is a stub of this repo's own making. These tests
// prove what cast SENDS, not that a real 4.1.2 accepts it — that claim rests on
// reading ApplicationsController.php (create_dockerimage_application, :896 and
// :1792-1860) and is verified live by the consumer's drill (landing-site#75,
// la-familia-site#250).

type Stub = {
  url: string;
  hits: string[];
  bodies: Record<string, Record<string, unknown>>;
  close: () => Promise<void>;
};
const stubs: Stub[] = [];

async function stubCoolify(app: Record<string, unknown> | null): Promise<Stub> {
  const hits: string[] = [];
  const bodies: Record<string, Record<string, unknown>> = {};
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "", "http://x").pathname.replace(
      "/api/v1",
      "",
    );
    hits.push(`${req.method} ${path}`);
    let raw = "";
    req.on("data", (d) => {
      raw += String(d);
    });
    req.on("end", () => {
      if (raw !== "") {
        try {
          bodies[`${req.method} ${path}`] = JSON.parse(raw);
        } catch {
          /* not JSON */
        }
      }
      const json = (body: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (path === "/teams/current") return json({ id: 0, name: "Root Team" });
      if (path === "/servers")
        return json([{ uuid: "s1", name: "shared-box" }]);
      // Asked for a GitHub App, the stub answers with none: a run that needs
      // one fails, which is how the test knows the dockerimage path never asks.
      if (path === "/github-apps") return json([]);
      if (path === "/projects" && req.method === "GET")
        return json([{ uuid: "p1", name: "widget" }]);
      if (path === "/projects/p1/environments")
        return json([{ name: "staging" }]);
      if (path === "/projects/p1/staging")
        return json({ applications: app === null ? [] : [app] });
      if (path === "/applications" && req.method === "GET") return json([]);
      if (path === "/applications/dockerimage" && req.method === "POST")
        return json({ uuid: "app-1" });
      if (path === "/applications/app-1" && req.method === "PATCH")
        return json({ uuid: "app-1" });
      if (path === "/applications/app-1/envs") return json([]);
      if (path === "/deploy") return json({});
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise<void>((r) => {
    server.listen(0, "127.0.0.1", r);
  });
  const stub: Stub = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    bodies,
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

// A live Docker Image application as environment_details serializes one: note
// the git remote Coolify stamps on it, which is not the manifest's business.
const liveApp = (over: Record<string, unknown> = {}) => ({
  name: "site",
  uuid: "app-1",
  git_repository: "coollabsio/coolify",
  git_branch: "main",
  build_pack: "dockerimage",
  base_directory: "/",
  docker_registry_image_name: "ghcr.io/acme/widget",
  docker_registry_image_tag: "stable",
  ports_exposes: "80",
  health_check_path: "/version",
  health_check_enabled: true,
  fqdn: "https://widget.example.com",
  destination_id: 1,
  ...over,
});

const MANIFEST = `project: widget
environments:
  staging:
    applications:
      site:
        image: { name: ghcr.io/acme/widget, tag: stable }
        build: { pack: dockerimage }
        port: 80
        healthcheck: /version
        domains: ["https://widget.example.com"]
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
  // No GitHub App bound for this repository: a manifest of registry images
  // needs none, and a run that asked for one would fail on this binding.
  writeFileSync(
    join(state, "environments.yaml"),
    [
      "environments:",
      "  staging:",
      "    server: shared-box",
      "    team: { id: 0, name: Root Team }",
      "github_apps: {}",
      "",
    ].join("\n"),
  );
  return { checkout, state };
}

function run(
  verb: "diff" | "apply",
  f: { checkout: string; state: string },
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      [
        "dist/cli.js",
        verb,
        "acme/widget",
        "--env",
        "staging",
        "--path",
        f.checkout,
        "--state",
        f.state,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
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

describe("cast apply — a dockerimage app reaches the wire (cast#161)", () => {
  it("creates through POST /applications/dockerimage, with no GitHub App asked for or sent", async () => {
    const stub = await stubCoolify(null);
    const r = await run("apply", fixture(stub.url));
    expect(r.code, r.output).toBe(0);
    expect(stub.hits).not.toContain("GET /github-apps");
    expect(stub.hits).not.toContain("POST /applications/private-github-app");
    const body = stub.bodies["POST /applications/dockerimage"];
    expect(body).toMatchObject({
      project_uuid: "p1",
      environment_name: "staging",
      server_uuid: "s1",
      name: "site",
      instant_deploy: false,
      docker_registry_image_name: "ghcr.io/acme/widget",
      docker_registry_image_tag: "stable",
      ports_exposes: "80",
      health_check_path: "/version",
      health_check_enabled: true,
      domains: "https://widget.example.com",
    });
    for (const k of [
      "github_app_uuid",
      "git_repository",
      "git_branch",
      "base_directory",
      "build_pack",
    ])
      expect(body, k).not.toHaveProperty(k);
    expect(stub.hits).toContain("POST /deploy");
  });
  it("moves a tag with a PATCH, never a recreate", async () => {
    const stub = await stubCoolify(
      liveApp({ docker_registry_image_tag: "2.0.0-rc2" }),
    );
    const r = await run("apply", fixture(stub.url));
    expect(r.code, r.output).toBe(0);
    expect(stub.hits).not.toContain("POST /applications/dockerimage");
    expect(stub.bodies["PATCH /applications/app-1"]).toEqual({
      docker_registry_image_tag: "stable",
    });
  });
  it("switches a check back on that the UI turned off", async () => {
    const stub = await stubCoolify(liveApp({ health_check_enabled: false }));
    const r = await run("apply", fixture(stub.url));
    expect(r.code, r.output).toBe(0);
    expect(stub.bodies["PATCH /applications/app-1"]).toEqual({
      health_check_enabled: true,
    });
  });
  it("is a no-op when the image, tag, port, check and domains all match", async () => {
    const stub = await stubCoolify(liveApp());
    const r = await run("apply", fixture(stub.url));
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain("no-op (clean)");
    expect(stub.hits).not.toContain("PATCH /applications/app-1");
    expect(stub.hits).not.toContain("POST /deploy");
  });
});
