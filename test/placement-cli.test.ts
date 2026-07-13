import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// Placement, end to end: `environments.yaml` -> `cast diff` -> what it prints
// and what it exits with. The unit tests prove each half (bindings resolve a
// project's destination; computeDiff groups the live side by it) — this proves
// they are actually wired to each other, which is the half a type checker
// cannot see.
//
// The box here is the shape #21 is about: ONE server carrying more than one
// project, so the server's default network is no longer the right answer for
// anything on it.

let recipient: string;
let keyFile: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "cast-age-"));
  keyFile = join(dir, "age.key");
  execFileSync("age-keygen", ["-o", keyFile], { stdio: "pipe" });
  recipient = execFileSync("age-keygen", ["-y", keyFile], {
    encoding: "utf8",
  }).trim();
});

type Stub = { url: string; close: () => Promise<void> };
const stubs: Stub[] = [];

// destinationIds is the knob: which network Coolify says each app is on. The
// live payload is otherwise a byte-for-byte match for the manifest below, so
// anything the diff reports is placement and nothing else.
async function stubCoolify(destinationIds: {
  core: number | null;
  landing: number | null;
}): Promise<Stub> {
  const app = (name: string, uuid: string, destination_id: number | null) => ({
    name,
    uuid,
    git_repository: "heavy-duty/incubator",
    git_branch: "main",
    build_pack: "nixpacks",
    base_directory: "/",
    fqdn: `http://${name}.example.com`,
    // Coolify returns this on every resource; `null` stands for the box that
    // somehow reports none.
    destination_id,
  });
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
        applications: [
          app("core", "a1", destinationIds.core),
          app("landing", "a2", destinationIds.landing),
        ],
      });
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
      landing:
        source: { repo: heavy-duty/incubator, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: ["http://landing.example.com"]
`;

// `declared` is the destination_uuid the state file names for this project —
// undefined means the state file says nothing, which is every state file today.
function fixture(url: string, declared?: string) {
  const checkout = mkdtempSync(join(tmpdir(), "cast-co-"));
  mkdirSync(join(checkout, ".infra", "env"), { recursive: true });
  writeFileSync(join(checkout, ".infra", "manifest.yaml"), MANIFEST);

  const state = mkdtempSync(join(tmpdir(), "cast-state-"));
  mkdirSync(join(state, "secrets"));
  writeFileSync(
    join(state, ".coolify.env"),
    `COOLIFY_BASE_URL="${url}"\nCOOLIFY_ACCESS_TOKEN="t"\n`,
  );
  // No template refs any secret, but the store still has to exist and open —
  // diff resolves the environment's secrets before it reads anything live.
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
      // Keyed by the full slug, and nested under the environment — the shape
      // that can say "this project goes HERE and that one goes THERE".
      ...(declared
        ? [
            "    projects:",
            "      heavy-duty/incubator:",
            `        destination_uuid: ${declared}`,
          ]
        : []),
      "github_apps:",
      "  incubator: hdb-coolify",
      "",
    ].join("\n"),
  );
  return { checkout, state };
}

function run(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["dist/cli.js", "diff", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CAST_AGE_KEY_FILE_STAGING: keyFile },
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

const base = (f: { checkout: string; state: string }) => [
  "heavy-duty/incubator",
  "--env",
  "staging",
  "--path",
  f.checkout,
  "--state",
  f.state,
];

describe("cast diff — placement (#21)", () => {
  it("reports the destination it declared, and says it could not verify it", async () => {
    const f = fixture(
      (await stubCoolify({ core: 5, landing: 5 })).url,
      "d-abc",
    );
    const r = await run(base(f));
    // Clean: a declared destination is never itself drift. There is nothing on
    // the wire to compare it to, and a phantom "update" would never clear.
    expect(r.code).toBe(0);
    expect(r.output).toContain("placement: all resources on destination 5");
    // The load-bearing sentence. cast enforces this UUID once, at create, and
    // can never check it again — an operator who reads a clean diff as "the
    // isolation is verified" is exactly the person #21 is written for.
    expect(r.output).toContain("d-abc");
    expect(r.output).toMatch(/NOT compared/);
    expect(r.output).toContain("clean");
  });

  // The failure the issue is actually about: the isolation looks configured and
  // isn't. Two of this project's apps, two different networks.
  it("fails a split project, naming both sides of the split", async () => {
    const f = fixture(
      (await stubCoolify({ core: 5, landing: 9 })).url,
      "d-abc",
    );
    const r = await run(base(f));
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/split placement: these resources sit on 2/);
    expect(r.output).toContain("destination 5: application core");
    expect(r.output).toContain("destination 9: application landing");
    // Reported, never repaired — the orphan disposition.
    expect(r.output).toMatch(/apply never moves a live resource between/);
    expect(r.output).not.toContain("clean");
  });

  // A split is a split whether or not the state file has caught up: it is read
  // off the live side alone. This is what catches a box where someone made the
  // destinations by hand and cast has never been told.
  it("catches a split even when no destination is declared", async () => {
    const f = fixture((await stubCoolify({ core: 5, landing: 9 })).url);
    const r = await run(base(f));
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/split placement/);
    // ...and with nothing declared there is no unverifiable claim to warn about.
    expect(r.output).not.toMatch(/NOT compared/);
  });

  // The state of every box today: one project, one server, one network, nothing
  // declared. Placement must be silent — a line on every diff that says nothing
  // is how a report stops being read.
  it("says nothing at all about placement on an undeclared, unsplit box", async () => {
    const f = fixture((await stubCoolify({ core: 5, landing: 5 })).url);
    const r = await run(base(f));
    expect(r.code).toBe(0);
    expect(r.output).not.toMatch(/placement/);
    expect(r.output).toContain("clean");
  });
});
