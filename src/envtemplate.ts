// A ${resource:<name>.url} reference — the internal URL of a database THIS
// manifest declares, read back from the resource Coolify created. It is not a
// secret: a secret is something a human authored and the age store holds, while
// this is a FACT about a resource cast itself made, readable from the API that
// made it, at any time, for free (#60). So it never enters the store, never
// enters a terminal, and needs no age key to read back — it is resolved from the
// live box, not decrypted.
export type ResourceRef = { resource: string; attr: string };

// The value a derived var carries until it is resolved against the live
// resource. NEVER a legal thing to WRITE — the executor refuses it, the same
// fail-closed shape as the generated-secret placeholder — because a database URL
// that resolved to nothing boots every consumer pointed at nothing (the exact
// trap fetchGeneratedSources guards with its `never a fill of ""` rule).
//
// Collision-safe by construction, not by exotic bytes: this string only ever
// occupies a `derived` var's value, and such a value is only ever this sentinel
// or a real `postgres://…`/`redis://…` URL that fillDerivedEnv put there — so it
// cannot be mistaken for a resolved value, and `unresolvedDerived` gates on the
// `derived` flag anyway. (A plain string, no NUL byte: a NUL makes git treat the
// whole source file as binary and its diff unreviewable.)
export const DERIVED_UNRESOLVED = "cast:unresolved-derived-resource-url";

// `secret` is true for both a ${SECRET} and a resolved ${resource:…} — both are
// values that must never be printed. `derived` is set (and stays set after
// resolution) so the diff can say "derived from database X" rather than mistaking
// a routine URL change for a secret rotation, and so the executor knows which
// vars to resolve from the live resource before it writes.
export type ResolvedEnv = {
  vars: Record<
    string,
    { value: string; secret: boolean; derived?: ResourceRef }
  >;
};

// A template line, parsed but not resolved: `ref` is set when the whole RHS is a
// single ${NAME} placeholder (a store secret); `resourceRef` when it is a single
// ${resource:<name>.attr} placeholder (a derived value). The two are mutually
// exclusive — a secret name is UPPER_SNAKE, a resource ref starts `resource:`.
export type TemplateVar = {
  key: string;
  rhs: string;
  ref?: string;
  resourceRef?: ResourceRef;
};

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
    // A resource ref names a Coolify resource (lower-kebab/snake, as the manifest
    // and Coolify spell it) and one dotted attribute. Only `.url` is derivable
    // today; an unknown attr is not rejected HERE — parsing stays dumb — but at
    // validation time (resolve.ts), where the message can name the declared
    // resources, exactly as an undeclared-resource ref is.
    const resource = rhs.match(
      /^\$\{resource:([a-z0-9][a-z0-9_-]*)\.([a-z_]+)\}$/,
    );
    vars.push({
      key,
      rhs,
      ...(placeholder ? { ref: placeholder[1] } : {}),
      ...(resource
        ? { resourceRef: { resource: resource[1], attr: resource[2] } }
        : {}),
    });
  }
  return vars;
}

export function resolveTemplate(
  text: string,
  secrets: Record<string, string>,
): ResolvedEnv {
  const vars: ResolvedEnv["vars"] = {};
  for (const { key, rhs, ref, resourceRef } of parseTemplate(text)) {
    // A derived value is resolved from the live resource, not the store, and not
    // here — the resource may not exist yet (a from-nothing apply creates it in
    // the same run). So it lands UNRESOLVED, carrying the ref; fillDerivedEnv
    // fills it once a URL map is known, and the executor refuses to write one
    // that never resolved. This is BEFORE the ref/store branch on purpose: a
    // resource ref's RHS is not UPPER_SNAKE, so it would otherwise be mistaken
    // for a literal and written through as the text "${resource:…}".
    if (resourceRef) {
      vars[key] = {
        value: DERIVED_UNRESOLVED,
        secret: true,
        derived: resourceRef,
      };
      continue;
    }
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

// Resolve every derived var whose resource now has a known URL, leaving the rest
// unresolved (a from-nothing apply has no live URL to resolve against until the
// database is created — the executor fills those, post-create). Pure, and the
// single place a derived value is turned into a real one, so the diff-time fill
// (against pre-existing live) and the apply-time fill (against a just-created
// resource) can never resolve the same ref two different ways.
//
// `urls` is keyed by the resource's MANIFEST name — the same name the ref
// carries. The caller keys it that way (see fillDesiredDerived / the executor):
// aliasing has already renamed live resources to the manifest's vocabulary by
// the time a URL map is built.
export function fillDerivedEnv(
  env: ResolvedEnv,
  urls: Record<string, string>,
): ResolvedEnv {
  const vars: ResolvedEnv["vars"] = {};
  for (const [key, v] of Object.entries(env.vars)) {
    const url =
      v.derived && v.derived.attr === "url"
        ? urls[v.derived.resource]
        : undefined;
    vars[key] =
      url !== undefined && url !== ""
        ? { value: url, secret: true, derived: v.derived }
        : v;
  }
  return { vars };
}

// The derived vars still holding the unresolved sentinel — what the executor
// must resolve from the live box before it can write this env, and what it
// refuses on if it cannot. Names the env key and the resource it derives from;
// never a value (there is none yet, and there never will be one to print).
export function unresolvedDerived(
  env: ResolvedEnv,
): Array<{ key: string; resource: string }> {
  return Object.entries(env.vars).flatMap(([key, v]) =>
    v.derived && v.value === DERIVED_UNRESOLVED
      ? [{ key, resource: v.derived.resource }]
      : [],
  );
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

// The ${resource:<name>.attr} refs a template declares — the derived edges. NOT
// returned by templateRefs above, and that separation is the point: a derived
// value is not a secret to be captured, so `capture` must never go looking for a
// store name called `resource:postgres.url`. resolve.ts reads these to validate
// each edge against the databases the manifest actually declares.
export function templateResourceRefs(
  text: string,
): Array<{ key: string; resource: string; attr: string }> {
  return parseTemplate(text).flatMap(({ key, resourceRef }) =>
    resourceRef === undefined
      ? []
      : [{ key, resource: resourceRef.resource, attr: resourceRef.attr }],
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
