import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function decryptSecrets(
  file: string,
  keyFile: string,
): Record<string, string> {
  const out = execFileSync("age", ["-d", "-i", keyFile, file], {
    encoding: "utf8",
  });
  const secrets: Record<string, string> = {};
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1)
      throw new Error("age store: malformed line (expected KEY=value)");
    secrets[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return secrets;
}

// Write an environment's secret store, encrypted to its recipient.
//
// The plaintext goes to age on STDIN and the ciphertext straight to `file`: it
// is never a temp file, never reaches the terminal, and never lands in shell
// history. The hand-run recipe this replaces assembled /dev/shm/prod.env and
// relied on remembering to `shred -u` it afterwards — a step that is invisible
// when it is skipped.
export function encryptSecrets(
  recipient: string,
  file: string,
  vars: Record<string, string>,
): void {
  const plaintext = `${Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
  execFileSync("age", ["-r", recipient, "-o", file], {
    input: plaintext,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// The age identity for an environment, resolved without cast knowing anything
// about your environment names:
//
//   1. $CAST_AGE_KEY_FILE_<ENV>  — injected for this invocation
//   2. ~/.config/cast/age-<env>.key — a standing key on this machine
//
// This is the whole mechanism behind attended vs unattended applies: an
// environment whose key you never leave on disk can only be applied by an
// operator who injects it. Keep the key OUT of the state repo — the state repo
// holds ciphertext, never the identity that opens it.
export function keyFileFor(envName: string): string {
  const injected = process.env[`CAST_AGE_KEY_FILE_${envName.toUpperCase()}`];
  if (injected) return injected;
  const standing = join(homedir(), ".config", "cast", `age-${envName}.key`);
  if (existsSync(standing)) return standing;
  throw new Error(
    `no age key for ${envName}: set CAST_AGE_KEY_FILE_${envName.toUpperCase()} (attended apply) or place a standing key at ${standing}`,
  );
}

export function secretsFileFor(
  stateDir: string,
  repoShortName: string,
  envName: string,
): string {
  return join(stateDir, "secrets", `${repoShortName}.${envName}.env.age`);
}
