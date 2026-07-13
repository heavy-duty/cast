export type ResolvedEnv = {
  vars: Record<string, { value: string; secret: boolean }>;
};

// A template line, parsed but not resolved: `ref` is set when the whole RHS is
// a single ${NAME} placeholder.
export type TemplateVar = { key: string; rhs: string; ref?: string };

// ONE grammar, shared by both readers of a template — resolveTemplate (which
// needs the values) and templateRefs (which needs only the names). Keeping
// them on separate parsers would let the two drift, and a drift here is not
// cosmetic: `capture` would collect a different set of names than `apply` will
// later demand, which is precisely the "a name silently missed" failure the
// capture verb exists to remove.
function parseTemplate(text: string): TemplateVar[] {
  const vars: TemplateVar[] = [];
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
    vars.push({ key, rhs, ...(placeholder ? { ref: placeholder[1] } : {}) });
  }
  return vars;
}

export function resolveTemplate(
  text: string,
  secrets: Record<string, string>,
): ResolvedEnv {
  const vars: ResolvedEnv["vars"] = {};
  for (const { key, rhs, ref } of parseTemplate(text)) {
    if (ref === undefined) {
      vars[key] = { value: rhs, secret: false };
      continue;
    }
    const value = secrets[ref];
    if (value === undefined) {
      throw new Error(`secret ${ref} (for ${key}) missing from the age store`);
    }
    vars[key] = { value, secret: true };
  }
  return { vars };
}

// The ${NAME} refs a template declares: the secret names the manifest requires,
// paired with the env var each one lands on. `capture` reads these to learn
// what to go and fetch — at capture time there is no store to resolve against
// yet, which is the whole point of the verb.
export function templateRefs(
  text: string,
): Array<{ key: string; ref: string }> {
  return parseTemplate(text).flatMap(({ key, ref }) =>
    ref === undefined ? [] : [{ key, ref }],
  );
}

// Every env var key a template declares — refs and literals alike. `capture`
// only cares about the ${...} refs (the secrets); `inventory` needs all of them,
// because the question it answers is "what does the manifest put on this
// resource, and what does the box actually have?", and a literal the manifest
// sets (a feature flag, NODE_ENV) is just as much a difference as a secret.
//
// Same parser as everything else in this file — see parseTemplate.
export function templateKeys(text: string): string[] {
  return parseTemplate(text).map(({ key }) => key);
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
