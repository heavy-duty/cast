import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decryptSecrets, keyFileFor, secretsFileFor } from "../src/secrets.js";

// A key file and a store encrypted to it, for the decrypt tests.
function ageFixture(): { keyFile: string; enc: string } {
  const dir = mkdtempSync(join(tmpdir(), "infra-age-"));
  const keyFile = join(dir, "key.txt");
  execFileSync("age-keygen", ["-o", keyFile]);
  const recipient = execFileSync("age-keygen", ["-y", keyFile], {
    encoding: "utf8",
  }).trim();
  const plain = join(dir, "s.env");
  writeFileSync(plain, "MAILGUN_KEY=mk-123\nOPENROUTER_KEY=or-456\n");
  const enc = join(dir, "s.env.age");
  execFileSync("age", ["-r", recipient, "-o", enc, plain]);
  return { keyFile, enc };
}

describe("decryptSecrets", () => {
  it("round-trips an env file through age", () => {
    const { keyFile, enc } = ageFixture();
    expect(decryptSecrets(enc, keyFile)).toEqual({
      MAILGUN_KEY: "mk-123",
      OPENROUTER_KEY: "or-456",
    });
  });

  it("accepts a key path only this process can resolve — what <(pm read …) injects", () => {
    // Process substitution hands cast a path like /dev/fd/11 that is
    // meaningful only inside the process holding the fd. A spawned age does
    // not hold it, so passing the path through as `-i <path>` can never work;
    // the identity must travel to age on stdin. Opening the key here and
    // pointing at our own fd reproduces exactly that shape. /dev/fd works on
    // both Linux (symlink to /proc/self/fd) and macOS, where /proc is absent.
    const { keyFile, enc } = ageFixture();
    const fd = openSync(keyFile, "r");
    try {
      expect(decryptSecrets(enc, `/dev/fd/${fd}`)).toEqual({
        MAILGUN_KEY: "mk-123",
        OPENROUTER_KEY: "or-456",
      });
    } finally {
      closeSync(fd);
    }
  });
});

describe("secretsFileFor", () => {
  it("resolves the age store under the state dir it is given, not the cwd", () => {
    expect(secretsFileFor("/srv/state", "widget", "prod")).toBe(
      "/srv/state/secrets/widget.prod.env.age",
    );
  });
});

// Pins the read-once shape of `<(pm read …)` that the fd-path test above
// cannot: a regular file behind an fd path re-opens at offset 0 on every
// read, but a pipe drains. `diff --all` / `apply --all` decrypt once per
// project, so the identity must be read once per process and reused.
describe("decryptSecrets identity caching", () => {
  it("a read-once pipe key survives two decrypts — the --all loop shape", () => {
    const { keyFile, enc } = ageFixture();
    const dir = mkdtempSync(join(tmpdir(), "infra-fifo-"));
    const fifo = join(dir, "key.fifo");
    execFileSync("mkfifo", [fifo]);
    // One writer, one serving of the key: exactly what a process substitution
    // delivers. It pairs with the first decrypt's open and exits.
    const once = spawn("sh", ["-c", `cat "${keyFile}" > "${fifo}"`], {
      stdio: "ignore",
    });
    const expected = { MAILGUN_KEY: "mk-123", OPENROUTER_KEY: "or-456" };
    expect(decryptSecrets(enc, fifo)).toEqual(expected);
    // The pipe is now drained. A second writer serves nothing, so if the
    // per-process cache ever regresses, the re-read hands age an empty
    // identity and fails loudly instead of blocking the suite on a
    // writerless FIFO open. With the cache, nobody opens the FIFO again and
    // the writer is still blocked in open() when we kill it.
    const drained = spawn("sh", ["-c", `: > "${fifo}"`], { stdio: "ignore" });
    try {
      expect(decryptSecrets(enc, fifo)).toEqual(expected);
    } finally {
      once.kill("SIGKILL");
      drained.kill("SIGKILL");
    }
  });
});

describe("keyFileFor", () => {
  it("an env with no injected var and no standing key refuses, naming both ways in", () => {
    Reflect.deleteProperty(process.env, "CAST_AGE_KEY_FILE_PROD");
    expect(() => keyFileFor("prod")).toThrow(
      /no age key for prod.*CAST_AGE_KEY_FILE_PROD.*age-prod\.key/s,
    );
  });
  it("the injected var wins, and is resolved per environment name", () => {
    process.env.CAST_AGE_KEY_FILE_PROD = "/tmp/prod.key";
    expect(keyFileFor("prod")).toBe("/tmp/prod.key");
    Reflect.deleteProperty(process.env, "CAST_AGE_KEY_FILE_PROD");
  });
  // #102: `drill-b`.toUpperCase() is `DRILL-B`, and a var named
  // CAST_AGE_KEY_FILE_DRILL-B cannot be set by any POSIX shell — the injected
  // channel (and its process-substitution trick) was unreachable for every
  // hyphenated environment name. Non-alphanumerics map to `_`.
  it("a hyphenated env name maps to a settable var name", () => {
    process.env.CAST_AGE_KEY_FILE_DRILL_B = "/tmp/drill-b.key";
    try {
      expect(keyFileFor("drill-b")).toBe("/tmp/drill-b.key");
    } finally {
      Reflect.deleteProperty(process.env, "CAST_AGE_KEY_FILE_DRILL_B");
    }
  });
  it("the refusal advertises the mapped (settable) var, and the exact-name standing path", () => {
    Reflect.deleteProperty(process.env, "CAST_AGE_KEY_FILE_DRILL_B");
    // Isolate $HOME: a standing age-drill-b.key on the dev machine must not
    // turn the refusal into a hit (os.homedir() reads $HOME on POSIX).
    const home = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "cast-home-"));
    try {
      expect(() => keyFileFor("drill-b")).toThrow(
        /no age key for drill-b.*CAST_AGE_KEY_FILE_DRILL_B.*age-drill-b\.key/s,
      );
    } finally {
      process.env.HOME = home;
    }
  });
  it("falls back to a standing key on disk when one exists", () => {
    const home = process.env.HOME;
    const dir = mkdtempSync(join(tmpdir(), "cast-home-"));
    const cfg = join(dir, ".config", "cast");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "age-staging.key"), "AGE-SECRET-KEY-1\n");
    process.env.HOME = dir; // os.homedir() reads $HOME on POSIX
    try {
      expect(keyFileFor("staging")).toBe(join(cfg, "age-staging.key"));
    } finally {
      process.env.HOME = home;
    }
  });
});
