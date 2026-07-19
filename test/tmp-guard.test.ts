import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));

// The only files allowed to call the raw API: the allocator and the per-run
// root that global setup reaps. Everything else goes through `tmp()`.
const HELPER = "helpers/tmp.ts";
const ALLOWED = new Set([HELPER, "helpers/global-setup.ts"]);

// Assembled at runtime rather than written out, so THIS file is not itself a
// hit. Exempting the guard by path instead would punch a permanent hole in the
// very check it performs.
const NEEDLE = ["mkdtemp", "Sync"].join("");

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

// The class guard the issue asks for (#117): the suite leaked 6731 temp dirs
// because cleanup was opt-in and 68 sites opted out. Making `tmp()` the only
// way to allocate is what keeps the next site clean by default — and this test
// is what stops the next raw call surviving review, the same shape as box#112's
// eof_guard_sweep. It is a source-text check on purpose: it fails at the point
// the habit returns, not after a machine-day of accumulation.
describe("temp dir allocation", () => {
  it(`uses the tmp() helper everywhere — no raw ${NEEDLE} under test/`, () => {
    const offenders = walk(TEST_DIR)
      .filter((f) => /\.(ts|js|mjs|sh)$/.test(f))
      .filter((f) => !ALLOWED.has(relative(TEST_DIR, f)))
      .filter((f) => readFileSync(f, "utf8").includes(NEEDLE))
      .map((f) => relative(TEST_DIR, f))
      .sort();

    expect(offenders).toEqual([]);
  });

  it("keeps the helper as the single allocation point", () => {
    const helper = readFileSync(join(TEST_DIR, HELPER), "utf8");
    expect(helper).toContain(NEEDLE);
    // and it must actually reap
    expect(helper).toContain("rmSync");
  });
});
