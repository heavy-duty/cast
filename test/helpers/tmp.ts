import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_ROOT_ENV } from "./global-setup.js";

// Every temp dir this process has handed out, in creation order.
const created: string[] = [];

// Where to allocate. Under `vitest run` this is the per-run root that
// global-setup.ts created and will remove wholesale when the run ends; the
// fallback keeps `tmp()` usable if a file is ever executed outside that config.
function base(): string {
  return process.env[RUN_ROOT_ENV] ?? tmpdir();
}

// Belt-and-braces reaper for the fallback case only.
//
// It is deliberately NOT the primary mechanism. Vitest recycles its pool workers
// by killing them, so an `exit` handler registered from a test file does not run
// — verified with a probe test, and by a full suite run that still leaked 750
// directories with this hook in place. The real cleanup is global-setup.ts's
// teardown, which runs in the main process where an exit IS orderly. This hook
// only earns its keep when `tmp()` is called with no run root set, where nothing
// else would ever remove the directory.
let armed = false;

function arm(): void {
  if (armed) return;
  armed = true;
  process.once("exit", () => {
    for (const dir of created) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    created.length = 0;
  });
}

/**
 * Create a temp dir and register it for cleanup. Drop-in replacement for
 * `mkdtempSync(join(tmpdir(), prefix))` — the prefix survives as the directory's
 * basename, so paths stay as greppable as they were.
 *
 * @param prefix e.g. `"cast-home-"` — mkdtemp appends six random characters.
 */
export function tmp(prefix: string): string {
  arm();
  const dir = mkdtempSync(join(base(), prefix));
  created.push(dir);
  return dir;
}
