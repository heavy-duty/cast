import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadBindings } from "../src/bindings.js";
import { CoolifyClient } from "../src/coolify.js";
import {
  type AppCredentials,
  awaitInstallationId,
  buildManifest,
  convertManifestCode,
  createGithubApp,
  detectOwnerType,
  findInstallationId,
  manifestFormPage,
  mintAppJwt,
  newAppFormAction,
  persistCredentials,
  preflightOrgAdmin,
  readAppRepositories,
  registerGithubApp,
  resolveAppName,
  seedGithubAppBinding,
  startManifestServer,
} from "../src/github-app.js";

// WHAT THIS FILE DOES NOT TEST, said out loud because the issue asks for it
// (#7, "Testability boundary"):
//
//   - The browser form POST. It is authenticated by the operator's logged-in
//     GitHub session and there is no headless path to it. Nothing here proves
//     that GitHub accepts a `redirect_url` on http://127.0.0.1:<port> — that
//     assumption is the load-bearing one, it is unvalidated, and the first real
//     run is an operator's.
//   - Registration against a live Coolify. Every Coolify call below is mocked.
//
// What IS proven here is everything on cast's side of that line: the JSON it
// builds, the server it serves, the JWT it signs, the requests it makes, and
// what it does with each answer.

let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKeyPem = pair.privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  publicKeyPem = pair.publicKey.export({
    type: "spki",
    format: "pem",
  }) as string;
});

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function creds(over: Partial<AppCredentials> = {}): AppCredentials {
  return {
    appId: 12345,
    installationId: 99887766,
    clientId: "Iv23liABCDEF",
    clientSecret: "cs-secret",
    webhookSecret: "wh-secret",
    privateKeyPem: privateKeyPem ?? "PEM",
    ...over,
  };
}

// A Coolify whose every route is declared by the test, and which records what
// it was asked — so a test can assert on the ABSENCE of a call as easily as on
// its presence.
function coolify(
  routes: Record<string, (body: unknown) => [number, unknown]>,
): { client: CoolifyClient; hits: string[]; bodies: Record<string, unknown> } {
  const hits: string[] = [];
  const bodies: Record<string, unknown> = {};
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace("/api/v1", "");
    const key = `${init?.method ?? "GET"} ${path}`;
    hits.push(key);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (body !== undefined) bodies[key] = body;
    const route = routes[key];
    if (!route) return new Response("no such route", { status: 404 });
    const [status, payload] = route(body);
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return {
    client: new CoolifyClient("https://coolify.test", "tok", fetchImpl),
    hits,
    bodies,
  };
}

describe("the manifest cast POSTs to GitHub", () => {
  const manifest = buildManifest({
    name: "hdb-coolify-prod",
    orgRepo: "heavy-duty/incubator",
    redirectUrl: "http://127.0.0.1:8765/callback",
  });

  it("declares clone-only permissions in snake_case", () => {
    // Hyphenated keys (`pull-requests`, as the docs' reference page renders
    // them) are silently wrong and cost an App you have to delete.
    expect(manifest.default_permissions).toEqual({
      contents: "read",
      metadata: "read",
    });
    for (const key of Object.keys(
      manifest.default_permissions as Record<string, string>,
    )) {
      expect(key).not.toContain("-");
    }
  });

  it("subscribes to no events and keeps the webhook inactive on a dead url", () => {
    expect(manifest.default_events).toEqual([]);
    expect(manifest.hook_attributes).toEqual({
      // Required by the schema even when inactive, so it points at a name that
      // can never resolve (RFC 2606 reserves `.invalid`).
      url: "https://example.invalid/unused",
      active: false,
    });
  });

  it("is private, points at the repo, and redirects to the loopback LITERAL", () => {
    expect(manifest.public).toBe(false);
    expect(manifest.url).toBe("https://github.com/heavy-duty/incubator");
    expect(manifest.redirect_url).toBe("http://127.0.0.1:8765/callback");
    // Never `localhost`: it resolves through the host's name resolution, which
    // other software on the machine can change.
    expect(String(manifest.redirect_url)).not.toContain("localhost");
  });

  it("targets the org form for an org and the personal form for a user", () => {
    expect(newAppFormAction("heavy-duty", "Organization")).toBe(
      "https://github.com/organizations/heavy-duty/settings/apps/new",
    );
    expect(newAppFormAction("danmt", "User")).toBe(
      "https://github.com/settings/apps/new",
    );
  });

  it("escapes the manifest into the form field rather than breaking out of it", () => {
    const page = manifestFormPage({
      manifest: { name: 'a"><script>x</script>' },
      formAction: "https://github.com/settings/apps/new",
      csrf: "tok/en",
      appName: "x",
    });
    expect(page).not.toContain("<script>x</script>");
    expect(page).toContain("&quot;");
    // The csrf token rides the action as `state`, url-encoded.
    expect(page).toContain("state=tok%2Fen");
  });
});

describe("the loopback callback server", () => {
  it("serves the auto-submitting form and captures the code from a real request", async () => {
    // Driven with a real HTTP request against a real ephemeral server — the
    // behaviour under test is an HTTP handshake, so nothing here is stubbed.
    const server = await startManifestServer({
      csrf: "csrf-value",
      port: 0,
      appName: "hdb-coolify-prod",
      formAction:
        "https://github.com/organizations/heavy-duty/settings/apps/new",
      manifestFor: (redirectUrl) =>
        buildManifest({
          name: "hdb-coolify-prod",
          orgRepo: "heavy-duty/incubator",
          redirectUrl,
        }),
    });
    try {
      // The manifest could not have been built before listen(): with port 0 the
      // port is only known afterwards, and it is inside redirect_url.
      expect(server.manifest.redirect_url).toBe(
        `http://127.0.0.1:${server.port}/callback`,
      );

      const page = await (await fetch(server.startUrl)).text();
      expect(page).toContain('name="manifest"');
      expect(page).toContain("hdb-coolify-prod");
      expect(page).toContain("state=csrf-value");

      const res = await fetch(
        `${server.startUrl}callback?code=abc123&state=csrf-value`,
      );
      expect(res.status).toBe(200);
      expect(await server.code).toBe("abc123");
    } finally {
      await server.close();
    }
  });

  it("refuses a callback carrying the wrong state, and keeps serving the right one", async () => {
    const server = await startManifestServer({
      csrf: "the-real-token",
      port: 0,
      appName: "app",
      formAction: "https://github.com/settings/apps/new",
      manifestFor: (redirectUrl) =>
        buildManifest({ name: "app", orgRepo: "o/r", redirectUrl }),
    });
    try {
      const forged = await fetch(
        `${server.startUrl}callback?code=attacker&state=guessed`,
      );
      expect(forged.status).toBe(400);
      expect(await forged.text()).toContain("state mismatch");

      // The load-bearing half: refusing a forgery must not also cancel the
      // real callback the operator is still on their way to producing.
      const real = await fetch(
        `${server.startUrl}callback?code=genuine&state=the-real-token`,
      );
      expect(real.status).toBe(200);
      expect(await server.code).toBe("genuine");
    } finally {
      await server.close();
    }
  });

  it("400s a callback with no code at all", async () => {
    const server = await startManifestServer({
      csrf: "t",
      port: 0,
      appName: "app",
      formAction: "https://github.com/settings/apps/new",
      manifestFor: (redirectUrl) =>
        buildManifest({ name: "app", orgRepo: "o/r", redirectUrl }),
    });
    try {
      const res = await fetch(`${server.startUrl}callback?state=t`);
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("rejects the pending code when it is closed without a callback", async () => {
    const server = await startManifestServer({
      csrf: "t",
      port: 0,
      appName: "app",
      formAction: "https://github.com/settings/apps/new",
      manifestFor: (redirectUrl) =>
        buildManifest({ name: "app", orgRepo: "o/r", redirectUrl }),
    });
    const pending = server.code;
    await server.close();
    await expect(pending).rejects.toThrow(/callback never arrived/);
  });
});

describe("the App JWT", () => {
  // Verified independently: this test does not call cast's own code to check
  // cast's signature. It re-derives the segments and verifies with the PUBLIC
  // key, which is what GitHub does.
  function decode(jwt: string) {
    const [h, p, s] = jwt.split(".");
    return {
      header: JSON.parse(Buffer.from(h, "base64url").toString("utf8")),
      payload: JSON.parse(Buffer.from(p, "base64url").toString("utf8")),
      signingInput: `${h}.${p}`,
      signature: Buffer.from(s, "base64url"),
    };
  }

  it("is an RS256 signature over the two segments, verifiable with the public key", () => {
    const jwt = mintAppJwt({ privateKeyPem, clientId: "Iv23liABCDEF" });
    const { header, signingInput, signature } = decode(jwt);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(
      createVerify("RSA-SHA256")
        .update(signingInput)
        .verify(publicKeyPem, signature),
    ).toBe(true);
  });

  it("does not verify against a different key", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = mintAppJwt({ privateKeyPem, clientId: "x" });
    const { signingInput, signature } = decode(jwt);
    expect(
      createVerify("RSA-SHA256")
        .update(signingInput)
        .verify(
          other.publicKey.export({ type: "spki", format: "pem" }) as string,
          signature,
        ),
    ).toBe(false);
  });

  it("backdates iat, stays inside GitHub's 10-minute ceiling, and issues as the CLIENT id", () => {
    const now = 1_770_000_000_000;
    const nowSeconds = Math.floor(now / 1000);
    const { payload } = decode(
      mintAppJwt({ privateKeyPem, clientId: "Iv23liABCDEF", now }),
    );
    // Backdated against clock skew — GitHub's own documented advice.
    expect(payload.iat).toBe(nowSeconds - 60);
    expect(payload.iat).toBeLessThan(nowSeconds);
    // "no more than 10 minutes into the future", measured from iat. Cast sits
    // inside the ceiling rather than on it: a JWT rejected for being one second
    // too long looks exactly like a bad key from the operator's side.
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(payload.exp).toBeGreaterThan(nowSeconds);
    // `iss` is the client id, which GitHub now recommends over the app id.
    expect(payload.iss).toBe("Iv23liABCDEF");
  });
});

describe("the manifest code exchange", () => {
  const conversionBody = {
    id: 424242,
    slug: "hdb-coolify-prod",
    client_id: "Iv23liABCDEF",
    client_secret: "cs",
    webhook_secret: "wh",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n",
    owner: { login: "heavy-duty", type: "Organization" },
  };

  it("POSTs to the conversions endpoint with NO Authorization header", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(conversionBody), { status: 200 }),
    ) as unknown as typeof fetch;
    const out = await convertManifestCode("the-code", fetchImpl);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(String(url)).toBe(
      "https://api.github.com/app-manifests/the-code/conversions",
    );
    expect(init.method).toBe("POST");
    // The code IS the credential. Sending a token here is not merely
    // unnecessary — the endpoint is documented as unauthenticated.
    expect(Object.keys(init.headers)).not.toContain("Authorization");
    expect(out.clientSecret).toBe("cs");
    expect(out.ownerLogin).toBe("heavy-duty");
    expect(out.ownerType).toBe("Organization");
  });

  it("turns a 404 into the remedy, because the code is spent and retrying the exchange cannot help", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Not Found", { status: 404 }),
    ) as unknown as typeof fetch;
    await expect(convertManifestCode("c", fetchImpl)).rejects.toThrow(
      /valid for one hour[\s\S]*run `cast github-app create` again/,
    );
  });

  it("turns a 422 into the rate-limit remedy rather than 'bad manifest'", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Unprocessable", { status: 422 }),
    ) as unknown as typeof fetch;
    await expect(convertManifestCode("c", fetchImpl)).rejects.toThrow(
      /rate-limit[\s\S]*wait a few minutes/,
    );
  });

  it("refuses a partial body instead of persisting half a credential", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ...conversionBody, pem: undefined }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    await expect(convertManifestCode("c", fetchImpl)).rejects.toThrow(
      /missing fields cast needs/,
    );
  });

  it("tolerates an absent webhook secret by reporting it as absent, not empty", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ...conversionBody, webhook_secret: null }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    expect(
      (await convertManifestCode("c", fetchImpl)).webhookSecret,
    ).toBeNull();
  });
});

describe("recovering the installation id from the App's own key", () => {
  function githubFetch(
    handler: (path: string, init?: RequestInit) => Response,
  ): { impl: typeof fetch; paths: string[] } {
    const paths: string[] = [];
    const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return handler(path, init);
    }) as unknown as typeof fetch;
    return { impl, paths };
  }

  it("asks the org endpoint with the JWT as a bearer token", async () => {
    const { impl, paths } = githubFetch(
      () => new Response(JSON.stringify({ id: 5150 }), { status: 200 }),
    );
    const id = await findInstallationId({
      owner: "heavy-duty",
      ownerType: "Organization",
      jwt: "the.jwt.here",
      fetchImpl: impl,
    });
    expect(id).toBe(5150);
    expect(paths[0]).toBe("/orgs/heavy-duty/installation");
    const [, init] = (impl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(init.headers.Authorization).toBe("Bearer the.jwt.here");
  });

  it("asks the user endpoint for a personal account", async () => {
    const { impl, paths } = githubFetch(
      () => new Response(JSON.stringify({ id: 1 }), { status: 200 }),
    );
    await findInstallationId({
      owner: "danmt",
      ownerType: "User",
      jwt: "j",
      fetchImpl: impl,
    });
    expect(paths[0]).toBe("/users/danmt/installation");
  });

  it("reads a 404 as 'not installed yet' and a 500 as an error — they are different facts", async () => {
    const notInstalled = githubFetch(() => new Response("", { status: 404 }));
    expect(
      await findInstallationId({
        owner: "o",
        ownerType: "Organization",
        jwt: "j",
        fetchImpl: notInstalled.impl,
      }),
    ).toBeUndefined();

    const broken = githubFetch(() => new Response("boom", { status: 500 }));
    await expect(
      findInstallationId({
        owner: "o",
        ownerType: "Organization",
        jwt: "j",
        fetchImpl: broken.impl,
      }),
    ).rejects.toThrow(/→ 500/);
  });

  it("polls while the operator clicks through the install screen", async () => {
    let call = 0;
    const impl = vi.fn(async () => {
      call++;
      return call < 3
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify({ id: 777 }), { status: 200 });
    }) as unknown as typeof fetch;
    const slept: number[] = [];
    const id = await awaitInstallationId({
      owner: "heavy-duty",
      ownerType: "Organization",
      privateKeyPem,
      clientId: "Iv1",
      fetchImpl: impl,
      intervalMs: 5000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(id).toBe(777);
    expect(call).toBe(3);
    expect(slept).toEqual([5000, 5000]);
  });

  it("gives up with an error that says the App exists and only the install is missing", async () => {
    const impl = vi.fn(
      async () => new Response("", { status: 404 }),
    ) as unknown as typeof fetch;
    await expect(
      awaitInstallationId({
        owner: "heavy-duty",
        ownerType: "Organization",
        privateKeyPem,
        clientId: "Iv1",
        fetchImpl: impl,
        attempts: 2,
        intervalMs: 1,
        sleep: async () => {},
      }),
    ).rejects.toThrow(
      /never installed on heavy-duty[\s\S]*The App exists on GitHub/,
    );
  });
});

describe("the Coolify-facing name is resolved from state, not from a flag (#5 footgun 1)", () => {
  const bindings = (apps: Record<string, string>) =>
    loadBindings("", {
      overrideText: [
        "environments:",
        "  prod:",
        "    server: box",
        "    team: { id: 0, name: Root Team }",
        `github_apps: ${JSON.stringify(apps)}`,
        "",
      ].join("\n"),
    });

  it("uses the full-slug entry and ignores a matching --name", () => {
    const b = bindings({ "heavy-duty/incubator": "hdb-coolify-prod" });
    expect(
      resolveAppName({ bindings: b, orgRepo: "heavy-duty/incubator" }),
    ).toEqual({ name: "hdb-coolify-prod", seed: false });
    expect(
      resolveAppName({
        bindings: b,
        orgRepo: "heavy-duty/incubator",
        nameFlag: "hdb-coolify-prod",
      }).name,
    ).toBe("hdb-coolify-prod");
  });

  it("still honours a legacy bare-repo key (#6's compatibility fallback)", () => {
    expect(
      resolveAppName({
        bindings: bindings({ incubator: "legacy-name" }),
        orgRepo: "heavy-duty/incubator",
      }),
    ).toEqual({ name: "legacy-name", seed: false });
  });

  it("REFUSES a --name that disagrees with state — the footgun, dissolved", () => {
    expect(() =>
      resolveAppName({
        bindings: bindings({ "heavy-duty/incubator": "hdb-coolify-prod" }),
        orgRepo: "heavy-duty/incubator",
        nameFlag: "My Cool App",
      }),
    ).toThrow(
      /disagrees with environments.yaml[\s\S]*state file is the authority/,
    );
  });

  it("seeds from --name only when the entry is absent, and refuses when neither exists", () => {
    expect(
      resolveAppName({
        bindings: bindings({}),
        orgRepo: "heavy-duty/incubator",
        nameFlag: "hdb-coolify-prod",
      }),
    ).toEqual({ name: "hdb-coolify-prod", seed: true });
    expect(() =>
      resolveAppName({
        bindings: bindings({}),
        orgRepo: "heavy-duty/incubator",
      }),
    ).toThrow(/no GitHub App name for heavy-duty\/incubator/);
  });

  it("writes the seeded entry by FULL slug, preserving the operator's comments", () => {
    const dir = tmp("cast-bind-");
    const path = join(dir, "environments.yaml");
    const original = [
      "# the control plane's bindings — hand maintained",
      "environments:",
      "  prod:",
      "    server: box # the tailnet one",
      "    team: { id: 0, name: Root Team }",
      "",
      "github_apps: {}",
      "",
    ].join("\n");
    writeFileSync(path, original);
    seedGithubAppBinding(path, "heavy-duty/incubator", "hdb-coolify-prod");
    const after = readFileSync(path, "utf8");
    expect(after).toContain("# the control plane's bindings — hand maintained");
    expect(after).toContain("# the tailnet one");
    expect(after).toContain("heavy-duty/incubator: hdb-coolify-prod");
    // And it round-trips through the real schema.
    expect(loadBindings(path).github_apps["heavy-duty/incubator"]).toBe(
      "hdb-coolify-prod",
    );
  });
});

describe("where the secrets land", () => {
  it("writes the PEM and the other two secrets 0600, under a directory git ignores by default", () => {
    const state = tmp("cast-state-");
    const { pemPath, secretsPath } = persistCredentials({
      stateDir: state,
      name: "hdb-coolify-prod",
      creds: creds(),
      org: "heavy-duty",
      orgRepo: "heavy-duty/incubator",
    });
    expect(readFileSync(pemPath, "utf8")).toBe(creds().privateKeyPem);
    const saved = JSON.parse(readFileSync(secretsPath, "utf8"));
    // All three, because the conversion response is the ONLY time GitHub yields
    // them and `register` needs the client secret to be re-runnable at all.
    expect(saved.client_secret).toBe("cs-secret");
    expect(saved.webhook_secret).toBe("wh-secret");
    expect(saved.app_id).toBe(12345);
    expect(saved.installation_id).toBe(99887766);
    for (const p of [pemPath, secretsPath]) {
      expect(statSync(p).mode & 0o777).toBe(0o600);
    }
    // The structural half of the "loud note": `git add -A` in the state repo
    // cannot commit plaintext credentials by accident.
    const ignore = join(state, "github-apps", ".gitignore");
    expect(existsSync(ignore)).toBe(true);
    expect(readFileSync(ignore, "utf8")).toContain("*");
  });

  it("is idempotent on identical content and REFUSES to overwrite different content", () => {
    const state = tmp("cast-state-");
    const args = {
      stateDir: state,
      name: "app",
      creds: creds(),
      org: "o",
      orgRepo: "o/r",
    };
    persistCredentials(args);
    expect(() => persistCredentials(args)).not.toThrow();
    expect(() =>
      persistCredentials({
        ...args,
        creds: creds({ privateKeyPem: "a different key" }),
      }),
    ).toThrow(/refusing to overwrite[\s\S]*only copy in existence/);
    // --force is the deliberate escape hatch for a stale half-run.
    expect(() =>
      persistCredentials({
        ...args,
        creds: creds({ privateKeyPem: "a different key" }),
        force: true,
      }),
    ).not.toThrow();
  });
});

describe("registering with Coolify, and the post-condition that matters", () => {
  const ok = (payload: unknown) => () => [200, payload] as [number, unknown];

  it("uploads the key, creates the App, and PROVES it can reach the repo", async () => {
    const c = coolify({
      "POST /security/keys": ok({ uuid: "key-uuid-1" }),
      "POST /github-apps": ok({ id: 7, uuid: "app-uuid" }),
      "GET /github-apps/7/repositories": ok({
        repositories: [
          { full_name: "heavy-duty/other" },
          { full_name: "heavy-duty/incubator" },
        ],
      }),
    });
    const out = await registerGithubApp({
      client: c.client,
      name: "hdb-coolify-prod",
      org: "heavy-duty",
      orgRepo: "heavy-duty/incubator",
      creds: creds(),
      stateDir: tmp("cast-state-"),
      log: () => {},
    });

    expect(c.hits).toEqual([
      "POST /security/keys",
      "POST /github-apps",
      "GET /github-apps/7/repositories",
    ]);
    expect(c.bodies["POST /security/keys"]).toEqual({
      name: "hdb-coolify-prod-key",
      private_key: creds().privateKeyPem,
    });
    expect(c.bodies["POST /github-apps"]).toEqual({
      name: "hdb-coolify-prod",
      organization: "heavy-duty",
      api_url: "https://api.github.com",
      html_url: "https://github.com",
      app_id: 12345,
      installation_id: 99887766,
      client_id: "Iv23liABCDEF",
      client_secret: "cs-secret",
      // No invented placeholder any more (#5 footgun 3).
      webhook_secret: "wh-secret",
      private_key_uuid: "key-uuid-1",
    });
    expect(out.coolifyAppId).toBe(7);
    expect(out.repositories).toContain("heavy-duty/incubator");
  });

  it("fails HARD when the App cannot see the repo, naming what it can see", async () => {
    // The whole point of step 9. Without it this misconfiguration surfaces
    // hours later, in a different command, as an unresolvable source.
    const c = coolify({
      "POST /security/keys": ok({ uuid: "k" }),
      "POST /github-apps": ok({ id: 9 }),
      "GET /github-apps/9/repositories": ok({
        repositories: [{ full_name: "heavy-duty/something-else" }],
      }),
    });
    await expect(
      registerGithubApp({
        client: c.client,
        name: "hdb-coolify-prod",
        org: "heavy-duty",
        orgRepo: "heavy-duty/incubator",
        creds: creds(),
        stateDir: tmp("cast-state-"),
        log: () => {},
      }),
    ).rejects.toThrow(
      /cannot see heavy-duty\/incubator[\s\S]*can see: heavy-duty\/something-else/,
    );
  });

  it("fails when the repo list is UNREADABLE, rather than reporting it as empty", async () => {
    const c = coolify({
      "POST /security/keys": ok({ uuid: "k" }),
      "POST /github-apps": ok({ id: 9 }),
      "GET /github-apps/9/repositories": ok({ repositories: "not a list" }),
    });
    await expect(
      registerGithubApp({
        client: c.client,
        name: "n",
        org: "o",
        orgRepo: "o/r",
        creds: creds(),
        stateDir: tmp("cast-state-"),
        log: () => {},
      }),
    ).rejects.toThrow(/cannot verify that n can reach o\/r/);
  });

  it("persists the credentials BEFORE the Coolify calls, so a Coolify failure does not lose the key", async () => {
    const c = coolify({}); // every route 404s
    const state = tmp("cast-state-");
    await expect(
      registerGithubApp({
        client: c.client,
        name: "app",
        org: "o",
        orgRepo: "o/r",
        creds: creds(),
        stateDir: state,
        log: () => {},
      }),
    ).rejects.toThrow();
    // GitHub shows the private key once. Losing it to a failed HTTP call would
    // mean deleting the App and starting over.
    expect(existsSync(join(state, "github-apps", "app.pem"))).toBe(true);
  });

  it("reads a bare array and an owner/name pair as well as full_name", async () => {
    const c = coolify({
      "GET /github-apps/3/repositories": ok([
        { owner: { login: "heavy-duty" }, name: "incubator" },
      ]),
    });
    expect(await readAppRepositories(c.client, 3)).toEqual([
      "heavy-duty/incubator",
    ]);
  });

  it("treats ONE unreadable row as an unreadable list — a partial list reads exactly like a complete one", async () => {
    const c = coolify({
      "GET /github-apps/3/repositories": ok({
        repositories: [{ full_name: "a/b" }, { nothing: "usable" }],
      }),
    });
    expect(await readAppRepositories(c.client, 3)).toBeUndefined();
  });
});

describe("the optional org-admin preflight", () => {
  it("passes on admin and refuses on anything else", () => {
    expect(preflightOrgAdmin("heavy-duty", () => '{"role":"admin"}')).toEqual({
      kind: "admin",
    });
    expect(preflightOrgAdmin("heavy-duty", () => '{"role":"member"}')).toEqual({
      kind: "not-admin",
      role: "member",
    });
  });

  it("skips silently when gh is absent — a nice-to-have must never become a dependency", () => {
    const result = preflightOrgAdmin("heavy-duty", () => {
      throw new Error("ENOENT");
    });
    expect(result.kind).toBe("skipped");
  });
});

describe("detecting whether the owner is an org or a personal account", () => {
  it("reads the type, and falls back to undefined rather than guessing on failure", async () => {
    const okFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ type: "User" }), { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await detectOwnerType("danmt", okFetch)).toBe("User");

    const badFetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await detectOwnerType("danmt", badFetch)).toBeUndefined();
  });
});

describe("`create` falls through into `register` — one implementation, not two", () => {
  it("ends in exactly the Coolify calls `register` makes, with GitHub's own secrets", async () => {
    const conversion = {
      id: 424242,
      slug: "hdb-coolify-prod",
      client_id: "Iv23liXYZ",
      client_secret: "github-issued-secret",
      webhook_secret: "github-issued-webhook",
      pem: privateKeyPem,
      owner: { login: "heavy-duty", type: "Organization" },
    };
    // GitHub, mocked: owner type, the conversion, then the installation.
    const githubFetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/conversions"))
        return new Response(JSON.stringify(conversion), { status: 200 });
      if (u.includes("/installation"))
        return new Response(JSON.stringify({ id: 5150 }), { status: 200 });
      return new Response(JSON.stringify({ type: "Organization" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const c = coolify({
      "POST /security/keys": () => [200, { uuid: "key-uuid-1" }],
      "POST /github-apps": () => [200, { id: 11 }],
      "GET /github-apps/11/repositories": () => [
        200,
        { repositories: [{ full_name: "heavy-duty/incubator" }] },
      ],
    });

    const state = tmp("cast-state-");
    // Drive the browser step: as soon as cast prints its start url, fetch the
    // callback the way GitHub's redirect would.
    const flow = createGithubApp({
      client: c.client,
      orgRepo: "heavy-duty/incubator",
      name: "hdb-coolify-prod",
      stateDir: state,
      port: 0,
      deps: {
        fetchImpl: githubFetch,
        openUrl: (url) => {
          if (url.startsWith("http://127.0.0.1")) {
            const u = new URL(url);
            // The state parameter is not knowable from outside: read it off the
            // page cast is serving, exactly as a browser would.
            fetch(url)
              .then((r) => r.text())
              .then((page) => {
                const state = /state=([^"&]+)/.exec(page)?.[1] ?? "";
                return fetch(
                  `${u.origin}/callback?code=the-code&state=${state}`,
                );
              });
          }
          return false;
        },
        sleep: async () => {},
        runGh: () => '{"role":"admin"}',
        log: () => {},
      },
    });

    const out = await flow;
    // The fall-through, asserted as an identity of behaviour: the same three
    // calls, in the same order, that the `register`-only test above pins.
    expect(c.hits).toEqual([
      "POST /security/keys",
      "POST /github-apps",
      "GET /github-apps/11/repositories",
    ]);
    const body = c.bodies["POST /github-apps"] as Record<string, unknown>;
    expect(body.app_id).toBe(424242);
    // Recovered via the JWT path, NOT read off a setup_url redirect parameter
    // (GitHub documents that one as a spoofable hint).
    expect(body.installation_id).toBe(5150);
    expect(body.client_secret).toBe("github-issued-secret");
    expect(body.webhook_secret).toBe("github-issued-webhook");
    expect(out.coolifyAppId).toBe(11);
    // And the secrets landed, all three of them.
    expect(
      readFileSync(join(state, "github-apps", "hdb-coolify-prod.pem"), "utf8"),
    ).toBe(privateKeyPem);
  });

  it("refuses before the browser dance when gh says you are not an org admin", async () => {
    const c = coolify({});
    await expect(
      createGithubApp({
        client: c.client,
        orgRepo: "heavy-duty/incubator",
        name: "n",
        stateDir: tmp("cast-state-"),
        port: 0,
        ownerType: "Organization",
        deps: {
          runGh: () => '{"role":"member"}',
          log: () => {},
          openUrl: () => false,
        },
      }),
    ).rejects.toThrow(/not an admin of heavy-duty/);
    // Nothing was served, nothing was registered — the point of a preflight.
    expect(c.hits).toEqual([]);
  });
});
