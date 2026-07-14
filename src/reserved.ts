// Names whose meaning belongs to the PLATFORM, and which cast therefore never
// writes, never copies, and never lets a manifest declare.
//
// Coolify injects a set of values into an application's runtime environment
// itself — `SOURCE_COMMIT`, and the `COOLIFY_*` family (`COOLIFY_URL`,
// `COOLIFY_FQDN`, `COOLIFY_BRANCH`, `COOLIFY_RESOURCE_UUID`,
// `COOLIFY_CONTAINER_NAME`). It does so behind one guard, and that guard is the
// entire reason this file exists — app/Jobs/ApplicationDeploymentJob.php
// (coollabsio/coolify v4.1.2), in generate_coolify_env_variables:
//
//     if ($this->application->environment_variables->where('key', 'SOURCE_COMMIT')->isEmpty()) {
//         if (! is_null($this->commit)) {
//             $coolify_envs->put('SOURCE_COMMIT', $this->commit);
//         } else {
//             $coolify_envs->put('SOURCE_COMMIT', 'unknown');
//         }
//     }
//
// (v4.1.2, lines 2994-3001; the same `->isEmpty()` shape guards each COOLIFY_*
// name at 3002-3028, and again on the preview branch at 2950-2984.)
//
// Coolify SKIPS its own injection of a name when the application already carries
// an env var of that name. So an application-level `SOURCE_COMMIT` does not
// merely fail to help — it **suppresses** the value Coolify would otherwise have
// provided. An EMPTY one suppresses it exactly as completely: presence is the
// whole test, `isEmpty()` being asked of the collection of vars, never of the
// value.
//
// And it fails GREEN. The deploy succeeds, the health check passes, the
// container runs — and the only symptom is that `/version`, which reads
// `process.env.SOURCE_COMMIT` at request time, reports `unknown`. That is the
// endpoint a production cutover is gated on. (D-266.)
//
// WHY THIS IS IN CAST'S CODE AND NOT IN THE STATE FILE. `forbidden_var_patterns`
// (envtemplate.ts) is the neighbouring rule and looks like the obvious home for
// this one. It is not. That rule is POLICY — an environment's own choice about
// its own vars, which prod may set harder than staging, and which therefore
// lives in the operator's private state precisely so a product-side change
// cannot lower its own guard. This rule is a FACT ABOUT COOLIFY: true on every
// box, in every environment, for every project. There is no environment in which
// declaring `SOURCE_COMMIT` is correct, so there must be no file in which it can
// be permitted.
//
// Not to be confused with cast's OWN config vars — `COOLIFY_BASE_URL`,
// `COOLIFY_ACCESS_TOKEN`, `COOLIFY_READ_ONLY` (config.ts). Those are read out of
// the operator's local instance file and are never written to a resource. The
// namespace collides; the meaning does not. Nothing here applies to them.

// Exactly the two shapes, and no more. Widening this set is not free: every name
// added here is a name cast will REFUSE to carry, so a wrong entry breaks a
// manifest that was right. Add one only with the guard in Coolify's source that
// justifies it.
export const RESERVED_EXACT: readonly string[] = ["SOURCE_COMMIT"];
export const RESERVED_PREFIX = /^COOLIFY_/;

export function isReservedEnvName(key: string): boolean {
  return RESERVED_EXACT.includes(key) || RESERVED_PREFIX.test(key);
}

// One sentence, wherever a reserved name has to be reported rather than refused
// (`diff` on a live box, `inventory --emit-draft`'s UNCAPTURED.md). Whatever the
// verb, the consequence is the same sentence — a reader who has met it once in a
// diff recognizes it in a draft.
export function reservedConsequence(key: string): string {
  return `${key} is injected by Coolify itself at runtime, and Coolify SKIPS its own injection when the resource already carries a var of that name (ApplicationDeploymentJob.php, v4.1.2). A var of this name — even an EMPTY one — SUPPRESSES the platform's value. The deploy stays green and /version reports "unknown".`;
}

export type ReservedHit = { resource: string; key: string };

export function reservedHits(
  resource: string,
  keys: Iterable<string>,
): ReservedHit[] {
  const hits: ReservedHit[] = [];
  for (const key of keys) {
    if (isReservedEnvName(key)) hits.push({ resource, key });
  }
  return hits;
}

export function renderReservedRefusal(hits: ReservedHit[]): string {
  const width = Math.max(...hits.map((h) => h.resource.length));
  return [
    `refusing this manifest: ${hits.length} env var(s) declare a name Coolify injects itself`,
    "",
    ...hits.map((h) => `  ${h.resource.padEnd(width)}  ${h.key}`),
    "",
    "Coolify injects SOURCE_COMMIT and the COOLIFY_* family into an application's",
    "runtime environment itself — and it SKIPS its own injection of a name the",
    "resource already carries a var of (ApplicationDeploymentJob.php, v4.1.2). A",
    "declared var of that name therefore does not merely fail to help: it SUPPRESSES",
    "the value Coolify would otherwise have provided.",
    "",
    "Presence, not value. An empty one suppresses it exactly as completely — the same",
    'rule forbidden_var_patterns already holds to, for the same reason: "off" means',
    "absent, not empty.",
    "",
    "And it fails GREEN. The deploy succeeds, the health check passes, and the only",
    'symptom is /version reporting "unknown" — the endpoint a production cutover is',
    "gated on.",
    "",
    "Delete the line from the env template. There is nothing to replace it with:",
    "Coolify sets the value at runtime, on every deploy, from no declaration at all.",
  ].join("\n");
}

// Every manifest read passes through here (resolve.ts), so a reserved name fails
// the run BEFORE any write — never at the wire, and never half-applied.
export function assertNoReservedEnvNames(hits: ReservedHit[]): void {
  if (hits.length === 0) return;
  throw new Error(renderReservedRefusal(hits));
}
