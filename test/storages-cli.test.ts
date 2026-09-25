import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tmp } from "./helpers/tmp.js";

// `storages` end to end (cast#167): manifest -> the real binary -> the wire.
// storages.test.ts proves each half; this pins what only a real request
// shows: a create POSTs each declared volume after the application exists and
// before it deploys; an existing application gets a missing volume POSTed and a
// moved one PATCHed by its uuid, and the application's own PATCH never carries
// `storages`; an undeclared volume is reported and never deleted; an unreadable
// read is reported and writes nothing.
//
// BOUNDARY: the Coolify here is a stub of this repo's own making. These tests
// prove what cast SENDS, not that a real 4.1.2 accepts it — that rests on
// reading ApplicationsController.php (storages, create_storage, update_storage
// @ v4.1.2) and is verified live by the consumer (la-familia-site#273).

type Stub = {
  url: string;
  hits: string[];
  bodies: Record<string, Record<string, unknown>>;
  posts: Array<Record<string, unknown>>;
  close: () => Promise<void>;
};
const stubs: Stub[] = [];

async function stubCoolify(
  app: Record<string, unknown> | null,
  storages: Record<string, unknown> | "fail" = {
    persistent_storages: [],
    file_storages: [],
  },
): Promise<Stub> {
  const hits: string[] = [];
  const bodies: Record<string, Record<string, unknown>> = {};
  const posts: Array<Record<string, unknown>> = [];
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
          if (path.endsWith("/storages") && req.method === "POST")
            posts.push(JSON.parse(raw));
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
      if (path === "/applications/app-1/storages" && req.method === "GET") {
        if (storages === "fail") {
          res.writeHead(500);
          return res.end("{}");
        }
        return json(storages);
      }
      if (path === "/applications/app-1/storages" && req.method === "POST")
        return json({ uuid: "st-new" });
      if (path === "/applications/app-1/storages" && req.method === "PATCH")
        return json({ uuid: "st-1" });
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
    posts,
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
        storages:
          - { name: admin-data, mount_path: /data }
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

const STORAGES = (list: Array<Record<string, unknown>>) => ({
  persistent_storages: list,
  file_storages: [],
});
const ADMIN_DATA = {
  uuid: "st-1",
  name: "app-1-admin-data",
  mount_path: "/data",
  host_path: null,
};

describe("cast apply — storages reach the wire (cast#167)", () => {
  it("a create POSTs the declared volume after the application exists and before it deploys", async () => {
    const stub = await stubCoolify(null);
    const r = await run("apply", fixture(stub.url));
    expect(r.code, r.output).toBe(0);
    expect(stub.bodies["POST /applications/dockerimage"]).not.toHaveProperty(
      "storages",
    );
    expect(stub.posts).toEqual([
      { type: "persistent", name: "admin-data", mount_path: "/data" },
    ]);
    const at = (h: string) => stub.hits.indexOf(h);
    expect(at("POST /applications/dockerimage")).toBeLessThan(
      at("POST /applications/app-1/storages"),
    );
    expect(at("POST /applications/app-1/storages")).toBeLessThan(
      at("POST /deploy"),
    );
  });
  it("an existing application missing the declared volume gets the same POST, and no PATCH of its own", async () => {
    const stub = await stubCoolify(liveApp(), STORAGES([]));
    const r = await run("apply", fixture(stub.url));
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain("storage admin-data: create, mounted at /data");
    expect(stub.posts).toEqual([
      { type: "persistent", name: "admin-data", mount_path: "/data" },
    ]);
    expect(stub.hits).not.toContain("PATCH /applications/app-1");
    expect(stub.hits).toContain("POST /deploy");
  });
  it("a moved mount path is a PATCH by the storage's uuid, never a second volume", async () => {
    const stub = await stubCoolify(
      liveApp(),
      STORAGES([{ ...ADMIN_DATA, mount_path: "/var/data" }]),
    );
    const r = await run("apply", fixture(stub.url));
    expect(r.code, r.output).toBe(0);
    expect(stub.posts).toEqual([]);
    expect(stub.bodies["PATCH /applications/app-1/storages"]).toEqual({
      uuid: "st-1",
      type: "persistent",
      mount_path: "/data",
      host_path: null,
    });
  });
  it("is a no-op when the declared volume is live where declared", async () => {
    const stub = await stubCoolify(liveApp(), STORAGES([ADMIN_DATA]));
    const r = await run("apply", fixture(stub.url));
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain("no-op (clean)");
    expect(
      stub.hits.filter((h) => /storages/.test(h) && !h.startsWith("GET")),
    ).toEqual([]);
    expect(stub.hits).not.toContain("POST /deploy");
  });
  it("an undeclared volume is reported as drift and never deleted", async () => {
    const stub = await stubCoolify(
      liveApp(),
      STORAGES([
        ADMIN_DATA,
        {
          uuid: "st-2",
          name: "app-1-old",
          mount_path: "/old",
          host_path: null,
        },
      ]),
    );
    const diff = await run("diff", fixture(stub.url));
    expect(diff.output).toContain(
      "undeclared storage old on application admin (mounted at /old)",
    );
    expect(diff.code).not.toBe(0);
    const apply = await run("apply", fixture(stub.url));
    expect(apply.code, apply.output).toBe(0);
    expect(stub.hits.filter((h) => h.startsWith("DELETE"))).toEqual([]);
    expect(stub.posts).toEqual([]);
  });
  it("an unreadable read is 'not compared': reported, and nothing is written to the storages", async () => {
    const stub = await stubCoolify(liveApp(), "fail");
    const r = await run("apply", fixture(stub.url));
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain(
      "storages on application admin declared, NOT compared",
    );
    expect(stub.posts).toEqual([]);
    expect(stub.hits).not.toContain("PATCH /applications/app-1/storages");
  });
});
