import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { tmp } from "./helpers/tmp.js";

// HTTP basic auth on an application, end to end: manifest -> the real binary ->
// what goes on the wire and what reaches the terminal (cast#76).
//
// The unit tests prove each half (the schema refuses a literal password;
// projectLiveFields never projects one; computeDiff skips what it could not
// read; completeBasicAuth puts the triple back into a partial payload). This
// proves they are wired to each other, and pins the two facts that only a real
// request can show: that the CREATE body carries all three keys, and that a
// PATCH triggered by a drifted TOGGLE still carries the credentials Coolify
// requires alongside it.
//
// BOUNDARY, stated because it matters: the Coolify here is a stub of this
// repo's own making. These tests prove what cast SENDS. They cannot prove that a
// real 4.1.2 accepts it, that label regeneration behaves as cast#72 read it, or
// that a sensitive-data token returns the password on any given route — every
// one of those is a claim about Coolify, sourced from reading Coolify, and none
// has been run against a live instance.

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

type Stub = {
  url: string;
  hits: string[];
  bodies: Record<string, Record<string, unknown>>;
  close: () => Promise<void>;
};
const stubs: Stub[] = [];

// `app` is the knob: what the live application row looks like, or `null` for an
// environment with nothing in it (so the plan is a create). Everything else on
// the row matches the manifest below, so anything the diff reports is basic auth
// and nothing else.
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
          /* not JSON — not a body this test asks about */
        }
      }
      const json = (body: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (path === "/teams/current") return json({ id: 0, name: "Root Team" });
      if (path === "/servers")
        return json([{ uuid: "s1", name: "shared-box" }]);
      if (path === "/github-apps")
        return json([{ uuid: "gh1", name: "hdb-coolify" }]);
      if (path === "/projects" && req.method === "GET")
        return json([{ uuid: "p1", name: "incubator" }]);
      if (path === "/projects/p1/environments")
        return json([{ name: "staging" }]);
      if (path === "/projects/p1/staging")
        return json({ applications: app === null ? [] : [app] });
      if (path === "/applications" && req.method === "GET") return json([]);
      if (path === "/applications/private-github-app" && req.method === "POST")
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

// A live application row as Coolify's environment_details serializes one. Note
// what is NOT here on purpose: `http_basic_auth_password`. That is the whole
// read-side story — the column is hidden from an ordinary token at 4.1.2, and
// cast would not project it even if it arrived.
const liveApp = (over: Record<string, unknown> = {}) => ({
  name: "admin",
  uuid: "app-1",
  git_repository: "heavy-duty/incubator",
  git_branch: "main",
  build_pack: "nixpacks",
  base_directory: "/",
  fqdn: "https://admin.example.com",
  destination_id: 1,
  is_http_basic_auth_enabled: true,
  http_basic_auth_username: "ops",
  ...over,
});

const PASSWORD = "correct-horse-battery-staple";

const MANIFEST = `project: incubator
environments:
  staging:
    applications:
      admin:
        source: { repo: heavy-duty/incubator, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: ["https://admin.example.com"]
        basic_auth:
          enabled: true
          username: ops
          password: \${ADMIN_BASIC_AUTH}
`;

function fixture(url: string, store = `ADMIN_BASIC_AUTH=${PASSWORD}\n`) {
  const checkout = tmp("cast-co-");
  mkdirSync(join(checkout, ".infra", "env"), { recursive: true });
  writeFileSync(join(checkout, ".infra", "manifest.yaml"), MANIFEST);

  const state = tmp("cast-state-");
  mkdirSync(join(state, "secrets"));
  writeFileSync(
    join(state, ".coolify.env"),
    `COOLIFY_BASE_URL="${url}"\nCOOLIFY_ACCESS_TOKEN="t"\n`,
  );
  execFileSync("age", ["-r", recipient, "-o", "incubator.staging.env.age"], {
    input: store,
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
      "github_apps:",
      "  incubator: hdb-coolify",
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
        "heavy-duty/incubator",
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

describe("cast apply — basic auth reaches the wire (#76)", () => {
  it("sends all three keys on the CREATE, with the password out of the age store", async () => {
    const stub = await stubCoolify(null);
    const r = await run("apply", fixture(stub.url));
    expect(r.code).toBe(0);
    const body = stub.bodies["POST /applications/private-github-app"];
    expect(body.is_http_basic_auth_enabled).toBe(true);
    expect(body.http_basic_auth_username).toBe("ops");
    // The value came from the encrypted store via the manifest's ${REF} — the
    // manifest itself holds only the name.
    expect(body.http_basic_auth_password).toBe(PASSWORD);
  });

  // The case an update body assembled from field diffs alone would get wrong:
  // only the toggle drifted, and Coolify rejects an enable without credentials.
  it("sends the credentials alongside a toggle-only PATCH", async () => {
    const stub = await stubCoolify(
      liveApp({ is_http_basic_auth_enabled: false }),
    );
    const r = await run("apply", fixture(stub.url));
    expect(r.code).toBe(0);
    const body = stub.bodies["PATCH /applications/app-1"];
    expect(body.is_http_basic_auth_enabled).toBe(true);
    expect(body.http_basic_auth_username).toBe("ops");
    expect(body.http_basic_auth_password).toBe(PASSWORD);
  });

  // The other half of the same rule: no drift, no write. cast does not PATCH
  // basic auth onto every apply just because it cannot verify the password.
  it("writes nothing when the readable halves already agree", async () => {
    const stub = await stubCoolify(liveApp());
    const r = await run("apply", fixture(stub.url));
    expect(r.code).toBe(0);
    expect(stub.hits).not.toContain("PATCH /applications/app-1");
  });

  it("refuses before touching Coolify when the store does not hold the ref", async () => {
    const stub = await stubCoolify(null);
    const r = await run("apply", fixture(stub.url, "SOMETHING_ELSE=x\n"));
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("does not hold it");
    // Nothing was created on the way to finding out.
    expect(stub.hits).not.toContain("POST /applications/private-github-app");
  });
});

describe("cast diff — basic auth is honest about the password (#76)", () => {
  it("says the password was NOT compared, on a run it still calls clean", async () => {
    const r = await run("diff", fixture((await stubCoolify(liveApp())).url));
    expect(r.code).toBe(0);
    expect(r.output).toContain(
      "basic_auth on application admin declared, http_basic_auth_password NOT compared",
    );
    expect(r.output).toMatch(/^clean$/m);
  });

  it("never prints the password", async () => {
    const r = await run("diff", fixture((await stubCoolify(null)).url));
    expect(r.output).not.toContain(PASSWORD);
  });

  // The defect this feature closes, from the other direction: somebody turned
  // basic auth off on the box. An unreadable password must not make that
  // invisible.
  it("reports drift when the toggle was flipped off in the UI", async () => {
    const r = await run(
      "diff",
      fixture(
        (await stubCoolify(liveApp({ is_http_basic_auth_enabled: false }))).url,
      ),
    );
    expect(r.code).toBe(1);
    expect(r.output).toContain("is_http_basic_auth_enabled: false → true");
  });

  it("reports drift when the username was changed on the box", async () => {
    const r = await run(
      "diff",
      fixture(
        (await stubCoolify(liveApp({ http_basic_auth_username: "someone" })))
          .url,
      ),
    );
    expect(r.code).toBe(1);
    expect(r.output).toContain("http_basic_auth_username");
  });

  // A Coolify (or a token) that serves none of these columns must produce
  // neither a clean bill nor invented drift.
  it("claims nothing at all when the read carried no basic-auth state", async () => {
    const stub = await stubCoolify(
      liveApp({
        is_http_basic_auth_enabled: undefined,
        http_basic_auth_username: undefined,
      }),
    );
    const r = await run("diff", fixture(stub.url));
    expect(r.output).toContain(
      "is_http_basic_auth_enabled, http_basic_auth_username, http_basic_auth_password NOT compared",
    );
    expect(r.output).toMatch(/^clean$/m);
  });
});
