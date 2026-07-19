import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The identity is read here and handed to age on stdin (`-i -`), never as a
// path: keyFile may be a process substitution (`CAST_AGE_KEY_FILE_PROD=<(pm
// read …)` → /proc/self/fd/N), and that path resolves only inside the process
// holding the fd — this one. A freshly spawned age has no such fd and fails
// with ENOENT. Not `-i /dev/stdin` either: node closes the pipe before age
// re-opens it by path (ENXIO); `-` makes age read the inherited fd directly.
//
// And it is read exactly ONCE per process: a process substitution is a
// read-once pipe, but `diff --all` / `apply --all` call decryptSecrets once
// per project. The first read drains the pipe; a re-read would hand age an
// empty identity and the second project's decrypt would fail. Caching by key
// path changes nothing about exposure — the key already transits this
// process's memory on every call.
const identities = new Map<string, Buffer>();

function readIdentity(keyFile: string): Buffer {
  let identity = identities.get(keyFile);
  if (identity === undefined) {
    identity = readFileSync(keyFile);
    identities.set(keyFile, identity);
  }
  return identity;
}

export function decryptSecrets(
  file: string,
  keyFile: string,
): Record<string, string> {
  const out = execFileSync("age", ["-d", "-i", "-", file], {
    input: readIdentity(keyFile),
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
  const injected = process.env[ageKeyVarFor(envName)];
  if (injected) return injected;
  const standing = join(homedir(), ".config", "cast", `age-${envName}.key`);
  if (existsSync(standing)) return standing;
  throw new Error(
    `no age key for ${envName}: set ${ageKeyVarFor(envName)} (attended apply) or place a standing key at ${standing}`,
  );
}

// The env var carrying an environment's injected key. Uppercased AND mapped to
// the character set a shell can actually set: `drill-b`.toUpperCase() is
// `DRILL-B`, and `CAST_AGE_KEY_FILE_DRILL-B` is a name no POSIX shell can
// export — the refusal above used to advertise it anyway, an escape hatch that
// pointed at a wall (#102, found live in the release drill). Every character
// outside [A-Z0-9] collapses to `_`, so `drill-b` and `drill.b` both read
// CAST_AGE_KEY_FILE_DRILL_B — a collision that costs nothing, because both
// names still resolve their OWN standing key (which keeps the exact env name).
export function ageKeyVarFor(envName: string): string {
  return `CAST_AGE_KEY_FILE_${envName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function secretsFileFor(
  stateDir: string,
  repoShortName: string,
  envName: string,
): string {
  return join(stateDir, "secrets", `${repoShortName}.${envName}.env.age`);
}
