import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { tmp } from "./helpers/tmp.js";

// The greenfield manifest-first bootstrap (#104), end to end: fresh box,
// registered project, a manifest that declares databases only and refs no
// secret — the exact shape the 2026-07-19 release drill hit. There used to be
// no path to the first apply: `apply` refused on the absent store, `capture`
// rightly refused the absent project, and the drill unblocked with a hand-made
// empty store nothing documented.
//
// The rule under test: the "no secret store" refusal is gated on the manifest
// actually REFERENCING a secret. Zero ${…} refs → an absent store is treated
// as empty, a loud note names the path, and no age key is demanded (nothing to
// decrypt, nothing to protect yet). One ${…} ref → the refusal, byte-identical
// to what it always said. A present store keeps decrypting exactly as before.

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

type Stub = { url: string; close: () => Promise<void> };
const stubs: Stub[] = [];

// A fresh box: the project is registered on Coolify but its environment holds
// nothing — the state one API call after `cast project create`, and the state
// the drill's first apply ran against.
async function stubCoolify(): Promise<Stub> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").replace("/api/v1", "");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/teams/current") return json({ id: 0, name: "Root Team" });
    if (path === "/projects") return json([{ uuid: "p1", name: "fresh" }]);
    if (path === "/projects/p1/staging") return json({ applications: [] });
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

// The drill's manifest, minimized: databases only, zero ${…} refs anywhere.
const ZERO_REFS_MANIFEST = `project: fresh
environments:
  staging:
    applications: {}
    databases:
      fresh-db:
        type: postgresql
`;

// The same environment the moment one template gains a placeholder — the
// boundary at which the old refusal must return, word for word.
const ONE_REF_MANIFEST = `project: fresh
environments:
  staging:
    applications:
      core:
        source: { repo: heavy-duty/fresh, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: ["http://core.example.com"]
        env_template: core.env
    databases:
      fresh-db:
        type: postgresql
`;

function fixture(
  url: string,
  opts: { manifest: string; store?: boolean } = {
    manifest: ZERO_REFS_MANIFEST,
  },
) {
  const checkout = tmp("cast-co-");
  mkdirSync(join(checkout, ".infra", "env"), { recursive: true });
  writeFileSync(join(checkout, ".infra", "manifest.yaml"), opts.manifest);
  writeFileSync(
    join(checkout, ".infra", "env", "core.env"),
    "API_KEY=${API_KEY}\n",
  );

  const state = tmp("cast-state-");
  mkdirSync(join(state, "secrets"));
  writeFileSync(
    join(state, ".coolify.env"),
    `COOLIFY_BASE_URL="${url}"\nCOOLIFY_ACCESS_TOKEN="t"\n`,
  );
  if (opts.store) {
    execFileSync("age", ["-r", recipient, "-o", "fresh.staging.env.age"], {
      input: "\n",
      cwd: join(state, "secrets"),
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  writeFileSync(
    join(state, "environments.yaml"),
    [
      "environments:",
      "  staging:",
      "    server: fresh-box",
      "    team: { id: 0, name: Root Team }",
      "github_apps:",
      "  fresh: hdb-coolify",
      "",
    ].join("\n"),
  );
  return { checkout, state };
}

// `withKey: false` is the greenfield claim itself: the run is spawned with no
// CAST_AGE_KEY_FILE_STAGING and a HOME that holds no standing key, so if cast
// so much as ASKS for the age key, the run dies "no age key for staging" and
// the assertion on the output catches it.
function run(
  args: string[],
  opts: { withKey: boolean },
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const { CAST_AGE_KEY_FILE_STAGING: _dropped, ...inherited } = process.env;
    const env = opts.withKey
      ? { ...inherited, CAST_AGE_KEY_FILE_STAGING: keyFile }
      : { ...inherited, HOME: tmp("cast-home-") };
    const child = spawn("node", ["dist/cli.js", "diff", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
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
  "heavy-duty/fresh",
  "--env",
  "staging",
  "--path",
  f.checkout,
  "--state",
  f.state,
];

describe("greenfield: zero ${…} refs and no store (#104)", () => {
  it("proceeds to a full plan, says the store was absent and unneeded, and never asks for an age key", async () => {
    const f = fixture((await stubCoolify()).url, {
      manifest: ZERO_REFS_MANIFEST,
    });
    const r = await run(base(f), { withKey: false });
    // The plan, not a refusal: the database is there to create, so this is an
    // ordinary drift exit — which is the whole point, the first apply's plan.
    expect(r.code).toBe(1);
    expect(r.output).toContain("fresh-db");
    expect(r.output).toContain(
      "NOTE: no secret store for heavy-duty/fresh in staging",
    );
    expect(r.output).toContain(
      join(f.state, "secrets", "fresh.staging.env.age"),
    );
    expect(r.output).toContain("proceeds without a store or an age key");
    // The two ways the old behavior would have surfaced, both absent: the
    // refusal (whose body, unlike the note, tells you what the store is FOR),
    // and — with no key in the spawn env at all — the key demand.
    expect(r.output).not.toContain("resolved from that store");
    expect(r.output).not.toContain("no age key for staging");
  });

  it("keeps the original refusal, word for word, the moment a template holds a ${…} ref", async () => {
    const f = fixture((await stubCoolify()).url, {
      manifest: ONE_REF_MANIFEST,
    });
    const r = await run(base(f), { withKey: false });
    // Exit 1 is what a single-project refusal has always exited with: the
    // throw lands in main()'s rejection handler, same as before #104. The
    // fleet flavor of this refusal (exit 2, UNREACHABLE) is fleet-cli.test.ts.
    expect(r.code).toBe(1);
    expect(r.output).toContain(
      "no secret store for heavy-duty/fresh in staging",
    );
    expect(r.output).toContain(
      `looked for:  ${join(f.state, "secrets", "fresh.staging.env.age")}`,
    );
    expect(r.output).toContain(
      "The manifest's ${…} refs are resolved from that store",
    );
    expect(r.output).toContain("`cast capture` writes one from a live box.");
    // The refusal, not the plan and not the note.
    expect(r.output).not.toContain("NOTE:");
    expect(r.output).not.toContain("fresh-db");
  });

  it("still opens a store that DOES exist — zero refs or not, a written store is decrypted as before", async () => {
    const f = fixture((await stubCoolify()).url, {
      manifest: ZERO_REFS_MANIFEST,
      store: true,
    });
    // The pre-#104 shape: store on disk, key injected. Same plan as the
    // greenfield run, and no note — the store was there, so nothing to say.
    const r = await run(base(f), { withKey: true });
    expect(r.code).toBe(1);
    expect(r.output).toContain("fresh-db");
    expect(r.output).not.toContain("NOTE: no secret store");
  });
});
