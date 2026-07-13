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
import { decryptSecrets } from "../src/secrets.js";

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

function fixture(url: string, opts: { template?: string } = {}) {
  const checkout = mkdtempSync(join(tmpdir(), "cast-co-"));
  mkdirSync(join(checkout, ".infra", "env"), { recursive: true });
  writeFileSync(join(checkout, ".infra", "manifest.yaml"), MANIFEST);
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
