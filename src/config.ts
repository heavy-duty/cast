import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Which Coolify cast is about to talk to. The single most consequential input
// to any command — so it is a value that gets resolved, named, and printed,
// not an implicit property of whatever `.coolify.env` happens to contain right
// now.
export type CoolifyInstance = {
  // "default" for <state>/.coolify.env, else the --instance name.
  name: string;
  baseUrl: string;
  token: string;
  // Declared by the instance, not inferred from the token: an instance
  // configured for inspection must not be writable even if its token would
  // permit the writes. See assertWritable.
  readOnly: boolean;
  // The file it came from, so every message can name it.
  file: string;
};

export const DEFAULT_INSTANCE = "default";
const DEFAULT_FILE = ".coolify.env";
const INSTANCE_DIR = ".coolify";

function parseEnvFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    vars[line.slice(0, eq)] = line.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return vars;
}

// Coolify's base URL + API token, read from <state>/.coolify.env — the one
// file in the state repo that is never committed (it is a live credential).
export function loadCoolifyEnv(path: string): {
  baseUrl: string;
  token: string;
  readOnly: boolean;
} {
  const vars = parseEnvFile(path);
  const baseUrl = vars.COOLIFY_BASE_URL;
  const token = vars.COOLIFY_ACCESS_TOKEN;
  if (!baseUrl || !token) {
    throw new Error(
      `${path}: COOLIFY_BASE_URL and COOLIFY_ACCESS_TOKEN are required`,
    );
  }
  return { baseUrl, token, readOnly: vars.COOLIFY_READ_ONLY === "true" };
}

// The named instances configured in a state dir: <state>/.coolify/<name>.env.
export function knownInstances(stateDir: string): string[] {
  const dir = join(stateDir, INSTANCE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".env"))
    .map((f) => f.slice(0, -".env".length))
    .sort();
}

export function instanceFile(stateDir: string, name?: string): string {
  return name === undefined
    ? join(stateDir, DEFAULT_FILE)
    : join(stateDir, INSTANCE_DIR, `${name}.env`);
}

// Refuse, don't guess — the same position `diff` takes on an absent target
// (#12). An unknown instance name is not a reason to fall back to the default
// one: "the instance I asked for isn't there, so I used a different one" is
// how a diff meant for a legacy box gets run against production.
export function loadInstance(stateDir: string, name?: string): CoolifyInstance {
  const file = instanceFile(stateDir, name);
  if (name !== undefined && !existsSync(file)) {
    const known = knownInstances(stateDir);
    throw new Error(
      [
        `no Coolify instance named "${name}"`,
        "",
        `  looked for:  ${file}`,
        `  configured:  ${known.join(", ") || "(none)"}`,
        "",
        "A named instance is an env file holding COOLIFY_BASE_URL +",
        "COOLIFY_ACCESS_TOKEN (and optionally COOLIFY_READ_ONLY=true). Create the",
        "file above, or pass one of the names that exist. With no --instance, cast",
        `reads ${join(stateDir, DEFAULT_FILE)}.`,
      ].join("\n"),
    );
  }
  const { baseUrl, token, readOnly } = loadCoolifyEnv(file);
  return {
    name: name ?? DEFAULT_INSTANCE,
    baseUrl,
    token,
    readOnly,
    file,
  };
}

// A read-only instance is one the operator declared for inspection. The token
// it holds may well be able to write — that is exactly the point: this turns
// "I pointed the wrong token at the wrong box" from a live incident into an
// exit code, before the first mutating call rather than after it.
export function assertWritable(instance: CoolifyInstance, verb: string): void {
  if (!instance.readOnly) return;
  throw new Error(
    [
      `refusing to ${verb}: Coolify instance "${instance.name}" is read-only`,
      "",
      `  declared by: COOLIFY_READ_ONLY=true in ${instance.file}`,
      `  base url:    ${instance.baseUrl}`,
      "",
      `\`${verb}\` writes. An instance configured for inspection cannot be written`,
      "to, even if its token would permit it. Run `cast diff` or `cast team`",
      "against this instance, or pass an --instance that is not read-only.",
    ].join("\n"),
  );
}

// What cast prints before it touches a Coolify, on every command that reaches
// one. The instance is the input most likely to be wrong and least likely to
// be noticed — so it gets said out loud, next to the team assert.
export function formatInstance(instance: CoolifyInstance): string {
  return `instance ${instance.name} → ${instance.baseUrl}${
    instance.readOnly ? "  (read-only)" : ""
  }`;
}
