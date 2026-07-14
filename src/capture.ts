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

// The manifest resources that no resource of that name exists for on the source.
//
// This is the absent-target lie (#12/D-237) one level deeper in the tree, and it
// fails in exactly the same way: a resource that is ABSENT reads back
// identically to one that is PRESENT with no env vars set. Every name it
// declares reports MISSING, the run refuses, and the message tells the operator
// to supply each of them with --override — which would "work", writing a
// perfectly valid store, while the real finding (the manifest and the box
// disagree about what this resource is called) is never discovered and the
// operator hand-carries values that were sitting right there under another name.
//
// So: refuse on the RESOURCE first, and only report per-name MISSING for
// resources that were actually found — where it means what it says.
export function absentResources(
  required: RequiredSecret[],
  liveNames: Iterable<string>,
): string[] {
  const live = new Set(liveNames);
  const declared = new Set(required.map((r) => r.resource));
  return [...declared].filter((name) => !live.has(name)).sort();
}

export function renderAbsentResources(
  absent: string[],
  live: Array<{ kind: string; name: string }>,
  ctx: { project: string; environment: string },
): string {
  const width = Math.max(0, ...live.map((l) => l.kind.length));
  return [
    `refusing to capture: the manifest declares ${absent.length} resource(s) that do not exist here`,
    "",
    `  looked in:   project "${ctx.project}", environment "${ctx.environment}"`,
    `  looked for:  ${absent.join(", ")}`,
    "  exists here:",
    ...(live.length > 0
      ? live.map((l) => `    ${l.kind.padEnd(width)}  ${l.name}`)
      : ["    (nothing at all)"]),
    "",
    "A resource that is absent reads back exactly like one with no env vars set:",
    "every name it declares reports MISSING, and --override would then have you",
    "hand-carry values that are sitting right there under a different name. The",
    "finding is not that the secrets are missing — it is that the manifest and this",
    "box disagree about what these resources are called.",
    "",
    "`cast inventory` shows both sides. Then map them at the call site:",
    "",
    ...absent.map(
      (name) => `    --resource ${name}="<what this box calls it>"`,
    ),
  ].join("\n");
}

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

// ---------------------------------------------------------------------------
// Pass 2 — `capture --generated-only`
//
// Bootstrapping an environment that declares generated_secrets is two-pass BY
// CONSTRUCTION, and the two passes are not variations of one verb:
//
//   pass 1  `capture`                 the store learns every name; the generated
//                                     ones are placeheld, because their values do
//                                     not exist yet — nothing has created them.
//   (apply)                           Coolify creates the database and generates
//                                     the real URL.
//   pass 2  `capture --generated-only` the store learns THAT value.
//
// Between the two, the store's value for a generated name is a placeholder while
// the live value is real. Everything below exists to close that window without
// the operator hand-editing decrypted plaintext (which is how it was closed
// before: decrypt, edit two lines, re-encrypt, against prod, holding the key).
//
// The flag INVERTS classify()'s disposition rule and nothing else: the names in
// generated_secrets are the ones it fills, and every other name is left exactly
// as the store has it — byte for byte, never re-read from the box. A generated
// name is the only kind of name whose true value cast can find AFTER the fact,
// because it is the only kind the provider owns.
// ---------------------------------------------------------------------------

// A live database inside the project + environment being filled — the resource
// that OWNS a generated URL.
//
// `url` is `internal_db_url`, and it is read from the DATABASE, never from a
// consuming application's env. It never appears there: the app's env holds
// whatever the template resolved to, which at this point in the bootstrap is
// the placeholder itself. Reading the app back would faithfully capture the
// lie we are here to correct.
export type GeneratedSource = {
  resource: string;
  type: string;
  url: string;
};

// One generated name, filled from the resource that owns it.
export type Fill = {
  ref: string;
  from: { resource: string; type: string };
  // Never rendered. Kept here so the caller can encrypt it, and nowhere else —
  // same contract as Disposition.value.
  value: string;
};

export type GeneratedPlan = {
  fills: Fill[];
  // Names the store keeps, byte for byte. Printed as names so the operator can
  // see the store is not being rewritten around them.
  kept: string[];
  // A generated name cast cannot attribute to exactly one database. Refuses:
  // picking would be silent, and picking WRONG writes another box's credentials
  // into this environment's store.
  unmapped: Array<{ ref: string; why: string }>;
  // A generated name whose store value is NOT the placeholder. Refuses without
  // --force: it is already filled (someone ran pass 2, or set it by hand), and
  // overwriting it is a silent rotation of a live credential.
  occupied: string[];
  // A generated name the store does not carry AT ALL. Refuses: pass 2 fills
  // names, it does not invent them. A store missing one did not come from pass
  // 1, and the name-count postcondition below could not hold anyway.
  absent: string[];
  // A store value that is still the placeholder and is NOT in the fill set —
  // so this run would leave the store still lying. Refuses. This is the
  // postcondition, checked BEFORE the write so it reads as a plan and not as an
  // assertion failure over ciphertext already on disk.
  stillPending: string[];
};

// Which database does a generated name come from?
//
// The manifest cannot say. `generated_secrets:` is a flat list of NAMES, and
// there is no edge anywhere in the data model from DATABASE_URL to the database
// that owns it — not in the manifest, not in the env template (which knows only
// `DATABASE_URL=${DATABASE_URL}`), and not on the box.
//
// So cast does not guess. It infers ONLY when the inference cannot be wrong —
// one generated name, one database, no other candidate — and otherwise refuses
// and makes the operator state the edge with --from. The temptation is to read
// the type out of the NAME (REDIS_URL → the redis one), and that is precisely
// the bug this verb must not have: a name-directed pick across a list of
// databases is #29 wearing a different hat, and it is wrong SILENTLY. The
// value it would write is a perfectly well-formed URL to somebody else's
// database.
export function resolveGeneratedSources(
  generated: string[],
  databases: GeneratedSource[],
  from: Record<string, string>,
): {
  mapping: Record<string, GeneratedSource>;
  unmapped: Array<{ ref: string; why: string }>;
} {
  const mapping: Record<string, GeneratedSource> = {};
  const unmapped: Array<{ ref: string; why: string }> = [];
  const byName = new Map(databases.map((d) => [d.resource, d]));
  for (const ref of generated) {
    const named = from[ref];
    if (named !== undefined) {
      const hit = byName.get(named);
      if (!hit) {
        unmapped.push({
          ref,
          why: `--from ${ref}=${named}, but no database named "${named}" exists in this project+environment`,
        });
        continue;
      }
      mapping[ref] = hit;
      continue;
    }
    if (databases.length === 0) {
      unmapped.push({
        ref,
        why: "no database exists in this project+environment to fill it from",
      });
      continue;
    }
    // The only inference that cannot be wrong: nothing else it could be.
    if (generated.length === 1 && databases.length === 1) {
      mapping[ref] = databases[0];
      continue;
    }
    unmapped.push({
      ref,
      why: `${databases.length} databases here (${databases.map((d) => `${d.resource}:${d.type}`).join(", ")}) — cast will not pick by name`,
    });
  }
  return { mapping, unmapped };
}

// Invert the disposition rule. `store` is the DECRYPTED current store; every
// name in it that is not being filled comes out the other side untouched.
export function planGenerated(
  generated: string[],
  store: Record<string, string>,
  sources: Record<string, GeneratedSource>,
  unmapped: Array<{ ref: string; why: string }>,
  opts: { force: boolean } = { force: false },
): GeneratedPlan {
  const generatedSet = new Set(generated);
  const fills: Fill[] = [];
  const occupied: string[] = [];
  const absent: string[] = [];
  for (const ref of generated) {
    if (!(ref in store)) {
      absent.push(ref);
      continue;
    }
    const source = sources[ref];
    // Already reported by resolveGeneratedSources; not also an "occupied".
    if (!source) continue;
    if (store[ref] !== GENERATED_PLACEHOLDER && !opts.force) {
      occupied.push(ref);
      continue;
    }
    fills.push({
      ref,
      from: { resource: source.resource, type: source.type },
      value: source.url,
    });
  }
  const filling = new Set(fills.map((f) => f.ref));
  // A placeholder left standing in a name nobody is filling. The run would
  // "succeed" and the store would still be a lie — so it refuses instead, and
  // names the flag that fixes it. Generated names that failed to map or were
  // refused as occupied are NOT reported here: they already have their own row,
  // and one problem should be named once.
  const stillPending = Object.keys(store)
    .filter(
      (k) =>
        store[k] === GENERATED_PLACEHOLDER &&
        !filling.has(k) &&
        !generatedSet.has(k),
    )
    .sort();
  // Everything the store keeps byte for byte. A name carrying a refusal above
  // is not "kept" — it is the reason the run stops, and printing it in both
  // rows would read as though cast had a plan for it.
  const flagged = new Set([
    ...unmapped.map((u) => u.ref),
    ...occupied,
    ...stillPending,
  ]);
  const kept = Object.keys(store)
    .filter((k) => !filling.has(k) && !flagged.has(k))
    .sort();
  return { fills, kept, unmapped, occupied, absent, stillPending };
}

export function generatedPlanRefuses(p: GeneratedPlan): boolean {
  return (
    p.unmapped.length > 0 ||
    p.occupied.length > 0 ||
    p.absent.length > 0 ||
    p.stillPending.length > 0
  );
}

// Names, provenance and the resource a value came FROM. Never values.
//
// capture.ts's rule holds unchanged: the only value-shaped thing printed is
// GENERATED_PLACEHOLDER, a literal constant in this file — and here it is
// printed as the thing being REPLACED, which is the one fact about the store's
// current contents an operator needs in order to believe the plan.
export function renderGeneratedPlan(
  p: GeneratedPlan,
  ctx: {
    orgRepo: string;
    env: string;
    instance: string;
    store: string;
    recipient: string;
    project: string;
    environment: string;
  },
): string {
  const lines = [
    `capture --generated-only — ${ctx.orgRepo} ${ctx.env}`,
    "",
    `  source:     instance ${ctx.instance}, project "${ctx.project}", environment "${ctx.environment}"`,
    `  store:      ${ctx.store}`,
    `  recipient:  ${ctx.recipient}`,
    "",
  ];
  const width = Math.max(
    0,
    ...[
      ...p.fills.map((f) => f.ref),
      ...p.kept,
      ...p.occupied,
      ...p.absent,
      ...p.unmapped.map((u) => u.ref),
    ].map((r) => r.length),
  );
  for (const f of p.fills) {
    lines.push(
      `  ${f.ref.padEnd(width)}  fill        ${GENERATED_PLACEHOLDER} → ${f.from.resource} (${f.from.type}) internal_db_url`,
    );
  }
  for (const k of p.kept) {
    lines.push(`  ${k.padEnd(width)}  keep        unchanged in the store`);
  }
  for (const u of p.unmapped) {
    lines.push(`  ${u.ref.padEnd(width)}  UNMAPPED    ${u.why}`);
  }
  for (const o of p.occupied) {
    lines.push(
      `  ${o.padEnd(width)}  OCCUPIED    already holds a value that is not ${GENERATED_PLACEHOLDER}`,
    );
  }
  for (const a of p.absent) {
    lines.push(`  ${a.padEnd(width)}  ABSENT      not in the store at all`);
  }
  for (const s of p.stillPending) {
    lines.push(
      `  ${s.padEnd(width)}  PENDING     still ${GENERATED_PLACEHOLDER}, and nothing here fills it`,
    );
  }
  lines.push(
    "",
    `${p.fills.length} name(s) to fill, ${p.kept.length} left exactly as the store has them`,
  );
  if (p.unmapped.length > 0) {
    lines.push(
      "",
      `refusing to write the store: ${p.unmapped.length} generated name(s) cannot be attributed`,
      "to exactly one database in this project+environment. Nothing in the manifest, the env",
      "template or the box says which database a given name comes from, and cast will not",
      "pick by name — a wrong pick writes another database's credentials into this store,",
      "and it does it silently. State the edge:",
      "",
      ...p.unmapped.map((u) => `    --from ${u.ref}=<database name>`),
    );
  }
  if (p.occupied.length > 0) {
    lines.push(
      "",
      `refusing to write the store: ${p.occupied.length} generated name(s) already hold a real`,
      "value. Filling them would rotate a live credential — silently, and against whatever is",
      "already running on that value. If Coolify's resource really was recreated and the store",
      "is stale, say so with --force.",
    );
  }
  if (p.absent.length > 0) {
    lines.push(
      "",
      `refusing to write the store: ${p.absent.length} generated name(s) are not in the store at`,
      "all. --generated-only FILLS names, it does not add them: the store it fills is the one",
      "pass 1 wrote, and the name set must come out of this run exactly as it went in. Run",
      "`cast capture` first, or check you are pointed at the right store.",
    );
  }
  if (p.stillPending.length > 0) {
    lines.push(
      "",
      `refusing to write the store: ${p.stillPending.length} name(s) would still hold the`,
      `${GENERATED_PLACEHOLDER} literal after this run — the store would still be a lie, and`,
      "the next apply would push that literal at a live app. If these are generated too,",
      "declare them (manifest `generated_secrets:`, or --generated <NAME>).",
    );
  }
  return lines.join("\n");
}

// The postcondition this verb EXISTS for, asserted against the store that was
// actually written — decrypted back off disk, not against the map cast held in
// memory a moment ago. In the hand-run procedure this was a line in a runbook
// ("assert 14 names / zero placeholders"), which is to say it was a step that
// could be, and eventually would be, skipped.
//
// Two claims, and they fail in opposite directions:
//   - zero placeholders remain      → the store no longer lies about any name
//   - the name count is unchanged   → and it did not lose one on the way
//
// A store that lost a name re-encrypts perfectly and reads back perfectly; the
// failure surfaces at the next apply, as a missing secret, in an environment
// whose plaintext nobody has any more.
export function assertGeneratedComplete(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const violations: string[] = [];
  const pending = Object.keys(after)
    .filter((k) => after[k] === GENERATED_PLACEHOLDER)
    .sort();
  if (pending.length > 0) {
    violations.push(
      `${pending.length} name(s) still hold the ${GENERATED_PLACEHOLDER} literal: ${pending.join(", ")}`,
    );
  }
  const beforeNames = Object.keys(before).sort();
  const afterNames = Object.keys(after).sort();
  if (beforeNames.length !== afterNames.length) {
    violations.push(
      `the store went in with ${beforeNames.length} name(s) and came out with ${afterNames.length}`,
    );
  }
  const lost = beforeNames.filter((n) => !(n in after));
  const gained = afterNames.filter((n) => !(n in before));
  if (lost.length > 0) violations.push(`names LOST: ${lost.join(", ")}`);
  if (gained.length > 0) violations.push(`names ADDED: ${gained.join(", ")}`);
  return violations;
}
