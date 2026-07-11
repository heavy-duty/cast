import type { Change, Desired, DiffReport, ResourceKind } from "./diff.js";
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
  const mutated: string[] = [];
  for (const c of report.changes) {
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
