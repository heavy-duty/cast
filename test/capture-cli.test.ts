import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { decryptSecrets, encryptSecrets } from "../src/secrets.js";

// End-to-end: the real CLI, a real age identity, a stub Coolify holding real
// live values. The point is the store that comes out the other side — it is
// decrypted and asserted on, so "exactly the names the manifest requires, no
// more and no fewer" is checked against the actual ciphertext rather than
// against cast's own console output.

const SECRETS = {
  // Points at the SOURCE box. Must NOT be carried over.
  DATABASE_URL: "postgres://user:pw@SOURCE-BOX-postgres:5432/app",
  MAILGUN_API_KEY: "key-REAL-MAILGUN-SECRET",
  OPENROUTER_API_KEY: "sk-or-REAL-OPENROUTER-SECRET",
  // A real founder. Must NOT be carried over to staging.
  ADMIN_EMAIL: "founder@real-company.com",
  // Live on the box, but the manifest never asks for it.
  UNRELATED_LIVE_VAR: "nobody-asked-for-this",
};

let keyFile: string;
let recipient: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "cast-age-"));
  keyFile = join(dir, "age-staging.key");
  execFileSync("age-keygen", ["-o", keyFile], { stdio: "pipe" });
  const pub = execFileSync("age-keygen", ["-y", keyFile], { encoding: "utf8" });
  recipient = pub.trim();
});

type Stub = { url: string; close: () => Promise<void> };
const stubs: Stub[] = [];

// A Coolify with one project, one environment, one application carrying the
// live env above.
async function stubCoolify(): Promise<Stub> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").replace("/api/v1", "");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/teams/current") return json({ id: 0, name: "Root Team" });
    if (path === "/projects") return json([{ uuid: "p1", name: "incubator" }]);
    if (path === "/projects/p1/staging")
      return json({ applications: [{ name: "core", uuid: "a1" }] });
    if (path === "/applications/a1/envs")
      return json(
        Object.entries(SECRETS).map(([key, real_value]) => ({
          key,
          real_value,
          value: "REDACTED",
        })),
      );
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
    generated_secrets: [DATABASE_URL_STAGING]
    applications:
      core:
        source: { repo: heavy-duty/incubator, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: ["http://core.example.com"]
        env_template: core.staging.env.template
`;

// NODE_ENV is a literal, not a secret — it must not reach the store.
const TEMPLATE = `NODE_ENV=production
DATABASE_URL=\${DATABASE_URL_STAGING}
MAILGUN_API_KEY=\${MAILGUN_API_KEY}
OPENROUTER_API_KEY=\${OPENROUTER_API_KEY}
ADMIN_EMAIL=\${ADMIN_EMAIL}
`;

function fixture(
  url: string,
  opts: { template?: string; manifest?: string } = {},
) {
  const checkout = mkdtempSync(join(tmpdir(), "cast-co-"));
  mkdirSync(join(checkout, ".infra", "env"), { recursive: true });
  writeFileSync(
    join(checkout, ".infra", "manifest.yaml"),
    opts.manifest ?? MANIFEST,
  );
  writeFileSync(
    join(checkout, ".infra", "env", "core.staging.env.template"),
    opts.template ?? TEMPLATE,
  );

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
      `    age_recipient: ${recipient}`,
      "github_apps:",
      "  incubator: hdb-coolify",
      "",
    ].join("\n"),
  );
  return {
    checkout,
    state,
    store: join(state, "secrets", "incubator.staging.env.age"),
  };
}

function runCapture(
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["dist/cli.js", "capture", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });
    let output = "";
    child.stdout.on("data", (d) => {
      output += String(d);
    });
    child.stderr.on("data", (d) => {
      output += String(d);
    });
    child.stdin.end(opts.stdin ?? "");
    child.on("close", (code) => resolve({ code: code ?? 0, output }));
  });
}

const base = (f: ReturnType<typeof fixture>) => [
  "heavy-duty/incubator",
  "--env",
  "staging",
  "--state",
  f.state,
  "--path",
  f.checkout,
];

describe("cast capture (end to end)", () => {
  it("writes a store with exactly the manifest's names, and the right provenance", async () => {
    const f = fixture((await stubCoolify()).url);
    const r = await runCapture([...base(f), "--override", "ADMIN_EMAIL"], {
      stdin: "staging\n",
      env: { CAST_CAPTURE_ADMIN_EMAIL: "operator@example.com" },
    });
    expect(r.code).toBe(0);
    expect(existsSync(f.store)).toBe(true);

    const store = decryptSecrets(f.store, keyFile);
    // No more, no fewer: the four ${...} refs. NODE_ENV is a literal, and
    // UNRELATED_LIVE_VAR is live but unasked-for — neither belongs here.
    expect(Object.keys(store).sort()).toEqual([
      "ADMIN_EMAIL",
      "DATABASE_URL_STAGING",
      "MAILGUN_API_KEY",
      "OPENROUTER_API_KEY",
    ]);
    // Captured verbatim.
    expect(store.MAILGUN_API_KEY).toBe(SECRETS.MAILGUN_API_KEY);
    expect(store.OPENROUTER_API_KEY).toBe(SECRETS.OPENROUTER_API_KEY);
    // Generated: the placeholder, NEVER the source box's own database URL.
    expect(store.DATABASE_URL_STAGING).toBe("pending-coolify-generated");
    expect(store.DATABASE_URL_STAGING).not.toContain("SOURCE-BOX");
    // Overridden: the operator's value, not the real founder's address.
    expect(store.ADMIN_EMAIL).toBe("operator@example.com");
    expect(store.ADMIN_EMAIL).not.toBe(SECRETS.ADMIN_EMAIL);
  });

  // "No secret value is ever written to stdout" — checked against the real
  // values the stub served, on the real console output of a real run.
  it("never prints a secret value to the console", async () => {
    const f = fixture((await stubCoolify()).url);
    const r = await runCapture([...base(f), "--override", "ADMIN_EMAIL"], {
      stdin: "staging\n",
      env: { CAST_CAPTURE_ADMIN_EMAIL: "operator@example.com" },
    });
    expect(r.code).toBe(0);
    for (const value of Object.values(SECRETS)) {
      expect(r.output).not.toContain(value);
    }
    expect(r.output).not.toContain("operator@example.com");
    // It did print the NAMES, though — that is the plan.
    expect(r.output).toContain("MAILGUN_API_KEY");
    expect(r.output).toContain("captured");
    expect(r.output).toContain("generated");
    expect(r.output).toContain("overridden");
  });

  // The plaintext exists only in memory and on age's stdin.
  it("leaves no plaintext behind — the store is real ciphertext", async () => {
    const f = fixture((await stubCoolify()).url);
    await runCapture([...base(f), "--override", "ADMIN_EMAIL"], {
      stdin: "staging\n",
      env: { CAST_CAPTURE_ADMIN_EMAIL: "operator@example.com" },
    });
    const raw = readFileSync(f.store, "utf8");
    expect(raw).toContain("age-encryption.org");
    for (const value of Object.values(SECRETS)) {
      expect(raw).not.toContain(value);
    }
  });

  // A name required by the template but absent from the source refuses the run
  // — writing an empty would boot the app misconfigured, plausibly.
  it("refuses when a required name is absent from the source", async () => {
    const f = fixture((await stubCoolify()).url, {
      template: `${TEMPLATE}TURNSTILE_SECRET=\${TURNSTILE_SECRET}\n`,
    });
    const r = await runCapture([...base(f), "--override", "ADMIN_EMAIL"], {
      stdin: "staging\n",
      env: { CAST_CAPTURE_ADMIN_EMAIL: "operator@example.com" },
    });
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/TURNSTILE_SECRET\s+MISSING/);
    expect(r.output).toMatch(/refusing to write the store/);
    expect(existsSync(f.store)).toBe(false);
  });

  // The confirmation is the last gate, and it is not "y".
  it("aborts, writing nothing, when the confirmation does not name the env", async () => {
    const f = fixture((await stubCoolify()).url);
    const r = await runCapture([...base(f), "--override", "ADMIN_EMAIL"], {
      stdin: "y\n",
      env: { CAST_CAPTURE_ADMIN_EMAIL: "operator@example.com" },
    });
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/aborted/);
    expect(existsSync(f.store)).toBe(false);
  });

  it("aborts on a closed stdin rather than hanging", async () => {
    const f = fixture((await stubCoolify()).url);
    const r = await runCapture([...base(f), "--override", "ADMIN_EMAIL"], {
      stdin: "",
      env: { CAST_CAPTURE_ADMIN_EMAIL: "operator@example.com" },
    });
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/aborted/);
  });

  // An override's VALUE never comes from argv — argv is visible in `ps`.
  it("refuses an --override whose CAST_CAPTURE_<NAME> is unset", async () => {
    const f = fixture((await stubCoolify()).url);
    const r = await runCapture([...base(f), "--override", "ADMIN_EMAIL"], {
      stdin: "staging\n",
    });
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/CAST_CAPTURE_ADMIN_EMAIL/);
    expect(r.output).toMatch(/never from the command/);
  });

  // The store may hold the only copy of values the source box no longer has.
  it("refuses to overwrite an existing store without --force", async () => {
    const f = fixture((await stubCoolify()).url);
    writeFileSync(f.store, "PRE-EXISTING");
    const r = await runCapture([...base(f), "--override", "ADMIN_EMAIL"], {
      stdin: "staging\n",
      env: { CAST_CAPTURE_ADMIN_EMAIL: "operator@example.com" },
    });
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/already exists/);
    expect(r.output).toMatch(/--force/);
    expect(readFileSync(f.store, "utf8")).toBe("PRE-EXISTING");
  });

  it("refuses an environment with no age_recipient", async () => {
    const f = fixture((await stubCoolify()).url);
    writeFileSync(
      join(f.state, "environments.yaml"),
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
    const r = await runCapture(base(f), { stdin: "staging\n" });
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/age_recipient/);
  });

  // Same position as diff: capture is only ever a claim about something that
  // already exists. Against an absent target it would call every secret
  // "missing" — an alarming report about the wrong box.
  it("refuses an absent target rather than reporting every secret missing", async () => {
    const f = fixture((await stubCoolify()).url);
    const r = await runCapture([...base(f), "--project", "typo"], {
      stdin: "staging\n",
    });
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/refusing to capture/);
    expect(r.output).toMatch(/no project named "typo"/);
    expect(r.output).not.toMatch(/MISSING/);
  });
});

// ---------------------------------------------------------------------------
// Pass 2 — `cast capture --generated-only` (end to end)
//
// The bootstrap this closes: pass 1 wrote a store in which the generated names
// are placeholders, `apply` then created the database, and Coolify generated the
// real URL. Until this runs, the store's value is a lie while the live value is
// real — which is the state that makes the next routine apply overwrite a
// working secret (#47). Everything here runs against a real age identity and a
// real `dist/cli.js`; the store is decrypted afterwards and asserted on.
// ---------------------------------------------------------------------------

// The values Coolify generated when it created the resources. NOT reachable from
// any application's env — the app's env holds what the template resolved to,
// which at this point in the bootstrap is the placeholder itself.
const PG_URL = "postgres://postgres:GENERATED-PG-PASSWORD@abc123:5432/app";
const REDIS_URL = "redis://default:GENERATED-REDIS-PASSWORD@def456:6379/0";
// Another project's database entirely. `GET /databases` would list it right next
// to ours — it is umami's bundled Postgres, the row the hand-run `jq` had to be
// careful not to pick. A name-directed lookup across the instance eventually
// takes it, and what it writes is a well-formed URL to the wrong database.
const UMAMI_URL = "postgres://umami:UMAMI-PASSWORD@zzz999:5432/umami";

const GEN_MANIFEST = `project: incubator
environments:
  staging:
    generated_secrets: [DATABASE_URL, REDIS_URL]
    applications:
      core:
        source: { repo: heavy-duty/incubator, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: ["http://core.example.com"]
        env_template: core.staging.env.template
    databases:
      incubator-db: { type: postgresql }
      incubator-redis: { type: redis }
`;

const GEN_TEMPLATE = `NODE_ENV=production
DATABASE_URL=\${DATABASE_URL}
REDIS_URL=\${REDIS_URL}
MAILGUN_API_KEY=\${MAILGUN_API_KEY}
`;

// What pass 1 left behind: the two generated names placeheld, the real secret
// captured. Pass 2 must fill the first two and not disturb the third.
const PASS1_STORE = {
  DATABASE_URL: "pending-coolify-generated",
  REDIS_URL: "pending-coolify-generated",
  MAILGUN_API_KEY: "key-REAL-MAILGUN-SECRET",
};

// Records every path the CLI asks for, so a test can assert on what cast did
// NOT call — `GET /databases` is instance-wide, and never reaching for it is the
// point, not an implementation detail.
async function stubCoolifyWithDatabases(): Promise<Stub & { hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "").replace("/api/v1", "");
    hits.push(path);
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/teams/current") return json({ id: 0, name: "Root Team" });
    if (path === "/projects")
      return json([
        { uuid: "p1", name: "incubator" },
        { uuid: "p2", name: "analytics" },
      ]);
    // The project+environment document. Coolify's environment_details eager-loads
    // these relations and serializes the models whole, so `internal_db_url` (an
    // appended attribute on StandalonePostgresql / StandaloneRedis) rides along.
    if (path === "/projects/p1/staging")
      return json({
        applications: [{ name: "core", uuid: "a1" }],
        postgresqls: [
          { name: "incubator-db", uuid: "abc123", internal_db_url: PG_URL },
        ],
        redis: [
          {
            name: "incubator-redis",
            uuid: "def456",
            internal_db_url: REDIS_URL,
          },
        ],
      });
    // Instance-wide: OURS and somebody else's, indistinguishable by name alone.
    // Nothing in cast may read this.
    if (path === "/databases")
      return json([
        { name: "incubator-db", internal_db_url: PG_URL },
        { name: "incubator-redis", internal_db_url: REDIS_URL },
        { name: "incubator-db", internal_db_url: UMAMI_URL },
      ]);
    // The app's env — it holds the PLACEHOLDER, which is exactly why the value
    // must be read off the database instead.
    if (path === "/applications/a1/envs")
      return json([
        {
          key: "DATABASE_URL",
          real_value: "pending-coolify-generated",
          value: "REDACTED",
        },
        {
          key: "MAILGUN_API_KEY",
          real_value: "key-REAL-MAILGUN-SECRET",
          value: "REDACTED",
        },
      ]);
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((r) => {
    server.listen(0, "127.0.0.1", r);
  });
  const stub = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
    hits,
  };
  stubs.push(stub);
  return stub;
}

// A fixture whose store is already what pass 1 would have written.
function genFixture(url: string, store: Record<string, string> = PASS1_STORE) {
  const f = fixture(url, { manifest: GEN_MANIFEST, template: GEN_TEMPLATE });
  encryptSecrets(recipient, f.store, store);
  return f;
}

const genBase = (f: ReturnType<typeof fixture>) => [
  ...base(f),
  "--generated-only",
];

// Pass 2 reads the store before it fills it, so it needs the age IDENTITY —
// not just the recipient pass 1 needed.
const withKey = () => ({ CAST_AGE_KEY_FILE_STAGING: keyFile });

const FROM = [
  "--from",
  "DATABASE_URL=incubator-db",
  "--from",
  "REDIS_URL=incubator-redis",
];

describe("cast capture --generated-only (end to end)", () => {
  it("fills the generated names from the databases that own them, and leaves the rest alone", async () => {
    const stub = await stubCoolifyWithDatabases();
    const f = genFixture(stub.url);
    const r = await runCapture([...genBase(f), ...FROM], {
      stdin: "staging\n",
      env: withKey(),
    });
    expect(r.code).toBe(0);

    const store = decryptSecrets(f.store, keyFile);
    // The postcondition, asserted on the actual ciphertext: zero placeholders,
    // and the name count unchanged.
    expect(Object.keys(store).sort()).toEqual([
      "DATABASE_URL",
      "MAILGUN_API_KEY",
      "REDIS_URL",
    ]);
    expect(Object.values(store)).not.toContain("pending-coolify-generated");
    // Each from the resource that OWNS it — and the redis one is a redis URL,
    // not the Postgres URL under a redis name.
    expect(store.DATABASE_URL).toBe(PG_URL);
    expect(store.REDIS_URL).toBe(REDIS_URL);
    // Carried over byte for byte. Pass 2 never re-read it from the box.
    expect(store.MAILGUN_API_KEY).toBe("key-REAL-MAILGUN-SECRET");
    // Never the other project's database.
    expect(store.DATABASE_URL).not.toContain("UMAMI");
    expect(r.output).toMatch(/zero pending-coolify-generated remaining/);
  });

  // The #29 hazard, structurally: the value is resolved inside the project and
  // environment, so the instance-wide list is never even consulted.
  it("never reads the instance-wide database list", async () => {
    const stub = await stubCoolifyWithDatabases();
    const f = genFixture(stub.url);
    const r = await runCapture([...genBase(f), ...FROM], {
      stdin: "staging\n",
      env: withKey(),
    });
    expect(r.code).toBe(0);
    expect(stub.hits).toContain("/projects/p1/staging");
    expect(stub.hits).not.toContain("/databases");
  });

  // capture.ts:166's rule holds in pass 2: the only value-shaped thing printed
  // is the placeholder literal being replaced.
  it("never prints a secret value to the console", async () => {
    const stub = await stubCoolifyWithDatabases();
    const f = genFixture(stub.url);
    const r = await runCapture([...genBase(f), ...FROM], {
      stdin: "staging\n",
      env: withKey(),
    });
    expect(r.code).toBe(0);
    for (const value of [PG_URL, REDIS_URL, "key-REAL-MAILGUN-SECRET"]) {
      expect(r.output).not.toContain(value);
    }
    expect(r.output).not.toContain("GENERATED-PG-PASSWORD");
    // The NAMES, and where each value came from, are the plan.
    expect(r.output).toMatch(/DATABASE_URL\s+fill/);
    expect(r.output).toContain("incubator-db (postgresql) internal_db_url");
    expect(r.output).toMatch(/MAILGUN_API_KEY\s+keep/);
  });

  // Nothing in the manifest, the templates or the box says DATABASE_URL comes
  // from the postgres one. cast will not guess — it hands back the flag.
  it("refuses to guess which database a name comes from, and says how to say it", async () => {
    const stub = await stubCoolifyWithDatabases();
    const f = genFixture(stub.url);
    const r = await runCapture(genBase(f), {
      stdin: "staging\n",
      env: withKey(),
    });
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/UNMAPPED/);
    expect(r.output).toContain("--from DATABASE_URL=<database name>");
    // Refused BEFORE the store was touched.
    expect(decryptSecrets(f.store, keyFile)).toEqual(PASS1_STORE);
  });

  // The refusal that keeps this from being a silent credential rotation.
  it("refuses to overwrite a generated name that already holds a real value", async () => {
    const stub = await stubCoolifyWithDatabases();
    const f = genFixture(stub.url, {
      ...PASS1_STORE,
      DATABASE_URL: "postgres://set:BY-HAND@live:5432/app",
    });
    const r = await runCapture([...genBase(f), ...FROM], {
      stdin: "staging\n",
      env: withKey(),
    });
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/OCCUPIED/);
    expect(r.output).toMatch(/rotate a live credential/);
    expect(r.output).toMatch(/--force/);
    // Untouched — including the name it COULD have filled. A refusal is a stop,
    // not a partial write.
    const store = decryptSecrets(f.store, keyFile);
    expect(store.DATABASE_URL).toBe("postgres://set:BY-HAND@live:5432/app");
    expect(store.REDIS_URL).toBe("pending-coolify-generated");
  });

  it("--force rotates it deliberately", async () => {
    const stub = await stubCoolifyWithDatabases();
    const f = genFixture(stub.url, {
      ...PASS1_STORE,
      DATABASE_URL: "postgres://set:BY-HAND@live:5432/app",
    });
    const r = await runCapture([...genBase(f), ...FROM, "--force"], {
      stdin: "staging\n",
      env: withKey(),
    });
    expect(r.code).toBe(0);
    expect(decryptSecrets(f.store, keyFile).DATABASE_URL).toBe(PG_URL);
  });

  // Pass 2 fills a store; it does not create one. A store written from here
  // would hold the generated names and nothing else.
  it("refuses when the store does not exist — pass 1 has not run", async () => {
    const stub = await stubCoolifyWithDatabases();
    const f = fixture(stub.url, {
      manifest: GEN_MANIFEST,
      template: GEN_TEMPLATE,
    });
    const r = await runCapture([...genBase(f), ...FROM], {
      stdin: "staging\n",
      env: withKey(),
    });
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/does not exist/);
    expect(r.output).toMatch(/Pass 2 FILLS the generated names/);
    expect(existsSync(f.store)).toBe(false);
  });

  // A placeholder nobody fills would leave the store still lying — and the next
  // apply would push that literal at a live app.
  it("refuses to leave a placeholder standing in a name it does not fill", async () => {
    const stub = await stubCoolifyWithDatabases();
    const f = genFixture(stub.url, {
      ...PASS1_STORE,
      MAILGUN_API_KEY: "pending-coolify-generated",
    });
    const r = await runCapture([...genBase(f), ...FROM], {
      stdin: "staging\n",
      env: withKey(),
    });
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/MAILGUN_API_KEY\s+PENDING/);
    expect(r.output).toMatch(/would still hold the/);
  });

  // The confirmation is the same last gate as pass 1, and it is not "y".
  it("aborts, writing nothing, when the confirmation does not name the env", async () => {
    const stub = await stubCoolifyWithDatabases();
    const f = genFixture(stub.url);
    const r = await runCapture([...genBase(f), ...FROM], {
      stdin: "y\n",
      env: withKey(),
    });
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/aborted/);
    expect(decryptSecrets(f.store, keyFile)).toEqual(PASS1_STORE);
  });

  // A flag pairing that can never be honored: pass 2 captures nothing, so there
  // is nothing for an override to override.
  it("refuses --override with --generated-only", async () => {
    const stub = await stubCoolifyWithDatabases();
    const f = genFixture(stub.url);
    const r = await runCapture(
      [...genBase(f), ...FROM, "--override", "MAILGUN_API_KEY"],
      { stdin: "staging\n", env: withKey() },
    );
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/refuses --override with --generated-only/);
  });

  it("refuses --from without --generated-only", async () => {
    const stub = await stubCoolifyWithDatabases();
    const f = fixture(stub.url, {
      manifest: GEN_MANIFEST,
      template: GEN_TEMPLATE,
    });
    const r = await runCapture([...base(f), ...FROM], { stdin: "staging\n" });
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/refuses --from without --generated-only/);
  });

  // A --from for a name that is not generated would be silently ignored, and
  // the operator would walk away believing they had set a value.
  it("refuses a --from naming something that is not a generated secret", async () => {
    const stub = await stubCoolifyWithDatabases();
    const f = genFixture(stub.url);
    const r = await runCapture(
      [...genBase(f), "--from", "MAILGUN_API_KEY=incubator-db"],
      { stdin: "staging\n", env: withKey() },
    );
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/is not a generated secret/);
  });
});

// --resource maps manifest names to box names for the env-reading pass, and pass
// 2 reads no env. Accepted, it would be silently ignored.
describe("cast capture --generated-only (flag hygiene)", () => {
  it("refuses --resource with --generated-only", async () => {
    const stub = await stubCoolifyWithDatabases();
    const f = genFixture(stub.url);
    const r = await runCapture(
      [...genBase(f), ...FROM, "--resource", "core=Core"],
      { stdin: "staging\n", env: withKey() },
    );
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/refuses --resource with --generated-only/);
  });
});
