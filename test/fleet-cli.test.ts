import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { tmp } from "./helpers/tmp.js";

// `cast diff --all` / `cast apply --all` (#26), end to end against a stub
// Coolify carrying three projects.
//
// The failure this whole feature is about is a report that reads the same
// whether cast looked at everything or at nothing — so every test below is
// really an assertion about COVERAGE: what the run says it read, versus what the
// registry says exists. A skipped project reads exactly like a clean one, and
// the exit code is where that lie would land.
//
// --all forbids --path (it is ONE project's checkout), so these runs take the
// real clone path. `insteadOf` points github.com at local git repos: the clone
// is genuine, the network is not.

const REPOS = ["alpha", "beta", "gamma"] as const;
const SLUGS = REPOS.map((r) => `heavy-duty/${r}`);

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

// What the box does when cast asks about a project:
//   clean  — exactly what the manifest declares
//   drift  — the same app on the wrong branch
//   absent — no such project on this Coolify (LiveLookup.found === false)
//   error  — the environment read 500s (any HTTP error at all)
type Behavior = "clean" | "drift" | "absent" | "error";

type Stub = { url: string; hits: string[]; close: () => Promise<void> };
const stubs: Stub[] = [];

async function stubCoolify(
  behavior: Partial<Record<string, Behavior>> = {},
): Promise<Stub> {
  const of = (repo: string): Behavior => behavior[repo] ?? "clean";
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "").replace("/api/v1", "");
    hits.push(path);
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/teams/current") return json({ id: 0, name: "Root Team" });
    if (path === "/servers") return json([{ uuid: "s1", name: "fleet-box" }]);
    if (path === "/github-apps")
      return json([{ uuid: "g1", name: "hdb-coolify" }]);
    if (path === "/projects") {
      return json(
        REPOS.filter((r) => of(r) !== "absent").map((r) => ({
          uuid: `p-${r}`,
          name: r,
        })),
      );
    }
    for (const repo of REPOS) {
      if (path === `/projects/p-${repo}/staging`) {
        if (of(repo) === "error") {
          res.writeHead(500);
          return res.end("boom");
        }
        return json({
          applications: [
            {
              name: "core",
              uuid: `a-${repo}`,
              git_repository: `heavy-duty/${repo}`,
              git_branch:
                of(repo) === "drift" ? "someones-feature-branch" : "main",
              build_pack: "nixpacks",
              base_directory: "/",
              fqdn: `http://${repo}.example.com`,
              destination_id: 1,
            },
          ],
        });
      }
      if (path === `/applications/a-${repo}/envs`) return json([]);
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((r) => {
    server.listen(0, "127.0.0.1", r);
  });
  const stub: Stub = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
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

const manifest = (repo: string, withRef = false) => `project: ${repo}
environments:
  staging:
    applications:
      core:
        source: { repo: heavy-duty/${repo}, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: ["http://${repo}.example.com"]
${withRef ? "        env_template: core.env\n" : ""}`;

// A state dir + three clonable product repos. `registry` is the knob: which
// slugs the `projects:` block registers for staging — undefined writes no
// `projects:` block at all (a state file from before the registry existed).
// `refIn` gives ONE repo a template with a ${…} ref: since #104 gated the
// missing-store refusal on the manifest actually referencing a secret, a
// fixture that wants to exercise that refusal has to reference one.
function fixture(
  url: string,
  opts: { registry?: string[]; registryEnv?: string; refIn?: string } = {},
) {
  const root = tmp("cast-fleet-");
  for (const repo of REPOS) {
    const dir = join(root, "repos", "heavy-duty", `${repo}.git`);
    mkdirSync(join(dir, ".infra"), { recursive: true });
    writeFileSync(
      join(dir, ".infra", "manifest.yaml"),
      manifest(repo, repo === opts.refIn),
    );
    if (repo === opts.refIn) {
      mkdirSync(join(dir, ".infra", "env"));
      writeFileSync(
        join(dir, ".infra", "env", "core.env"),
        "API_KEY=${API_KEY}\n",
      );
    }
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    git("add", "-A");
    git(
      "-c",
      "user.email=cast@example.com",
      "-c",
      "user.name=cast",
      "commit",
      "-qm",
      "manifest",
    );
  }
  const state = join(root, "state");
  mkdirSync(join(state, "secrets"), { recursive: true });
  writeFileSync(
    join(state, ".coolify.env"),
    `COOLIFY_BASE_URL="${url}"\nCOOLIFY_ACCESS_TOKEN="t"\n`,
  );
  for (const repo of REPOS) {
    // No template refs a secret, so since #104 none of these stores is strictly
    // required — but the pre-greenfield shape (store on disk, key injected) is
    // the shape most fleets are in, and it has to keep working unchanged. The
    // missing-store-with-a-ref refusal is exercised below by deleting one.
    execFileSync("age", ["-r", recipient, "-o", `${repo}.staging.env.age`], {
      input: "\n",
      cwd: join(state, "secrets"),
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  const registry = opts.registry ?? SLUGS;
  writeFileSync(
    join(state, "environments.yaml"),
    [
      "environments:",
      "  staging:",
      "    server: fleet-box",
      "    team: { id: 0, name: Root Team }",
      // A second environment, so "registered, but not HERE" is a state this
      // fixture can express — it is the difference between a fleet nobody has
      // registered and a fleet registered somewhere else.
      "  prod:",
      "    server: prod-box",
      "    team: { id: 0, name: Root Team }",
      "github_apps:",
      ...SLUGS.map((s) => `  ${s}: hdb-coolify`),
      ...(registry.length > 0
        ? [
            "projects:",
            ...registry.flatMap((slug) => [
              `  ${slug}:`,
              `    environments: [${opts.registryEnv ?? "staging"}]`,
            ]),
          ]
        : []),
      "",
    ].join("\n"),
  );
  return { root, state };
}

function run(
  verb: "apply" | "diff",
  args: string[],
  f?: { root: string },
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["dist/cli.js", verb, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CAST_AGE_KEY_FILE_STAGING: keyFile,
        // The clone is real; only its origin is local. cast builds the URL as
        // https://github.com/<org>/<repo>.git and git rewrites it here.
        ...(f
          ? {
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: `url.${join(f.root, "repos")}/.insteadOf`,
              GIT_CONFIG_VALUE_0: "https://github.com/",
            }
          : {}),
      },
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

const fleet = (f: { state: string }) => [
  "--env",
  "staging",
  "--state",
  f.state,
  "--all",
];

describe("cast diff --all (#26)", () => {
  it("iterates the registry, reports each project, and exits 0 on a clean fleet", async () => {
    const f = fixture((await stubCoolify()).url);
    const r = await run("diff", fleet(f), f);
    expect(r.code).toBe(0);
    for (const slug of SLUGS) expect(r.output).toContain(slug);
    expect(r.output).toContain("[1/3] heavy-duty/alpha");
    expect(r.output).toContain("[3/3] heavy-duty/gamma");
    // Coverage, said out loud. "clean" alone would be exactly the sentence a
    // fleet run over nothing at all prints.
    expect(r.output).toContain("registered:   3");
    expect(r.output).toContain("read:         3 of 3");
    expect(r.output).toContain(
      "all 3 registered project(s) were read, and every one is clean.",
    );
  });

  it("exits 1 on drift, naming the drifted project and still reporting the rest", async () => {
    const f = fixture((await stubCoolify({ beta: "drift" })).url);
    const r = await run("diff", fleet(f), f);
    expect(r.code).toBe(1);
    expect(r.output).toContain("someones-feature-branch");
    expect(r.output).toContain("read:         3 of 3");
    expect(r.output).toContain("drift:        1  heavy-duty/beta");
    expect(r.output).toContain("clean:        2");
  });

  // The issue, in one test: a project cast could not reach is an ERROR, not a
  // skip — and it does not stop the read either, because stopping would hide
  // the drift in the projects never reached.
  it("fails the fleet on an unreachable project, and still reads the ones after it", async () => {
    const f = fixture(
      (await stubCoolify({ beta: "absent", gamma: "drift" })).url,
    );
    const r = await run("diff", fleet(f), f);
    // 2, not 1: an unreadable project is not a diff result, so it outranks the
    // drift that WAS found.
    expect(r.code).toBe(2);
    expect(r.output).toContain("[3/3] heavy-duty/gamma");
    expect(r.output).toContain("someones-feature-branch");
    expect(r.output).toContain("read:         2 of 3");
    expect(r.output).toContain("UNREACHABLE:  1  heavy-duty/beta");
    expect(r.output).toContain("FAILURE, not a diff result");
    expect(r.output).not.toContain("every one is clean");
  });

  it("treats an HTTP error as unreachable, never as an empty project", async () => {
    const f = fixture((await stubCoolify({ beta: "error" })).url);
    const r = await run("diff", fleet(f), f);
    expect(r.code).toBe(2);
    expect(r.output).toContain("UNREACHABLE:  1  heavy-duty/beta");
    expect(r.output).toContain("500");
  });

  // `refIn` matters: since #104 the refusal is gated on the manifest actually
  // referencing a secret, so the missing store is only an error because beta's
  // template holds a ${…} ref. The gate's other half is the test after this one.
  it("treats a missing secret store as unreachable when a template refs a secret, naming the file", async () => {
    const f = fixture((await stubCoolify()).url, { refIn: "beta" });
    execFileSync("rm", [join(f.state, "secrets", "beta.staging.env.age")]);
    const r = await run("diff", fleet(f), f);
    expect(r.code).toBe(2);
    expect(r.output).toContain(
      "no secret store for heavy-duty/beta in staging",
    );
    expect(r.output).toContain("UNREACHABLE:  1  heavy-duty/beta");
  });

  // The greenfield gate (#104) under --all: a zero-refs project whose store was
  // never written is READ, not failed — the note prints, the fleet stays whole.
  it("reads a zero-refs project with no store, noting the absence instead of failing it", async () => {
    const f = fixture((await stubCoolify()).url);
    execFileSync("rm", [join(f.state, "secrets", "beta.staging.env.age")]);
    const r = await run("diff", fleet(f), f);
    expect(r.code).toBe(0);
    expect(r.output).toContain(
      "NOTE: no secret store for heavy-duty/beta in staging",
    );
    expect(r.output).toContain("read:         3 of 3");
    expect(r.output).toContain(
      "all 3 registered project(s) were read, and every one is clean.",
    );
  });
});

describe("cast diff --all — an empty fleet is not a clean fleet", () => {
  it("refuses a state file with no registry at all", async () => {
    const f = fixture((await stubCoolify()).url, { registry: [] });
    const r = await run("diff", fleet(f), f);
    expect(r.code).toBe(2);
    expect(r.output).toContain(
      'refusing to diff --all: no projects are registered for "staging"',
    );
    expect(r.output).toContain("no `projects:` block at all");
    expect(r.output).toContain("environments: [staging]");
    // The thing it must NOT have done — the ONLY reason this refusal exists.
    // (The refusal quotes the phrase "0 projects, clean" to name the lie, so
    // the assertion is on the verdict line a real run would have printed.)
    expect(r.output).not.toContain("read:");
    expect(r.output).not.toContain("were read, and every one is clean");
  });

  // The registry is not empty — it just has nothing to say about THIS
  // environment. Same refusal, because it is the same silence: there is nothing
  // to iterate, and a run over nothing must never print what a clean run prints.
  it("refuses a registry that registers every project somewhere else", async () => {
    const f = fixture((await stubCoolify()).url, { registryEnv: "prod" });
    const r = await run("diff", fleet(f), f);
    expect(r.code).toBe(2);
    expect(r.output).toContain(
      "a registry, but nothing registered for this environment",
    );
    expect(r.output).toContain("heavy-duty/alpha (prod)");
  });
});

describe("cast diff/apply --all — mutually exclusive coordinates", () => {
  const cases: Array<[string, string[]]> = [
    ["<org>/<repo>", ["heavy-duty/alpha"]],
    ["--path", ["--path", "/tmp/somewhere"]],
    ["--project", ["--project", "Incubator"]],
    ["--environment", ["--environment", "production"]],
    ["--resource", ["--resource", "core=Stack v2"]],
    ["--hostname-overlay", ["--hostname-overlay", "/tmp/overlay.yaml"]],
  ];

  it.each(cases)("refuses --all with %s", async (flag, args) => {
    // No state dir and no Coolify: the refusal lands before cast opens either.
    const r = await run("diff", ["--env", "staging", "--all", ...args]);
    expect(r.code).toBe(2);
    expect(r.output).toContain(
      `refusing to diff: --all cannot be combined with ${flag}`,
    );
  });

  it("refuses on apply too, and says so as apply", async () => {
    const r = await run("apply", [
      "--env",
      "staging",
      "--all",
      "--project",
      "Incubator",
    ]);
    expect(r.code).toBe(2);
    expect(r.output).toContain(
      "refusing to apply: --all cannot be combined with --project",
    );
  });
});

// The prod ban is older than --all (a feature-branch checkout must not decide
// what prod runs), but --all is what moved it: hoisting loadBindings for the
// registry put it AFTER the point where resolveCheckout used to catch this, so
// the CLI now refuses up front and resolveCheckout still throws behind it. Two
// call sites, one rule — and the up-front one is a code path of its own, so it
// gets a test of its own rather than riding on resolve.test.ts's.
describe("--path with --env prod is refused before anything is opened", () => {
  it.each(["diff", "apply"] as const)(
    "refuses on %s with no state dir, no store and no Coolify",
    async (verb) => {
      const r = await run(verb, [
        "heavy-duty/alpha",
        "--env",
        "prod",
        "--path",
        "/tmp/somewhere",
      ]);
      expect(r.code).toBe(2);
      expect(r.output).toContain(
        "refuses --path with --env prod: prod always reads the default branch",
      );
    },
  );
});

describe("cast apply --all (#26)", () => {
  it("applies every registered project and says what it did", async () => {
    const f = fixture((await stubCoolify()).url);
    const r = await run("apply", fleet(f), f);
    expect(r.code).toBe(0);
    expect(r.output).toContain("applied:      3 of 3");
    expect(r.output).toContain("all 3 registered project(s) applied.");
    expect(r.output).toContain(
      "nothing changed — the fleet already matched its manifests.",
    );
  });

  // The one disposition `apply` does not share with `diff`: it STOPS. Half a
  // fleet mutated after an unexplained failure is not a fleet cast keeps writing
  // to — and the report has to say which half.
  it("stops at the first failure, and names what it did and did not touch", async () => {
    const stub = await stubCoolify({ beta: "error" });
    const f = fixture(stub.url);
    const r = await run("apply", fleet(f), f);
    expect(r.code).toBe(2);
    expect(r.output).toContain("STOPPED at the first failure");
    expect(r.output).toContain("applied:      1 of 3  heavy-duty/alpha");
    expect(r.output).toContain("FAILED:       heavy-duty/beta");
    expect(r.output).toContain("not reached:  1  heavy-duty/gamma");
    expect(r.output).toContain('"not reached" were NOT touched');
    // It did not merely SAY it stopped: gamma was never run…
    expect(r.output).not.toContain("[3/3] heavy-duty/gamma");
    // …and the box was never asked about it.
    expect(stub.hits).not.toContain("/projects/p-gamma/staging");
  });
});
