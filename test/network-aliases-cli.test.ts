import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tmp } from "./helpers/tmp.js";

// `network_aliases` end to end (cast#170): manifest -> the real binary -> the
// wire. A create sends `custom_network_aliases` as Coolify's comma string; a
// live application without the alias gets it by PATCH and is redeployed (the
// alias is on the container only after a deploy); a matching one is a no-op.
//
// BOUNDARY: the Coolify here is a stub of this repo's own making. What 4.1.2
// accepts rests on reading ApplicationsController.php (:914, :2368),
// bootstrap/helpers/api.php (:111) and Application::customNetworkAliases @
// v4.1.2; the live check is the consumer's (la-familia-site#211).

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
  custom_network_aliases: "api",
  name: "admin",
  uuid: "app-1",
  git_repository: "coollabsio/coolify",
  git_branch: "main",
  build_pack: "dockerimage",
  base_directory: "/",
  docker_registry_image_name: "ghcr.io/acme/admin",
  docker_registry_image_tag: "stable",
  ports_exposes: "8787",
  health_check_path: "/api/health",
  health_check_enabled: true,
  fqdn: "",
  destination_id: 1,
  ...over,
});

// The shape la-familia-site#211 asks for: the admin as a Docker Image
// resource with its store on a volume, no domain, reached only by its network.
const MANIFEST = `project: widget
environments:
  staging:
    applications:
      admin:
        image: { name: ghcr.io/acme/admin, tag: stable }
        build: { pack: dockerimage }
        port: 8787
        healthcheck: /api/health
        network_aliases: [api]
        domains: []
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

describe("cast apply — network_aliases reach the wire (cast#170)", () => {
  it("a create sends custom_network_aliases as Coolify's comma string", async () => {
    const stub = await stubCoolify(null);
    const r = await run("apply", fixture(stub.url));
    expect(r.code, r.output).toBe(0);
    expect(stub.bodies["POST /applications/dockerimage"]).toMatchObject({
      custom_network_aliases: "api",
    });
    expect(stub.bodies["POST /applications/dockerimage"]).not.toHaveProperty(
      "network_aliases",
    );
  });
  it("a live application without the alias gets it by PATCH, and is redeployed", async () => {
    const stub = await stubCoolify(liveApp({ custom_network_aliases: null }));
    const r = await run("apply", fixture(stub.url));
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('network_aliases: [] → ["api"]');
    expect(stub.bodies["PATCH /applications/app-1"]).toEqual({
      custom_network_aliases: "api",
    });
    expect(stub.hits).toContain("POST /deploy");
  });
  it("is a no-op when the alias is live", async () => {
    const stub = await stubCoolify(liveApp());
    const r = await run("apply", fixture(stub.url));
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain("no-op (clean)");
    expect(stub.hits).not.toContain("PATCH /applications/app-1");
    expect(stub.hits).not.toContain("POST /deploy");
  });
});
