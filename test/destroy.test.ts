import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESTROY_ORDER,
  type DestroyExecutor,
  type DestroyTarget,
  executeDestroy,
  planDestroy,
  readBackupState,
  renderDestroyPlan,
} from "../src/destroy.js";
import { tmp } from "./helpers/tmp.js";

// The refusals ARE the product. `destroy` is the only verb in cast that removes
// something a manifest declared, and the difference between it and a hand
// deletion in the Coolify UI is entirely in what it declines to do — so every
// gate below is a test, and the happy path is the short section at the end.

// ---------------------------------------------------------------- unit tests

describe("DESTROY_ORDER", () => {
  it("is the create order, backwards", () => {
    expect([...DESTROY_ORDER]).toEqual(["application", "service", "database"]);
  });
});

describe("planDestroy", () => {
  const live = [
    { kind: "database" as const, name: "postgres", uuid: "d1" },
    { kind: "application" as const, name: "core", uuid: "a1" },
    { kind: "service" as const, name: "metabase", uuid: "s1" },
    { kind: "database" as const, name: "cache", uuid: "d2" },
  ];

  it("orders the deletes applications → services → databases", () => {
    const plan = planDestroy(
      [
        { kind: "application", name: "core" },
        { kind: "service", name: "metabase" },
        { kind: "database", name: "postgres" },
        { kind: "database", name: "cache" },
      ],
      live,
    );
    expect(plan.targets.map((t) => `${t.kind} ${t.name}`)).toEqual([
      "application core",
      "service metabase",
      "database cache",
      "database postgres",
    ]);
  });

  // The single most important property of this verb: a resource the manifest
  // does not declare is REPORTED, and never becomes a target. An instance-scoped
  // (or even environment-scoped) destroy is one wrong argument away from
  // deleting another project's production, and the boxes in this fleet are
  // multi-project by design.
  it("leaves what the manifest does not declare standing, and reports it", () => {
    const plan = planDestroy([{ kind: "application", name: "core" }], live);
    expect(plan.targets.map((t) => t.name)).toEqual(["core"]);
    expect(plan.undeclared).toEqual([
      { kind: "database", name: "postgres" },
      { kind: "service", name: "metabase" },
      { kind: "database", name: "cache" },
    ]);
  });

  // Same name, different kind, is a different resource — and one of them is a
  // delete of a database.
  it("matches on kind AND name, never on name alone", () => {
    const plan = planDestroy(
      [{ kind: "application", name: "postgres" }],
      [{ kind: "database", name: "postgres", uuid: "d1" }],
    );
    expect(plan.targets).toEqual([]);
    expect(plan.absent).toEqual([{ kind: "application", name: "postgres" }]);
    expect(plan.undeclared).toEqual([{ kind: "database", name: "postgres" }]);
  });

  it("reports what the manifest declares and the box does not have", () => {
    const plan = planDestroy(
      [
        { kind: "application", name: "core" },
        { kind: "application", name: "worker" },
      ],
      [{ kind: "application", name: "core", uuid: "a1" }],
    );
    expect(plan.absent).toEqual([{ kind: "application", name: "worker" }]);
  });
});

describe("readBackupState", () => {
  it("reads the schedule and the last execution that actually landed", () => {
    const state = readBackupState([
      {
        uuid: "b1",
        frequency: "0 2 * * *",
        enabled: true,
        executions: [
          { created_at: "2026-07-10T02:00:03Z", status: "success" },
          { created_at: "2026-07-13T02:00:11Z", status: "success" },
          { created_at: "2026-07-11T02:00:07Z", status: "failed" },
        ],
      },
    ]);
    expect(state.state).toBe("scheduled");
    if (state.state !== "scheduled") return;
    expect(state.schedules[0].frequency).toBe("0 2 * * *");
    // The NEWEST, not the first in the array — the ordering of the response is
    // not a thing to depend on when the answer decides whether a delete is
    // recoverable.
    expect(state.schedules[0].last?.at).toBe("2026-07-13T02:00:11Z");
    expect(state.schedules[0].executions).toBe(3);
  });

  it("says NONE only when Coolify actually says there are no backups", () => {
    expect(readBackupState([])).toEqual({ state: "none" });
  });

  // The direction that must never round the wrong way. Anything cast cannot read
  // is UNKNOWN — an unreadable backup configuration must never render as "this
  // database has no backups" (which reads as "expected, go ahead"), and equally
  // never as "backed up" (which reads as "recoverable").
  it("says UNKNOWN, never NONE, for a shape it cannot read", () => {
    for (const raw of [
      null,
      undefined,
      "Content is very complex. Will be implemented later.",
      { message: "Database not found." },
      42,
    ]) {
      const state = readBackupState(raw);
      expect(state.state).toBe("unknown");
    }
  });

  it("accepts an enveloped response rather than calling it unknown", () => {
    const state = readBackupState({
      data: [{ frequency: "0 3 * * *", executions: [] }],
    });
    expect(state.state).toBe("scheduled");
  });

  it("counts a schedule that has never run as a schedule that has never run", () => {
    const state = readBackupState([{ frequency: "0 3 * * *", executions: [] }]);
    if (state.state !== "scheduled") throw new Error("expected scheduled");
    expect(state.schedules[0].executions).toBe(0);
    expect(state.schedules[0].last).toBeUndefined();
  });
});

describe("renderDestroyPlan", () => {
  const ctx = {
    orgRepo: "heavy-duty/incubator",
    env: "staging",
    project: "incubator",
    environment: "staging",
    withProject: false,
  };

  it("says, for every database, whether deleting it is recoverable", () => {
    const targets: DestroyTarget[] = [
      {
        kind: "database",
        name: "postgres",
        uuid: "d1",
        backup: {
          state: "scheduled",
          schedules: [
            {
              frequency: "0 2 * * *",
              enabled: true,
              last: { at: "2026-07-13T02:00:11Z", status: "success" },
              executions: 12,
            },
          ],
        },
      },
      {
        kind: "database",
        name: "cache",
        uuid: "d2",
        backup: { state: "none" },
      },
      {
        kind: "database",
        name: "ledger",
        uuid: "d3",
        backup: { state: "unknown", reason: "GET … → 404" },
      },
    ];
    const out = renderDestroyPlan({ targets, absent: [], undeclared: [] }, ctx);
    expect(out).toContain("0 2 * * *");
    expect(out).toContain("2026-07-13T02:00:11Z");
    // The two that cannot be brought back say so, in the word an operator reads
    // at 2am.
    expect(out).toContain("backup schedule: NONE");
    expect(out).toContain("backup schedule: UNKNOWN");
    expect(out.match(/UNRECOVERABLE/g)?.length).toBe(2);
    // And the one that CAN does not.
    const backedUp = out.split("cache")[0];
    expect(backedUp).not.toContain("UNRECOVERABLE");
  });

  it("names what it is leaving standing", () => {
    const out = renderDestroyPlan(
      {
        targets: [{ kind: "application", name: "core", uuid: "a1" }],
        absent: [],
        undeclared: [{ kind: "service", name: "clients-site", uuid: "s9" }],
      } as never,
      ctx,
    );
    expect(out).toContain("LEFT STANDING");
    expect(out).toContain("clients-site");
  });
});

// A fake Coolify for the executor: it records the order of every call, which is
// the thing being asserted.
function fakeExecutor(opts: { emptyAfter?: number; failOn?: string } = {}) {
  const calls: string[] = [];
  let polls = 0;
  const exec: DestroyExecutor = {
    async deleteResource(t) {
      if (opts.failOn === t.name) throw new Error(`boom: ${t.name}`);
      calls.push(`delete ${t.kind} ${t.name}`);
    },
    async environmentIsEmpty() {
      polls += 1;
      return polls > (opts.emptyAfter ?? 0);
    },
    async deleteEnvironment() {
      calls.push("delete environment");
    },
    async deleteProject() {
      calls.push("delete project");
    },
  };
  return { exec, calls };
}

const plan = (targets: DestroyTarget[]) => ({
  targets,
  absent: [],
  undeclared: [],
});

const TARGETS: DestroyTarget[] = [
  { kind: "application", name: "core", uuid: "a1" },
  { kind: "service", name: "metabase", uuid: "s1" },
  { kind: "database", name: "postgres", uuid: "d1" },
];

const NO_WAIT = { attempts: 3, intervalMs: 0, sleep: async () => {} };

describe("executeDestroy", () => {
  it("deletes in reverse dependency order", async () => {
    const { exec, calls } = fakeExecutor();
    const outcome = await executeDestroy(plan(TARGETS), exec, {
      withProject: false,
    });
    expect(calls).toEqual([
      "delete application core",
      "delete service metabase",
      "delete database postgres",
    ]);
    expect(outcome.deleted).toHaveLength(3);
    expect(outcome.projectDeleted).toBe(false);
  });

  it("stops at the first failure rather than carrying on down the order", async () => {
    const { exec, calls } = fakeExecutor({ failOn: "metabase" });
    await expect(
      executeDestroy(plan(TARGETS), exec, { withProject: false }),
    ).rejects.toThrow("boom: metabase");
    // The database is still there. A teardown that continues past an unexplained
    // failure is deleting the thing the failed one may still depend on.
    expect(calls).toEqual(["delete application core"]);
  });

  // Coolify's DELETE queues a job and answers immediately, so "I deleted them"
  // is not the same claim as "they are gone" — and only one of the two makes it
  // safe to delete the project.
  it("waits for Coolify's queue before it removes the environment and project", async () => {
    const { exec, calls } = fakeExecutor({ emptyAfter: 2 });
    const outcome = await executeDestroy(plan(TARGETS), exec, {
      withProject: true,
      wait: NO_WAIT,
    });
    expect(calls).toEqual([
      "delete application core",
      "delete service metabase",
      "delete database postgres",
      "delete environment",
      "delete project",
    ]);
    expect(outcome.projectDeleted).toBe(true);
    expect(outcome.note).toBeUndefined();
  });

  it("will not delete a project it cannot see is empty", async () => {
    const { exec, calls } = fakeExecutor({ emptyAfter: 99 });
    const outcome = await executeDestroy(plan(TARGETS), exec, {
      withProject: true,
      wait: NO_WAIT,
    });
    expect(calls).not.toContain("delete environment");
    expect(calls).not.toContain("delete project");
    expect(outcome.projectDeleted).toBe(false);
    expect(outcome.note).toContain("still not empty");
  });
});

// ----------------------------------------------------------- end-to-end tests
//
// The real CLI (`dist/cli.js`), against a stub Coolify that MUTATES: a delete
// removes the resource, so the environment really does read back empty
// afterwards, and --with-project's wait is exercised rather than mocked away.

type Stub = {
  url: string;
  calls: string[];
  close: () => Promise<void>;
};

const stubs: Stub[] = [];

type Resource = { name: string; uuid: string };
type Env = {
  applications: Resource[];
  postgresqls: Resource[];
  redis: Resource[];
  services: Resource[];
};

const env = (e: Partial<Env> = {}): Env => ({
  applications: [],
  postgresqls: [],
  redis: [],
  services: [],
  ...e,
});

async function stubCoolify(
  opts: {
    environments?: Record<string, Env>;
    backups?: Record<string, unknown>;
    projects?: Array<{ uuid: string; name: string }>;
  } = {},
): Promise<Stub> {
  const environments = opts.environments ?? {
    staging: env({
      applications: [{ name: "core", uuid: "a1" }],
      postgresqls: [{ name: "postgres", uuid: "d1" }],
      redis: [{ name: "cache", uuid: "d2" }],
    }),
  };
  const projects = opts.projects ?? [{ uuid: "p1", name: "incubator" }];
  const backups = opts.backups ?? {
    d1: [
      {
        uuid: "b1",
        frequency: "0 2 * * *",
        enabled: true,
        executions: [{ created_at: "2026-07-13T02:00:11Z", status: "success" }],
      },
    ],
    d2: [],
  };
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const url = (req.url ?? "").replace("/api/v1", "");
    const path = url.split("?")[0];
    calls.push(`${req.method} ${url}`);
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/teams/current") return json({ id: 0, name: "Root Team" });
    if (req.method === "GET" && path === "/projects") return json(projects);
    if (path === "/projects/p1/environments")
      return json(Object.keys(environments).map((name) => ({ name })));
    const envMatch = path.match(/^\/projects\/p1\/([^/]+)$/);
    if (req.method === "GET" && envMatch) {
      const found = environments[envMatch[1]];
      if (!found) {
        res.writeHead(404);
        return res.end("{}");
      }
      return json(found);
    }
    const backupMatch = path.match(/^\/databases\/([^/]+)\/backups$/);
    if (req.method === "GET" && backupMatch)
      return json(backups[backupMatch[1]] ?? []);
    const del = path.match(/^\/(applications|databases|services)\/([^/]+)$/);
    if (req.method === "DELETE" && del) {
      const uuid = del[2];
      for (const e of Object.values(environments)) {
        for (const key of [
          "applications",
          "postgresqls",
          "redis",
          "services",
        ] as const) {
          e[key] = e[key].filter((r) => r.uuid !== uuid);
        }
      }
      return json({ message: "deletion request queued" });
    }
    if (
      req.method === "DELETE" &&
      path.startsWith("/projects/p1/environments/")
    )
      return json({ message: "Environment deleted." });
    if (req.method === "DELETE" && path === "/projects/p1")
      return json({ message: "Project deleted." });
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((r) => {
    server.listen(0, "127.0.0.1", r);
  });
  const stub: Stub = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  };
  stubs.push(stub);
  return stub;
}

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((s) => s.close()));
});

// core (app), postgres + cache (databases). `metabase` is deliberately NOT here:
// wherever the stub serves it, it is a resource created outside cast.
const MANIFEST = `project: incubator
environments:
  staging:
    applications:
      core:
        source: { repo: heavy-duty/incubator, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: ["http://core.example.com"]
    databases:
      postgres: { type: postgresql, version: "16" }
      cache: { type: redis }
`;

function fixture(
  url: string,
  opts: { destroyAllowed?: boolean | undefined; readOnly?: boolean } = {},
) {
  const checkout = tmp("cast-co-");
  mkdirSync(join(checkout, ".infra"), { recursive: true });
  writeFileSync(join(checkout, ".infra", "manifest.yaml"), MANIFEST);

  const state = tmp("cast-state-");
  writeFileSync(
    join(state, ".coolify.env"),
    [
      `COOLIFY_BASE_URL="${url}"`,
      'COOLIFY_ACCESS_TOKEN="t"',
      ...(opts.readOnly ? ["COOLIFY_READ_ONLY=true"] : []),
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(state, "environments.yaml"),
    [
      "environments:",
      "  staging:",
      "    server: staging-box",
      "    team: { id: 0, name: Root Team }",
      ...(opts.destroyAllowed === undefined
        ? []
        : [`    destroy_allowed: ${opts.destroyAllowed}`]),
      "github_apps:",
      "  incubator: hdb-coolify",
      "",
    ].join("\n"),
  );
  return { checkout, state };
}

function runDestroy(
  args: string[],
  opts: { stdin?: string } = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["dist/cli.js", "destroy", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => {
      output += String(d);
    });
    child.stderr.on("data", (d) => {
      output += String(d);
    });
    child.stdin.end(opts.stdin ?? "");
    child.on("close", (code) => resolve({ code: code ?? 0, output }));
  });
}

const base = (f: ReturnType<typeof fixture>) => [
  "heavy-duty/incubator",
  "--env",
  "staging",
  "--state",
  f.state,
  "--path",
  f.checkout,
];

const deletes = (stub: Stub) =>
  stub.calls.filter((c) => c.startsWith("DELETE"));

describe("cast destroy (end to end): the refusals", () => {
  // The one verb that must never iterate a fleet.
  it("refuses --all, always, and before it opens anything", async () => {
    const stub = await stubCoolify();
    const f = fixture(stub.url, { destroyAllowed: true });
    const r = await runDestroy([...base(f), "--all"], { stdin: "staging\n" });
    expect(r.code).toBe(2);
    expect(r.output).toContain("--all is not a thing destroy does");
    expect(stub.calls).toEqual([]);
  });

  // The interlock lives in state, not in argv — and absent means refuse.
  it("refuses an environment with no destroy_allowed binding", async () => {
    const stub = await stubCoolify();
    const f = fixture(stub.url);
    const r = await runDestroy(base(f), { stdin: "staging\n" });
    expect(r.code).toBe(2);
    expect(r.output).toContain("does not allow it");
    expect(r.output).toContain("destroy_allowed: true");
    expect(r.output).toContain("(absent)");
    // Nothing was even asked of Coolify: the state repo said no.
    expect(stub.calls).toEqual([]);
  });

  it("refuses destroy_allowed: false as loudly as an absent one", async () => {
    const stub = await stubCoolify();
    const f = fixture(stub.url, { destroyAllowed: false });
    const r = await runDestroy(base(f), { stdin: "staging\n" });
    expect(r.code).toBe(2);
    expect(r.output).toContain("destroy_allowed: false");
    expect(stub.calls).toEqual([]);
  });

  // The same refusal apply/smoke/server-add take, from the same assert, with the
  // same exit code (assertWritable throws, and main's handler exits 1) — an
  // instance declared for inspection cannot be written to, whatever its token
  // would permit.
  it("refuses a read-only instance", async () => {
    const stub = await stubCoolify();
    const f = fixture(stub.url, { destroyAllowed: true, readOnly: true });
    const r = await runDestroy(base(f), { stdin: "staging\n" });
    expect(r.code).toBe(1);
    expect(r.output).toContain("refusing to destroy");
    expect(r.output).toContain("read-only");
    expect(deletes(stub)).toEqual([]);
  });

  // D-237, for the verb whose empty plan is "delete nothing" — an absent project
  // must never read as a clean teardown.
  it("refuses an absent project, and names what IS there", async () => {
    const stub = await stubCoolify({
      projects: [{ uuid: "p9", name: "clients-site" }],
    });
    const f = fixture(stub.url, { destroyAllowed: true });
    const r = await runDestroy(base(f), { stdin: "staging\n" });
    expect(r.code).toBe(2);
    expect(r.output).toContain('no project named "incubator"');
    expect(r.output).toContain("clients-site");
    expect(deletes(stub)).toEqual([]);
  });

  it("refuses when the manifest declares nothing this environment holds", async () => {
    const stub = await stubCoolify({
      environments: {
        staging: env({ services: [{ name: "metabase", uuid: "s1" }] }),
      },
    });
    const f = fixture(stub.url, { destroyAllowed: true });
    const r = await runDestroy(base(f), { stdin: "staging\n" });
    expect(r.code).toBe(2);
    expect(r.output).toContain(
      "none of the 3 resource(s) the manifest declares",
    );
    expect(r.output).toContain("metabase");
    expect(deletes(stub)).toEqual([]);
  });

  it("aborts on anything but the environment's own name, typed", async () => {
    const stub = await stubCoolify();
    const f = fixture(stub.url, { destroyAllowed: true });
    for (const answer of ["y\n", "yes\n", "prod\n", ""]) {
      const r = await runDestroy(base(f), { stdin: answer });
      expect(r.code).toBe(2);
      expect(r.output).toContain("aborted — nothing deleted");
    }
    expect(deletes(stub)).toEqual([]);
  });

  // --with-project, blocked by something cast did not declare. Refused BEFORE the
  // confirmation, because Coolify would refuse the project delete after the
  // resources were already gone.
  it("refuses --with-project while an undeclared resource is in the way", async () => {
    const stub = await stubCoolify({
      environments: {
        staging: env({
          applications: [{ name: "core", uuid: "a1" }],
          postgresqls: [{ name: "postgres", uuid: "d1" }],
          redis: [{ name: "cache", uuid: "d2" }],
          services: [{ name: "metabase", uuid: "s1" }],
        }),
      },
    });
    const f = fixture(stub.url, { destroyAllowed: true });
    const r = await runDestroy([...base(f), "--with-project"], {
      stdin: "staging\n",
    });
    expect(r.code).toBe(2);
    expect(r.output).toContain("would not be empty");
    expect(r.output).toContain("metabase");
    expect(deletes(stub)).toEqual([]);
  });

  it("refuses --with-project while another environment of it holds resources", async () => {
    const stub = await stubCoolify({
      environments: {
        staging: env({
          applications: [{ name: "core", uuid: "a1" }],
          postgresqls: [{ name: "postgres", uuid: "d1" }],
          redis: [{ name: "cache", uuid: "d2" }],
        }),
        production: env({ applications: [{ name: "core", uuid: "a9" }] }),
      },
    });
    const f = fixture(stub.url, { destroyAllowed: true });
    const r = await runDestroy([...base(f), "--with-project"], {
      stdin: "staging\n",
    });
    expect(r.code).toBe(2);
    expect(r.output).toContain("would not be empty");
    expect(r.output).toContain("production");
    expect(deletes(stub)).toEqual([]);
  });
});

describe("cast destroy (end to end): what it does when it does it", () => {
  it("deletes exactly what the manifest declares, in reverse order, and says what it left", async () => {
    const stub = await stubCoolify({
      environments: {
        staging: env({
          applications: [{ name: "core", uuid: "a1" }],
          postgresqls: [{ name: "postgres", uuid: "d1" }],
          redis: [{ name: "cache", uuid: "d2" }],
          // Created outside cast. It survives this run.
          services: [{ name: "metabase", uuid: "s1" }],
        }),
      },
    });
    const f = fixture(stub.url, { destroyAllowed: true });
    const r = await runDestroy(base(f), { stdin: "staging\n" });
    expect(r.code).toBe(0);

    const del = deletes(stub).map((c) => c.split("?")[0]);
    expect(del).toEqual([
      "DELETE /applications/a1",
      "DELETE /databases/d2",
      "DELETE /databases/d1",
    ]);
    // The service nobody declared is still standing, and was said out loud.
    expect(del).not.toContain("DELETE /services/s1");
    expect(r.output).toContain("LEFT STANDING");
    expect(r.output).toContain("metabase");

    // The query cast sends, rather than the defaults it would inherit: volumes
    // and the resource's own network go, a server-wide docker prune does not.
    const query = deletes(stub)[0];
    expect(query).toContain("delete_volumes=true");
    expect(query).toContain("delete_connected_networks=true");
    expect(query).toContain("delete_configurations=true");
    expect(query).toContain("docker_cleanup=false");
  });

  it("says at the prompt which database can be brought back and which cannot", async () => {
    const stub = await stubCoolify();
    const f = fixture(stub.url, { destroyAllowed: true });
    const r = await runDestroy(base(f), { stdin: "staging\n" });
    expect(r.code).toBe(0);
    // postgres (d1) has a schedule that has run; cache (d2) has none at all.
    expect(r.output).toContain("0 2 * * *");
    expect(r.output).toContain("2026-07-13T02:00:11Z");
    expect(r.output).toContain("backup schedule: NONE");
    expect(r.output).toContain("UNRECOVERABLE");
  });

  // A backups route cast cannot read must never make a backed-up database read
  // as an unbacked one, or the reverse. It reads as UNKNOWN, and says so.
  it("prints UNKNOWN when the backups route cannot be read", async () => {
    const stub = await stubCoolify({
      backups: { d1: "not json we know", d2: [] },
    });
    const f = fixture(stub.url, { destroyAllowed: true });
    const r = await runDestroy(base(f), { stdin: "staging\n" });
    expect(r.code).toBe(0);
    expect(r.output).toContain("backup schedule: UNKNOWN");
  });

  it("--with-project removes the environment and the project once they are empty", async () => {
    const stub = await stubCoolify({
      environments: {
        staging: env({
          applications: [{ name: "core", uuid: "a1" }],
          postgresqls: [{ name: "postgres", uuid: "d1" }],
          redis: [{ name: "cache", uuid: "d2" }],
        }),
      },
    });
    const f = fixture(stub.url, { destroyAllowed: true });
    const r = await runDestroy([...base(f), "--with-project"], {
      stdin: "staging\n",
    });
    expect(r.code).toBe(0);
    const del = deletes(stub).map((c) => c.split("?")[0]);
    expect(del).toEqual([
      "DELETE /applications/a1",
      "DELETE /databases/d2",
      "DELETE /databases/d1",
      "DELETE /projects/p1/environments/staging",
      "DELETE /projects/p1",
    ]);
    expect(r.output).toContain('deleted project "incubator"');
  });
});
