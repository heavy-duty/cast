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
  // The MANIFEST's name for it, once --resource has aliased it. Without an
  // alias, whatever the box calls it.
  name: string;
  // What the box calls it, when that differs. Kept, and printed: a document
  // that renamed the box's resources to our vocabulary and then never mentioned
  // theirs would be unusable against the UI it describes.
  sourceName?: string;
  envKeys: string[];
};

export type Matched = {
  kind: string;
  name: string;
  sourceName?: string;
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

// --- The sweep: what is on this box, before any manifest is involved ---
//
// The verb's premise is that you are looking at a box you did not build, so you
// do NOT know its coordinates yet. Requiring a project and an environment to
// look at it made it a discovery tool that needed you to have already
// discovered — and the operator went back to hand-curling /projects to find out
// where anything lived. This is that pass, and it needs no manifest at all.

export type SweepEnvironment = {
  name: string;
  resources: Array<{ kind: string; name: string }>;
};

export type SweepProject = {
  name: string;
  environments: SweepEnvironment[];
};

export function renderSweep(
  projects: SweepProject[],
  ctx: { instance: string; baseUrl: string },
): string {
  const lines = [
    `sweep — instance ${ctx.instance} (${ctx.baseUrl})`,
    "",
    "  Every project, every environment, every resource this token can see.",
    "  No manifest involved: this is what is HERE, not how it compares to anything.",
    "",
  ];
  if (projects.length === 0) {
    lines.push(
      "  (no projects at all)",
      "",
      "  An instance with no projects is more often a token that cannot see them",
      "  than an empty instance — the team assert above is what rules that out.",
    );
    return lines.join("\n");
  }
  for (const p of projects) {
    lines.push(`  ${p.name}`);
    if (p.environments.length === 0) {
      lines.push("    (no environments)");
    }
    for (const e of p.environments) {
      const counts = Object.entries(
        e.resources.reduce<Record<string, number>>((acc, r) => {
          acc[r.kind] = (acc[r.kind] ?? 0) + 1;
          return acc;
        }, {}),
      )
        .map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`)
        .join(", ");
      // An empty environment is worth seeing, not hiding: Coolify auto-creates
      // `production` in every project, and an operator who assumes that is where
      // things live will aim every later command at nothing.
      lines.push(`    ${e.name.padEnd(14)} ${counts || "(empty)"}`);
      for (const r of e.resources) {
        lines.push(`      ${r.kind.padEnd(12)} ${r.name}`);
      }
    }
    lines.push("");
  }
  lines.push(
    "Point a reconciliation at one of these with --project / --environment, and",
    "map any resource whose name differs with --resource <manifest>=<live>.",
  );
  return lines.join("\n");
}

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
      ...(l.sourceName ? { sourceName: l.sourceName } : {}),
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
  // The box has NOTHING in it. Not "nothing that matched" — nothing at all.
  //
  // This is the third face of the D-237 lie, and the quietest: an environment
  // with zero resources reads back exactly like a box you have not built yet,
  // and the report then consists entirely of the manifest talking to itself.
  // The overall impression — "the box has nothing, the manifest has five things"
  // — is how a full-create plan gets laundered into a pass. It happened: pointed
  // at a project's auto-created `production` environment, this verb reported
  // five differences against a box whose resources were alive and serving
  // production the whole time, in an environment named `staging`.
  if (rec.matched.length === 0 && rec.boxOnly.length === 0) {
    return [
      `inventory — ${ctx.orgRepo} ${ctx.env}`,
      "",
      `  looked in:    project "${ctx.project}", environment "${ctx.environment}"`,
      `  found:        NOTHING. Not one resource.`,
      "",
      "This environment is EMPTY — so there is nothing here to reconcile, and the",
      "manifest's list below would just be the manifest talking to itself.",
      "",
      "An environment with zero resources is far more often the WRONG COORDINATE",
      "than an empty one. Coolify auto-creates a `production` environment in every",
      "project, and a box built by hand keeps its real resources wherever someone",
      "put them — which may well be an environment called something else entirely.",
      "",
      "Sweep the instance and see where things actually are:",
      "",
      `    cast inventory --env ${ctx.env} --instance ${ctx.instance}`,
      "",
      "(The manifest declares: " +
        rec.manifestOnly.map((m) => m.name).join(", ") +
        ".)",
    ].join("\n");
  }
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
    lines.push(
      m.sourceName
        ? `${bullet(m.kind, m.name)}   ← "${m.sourceName}" on the box`
        : bullet(m.kind, m.name),
    );
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
  // Nothing matched, yet the box is full of resources: that is a NAMING gap, not
  // an empty box — and it is the single most likely thing to be looking at you
  // here. Say so, rather than leaving a reader to conclude the box has nothing
  // (which is how "create everything" gets laundered into a pass).
  if (rec.matched.length === 0 && rec.boxOnly.length > 0) {
    lines.push(
      "",
      "NOTHING matched — and yet this box has resources. That is almost always a",
      "naming difference, not an empty box: a box built by hand names things for a",
      "human reading a UI, not for a manifest. Map them and re-run:",
      "",
      ...rec.manifestOnly.map(
        (m) => `    --resource ${m.name}="<what this box calls it>"`,
      ),
    );
  }
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
