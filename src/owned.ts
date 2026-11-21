import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { ResourceKind } from "./diff.js";
import { templateKeys } from "./envtemplate.js";
import { ENV_KEY, type Manifest, type OwnedKeysDecl } from "./manifest.js";

// Env keys owned by the app (cast#177), resolved against the checkout.
//
// The manifest schema (manifest.ts) checks what it can see alone: the shape,
// the names, a relative `.json` path. What needs the checkout lives here: the
// file a pointer names, and whether every name is a key the template actually
// declares. A declared key no template mentions is refused — the
// generated_secrets rule (resolve.ts): a guard standing over nothing reads like
// a guard, and the likeliest cause is a typo that leaves the real key exposed to
// a break-glass apply.
//
// SCOPE. Inline lists and per-template lists are checked for the environment
// being run only, like generated_secrets: a prod run never opens staging's
// templates for them. The one check that is NOT per environment is the dead
// name in a shared list (`_secretos`), and that is forced by the file format: a
// shared list applies to every template that points at the file, filtered to
// the keys each one declares, so a credential staging never carries is not a
// typo because prod carries it — whether a shared name is dead is a question
// about every pointing template in every environment. That check alone opens
// other environments' templates, and only those of resources pointing at a
// file this environment also points at.

// The file a pointer names, as the product wrote it:
//
//   {
//     "_why": "comment",                         // `_` + string: a comment
//     "_secretos": ["MAILGUN_API_KEY"],          // `_` + array: every template
//     "admin.prod.env.template": ["MCP_ENABLED"] // template file name: that one
//   }
type OwnedFile = {
  shared: Map<string, string[]>;
  byTemplate: Map<string, string[]>;
};

// Where a declaration sits, for messages and for keying the result.
type Site = {
  env: string;
  kind: Extract<ResourceKind, "application" | "service">;
  name: string;
  template: string;
  decl: OwnedKeysDecl;
};

// `application:admin` → the env keys owned on that resource, for one
// environment. A resource that declares none is absent.
export type OwnedKeys = Record<string, string[]>;

export function ownedKey(kind: ResourceKind, name: string): string {
  return `${kind}:${name}`;
}

function sitesOf(manifest: Manifest): Site[] {
  const sites: Site[] = [];
  for (const [env, spec] of Object.entries(manifest.environments)) {
    const push = (
      kind: Site["kind"],
      name: string,
      r: { owned_keys?: OwnedKeysDecl; env_template?: string },
    ) => {
      // The schema refuses owned_keys without env_template; the guard is for
      // the type only.
      if (r.owned_keys !== undefined && r.env_template !== undefined)
        sites.push({
          env,
          kind,
          name,
          template: r.env_template,
          decl: r.owned_keys,
        });
    };
    for (const [name, app] of Object.entries(spec.applications))
      push("application", name, app);
    for (const [name, svc] of Object.entries(spec.services ?? {}))
      push("service", name, svc);
  }
  return sites;
}

const where = (s: Site) => `manifest environment ${s.env}: ${s.kind} ${s.name}`;

const DEAD_TAIL = [
  "",
  "An owned key that matches nothing guards nothing — and if this is a typo, the",
  "key it was meant to guard is overwritten by the next break-glass apply. Fix",
  "the spelling, or drop the entry.",
];

function readOwnedFile(
  checkoutDir: string,
  path: string,
  pointedBy: Site[],
): OwnedFile {
  const file = join(checkoutDir, path);
  const by = pointedBy.map((s) => `${s.kind} ${s.name} in ${s.env}`).join(", ");
  if (!existsSync(file))
    throw new Error(
      [
        `owned_keys file missing: ${path} (named by ${by})`,
        "",
        `  looked for:  ${file}`,
        "",
        "cast will not guess which keys the app owns: without the file, a break-glass",
        "apply would overwrite every one of them. Commit the file, or fix the path.",
      ].join("\n"),
    );
  // The schema refuses `..` and absolute paths; a symlink could still point
  // out of the checkout, at a file the repo does not version.
  const root = realpathSync(checkoutDir);
  const real = realpathSync(file);
  if (!real.startsWith(root + sep))
    throw new Error(
      `owned_keys file ${path} resolves outside the repo checkout (named by ${by}) — the owned keys must be a file the product repo versions, not a symlink out of it`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(real, "utf8"));
  } catch (err) {
    // Never the parser's message: Node quotes the text around the error, and
    // this file sits next to secrets often enough not to echo any of it.
    const at = /position (\d+)/.exec(
      err instanceof Error ? err.message : "",
    )?.[1];
    throw new Error(
      `owned_keys file ${path} is not valid JSON${at ? ` (at character ${at})` : ""} (named by ${by})`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(
      `owned_keys file ${path} must be a JSON object: one array of env var names per env template file name, "_"-prefixed arrays for every template, "_"-prefixed strings as comments`,
    );
  const templates = new Set(pointedBy.map((s) => s.template));
  const shared = new Map<string, string[]>();
  const byTemplate = new Map<string, string[]>();
  const names = (entry: string, v: unknown): string[] => {
    if (
      !Array.isArray(v) ||
      v.some((n) => typeof n !== "string" || !ENV_KEY.test(n))
    )
      throw new Error(
        `owned_keys file ${path}: "${entry}" must be an array of env var names`,
      );
    const seen = new Set<string>();
    for (const n of v as string[]) {
      if (seen.has(n))
        throw new Error(`owned_keys file ${path}: "${entry}" lists ${n} twice`);
      seen.add(n);
    }
    return v as string[];
  };
  for (const [entry, v] of Object.entries(raw as Record<string, unknown>)) {
    if (entry.startsWith("_")) {
      if (typeof v === "string") continue; // a comment
      shared.set(entry, names(entry, v));
      continue;
    }
    // An unknown entry is refused rather than ignored: a template renamed in
    // the manifest but not in the file would otherwise leave its keys
    // unguarded, silently. A manifest-level fact (template NAMES), so it needs
    // no other environment's template file.
    if (!templates.has(entry))
      throw new Error(
        [
          `owned_keys file ${path}: "${entry}" is not the env_template of any resource that points at this file`,
          "",
          `  pointing at it:  ${[...templates].sort().join(", ")}`,
          "",
          'An entry is an env template file name, or "_"-prefixed (an array for every',
          "template, a string for a comment). A stale or misspelt name guards nothing.",
        ].join("\n"),
      );
    byTemplate.set(entry, names(entry, v));
  }
  return { shared, byTemplate };
}

// Every owned_keys declaration `envName` makes, checked against the checkout;
// returns the owned keys of that environment's resources. See the header for
// what is checked beyond `envName`, and why.
export function resolveOwnedKeys(
  checkoutDir: string,
  manifest: Manifest,
  envName: string,
  // Where "this resource resolves to no owned keys" is said. A warning, not a
  // refusal: an empty list is a legitimate state (the product moved every key
  // back to the operator), just one worth seeing.
  warn: (msg: string) => void = (msg) => console.warn(msg),
): OwnedKeys {
  const all = sitesOf(manifest);
  const here = all.filter((s) => s.env === envName);
  if (here.length === 0) return {};
  const keysCache = new Map<string, Set<string>>();
  const keysOf = (s: Site, why?: string): Set<string> => {
    const cached = keysCache.get(s.template);
    if (cached) return cached;
    const file = join(checkoutDir, ".infra", "env", s.template);
    if (!existsSync(file))
      throw new Error(
        why
          ? `env template missing: ${file} (referenced by ${s.kind} ${s.name} in ${s.env}) — ${why}`
          : `env template missing: ${file} (referenced by ${s.name})`,
      );
    const keys = new Set(templateKeys(readFileSync(file, "utf8")));
    keysCache.set(s.template, keys);
    return keys;
  };
  // The files THIS environment points at, each with every resource in the
  // manifest pointing at it.
  const files = new Map<string, Site[]>();
  for (const s of here) if (!Array.isArray(s.decl)) files.set(s.decl.file, []);
  for (const s of all)
    if (!Array.isArray(s.decl) && files.has(s.decl.file))
      files.get(s.decl.file)?.push(s);
  const parsed = new Map<string, OwnedFile>();
  for (const [path, pointedBy] of files) {
    const f = readOwnedFile(checkoutDir, path, pointedBy);
    parsed.set(path, f);
    // A shared name mentioned by no template pointing at the file, in any
    // environment, is dead. The only reason another environment's template is
    // opened at all.
    for (const [entry, list] of f.shared) {
      const dead = list.filter(
        (n) =>
          !pointedBy.some((s) =>
            keysOf(
              s,
              `opened because "${entry}" in ${path} is a shared list, checked against every template pointing at the file in every environment`,
            ).has(n),
          ),
      );
      if (dead.length > 0)
        throw new Error(
          [
            `owned_keys file ${path}: "${entry}" names ${dead.join(", ")}, which no env template pointing at the file declares`,
            "",
            `  templates:  ${[...new Set(pointedBy.map((s) => s.template))].sort().join(", ")}`,
            ...DEAD_TAIL,
          ].join("\n"),
        );
    }
  }
  const out: OwnedKeys = {};
  for (const s of here) {
    const keys = keysOf(s);
    let owned: string[];
    let listed: string[];
    let from: string;
    if (Array.isArray(s.decl)) {
      listed = s.decl;
      owned = s.decl;
      from = "owned_keys";
    } else {
      const f = parsed.get(s.decl.file) as OwnedFile;
      listed = f.byTemplate.get(s.template) ?? [];
      from = `owned_keys file ${s.decl.file} ("${s.template}")`;
      const sharedHere = [...f.shared.values()]
        .flat()
        .filter((n) => keys.has(n));
      owned = [...new Set([...listed, ...sharedHere])];
    }
    // Per-template and inline names must each be a key THIS template declares.
    const dead = listed.filter((n) => !keys.has(n));
    if (dead.length > 0)
      throw new Error(
        [
          `${where(s)}: ${from} names ${dead.join(", ")}, which its env template ${s.template} does not declare`,
          "",
          `  declared:   ${listed.join(", ")}`,
          ...DEAD_TAIL,
        ].join("\n"),
      );
    if (owned.length === 0) {
      warn(
        `${where(s)}: owned_keys resolves to no keys for env template ${s.template} — cast manages every key of it as usual`,
      );
      continue;
    }
    out[ownedKey(s.kind, s.name)] = [...owned].sort();
  }
  return out;
}
