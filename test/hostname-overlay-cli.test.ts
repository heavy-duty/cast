import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tmp } from "./helpers/tmp.js";

// `cast diff --hostname-overlay <file>` overlays (#151). The unit half is
// test/apply.test.ts (applyHostnameOverlay); the CLI half was reached only by
// the `--all` refusals in test/fleet-cli.test.ts, which prove the flag is
// REJECTED fleet-wide and nothing about what it does on one project. This is
// the operator's cutover window: the box is live on the overlay's hostnames,
// the manifest says the real ones, and the read-only verb must be able to
// say "clean" — with the flag — and "drift" — without it.

type Stub = { url: string; close: () => Promise<void> };
const stubs: Stub[] = [];

async function stubCoolify(liveDomain: string): Promise<Stub> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "", "http://x").pathname.replace(
      "/api/v1",
      "",
    );
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/teams/current") return json({ id: 0, name: "Root Team" });
    if (path === "/servers") return json([{ uuid: "s1", name: "shared-box" }]);
    if (path === "/projects") return json([{ uuid: "p1", name: "widget" }]);
    if (path === "/projects/p1/environments")
      return json([{ name: "staging" }]);
    if (path === "/projects/p1/staging")
      return json({
        applications: [
          {
            name: "site",
            uuid: "app-1",
            git_repository: "coollabsio/coolify",
            git_branch: "main",
            build_pack: "dockerimage",
            base_directory: "/",
            docker_registry_image_name: "ghcr.io/acme/widget",
            docker_registry_image_tag: "main",
            ports_exposes: "80",
            fqdn: liveDomain,
            destination_id: 1,
          },
        ],
      });
    if (path === "/applications/app-1/envs") return json([]);
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

const MANIFEST = `project: widget
environments:
  staging:
    applications:
      site:
        image: { name: ghcr.io/acme/widget, tag: main }
        build: { pack: dockerimage }
        port: 80
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
  const overlay = join(state, "overlay.yaml");
  writeFileSync(overlay, 'site: ["http://widget.10.0.0.9.sslip.io"]\n');
  return { checkout, state, overlay };
}

function spawnCli(args: string[]): Promise<{ code: number; output: string }> {
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

const diff = (f: ReturnType<typeof fixture>, extra: string[]) =>
  spawnCli([
    "diff",
    "acme/widget",
    "--env",
    "staging",
    "--path",
    f.checkout,
    "--state",
    f.state,
    ...extra,
  ]);

describe("cast diff --hostname-overlay (#151)", () => {
  it("is clean with the flag while the box is live on the overlay's hostnames", async () => {
    const f = fixture(
      (await stubCoolify("http://widget.10.0.0.9.sslip.io")).url,
    );
    const r = await diff(f, ["--hostname-overlay", f.overlay]);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toMatch(/^clean$/m);
  });

  it("reports the domain drift without the flag — the cutover-window read", async () => {
    const f = fixture(
      (await stubCoolify("http://widget.10.0.0.9.sslip.io")).url,
    );
    const r = await diff(f, []);
    expect(r.code).toBe(1);
    expect(r.output).toContain("domains");
    expect(r.output).toContain("widget.example.com");
  });
});
