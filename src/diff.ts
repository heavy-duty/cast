import { GENERATED_PLACEHOLDER } from "./capture.js";
import type { ResolvedEnv } from "./envtemplate.js";
import { isReservedEnvName, reservedConsequence } from "./reserved.js";

export type ResourceKind = "application" | "database" | "service";
// One live env var as Coolify returns it, before the per-secret flattening that
// used to happen the moment it was read. `value` is what a plain token sees:
// fresh after every write, but MASKED for a secret. `realValue` is the decrypted
// plaintext (a `read:sensitive` token); it is the only readable form of a secret,
// but for a NON-secret var it is a stored column Coolify does NOT recompute on an
// in-place PATCH — so it goes stale and reads back the pre-update value (#78).
//
// Carrying both to diffEnv (rather than collapsing to `realValue ?? value` at
// fetch time) is what lets the comparison pick the fresh side per var: `value`
// for non-secrets, `realValue ?? value` for secrets. See fetchEnv, diffEnv.
export type LiveEnvVar = { value: string; realValue?: string };
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
  env?: Record<string, LiveEnvVar>;
  // The destination (Docker network) Coolify reports this resource on.
  //
  // NOT in `fields`, because `fields` is the desired-vs-live comparison
  // vocabulary and this can never take part in it: Coolify 4.1.2 accepts
  // `destination_uuid` on write and returns `destination_id` (an integer
  // primary key) on read, and exposes no endpoint that maps one to the other.
  // Putting it in `fields` would diff a UUID against an int and report drift
  // that can never be resolved. See Placement.
  destinationId?: number;
  // Set ONLY when this database declares a `backup` block that cast could not
  // read back (GET /databases/{uuid}/backups was unreachable, or answered a
  // shape cast does not recognize — see BackupRead). The string is the reason,
  // printed verbatim.
  //
  // Presence of this means: DO NOT COMPARE `backup` for this resource. Leaving
  // `backup` merely absent from `fields` would NOT be equivalent — it would
  // diff desired-against-nothing and report confident drift on a database that
  // may well be perfectly backed up. An unreadable answer must produce neither
  // drift nor a clean bill; it produces a line on the report. computeDiff is
  // where that is enforced.
  backupNotCompared?: string;
  // The internal URL Coolify minted for this database (`internal_db_url`), when
  // it is a database and the read carried one. NOT in `fields`: it is never
  // written or compared as a database field — it is what an APPLICATION's
  // ${resource:<this>.url} derives from (#60). Absent on applications/services,
  // and on a database whose URL the read could not see.
  internalDbUrl?: string;
  // Coolify 4.1.2 returns `is_static: null` on the read path even for a
  // genuinely-static application (cast#68), so the live value is UNREADABLE.
  // Presence of this means: DO NOT COMPARE `is_static` for this application.
  // Exactly like backupNotCompared, leaving is_static merely absent from
  // `fields` is NOT equivalent — the desired side still declares it whenever
  // the manifest sets `static:`, so computeDiff would diff true-against-
  // undefined and report a phantom PATCH + redeploy every run. is_static stays
  // a create-time setting; a real boolean from a future Coolify (staticNotCompared
  // unset) is projected and diffed normally.
  staticNotCompared?: boolean;
};
export type FieldDiff = {
  field: string;
  desired: unknown;
  live?: unknown;
  updatable: boolean;
};
export type EnvDiff = {
  key: string;
  // `placeholder-conflict` is NOT a kind of `change`, and the distinction is
  // the whole point: a `change` is a value cast is entitled to write, and this
  // is one it must never write. The store holds GENERATED_PLACEHOLDER — "no
  // real value exists yet, Coolify will make one" — and the live resource says
  // Coolify already did. See diffEnv, renderDiff and applyPlan's refusal.
  state: "add" | "change" | "remove-candidate" | "placeholder-conflict";
  secret: boolean;
  // Set to the RESOURCE NAME this var's value is derived from — its
  // ${resource:<name>.url} — when it is a derived value rather than an authored
  // one. Rendered as "derived from database <name>" rather than "secret differs",
  // so a routine URL change (a rotation the derivation is meant to follow) never
  // reads as an unexplained secret drift. Still `secret`, so the value itself is
  // never printed either way (#60).
  derived?: string;
};
export type Change = {
  kind: ResourceKind;
  name: string;
  uuid?: string;
  op: "create" | "update";
  fieldDiffs: FieldDiff[];
  envDiffs: EnvDiff[];
};
// Where this project's resources actually sit, as far as Coolify will say.
//
// The destination cannot be diffed the way every other field is (see Live), so
// the alternative was to leave it out of the report entirely — and a setting
// that reads back as ABSENT rather than WRONG is the exact failure shape cast
// keeps legislating against (#12, #14, #17, #18). So it is reported instead of
// compared, and reported with the limit stated:
//
//   - `declared` is what the state file asks for. cast sends it on create and
//     CANNOT check it afterwards. Never silently — renderDiff says so.
//   - `groups` is what Coolify answers, by `destination_id`. It is an opaque
//     int, but it is comparable to ITSELF, and that is enough to catch the
//     thing actually worth catching: a project whose resources do not all share
//     one network is a project whose isolation is broken, whatever the numbers
//     happen to be.
export type Placement = {
  declared?: string;
  groups: { destinationId: number; resources: string[] }[];
  split: boolean;
};

// A reserved name (SOURCE_COMMIT, COOLIFY_*) found on a LIVE resource.
//
// NOT an orphan var, and the distinction is the whole point of this type. An
// orphan var is a live-only var the manifest does not declare, and its
// documented disposition is "apply never removes these; read them by eye" —
// cosmetic residue, filed under a heading that invites being read past. A
// reserved name is not residue: it is an ACTIVE SUPPRESSION of a value Coolify
// would otherwise inject (see reserved.ts), it is the difference between
// /version reporting a commit and reporting "unknown", and it is never
// cosmetic. So it comes out of that list and is reported as a finding, with the
// consequence attached.
//
// `apply never deletes` still holds, unchanged: cast reports it, a human deletes
// it in the Coolify UI.
export type ReservedVar = { kind: ResourceKind; name: string; key: string };

export type DiffReport = {
  mode: "structural" | "full";
  changes: Change[];
  orphans: { kind: ResourceKind; name: string; uuid: string }[];
  // Findings, not drift-to-repair. Never empty in structural mode by accident:
  // structural mode reads no env vars at all, so it can find none — and says so.
  reserved: ReservedVar[];
  placement: Placement;
  // Databases whose declared `backup` block cast could not verify this run.
  // NOT drift (nothing was read, so nothing can be claimed) and so NOT counted
  // against `clean` — but printed on every run that has any, because the whole
  // point is that the assumption goes on screen at the moment it is made.
  backupsNotCompared: { name: string; reason: string }[];
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

// The live value to compare a desired var against, chosen by whether the desired
// side declares it secret (#78). For a NON-secret, `value` is authoritative and
// always fresh; `realValue` is a stored column Coolify leaves stale after an
// in-place PATCH, so trusting it re-proposes an already-correct var on every
// diff. For a SECRET, `value` is masked to a plain token, so `realValue` (the
// decrypted plaintext) is the only comparable form — kept as it always was, at
// the cost of the same theoretical staleness, which a masked `value` cannot
// stand in for. `realValue` is optional (a plain token omits it); fall back to
// `value` so a secret still compares against SOMETHING rather than `undefined`.
function liveValueFor(secret: boolean, live: LiveEnvVar): string {
  return secret ? (live.realValue ?? live.value) : live.value;
}

function diffEnv(
  desired: ResolvedEnv,
  live: Record<string, LiveEnvVar>,
): EnvDiff[] {
  const diffs: EnvDiff[] = [];
  for (const [key, v] of Object.entries(desired.vars)) {
    const derived =
      v.derived !== undefined ? { derived: v.derived.resource } : {};
    if (!(key in live))
      diffs.push({ key, state: "add", secret: v.secret, ...derived });
    else if (liveValueFor(v.secret, live[key]) !== v.value) {
      // The second pass of the two-pass bootstrap, which for years only ever
      // ran once. The store's value for a provider-generated secret is the
      // literal `pending-coolify-generated` (capture.ts); the first apply sends
      // it, Coolify creates the resource and replaces it with the real URL. From
      // that moment the store is KNOWN-WRONG, and every diff since has printed
      // `secret DATABASE_URL differs` — word for word what a legitimate rotation
      // prints — while apply stood ready to PATCH the placeholder back over the
      // live, working value and redeploy. So the placeholder gets its own state,
      // and apply refuses on it (#47).
      //
      // Keyed on the STORE VALUE, not on the manifest's `generated_secrets:`
      // list. Two reasons, and the first is fatal to the alternative:
      //
      //   - `generated_secrets:` names store REFS (`DATABASE_URL_PROD`) while an
      //     env diff is keyed by env var KEY (`DATABASE_URL`) — the template maps
      //     one to the other and they routinely differ, so matching the list
      //     against these keys would sail straight past the real case. The value
      //     carries the same fact to where it is needed: resolveTemplate copies
      //     the store's value in verbatim, and `secret` is true exactly when the
      //     RHS was a single `${REF}`.
      //   - It is the stricter rule. A name dropped from `generated_secrets:`
      //     while the store still holds the placeholder is still a data-loss
      //     write; the placeholder is never a value anyone meant to ship.
      //
      // Only the UPDATE path can reach this: diffEnv runs solely against a live
      // resource. On a create the placeholder is correct — Coolify replaces it —
      // and that path emits `add`, untouched. A var absent live is likewise an
      // `add`, and a live value that is ALSO the placeholder never gets here at
      // all (the values are equal, so there is no diff to state).
      const placeheld = v.secret && v.value === GENERATED_PLACEHOLDER;
      diffs.push({
        key,
        state: placeheld ? "placeholder-conflict" : "change",
        secret: v.secret,
        ...derived,
      });
    }
  }
  for (const key of Object.keys(live)) {
    // A reserved name is deliberately NOT a remove-candidate: it is collected
    // separately, as a finding (see ReservedVar). Leaving it here as well would
    // report the same var twice under two headings, one of which says it is
    // harmless. It also cannot be an `add`/`change`: the manifest side can never
    // declare one — resolve.ts refuses the run first.
    if (!(key in desired.vars) && !isReservedEnvName(key))
      diffs.push({ key, state: "remove-candidate", secret: false });
  }
  return diffs;
}

// Read off the LIVE side, and off every live resource — not only the ones the
// manifest declares. A reserved name suppresses Coolify's injection on the box
// whether or not cast has ever heard of the resource carrying it, so scanning
// `changes` (which exists only for declared resources) would miss it on exactly
// the resource nobody is watching. Empty in structural mode, where no env var
// was read at all.
function reservedVars(live: Live[]): ReservedVar[] {
  const found: ReservedVar[] = [];
  for (const l of live) {
    for (const key of Object.keys(l.env ?? {})) {
      if (isReservedEnvName(key))
        found.push({ kind: l.kind, name: l.name, key });
    }
  }
  return found;
}

function computePlacement(live: Live[], declared?: string): Placement {
  const byDestination = new Map<number, string[]>();
  for (const l of live) {
    // Coolify returns destination_id on applications, databases and services
    // alike (none of the three controllers' removeSensitiveData hides it,
    // v4.1.2). A resource that reports none is not evidence of a split — it is
    // no evidence at all, so it is left out rather than grouped under a
    // fabricated id.
    if (typeof l.destinationId !== "number") continue;
    const at = byDestination.get(l.destinationId) ?? [];
    at.push(`${l.kind} ${l.name}`);
    byDestination.set(l.destinationId, at);
  }
  const groups = [...byDestination.entries()]
    .map(([destinationId, resources]) => ({
      destinationId,
      resources: resources.sort(),
    }))
    .sort((a, b) => a.destinationId - b.destinationId);
  return { declared, groups, split: groups.length > 1 };
}

export function computeDiff(
  desired: Desired[],
  live: Live[],
  mode: "structural" | "full",
  opts: { declaredDestination?: string } = {},
): DiffReport {
  const changes: Change[] = [];
  const backupsNotCompared: { name: string; reason: string }[] = [];
  // is_static is unreadable on Coolify 4.1.2's read path (cast#68); warn once
  // per run when the degradation actually bites (a manifest declares `static:`
  // on an app whose live value cast could not read), not per application.
  let staticWarned = false;
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
                ...(v.derived !== undefined
                  ? { derived: v.derived.resource }
                  : {}),
              }))
            : [],
      });
      continue;
    }
    // The unreadable-backup escape hatch. `backup` is dropped from the
    // comparison entirely — not diffed against `undefined`, which is what
    // "just leave it out of live.fields" would silently mean, and which would
    // report drift cast has no evidence for and let apply write a schedule it
    // never checked for. See Live.backupNotCompared.
    if (l.backupNotCompared && "backup" in d.fields) {
      backupsNotCompared.push({ name: d.name, reason: l.backupNotCompared });
    }
    const skipBackup = l.backupNotCompared !== undefined;
    const fieldDiffs: FieldDiff[] = Object.entries(d.fields)
      .filter(([field]) => !(skipBackup && field === "backup"))
      .filter(([field]) => {
        // The unreadable-is_static escape hatch (cast#68), sibling to the
        // backup one above. is_static lives on the ApplicationSetting relation,
        // which Coolify 4.1.2 never serializes on a read (source-verified), so
        // the live projection omits it and Live carries staticNotCompared. Skip
        // the comparison rather than diffing the desired value against
        // `undefined` forever (a phantom redeploy every run); warn once so the
        // degradation is on screen. A real boolean (staticNotCompared unset)
        // falls through and diffs normally.
        if (field === "is_static" && l.staticNotCompared) {
          if (!staticWarned) {
            console.warn(
              "is_static is set at create time but cannot be read back — it lives on Coolify 4.1.2's ApplicationSetting relation, which no read endpoint serializes (cast#68). So it is not diffed, and changing an EXISTING app's static flag is a Coolify UI act cast cannot reconcile. Ensure it is correct at create time.",
            );
            staticWarned = true;
          }
          return false;
        }
        return true;
      })
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
  const placement = computePlacement(live, opts.declaredDestination);
  const reserved = reservedVars(live);
  return {
    mode,
    changes,
    orphans,
    reserved,
    placement,
    backupsNotCompared,
    // A split project is drift, and drift is not clean — the same disposition
    // as an orphan: reported, counted, and NOT repaired (apply moves nothing
    // between networks; see renderDiff).
    //
    // A reserved name is not clean either, and for a stronger reason than drift:
    // it is a live defect. The box it sits on is deploying green and reporting
    // the wrong commit, and a `diff` that answered "clean" over it would be the
    // last chance anyone had to notice.
    //
    // `backupsNotCompared` is deliberately NOT in this sum, and it is the one
    // exception to the rule the line above states: it is an absence of evidence,
    // not evidence of drift, and a run that failed because a read failed would be
    // a run operators learn to force past. It gets a line instead — an
    // unmissable one — rather than a non-zero exit.
    clean:
      changes.length === 0 &&
      orphans.length === 0 &&
      reserved.length === 0 &&
      !placement.split,
  };
}

// Every env var whose store value is still the generated-secret placeholder
// while the live resource holds a real one. The single reading of the report
// that both renderDiff and applyPlan use, so the warning and the refusal can
// never disagree about what counts as one.
//
// Names the key and the resource — NEVER the live value. Same rule as capture's
// disposition table: the point of the report is what to fix, not what the secret
// is, and a secret printed to a terminal is a secret in a scrollback buffer.
export function placeholderConflicts(
  report: DiffReport,
): Array<{ kind: ResourceKind; name: string; key: string }> {
  return report.changes.flatMap((c) =>
    c.envDiffs
      .filter((e) => e.state === "placeholder-conflict")
      .map((e) => ({ kind: c.kind, name: c.name, key: e.key })),
  );
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
      // Said in words no rotation prints. `secret X differs` was the ONLY signal
      // this ever had, and it is exactly what a legitimate rotation of the same
      // secret looks like — an operator reading it had no way to tell the two
      // apart, which is how a plan to destroy a live database reads as routine.
      else if (e.state === "placeholder-conflict")
        lines.push(
          `  secret ${e.key}: store holds the generated-secret PLACEHOLDER, live holds a real value — apply would OVERWRITE it`,
        );
      // A derived value, said in words that are not a rotation's: it is not a
      // secret that "differs", it is a URL cast reads back from the database it
      // created and keeps the app pointed at. `add` = the app does not carry it
      // yet (a first apply, or a database made this run); `change` = the live
      // value has drifted from the database's current URL and apply will follow
      // it. Never the value — same rule as any secret.
      else if (e.derived)
        lines.push(
          e.state === "add"
            ? `  ${e.key}: derived from database ${e.derived} — apply will set it`
            : `  ${e.key}: derived from database ${e.derived} — live differs, apply will follow it`,
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
  // Printed as a FINDING, in its own paragraph, with the consequence attached —
  // not as a one-line entry in a list of things that are fine. The failure this
  // catches is green: the deploy worked, the health check passed, and this line
  // is the only place anything says otherwise. It has to be readable as an
  // instruction to go and delete something, because that is what it is.
  for (const r of report.reserved) {
    lines.push(
      `FINDING: ${r.kind} ${r.name} carries env var ${r.key} — DELETE IT (Coolify UI)`,
      `  ${reservedConsequence(r.key)}`,
      "  cast declares no such var and never will (it refuses a manifest that does),",
      "  and `apply` never deletes — so this one is yours to remove, by hand, in the UI.",
    );
  }
  // The honest fallback, on the same principle as the placement line below: cast
  // read for the schedule and did not understand the answer, so it says so here
  // rather than dropping the field and letting a clean report imply a backed-up
  // database. A `backup:` block that produced no line above and no line here IS
  // compared, and IS clean.
  for (const b of report.backupsNotCompared) {
    lines.push(
      `backup schedule for database ${b.name} declared, NOT compared — verify in the Coolify UI`,
      `  (${b.reason})`,
    );
  }
  const { placement } = report;
  if (placement.split) {
    lines.push(
      `split placement: these resources sit on ${placement.groups.length} different destinations`,
    );
    for (const g of placement.groups)
      lines.push(`  destination ${g.destinationId}: ${g.resources.join(", ")}`);
    lines.push(
      "  a project's resources must share one destination — that is what the isolation IS.",
      "  apply never moves a live resource between networks: resolve manually (runbook act).",
    );
  } else if (placement.declared && placement.groups.length === 1) {
    lines.push(
      `placement: all resources on destination ${placement.groups[0].destinationId}`,
    );
  }
  if (placement.declared) {
    // Said out loud on every run that declares one, rather than left to be
    // inferred from its absence. cast enforces this UUID exactly once — at
    // create — and can never check it again; an operator who thinks `diff`
    // covers it is an operator who thinks the isolation is verified.
    lines.push(
      `destination ${placement.declared} declared, NOT compared — Coolify 4.1.2 takes`,
      "  destination_uuid on write and returns destination_id on read, and has no endpoint",
      "  mapping one to the other. cast sends it on create; nothing can verify it after.",
    );
  } else {
    // The other half of the same principle, and #41: declaring NOTHING is also a
    // decision about placement — cast sends no destination_uuid and lets Coolify
    // pick — and it was the one placement decision made in silence. The inference
    // lived in a source comment ("the server's only destination, which is what
    // Coolify picks anyway"), which is exactly where an assumption is invisible
    // until it is wrong.
    //
    // This reverses a judgment cast used to hold explicitly ("a line on every diff
    // that says nothing is how a report stops being read" — the test this replaces).
    // The line does not say nothing: it says which network the next create lands on,
    // which is a fact about this run and a wrong one to have to infer from a blank
    // space. It stays on a run that creates nothing, too, because the trap is set
    // precisely for projects that are already built and clean — the day their server
    // gains a second destination, every one of them that declared no destination
    // stops being able to create at all, and nothing will have warned them.
    //
    // Two lines, not three: the old judgment was not wrong about noise, only about
    // which side of it silence was on.
    lines.push(
      "placement: server's default destination (none declared) — cast sends no destination_uuid,",
      "  so Coolify picks; a server with more than one destination refuses the create outright.",
    );
  }
  // In the tail too, not only against the var: the per-var line sits inside a
  // change block that can be dozens of lines up, and the summary is the line an
  // operator actually reads before typing `apply`. It says what apply will do,
  // which is nothing at all.
  const conflicts = placeholderConflicts(report);
  lines.push(
    report.clean
      ? "clean"
      : `${report.changes.length} change(s), ${report.orphans.length} orphan(s)${
          report.reserved.length > 0
            ? `, ${report.reserved.length} reserved-name FINDING(s)`
            : ""
        }${placement.split ? ", split placement" : ""}${
          conflicts.length > 0
            ? `, ${conflicts.length} generated-secret PLACEHOLDER conflict(s) — apply will REFUSE`
            : ""
        }`,
  );
  return lines.join("\n");
}
