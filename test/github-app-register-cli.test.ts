import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// `cast github-app register` through the real CLI: argv parsing, the stdin-only
// client secret, the team assert, the name resolved from state, the
// post-condition check, and WHEN environments.yaml is written.
//
// The Coolify here is a stub. Registration against a live instance is
// operator-only territory (#7's testability boundary) and nothing in this file
// pretends otherwise — what it proves is that cast sends the right things and
// reacts correctly to each answer.

let privateKeyPem: string;

beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
});

type Stub = {
  url: string;
  hits: string[];
  bodies: Record<string, Record<string, unknown>>;
  close: () => Promise<void>;
};
const stubs: Stub[] = [];

async function stubCoolify(opts: { repositories: unknown }): Promise<Stub> {
  const hits: string[] = [];
  const bodies: Record<string, Record<string, unknown>> = {};
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "", "http://x").pathname.replace(
      "/api/v1",
      "",
    );
    const key = `${req.method} ${path}`;
    hits.push(key);
    let raw = "";
    req.on("data", (d) => {
      raw += String(d);
    });
    req.on("end", () => {
      if (raw) bodies[key] = JSON.parse(raw);
      const json = (body: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (path === "/teams/current") return json({ id: 0, name: "Root Team" });
      if (path === "/security/keys") return json({ uuid: "key-uuid-1" });
      if (path === "/github-apps" && req.method === "POST")
        return json({ id: 7, uuid: "app-uuid" });
      // A clean instance: nothing registered under this name yet, so register
      // goes on to create. (The list read is how it avoids a duplicate Source
      // on a re-run — Coolify does not enforce unique names.)
      if (path === "/github-apps" && req.method === "GET") return json([]);
      if (path === "/github-apps/7/repositories")
        return json({ repositories: opts.repositories });
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

function fixture(
  url: string,
  githubApps: string,
): { state: string; pem: string } {
  const state = mkdtempSync(join(tmpdir(), "cast-state-"));
  writeFileSync(
    join(state, ".coolify.env"),
    `COOLIFY_BASE_URL="${url}"\nCOOLIFY_ACCESS_TOKEN="t"\n`,
  );
  writeFileSync(
    join(state, "environments.yaml"),
    [
      "# hand-maintained",
      "environments:",
      "  prod:",
      "    server: prod-box",
      "    team: { id: 0, name: Root Team }",
      githubApps,
      "",
    ].join("\n"),
  );
  const pem = join(state, "downloaded.pem");
  writeFileSync(pem, privateKeyPem);
  return { state, pem };
}

function run(
  args: string[],
  stdin: string | null,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["dist/cli.js", ...args], {
      stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (stdin !== null) {
      child.stdin?.end(stdin);
    }
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

const REGISTER = (state: string, pem: string) => [
  "github-app",
  "register",
  "heavy-duty/incubator",
  "--env",
  "prod",
  "--state",
  state,
  "--app-id",
  "12345",
  "--installation-id",
  "99887766",
  "--client-id",
  "Iv23liABCDEF",
  "--client-secret-stdin",
  "--private-key",
  pem,
];

describe("cast github-app register", () => {
  it("registers against the name in state, verifies the repo, and never takes the secret from argv", async () => {
    const stub = await stubCoolify({
      repositories: [{ full_name: "heavy-duty/incubator" }],
    });
    const f = fixture(
      stub.url,
      "github_apps:\n  heavy-duty/incubator: hdb-coolify-prod",
    );
    const r = await run(REGISTER(f.state, f.pem), "the-client-secret\n");
    expect(r.code).toBe(0);
    expect(r.output).toContain('team id=0 name="Root Team" ✓');
    expect(r.output).toContain("(from environments.yaml)");
    expect(r.output).toContain(
      "verified: hdb-coolify-prod can clone heavy-duty/incubator ✓",
    );
    // The secret reached Coolify, and it came off stdin — it is nowhere in
    // argv, which `ps` shows and shell history keeps.
    expect(stub.bodies["POST /github-apps"].client_secret).toBe(
      "the-client-secret",
    );
    expect(stub.bodies["POST /security/keys"].name).toBe(
      "hdb-coolify-prod-key",
    );
    // A webhook-INACTIVE App is the right shape for a tailnet-only Coolify, so
    // no operator has to invent a placeholder any more (#5 footgun 3).
    expect(r.output).toContain("generated one");
    expect(
      String(stub.bodies["POST /github-apps"].webhook_secret).length,
    ).toBeGreaterThan(0);
    // The credentials landed in the state dir, under a git-ignored directory.
    expect(
      readFileSync(
        join(f.state, "github-apps", "hdb-coolify-prod.pem"),
        "utf8",
      ),
    ).toBe(privateKeyPem);
    expect(
      readFileSync(join(f.state, "github-apps", ".gitignore"), "utf8"),
    ).toContain("*");
  });

  it("seeds an ABSENT binding from --name, keyed by the full slug, comments intact", async () => {
    const stub = await stubCoolify({
      repositories: [{ full_name: "heavy-duty/incubator" }],
    });
    const f = fixture(stub.url, "github_apps: {}");
    const r = await run(
      [...REGISTER(f.state, f.pem), "--name", "hdb-coolify-prod"],
      "s\n",
    );
    expect(r.code).toBe(0);
    const after = readFileSync(join(f.state, "environments.yaml"), "utf8");
    expect(after).toContain("heavy-duty/incubator: hdb-coolify-prod");
    expect(after).toContain("# hand-maintained");
  });

  it("REFUSES a --name that disagrees with the state file", async () => {
    const stub = await stubCoolify({ repositories: [] });
    const f = fixture(
      stub.url,
      "github_apps:\n  heavy-duty/incubator: hdb-coolify-prod",
    );
    const r = await run(
      [...REGISTER(f.state, f.pem), "--name", "My Cool App"],
      "s\n",
    );
    expect(r.code).toBe(1);
    expect(r.output).toContain("disagrees with environments.yaml");
    // Refused before it touched Coolify at all — not even the team assert.
    expect(stub.hits).toEqual([]);
  });

  it("refuses a client secret passed any way other than stdin", async () => {
    const stub = await stubCoolify({ repositories: [] });
    const f = fixture(
      stub.url,
      "github_apps:\n  heavy-duty/incubator: hdb-coolify-prod",
    );
    const withoutFlag = REGISTER(f.state, f.pem).filter(
      (a) => a !== "--client-secret-stdin",
    );
    const r = await run(withoutFlag, null);
    expect(r.code).toBe(2);
    expect(r.output).toContain("--client-secret-stdin is required");
  });

  it("fails, and does NOT seed state, when the App cannot see the repo", async () => {
    // A state file naming an App that does not work is worse than one naming
    // none: the next `cast apply` resolves it, uses it, and fails at clone time.
    const stub = await stubCoolify({
      repositories: [{ full_name: "heavy-duty/something-else" }],
    });
    const f = fixture(stub.url, "github_apps: {}");
    const r = await run(
      [...REGISTER(f.state, f.pem), "--name", "hdb-coolify-prod"],
      "s\n",
    );
    expect(r.code).toBe(1);
    expect(r.output).toContain("cannot see heavy-duty/incubator");
    expect(r.output).toContain("can see: heavy-duty/something-else");
    expect(readFileSync(join(f.state, "environments.yaml"), "utf8")).toContain(
      "github_apps: {}",
    );
  });

  it("refuses a read-only instance before any write", async () => {
    const stub = await stubCoolify({ repositories: [] });
    const f = fixture(
      stub.url,
      "github_apps:\n  heavy-duty/incubator: hdb-coolify-prod",
    );
    writeFileSync(
      join(f.state, ".coolify.env"),
      `COOLIFY_BASE_URL="${stub.url}"\nCOOLIFY_ACCESS_TOKEN="t"\nCOOLIFY_READ_ONLY=true\n`,
    );
    const r = await run(REGISTER(f.state, f.pem), "s\n");
    expect(r.code).toBe(1);
    expect(r.output).toContain("refusing to github-app register");
    expect(stub.hits).toEqual([]);
  });

  // Invalid ids must be refused before ANYTHING happens (cast#7 review).
  // `register` persists the credential record before it calls Coolify, and
  // `Number("nope")` is NaN which `JSON.stringify` writes as `null` — so
  // without this gate a typo produces a credential file with a null app_id AND
  // a security key uploaded to a live Coolify, from a run that then fails.
  // Both halves are asserted: no stub hit, and no file written.
  for (const [what, argv] of [
    ["a non-numeric --app-id", ["--app-id", "nope"]],
    ["a non-numeric --installation-id", ["--installation-id", "nope"]],
    ["a zero --app-id", ["--app-id", "0"]],
    ["a decimal --app-id", ["--app-id", "12.5"]],
    // Integers to JavaScript, but not how an id is written — and silently
    // storing 1000 for "1e3" is the quiet wrong answer, not a convenience.
    ["an exponent --app-id", ["--app-id", "1e3"]],
    ["a hex --app-id", ["--app-id", "0x10"]],
  ] as const) {
    it(`refuses ${what} before touching disk or Coolify`, async () => {
      const stub = await stubCoolify({
        repositories: [{ full_name: "heavy-duty/incubator" }],
      });
      const f = fixture(
        stub.url,
        "github_apps:\n  heavy-duty/incubator: hdb-coolify-prod",
      );
      const before = readdirSync(f.state).sort();

      const base = REGISTER(f.state, f.pem);
      const i = base.indexOf(argv[0]);
      const args = [...base];
      args[i + 1] = argv[1];

      const r = await run(args, "s\n");
      expect(r.code).toBe(2);
      expect(r.output).toContain("must be a positive integer");
      // Nothing reached the network...
      expect(stub.hits).toEqual([]);
      // ...and nothing was created or rewritten in the state dir.
      expect(readdirSync(f.state).sort()).toEqual(before);
    });
  }

  // A NEGATIVE id never reaches the check above: parseArgs reads a leading dash
  // as an option and rejects `-5` as unknown, exiting 1 rather than 2. That is
  // still a refusal before any write or request, which is the property that
  // matters — but it is a different code path with a different exit code, so it
  // gets its own case rather than a loosened assertion hiding the difference.
  it("refuses a negative --app-id before touching disk or Coolify", async () => {
    const stub = await stubCoolify({
      repositories: [{ full_name: "heavy-duty/incubator" }],
    });
    const f = fixture(
      stub.url,
      "github_apps:\n  heavy-duty/incubator: hdb-coolify-prod",
    );
    const before = readdirSync(f.state).sort();

    const base = REGISTER(f.state, f.pem);
    const args = [...base];
    args[base.indexOf("--app-id") + 1] = "-5";

    const r = await run(args, "s\n");
    expect(r.code).not.toBe(0);
    expect(stub.hits).toEqual([]);
    expect(readdirSync(f.state).sort()).toEqual(before);
  });

  // `--port` belongs to the CREATE path, and had the same defect the ids did:
  // `Number("abc")` is NaN, which reaches server.listen(NaN) and dies as an
  // uncaught ERR_SOCKET_BAD_PORT stack trace — after detectOwnerType and the
  // org-admin preflight have already gone out. Nothing is lost when it fails
  // (no App and no secret exist yet), so this is about the command honouring
  // its own rule — reject before any write or network call — and failing with
  // a sentence rather than a stack trace.
  //
  // Driven through `create` because that is the path that reads the flag. The
  // validation sits in the shared preamble, above openCoolify, so the run ends
  // before the browser flow this command would otherwise need.
  for (const [what, port] of [
    ["a non-numeric --port", "abc"],
    ["an out-of-range --port", "99999"],
    ["a zero --port", "0"],
    ["a decimal --port", "80.5"],
  ] as const) {
    it(`refuses ${what} before touching disk or Coolify`, async () => {
      const stub = await stubCoolify({ repositories: [] });
      const f = fixture(
        stub.url,
        "github_apps:\n  heavy-duty/incubator: hdb-coolify-prod",
      );
      const before = readdirSync(f.state).sort();

      const r = await run(
        [
          "github-app",
          "create",
          "heavy-duty/incubator",
          "--env",
          "prod",
          "--state",
          f.state,
          "--port",
          port,
        ],
        null,
      );
      expect(r.code).toBe(2);
      expect(r.output).toContain("--port must be a port number");
      expect(stub.hits).toEqual([]);
      expect(readdirSync(f.state).sort()).toEqual(before);
    });
  }

  it("prints usage for an unknown subcommand", async () => {
    const r = await run(["github-app", "wat"], null);
    expect(r.code).toBe(2);
    expect(r.output).toContain("cast github-app create");
    expect(r.output).toContain("cast github-app register");
  });
});
