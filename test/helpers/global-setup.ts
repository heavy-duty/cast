import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The env var that tells `tmp()` (test/helpers/tmp.ts) where to allocate.
export const RUN_ROOT_ENV = "CAST_TEST_TMP_ROOT";

// One directory per `vitest run`, holding every temp dir the suite allocates.
//
// This is what actually reaps the suite's temp dirs (#117). The obvious design —
// each worker cleaning up after itself in a `process.once("exit")` hook — does
// NOT work under vitest, and it fails silently, which is worse: vitest recycles
// its pool workers by killing them, so `exit` handlers registered inside a test
// file never run. Measured, not assumed: a probe test that wrote a file from an
// `exit` hook produced no file, and a full suite run with per-worker exit hooks
// still left 750 directories behind.
//
// globalSetup's teardown runs in vitest's MAIN process, after every worker has
// finished, and vitest awaits it. That makes it the only hook in the run with
// both of the properties this needs: it is guaranteed to execute, and it sees
// the whole run rather than one worker's slice of it.
//
// Collapsing the whole run into a single root is what makes that teardown one
// `rmSync` instead of a list to keep in sync across processes — the workers do
// not have to report anything back, because the parent already knows the one
// path that contains everything.
export function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "cast-testrun-"));
  process.env[RUN_ROOT_ENV] = root;

  return function teardown(): void {
    // Best-effort: a failure to clean up must not turn a green run red.
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };
}
