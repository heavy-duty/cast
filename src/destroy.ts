import type { ResourceKind } from "./diff.js";

// REVERSE DEPENDENCY ORDER: applications, then services, then databases.
//
// The order a thing is torn down in is the order it was built in, backwards. A
// database removed while an application still points at it does not fail
// quietly — it fails as a restart loop against a hostname that stopped
// resolving, on a box that is still serving somebody else's project. Deleting
// the consumers first means every delete after the first one is a delete of
// something nothing is talking to any more.
//
// DEFINED HERE, not imported from apply.ts, and deliberately: apply owns the
// FORWARD create-order and PR #45 is settling what that order actually is. One
// shared array with a `.reverse()` at one of its two call sites is a constant
// whose meaning depends on which caller you read last — and the one that gets it
// backwards deletes a database first. Two constants, two comments, and a
// follow-up to unify them once #45 has landed and there is one place that can
// honestly own both directions (noted in the PR).
export const DESTROY_ORDER: readonly ResourceKind[] = [
  "application",
  "service",
  "database",
] as const;

// What a database's backups look like from here, and the whole point of the
// three-way split: "backed up", "not backed up" and "cast could not tell" are
// three different answers, and only the first one makes a delete recoverable.
//
// `unknown` is not a degraded `none`. A database that IS backed up must never
// read at the confirmation prompt as one that is not, and a database that is NOT
// must never read as one that is — so anything cast cannot read confidently
// (an HTTP failure, a response shape it does not recognize) comes back as
// `unknown` carrying the reason, and the plan says out loud that an unknown
// database must be treated as unrecoverable.
export type BackupExecution = { at?: string; status?: string };
export type BackupSchedule = {
  frequency?: string;
  enabled?: boolean;
  // The most recent execution, by `created_at`. Newest first is what the
  // executions route returns, but the ordering is not something to depend on:
  // this is computed.
  last?: BackupExecution;
  // How many executions the schedule has ever had. Zero is the case that looks
  // like a backup and is not one.
  executions: number;
};
export type BackupState =
  | { state: "scheduled"; schedules: BackupSchedule[] }
  | { state: "none" }
  | { state: "unknown"; reason: string };

// Parse GET /databases/{uuid}/backups.
//
// The route returns `ScheduledDatabaseBackup::…->with('executions')->get()` —
// a bare JSON ARRAY of backup configurations, each carrying its executions
// eager-loaded (DatabasesController@database_backup_details_uuid,
// coollabsio/coolify v4.1.2). The vendored OpenAPI documents the response as the
// literal string "Content is very complex. Will be implemented later.", which is
// why this parses the SOURCE's shape and then refuses to guess: an envelope it
// does not recognize is `unknown`, never `none`.
//
// PR #51 is settling this route's real response against a live instance in
// parallel. If it lands a different envelope, this function is the one place
// that has to learn about it — and until it does, an unrecognized shape degrades
// to `unknown` rather than to a lie.
export function readBackupState(raw: unknown): BackupState {
  const configs = Array.isArray(raw)
    ? raw
    : // Two envelopes seen in the wild around Laravel APIs — accepted because
      // reading them is free, and misreading them costs a database.
      Array.isArray((raw as { data?: unknown })?.data)
      ? ((raw as { data: unknown[] }).data as unknown[])
      : Array.isArray((raw as { backups?: unknown })?.backups)
        ? ((raw as { backups: unknown[] }).backups as unknown[])
        : undefined;
  if (!configs) {
    return {
      state: "unknown",
      reason: `GET /databases/{uuid}/backups returned a shape cast does not recognize (${typeof raw})`,
    };
  }
  if (configs.length === 0) return { state: "none" };
  const schedules = configs.map((c): BackupSchedule => {
    const config = (c ?? {}) as Record<string, unknown>;
    const executions = Array.isArray(config.executions)
      ? (config.executions as Array<Record<string, unknown>>)
      : [];
    // Newest by created_at. An entry whose timestamp will not parse is not
    // dropped from the count — it is simply never the newest, because a date
    // cast cannot read is not evidence that a backup landed.
    let last: BackupExecution | undefined;
    let lastMs = Number.NEGATIVE_INFINITY;
    for (const e of executions) {
      const at = typeof e.created_at === "string" ? e.created_at : undefined;
      const ms = at ? Date.parse(at) : Number.NaN;
      if (!Number.isNaN(ms) && ms > lastMs) {
        lastMs = ms;
        last = {
          at,
          status: typeof e.status === "string" ? e.status : undefined,
        };
      }
    }
    return {
      frequency:
        typeof config.frequency === "string" ? config.frequency : undefined,
      enabled: typeof config.enabled === "boolean" ? config.enabled : undefined,
      last,
      executions: executions.length,
    };
  });
  return { state: "scheduled", schedules };
}

// One resource this run will delete: what it is, what it is called, and — for a
// database — what deleting it costs.
export type DestroyTarget = {
  kind: ResourceKind;
  name: string;
  uuid: string;
  backup?: BackupState;
};

export type Resource = { kind: ResourceKind; name: string };

export type DestroyPlan = {
  // Declared by the manifest AND present on the box, in DESTROY_ORDER.
  targets: DestroyTarget[];
  // Declared by the manifest and NOT on the box. Nothing to delete — reported
  // because a manifest that names a resource this environment has never held is
  // a finding in its own right (a typo, a stale block, an environment that was
  // never applied), and because it is how "I deleted three of four" stops
  // reading like "I deleted everything".
  absent: Resource[];
  // On the box and NOT declared by the manifest. LEFT STANDING, always, and
  // reported loudly: this is the one report that tells an operator something was
  // created outside cast. Deleting it would make destroy an environment wipe,
  // which is precisely the verb this one refuses to be.
  undeclared: Resource[];
};

export function planDestroy(
  declared: Resource[],
  live: Array<{ kind: ResourceKind; name: string; uuid: string }>,
): DestroyPlan {
  const isSame = (a: Resource, b: Resource) =>
    a.kind === b.kind && a.name === b.name;
  const targets = live
    .filter((l) => declared.some((d) => isSame(d, l)))
    .map((l) => ({ kind: l.kind, name: l.name, uuid: l.uuid }))
    .sort(
      (a, b) =>
        DESTROY_ORDER.indexOf(a.kind) - DESTROY_ORDER.indexOf(b.kind) ||
        a.name.localeCompare(b.name),
    );
  const absent = declared
    .filter((d) => !live.some((l) => isSame(d, l)))
    .map((d) => ({ kind: d.kind, name: d.name }));
  const undeclared = live
    .filter((l) => !declared.some((d) => isSame(d, l)))
    .map((l) => ({ kind: l.kind, name: l.name }));
  return { targets, absent, undeclared };
}

// What a Coolify DELETE actually does, said once, where the plan is printed —
// because the operator at the prompt is deciding on the strength of it.
//
// DELETE /applications|databases|services/{uuid} takes four query parameters,
// and every one of them DEFAULTS TO TRUE
// ({Applications,Databases,Services}Controller@delete_by_uuid, v4.1.2):
// delete_volumes, delete_connected_networks, delete_configurations,
// docker_cleanup. The controller dispatches DeleteResourceJob with them, so a
// naked DELETE takes the volumes with it. cast sends them EXPLICITLY (see
// coolify.ts DELETE_RESOURCE_QUERY) rather than inheriting defaults it does not
// control.
export const DESTROY_PREAMBLE = [
  "Coolify's delete takes the resource's VOLUMES with it (delete_volumes defaults to",
  "true, and cast sends it explicitly): a database's data is gone with the database.",
  "The delete is also ASYNCHRONOUS — the API queues a DeleteResourceJob and answers",
  "immediately — so this plan is the last thing that happens before it is irreversible.",
];

const kindWidth = (rs: Array<{ kind: string }>) =>
  Math.max(0, ...rs.map((r) => r.kind.length));

// A database line, in the terms that decide the answer at the prompt: not a
// UUID, but whether the thing that is about to be deleted can be brought back.
export function renderBackupLine(backup: BackupState | undefined): string[] {
  if (!backup) return [];
  if (backup.state === "unknown") {
    return [
      `      backup schedule: UNKNOWN — cast could not read it (${backup.reason})`,
      "      treat this database as UNRECOVERABLE: an unread backup is not a backup.",
    ];
  }
  if (backup.state === "none") {
    return [
      "      backup schedule: NONE — nothing has ever been scheduled for this database.",
      "      its volume goes with it, and cast cannot bring it back. UNRECOVERABLE.",
    ];
  }
  return backup.schedules.flatMap((s) => {
    const freq = s.frequency ?? "(frequency unreadable)";
    const enabled = s.enabled === false ? " [DISABLED]" : "";
    const last =
      s.executions === 0
        ? "      last backup:     NEVER — the schedule exists and has never run. UNRECOVERABLE."
        : s.last?.at
          ? `      last backup:     ${s.last.at}${s.last.status ? ` (${s.last.status})` : ""}`
          : `      last backup:     ${s.executions} execution(s), none with a readable timestamp — treat as UNRECOVERABLE`;
    return [`      backup schedule: ${freq}${enabled}`, last];
  });
}

export function renderDestroyPlan(
  plan: DestroyPlan,
  ctx: {
    orgRepo: string;
    env: string;
    project: string;
    environment: string;
    withProject: boolean;
  },
): string {
  const width = kindWidth(plan.targets);
  const lines = [
    "",
    `destroy plan — ${ctx.orgRepo} ${ctx.env}`,
    "",
    `  project:      ${ctx.project}   (on Coolify)`,
    `  environment:  ${ctx.environment}`,
    `  scope:        the ${plan.targets.length} resource(s) the manifest declares for ${ctx.env}, and nothing else`,
    "",
    "DELETE, in reverse dependency order (applications → services → databases):",
    "",
  ];
  if (plan.targets.length === 0) {
    lines.push("  (none — the manifest declares nothing that exists here)");
  }
  for (const t of plan.targets) {
    lines.push(`  ${t.kind.padEnd(width)}  ${t.name}   ${t.uuid}`);
    lines.push(...renderBackupLine(t.backup));
  }
  if (plan.absent.length > 0) {
    lines.push(
      "",
      "declared by the manifest, ABSENT here (nothing to delete):",
      ...plan.absent.map(
        (r) => `  ${r.kind.padEnd(kindWidth(plan.absent))}  ${r.name}`,
      ),
    );
  }
  lines.push(
    "",
    "LEFT STANDING — on this box, and NOT declared by the manifest:",
    "",
  );
  if (plan.undeclared.length === 0) {
    lines.push(
      "  (nothing — every resource here is one the manifest declares)",
    );
  } else {
    lines.push(
      ...plan.undeclared.map(
        (r) => `  ${r.kind.padEnd(kindWidth(plan.undeclared))}  ${r.name}`,
      ),
      "",
      "cast will NOT delete these, and this is not a limitation to work around: destroy is",
      "manifest-scoped, and a resource here that the manifest does not declare was created",
      "outside cast. That is a finding — write it down, or declare it — never a thing to",
      "clean up on the way past.",
    );
  }
  if (ctx.withProject) {
    lines.push(
      "",
      `then --with-project: environment "${ctx.environment}", then project "${ctx.project}".`,
      "Both only if EMPTY — Coolify refuses either with a 400 while anything is still in it,",
      "and so does cast, before it asks.",
    );
  }
  lines.push("", ...DESTROY_PREAMBLE);
  return lines.join("\n");
}

// --all is REFUSED, always, and this is the only verb in cast that says so about
// a flag that exists.
//
// `apply --all` and `diff --all` iterate the registry because a fleet-wide read
// is what nobody does reliably by hand, and a fleet-wide apply is idempotent.
// Neither argument survives being pointed at a delete: there is no incident a
// fleet-wide destroy prevents, no operator who needs two projects gone so badly
// they cannot type the second one, and no way to un-run it. The flag is parsed
// (rather than left to explode as an unknown option) precisely so that this can
// be the answer.
export function renderDestroyAllRefusal(): string {
  return [
    "refusing to destroy: --all is not a thing destroy does — ever",
    "",
    "  --all means: every project the registry lists for this environment.",
    "  destroy means: delete the resources one manifest declares.",
    "",
    "The two compose into a fleet-wide deletion, which is a thing that has no honest use",
    "and exactly one outcome when it is wrong. `apply --all` is safe to iterate because",
    "it is idempotent and never deletes; `diff --all` because it only reads. A destroy is",
    "neither, and no amount of confirmation ceremony makes a loop over other people's",
    "projects a reasonable thing to offer.",
    "",
    "Name ONE project:",
    "",
    "  cast destroy <org>/<repo> --env <env>",
  ].join("\n");
}

// The interlock, and why it is not a flag.
//
// `--yes` is not a gate. It is a thing you type without reading, and by the
// second week it is in the shell history above the command it guards. The gate
// this verb needs has to be somewhere a human commits to it: `destroy_allowed:
// true` in environments.yaml, in the private state repo — edited, committed,
// reviewed, merged. Absent means destroy refuses.
//
// It lives in state and NOT in the product's manifest for the same reason
// `forbidden_var_patterns` does: a change on one side must not be able to lower
// its own guard. A manifest is a PR against the product repo; the guard on
// deleting that product's production must not be.
export function renderNoInterlock(
  envName: string,
  bindingsPath: string,
  declared: boolean | undefined,
): string {
  return [
    `refusing to destroy: environment "${envName}" does not allow it`,
    "",
    `  looked for:  environments.${envName}.destroy_allowed: true`,
    `  in:          ${bindingsPath}`,
    `  found:       ${declared === undefined ? "(absent)" : `destroy_allowed: ${declared}`}`,
    "",
    "The gate on the one verb that deletes lives in STATE, not in argv. A flag is a thing",
    "you type without reading; this is a line somebody has to edit, commit and merge. It",
    "is `true` on an environment that is empty and being battle-tested, and it is DELETED",
    "at cutover — from the moment an environment carries real data, destroying it takes a",
    "PR against the state repo, which is the correct amount of friction for a verb that",
    "ends companies.",
    "",
    "  environments:",
    `    ${envName}:`,
    "      destroy_allowed: true    # absent = destroy refuses. Removed at cutover, forever.",
  ].join("\n");
}

// The absent target, destroy's own copy of the D-237 refusal.
//
// Structurally the same lookup `diff`/`capture`/`smoke` refuse on
// (cli.ts renderAbsentTarget), with one difference that is the whole reason this
// exists rather than reusing it: that message ends by offering `--project` /
// `--environment`, and DESTROY HAS NEITHER, on purpose. Those two coordinates
// exist to point cast at a project or an environment that somebody else named,
// by hand, in a UI — which is precisely the thing this verb must never be
// pointed at. So the remedy it offers is a different one, and an absent project
// still refuses rather than reading back as an empty plan (which, for a verb
// whose plan is "delete nothing", would render as a perfectly clean teardown of
// an environment that is still standing).
export type AbsentTarget =
  | { missing: "project"; project: string; available: string[] }
  | { missing: "environment"; project: string; environment: string };

export function renderAbsentDestroyTarget(
  lookup: AbsentTarget,
  ctx: { orgRepo: string; env: string },
): string {
  const head =
    lookup.missing === "project"
      ? [
          `refusing to destroy: no project named "${lookup.project}" exists in this team`,
          "",
          `  looked for:  project "${lookup.project}"  (derived from the repo slug ${ctx.orgRepo})`,
          `  exists here: ${lookup.available.join(", ") || "(no projects at all)"}`,
        ]
      : [
          `refusing to destroy: project "${lookup.project}" has no environment "${lookup.environment}"`,
          "",
          `  looked for:  environment "${lookup.environment}" in project "${lookup.project}"  (from --env ${ctx.env})`,
          "  note:        an environment built by hand in the Coolify UI may well use a",
          "               different name for the same tier — Coolify's own default is",
          "               `production`, not `prod`.",
        ];
  return [
    ...head,
    "",
    "An absent target reads back exactly like an empty one, and an empty one gives this",
    'verb a plan that says "delete nothing" — a clean-looking teardown of an environment',
    "that is still standing, somewhere else, under a name cast was not told about.",
    "",
    "cast destroy takes no --project and no --environment, deliberately. Those coordinates",
    "exist to point cast at a project or an environment SOMEBODY ELSE named in a UI, and",
    "that is exactly the thing a delete must never be aimed at by a typo. destroy only ever",
    "removes what cast's own manifest declares, in the project named after the repo, in the",
    "environment named by --env.",
    "",
    "`cast inventory --env <env>` sweeps the instance and shows what is actually there.",
    "Nothing was deleted.",
  ].join("\n");
}

// Nothing the manifest declares is here — and that is a REFUSAL, not a clean
// plan (D-237, and doubly so for a verb whose plan is "delete nothing").
//
// The project and the environment both exist; they simply hold none of the
// resources this manifest names. Reported as "0 to delete, done" that reads
// exactly like a successful teardown of an environment that is, in fact, still
// standing — under names cast was never told about. So it names what IS there.
export function renderNothingDeclaredHere(
  plan: DestroyPlan,
  ctx: { orgRepo: string; env: string; project: string; environment: string },
): string {
  const width = kindWidth(plan.undeclared);
  return [
    `refusing to destroy: none of the ${plan.absent.length} resource(s) the manifest declares exists here`,
    "",
    `  looked in:   project "${ctx.project}", environment "${ctx.environment}"`,
    `  declared:    ${plan.absent.map((r) => `${r.kind} ${r.name}`).join(", ")}`,
    "  exists here:",
    ...(plan.undeclared.length > 0
      ? plan.undeclared.map((r) => `    ${r.kind.padEnd(width)}  ${r.name}`)
      : ["    (nothing at all)"]),
    "",
    "A destroy with nothing to destroy is not a clean run — it is a run that agreed with",
    "you about the wrong box, or the wrong environment, or a manifest whose names this",
    "environment has never used. Reported as a no-op it reads exactly like a successful",
    "teardown, which is the one thing it must never read as.",
    "",
    "`cast inventory` shows both sides. Nothing was deleted.",
  ].join("\n");
}

// --with-project, blocked — by resources cast is not allowed to delete.
//
// Coolify refuses both deletes itself while anything is still inside
// (`Project has resources, so it cannot be deleted.` / `Environment has
// resources, so it cannot be deleted.` — ProjectController@delete_project /
// @delete_environment, v4.1.2, both 400). cast refuses FIRST, and before the
// confirmation prompt, because the alternative is an operator who typed the
// environment name, watched their resources get deleted, and then read a 400
// about a project that was never going to go away — having discovered only at
// that point that something else lives in it.
export function renderProjectNotEmptiable(
  ctx: {
    project: string;
    environment: string;
  },
  blockers: {
    undeclared: Resource[];
    otherEnvironments: Array<{ name: string }>;
  },
): string {
  const lines = [
    `refusing to destroy --with-project: project "${ctx.project}" would not be empty`,
    "",
  ];
  if (blockers.undeclared.length > 0) {
    const width = kindWidth(blockers.undeclared);
    lines.push(
      `  in environment "${ctx.environment}", not declared by this manifest:`,
      ...blockers.undeclared.map(
        (r) => `    ${r.kind.padEnd(width)}  ${r.name}`,
      ),
    );
  }
  if (blockers.otherEnvironments.length > 0) {
    lines.push(
      `  in other environments of project "${ctx.project}":`,
      ...blockers.otherEnvironments.map((e) => `    ${e.name}  (not empty)`),
    );
  }
  lines.push(
    "",
    "destroy deletes what the manifest declares. Everything above is something else —",
    "another environment of this project, or a resource somebody created outside cast —",
    "and cast will not delete either to make room for a project delete. Coolify would",
    "refuse the delete too (400: `Project has resources, so it cannot be deleted.`), but",
    "it would refuse it AFTER your resources were already gone.",
    "",
    "Nothing has been deleted. Re-run without --with-project to remove the declared",
    "resources and leave the project standing, or deal with what is listed above first.",
  );
  return lines.join("\n");
}

// The four teardown calls destroy makes, behind an interface, for the same
// reason apply.ts has an Executor: the ORDER and the REFUSALS are the product,
// and they are tested against a fake rather than against a Coolify nobody has
// credentials for.
export type DestroyExecutor = {
  deleteResource(target: DestroyTarget): Promise<void>;
  // Of the project + environment this run is scoped to. Asked of Coolify, never
  // inferred from "I just deleted everything": the deletes are queued jobs, and
  // this is the only thing that knows whether they have run.
  environmentIsEmpty(): Promise<boolean>;
  deleteEnvironment(): Promise<void>;
  deleteProject(): Promise<void>;
};

export type DestroyOutcome = {
  deleted: DestroyTarget[];
  environmentDeleted: boolean;
  projectDeleted: boolean;
  // Set when --with-project was asked for and did not (or could not) complete.
  // Never a throw: the resources ARE deleted by then, and a stack trace over the
  // top of that is not a report.
  note?: string;
};

export type DestroyWait = {
  attempts: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
};

const DEFAULT_WAIT: DestroyWait = {
  attempts: 20,
  intervalMs: 1_000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// Delete, in order, and then — only if asked, and only once Coolify agrees the
// environment is actually empty — take the environment and the project with it.
//
// The wait is not politeness, it is correctness: DELETE on a resource dispatches
// DeleteResourceJob onto a queue and returns "deletion request queued"
// immediately (v4.1.2). A DELETE /projects fired straight after would race the
// queue and 400 with "Project has resources" — an error message about a
// condition that stopped being true a second later, which is the kind of thing
// operators learn to re-run blindly. So cast asks, waits, and says so if the
// answer never comes.
export async function executeDestroy(
  plan: DestroyPlan,
  exec: DestroyExecutor,
  opts: { withProject: boolean; wait?: Partial<DestroyWait> } = {
    withProject: false,
  },
): Promise<DestroyOutcome> {
  const wait = { ...DEFAULT_WAIT, ...opts.wait };
  const deleted: DestroyTarget[] = [];
  for (const target of plan.targets) {
    // No try/catch, deliberately: a delete that fails stops the run. The next
    // one in the order would be a delete of something the failed one may still
    // depend on, and "carry on and see" is not a disposition a teardown gets.
    // The caller reports what WAS deleted (`deleted` is what it read), and the
    // run is re-runnable — destroy is idempotent by construction, because a
    // resource that is already gone is simply not in the next plan.
    await exec.deleteResource(target);
    deleted.push(target);
  }
  if (!opts.withProject) {
    return { deleted, environmentDeleted: false, projectDeleted: false };
  }
  let empty = await exec.environmentIsEmpty();
  for (let i = 0; i < wait.attempts && !empty; i++) {
    await wait.sleep(wait.intervalMs);
    empty = await exec.environmentIsEmpty();
  }
  if (!empty) {
    return {
      deleted,
      environmentDeleted: false,
      projectDeleted: false,
      note: [
        `--with-project: the ${deleted.length} resource(s) above were deleted, and the environment is`,
        `still not empty after ${(wait.attempts * wait.intervalMs) / 1000}s. Coolify deletes on a queue, so this is either a slow`,
        "queue or a resource that did not go. cast will not delete a project it cannot see is",
        "empty. Nothing else was touched — re-run `cast destroy … --with-project` once the",
        "environment is clear, and it will pick up from here.",
      ].join("\n"),
    };
  }
  await exec.deleteEnvironment();
  await exec.deleteProject();
  return { deleted, environmentDeleted: true, projectDeleted: true };
}

export function renderDestroyResult(
  outcome: DestroyOutcome,
  ctx: { project: string; environment: string },
): string {
  const lines = [""];
  lines.push(
    outcome.deleted.length === 0
      ? "deleted nothing"
      : `deleted (queued with Coolify): ${outcome.deleted.map((t) => `${t.kind} ${t.name}`).join(", ")}`,
  );
  if (outcome.environmentDeleted) {
    lines.push(`deleted environment "${ctx.environment}" (empty)`);
  }
  if (outcome.projectDeleted) {
    lines.push(`deleted project "${ctx.project}" (empty)`);
  }
  if (outcome.note) lines.push("", outcome.note);
  return lines.join("\n");
}
