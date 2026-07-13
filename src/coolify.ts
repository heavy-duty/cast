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

  async deploy(uuid: string): Promise<void> {
    await this.post(`/deploy?uuid=${encodeURIComponent(uuid)}`);
  }
  async restart(uuid: string): Promise<void> {
    await this.post(`/services/${encodeURIComponent(uuid)}/restart`);
  }
}
