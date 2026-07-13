import type { Bindings } from "./bindings.js";

// A fleet run is N project runs and ONE verdict — and the verdict is the part
// that has to be right. Every other command in cast answers a question about a
// project the operator named; `--all` answers a question about a set nobody
// enumerated by hand, which means the report's COVERAGE is as load-bearing as
// its content. "Nothing to report" and "I looked at nothing" must never render
// the same, so a project is only ever one of these four things, and the one
// that does not exist is "skipped".
export type ProjectOutcome =
  | { repo: string; status: "clean" }
  | { repo: string; status: "drift" }
  | { repo: string; status: "applied"; mutated: string[] }
  // Everything that stopped cast from producing a result for a project it was
  // told exists: the clone failing, no manifest block for this environment, an
  // absent or undecryptable secret store, an absent Coolify project or
  // environment, any HTTP error. They collapse into one status deliberately —
  // downstream, the only thing that matters about all of them is that this
  // project WAS NOT READ, and every one of them is fatal to the fleet.
  | { repo: string; status: "unreachable"; message: string };

// The headline of an unreachable project, for the summary block. The full
// message (multi-line, and normally very much worth reading) is printed in the
// project's own section as the run reaches it; repeating it whole at the bottom
// would bury the aggregate under the detail it is meant to summarize.
function headline(message: string): string {
  return message.split("\n")[0];
}

export function renderProjectHeading(
  repo: string,
  index: number,
  total: number,
): string {
  const label = `[${index}/${total}] ${repo}`;
  return `\n── ${label} ${"─".repeat(Math.max(3, 74 - label.length))}`;
}

function coverage(registered: string[], outcomes: ProjectOutcome[]) {
  const of = (status: ProjectOutcome["status"]) =>
    outcomes.filter((o) => o.status === status).map((o) => o.repo);
  const visited = new Set(outcomes.map((o) => o.repo));
  return {
    clean: of("clean"),
    drift: of("drift"),
    applied: of("applied"),
    unreachable: outcomes.filter(
      (o): o is Extract<ProjectOutcome, { status: "unreachable" }> =>
        o.status === "unreachable",
    ),
    // Registered, and never even attempted. Only `apply` can produce these (it
    // stops at the first failure); for `diff` this is always empty, because a
    // read that stops early hides the drift in the projects it never reached.
    notReached: registered.filter((r) => !visited.has(r)),
  };
}

const list = (repos: string[]): string => repos.join(", ") || "—";

// The aggregate a human reads to decide whether to trust the run — so it leads
// with COUNTS OF PROJECTS, not counts of changes. A drifted project and an
// unreadable one are both "not clean", but only one of them is a diff result:
// the other is a hole in the report, and a report with a hole in it is not a
// clean fleet however green the projects around the hole were.
export function renderFleetDiff(
  envName: string,
  registered: string[],
  outcomes: ProjectOutcome[],
): string {
  const { clean, drift, unreachable, notReached } = coverage(
    registered,
    outcomes,
  );
  const read = clean.length + drift.length;
  const lines = [
    "",
    `fleet diff — ${envName}`,
    "",
    `  registered:   ${registered.length}  (${list(registered)})`,
    `  read:         ${read} of ${registered.length}`,
    `  clean:        ${clean.length}  ${list(clean)}`,
    `  drift:        ${drift.length}  ${list(drift)}`,
    `  UNREACHABLE:  ${unreachable.length}  ${list(unreachable.map((u) => u.repo))}`,
  ];
  for (const u of unreachable) {
    lines.push(`                   ${u.repo}: ${headline(u.message)}`);
  }
  if (notReached.length > 0) {
    // Cannot happen for `diff` (it runs every project to completion), and said
    // out loud anyway: if it ever did, the fleet's coverage would be a lie and
    // the exit code below would be a 2. Silence here would hide the one thing
    // this report is for.
    lines.push(`  NOT REACHED:  ${notReached.length}  ${list(notReached)}`);
  }
  lines.push("");
  if (unreachable.length > 0 || notReached.length > 0) {
    lines.push(
      `${unreachable.length + notReached.length} of ${registered.length} registered project(s) could not be read.`,
      "",
      "A fleet report is worth exactly its coverage. An unread project is not a clean",
      "one — it is a project cast has nothing to say about, and a silently skipped",
      "project reads exactly like a clean one (#12/#18/#22, at fleet scale). So this",
      "run is a FAILURE, not a diff result: what it read stands, but the state of this",
      "environment as a whole is UNKNOWN until every registered project answers.",
    );
  } else if (drift.length > 0) {
    lines.push(
      `all ${registered.length} registered project(s) were read; ${drift.length} ${
        drift.length === 1 ? "has" : "have"
      } drift.`,
    );
  } else {
    lines.push(
      `all ${registered.length} registered project(s) were read, and every one is clean.`,
    );
  }
  return lines.join("\n");
}

export function renderFleetApply(
  envName: string,
  registered: string[],
  outcomes: ProjectOutcome[],
): string {
  const { applied, unreachable, notReached } = coverage(registered, outcomes);
  const changed = outcomes.filter(
    (o): o is Extract<ProjectOutcome, { status: "applied" }> =>
      o.status === "applied" && o.mutated.length > 0,
  );
  const lines = [
    "",
    `fleet apply — ${envName}`,
    "",
    `  registered:   ${registered.length}  (${list(registered)})`,
    `  applied:      ${applied.length} of ${registered.length}  ${list(applied)}`,
  ];
  for (const c of changed) {
    lines.push(`                   ${c.repo}: ${c.mutated.join(", ")}`);
  }
  if (unreachable.length > 0) {
    lines.push(
      `  FAILED:       ${list(unreachable.map((u) => u.repo))}`,
      ...unreachable.map((u) => `                   ${headline(u.message)}`),
    );
  }
  if (notReached.length > 0) {
    lines.push(`  not reached:  ${notReached.length}  ${list(notReached)}`);
  }
  lines.push("");
  if (unreachable.length === 0 && notReached.length === 0) {
    lines.push(
      `all ${registered.length} registered project(s) applied.`,
      ...(changed.length === 0
        ? ["nothing changed — the fleet already matched its manifests."]
        : []),
    );
    return lines.join("\n");
  }
  lines.push(
    "STOPPED at the first failure, and deliberately: continuing to mutate a fleet after",
    "an unexplained failure is not a thing cast gets to do — the next project's apply",
    "would be a guess about whether the last one broke something it depends on.",
    "",
    notReached.length > 0
      ? `The ${notReached.length} project(s) listed as "not reached" were NOT touched. Resolve the failure`
      : "Resolve the failure",
    "and re-run: `apply` is idempotent, so re-running over the projects that already",
    "applied is a no-op.",
  );
  return lines.join("\n");
}

// The whole point of the flag, expressed as a number.
//
//   diff:  0  every registered project was READ, and every one is clean
//          1  every registered project was read, and at least one has drift
//          2  a registered project could not be read — which OUTRANKS drift,
//             because it is not a diff result at all: it is the absence of one.
//   apply: 0  every registered project applied
//          2  anything else
//
// The default is 2, not 0: a coverage gap this function does not recognize must
// fail, not pass. An exit code is the only part of this report that CI reads.
export function fleetExitCode(
  verb: "apply" | "diff",
  registered: string[],
  outcomes: ProjectOutcome[],
): number {
  const { clean, drift, applied, unreachable, notReached } = coverage(
    registered,
    outcomes,
  );
  if (unreachable.length > 0 || notReached.length > 0) return 2;
  if (verb === "apply") return applied.length === registered.length ? 0 : 2;
  if (clean.length + drift.length !== registered.length) return 2;
  return drift.length > 0 ? 1 : 0;
}

// An empty registry REFUSES. It does not report "0 projects, clean".
//
// `projectsIn` answers `[]` for a state file with no `projects:` block, and for
// one whose registry names no project in this environment. Both are the same
// thing to a fleet run: NOTHING TO ITERATE — and a fleet run over nothing prints
// exactly what a fleet run over a clean fleet prints. That equivalence is the
// entire failure this feature exists to prevent, so it is a refusal, and the
// refusal says what was looked for and what to write instead.
export function renderEmptyRegistry(
  verb: "apply" | "diff",
  envName: string,
  bindings: Bindings,
  bindingsPath: string,
): string {
  const registry = bindings.projects;
  const elsewhere = Object.entries(registry ?? {}).map(
    ([slug, project]) => `${slug} (${project.environments.join(", ")})`,
  );
  const found = !registry
    ? [
        "  found:       no `projects:` block at all — this state file predates the",
        "               registry, so it lists no projects anywhere",
      ]
    : elsewhere.length > 0
      ? [
          "  found:       a registry, but nothing registered for this environment:",
          ...elsewhere.map((e) => `                 ${e}`),
        ]
      : ["  found:       a `projects:` block with no projects in it"];
  return [
    `refusing to ${verb} --all: no projects are registered for "${envName}"`,
    "",
    `  looked for:  projects.<org>/<repo>.environments containing "${envName}"`,
    `  in:          ${bindingsPath}`,
    ...found,
    "",
    "--all iterates the registry — the list of which projects exist. An EMPTY list is",
    "not an empty fleet; it is an unanswered question. A run over no projects prints",
    'exactly what a run over a clean fleet prints, and "0 projects, clean" is the one',
    "sentence this flag exists to make impossible.",
    "",
    "Register what deploys here (or name the one repo you mean, without --all):",
    "",
    "  projects:",
    "    <org>/<repo>:",
    `      environments: [${envName}]`,
  ].join("\n");
}

// The coordinates that name ONE project, each with the reason it cannot mean
// anything across a fleet. Every one of them is a name someone else chose for a
// single project — one checkout, one Coolify project, one box's resource names —
// and none of them is true of the project next to it. Fleet-wide they are
// meaningless at best and, on `apply`, actively dangerous.
//
// Insertion order is the reporting order: the positional first, because passing
// a repo AND --all is the most likely way in here.
const SINGLE_PROJECT_COORDINATES: Record<string, string[]> = {
  "<org>/<repo>": [
    "A repo positional names the ONE project to act on. --all says: every project the",
    "registry lists for this environment. Passing both asks cast to guess which of the",
    "two you meant — and the wrong guess is either a fleet-wide act you did not ask",
    "for, or a fleet you thought you covered and did not.",
  ],
  "--path": [
    "--path is ONE project's local checkout. Fleet-wide it would resolve every project",
    "to the same working tree, and cast would diff one repo's manifest against every",
    "other project on the box — reporting each of them as an unrecognizable mess of",
    "creates and orphans.",
  ],
  "--project": [
    "--project is the name ONE project has on Coolify (the coordinate for a project",
    "somebody built by hand in the UI). Fleet-wide it would point every project in the",
    "registry at that SAME Coolify project: on `diff` that is a false report, and on",
    "`apply` it is every manifest in the fleet written into one project.",
  ],
  "--environment": [
    "--environment is the name ONE project's environment has on the wire. The projects",
    "in a fleet need not share it — a box that calls one of them `production` says",
    "nothing whatsoever about the next one — so fleet-wide it is a guess applied to",
    "projects that never agreed to it.",
  ],
  "--resource": [
    "--resource maps ONE project's manifest names onto the names some box gave the same",
    "resources. Its left-hand side is validated against that project's manifest, so",
    "across a fleet it is either an error or, worse, an alias that happens to match a",
    "different project's resource and quietly diffs the wrong thing.",
  ],
  "--hostname-overlay": [
    "--hostname-overlay names applications in ONE project's manifest (an unknown name is",
    "an error — that is the guard that makes it safe). It cannot be true of a second",
    "project's manifest, and a fleet cutover is not one file's job.",
  ],
};

// Which single-project coordinate was passed alongside --all, if any. `undefined`
// means the invocation is a legitimate fleet run.
export function fleetConflict(
  given: Record<string, unknown>,
): string | undefined {
  for (const flag of Object.keys(SINGLE_PROJECT_COORDINATES)) {
    const value = given[flag];
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return flag;
  }
  return undefined;
}

export function renderFleetConflict(
  verb: "apply" | "diff",
  flag: string,
): string {
  return [
    `refusing to ${verb}: --all cannot be combined with ${flag}`,
    "",
    ...(SINGLE_PROJECT_COORDINATES[flag] ?? []),
    "",
    `Act on one project (name its <org>/<repo>, and keep ${flag}), or act on the whole`,
    "environment (--all, and drop it). Not both.",
  ].join("\n");
}
