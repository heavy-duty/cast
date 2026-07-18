import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("cast --version", () => {
  // The real built CLI, not a fixture: what an operator's `cast --version`
  // answers. The version comes from package.json — the single source of
  // truth (deliberately no separate VERSION file) — and the install root
  // rides along, rig-style, because "which cast" and "where from" are the
  // same question once versions install side by side.
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    version: string;
  };

  for (const flag of ["--version", "-V"]) {
    it(`${flag} prints the package.json version and the install root`, async () => {
      const { stdout, stderr } = await run("node", ["dist/cli.js", flag]);
      expect(stdout.trim()).toBe(`cast ${pkg.version} (${process.cwd()})`);
      expect(stderr).toBe("");
    });
  }
});
