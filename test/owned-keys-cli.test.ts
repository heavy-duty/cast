import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tmp } from "./helpers/tmp.js";

// `owned_keys` end to end (cast#177): manifest + a la-familia-site-shaped
// pointer file -> the real binary -> the wire. On an existing application the
// bulk env write carries every key EXCEPT the owned ones (and is not issued at
// all when only owned keys differ); on a create it carries them too; `diff
// --full` names them and never prints a value.
//
// BOUNDARY: the Coolify here is a stub of this repo's own making; the bulk
// route's upsert-only behaviour is what `cast smoke` proves on a real box.

type Stub = {
  url: string;
  hits: string[];
  bodies: Record<string, unknown>;
  close: () => Promise<void>;
};
const stubs: Stub[] = [];

async function stubCoolify(
  app: Record<string, unknown> | null,
  liveEnv: Record<string, string>,
): Promise<Stub> {
  const hits: string[] = [];
  const bodies: Record<string, unknown> = {};
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
      if (path === "/applications/app-1/envs" && req.method === "GET")
        return json(
          Object.entries(liveEnv).map(([key, value]) => ({
            key,
            value,
            real_value: value,
            is_preview: false,
          })),
        );
      if (path === "/applications/app-1/envs/bulk") return json({});
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

const liveApp = () => ({
  name: "admin",
  uuid: "app-1",
  git_repository: "coollabsio/coolify",
  git_branch: "main",
  build_pack: "dockerimage",
  base_directory: "/",
  docker_registry_image_name: "ghcr.io/acme/admin",
  docker_registry_image_tag: "stable",
  ports_exposes: "8787",
  fqdn: "",
  destination_id: 1,
});

const MANIFEST = `project: widget
environments:
  staging:
    applications:
      admin:
        image: { name: ghcr.io/acme/admin, tag: stable }
        build: { pack: dockerimage }
        port: 8787
        domains: []
        env_template: admin.staging.env.template
        owned_keys: { file: .infra/admin-editable.json }
`;

// la-familia-site's .infra/admin-editable.json, in miniature: comments, a list
// for every template, a list for this one.
const OWNED_FILE = JSON.stringify({
  _why: "What the admin may change, by template.",
  _secretos_why: "Credentials the admin accepts a drop for.",
  _secretos: ["RELEASE_TO"],
  "admin.staging.env.template": ["MCP_ENABLED"],
});

const TEMPLATE = [
  "NODE_ENV=production",
  "MCP_ENABLED=true",
  "RELEASE_TO=ops@example.com",
  "",
].join("\n");

function fixture(url: string) {
  const checkout = tmp("cast-co-");
  mkdirSync(join(checkout, ".infra", "env"), { recursive: true });
  writeFileSync(join(checkout, ".infra", "manifest.yaml"), MANIFEST);
  writeFileSync(join(checkout, ".infra", "admin-editable.json"), OWNED_FILE);
  writeFileSync(
    join(checkout, ".infra", "env", "admin.staging.env.template"),
    TEMPLATE,
  );
  const state = tmp("cast-state-");
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
      "    server: shared-box",
      "    team: { id: 0, name: Root Team }",
      "github_apps: {}",
      "",
    ].join("\n"),
  );
  return { checkout, state };
}

function run(
  args: string[],
  f: { checkout: string; state: string },
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      [
        "dist/cli.js",
        ...args,
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

const bulkKeys = (stub: Stub) =>
  (
    stub.bodies["PATCH /applications/app-1/envs/bulk"] as {
      data: Array<{ key: string; value: string }>;
    }
  ).data
    .map((d) => d.key)
    .sort();

describe("cast apply — owned_keys never reach an existing resource (cast#177)", () => {
  it("writes the other keys and leaves out the owned ones", async () => {
    const stub = await stubCoolify(liveApp(), {
      NODE_ENV: "development",
      MCP_ENABLED: "false",
      RELEASE_TO: "admin-chose@example.com",
    });
    const r = await run(["apply"], fixture(stub.url));
    expect(r.code, r.output).toBe(0);
    expect(bulkKeys(stub)).toEqual(["NODE_ENV"]);
    expect(stub.hits).toContain("POST /deploy");
    expect(r.output).toContain(
      "env on application admin: MCP_ENABLED, RELEASE_TO owned by the app — not compared",
    );
    expect(r.output).not.toContain("admin-chose@example.com");
  });
  it("issues no write at all when only owned keys differ", async () => {
    const stub = await stubCoolify(liveApp(), {
      NODE_ENV: "production",
      MCP_ENABLED: "false",
      RELEASE_TO: "admin-chose@example.com",
    });
    const r = await run(["apply"], fixture(stub.url));
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain("no-op (clean)");
    expect(stub.hits).not.toContain("PATCH /applications/app-1/envs/bulk");
    expect(stub.hits).not.toContain("POST /deploy");
  });
  it("a create writes the owned keys from the template, and says so in the plan", async () => {
    const stub = await stubCoolify(null, {});
    const r = await run(["apply"], fixture(stub.url));
    expect(r.code, r.output).toBe(0);
    expect(stub.hits).toContain("POST /applications/dockerimage");
    expect(bulkKeys(stub)).toEqual(["MCP_ENABLED", "NODE_ENV", "RELEASE_TO"]);
    expect(r.output).toContain(
      "env MCP_ENABLED: add — owned by the app; written now because apply creates the resource",
    );
    expect(r.output).toContain(
      "env RELEASE_TO: add — owned by the app; written now because apply creates the resource",
    );
    expect(r.output).toContain("env NODE_ENV: add\n");
  });
});

describe("cast diff --full — owned keys are named, never valued (cast#177)", () => {
  it("is clean when only owned keys differ, and names them without a value", async () => {
    const stub = await stubCoolify(liveApp(), {
      NODE_ENV: "production",
      MCP_ENABLED: "false",
      RELEASE_TO: "admin-chose@example.com",
    });
    const r = await run(["diff", "--full"], fixture(stub.url));
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain(
      "env on application admin: MCP_ENABLED, RELEASE_TO owned by the app — not compared",
    );
    expect(r.output).toMatch(/^clean$/m);
    expect(r.output).not.toContain("admin-chose@example.com");
    expect(r.output).not.toContain("ops@example.com");
  });
  it("refuses a pointer to a file that is not there, before any write", async () => {
    const stub = await stubCoolify(liveApp(), {});
    const f = fixture(stub.url);
    rmSync(join(f.checkout, ".infra", "admin-editable.json"));
    const r = await run(["apply"], f);
    expect(r.code).not.toBe(0);
    expect(r.output).toContain(
      "owned_keys file missing: .infra/admin-editable.json (named by application admin in staging)",
    );
    expect(stub.hits.filter((h) => !h.startsWith("GET"))).toEqual([]);
  });
});
