import type { ManifestResource } from "./resolve.js";

// `inventory` answers the question every other verb assumes you already
// answered: **what is actually on this box?**
//
// cast can describe a Coolify it built (`diff`), change one (`apply`), and take
// secret values off one for names a manifest already declares (`capture`). None
// of those can tell you what is on a box you did NOT build — and that is the
// first thing anyone needs when adopting an existing deployment. Without it,
// every mismatch surfaces later, one at a time, as a refusal from a verb that is
// already committed to a course of action; and the tempting fix for a refusal is
// to bend the manifest toward the legacy box, which is exactly backwards.
//
// The output is a DOCUMENT, read by a person. It is deliberately not desired
// state, not a store, and not consumed by `apply`:
//
//   inventory → human reads → manifest PR → capture → apply
//
// That boundary is what keeps `capture` safe to be strict about. `inventory` may
// read everything, because a person reads its output. `capture` may only ever
// write what the manifest declares, because `apply` reads its output. Same box,
// two consumers, two contracts.

export type LiveResource = {
  kind: string;
  name: string;
  envKeys: string[];
};

export type Matched = {
  kind: string;
  name: string;
  // Declared by the manifest, absent from the box.
  manifestOnlyKeys: string[];
  // On the box, and the manifest knows nothing about it. Either something the
  // manifest must gain, or cruft that must not travel — and only a human can
  // say which. That judgment is the whole reason this verb exists.
  boxOnlyKeys: string[];
  sharedKeys: string[];
};

export type Reconciliation = {
  matched: Matched[];
  manifestOnly: ManifestResource[];
  boxOnly: LiveResource[];
};

const sorted = (xs: Iterable<string>) => [...xs].sort();

export function reconcile(
  manifest: ManifestResource[],
  live: LiveResource[],
): Reconciliation {
  // Matched by NAME, not by kind: a manifest `application` that the box models
  // as a `service` is a real and interesting finding, and collapsing it into
  // "manifest-only + box-only" would hide the fact that they are the same thing.
  const liveByName = new Map(live.map((l) => [l.name, l]));
  const matched: Matched[] = [];
  const manifestOnly: ManifestResource[] = [];
  for (const m of manifest) {
    const l = liveByName.get(m.name);
    if (!l) {
      manifestOnly.push(m);
      continue;
    }
    const boxKeys = new Set(l.envKeys);
    const manifestKeys = new Set(m.envKeys);
    matched.push({
      kind: m.kind === l.kind ? m.kind : `${m.kind} / ${l.kind} on the box`,
      name: m.name,
      manifestOnlyKeys: sorted(m.envKeys.filter((k) => !boxKeys.has(k))),
      boxOnlyKeys: sorted(l.envKeys.filter((k) => !manifestKeys.has(k))),
      sharedKeys: sorted(m.envKeys.filter((k) => boxKeys.has(k))),
    });
  }
  const manifestNames = new Set(manifest.map((m) => m.name));
  const boxOnly = live.filter((l) => !manifestNames.has(l.name));
  return { matched, manifestOnly, boxOnly };
}

// Names and keys. NEVER values — the whole artifact is meant to be read, pasted,
// and committed to a PR discussion, so it must be safe to do all three with.
export function renderInventory(
  rec: Reconciliation,
  ctx: {
    orgRepo: string;
    env: string;
    instance: string;
    project: string;
    environment: string;
  },
): string {
  const lines = [
    `inventory — ${ctx.orgRepo} ${ctx.env}`,
    "",
    `  source:       instance ${ctx.instance}`,
    `  project:      ${ctx.project}`,
    `  environment:  ${ctx.environment}`,
    "",
    "  Env var KEYS only — no values are read or printed.",
    "",
  ];

  const bullet = (kind: string, name: string) =>
    `    ${kind.padEnd(12)} ${name}`;

  lines.push("on the box, and in the manifest");
  if (rec.matched.length === 0) {
    lines.push("    (nothing matched — see both lists below)");
  }
  for (const m of rec.matched) {
    lines.push(bullet(m.kind, m.name));
    if (m.sharedKeys.length > 0) {
      lines.push(`      both:          ${m.sharedKeys.join(", ")}`);
    }
    if (m.manifestOnlyKeys.length > 0) {
      lines.push(`      manifest only: ${m.manifestOnlyKeys.join(", ")}`);
    }
    if (m.boxOnlyKeys.length > 0) {
      lines.push(`      box only:      ${m.boxOnlyKeys.join(", ")}`);
    }
  }

  lines.push("", "in the manifest, NOT on the box");
  if (rec.manifestOnly.length === 0) lines.push("    (none)");
  for (const m of rec.manifestOnly) {
    lines.push(bullet(m.kind, m.name));
    if (m.envKeys.length > 0) {
      lines.push(`      declares:      ${sorted(m.envKeys).join(", ")}`);
    }
  }

  lines.push("", "on the box, NOT in the manifest");
  if (rec.boxOnly.length === 0) lines.push("    (none)");
  for (const l of rec.boxOnly) {
    lines.push(bullet(l.kind, l.name));
    // A resource the manifest has never heard of: EVERY key on it is box-only,
    // and they are the most interesting keys in the report — this is where a
    // resource that the manifest calls something else shows up, carrying the
    // values `capture` went looking for and could not find.
    if (l.envKeys.length > 0) {
      lines.push(`      carries:       ${sorted(l.envKeys).join(", ")}`);
    }
  }

  const drift =
    rec.manifestOnly.length +
    rec.boxOnly.length +
    rec.matched.reduce(
      (n, m) => n + m.manifestOnlyKeys.length + m.boxOnlyKeys.length,
      0,
    );
  lines.push(
    "",
    drift === 0
      ? "The manifest and this box name the same things. (On a hand-built box, treat"
      : `${drift} difference(s) between the manifest and this box.`,
  );
  if (drift === 0) {
    lines.push(
      "that with suspicion rather than relief — a box nobody declared agreeing",
      "perfectly with a manifest nobody applied is more often a wrong lookup than",
      "a true match.)",
    );
  }
  lines.push(
    "",
    "This is a document, not desired state. Nothing here is read by `apply` — the",
    "path from here is: decide what the manifest should GAIN and what is cruft that",
    "must not travel, land that as a manifest PR, then `capture` and `apply`.",
  );
  return lines.join("\n");
}
