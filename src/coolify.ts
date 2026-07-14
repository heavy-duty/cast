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

  async deploy(uuid: string): Promise<void> {
    await this.post(`/deploy?uuid=${encodeURIComponent(uuid)}`);
  }
  async restart(uuid: string): Promise<void> {
    await this.post(`/services/${encodeURIComponent(uuid)}/restart`);
  }
}
