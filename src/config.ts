import { readFileSync } from "node:fs";

// Coolify's base URL + API token, read from <state>/.coolify.env — the one
// file in the state repo that is never committed (it is a live credential).
export function loadCoolifyEnv(path: string): {
  baseUrl: string;
  token: string;
} {
  const vars: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    vars[line.slice(0, eq)] = line.slice(eq + 1).replace(/^"|"$/g, "");
  }
  const baseUrl = vars.COOLIFY_BASE_URL;
  const token = vars.COOLIFY_ACCESS_TOKEN;
  if (!baseUrl || !token) {
    throw new Error(
      `${path}: COOLIFY_BASE_URL and COOLIFY_ACCESS_TOKEN are required`,
    );
  }
  return { baseUrl, token };
}
