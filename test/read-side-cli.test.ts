import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// The read side, end to end, against a stub Coolify shaped like a box nobody
// declared: its project is `Incubator` (capital I), its environment is
// `production` (Coolify's default, not ours), and its application is called
// `incubator-stack` rather than the manifest's `core`.
//
// Every one of those three is a real name from the live box this work came out
// of, and each one used to fail differently and badly:
//
//   project      → refused (already fixed, #12)
//   environment  → refused, and the "obvious" fix was to rename OUR environment
//                  to match the box — letting a machine due for deletion name
//                  the new box's environment forever (#17)
//   resource     → NOT refused: reported every required secret as individually
//                  MISSING from a box that was serving production at the time,
//                  and invited --override to hand-carry all of them (#18)

const LIVE_ENV = {
  MAILGUN_API_KEY: "key-REAL-MAILGUN-SECRET",
  ADMIN_EMAIL: "founder@real-company.com",
  LEFTOVER_FROM_2019: "nobody-asked-for-this",
};

let recipient: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "cast-age-"));
  const keyFile = join(dir, "age.key");
  execFileSync("age-keygen", ["-o", keyFile], { stdio: "pipe" });
  recipient = execFileSync("age-keygen", ["-y", keyFile], {
    encoding: "utf8",
  }).trim();
});

type Stub = { url: string; close: () => Promise<void> };
const stubs: Stub[] = [];

// appName is the knob: `incubator-stack` is the hand-built box (the manifest's
// `core` does not exist on it); `core` is the box whose names happen to line up.
async function stubCoolify(appName: string): Promise<Stub> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").replace("/api/v1", "");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/teams/current") return json({ id: 0, name: "Root Team" });
    // Named as someone typed it, not as the repo slug would derive it.
    if (path === "/projects") return json([{ uuid: "p1", name: "Incubator" }]);
    // Coolify's default environment name — ours is `staging`.
    if (path === "/projects/p1/production")
      return json({ applications: [{ name: appName, uuid: "a1" }] });
    if (path === "/applications/a1/envs")
      return json(
        Object.entries(LIVE_ENV).map(([key, real_value]) => ({
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
    applications:
      core:
        source: { repo: heavy-duty/incubator, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: ["http://core.example.com"]
        env_template: core.staging.env.template
`;

const TEMPLATE = `NODE_ENV=production
MAILGUN_API_KEY=\${MAILGUN_API_KEY}
ADMIN_EMAIL=\${ADMIN_EMAIL}
`;

function fixture(url: string) {
  const checkout = mkdtempSync(join(tmpdir(), "cast-co-"));
  mkdirSync(join(checkout, ".infra", "env"), { recursive: true });
  writeFileSync(join(checkout, ".infra", "manifest.yaml"), MANIFEST);
  writeFileSync(
    join(checkout, ".infra", "env", "core.staging.env.template"),
    TEMPLATE,
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

function run(
  verb: string,
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["dist/cli.js", verb, ...args], {
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

describe("--environment (the read-side coordinate, #17)", () => {
  it("reads the box's environment name while the store keeps OURS", async () => {
    const f = fixture((await stubCoolify("core")).url);
    const r = await run(
      "capture",
      [
        ...base(f),
        "--project",
        "Incubator",
        "--environment",
        "production",
        "--override",
        "ADMIN_EMAIL",
      ],
      {
        stdin: "staging\n",
        env: { CAST_CAPTURE_ADMIN_EMAIL: "operator@example.com" },
      },
    );
    expect(r.code).toBe(0);
    // THE POINT: the box calls it `production`; we call it `staging`. The store
    // is keyed by OUR name. A hand-built box does not get to name our
    // environments, our store, or our age key — it only gets to be read.
    expect(existsSync(f.store)).toBe(true);
    expect(
      existsSync(join(f.state, "secrets", "incubator.production.env.age")),
    ).toBe(false);
  });

  it("refuses an absent environment by naming --environment, not by inviting a rename", async () => {
    const f = fixture((await stubCoolify("core")).url);
    // No --environment: cast looks for `staging`, the box has `production`.
    const r = await run("capture", [...base(f), "--project", "Incubator"]);
    expect(r.code).toBe(2);
    expect(r.output).toContain('has no environment "staging"');
    expect(r.output).toContain("Pass --environment <name>");
    // The old message said "re-run with --env naming the environment as it
    // exists here" — i.e. adopt the box's vocabulary as our own. That is the
    // sentence that cost us a rename across three repos.
    expect(r.output).not.toContain("Re-run with --env");
    expect(existsSync(f.store)).toBe(false);
  });
});

describe("absent resource (#18)", () => {
  it("refuses on the RESOURCE, naming what exists, instead of reporting every secret missing", async () => {
    const f = fixture((await stubCoolify("incubator-stack")).url);
    const r = await run("capture", [
      ...base(f),
      "--project",
      "Incubator",
      "--environment",
      "production",
    ]);
    expect(r.code).toBe(2);
    // The finding: the manifest and the box disagree about what this is called.
    expect(r.output).toContain("core");
    expect(r.output).toContain("incubator-stack");
    expect(r.output).toContain("do not exist here");
    // NOT the old report — a wall of per-name MISSING against a box that HAS
    // every one of those secrets, sitting right there under another name, with
    // --override offered as the remedy (which would have written a perfectly
    // valid store and buried the real problem forever).
    //
    // The assertion is that no INDIVIDUAL SECRET is named at all: this is a
    // resource-level finding, and reporting it per-secret is what made the
    // original failure so convincingly wrong. (Asserting on the word "MISSING"
    // would only catch the prose that explains why we are not doing that.)
    for (const name of Object.keys(LIVE_ENV)) {
      expect(r.output).not.toContain(name);
    }
    expect(existsSync(f.store)).toBe(false);
  });
});

describe("cast inventory (#19)", () => {
  it("shows both sides of a hand-built box — and no values", async () => {
    const f = fixture((await stubCoolify("incubator-stack")).url);
    const r = await run("inventory", [
      ...base(f),
      "--project",
      "Incubator",
      "--environment",
      "production",
    ]);
    expect(r.code).toBe(0);
    // Declared, absent from the box.
    expect(r.output).toContain("core");
    // On the box, undeclared — including a var the manifest never heard of.
    expect(r.output).toContain("incubator-stack");
    expect(r.output).toContain("LEFTOVER_FROM_2019");
    // Keys, never values. This artifact is meant to be pasted into a PR.
    for (const value of Object.values(LIVE_ENV)) {
      expect(r.output).not.toContain(value);
    }
  });

  it("needs no secret store, no age key, and no age_recipient to run", async () => {
    // The whole point: inventory runs BEFORE adoption, when none of those exist.
    const f = fixture((await stubCoolify("incubator-stack")).url);
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
    const r = await run("inventory", [
      ...base(f),
      "--project",
      "Incubator",
      "--environment",
      "production",
    ]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("inventory — heavy-duty/incubator staging");
  });
});

describe("--resource (the third name, #23)", () => {
  it("captures from a resource the box calls something else", async () => {
    const f = fixture((await stubCoolify("Incubator Stack v2")).url);
    const r = await run(
      "capture",
      [
        ...base(f),
        "--project",
        "Incubator",
        "--environment",
        "production",
        "--resource",
        "core=Incubator Stack v2",
        "--override",
        "ADMIN_EMAIL",
      ],
      {
        stdin: "staging\n",
        env: { CAST_CAPTURE_ADMIN_EMAIL: "operator@example.com" },
      },
    );
    expect(r.code).toBe(0);
    expect(existsSync(f.store)).toBe(true);
  });

  it("shows the box's own name beside ours, and diffs the KEYS of the pair", async () => {
    const f = fixture((await stubCoolify("Incubator Stack v2")).url);
    const r = await run("inventory", [
      ...base(f),
      "--project",
      "Incubator",
      "--environment",
      "production",
      "--resource",
      "core=Incubator Stack v2",
    ]);
    expect(r.code).toBe(0);
    // Matched — and the box's name is still there. A document that renamed the
    // box's resources to our vocabulary and never mentioned theirs would be
    // useless against the UI it describes.
    expect(r.output).toContain('← "Incubator Stack v2" on the box');
    // The finding that only becomes visible once they are PAIRED: a var the box
    // carries that the manifest has never heard of.
    expect(r.output).toContain("box only:");
    expect(r.output).toContain("LEFTOVER_FROM_2019");
  });

  it("tells you what to map, when nothing matched but the box is full", async () => {
    const f = fixture((await stubCoolify("Incubator Stack v2")).url);
    const r = await run("inventory", [
      ...base(f),
      "--project",
      "Incubator",
      "--environment",
      "production",
    ]);
    expect(r.code).toBe(0);
    // Not "the box is empty" — which is how a full-create plan gets laundered
    // into a pass. It is a naming gap, and the fix is printed.
    expect(r.output).toContain("NOTHING matched");
    expect(r.output).toContain('--resource core="<what this box calls it>"');
  });

  it("refuses an alias for a resource the manifest never declared", async () => {
    const f = fixture((await stubCoolify("Incubator Stack v2")).url);
    const r = await run("inventory", [
      ...base(f),
      "--project",
      "Incubator",
      "--environment",
      "production",
      "--resource",
      "cores=Incubator Stack v2",
    ]);
    // A typo here would be silent and expensive: the alias maps nothing, the
    // real resource is looked up under its own name, and the run refuses with
    // no hint that the flag missed.
    expect(r.code).not.toBe(0);
    expect(r.output).toContain('declares no resource named "cores"');
    expect(r.output).toContain("core");
  });

  it("refuses --resource on apply — it is a read-side coordinate", async () => {
    const f = fixture((await stubCoolify("Incubator Stack v2")).url);
    const r = await run("apply", [
      ...base(f),
      "--resource",
      "core=Incubator Stack v2",
    ]);
    expect(r.code).toBe(2);
    expect(r.output).toContain("read-side coordinate");
  });
});
