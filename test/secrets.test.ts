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
    // Process substitution hands cast a path like /proc/self/fd/11 that is
    // meaningful only inside the process holding the fd. A spawned age does
    // not hold it, so passing the path through as `-i <path>` can never work;
    // the identity must travel to age on stdin. Opening the key here and
    // pointing at our own fd reproduces exactly that shape.
    const { keyFile, enc } = ageFixture();
    const fd = openSync(keyFile, "r");
    try {
      expect(decryptSecrets(enc, `/proc/self/fd/${fd}`)).toEqual({
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
// cannot: a regular file behind /proc/self/fd re-opens at offset 0 on every
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
