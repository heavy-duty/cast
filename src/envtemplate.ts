export type ResolvedEnv = {
  vars: Record<string, { value: string; secret: boolean }>;
};

export function resolveTemplate(
  text: string,
  secrets: Record<string, string>,
): ResolvedEnv {
  const vars: ResolvedEnv["vars"] = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m)
      throw new Error(
        `env template line ${i + 1}: expected KEY=value, got "${line}"`,
      );
    const [, key, rhs] = m;
    const placeholder = rhs.match(/^\$\{([A-Z][A-Z0-9_]*)\}$/);
    if (placeholder) {
      const value = secrets[placeholder[1]];
      if (value === undefined) {
        throw new Error(
          `secret ${placeholder[1]} (for ${key}) missing from the age store`,
        );
      }
      vars[key] = { value, secret: true };
    } else {
      vars[key] = { value: rhs, secret: false };
    }
  }
  return { vars };
}

// An environment may forbid variables by name pattern, declared as
// `environments.<env>.forbidden_var_patterns` in the state repo. The rule is
// PRESENCE, not value: a forbidden var set to "false" still refuses the apply,
// because a var that exists can be flipped on later in the Coolify UI without
// touching a manifest — "off" has to mean absent.
//
// The policy lives in the operator's private state, never in a product's
// manifest: a product-side change must not be able to lower its own guard.
export function assertEnvVarPolicy(
  envName: string,
  resolved: Record<string, ResolvedEnv>,
  forbiddenPatterns: string[] | undefined,
): void {
  if (!forbiddenPatterns?.length) return;
  const patterns = forbiddenPatterns.map((p) => ({
    src: p,
    re: new RegExp(p),
  }));
  for (const [resource, env] of Object.entries(resolved)) {
    for (const key of Object.keys(env.vars)) {
      const hit = patterns.find((p) => p.re.test(key));
      if (hit) {
        throw new Error(
          `refusing ${envName} apply: ${key} is present on ${resource} regardless of value — forbidden by forbidden_var_patterns /${hit.src}/ ("off" means absent, not false)`,
        );
      }
    }
  }
}
