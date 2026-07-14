import { GENERATED_PLACEHOLDER } from "./capture.js";
import {
  type Change,
  type Desired,
  type DiffReport,
  type ResourceKind,
  placeholderConflicts,
} from "./diff.js";
import type { ResolvedEnv } from "./envtemplate.js";

export type Executor = {
  createResource(change: Change): Promise<string>;
  updateFields(
    uuid: string,
    kind: ResourceKind,
    fields: Record<string, unknown>,
  ): Promise<void>;
  syncEnv(uuid: string, kind: ResourceKind, env: ResolvedEnv): Promise<void>;
  redeploy(uuid: string, kind: ResourceKind): Promise<void>;
};

// The order apply acts in, by kind.
//
// It is a FIXED order and not a computed graph because there is no graph to
// compute: nothing in a manifest declares that `core` needs `postgres` — no
// resource names another, anywhere — so the dependency edges do not exist to be
// walked. What does exist is the direction between kinds, and it is not in
// question: applications talk to databases and services, never the reverse.
// Three kinds is few enough to legislate.
//
// Ranked as a Record<ResourceKind, number> on purpose: a fourth ResourceKind
// does not COMPILE until someone decides where it goes. A list + `indexOf`
// would rank an unranked kind -1 — i.e. ahead of databases — which is exactly
// the bug this ordering exists to fix (#45), reintroduced silently for the new
// kind.
const KIND_RANK: Record<ResourceKind, number> = {
  database: 0,
  service: 1,
  application: 2,
};

// The forward order, spelled out: databases → services → applications. Derived
// from the ranks rather than written twice, so the two can never drift apart.
// `cast destroy` (#43) tears down in its exact reverse — things come up in the
// order their dependencies allow and go down in the reverse — and a follow-up
// unifies the two constants in one place.
export const KIND_ORDER: readonly ResourceKind[] = (
  Object.keys(KIND_RANK) as ResourceKind[]
).sort((a, b) => KIND_RANK[a] - KIND_RANK[b]);

export function applyHostnameOverlay(
  desired: Desired[],
  overlay: Record<string, string[] | Record<string, string[]>>,
): Desired[] {
  const unknown = Object.keys(overlay).filter(
    (n) => !desired.some((d) => d.name === n),
  );
  if (unknown.length > 0)
    throw new Error(
      `hostname overlay names unknown apps: ${unknown.join(", ")}`,
    );
  return desired.map((d) => {
    const entry = overlay[d.name];
    if (!entry) return d;
    if (Array.isArray(entry)) {
      return { ...d, fields: { ...d.fields, domains: entry } };
    }
    // Map-shaped overlay entry: per-service domains for a dockercompose app.
    const composeDomains = d.fields.docker_compose_domains as
      | Record<string, string[]>
      | undefined;
    if (!composeDomains) {
      throw new Error(
        `hostname overlay gave a service map for non-compose app ${d.name}`,
      );
    }
    const unknownServices = Object.keys(entry).filter(
      (s) => !(s in composeDomains),
    );
    if (unknownServices.length > 0) {
      throw new Error(
        `hostname overlay names unknown service(s) ${unknownServices.join(", ")} for app ${d.name} (known: ${Object.keys(composeDomains).join(", ")})`,
      );
    }
    return {
      ...d,
      fields: {
        ...d.fields,
        docker_compose_domains: { ...composeDomains, ...entry },
      },
    };
  });
}

export async function applyPlan(
  report: DiffReport,
  desired: Desired[],
  exec: Executor,
): Promise<{ mutated: string[] }> {
  if (report.mode !== "full") {
    throw new Error(
      "apply requires a full diff (session token with read:sensitive) — refusing on a structural report",
    );
  }
  // REFUSED, not warned about. The placeholder is a promise ("Coolify will make
  // this"), never a value, and writing it over a secret Coolify has since made
  // is a data-loss write: it takes DATABASE_URL away from every consumer and
  // then redeploys them onto it. A warning is no guard at all here, because the
  // plan line it would sit next to is indistinguishable from a routine rotation
  // — this is the same fail-closed family as the team assert and the absent-
  // project gate, and for the same reason: a routine command about to do
  // something irreversible.
  //
  // Before ANY resource is touched, like the not-updatable refusal below: an
  // apply that pulled the database out from under one app and only THEN refused
  // on the next would be the worst of both outcomes.
  //
  // UPDATE-path only, by construction — computeDiff can only raise this against
  // a live resource (see diffEnv). A create still sends the placeholder, which
  // is correct: Coolify replaces it when it makes the resource, and that is the
  // first pass of the bootstrap this guard exists to let you survive twice.
  const conflicts = placeholderConflicts(report);
  if (conflicts.length > 0) {
    throw new Error(
      [
        `refusing apply: the store still holds the ${GENERATED_PLACEHOLDER} placeholder for secret(s) whose live value Coolify has already generated:`,
        // The key and the resource. Never the live value — capture's rule.
        ...conflicts.map((c) => `  ${c.key} on ${c.kind} ${c.name}`),
        "",
        "Writing the store's value would overwrite the real one and break every consumer.",
        "Fill the store from the live resource first (`cast capture --generated-only`, #48),",
        "or, if the name is no longer provider-generated, drop it from the manifest's",
        "`generated_secrets:` and capture its real value.",
      ].join("\n"),
    );
  }
  // Every change is checked before the first one is acted on — that is the
  // guarantee ("fails loudly, before any mutation"), and it is why this is a
  // separate full scan and not a check folded into the ordered walk below. A
  // fold would let the databases (which now sort first) be created before the
  // application whose un-updatable drift refuses the run.
  for (const c of report.changes) {
    const blocked = c.fieldDiffs.filter(
      (f) => !f.updatable && c.op === "update",
    );
    if (blocked.length > 0) {
      throw new Error(
        `cannot update in place: ${c.kind} ${c.name} field(s) ${blocked.map((f) => f.field).join(", ")} — apply never recreates resources; resolve manually (runbook act)`,
      );
    }
  }
  // Act in dependency order, not manifest order (#45).
  //
  // `desiredFromManifest` emits applications first and `computeDiff` preserves
  // that, so a walk in report order creates the compose app — and deploys it,
  // three lines down — before the Postgres and Redis it talks to exist at all.
  // A guaranteed-red first deploy, every time.
  //
  // Creates AND updates, not just creates: a redeploy is a redeploy. An
  // application restarted against a database whose own pending change has not
  // been applied yet is the same failure, one apply later.
  //
  // A COPY, never a sort in place: `report.changes` is what `renderDiff` prints
  // and what a fleet run reports on, and that reading order is the manifest's,
  // deliberately — a resource is read where its author wrote it. Only the acting
  // order changes here. Nothing about WHAT apply does (clean, orphans,
  // placement, the refusals above) moves with it.
  //
  // Stable (ES2019 guarantees it), so within a kind the manifest's order
  // survives. Within-kind order carries no meaning, but a run that reshuffles
  // its own resources every time is noise in an operator's terminal.
  const ordered = [...report.changes].sort(
    (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind],
  );
  const mutated: string[] = [];
  for (const c of ordered) {
    const spec = desired.find((d) => d.kind === c.kind && d.name === c.name);
    let uuid: string;
    let didMutate = c.op === "create";
    if (c.op === "create") {
      uuid = await exec.createResource(c);
    } else {
      uuid = c.uuid as string;
      const fields = Object.fromEntries(
        c.fieldDiffs.map((f) => [f.field, f.desired]),
      );
      if (Object.keys(fields).length > 0) {
        await exec.updateFields(uuid, c.kind, fields);
        didMutate = true;
      }
    }
    const needsEnv =
      c.op === "create"
        ? spec?.env !== undefined
        : c.envDiffs.some((e) => e.state !== "remove-candidate");
    if (needsEnv && spec?.env) {
      await exec.syncEnv(uuid, c.kind, spec.env);
      didMutate = true;
    }
    if (didMutate) {
      await exec.redeploy(uuid, c.kind);
      mutated.push(c.name);
    }
  }
  return { mutated };
}
