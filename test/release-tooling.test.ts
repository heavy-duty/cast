import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

// The release surface has two moving parts this file can prove without a
// tag push: `cast --version` (what an operator asks an installed tree) and
// scripts/changelog-section.sh (what release.yml publishes as the release
// body). Both are exercised for real — the built CLI, the actual script —
// not reimplemented in the test.

describe("cast --version", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    version: string;
  };

  for (const flag of ["--version", "-V"]) {
    it(`${flag} prints the package.json version and the install root`, async () => {
      const { stdout } = await run("node", ["dist/cli.js", flag]);
      // The version comes from package.json — the single source of truth
      // (cast#96) — and the root rides along, rig-style, because "which
      // cast" and "where from" are the same question.
      expect(stdout.trim()).toBe(`cast ${pkg.version} (${process.cwd()})`);
    });
  }

  it("exits 0 and prints nothing to stderr", async () => {
    const { stderr } = await run("node", ["dist/cli.js", "--version"]);
    expect(stderr).toBe("");
  });
});

describe("scripts/changelog-section.sh", () => {
  const SCRIPT = join(process.cwd(), "scripts", "changelog-section.sh");

  const CHANGELOG = `# Changelog

Intro prose that must never leak into a release body.

## Unreleased

### Added

- something still cooking

## 0.2.0 — 2026-07-18

### Added

- **the second thing** (#96) — with detail.

### Fixed

- a fix note

## 0.1.0 — 2026-07-01

- the first thing
`;

  function withChangelog(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "cast-changelog-"));
    const file = join(dir, "CHANGELOG.md");
    writeFileSync(file, content);
    return file;
  }

  it("prints exactly one version's section, trimmed", async () => {
    const file = withChangelog(CHANGELOG);
    const { stdout } = await run("bash", [SCRIPT, "0.2.0", file]);
    expect(stdout).toBe(
      "### Added\n\n- **the second thing** (#96) — with detail.\n\n### Fixed\n\n- a fix note\n",
    );
  });

  it("does not bleed into the next section for the last version either", async () => {
    const file = withChangelog(CHANGELOG);
    const { stdout } = await run("bash", [SCRIPT, "0.1.0", file]);
    expect(stdout).toBe("- the first thing\n");
  });

  it("never serves Unreleased content for a version that is absent", async () => {
    const file = withChangelog(CHANGELOG);
    // 0.3.0 has no section — the release must fail loudly, not ship the
    // Unreleased notes (or an empty body) under a version's name.
    await expect(run("bash", [SCRIPT, "0.3.0", file])).rejects.toMatchObject({
      code: 1,
    });
  });

  it("refuses an empty section", async () => {
    const file = withChangelog(
      "# Changelog\n\n## 0.9.0 — 2026-01-01\n\n## 0.8.0\n\n- old\n",
    );
    await expect(run("bash", [SCRIPT, "0.9.0", file])).rejects.toMatchObject({
      code: 1,
    });
  });

  it("refuses a missing file and a missing argument", async () => {
    await expect(
      run("bash", [SCRIPT, "0.1.0", "/nonexistent/CHANGELOG.md"]),
    ).rejects.toMatchObject({ code: 1 });
    await expect(run("bash", [SCRIPT])).rejects.toMatchObject({ code: 2 });
  });

  it("finds the real CHANGELOG's Unreleased section (the format stays parseable)", async () => {
    // Guard against the repo's own changelog drifting away from the shape
    // this script parses — that drift would only surface on a tag push.
    const { stdout } = await run("bash", [
      SCRIPT,
      "Unreleased",
      "CHANGELOG.md",
    ]);
    expect(stdout.length).toBeGreaterThan(0);
  });
});
