import type { ResolvedEnv } from "./envtemplate.js";

export type ResourceKind = "application" | "database" | "service";
export type Desired = {
  kind: ResourceKind;
  name: string;
  fields: Record<string, unknown>;
  env?: ResolvedEnv;
};
export type Live = {
  kind: ResourceKind;
  name: string;
  uuid: string;
  fields: Record<string, unknown>;
  env?: Record<string, string>;
};
export type FieldDiff = {
  field: string;
  desired: unknown;
  live?: unknown;
  updatable: boolean;
};
export type EnvDiff = {
  key: string;
  state: "add" | "change" | "remove-candidate";
  secret: boolean;
};
export type Change = {
  kind: ResourceKind;
  name: string;
  uuid?: string;
  op: "create" | "update";
  fieldDiffs: FieldDiff[];
  envDiffs: EnvDiff[];
};
export type DiffReport = {
  mode: "structural" | "full";
  changes: Change[];
  orphans: { kind: ResourceKind; name: string; uuid: string }[];
  clean: boolean;
};

export const NON_UPDATABLE: Record<ResourceKind, string[]> = {
  application: ["build_pack"],
  database: ["type", "version"],
  service: ["type"],
};

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffEnv(
  desired: ResolvedEnv,
  live: Record<string, string>,
): EnvDiff[] {
  const diffs: EnvDiff[] = [];
  for (const [key, v] of Object.entries(desired.vars)) {
    if (!(key in live)) diffs.push({ key, state: "add", secret: v.secret });
    else if (live[key] !== v.value)
      diffs.push({ key, state: "change", secret: v.secret });
  }
  for (const key of Object.keys(live)) {
    if (!(key in desired.vars))
      diffs.push({ key, state: "remove-candidate", secret: false });
  }
  return diffs;
}

export function computeDiff(
  desired: Desired[],
  live: Live[],
  mode: "structural" | "full",
): DiffReport {
  const changes: Change[] = [];
  for (const d of desired) {
    const l = live.find((x) => x.kind === d.kind && x.name === d.name);
    if (!l) {
      changes.push({
        kind: d.kind,
        name: d.name,
        op: "create",
        fieldDiffs: Object.entries(d.fields).map(([field, value]) => ({
          field,
          desired: value,
          updatable: !NON_UPDATABLE[d.kind].includes(field),
        })),
        envDiffs:
          mode === "full" && d.env
            ? Object.entries(d.env.vars).map(([key, v]) => ({
                key,
                state: "add" as const,
                secret: v.secret,
              }))
            : [],
      });
      continue;
    }
    const fieldDiffs: FieldDiff[] = Object.entries(d.fields)
      .filter(([field, value]) => !eq(value, l.fields[field]))
      .map(([field, value]) => ({
        field,
        desired: value,
        live: l.fields[field],
        updatable: !NON_UPDATABLE[d.kind].includes(field),
      }));
    const envDiffs =
      mode === "full" && d.env ? diffEnv(d.env, l.env ?? {}) : [];
    if (fieldDiffs.length > 0 || envDiffs.length > 0) {
      changes.push({
        kind: d.kind,
        name: d.name,
        uuid: l.uuid,
        op: "update",
        fieldDiffs,
        envDiffs,
      });
    }
  }
  const orphans = live
    .filter((l) => !desired.some((d) => d.kind === l.kind && d.name === l.name))
    .map((l) => ({ kind: l.kind, name: l.name, uuid: l.uuid }));
  return {
    mode,
    changes,
    orphans,
    clean: changes.length === 0 && orphans.length === 0,
  };
}

export function renderDiff(report: DiffReport): string {
  const lines: string[] = [];
  if (report.mode === "structural") {
    lines.push(
      "env vars not compared (structural mode — full diff needs a session token with read:sensitive)",
    );
  }
  for (const c of report.changes) {
    lines.push(`${c.op} ${c.kind} ${c.name}`);
    for (const f of c.fieldDiffs) {
      lines.push(
        `  ${f.field}: ${JSON.stringify(f.live)} → ${JSON.stringify(f.desired)}${f.updatable ? "" : "  [NOT UPDATABLE IN PLACE]"}`,
      );
    }
    for (const e of c.envDiffs) {
      if (e.state === "remove-candidate")
        lines.push(
          `  env ${e.key}: live-only (orphan var — apply never removes)`,
        );
      else if (e.secret) lines.push(`  secret ${e.key} differs`);
      else lines.push(`  env ${e.key}: ${e.state}`);
    }
  }
  for (const o of report.orphans) {
    lines.push(
      `orphan ${o.kind} ${o.name} (live, not in manifest — removal is a manual runbook act)`,
    );
  }
  lines.push(
    report.clean
      ? "clean"
      : `${report.changes.length} change(s), ${report.orphans.length} orphan(s)`,
  );
  return lines.join("\n");
}
