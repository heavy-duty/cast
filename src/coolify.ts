type Json = Record<string, unknown> | unknown[] | null;

// The team a token acts as. Coolify's `Team` model carries more than this
// (description, personal_team, timestamps); cast only ever needs identity.
export type Team = { id: number; name: string };

// Thrown by req/reqText on a non-2xx response. `status` lets callers narrow
// handling (e.g. "treat 404 as absent, rethrow everything else") via
// `instanceof HttpError` without parsing the message string; the message
// format itself is unchanged (asserted by coolify.test.ts).
export class HttpError extends Error {
  constructor(
    method: string,
    path: string,
    public readonly status: number,
    body: string,
  ) {
    super(`${method} ${path} → ${status}: ${body}`);
    this.name = "HttpError";
  }
}

// A database's scheduled backup, as cast is able to read it back.
//
// `retention` is Coolify's `database_backup_retention_amount_locally` — the
// same field cast has always POSTed on create. `enabled` is carried because a
// DISABLED schedule is a row that exists and backs nothing up: reporting that
// database as backed-up is the one lie this whole path exists to prevent.
export type LiveBackup = {
  uuid: string;
  frequency: string;
  retention: number;
  enabled: boolean;
};

// The result of trying to read a database's schedules. The two absences are
// NOT the same fact and must never collapse into one another (the LiveLookup
// lesson, one level down):
//
//   []        — read cleanly, this database has NO schedule. Trustworthy, and
//               therefore real drift if the manifest declares one.
//   undefined — NOT READ: transport error, or a body cast does not recognize.
//               Says nothing. Must never become "no backups" (which would
//               invent drift, and make apply POST a duplicate schedule) nor
//               "backed up" (which would pass a cutover on an unbacked-up db).
export type BackupRead = LiveBackup[] | undefined;

// Coolify's int columns arrive as ints, but a tinyint `enabled` has no cast on
// ScheduledDatabaseBackup (v4.1.2 casts() covers only the two float storage
// fields), so it can serialize as 1/0 rather than true/false. Accept both; only
// an explicit falsey value disables. An ABSENT `enabled` is read as enabled —
// Coolify's own create path defaults it to true (DatabasesController, v4.1.2).
function readEnabled(raw: Record<string, unknown>): boolean {
  const v = raw.enabled;
  if (v === undefined || v === null) return true;
  return !(v === false || v === 0 || v === "0");
}

// Strict on purpose: a value cast cannot read EXACTLY is not coerced into a
// guess, it collapses the whole read to `undefined` (= "not compared", said out
// loud). Silence about a backup is the failure being fixed here; a wrong number
// about one would be worse than the silence.
function readInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

// Parse GET /databases/{uuid}/backups.
//
// The vendored OpenAPI documents this body as "Content is very complex. Will be
// implemented later." — so the shape here comes from the source instead:
// DatabasesController@database_backup_details_uuid (v4.1.2) ends with
//
//   $backupConfig = ScheduledDatabaseBackup::ownedByCurrentTeamAPI($teamId)
//       ->with('executions')->where('database_id', $database->id)->get();
//   return response()->json($backupConfig);
//
// i.e. a raw Eloquent collection — a JSON ARRAY of ScheduledDatabaseBackup rows
// (no API resource, no removeSensitiveData), whose columns are the model's
// $fillable: uuid, enabled, save_s3, frequency,
// database_backup_retention_amount_locally, ... plus an eager-loaded
// `executions` array cast ignores.
//
// `frequency` round-trips VERBATIM: the controller validates it
// (validate_cron_expression, which only returns a bool) and then stores
// $request->only($backupConfigFields) unchanged — there is no mutator on the
// model. So "0 3 * * *" reads back as "0 3 * * *", and the preset words
// (daily, weekly, ...) read back as themselves. That is what makes this field
// diffable at all, and it is the fact the old "spurious drift" fear assumed
// away without checking.
export function parseBackupSchedules(raw: unknown): BackupRead {
  // Not an array = not the documented collection. Unknown answer, not "none".
  if (!Array.isArray(raw)) return undefined;
  const schedules: LiveBackup[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return undefined;
    const row = item as Record<string, unknown>;
    const uuid = row.uuid;
    const frequency = row.frequency;
    const retention = readInt(row.database_backup_retention_amount_locally);
    // One unreadable row makes the whole read unreadable. A partial list would
    // be indistinguishable from a complete one to every caller downstream, and
    // the caller most worth protecting is the one asking "is this backed up?".
    if (
      typeof uuid !== "string" ||
      typeof frequency !== "string" ||
      retention === undefined
    ) {
      return undefined;
    }
    schedules.push({
      uuid,
      frequency,
      retention,
      enabled: readEnabled(row),
    });
  }
  return schedules;
}

export class CoolifyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async req(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Json> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new HttpError(method, path, res.status, await res.text());
    }
    return res.status === 204 ? null : ((await res.json()) as Json);
  }

  private async reqText(method: string, path: string): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });
    if (!res.ok) {
      throw new HttpError(method, path, res.status, await res.text());
    }
    return res.text();
  }

  get = (path: string) => this.req("GET", path);
  post = (path: string, body?: unknown) => this.req("POST", path, body);
  patch = (path: string, body?: unknown) => this.req("PATCH", path, body);
  delete_ = (path: string) => this.req("DELETE", path);

  async version(): Promise<string> {
    return this.reqText("GET", "/version");
  }

  // The team this TOKEN acts as — the question every mutation depends on
  // (see team.ts for why). GET /teams/current resolves it from the token
  // itself, not from a session: TeamController@current_team calls
  // getTeamIdFromToken() and 404s if that team is gone
  // (coollabsio/coolify v4.1.2). It is the only endpoint that answers it.
  async currentTeam(): Promise<Team> {
    const raw = (await this.get("/teams/current")) as Record<
      string,
      unknown
    > | null;
    const id = raw?.id;
    const name = raw?.name;
    // A shape we can't read is not "no team" — it's an unknown answer to the
    // one question we must not guess at. Fail rather than degrade.
    if (typeof id !== "number" || typeof name !== "string") {
      throw new Error(
        `GET /teams/current returned no usable team identity: ${JSON.stringify(raw)}`,
      );
    }
    return { id, name };
  }

  private async resolve(
    kind: string,
    listPath: string,
    name: string,
  ): Promise<string> {
    const items = (await this.get(listPath)) as Array<{
      uuid: string;
      name: string;
    }>;
    const hit = items.find((i) => i.name === name);
    if (!hit) throw new Error(`not found in Coolify: ${kind} ${name}`);
    return hit.uuid;
  }

  serverUuid = (name: string) => this.resolve("server", "/servers", name);
  githubAppUuid = (name: string) =>
    this.resolve("github app", "/github-apps", name);
  projectUuid = (name: string) => this.resolve("project", "/projects", name);

  // Every project the TOKEN can see. Team-scoped by Coolify itself, which is
  // why a sweep still asserts the team first: a wrong-team token sees nothing,
  // and "nothing" would render as "this instance is empty".
  async projects(): Promise<Array<{ uuid: string; name: string }>> {
    return (await this.get("/projects")) as Array<{
      uuid: string;
      name: string;
    }>;
  }

  // Every application the TOKEN can see, raw — the whole instance, not one
  // project. The population a create's domains are checked against, and the
  // only way cast can read it (see the domain pre-flight in cli.ts, #44).
  //
  // Two scopes have to be the same one for a pre-flight to mean anything, and
  // they are: ApplicationsController@applications lists
  // `Application::ownedByCurrentTeamAPI($teamId)`, and the create-time conflict
  // check (bootstrap/helpers/domains.php@checkIfDomainIsAlreadyUsedViaAPI,
  // v4.1.2) walks that same set. What it ALSO walks and this does not:
  // ServiceApplication fqdns and the instance-level fqdn. So this list is a
  // subset of what Coolify checks — which is why the 409 translation stays,
  // and is not dead code once the pre-flight exists.
  //
  // Raw records rather than a narrow type, because the useful fields are not
  // documented anywhere cast could import from: the vendored OpenAPI does not
  // even list `fqdn` here. The list is serialized by the SAME
  // removeSensitiveData() the per-application GET uses (ApplicationsController
  // :38, called at :130 and :1980 @ v4.1.2), so it carries every non-sensitive
  // column — `fqdn`, `docker_compose_domains`, `build_pack`, `uuid`, `name` —
  // and a per-app GET would return byte-for-byte the same fields. Reading them
  // is the caller's job (cli.ts@liveApplicationDomains).
  async applications(): Promise<Array<Record<string, unknown>>> {
    const raw = await this.get("/applications");
    return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  }

  // A project's environment NAMES.
  //
  // Two roads, because the vendored OpenAPI has been wrong before and this is a
  // discovery path — the one place where failing to enumerate is worse than
  // being slow. GET /projects/{uuid}/environments is documented; if a given
  // instance does not serve it, GET /projects/{uuid} carries the same list as a
  // relation on the project (ProjectController@show eager-loads it). Falling
  // back beats reporting "no environments" for a project that has several.
  async environments(projectUuid: string): Promise<string[]> {
    const names = (items: unknown): string[] =>
      Array.isArray(items)
        ? items
            .map((e) => (e as { name?: unknown })?.name)
            .filter((n): n is string => typeof n === "string")
        : [];
    try {
      const direct = await this.get(`/projects/${projectUuid}/environments`);
      const found = names(direct);
      if (found.length > 0) return found;
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 404) throw err;
    }
    const project = (await this.get(`/projects/${projectUuid}`)) as {
      environments?: unknown;
    } | null;
    return names(project?.environments);
  }

  // Does this environment hold anything at all?
  //
  // The LIST route above cannot answer it: an `Environment` carries id, name,
  // project_id, description, timestamps — no relations, so an environment with
  // five applications in it looks exactly like an empty one. This route is the
  // one that eager-loads them (ProjectController@environment_details, v4.1.2:
  // applications, postgresqls, redis, mongodbs, mysqls, mariadbs, services).
  //
  // The question is asked of the SHAPE rather than of those seven names: any
  // non-empty array in the response is a resource list, because everything else
  // there is a scalar. Naming the seven instead would mean a Coolify that grows
  // an eighth database type could answer "empty" about an environment holding
  // one — and this answer is the guard on a delete.
  async environmentIsEmpty(
    projectUuid: string,
    envName: string,
  ): Promise<boolean> {
    const env = (await this.get(
      `/projects/${projectUuid}/${encodeURIComponent(envName)}`,
    )) as Record<string, unknown> | null;
    // Not "empty" — unreadable. The caller must not delete on this answer.
    if (!env) return false;
    return !Object.values(env).some((v) => Array.isArray(v) && v.length > 0);
  }

  async deleteEnvironment(projectUuid: string, envName: string): Promise<void> {
    await this.delete_(
      `/projects/${projectUuid}/environments/${encodeURIComponent(envName)}`,
    );
  }

  // Coolify refuses this itself while the project still holds anything —
  // `{"message":"Project has resources, so it cannot be deleted."}`, 400
  // (ProjectController@delete_project, v4.1.2, `if (! $project->isEmpty())`,
  // where isEmpty() counts every resource in every environment of the project).
  // `cast destroy --with-project` refuses first and for the same reason, before
  // it asks for the confirmation — see destroy.ts renderProjectNotEmptiable.
  async deleteProject(projectUuid: string): Promise<void> {
    await this.delete_(`/projects/${projectUuid}`);
  }

  // Every backup CONFIGURATION for a database, with its executions.
  //
  // One call answers both halves of the only question that matters at a destroy
  // prompt — is this database backed up, and did a backup ever actually land —
  // because the route eager-loads them:
  // `ScheduledDatabaseBackup::…->with('executions')->where('database_id', …)->get()`
  // (DatabasesController@database_backup_details_uuid, v4.1.2). The separate
  // `.../backups/{uuid}/executions` route exists and is not needed here.
  //
  // Returned RAW. destroy.ts's readBackupState is the one place that decides what
  // a shape means, because the vendored OpenAPI documents this response as the
  // string "Content is very complex. Will be implemented later." and a shape cast
  // cannot read has to become "unknown", never "none".
  async databaseBackups(uuid: string): Promise<unknown> {
    return this.get(`/databases/${encodeURIComponent(uuid)}/backups`);
  }

  // A service's per-container hostnames live on `service.applications[].fqdn`,
  // and only GET /services/{uuid} loads that relation ($service->load(['appli-
  // cations','databases']), v4.1.2) — the environment-list GET that fetchLive
  // reads does NOT. So reading a service's domains back to diff them (cast#72)
  // costs this one extra GET per service. Returns the raw body; attachService-
  // Domains projects `applications[].fqdn` into the manifest's service_domains
  // shape and fails closed on any unrecognized answer.
  async serviceByUuid(uuid: string): Promise<unknown> {
    return this.get(`/services/${encodeURIComponent(uuid)}`);
  }

  // What a Coolify DELETE removes, made explicit rather than inherited.
  //
  // All four are query parameters on DELETE /applications|databases|services/{uuid},
  // and ALL FOUR DEFAULT TO TRUE — the controller reads them with
  // `$request->boolean('delete_volumes', true)` and hands them to DeleteResourceJob
  // ({Applications,Databases,Services}Controller@delete_by_uuid, v4.1.2). cast sends
  // them anyway: a default is a thing the vendor gets to change, and three of these
  // decide whether an operator's data still exists afterwards.
  //
  //   delete_volumes=true            the resource's Docker volumes are removed
  //                                  (Application::deleteVolumes → `docker volume rm -f`,
  //                                  or `docker compose down -v` for a compose app; the
  //                                  persistent-storage rows go with them). THIS is what
  //                                  makes a database delete unrecoverable, and it is why
  //                                  the plan prints a backup line for every database.
  //   delete_connected_networks=true removes the resource's OWN network — literally
  //                                  `docker network disconnect {uuid} coolify-proxy` and
  //                                  `docker network rm {uuid}` (Application::deleteConnectedNetworks,
  //                                  v4.1.2). The name is the resource's uuid, so this is
  //                                  NOT the shared destination network the rest of the box
  //                                  hangs off — a multi-project server keeps its network,
  //                                  and the two other projects on it keep running. Left at
  //                                  false it would leak a dead network per resource.
  //   delete_configurations=true     removes the resource's config directory on the server.
  //   docker_cleanup=FALSE           and this one is deliberately OFF. It is not scoped to
  //                                  the resource at all: it dispatches CleanupDocker against
  //                                  the SERVER — `docker container prune`, an image prune,
  //                                  `docker builder prune -af` (Actions/Server/CleanupDocker,
  //                                  v4.1.2) — across every project on that box. The boxes in
  //                                  this fleet are multi-project by design and one of them
  //                                  hosts third-party production. A teardown of our project
  //                                  does not get to prune somebody else's build cache. Coolify
  //                                  runs its own scheduled cleanup; it does not need ours.
  static readonly DELETE_RESOURCE_QUERY =
    "delete_volumes=true&delete_connected_networks=true&delete_configurations=true&docker_cleanup=false";

  // The DELETE itself. It ANSWERS BEFORE IT ACTS: the controller dispatches a
  // DeleteResourceJob onto the `high` queue and returns 200 "…deletion request
  // queued." So a 2xx here means "Coolify accepted the deletion", not "the
  // resource is gone" — which is exactly why --with-project waits for the
  // environment to actually read back empty before it deletes anything else.
  async deleteResource(
    kind: "application" | "database" | "service",
    uuid: string,
  ): Promise<void> {
    const base = kind === "database" ? "databases" : `${kind}s`;
    await this.delete_(
      `/${base}/${encodeURIComponent(uuid)}?${CoolifyClient.DELETE_RESOURCE_QUERY}`,
    );
  }

  // The SAME route as databaseBackups above, PARSED for the diff/apply half of
  // the story (#51). destroy reads the raw body because it decides shape-meaning
  // itself (readBackupState); diff/apply need a settled `frequency`/`retention`
  // to compare and write, so this parses on top of the one HTTP call rather than
  // duplicating it — one place fetches, two callers read it their own way.
  //
  // `undefined` means "could not read", which is a DIFFERENT fact from "has
  // none" (see BackupRead). Every failure lands on `undefined`, INCLUDING a 404:
  // it is tempting to read 404 as "no backups" (fetchLive does exactly that for a
  // missing environment), but here a 404 is Coolify saying *the database* was not
  // found, never "the database has no schedules" — the handler returns a plain
  // `[]` for that, with a 200. Reading 404 as "none" would let a mistyped uuid
  // report an unbacked-up database as clean, and let apply POST a second schedule
  // onto a database that already had one.
  async databaseBackupSchedules(uuid: string): Promise<BackupRead> {
    try {
      return parseBackupSchedules(await this.databaseBackups(uuid));
    } catch {
      return undefined;
    }
  }

  async deploy(uuid: string): Promise<void> {
    await this.post(`/deploy?uuid=${encodeURIComponent(uuid)}`);
  }
  async restart(uuid: string): Promise<void> {
    await this.post(`/services/${encodeURIComponent(uuid)}/restart`);
  }
}
