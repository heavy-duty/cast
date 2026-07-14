import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classify } from "../src/capture.js";
import { computeDiff, renderDiff } from "../src/diff.js";
import { type DraftProject, planDraft } from "../src/draft.js";
import { isReservedEnvName } from "../src/reserved.js";
import {
  desiredFromManifest,
  manifestResources,
  requiredSecrets,
} from "../src/resolve.js";
import { SMOKE_KEEP_KEY, SMOKE_PROBE_KEY } from "../src/smoke.js";

// #50. Coolify injects SOURCE_COMMIT and the COOLIFY_* family itself, and SKIPS
// its own injection of a name the resource already carries a var of
// (ApplicationDeploymentJob.php, v4.1.2). So a var of that name SUPPRESSES the
// platform's value — and it fails GREEN: the deploy succeeds, the health check
// passes, and /version reports "unknown".
//
// The rule has to be true of CAST, not of one code path — every place cast
// touches an env var. This file tests all four of them together, because that
// joint property is the thing being claimed.

describe("the rule", () => {
  it("reserves the names Coolify injects itself", () => {
    for (const key of [
      "SOURCE_COMMIT",
      "COOLIFY_URL",
      "COOLIFY_FQDN",
      "COOLIFY_BRANCH",
      "COOLIFY_RESOURCE_UUID",
      "COOLIFY_CONTAINER_NAME",
      "COOLIFY_ANYTHING_AT_ALL",
    ]) {
      expect(isReservedEnvName(key), key).toBe(true);
    }
  });

  // The rule is exactly two shapes. A name that merely LOOKS adjacent is a
  // manifest's own business — over-reaching here refuses a manifest that was
  // right, which is the one way this rule can do harm.
  it("reserves nothing else", () => {
    for (const key of [
      "SOURCE_COMMIT_SHA",
      "MY_SOURCE_COMMIT",
      "COOLIFYISH",
      "SERVICE_FQDN_UMAMI",
      "DATABASE_URL",
      "NODE_ENV",
    ]) {
      expect(isReservedEnvName(key), key).toBe(false);
    }
  });
});

// --- resolve / apply: REFUSE ---------------------------------------------------

function checkout(template: string, envName = "staging"): string {
  const dir = mkdtempSync(join(tmpdir(), "infra-reserved-"));
  mkdirSync(join(dir, ".infra", "env"), { recursive: true });
  writeFileSync(
    join(dir, ".infra", "manifest.yaml"),
    `project: widget
environments:
  ${envName}:
    applications:
      core:
        source: { repo: acme/widget, branch: main }
        build: { pack: nixpacks, base_directory: / }
        port: 3000
        domains: []
        env_template: core.${envName}.env.template
`,
  );
  writeFileSync(
    join(dir, ".infra", "env", `core.${envName}.env.template`),
    template,
  );
  return dir;
}

describe("resolve / apply — a manifest that declares a reserved name is refused", () => {
  it("refuses before anything is written, naming the var and the consequence", () => {
    const dir = checkout("PORT=3000\nSOURCE_COMMIT=${SOURCE_COMMIT}\n");
    expect(() =>
      desiredFromManifest(dir, "staging", { SOURCE_COMMIT: "abc123" }),
    ).toThrow(/SOURCE_COMMIT/);
    try {
      desiredFromManifest(dir, "staging", { SOURCE_COMMIT: "abc123" });
    } catch (e) {
      const msg = String(e);
      expect(msg).toMatch(/refusing/);
      expect(msg).toMatch(/core/); // which resource
      expect(msg).toMatch(/SUPPRESSES/); // what it does
      expect(msg).toMatch(/GREEN/); // and how it fails
      expect(msg).toMatch(/version/);
    }
  });

  // The whole trap, in one test. An EMPTY SOURCE_COMMIT is not a var that does
  // nothing — it is the var that suppresses the injection most invisibly, and it
  // is the one the real box actually carried. Presence, not value: the same rule
  // forbidden_var_patterns already holds to.
  it("refuses an EMPTY literal — presence, not value", () => {
    const dir = checkout("PORT=3000\nSOURCE_COMMIT=\n");
    expect(() => desiredFromManifest(dir, "staging", {})).toThrow(
      /SOURCE_COMMIT/,
    );
  });

  it("refuses the COOLIFY_* family too", () => {
    const dir = checkout("COOLIFY_URL=https://app.example.com\n");
    expect(() => desiredFromManifest(dir, "staging", {})).toThrow(
      /COOLIFY_URL/,
    );
  });

  // Not just apply: every verb that reads the manifest. Refusing in one and
  // reporting in another would let `capture` write a store for a manifest
  // `apply` is guaranteed to refuse — a green run that promises a red one.
  it("refuses on the capture path (requiredSecrets) and the inventory path (manifestResources)", () => {
    const dir = checkout("SOURCE_COMMIT=${SOURCE_COMMIT}\n");
    expect(() => requiredSecrets(dir, "staging")).toThrow(/SOURCE_COMMIT/);
    expect(() => manifestResources(dir, "staging")).toThrow(/SOURCE_COMMIT/);
  });

  it("leaves an ordinary manifest alone", () => {
    const dir = checkout("PORT=3000\nMG=${MG}\n");
    const { desired } = desiredFromManifest(dir, "staging", { MG: "v" });
    expect(desired).toHaveLength(1);
  });
});

// --- capture: NEVER STORE ONE --------------------------------------------------

describe("capture — classify refuses a reserved name at the file", () => {
  // Unreachable through the CLI (requiredSecrets refuses first) and asserted
  // anyway: the invariant is "cast never carries one", not "the CLI happens to
  // check first". A captured SOURCE_COMMIT would sit in the age store — the one
  // artifact a reviewer cannot read.
  it("refuses rather than reading the live value into the store", () => {
    expect(() =>
      classify(
        [{ ref: "SOURCE_COMMIT", resource: "core", key: "SOURCE_COMMIT" }],
        [],
        { core: { SOURCE_COMMIT: "" } },
        {},
      ),
    ).toThrow(/SOURCE_COMMIT/);
  });
});

// --- draft: NEVER COPY ONE -----------------------------------------------------

const draftCtx = {
  env: "prod",
  instance: "box-b",
  baseUrl: "https://coolify.example.com",
  team: { id: 0, name: "Root Team" },
  server: "box-b",
  recipient: "age1example",
  generatedAt: "2026-07-13T00:00:00.000Z",
};

// The live box that set this whole thing off: a working app carrying an orphan,
// EMPTY SOURCE_COMMIT. Before #50, isProviderGenerated was the only filter on
// what a live var becomes in a drafted manifest — and SOURCE_COMMIT splits to
// [SOURCE, COMMIT]: no SERVICE_ prefix, no datastore word, no connection word.
// So it was captured verbatim, and drafting a working box reproduced the trap in
// the new box's manifest.
const suppressingBox = (): DraftProject => ({
  name: "Incubator",
  coolifyEnv: "staging",
  resources: [
    {
      kind: "application",
      name: "core",
      uuid: "a1",
      raw: {
        git_repository: "https://github.com/heavy-duty/incubator",
        git_branch: "main",
        build_pack: "nixpacks",
        base_directory: "/",
        ports_exposes: "3000",
        fqdn: "https://app.example.com",
      },
      env: {
        SOURCE_COMMIT: "",
        COOLIFY_BRANCH: "main",
        MAILGUN_KEY: "key-abc123",
      },
    },
  ],
  unreadable: [],
  otherEnvironments: [],
});

describe("draft — a reserved name is suppressed, not copied", () => {
  const plan = planDraft([suppressingBox()], draftCtx);
  const template = plan.files.find((f) => f.path.endsWith(".env.template"));

  it("keeps it out of the emitted env template", () => {
    expect(template?.content).toContain("MAILGUN_KEY=");
    expect(template?.content).not.toContain("SOURCE_COMMIT");
    expect(template?.content).not.toContain("COOLIFY_BRANCH");
  });

  it("keeps it out of the age store", () => {
    const store = plan.stores[0];
    expect(Object.keys(store.vars)).toEqual(["MAILGUN_KEY"]);
  });

  it("dispositions it as `suppressed` rather than dropping it in silence", () => {
    const d = plan.dispositions.find((x) => x.ref === "SOURCE_COMMIT");
    expect(d?.provenance).toBe("suppressed");
    expect(d?.sites).toEqual(["core.SOURCE_COMMIT"]);
    expect(
      plan.dispositions.find((x) => x.ref === "COOLIFY_BRANCH")?.provenance,
    ).toBe("suppressed");
    expect(
      plan.dispositions.find((x) => x.ref === "MAILGUN_KEY")?.provenance,
    ).toBe("captured");
  });

  // UNCAPTURED.md exists precisely so that what cast declines to carry is stated
  // out loud rather than dropped — and this entry has to say two things: it is
  // not in your draft, AND it is a live bug on the box you drafted from.
  it("names it in UNCAPTURED.md, with the consequence", () => {
    const uncaptured = plan.uncaptured.find(
      (u) => u.setting === "env var SOURCE_COMMIT",
    );
    expect(uncaptured).toBeDefined();
    expect(uncaptured?.detail).toMatch(/SUPPRESSES/);
    expect(uncaptured?.detail).toMatch(/NOT in this draft/);
    const md = plan.files.find((f) => f.path === "UNCAPTURED.md");
    expect(md?.content).toContain("SOURCE_COMMIT");
  });

  // A resource whose only vars were reserved has no template to point at, and
  // must not gain an env_template line for a file that does not exist.
  it("emits no env template at all when every var was reserved", () => {
    const box = suppressingBox();
    box.resources[0].env = { SOURCE_COMMIT: "" };
    const p = planDraft([box], draftCtx);
    expect(p.files.some((f) => f.path.endsWith(".env.template"))).toBe(false);
    expect(p.stores).toHaveLength(0);
    const manifest = p.files.find((f) => f.path.endsWith("manifest.yaml"));
    expect(manifest?.content).not.toContain("env_template");
  });
});

// --- diff: A FINDING, NOT AN ORPHAN VAR ----------------------------------------

const desiredApp = {
  kind: "application" as const,
  name: "core",
  fields: { build_pack: "nixpacks" },
  env: { vars: { PORT: { value: "3000", secret: false } } },
};
const liveApp = (env: Record<string, string>) => ({
  kind: "application" as const,
  name: "core",
  uuid: "u1",
  fields: { build_pack: "nixpacks" },
  env,
});

describe("diff — a reserved name on a live box is a finding", () => {
  it("is promoted OUT of the remove-candidate orphan list", () => {
    const r = computeDiff(
      [desiredApp],
      [liveApp({ PORT: "3000", SOURCE_COMMIT: "" })],
      "full",
    );
    // The category whose documented meaning is "apply never removes these; read
    // them by eye". This is not cosmetic residue, so it must not be filed as it.
    const orphanVars = r.changes.flatMap((c) =>
      c.envDiffs.filter((e) => e.state === "remove-candidate"),
    );
    expect(orphanVars).toEqual([]);
    expect(r.reserved).toEqual([
      { kind: "application", name: "core", key: "SOURCE_COMMIT" },
    ]);
  });

  it("is not clean — the box is deploying green and reporting the wrong commit", () => {
    const r = computeDiff(
      [desiredApp],
      [liveApp({ PORT: "3000", SOURCE_COMMIT: "" })],
      "full",
    );
    expect(r.clean).toBe(false);
    const out = renderDiff(r);
    expect(out).toMatch(/FINDING/);
    expect(out).toMatch(/DELETE IT/);
    expect(out).toMatch(/SUPPRESSES/);
    expect(out).toMatch(/reserved-name FINDING\(s\)/);
    // apply never deletes — cast reports it, the human removes it in the UI.
    expect(out).toMatch(/never deletes/);
  });

  // A reserved var suppresses the injection whether or not cast has ever heard
  // of the resource carrying it — so the scan is over the LIVE side, not over
  // the resources the manifest happens to declare.
  it("finds one on an orphan resource, which no change entry covers", () => {
    const r = computeDiff(
      [desiredApp],
      [
        liveApp({ PORT: "3000" }),
        {
          kind: "application" as const,
          name: "nobody-declared-me",
          uuid: "u2",
          fields: {},
          env: { COOLIFY_URL: "https://stale.example.com" },
        },
      ],
      "full",
    );
    expect(r.reserved).toEqual([
      {
        kind: "application",
        name: "nobody-declared-me",
        key: "COOLIFY_URL",
      },
    ]);
    expect(r.clean).toBe(false);
  });

  it("finds none in structural mode, where no env var was read at all", () => {
    const r = computeDiff([desiredApp], [liveApp({})], "structural");
    expect(r.reserved).toEqual([]);
  });

  it("stays clean on a box with no reserved names", () => {
    const r = computeDiff([desiredApp], [liveApp({ PORT: "3000" })], "full");
    expect(r.clean).toBe(true);
    expect(renderDiff(r)).not.toMatch(/FINDING/);
  });
});

// --- smoke: it writes an env var too -------------------------------------------

describe("smoke — the probe it writes can never be a reserved name", () => {
  it("picks names outside the reserved space", () => {
    expect(isReservedEnvName(SMOKE_KEEP_KEY)).toBe(false);
    expect(isReservedEnvName(SMOKE_PROBE_KEY)).toBe(false);
  });
});
