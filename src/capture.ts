import type { RequiredSecret } from "./resolve.js";

// What the manifest writes for a provider-generated name. Not the source box's
// value — that points at the SOURCE box's Postgres/Redis — and not an empty
// string, which would boot the app misconfigured. A literal that is obviously
// a placeholder, and that Coolify replaces when it creates the resource.
export const GENERATED_PLACEHOLDER = "pending-coolify-generated";

// Live env vars, per resource: resource name -> (env key -> value).
export type LiveEnvs = Record<string, Record<string, string>>;

export type Provenance = "captured" | "generated" | "overridden";

export type Site = { resource: string; key: string };

export type Disposition = {
  ref: string;
  provenance: Provenance;
  // Never rendered. Kept here so the caller can encrypt it, and nowhere else.
  value: string;
  sites: Site[];
};

export type Classification = {
  plan: Disposition[];
  // Required by a template, absent from the source, and not dispositioned
  // otherwise. Refuses the run: writing an empty value substitutes to nothing
  // and the app boots misconfigured — the exact failure capture exists to
  // remove, and one that looks entirely plausible from the outside.
  missing: Array<{ ref: string; sites: Site[] }>;
  // The same ref carrying DIFFERENT live values on two resources. cast cannot
  // pick, and picking wrong is silent, so it refuses.
  conflicts: Array<{ ref: string; values: Site[] }>;
};

function groupByRef(required: RequiredSecret[]): Map<string, Site[]> {
  const byRef = new Map<string, Site[]>();
  for (const { ref, resource, key } of required) {
    const sites = byRef.get(ref) ?? [];
    sites.push({ resource, key });
    byRef.set(ref, sites);
  }
  return byRef;
}

// Force disposition, never guess. Every name the manifest requires lands in
// exactly one of four buckets, and two of them stop the run.
//
// The mapping is deliberately NOT a mechanical dump of the source box: some
// entries encode migration decisions rather than facts about the source. A
// "capture everything" verb would be wrong in a handful of entries out of
// seventeen, silently — which is worse than being wrong in all of them.
export function classify(
  required: RequiredSecret[],
  generated: string[],
  live: LiveEnvs,
  overrides: Record<string, string>,
): Classification {
  const generatedSet = new Set(generated);
  const plan: Disposition[] = [];
  const missing: Classification["missing"] = [];
  const conflicts: Classification["conflicts"] = [];

  for (const [ref, sites] of groupByRef(required)) {
    // The operator's word beats both the manifest and the source box: this is
    // the escape hatch for a value that must NOT be carried over (staging's
    // ADMIN_EMAIL, where the source's value is a real founder and staging
    // shares a Mailgun domain with prod).
    if (ref in overrides) {
      plan.push({
        ref,
        provenance: "overridden",
        value: overrides[ref],
        sites,
      });
      continue;
    }
    if (generatedSet.has(ref)) {
      plan.push({
        ref,
        provenance: "generated",
        value: GENERATED_PLACEHOLDER,
        sites,
      });
      continue;
    }
    // Captured: read the live value off whichever resources declare it.
    const found = sites
      .map((s) => ({ site: s, value: live[s.resource]?.[s.key] }))
      .filter((f): f is { site: Site; value: string } => f.value !== undefined);
    if (found.length === 0) {
      missing.push({ ref, sites });
      continue;
    }
    const distinct = new Set(found.map((f) => f.value));
    if (distinct.size > 1) {
      conflicts.push({ ref, values: found.map((f) => f.site) });
      continue;
    }
    plan.push({
      ref,
      provenance: "captured",
      value: found[0].value,
      sites,
    });
  }
  return { plan, missing, conflicts };
}

const site = (s: Site) => `${s.resource}.${s.key}`;

// Names and provenance. NEVER values.
//
// The one thing printed that looks like a value is GENERATED_PLACEHOLDER,
// which is a literal constant in this file and carries no information about
// the source box. Everything else is a name the manifest already declares in
// plaintext, in a committed file.
export function renderCapturePlan(
  c: Classification,
  ctx: {
    orgRepo: string;
    env: string;
    instance: string;
    store: string;
    recipient: string;
  },
): string {
  const lines = [
    `capture plan — ${ctx.orgRepo} ${ctx.env}`,
    "",
    `  source:     instance ${ctx.instance} (live values read from it)`,
    `  store:      ${ctx.store}`,
    `  recipient:  ${ctx.recipient}`,
    "",
  ];
  const width = Math.max(
    0,
    ...[...c.plan, ...c.missing, ...c.conflicts].map((d) => d.ref.length),
  );
  for (const d of c.plan) {
    const where = d.sites.map(site).join(", ");
    const note =
      d.provenance === "generated"
        ? `  → ${GENERATED_PLACEHOLDER}`
        : d.provenance === "overridden"
          ? `  (from CAST_CAPTURE_${d.ref})`
          : "";
    lines.push(
      `  ${d.ref.padEnd(width)}  ${d.provenance.padEnd(10)}  ${where}${note}`,
    );
  }
  for (const m of c.missing) {
    lines.push(
      `  ${m.ref.padEnd(width)}  MISSING     required by ${m.sites.map(site).join(", ")}, absent from the source`,
    );
  }
  for (const c2 of c.conflicts) {
    lines.push(
      `  ${c2.ref.padEnd(width)}  CONFLICT    differs between ${c2.values.map(site).join(" and ")}`,
    );
  }
  const counts = (["captured", "generated", "overridden"] as const)
    .map((p) => [p, c.plan.filter((d) => d.provenance === p).length] as const)
    .filter(([, n]) => n > 0)
    .map(([p, n]) => `${n} ${p}`)
    .join(", ");
  lines.push(
    "",
    `${c.plan.length} name(s) to write${counts ? `: ${counts}` : ""}`,
  );
  if (c.missing.length > 0) {
    lines.push(
      "",
      `refusing to write the store: ${c.missing.length} name(s) the manifest requires are not`,
      "present on the source. An empty value substitutes to nothing and the app boots",
      "misconfigured — plausibly, and silently. Supply each one with --override <NAME>",
      "(its value is read from CAST_CAPTURE_<NAME>, never from argv), or fix the source.",
    );
  }
  if (c.conflicts.length > 0) {
    lines.push(
      "",
      `refusing to write the store: ${c.conflicts.length} name(s) carry different values on`,
      "different resources of the source. The store holds one value per name, and cast",
      "will not pick for you. Reconcile them on the source, or pin one with --override.",
    );
  }
  return lines.join("\n");
}
