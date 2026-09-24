import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APPLY_DIFF_OPTIONS,
  CAPTURE_OPTIONS,
  DESTROY_OPTIONS,
  GITHUB_APP_OPTIONS,
  INVENTORY_OPTIONS,
  SERVER_ADD_OPTIONS,
  SMOKE_OPTIONS,
  TEAM_OPTIONS,
  USAGE,
} from "../src/cli.js";

// Every flag a command accepts is on that command's usage lines (#151).
//
// cast#151 was one instance: `diff` took `--path` and `--hostname-overlay`
// (same parser table as `apply`, both honoured) and its usage lines showed
// neither, so an operator checking the box during a cutover window — the one
// time the overlay flag matters on the read-only verb — was told every app had
// drifted and given no hint the flag existed. This guards the CLASS: for each
// command, every key of its parseArgs table appears on one of its USAGE lines,
// or is one of the seven flags the block under USAGE describes, or is the one
// exemption declared here. Both sets are literals in this file, asserted, so
// neither can be widened silently.

// The flags described in prose under the command lines. Exactly these seven.
const DESCRIBED = [
  "state",
  "env",
  "instance",
  "project",
  "environment",
  "resource",
  "all",
] as const;

// `apply` shares `diff`'s table so it accepts `--full`, and cli.ts makes it a
// no-op there (apply is always full). Documenting it on the apply line would
// be worse than omitting it. Exactly one entry.
const EXEMPT: ReadonlyArray<readonly [command: string, flag: string]> = [
  ["apply", "full"],
];

// Which top-level command word each table serves. `github-app` and
// `server add` have subcommand lines; they are grouped under the word.
const TABLES: ReadonlyArray<
  readonly [command: string, options: Record<string, unknown>]
> = [
  ["apply", APPLY_DIFF_OPTIONS],
  ["diff", APPLY_DIFF_OPTIONS],
  ["capture", CAPTURE_OPTIONS],
  ["inventory", INVENTORY_OPTIONS],
  ["destroy", DESTROY_OPTIONS],
  ["server", SERVER_ADD_OPTIONS],
  ["github-app", GITHUB_APP_OPTIONS],
  ["smoke", SMOKE_OPTIONS],
  ["team", TEAM_OPTIONS],
];

// The flags each command's usage lines show: a line `cast <word> …` opens a
// command's group, and the indented lines after it that open no other command
// (register's wrapped flags) belong to the same group. Read from the synopsis
// only — the prose block below it is deliberately not consulted, which is what
// makes "add a description paragraph instead of fixing the line" fail.
export function usageFlags(usage: string): Map<string, Set<string>> {
  const synopsis = usage.split("\n\n")[0];
  const flags = new Map<string, Set<string>>();
  let current: string | undefined;
  for (const line of synopsis.split("\n")) {
    const opens = /^(?:usage: )?\s*cast (\S+)/.exec(line);
    if (opens) current = opens[1];
    if (!current) continue;
    const set = flags.get(current) ?? new Set<string>();
    for (const m of line.matchAll(/--([a-z][a-z-]*)/g)) set.add(m[1]);
    flags.set(current, set);
  }
  return flags;
}

// The defects: every (command, flag) the table accepts and the usage hides.
export function hiddenFlags(
  usage: string,
  tables: typeof TABLES,
): Array<[string, string]> {
  const shown = usageFlags(usage);
  const out: Array<[string, string]> = [];
  for (const [command, options] of tables) {
    for (const flag of Object.keys(options)) {
      if ((DESCRIBED as readonly string[]).includes(flag)) continue;
      if (EXEMPT.some(([c, f]) => c === command && f === flag)) continue;
      if (shown.get(command)?.has(flag)) continue;
      out.push([command, flag]);
    }
  }
  return out;
}

describe("cast --help shows every flag a command accepts (#151)", () => {
  it("pins the described set and the exemption list themselves", () => {
    expect([...DESCRIBED]).toEqual([
      "state",
      "env",
      "instance",
      "project",
      "environment",
      "resource",
      "all",
    ]);
    expect(EXEMPT).toEqual([["apply", "full"]]);
    // And the described set is exactly what the prose block documents: each
    // one opens a paragraph there, and nothing else does.
    // The flag block sits between the synopsis and the `github-app` section.
    const prose = USAGE.split("\n\n")
      .slice(1)
      .join("\n\n")
      .split("\ngithub-app (")[0];
    const documented = [...prose.matchAll(/^ {2}--([a-z-]+)/gm)].map(
      (m) => m[1],
    );
    expect(documented).toEqual([...DESCRIBED]);
  });

  it("hides nothing today", () => {
    expect(hiddenFlags(USAGE, TABLES)).toEqual([]);
  });

  // The instance, kept red for good: the usage text as it was before #151
  // shows exactly the two hidden flags the issue named, and nothing else —
  // not `--resource` on apply, not `--all` on destroy.
  it("would have named exactly diff --path and diff --hostname-overlay before the fix", () => {
    const before = USAGE.replace(
      "       cast diff      <org>/<repo> --env <env> [--full] [--path <dir>] [--project <name>] [--environment <name>] [--hostname-overlay <file>]",
      "       cast diff      <org>/<repo> --env <env> [--full] [--project <name>] [--environment <name>]",
    );
    expect(before).not.toBe(USAGE);
    expect(hiddenFlags(before, TABLES)).toEqual([
      ["diff", "path"],
      ["diff", "hostname-overlay"],
    ]);
  });

  // The class: a flag added to any table without a usage line is caught,
  // which a test pinning the diff line alone could not do.
  it("catches a flag added to a table and not to the usage", () => {
    const tables = [
      ...TABLES,
      ["smoke", { ...SMOKE_OPTIONS, nonsense: { type: "boolean" } }],
    ] as unknown as typeof TABLES;
    expect(hiddenFlags(USAGE, tables)).toEqual([["smoke", "nonsense"]]);
  });

  // The escape hatch: describing the flag in the prose block, instead of
  // putting it on the command's line, does not satisfy the guard.
  it("is not satisfied by a description paragraph", () => {
    const before = USAGE.replace(
      " [--path <dir>] [--project <name>] [--environment <name>] [--hostname-overlay <file>]\n       cast diff      --env <env> --all",
      " [--project <name>] [--environment <name>]\n       cast diff      --env <env> --all",
    );
    const withParagraph = `${before}\n  --hostname-overlay <file>\n                  swaps the manifest's domains for a pre-flight run.\n`;
    expect(hiddenFlags(withParagraph, TABLES)).toEqual([
      ["diff", "path"],
      ["diff", "hostname-overlay"],
    ]);
  });

  it("README's synopsis shows the same two flags on diff", () => {
    const text = readFileSync("README.md", "utf8");
    const line = text
      .split("\n")
      .find((l) => l.startsWith("cast diff      <org>/<repo>"));
    expect(line).toContain("[--path <dir>]");
    expect(line).toContain("[--hostname-overlay <file>]");
    const all = text
      .split("\n")
      .find((l) => l.startsWith("cast diff      --env <env> --all"));
    expect(all).not.toMatch(/--path|hostname-overlay/);
  });
});
