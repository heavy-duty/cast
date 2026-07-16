import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadBindings } from "../src/bindings.js";
import { GENERATED_PLACEHOLDER } from "../src/capture.js";
import { decryptSecrets } from "../src/secrets.js";

// `cast inventory --emit-draft` against a stub shaped like the box that made it
// necessary: a Coolify nobody declared, holding our stack under names someone
// typed, two third-party client sites, and a database cast cannot even model.
//
// The single most important assertion in this file is that POISON — the source
// box's real DATABASE_URL — appears in NO emitted artifact. A draft that carried
// it would rebuild a box that comes up WORKING, reading and writing the old
// box's database, and nobody would find out until the old box was deleted.

// The live values. If any of these reaches an emitted file, the test fails.
const POISON =
  "postgres://postgres:s3cr3t@incubator-database-v2.box-b.internal:5432/app";
const POISON_REDIS = "redis://:r3d1s@incubator-redis.box-b.internal:6379/0";
const POISON_SERVICE_PW = "umami-generated-9f3a1c";
// …and one that MUST survive: an ordinary secret is captured, not placeheld.
const MAILGUN = "key-1a2b3c-real-mailgun";

type Stub = { url: string; close: () => Promise<void> };
const stubs: Stub[] = [];

const ENVS: Record<string, Array<{ key: string; value: string }>> = {
  a1: [
    { key: "DATABASE_URL", value: POISON },
    { key: "REDIS_URL", value: POISON_REDIS },
    { key: "MAILGUN_KEY", value: MAILGUN },
    { key: "NODE_ENV", value: "production" },
    // Not a name a cast env template can hold. Reported, never dropped in silence.
    { key: "legacy.flag", value: "on" },
  ],
  s1: [
    { key: "SERVICE_PASSWORD_UMAMI", value: POISON_SERVICE_PW },
    { key: "SERVICE_FQDN_UMAMI", value: "https://umami.box-b.example.com" },
    { key: "UMAMI_APP_SECRET", value: "umami-app-secret-xyz" },
  ],
  a9: [{ key: "WP_HOME", value: "https://lafamilia.example.com" }],
};

// One project with resources in TWO environments — cast must refuse to pick.
async function stubCoolify(opts: { ambiguous?: boolean } = {}): Promise<Stub> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").replace("/api/v1", "");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/teams/current") return json({ id: 0, name: "Root Team" });
    // GET /github-apps returns each App's `id` and `name` (cast#72). The
    // incubator app below carries `source_id: 7`, so the binding RESOLVES to
    // this App by the read; the third-party public repo has no GithubApp source
    // and gets a REVIEW marker instead of being wrongly bound to it.
    if (path === "/github-apps")
      return json([{ id: 7, uuid: "g1", name: "hdb-coolify" }]);
    if (path === "/projects")
      return json([
        { uuid: "p1", name: "Incubator" },
        { uuid: "p2", name: "La Familia Site" },
        { uuid: "p3", name: "Martin Reyes Barber Shop" },
      ]);
    if (path === "/projects/p1/environments")
      return json([{ name: "production" }, { name: "staging" }]);
    if (path === "/projects/p2/environments")
      return json([{ name: "production" }]);
    if (path === "/projects/p3/environments")
      return json([{ name: "production" }]);

    // Coolify auto-creates `production`. It is empty (unless the ambiguous
    // variant puts a resource in it too). Everything real lives in `staging`.
    if (path === "/projects/p1/production")
      return json(
        opts.ambiguous
          ? { applications: [{ name: "old-core", uuid: "a7", fqdn: "" }] }
          : {},
      );
    if (path === "/projects/p1/staging")
      return json({
        applications: [
          {
            name: "Incubator Stack v2",
            uuid: "a1",
            git_repository: "heavy-duty/incubator",
            git_branch: "main",
            // Cloned by the GitHub App id 7 (hdb-coolify) — source_id/source_type
            // survive serialization, so the binding is resolvable (cast#72).
            source_id: 7,
            source_type: "App\\Models\\GithubApp",
            build_pack: "dockercompose",
            base_directory: "/",
            docker_compose_location: "/docker-compose.yaml",
            docker_compose_domains: JSON.stringify([
              { name: "core", domain: "https://app.example.com" },
            ]),
            destination_id: 3,
            // Basic Auth lives here, and cast's manifest has no field for it.
            custom_labels:
              "traefik.http.middlewares.auth.basicauth.users=admin:$2y$05$x",
          },
        ],
        postgresqls: [
          {
            name: "Incubator Database v2",
            uuid: "d1",
            database_type: "standalone-postgresql",
            image: "postgres:16-alpine",
            destination_id: 3,
          },
        ],
        services: [
          {
            name: "Incubator Umami",
            uuid: "s1",
            service_type: "umami",
            destination_id: 3,
          },
        ],
        // A database cast's manifest cannot express at all.
        mysqls: [{ name: "legacy-analytics", uuid: "m1" }],
      });
    if (path === "/projects/p2/production")
      return json({
        applications: [
          {
            name: "lafamilia-web",
            uuid: "a9",
            git_repository: "https://github.com/third-party/la-familia.git",
            git_branch: "main",
            build_pack: "static",
            base_directory: "/",
            publish_directory: "/dist",
            fqdn: "https://lafamilia.example.com",
            destination_id: 4,
          },
        ],
      });
    // A project with no application at all: nothing on the box knows its repo.
    if (path === "/projects/p3/production")
      return json({
        services: [
          { name: "barber-site", uuid: "s9", service_type: "wordpress" },
        ],
      });

    const envs = path.match(/^\/[a-z]+\/([a-z0-9]+)\/envs$/);
    if (envs) return json(ENVS[envs[1]] ?? []);
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

let KEY_FILE = "";
let RECIPIENT = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "cast-age-"));
  KEY_FILE = join(dir, "key.txt");
  execFileSync("age-keygen", ["-o", KEY_FILE], { stdio: "ignore" });
  RECIPIENT = execFileSync("age-keygen", ["-y", KEY_FILE], {
    encoding: "utf8",
  }).trim();
});

function fixture(url: string, opts: { recipient?: string } = {}) {
  const state = mkdtempSync(join(tmpdir(), "cast-state-"));
  writeFileSync(
    join(state, ".coolify.env"),
    `COOLIFY_BASE_URL="${url}"\nCOOLIFY_ACCESS_TOKEN="t"\n`,
  );
  writeFileSync(
    join(state, "environments.yaml"),
    [
      "environments:",
      "  prod:",
      "    server: box-b",
      "    team: { id: 0, name: Root Team }",
      ...(opts.recipient ? [`    age_recipient: ${opts.recipient}`] : []),
      "github_apps:",
      "  heavy-duty/incubator: hdb-coolify",
      "",
    ].join("\n"),
  );
  const out = join(mkdtempSync(join(tmpdir(), "cast-out-")), "draft");
  return { state, out };
}

function run(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["dist/cli.js", "inventory", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => {
      output += String(d);
    });
    child.stderr.on("data", (d) => {
      output += String(d);
    });
    child.stdin.end();
    child.on("close", (code) => resolve({ code: code ?? 0, output }));
  });
}

// Every file in the emitted tree, path -> bytes as text.
function tree(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, tree(path, rel));
    else out[rel] = readFileSync(path, "utf8");
  }
  return out;
}

describe("cast inventory --emit-draft (#27)", () => {
  it("emits the tree: bindings + registry, a manifest per project, templates, stores, UNCAPTURED", async () => {
    const f = fixture((await stubCoolify()).url);
    const r = await run([
      "--env",
      "prod",
      "--state",
      f.state,
      "--emit-draft",
      f.out,
      "--recipient",
      RECIPIENT,
    ]);
    expect(r.code).toBe(0);
    expect(Object.keys(tree(f.out)).sort()).toEqual([
      "UNCAPTURED.md",
      "environments.yaml",
      // One per project — INCLUDING the two third-party client sites nobody ever
      // declared. They each sit alone in a Coolify-default `production`, and a
      // draft that filtered the instance by one environment name would drop
      // exactly them: the projects the verb exists to bootstrap.
      "incubator/.infra/env/incubator-stack-v2.prod.env.template",
      "incubator/.infra/env/incubator-umami.prod.env.template",
      "incubator/.infra/manifest.yaml",
      "la-familia/.infra/env/lafamilia-web.prod.env.template",
      "la-familia/.infra/manifest.yaml",
      "martin-reyes-barber-shop/.infra/manifest.yaml",
      "secrets/incubator.prod.env.age",
      "secrets/la-familia.prod.env.age",
    ]);
    // Every emitted file says what it is, in its own body.
    for (const [path, body] of Object.entries(tree(f.out))) {
      if (path.endsWith(".age")) continue;
      expect(body, path).toContain("PROPOSAL");
      expect(body, path).toContain("apply` does not read");
    }
  });

  it("NEVER copies a provider-generated value — not into any artifact", async () => {
    const f = fixture((await stubCoolify()).url);
    const r = await run([
      "--env",
      "prod",
      "--state",
      f.state,
      "--emit-draft",
      f.out,
      "--recipient",
      RECIPIENT,
    ]);
    expect(r.code).toBe(0);

    // 1. Not in any emitted FILE.
    for (const [path, body] of Object.entries(tree(f.out))) {
      expect(body, path).not.toContain(POISON);
      expect(body, path).not.toContain(POISON_REDIS);
      expect(body, path).not.toContain(POISON_SERVICE_PW);
    }
    // 2. Not in the age store either, once decrypted — the store is the one place
    //    a copied value would actually be, and the one place you cannot grep.
    const store = decryptSecrets(
      join(f.out, "secrets", "incubator.prod.env.age"),
      KEY_FILE,
    );
    expect(store.DATABASE_URL).toBe(GENERATED_PLACEHOLDER);
    expect(store.REDIS_URL).toBe(GENERATED_PLACEHOLDER);
    expect(store.SERVICE_PASSWORD_UMAMI).toBe(GENERATED_PLACEHOLDER);
    expect(store.SERVICE_FQDN_UMAMI).toBe(GENERATED_PLACEHOLDER);
    expect(Object.values(store)).not.toContain(POISON);
    // 3. Not on stdout.
    expect(r.output).not.toContain(POISON);

    // …and an ORDINARY secret IS carried. The discipline is placeholding the
    // provider's names, not refusing to capture anything.
    expect(store.MAILGUN_KEY).toBe(MAILGUN);
    expect(store.UMAMI_APP_SECRET).toBe("umami-app-secret-xyz");

    // The manifest declares the placeheld names, so a later `capture` placeholds
    // them again with no flag to remember.
    const manifest = readFileSync(
      join(f.out, "incubator", ".infra", "manifest.yaml"),
      "utf8",
    );
    expect(manifest).toContain("generated_secrets:");
    expect(manifest).toContain("- DATABASE_URL");
    expect(manifest).toContain("- REDIS_URL");
    // The plan says so out loud, in names and provenance — never values.
    expect(r.output).toContain("generated");
    expect(r.output).toContain(GENERATED_PLACEHOLDER);
    expect(r.output).toContain("captured");
  });

  it("UNCAPTURED.md lists every known-inexpressible setting it SAW", async () => {
    const f = fixture((await stubCoolify()).url);
    const r = await run([
      "--env",
      "prod",
      "--state",
      f.state,
      "--emit-draft",
      f.out,
      "--recipient",
      RECIPIENT,
    ]);
    expect(r.code).toBe(0);
    const md = readFileSync(join(f.out, "UNCAPTURED.md"), "utf8");

    // Seen on the box, and inexpressible:
    expect(md).toContain("Incubator Umami"); // service hostnames (#21 / 4.1.2)
    expect(md).toContain("domains (hostnames)");
    expect(md).toContain("destination"); // which Docker network (#21)
    expect(md).toContain("destination_id 3");
    expect(md).toContain("legacy-analytics"); // a MySQL cast cannot model
    expect(md).toContain("custom_labels"); // Basic Auth / Traefik labels
    expect(md).toContain("backup"); // not exposed by the API
    expect(md).toContain("legacy.flag"); // not a name a template can hold

    // And the standing sections, emitted on every run whatever was found:
    expect(md).toContain("no API coverage in Coolify 4.1.2");
    expect(md).toContain("Include Source Commit in Build");
    expect(md).toContain("What a rebuild from this draft still cannot restore");
    expect(md).toContain("the GitHub App private key");
    expect(md).toContain("S3 access keys");

    // The run points at it rather than leaving it to be found.
    expect(r.output).toContain("UNCAPTURED.md");
  });

  it("writes the projects: registry — the list of what exists", async () => {
    const f = fixture((await stubCoolify()).url);
    await run([
      "--env",
      "prod",
      "--state",
      f.state,
      "--emit-draft",
      f.out,
      "--recipient",
      RECIPIENT,
    ]);
    const yaml = readFileSync(join(f.out, "environments.yaml"), "utf8");
    expect(yaml).toContain("projects:");
    // Read off the application's git remote — the only place a box knows its repo.
    expect(yaml).toContain("third-party/la-familia:");
    expect(yaml).toContain("environments:\n      - prod");
    // The bindings the sweep could actually read.
    expect(yaml).toContain("server: box-b");
    expect(yaml).toContain("name: Root Team");
    // Which GitHub App clones a repo is READ from the application's source_id,
    // not guessed (cast#72): the incubator app's source_id: 7 resolves to
    // hdb-coolify, while the third-party PUBLIC repo (no GithubApp source) gets a
    // REVIEW marker rather than being wrongly bound to the only App there is.
    expect(yaml).toContain("github_apps:");
    expect(yaml).toContain("heavy-duty/incubator: hdb-coolify");
    expect(yaml).toMatch(
      /third-party\/la-familia: REVIEW-which-github-app-in-coolify-clones-this-repo/,
    );

    // The barber shop has no application, so the box knows no repo for it. cast
    // writes the bare project name — and the registry's own parse-time refusal
    // (#25: "a registry key has no meaning without its org") then stops the file
    // being used until a human supplies the org. That refusal IS the design: the
    // alternatives are inventing an org, or dropping a project from the list —
    // and a project missing from the registry is one every fleet run skips in
    // silence.
    expect(yaml).toContain("martin-reyes-barber-shop:");
    const path = join(f.out, "environments.yaml");
    expect(() => loadBindings(path)).toThrow(/has no meaning without its org/);
  });

  it("refuses --emit-draft together with a repo — that is the reconcile path", async () => {
    const f = fixture((await stubCoolify()).url);
    const r = await run([
      "heavy-duty/incubator",
      "--env",
      "prod",
      "--state",
      f.state,
      "--emit-draft",
      f.out,
    ]);
    expect(r.code).toBe(2);
    expect(r.output).toContain("SWEEP-mode flag");
    expect(r.output).toContain("Adoption is one-way");
    expect(existsSync(f.out)).toBe(false);
  });

  it("refuses a target directory that already holds a repo", async () => {
    const f = fixture((await stubCoolify()).url);
    mkdirSync(join(f.out, ".infra"), { recursive: true });
    writeFileSync(
      join(f.out, ".infra", "manifest.yaml"),
      "project: incubator\nenvironments: {}\n",
    );
    const r = await run([
      "--env",
      "prod",
      "--state",
      f.state,
      "--emit-draft",
      f.out,
      "--recipient",
      RECIPIENT,
    ]);
    expect(r.code).toBe(2);
    expect(r.output).toContain("is not empty");
    // For a declared project the manifest is the truth — a draft must not be able
    // to overwrite a reviewed spec with a live box's accumulated cruft.
    expect(r.output).toContain("Adoption is one-way");
    expect(readFileSync(join(f.out, ".infra", "manifest.yaml"), "utf8")).toBe(
      "project: incubator\nenvironments: {}\n",
    );
  });

  it("refuses to emit secrets nobody can decrypt — and takes an explicit opt-out", async () => {
    const f = fixture((await stubCoolify()).url);
    const refused = await run([
      "--env",
      "prod",
      "--state",
      f.state,
      "--emit-draft",
      f.out,
    ]);
    // No --recipient, no age_recipient binding. Silently skipping the store would
    // emit a draft that LOOKS complete and holds not one value.
    expect(refused.code).toBe(2);
    expect(refused.output).toContain("no age recipient");
    expect(refused.output).toContain("--no-secrets");
    expect(existsSync(f.out)).toBe(false);

    const optOut = await run([
      "--env",
      "prod",
      "--state",
      f.state,
      "--emit-draft",
      f.out,
      "--no-secrets",
    ]);
    expect(optOut.code).toBe(0);
    expect(existsSync(join(f.out, "secrets"))).toBe(false);
    expect(
      existsSync(join(f.out, "incubator", ".infra", "manifest.yaml")),
    ).toBe(true);
    expect(optOut.output).toContain("NOT WRITTEN");
  });

  it("takes the recipient from the environment's binding when no flag is given", async () => {
    const f = fixture((await stubCoolify()).url, { recipient: RECIPIENT });
    const r = await run([
      "--env",
      "prod",
      "--state",
      f.state,
      "--emit-draft",
      f.out,
    ]);
    expect(r.code).toBe(0);
    const store = decryptSecrets(
      join(f.out, "secrets", "incubator.prod.env.age"),
      KEY_FILE,
    );
    expect(store.MAILGUN_KEY).toBe(MAILGUN);
  });

  it("refuses to pick between two environments that both have resources", async () => {
    const f = fixture((await stubCoolify({ ambiguous: true })).url);
    const r = await run([
      "--env",
      "prod",
      "--state",
      f.state,
      "--emit-draft",
      f.out,
      "--recipient",
      RECIPIENT,
    ]);
    // Picking would emit a blueprint of half a box that says nothing about the
    // other half — and this box is where that already happened once (#22).
    expect(r.code).toBe(2);
    expect(r.output).toContain("MORE THAN ONE environment");
    expect(r.output).toContain("Incubator");
    expect(r.output).toContain("--environment");
    expect(existsSync(f.out)).toBe(false);

    // …and --environment breaks the tie. For the projects that HAVE no tie (the
    // client sites, each alone in its own `production`), it changes nothing: they
    // are drafted either way.
    const tied = await run([
      "--env",
      "prod",
      "--state",
      f.state,
      "--emit-draft",
      f.out,
      "--recipient",
      RECIPIENT,
      "--environment",
      "staging",
    ]);
    expect(tied.code).toBe(0);
    const files = Object.keys(tree(f.out));
    expect(files).toContain("incubator/.infra/manifest.yaml");
    expect(files).toContain("la-familia/.infra/manifest.yaml");
    // The environment it did NOT draft is named, not dropped in silence.
    expect(readFileSync(join(f.out, "UNCAPTURED.md"), "utf8")).toContain(
      "other environments",
    );
  });

  it("still sweeps, and still asserts the team, before it writes anything", async () => {
    const f = fixture((await stubCoolify()).url);
    writeFileSync(
      join(f.state, "environments.yaml"),
      [
        "environments:",
        "  prod:",
        "    server: box-b",
        "    team: { id: 9, name: Some Other Team }",
        "",
      ].join("\n"),
    );
    const r = await run([
      "--env",
      "prod",
      "--state",
      f.state,
      "--emit-draft",
      f.out,
      "--recipient",
      RECIPIENT,
    ]);
    // A wrong-team token reads back an empty instance — and would draft a
    // blueprint of nothing at all, confidently.
    expect(r.code).not.toBe(0);
    expect(existsSync(f.out)).toBe(false);
  });
});
