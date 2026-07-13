import { describe, expect, it } from "vitest";
import { loadBindings } from "../src/bindings.js";
import {
  type ProjectOutcome,
  fleetConflict,
  fleetExitCode,
  renderEmptyRegistry,
  renderFleetApply,
  renderFleetDiff,
} from "../src/fleet.js";

const REGISTERED = ["heavy-duty/alpha", "heavy-duty/beta", "heavy-duty/gamma"];

const clean = (repo: string): ProjectOutcome => ({ repo, status: "clean" });
const drift = (repo: string): ProjectOutcome => ({ repo, status: "drift" });
const applied = (repo: string, mutated: string[] = []): ProjectOutcome => ({
  repo,
  status: "applied",
  mutated,
});
const unreachable = (repo: string, message: string): ProjectOutcome => ({
  repo,
  status: "unreachable",
  message,
});

// The contract, as a table. Everything else in this feature is prose a human
// reads; this is the part CI reads, and the only part that can gate a pipeline.
describe("fleetExitCode", () => {
  it("diff: 0 only when every registered project was READ and every one is clean", () => {
    expect(fleetExitCode("diff", REGISTERED, REGISTERED.map(clean))).toBe(0);
  });

  it("diff: 1 when all were read and at least one drifted", () => {
    expect(
      fleetExitCode("diff", REGISTERED, [
        clean("heavy-duty/alpha"),
        drift("heavy-duty/beta"),
        clean("heavy-duty/gamma"),
      ]),
    ).toBe(1);
  });

  it("diff: 2 when a project could not be read — outranking drift", () => {
    // The whole point of the ranking: an unreadable project is not a diff
    // result, it is the ABSENCE of one. A run that reported 1 here would be
    // saying "the fleet has drift", when what it actually has is a hole.
    expect(
      fleetExitCode("diff", REGISTERED, [
        clean("heavy-duty/alpha"),
        unreachable("heavy-duty/beta", "refusing to diff: no project named…"),
        drift("heavy-duty/gamma"),
      ]),
    ).toBe(2);
  });

  it("diff: 2 when the outcomes do not cover the registry at all", () => {
    // Fails closed on a coverage gap it does not otherwise recognize. A clean
    // outcome for two of three projects is not a clean fleet — and the default
    // an unrecognized shape falls into must never be 0.
    expect(
      fleetExitCode("diff", REGISTERED, [
        clean("heavy-duty/alpha"),
        clean("heavy-duty/beta"),
      ]),
    ).toBe(2);
  });

  it("apply: 0 only when every registered project applied", () => {
    expect(
      fleetExitCode(
        "apply",
        REGISTERED,
        REGISTERED.map((r) => applied(r)),
      ),
    ).toBe(0);
    expect(
      fleetExitCode("apply", REGISTERED, [
        applied("heavy-duty/alpha", ["core"]),
        unreachable("heavy-duty/beta", "GET /projects/p2/staging → 500: boom"),
      ]),
    ).toBe(2);
  });
});

describe("renderFleetDiff", () => {
  it("states coverage, not just findings — a clean fleet says how many it read", () => {
    const out = renderFleetDiff("prod", REGISTERED, REGISTERED.map(clean));
    expect(out).toContain("registered:   3");
    expect(out).toContain("read:         3 of 3");
    expect(out).toContain(
      "all 3 registered project(s) were read, and every one is clean.",
    );
  });

  it("never lets an unreachable project read like a clean one", () => {
    const out = renderFleetDiff("prod", REGISTERED, [
      clean("heavy-duty/alpha"),
      unreachable(
        "heavy-duty/beta",
        'refusing to diff: no project named "beta" exists in this team\n\n  looked for: …',
      ),
      clean("heavy-duty/gamma"),
    ]);
    expect(out).toContain("read:         2 of 3");
    expect(out).toContain("UNREACHABLE:  1  heavy-duty/beta");
    // The headline of the refusal travels with the summary; the body of it was
    // printed in that project's own section.
    expect(out).toContain('no project named "beta" exists in this team');
    expect(out).not.toContain("looked for:");
    expect(out).toContain("FAILURE, not a diff result");
    expect(out).not.toContain("every one is clean");
  });
});

describe("renderFleetApply", () => {
  it("says what it applied when it applied everything", () => {
    const out = renderFleetApply("prod", REGISTERED, [
      applied("heavy-duty/alpha", ["core"]),
      applied("heavy-duty/beta"),
      applied("heavy-duty/gamma"),
    ]);
    expect(out).toContain("applied:      3 of 3");
    expect(out).toContain("heavy-duty/alpha: core");
    expect(out).toContain("all 3 registered project(s) applied.");
  });

  it("says what it did AND what it did not touch when it stopped", () => {
    const out = renderFleetApply("prod", REGISTERED, [
      applied("heavy-duty/alpha", ["core"]),
      unreachable("heavy-duty/beta", "GET /projects/p2/staging → 500: boom"),
    ]);
    expect(out).toContain("applied:      1 of 3  heavy-duty/alpha");
    expect(out).toContain("FAILED:       heavy-duty/beta");
    expect(out).toContain("not reached:  1  heavy-duty/gamma");
    // The sentence an operator has to be able to trust before re-running.
    expect(out).toContain('"not reached" were NOT touched');
    expect(out).toContain("STOPPED at the first failure");
  });
});

describe("renderEmptyRegistry", () => {
  const bindings = (extra: string[]) =>
    loadBindings("(inline)", {
      overrideText: [
        "environments:",
        "  prod:",
        "    server: prod-box",
        "    team: { id: 0, name: Root Team }",
        "  staging:",
        "    server: staging-box",
        "    team: { id: 0, name: Root Team }",
        "github_apps:",
        "  heavy-duty/alpha: hdb-coolify",
        ...extra,
        "",
      ].join("\n"),
    });

  it("names the environment, the file, and the YAML to write", () => {
    const out = renderEmptyRegistry(
      "diff",
      "prod",
      bindings([]),
      "/state/environments.yaml",
    );
    expect(out).toContain(
      'refusing to diff --all: no projects are registered for "prod"',
    );
    expect(out).toContain("/state/environments.yaml");
    expect(out).toContain("no `projects:` block at all");
    expect(out).toContain("environments: [prod]");
    // The sentence the refusal exists for.
    expect(out).toContain('"0 projects, clean"');
  });

  it("distinguishes an unmigrated state file from one registered elsewhere", () => {
    const out = renderEmptyRegistry(
      "apply",
      "prod",
      bindings([
        "projects:",
        "  heavy-duty/alpha:",
        "    environments: [staging]",
      ]),
      "/state/environments.yaml",
    );
    expect(out).toContain(
      "a registry, but nothing registered for this environment",
    );
    expect(out).toContain("heavy-duty/alpha (staging)");
    expect(out).not.toContain("no `projects:` block at all");
  });
});

describe("fleetConflict", () => {
  it("names the offending single-project coordinate", () => {
    expect(fleetConflict({ "--project": "Incubator" })).toBe("--project");
    expect(fleetConflict({ "--resource": ["core=Stack v2"] })).toBe(
      "--resource",
    );
    expect(fleetConflict({ "<org>/<repo>": "heavy-duty/alpha" })).toBe(
      "<org>/<repo>",
    );
  });

  it("passes a legitimate fleet invocation", () => {
    // parseArgs hands back `[]` for an unused repeatable flag, not `undefined`.
    expect(
      fleetConflict({ "--resource": [], "--path": undefined }),
    ).toBeUndefined();
    expect(fleetConflict({})).toBeUndefined();
  });
});
