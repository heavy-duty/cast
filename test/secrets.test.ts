import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decryptSecrets, keyFileFor, secretsFileFor } from "../src/secrets.js";

describe("decryptSecrets", () => {
  it("round-trips an env file through age", () => {
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
    expect(decryptSecrets(enc, keyFile)).toEqual({
      MAILGUN_KEY: "mk-123",
      OPENROUTER_KEY: "or-456",
    });
  });
});

describe("secretsFileFor", () => {
  it("resolves the age store under the state dir it is given, not the cwd", () => {
    expect(secretsFileFor("/srv/state", "widget", "prod")).toBe(
      "/srv/state/secrets/widget.prod.env.age",
    );
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
