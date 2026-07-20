import { execFileSync } from "node:child_process";
import { createSign, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import type { Bindings } from "./bindings.js";
import type { CoolifyClient } from "./coolify.js";

// The GitHub App is the one piece of a Coolify instance cast could not
// reproduce (#7). Everything else derives from the manifest plus the state
// directory; the App was created by hand in a browser, its four identifiers
// read off a web page by eye, its private key downloaded to ~/Downloads, and
// its details fed to a script as a six-variable env pile (#5). Nothing about
// that survived in state.
//
// There is no REST endpoint that creates a GitHub App — no `POST /apps`, no
// GraphQL mutation, no `gh app` subcommand. A PAT cannot mint one at any
// scope. The ONLY programmatic path is the App Manifest flow: a browser form
// POST authenticated by the operator's existing GitHub session, followed by an
// unauthenticated code exchange. That is how Coolify's own "Create GitHub App"
// button works, and it is why this module serves an HTML page instead of
// calling an API.
//
// The flow gives us more than the manual path did, not less: its conversion
// response is the ONLY moment GitHub ever hands over the private key, the
// client secret and the webhook secret together. Today those are scattered
// across a download folder and a browser tab. Here they arrive in one JSON
// body that cast can persist deliberately (see persistCredentials).

// The manifest schema requires `hook_attributes.url` even when the webhook is
// inactive, so it gets a deliberately dead value rather than a plausible one.
// `.invalid` is reserved by RFC 2606 and can never resolve.
const DEAD_HOOK_URL = "https://example.invalid/unused";

// The loopback literal, never `localhost`. GitHub's OAuth guidance explicitly
// prefers the IP: `localhost` resolves through the host's name resolution,
// which is a thing other software on the machine can change.
const LOOPBACK = "127.0.0.1";

export const DEFAULT_CALLBACK_PORT = 8765;

// GitHub requires an App JWT's lifetime to be at most 10 minutes and tolerates
// clock skew badly, so `iat` is backdated a minute (their own documented
// advice) and `exp` is set well inside the ceiling rather than at it: 480 + 60
// = 540s of span, 60s of headroom. A JWT rejected for being one second too
// long is indistinguishable, from the operator's side, from a bad key.
const JWT_BACKDATE_SECONDS = 60;
const JWT_AHEAD_SECONDS = 480;

export type OwnerType = "Organization" | "User";

// What GitHub returns from the manifest conversion — the only body in the
// whole flow that carries secrets.
export type ManifestConversion = {
  id: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string | null;
  pem: string;
  ownerLogin: string;
  ownerType: OwnerType;
};

// Everything Coolify needs to clone with. `register` is handed these by the
// operator; `create` obtains them from GitHub. The two paths converge here and
// nowhere later — registerGithubApp is the single implementation.
export type AppCredentials = {
  appId: number;
  installationId: number;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  privateKeyPem: string;
};

// What `create` has in hand the instant the conversion returns, and what it
// persists BEFORE going anywhere near the install poll. It is an AppCredentials
// missing exactly one field, and that field is the only one recoverable later:
// GitHub will re-answer "which installation" forever, and will never re-show
// the private key or the client secret.
export type PendingAppCredentials = Omit<AppCredentials, "installationId"> & {
  installationId?: number;
};

export type RegisterResult = {
  // Coolify's OWN integer id for the App record, not GitHub's app id. It is
  // what GET /github-apps/{id}/repositories takes.
  coolifyAppId: number;
  // null when the App was already registered under this name and cast verified
  // the existing record instead of creating a second one.
  keyUuid: string | null;
  repositories: string[];
  pemPath: string;
  secretsPath: string;
};

// grok #4: GitHub asks every client to identify itself, and an absent
// User-Agent is a documented cause of 403s that look like nothing else.
// Resolved from package.json the same way `cast --version` does, and never
// fatal — a User-Agent is not worth failing a bootstrap over.
let userAgentCache: string | undefined;
export function githubUserAgent(): string {
  if (userAgentCache !== undefined) return userAgentCache;
  let version = "unknown";
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const raw: unknown = JSON.parse(readFileSync(pkgPath, "utf8")).version;
    if (typeof raw === "string") version = raw;
  } catch {
    // A missing or unreadable package.json means an odd install tree, not a
    // reason to refuse to talk to GitHub.
  }
  userAgentCache = `cast/${version}`;
  return userAgentCache;
}

// Every GitHub request in this module goes out with these.
function githubHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": githubUserAgent(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Step 2 — the name comes from state, not from a flag
// ---------------------------------------------------------------------------

// #5's footgun 1: `APP_NAME` was a free-form env var that had to equal
// `github_apps.<repo>` in environments.yaml, and the script could not know when
// it didn't. The operator passed the App's GitHub display name instead of the
// state value; nothing caught it, and every later `cast apply` failed to
// resolve the source.
//
// Dissolved structurally rather than validated after the fact: the state file
// is the authority. `--name` may SEED an absent entry, and is a hard refusal
// when it disagrees with one that exists — because at that point one of the two
// is wrong and cast cannot know which.
export function resolveAppName(opts: {
  bindings: Bindings;
  orgRepo: string;
  nameFlag?: string;
}): { name: string; seed: boolean } {
  const repoShort = opts.orgRepo.split("/")[1] ?? opts.orgRepo;
  if (opts.nameFlag !== undefined) assertUsableAppName(opts.nameFlag);
  const bound =
    opts.bindings.github_apps[opts.orgRepo] ??
    opts.bindings.github_apps[repoShort];
  if (bound !== undefined) {
    if (opts.nameFlag !== undefined && opts.nameFlag !== bound) {
      throw new Error(
        [
          `--name ${opts.nameFlag} disagrees with environments.yaml`,
          "",
          `  state says:  github_apps["${opts.orgRepo}"] = ${bound}`,
          `  --name says: ${opts.nameFlag}`,
          "",
          "The state file is the authority: that value is what every later",
          "`cast apply` resolves this repo's App by. Registering under a different",
          "name produces an App that exists and is never found. Drop --name to use",
          `${bound}, or change environments.yaml first if the state value is wrong.`,
        ].join("\n"),
      );
    }
    // Applies to a value that came from state too: environments.yaml is
    // hand-edited, and `github_apps` entries become filenames just the same.
    assertUsableAppName(bound);
    return { name: bound, seed: false };
  }
  if (opts.nameFlag === undefined) {
    throw new Error(
      [
        `no GitHub App name for ${opts.orgRepo}`,
        "",
        `  looked for:  github_apps["${opts.orgRepo}"], then github_apps["${repoShort}"]`,
        `  bound repos: ${Object.keys(opts.bindings.github_apps).join(", ") || "(none)"}`,
        "",
        "This name is the one every later `cast apply` resolves the App by, so it",
        "has to be decided here. Either add it to environments.yaml:",
        "",
        "  github_apps:",
        `    ${opts.orgRepo}: <a name for the App in Coolify>`,
        "",
        "or pass --name <name> and cast will write that line for you once the App",
        "is registered.",
      ].join("\n"),
    );
  }
  return { name: opts.nameFlag, seed: true };
}

// Write the binding cast just used into environments.yaml, keyed by the FULL
// slug (#6 — a bare `<repo>` key collides the day a second org shows up with
// the same repo short name, and this is a brand new entry, so it is written the
// way the resolver prefers).
//
// Comment-preserving: the yaml Document API edits the parsed tree in place, so
// an operator's comments, key order and blank lines survive. cast rewriting a
// hand-maintained file at all is a real intrusion, which is why it happens ONLY
// after a successful registration and only for a key that was absent.
export function seedGithubAppBinding(
  bindingsPath: string,
  orgRepo: string,
  name: string,
): void {
  const doc = parseDocument(readFileSync(bindingsPath, "utf8"));
  doc.setIn(["github_apps", orgRepo], name);
  writeFileSync(bindingsPath, doc.toString());
}

// ---------------------------------------------------------------------------
// Step 3 — the manifest, and the page that POSTs it
// ---------------------------------------------------------------------------

export function buildManifest(opts: {
  name: string;
  orgRepo: string;
  redirectUrl: string;
}): Record<string, unknown> {
  return {
    name: opts.name,
    url: `https://github.com/${opts.orgRepo}`,
    // Required by the schema even inactive — see DEAD_HOOK_URL.
    hook_attributes: { url: DEAD_HOOK_URL, active: false },
    redirect_url: opts.redirectUrl,
    public: false,
    default_events: [],
    // Clone-only. Keys are snake_case here (`pull_requests`), NOT the
    // hyphenated form the docs' reference page renders — a difference that
    // costs an App you have to delete and recreate.
    default_permissions: { contents: "read", metadata: "read" },
  };
}

export function newAppFormAction(owner: string, ownerType: OwnerType): string {
  return ownerType === "User"
    ? "https://github.com/settings/apps/new"
    : `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The page the operator's browser loads. It carries the manifest as a single
// form field and submits itself; GitHub renders a confirmation screen, and the
// operator's existing session is the authentication.
export function manifestFormPage(opts: {
  manifest: Record<string, unknown>;
  formAction: string;
  csrf: string;
  appName: string;
}): string {
  const action = `${opts.formAction}?state=${encodeURIComponent(opts.csrf)}`;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>cast: create GitHub App ${escapeHtml(opts.appName)}</title>`,
    "</head><body>",
    `<p>Submitting the App manifest for <strong>${escapeHtml(opts.appName)}</strong> to GitHub&hellip;</p>`,
    `<form id="cast-manifest" method="post" action="${escapeHtml(action)}">`,
    `<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(opts.manifest))}">`,
    '<button type="submit">Continue to GitHub</button>',
    "</form>",
    '<script>document.getElementById("cast-manifest").submit();</script>',
    "</body></html>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Step 4 — the one-shot loopback server
// ---------------------------------------------------------------------------

export type LoopbackServer = {
  port: number;
  // Where the operator points a browser to start the flow.
  startUrl: string;
  redirectUrl: string;
  manifest: Record<string, unknown>;
  // Resolves with the manifest `code`; rejects if close() is called first.
  code: Promise<string>;
  close: () => Promise<void>;
};

export async function startManifestServer(opts: {
  csrf: string;
  port?: number;
  formAction: string;
  appName: string;
  // The manifest cannot be built before the port is known (it contains the
  // redirect_url), and with port 0 the port is only known after listen().
  manifestFor: (redirectUrl: string) => Record<string, unknown>;
}): Promise<LoopbackServer> {
  let settle: ((code: string) => void) | undefined;
  let fail: ((err: Error) => void) | undefined;
  const code = new Promise<string>((res, rej) => {
    settle = res;
    fail = rej;
  });
  // The rejection is always handled by close(); without this an operator who
  // Ctrl-Cs mid-flow gets an unhandled rejection warning on the way out.
  code.catch(() => {});
  let captured = false;

  let manifest: Record<string, unknown> = {};
  let page = "";

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${LOOPBACK}`);
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    if (url.pathname === "/callback") {
      const state = url.searchParams.get("state");
      const got = url.searchParams.get("code");
      // The CSRF check. A callback carrying someone else's `state` is not a
      // slow request to retry — it is a page on the internet trying to hand
      // this server a code, so it is refused and NOT resolved. The server
      // keeps listening: refusing a forgery must not also cancel the real
      // callback the operator is still on their way to producing.
      if (state !== opts.csrf) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end(
          "state mismatch: this callback did not come from cast's flow\n",
        );
        return;
      }
      if (!got) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("no code in callback\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        '<!doctype html><html lang="en"><body><p>App created. You can close this tab and return to the terminal.</p></body></html>',
      );
      captured = true;
      settle?.(got);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(opts.port ?? DEFAULT_CALLBACK_PORT, LOOPBACK, () => res());
  });

  const port = (server.address() as AddressInfo).port;
  const redirectUrl = `http://${LOOPBACK}:${port}/callback`;
  manifest = opts.manifestFor(redirectUrl);
  page = manifestFormPage({
    manifest,
    formAction: opts.formAction,
    csrf: opts.csrf,
    appName: opts.appName,
  });

  return {
    port,
    startUrl: `http://${LOOPBACK}:${port}/`,
    redirectUrl,
    manifest,
    code,
    close: () =>
      new Promise<void>((res) => {
        if (!captured) {
          fail?.(new Error("the manifest callback never arrived"));
        }
        server.close(() => res());
        server.closeAllConnections?.();
      }),
  };
}

export function newCsrfToken(): string {
  return randomBytes(24).toString("hex");
}

// ---------------------------------------------------------------------------
// Step 5 — the code exchange
// ---------------------------------------------------------------------------

function readOwnerType(raw: unknown): OwnerType {
  return raw === "User" ? "User" : "Organization";
}

// POST /app-manifests/{code}/conversions, deliberately with NO Authorization
// header: the code itself is the credential. It is valid for one hour and is
// treated as single-use.
export async function convertManifestCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ManifestConversion> {
  const res = await fetchImpl(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: githubHeaders({ "X-GitHub-Api-Version": "2022-11-28" }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    // GitHub's own wording for both of these says nothing about the remedy,
    // and the remedy is not guessable: the code is spent, so the fix is to run
    // the whole flow again, not to retry the exchange.
    if (res.status === 404) {
      throw new Error(
        [
          "GitHub rejected the manifest code (404).",
          "",
          "The code is valid for one hour and can be exchanged once. This one is",
          "expired, already spent, or was never issued.",
          "",
          "Remedy: run `cast github-app create` again and click through the browser",
          "form once more. Nothing was registered, and no App was created on GitHub",
          "by the exchange — if the browser step DID create one, delete it first",
          "(GitHub Apps can be deleted from the org's Settings → Developer settings).",
        ].join("\n"),
      );
    }
    if (res.status === 422) {
      throw new Error(
        [
          "GitHub refused the manifest conversion (422).",
          "",
          "This is GitHub's rate-limit/abuse response on this endpoint, not a bad",
          `manifest. Body: ${body}`,
          "",
          "Remedy: wait a few minutes, then run `cast github-app create` again. If",
          "earlier attempts left half-created Apps on the org, delete them first —",
          "repeated create attempts are what trips this.",
        ].join("\n"),
      );
    }
    throw new Error(
      `POST /app-manifests/{code}/conversions → ${res.status}: ${body}`,
    );
  }
  const raw = (await res.json()) as Record<string, unknown>;
  const owner = (raw.owner ?? {}) as Record<string, unknown>;
  const id = raw.id;
  const slug = raw.slug;
  const clientId = raw.client_id;
  const pem = raw.pem;
  const clientSecret = raw.client_secret;
  const ownerLogin = owner.login;
  // Strict: this body is the only copy of these values that will ever exist.
  // A field cast cannot read is not defaulted — half-persisted credentials are
  // worse than a loud failure, because the App exists on GitHub either way and
  // only the loud failure says so.
  if (
    typeof id !== "number" ||
    typeof slug !== "string" ||
    typeof clientId !== "string" ||
    typeof clientSecret !== "string" ||
    typeof pem !== "string" ||
    typeof ownerLogin !== "string"
  ) {
    throw new Error(
      [
        "the manifest conversion response is missing fields cast needs.",
        "",
        `  got: ${JSON.stringify(Object.keys(raw))}`,
        "",
        "The App may well have been created on GitHub — check the org's Developer",
        "settings, delete it if so, and re-run. This body is the only time GitHub",
        "hands over the private key, so cast refuses to persist a partial copy.",
      ].join("\n"),
    );
  }
  return {
    id,
    slug,
    clientId,
    clientSecret,
    webhookSecret:
      typeof raw.webhook_secret === "string" ? raw.webhook_secret : null,
    pem,
    ownerLogin,
    ownerType: readOwnerType(owner.type),
  };
}

// ---------------------------------------------------------------------------
// Step 7 — recover the installation id from the App's own key
// ---------------------------------------------------------------------------

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

// An RS256 App JWT, signed with the PEM the conversion just handed over. No
// dependency: node's createSign("RSA-SHA256") IS the RS256 signature, and a
// JWT is two base64url JSON segments and that signature over them.
//
// `iss` is the CLIENT ID, not the app id: GitHub now recommends it, and both
// are accepted, so the recommended one is what cast sends.
export function mintAppJwt(opts: {
  privateKeyPem: string;
  clientId: string;
  now?: number;
}): string {
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSeconds - JWT_BACKDATE_SECONDS,
    exp: nowSeconds + JWT_AHEAD_SECONDS,
    iss: opts.clientId,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(opts.privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

// The installation id, from the App's own credential. Nothing else is needed —
// no PAT, no operator token.
//
// Deliberately NOT read from the `installation_id` GitHub appends to a
// setup_url redirect: GitHub documents that value as a hint and warns it can be
// spoofed. An installation id is the thing Coolify clones through; a wrong one
// is a silent wrong-repo grant.
//
// `undefined` means "read cleanly, not installed yet" — the state the poll
// waits out. A transport or auth failure throws instead, because "not installed
// yet" and "cast could not ask" are different facts and only one of them is
// worth waiting on.
export async function findInstallationId(opts: {
  owner: string;
  ownerType: OwnerType;
  jwt: string;
  fetchImpl?: typeof fetch;
}): Promise<number | undefined> {
  const path =
    opts.ownerType === "User"
      ? `/users/${encodeURIComponent(opts.owner)}/installation`
      : `/orgs/${encodeURIComponent(opts.owner)}/installation`;
  const res = await (opts.fetchImpl ?? fetch)(`https://api.github.com${path}`, {
    headers: githubHeaders({
      Authorization: `Bearer ${opts.jwt}`,
      "X-GitHub-Api-Version": "2022-11-28",
    }),
  });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;
  if (typeof raw.id !== "number") {
    throw new Error(
      `GET ${path} returned no usable installation id: ${JSON.stringify(raw)}`,
    );
  }
  return raw.id;
}

// Distinguishable so `create` can attach the remedy it alone can write — the
// real paths it just persisted to — without string-matching a message.
export class InstallationNeverArrivedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallationNeverArrivedError";
  }
}

// Poll while the operator clicks through the install screen in a browser.
export async function awaitInstallationId(opts: {
  owner: string;
  ownerType: OwnerType;
  privateKeyPem: string;
  clientId: string;
  attempts?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}): Promise<number> {
  const attempts = opts.attempts ?? 60;
  const intervalMs = opts.intervalMs ?? 5000;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Minted per attempt, not once: a JWT lives 8 minutes and this loop can
    // outlast that while an operator reads the install screen.
    const jwt = mintAppJwt({
      privateKeyPem: opts.privateKeyPem,
      clientId: opts.clientId,
      now: opts.now?.(),
    });
    const id = await findInstallationId({
      owner: opts.owner,
      ownerType: opts.ownerType,
      jwt,
      fetchImpl: opts.fetchImpl,
    });
    if (id !== undefined) return id;
    if (attempt === 0) {
      opts.log?.("waiting for the App to be installed…");
    }
    await sleep(intervalMs);
  }
  // Only the FACT belongs here. This function does not know where — or
  // whether — anything was persisted, and the previous version of this message
  // asserted that credentials were "already there" on exactly the path where
  // they were not (all three reviewers, #124). The caller that owns the files
  // owns the remedy: see createGithubApp.
  throw new InstallationNeverArrivedError(
    [
      `the App was never installed on ${opts.owner}`,
      "",
      `cast polled GET /${opts.ownerType === "User" ? "users" : "orgs"}/${opts.owner}/installation`,
      `for ${Math.round((attempts * intervalMs) / 1000)}s and it stayed 404.`,
      "",
      "The App exists on GitHub — only the install step is missing.",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Where the secrets land
// ---------------------------------------------------------------------------

// The conversion response is the only time GitHub yields the PEM, the client
// secret and the webhook secret, so cast persists all three — in the state
// directory the operator points it at, never anywhere of its own (public tool,
// private state).
//
// Why plaintext, 0600, and not the age store: `secrets/` is per-repo-per-env
// APPLICATION env vars (secrets.ts) — its contents are decrypted and injected
// into the deployed container, which is the last place an App private key
// should be. And `keyFileFor` throws outright where no age key exists, which is
// the incubator deployment's actual state; encrypting the one credential that
// makes disaster recovery possible behind a key that may not exist is how DR
// fails at the moment it is needed.
//
// So the guard is structural instead of cryptographic: the directory carries a
// `.gitignore` of `*`, which means an unthinking `git add -A` in the state repo
// cannot commit these, and committing them stays possible but has to be
// deliberate. See the PR body for the argument and the follow-up.
export function githubAppDir(stateDir: string): string {
  return join(stateDir, "github-apps");
}

// grok #3: `name` becomes a path segment (`<name>.pem`, `<name>.json`). It is
// operator-controlled and therefore not a security boundary — but a typo with a
// slash in it silently nests credentials under a subdirectory nobody will think
// to look in, and `..` walks out of the state directory entirely. Neither is
// worth diagnosing later, so both are refused here, at the one point where the
// name becomes a filename.
export function assertUsableAppName(name: string): void {
  const bad =
    name === ""
      ? "is empty"
      : name === "." || name === ".."
        ? "is a directory reference"
        : /[/\\]/.test(name)
          ? "contains a path separator"
          : name.includes("..")
            ? "contains `..`"
            : name.startsWith(".")
              ? "starts with a dot"
              : // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
                /[\x00-\x1f]/.test(name)
                ? "contains a control character"
                : undefined;
  if (bad === undefined) return;
  throw new Error(
    [
      `github app name ${JSON.stringify(name)} ${bad}`,
      "",
      "The name is used verbatim as a filename under <state>/github-apps/ and as",
      "the Coolify Source label that environments.yaml binds. Use a plain name",
      "like `hdb-coolify-prod`.",
    ].join("\n"),
  );
}

// Refuse a name collision BEFORE the browser flow, when nothing has been
// created and nothing can be lost (claude-bot, #124).
//
// On the `create` path a stale `<name>.pem` is a trap: the freshly minted App's
// key differs from it by construction, so the post-conversion persist would hit
// writeExclusive's refusal holding the one and only copy of a key GitHub has
// already stopped showing — and that refusal's remedy ("pass --force and
// re-run") would mean minting a SECOND App. Checked here, the answer costs
// nothing: no App exists yet.
export function preflightCredentialSlot(opts: {
  stateDir: string;
  name: string;
  force?: boolean;
}): void {
  assertUsableAppName(opts.name);
  if (opts.force === true) return;
  const dir = githubAppDir(opts.stateDir);
  const occupied = [`${opts.name}.pem`, `${opts.name}.json`]
    .map((f) => join(dir, f))
    .filter((p) => existsSync(p));
  if (occupied.length === 0) return;
  throw new Error(
    [
      `${opts.name} already has credentials on disk`,
      "",
      ...occupied.map((p) => `  ${p}`),
      "",
      "`create` mints a NEW App, whose private key cannot match the one already",
      "saved here — so this is checked now, before the browser flow, rather than",
      "after GitHub has handed over a key that would have nowhere to go.",
      "",
      "If those files are the App you want, you do not need `create`: install it",
      "on the repository and run `cast github-app register` against them.",
      "If they are a stale half-run whose App you have since deleted, move them",
      "aside or pass --force.",
    ].join("\n"),
  );
}

export function persistCredentials(opts: {
  stateDir: string;
  name: string;
  creds: PendingAppCredentials;
  org: string;
  orgRepo: string;
  force?: boolean;
}): { pemPath: string; secretsPath: string } {
  assertUsableAppName(opts.name);
  const dir = githubAppDir(opts.stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) {
    writeFileSync(
      ignore,
      [
        "# Written by `cast github-app`. These files are the ONLY copy of a GitHub",
        "# App's private key, client secret and webhook secret — GitHub shows them",
        "# once and never again.",
        "#",
        "# Ignored by default so that `git add -A` in this state repo cannot commit",
        "# plaintext credentials by accident. Committing them is still possible and",
        "# is a deliberate act: encrypt them first (age, sops, …) and commit the",
        "# ciphertext, or keep this directory out of the repo and back it up",
        "# somewhere that is not a git remote.",
        "*",
        "",
      ].join("\n"),
    );
  }

  const pemPath = join(dir, `${opts.name}.pem`);
  const secretsPath = join(dir, `${opts.name}.json`);
  writeExclusive(pemPath, opts.creds.privateKeyPem, opts.force === true);
  // `installation_id: null` is the honest representation of a record written
  // between the conversion and the install: everything GitHub shows once is
  // here, and the one missing field is the one GitHub will answer again.
  const record = {
    name: opts.name,
    org: opts.org,
    repo: opts.orgRepo,
    app_id: opts.creds.appId,
    installation_id: opts.creds.installationId ?? null,
    client_id: opts.creds.clientId,
    client_secret: opts.creds.clientSecret,
    webhook_secret: opts.creds.webhookSecret,
    private_key_file: `${opts.name}.pem`,
  };
  writeCredentialsRecord(secretsPath, record, opts.force === true);
  return { pemPath, secretsPath };
}

// Same refusal as writeExclusive, with ONE transition carved out: a record
// whose only difference from the incoming one is that its `installation_id` was
// null. That is the backfill `create` performs once the install lands, and it
// is not the loss writeExclusive exists to prevent — nothing irreplaceable
// changes. Anything else still refuses.
function writeCredentialsRecord(
  path: string,
  record: Record<string, unknown>,
  force: boolean,
): void {
  const next = `${JSON.stringify(record, null, 2)}\n`;
  if (existsSync(path) && !force) {
    const raw = readFileSync(path, "utf8");
    if (raw === next) return;
    if (!isInstallationBackfill(raw, record)) {
      throw refusalToOverwrite(path);
    }
  }
  writeFileSync(path, next, { mode: 0o600 });
}

function isInstallationBackfill(
  existing: string,
  next: Record<string, unknown>,
): boolean {
  let prev: Record<string, unknown>;
  try {
    prev = JSON.parse(existing) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (prev === null || typeof prev !== "object") return false;
  // Only ever fills a null in; never overwrites an id with a different one.
  if (prev.installation_id !== null) return false;
  if (typeof next.installation_id !== "number") return false;
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    if (key === "installation_id") continue;
    if (prev[key] !== next[key]) return false;
  }
  return true;
}

// Idempotent when the content matches, a refusal when it does not. Overwriting
// a DIFFERENT credential silently is how the one copy of a private key is lost.
function writeExclusive(path: string, content: string, force: boolean): void {
  if (existsSync(path) && !force) {
    if (readFileSync(path, "utf8") === content) return;
    throw refusalToOverwrite(path);
  }
  writeFileSync(path, content, { mode: 0o600 });
}

// The remedy here is honest for `register`, where re-running is cheap and
// nothing is minted. `create` can no longer reach this refusal: it is
// pre-flighted before the browser flow (preflightCredentialSlot), so by the
// time a create-path persist runs, the slot is either clean or an exact match.
function refusalToOverwrite(path: string): Error {
  return new Error(
    [
      `refusing to overwrite ${path}`,
      "",
      "It already holds different content. For a GitHub App private key that is",
      "the only copy in existence — GitHub will not show it again — so cast will",
      "not replace it without being told to.",
      "",
      "Move it aside, or pass --force if the existing file is stale (e.g. a",
      "previous `create` attempt whose App you have since deleted).",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Steps 8 + 9 — the register code path. `create` falls through into THIS.
// ---------------------------------------------------------------------------

// Read the repo list back off a Coolify GitHub App record. Coolify proxies
// GitHub with the installation token, so this answers the only question that
// matters: can this App, as registered, actually see the repo cast will ask it
// to clone?
export async function readAppRepositories(
  client: CoolifyClient,
  coolifyAppId: number,
): Promise<string[] | undefined> {
  const raw = (await client.get(
    `/github-apps/${coolifyAppId}/repositories`,
  )) as unknown;
  const list = Array.isArray(raw)
    ? raw
    : ((raw as Record<string, unknown> | null)?.repositories ?? null);
  if (!Array.isArray(list)) return undefined;
  const names: string[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) return undefined;
    const row = item as Record<string, unknown>;
    if (typeof row.full_name === "string") {
      names.push(row.full_name);
      continue;
    }
    const owner = (row.owner ?? {}) as Record<string, unknown>;
    if (typeof owner.login === "string" && typeof row.name === "string") {
      names.push(`${owner.login}/${row.name}`);
      continue;
    }
    // One unreadable row makes the whole read unreadable: a partial list is
    // indistinguishable from a complete one, and this list is the evidence for
    // a claim ("the App can clone this repo") that must not be made loosely.
    return undefined;
  }
  return names;
}

// grok #2: the repo-visibility failure tells the operator to re-run `register`
// to re-check — and re-running used to re-POST the key and the App first. That
// is only harmless if Coolify de-dupes by name, and it does not. Coolify's own
// GithubController@create validates `'name' => 'required|string|max:255'` —
// no `unique` rule — and then calls a plain `GithubApp::create($payload)`. The
// vendored OpenAPI agrees by omission: the create response documents 201/400/
// 401/422 and no conflict at all. So a second `register` under the same name
// yields a second Source, and the remedy printed by a failed post-condition
// quietly multiplies the thing it is asking the operator to fix.
//
// Fixed by looking first. This turns "re-run register to re-check" into what
// its own wording already promised — a re-check — and leaves the create path
// unchanged, since a clean instance has nothing to find.
export type ExistingApp = { id: number; appId: number | undefined };

// `undefined` means "cast could not read the list", which is NOT the same as
// "there is nothing there" — see the caller for why that distinction does not
// become a refusal here.
export async function findRegisteredApp(
  client: CoolifyClient,
  name: string,
): Promise<ExistingApp[] | undefined> {
  let raw: unknown;
  try {
    raw = await client.get("/github-apps");
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  const found: ExistingApp[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    if (row.name !== name || typeof row.id !== "number") continue;
    found.push({
      id: row.id,
      appId: typeof row.app_id === "number" ? row.app_id : undefined,
    });
  }
  return found;
}

// Register the App with Coolify and PROVE it works.
//
// The two POSTs are the script's, unchanged in effect. The GET is the step that
// matters most: today a misconfigured App fails silently and surfaces hours
// later as an unresolvable source at `cast apply` time, in a different command
// on a different day. Here it is a hard error at creation, next to the thing
// that caused it.
export async function registerGithubApp(opts: {
  client: CoolifyClient;
  name: string;
  org: string;
  orgRepo: string;
  creds: AppCredentials;
  stateDir: string;
  force?: boolean;
  log?: (line: string) => void;
}): Promise<RegisterResult> {
  const log = opts.log ?? ((line: string) => console.log(line));

  // Persist BEFORE the Coolify calls. If Coolify refuses, the credentials are
  // still on disk and `register` can be re-run against them; the reverse order
  // loses the private key to a failed HTTP call.
  const { pemPath, secretsPath } = persistCredentials({
    stateDir: opts.stateDir,
    name: opts.name,
    creds: opts.creds,
    org: opts.org,
    orgRepo: opts.orgRepo,
    force: opts.force,
  });
  log(`private key  → ${pemPath}`);
  log(`credentials  → ${secretsPath}`);

  // Look before creating (grok #2). Both verbs do this, so `create`'s
  // fall-through remains an identity of behaviour: the same call sequence,
  // in the same order, whichever verb produced the credentials.
  const existing = await findRegisteredApp(opts.client, opts.name);
  if (existing === undefined) {
    // Deliberately a warning and not a refusal. An unreadable list leaves cast
    // exactly where it was before this check existed — it might create a
    // duplicate — whereas refusing would block the bootstrap command outright
    // on an instance whose list endpoint is restricted. The failure mode of
    // proceeding is a spare Source the operator can delete; the failure mode of
    // refusing is no Source at all. Said out loud rather than assumed away.
    log(
      "warning: could not list existing Coolify Sources; cannot check whether",
    );
    log(`         ${opts.name} is already registered. Proceeding to create.`);
  }
  if (existing !== undefined && existing.length > 1) {
    throw new Error(
      [
        `Coolify already has ${existing.length} GitHub App records named ${opts.name}`,
        "",
        `  coolify ids: ${existing.map((e) => e.id).join(", ")}`,
        "",
        "Coolify does not enforce unique Source names, so cast cannot tell which",
        "of these `cast apply` would resolve. Delete the duplicates from Coolify's",
        "Sources page, leaving the one that is correctly installed, then re-run.",
      ].join("\n"),
    );
  }
  const reuse = existing?.[0];
  if (
    reuse !== undefined &&
    reuse.appId !== undefined &&
    reuse.appId !== opts.creds.appId
  ) {
    throw new Error(
      [
        `Coolify already has a GitHub App named ${opts.name}, and it is a DIFFERENT App`,
        "",
        `  registered: github app id ${reuse.appId} (coolify id ${reuse.id})`,
        `  supplied:   github app id ${opts.creds.appId}`,
        "",
        "Registering these credentials would leave two Sources with one name and",
        "no way for `cast apply` to tell them apart. Either delete the old record",
        "from Coolify's Sources page, or bind this App to a different name in",
        "environments.yaml.",
      ].join("\n"),
    );
  }

  let coolifyAppId: number;
  let keyUuid: string | null = null;
  if (reuse !== undefined) {
    // The verify-only path. Nothing is POSTed, so a failed post-condition can
    // be re-checked as many times as the operator needs.
    coolifyAppId = reuse.id;
    log(
      `already registered as ${opts.name} (coolify id ${coolifyAppId}) — verifying, not re-creating`,
    );
  } else {
    ({ coolifyAppId, keyUuid } = await createCoolifyApp(opts, log));
  }

  const repositories = await readAppRepositories(opts.client, coolifyAppId);
  if (repositories === undefined) {
    throw new Error(
      [
        `cannot verify that ${opts.name} can reach ${opts.orgRepo}`,
        "",
        `GET /github-apps/${coolifyAppId}/repositories did not return a repository`,
        "list cast can read. The App IS registered — this is a failed check, not a",
        "failed registration — but the check is the point: an App that cannot see",
        "the repo fails at `cast apply` time instead, hours later and somewhere",
        "else.",
        "",
        "Open Coolify's Sources page and confirm the App lists the repository, or",
        "re-run this verification with `cast github-app register` once the install",
        "is fixed. Re-running re-checks the existing record; it does not create a",
        "second one.",
      ].join("\n"),
    );
  }
  if (!repositories.includes(opts.orgRepo)) {
    throw new Error(
      [
        `${opts.name} is registered but cannot see ${opts.orgRepo}`,
        "",
        `  can see: ${repositories.join(", ") || "(no repositories at all)"}`,
        "",
        "The App exists on GitHub and in Coolify; it is INSTALLED on the wrong",
        "repositories (or on none). Open",
        "  https://github.com/settings/installations",
        "or the org's Settings → GitHub Apps, grant the App access to",
        `${opts.orgRepo}, and re-run \`cast github-app register\` to re-check.`,
        "That re-check reuses the record above rather than registering a second.",
        "",
        "Left unfixed this surfaces at `cast apply` time as an unresolvable source.",
      ].join("\n"),
    );
  }
  log(`verified: ${opts.name} can clone ${opts.orgRepo} ✓`);

  return { coolifyAppId, keyUuid, repositories, pemPath, secretsPath };
}

// The two POSTs, unchanged in effect from the script's.
async function createCoolifyApp(
  opts: {
    client: CoolifyClient;
    name: string;
    org: string;
    creds: AppCredentials;
  },
  log: (line: string) => void,
): Promise<{ coolifyAppId: number; keyUuid: string }> {
  const key = (await opts.client.post("/security/keys", {
    name: `${opts.name}-key`,
    private_key: opts.creds.privateKeyPem,
  })) as { uuid: string } | null;
  const keyUuid = key?.uuid;
  if (typeof keyUuid !== "string") {
    throw new Error(
      `POST /security/keys returned no key uuid: ${JSON.stringify(key)}`,
    );
  }

  const created = (await opts.client.post("/github-apps", {
    name: opts.name,
    organization: opts.org,
    api_url: "https://api.github.com",
    html_url: "https://github.com",
    app_id: opts.creds.appId,
    installation_id: opts.creds.installationId,
    client_id: opts.creds.clientId,
    client_secret: opts.creds.clientSecret,
    webhook_secret: opts.creds.webhookSecret,
    private_key_uuid: keyUuid,
  })) as Record<string, unknown> | null;
  const coolifyAppId = created?.id;
  if (typeof coolifyAppId !== "number") {
    throw new Error(
      [
        `POST /github-apps returned no usable id: ${JSON.stringify(created)}`,
        "",
        "The App record may exist in Coolify, but cast cannot verify that it can",
        "reach the repo without that id. Check Coolify's Sources page.",
      ].join("\n"),
    );
  }
  log(`registered as ${opts.name} (coolify id ${coolifyAppId})`);
  return { coolifyAppId, keyUuid };
}

// ---------------------------------------------------------------------------
// Step 1 — the optional preflight
// ---------------------------------------------------------------------------

export type PreflightResult =
  | { kind: "admin" }
  | { kind: "not-admin"; role: string }
  | { kind: "skipped"; why: string };

// Cheap and worth it: without this the operator completes the entire browser
// dance and only THEN learns they cannot create Apps on that org.
//
// `gh` is never required — an absent or unauthenticated `gh` skips silently.
// Making a nice-to-have check into a hard dependency is how a bootstrap command
// stops working on the machine that most needs it.
export function preflightOrgAdmin(
  org: string,
  run: (file: string, args: string[]) => string = (file, args) =>
    execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
): PreflightResult {
  let out: string;
  try {
    out = run("gh", ["api", `/user/memberships/orgs/${org}`]);
  } catch {
    return {
      kind: "skipped",
      why: "gh is absent, unauthenticated, or errored",
    };
  }
  try {
    const role = (JSON.parse(out) as { role?: unknown }).role;
    if (role === "admin") return { kind: "admin" };
    return { kind: "not-admin", role: typeof role === "string" ? role : "?" };
  } catch {
    return { kind: "skipped", why: "gh returned a body cast could not read" };
  }
}

// Whether the owner is an org or a personal account — which decides the form
// URL and the installation endpoint. Read from GitHub's public, unauthenticated
// user endpoint; on any failure cast assumes an org (the overwhelmingly common
// case here) and says so rather than refusing.
export async function detectOwnerType(
  owner: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OwnerType | undefined> {
  try {
    const res = await fetchImpl(
      `https://api.github.com/users/${encodeURIComponent(owner)}`,
      { headers: githubHeaders() },
    );
    if (!res.ok) return undefined;
    const raw = (await res.json()) as Record<string, unknown>;
    return raw.type === "User" ? "User" : "Organization";
  } catch {
    return undefined;
  }
}

export function openBrowser(
  url: string,
  run: (file: string, args: string[]) => void = (file, args) => {
    execFileSync(file, args, { stdio: "ignore" });
  },
): boolean {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    run(opener, [url]);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// `create` — the manifest flow, falling through into registerGithubApp
// ---------------------------------------------------------------------------

// #5's footgun 3: the script required WEBHOOK_SECRET even for an App whose
// webhook is inactive — the correct configuration for a tailnet-only Coolify
// where deliveries can never arrive and deploys are CI-triggered — so operators
// invented a placeholder by hand. `create` gets a real one from GitHub;
// `register` generates one and says so.
export function generateWebhookSecret(): string {
  return randomBytes(16).toString("hex");
}

export type CreateDeps = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  openUrl?: (url: string) => boolean;
  log?: (line: string) => void;
  runGh?: (file: string, args: string[]) => string;
  installAttempts?: number;
  installIntervalMs?: number;
};

// The whole browser flow, ending in EXACTLY the code path `register` runs.
// There is no second registration implementation: everything above this line
// exists to produce an AppCredentials, and everything below the call to
// registerGithubApp is registerGithubApp's.
export async function createGithubApp(opts: {
  client: CoolifyClient;
  orgRepo: string;
  name: string;
  stateDir: string;
  port?: number;
  force?: boolean;
  ownerType?: OwnerType;
  deps?: CreateDeps;
}): Promise<RegisterResult> {
  const deps = opts.deps ?? {};
  const log = deps.log ?? ((line: string) => console.log(line));
  const org = opts.orgRepo.split("/")[0] ?? opts.orgRepo;

  // Before ANY of it — before the browser, before GitHub mints anything. A
  // name collision discovered here costs nothing; discovered after the
  // conversion it costs the private key of an App that now exists.
  preflightCredentialSlot({
    stateDir: opts.stateDir,
    name: opts.name,
    force: opts.force,
  });

  const ownerType =
    opts.ownerType ??
    (await detectOwnerType(org, deps.fetchImpl)) ??
    "Organization";

  // Step 1 — optional, cheap, and it saves the operator the entire browser
  // dance when the answer is no.
  if (ownerType === "Organization") {
    const pre =
      deps.runGh === undefined
        ? preflightOrgAdmin(org)
        : preflightOrgAdmin(org, deps.runGh);
    if (pre.kind === "not-admin") {
      throw new Error(
        [
          `you are not an admin of ${org} (gh reports role: ${pre.role})`,
          "",
          "Only org admins can create GitHub Apps on an organization. Ask an admin",
          "to run this, or create the App on a personal account instead.",
        ].join("\n"),
      );
    }
    log(
      pre.kind === "admin"
        ? `preflight: admin of ${org} ✓`
        : `preflight: skipped (${pre.why})`,
    );
  }

  // Steps 3 + 4 — serve the form, wait for the redirect.
  const csrf = newCsrfToken();
  const server = await startManifestServer({
    csrf,
    port: opts.port,
    appName: opts.name,
    formAction: newAppFormAction(org, ownerType),
    manifestFor: (redirectUrl) =>
      buildManifest({ name: opts.name, orgRepo: opts.orgRepo, redirectUrl }),
  });

  let conversion: ManifestConversion;
  try {
    log("");
    log(
      "open this to create the App (a browser session is the authentication):",
    );
    log(`  ${server.startUrl}`);
    if ((deps.openUrl ?? openBrowser)(server.startUrl)) {
      log("  (opened in your browser)");
    }
    log("");
    const code = await server.code;
    // Step 5 — the exchange. Unauthenticated by design; the code IS the
    // credential, it lives an hour, and it is single-use.
    conversion = await convertManifestCode(code, deps.fetchImpl);
  } finally {
    await server.close();
  }

  // GitHub may have created the App under a suffixed name if ours was taken —
  // which is fine and worth saying out loud, because the name in the GitHub UI
  // and the name in Coolify are then different things. Coolify's name is a
  // local label, and it is the one environments.yaml binds.
  log(
    `created GitHub App: ${conversion.slug} (github app id ${conversion.id})`,
  );

  // PERSIST NOW — the blocker all three reviewers raised on #124.
  //
  // The conversion response is the only moment GitHub ever yields the private
  // key, the client secret and the webhook secret. Everything after this line
  // can fail for ordinary reasons and for a long time: the install poll runs
  // ~5 minutes, the operator can wander off, the network can drop, Ctrl-C is
  // one keystroke. Holding the one-shot payload in memory across all of that
  // and only writing it inside registerGithubApp meant any of those events
  // destroyed a credential GitHub will not reissue — and left the App itself
  // orphaned on GitHub, needing manual deletion.
  //
  // So the record goes to disk here, complete but for the installation id,
  // which is the ONE field GitHub will answer again as often as asked. It is
  // backfilled below once the install lands.
  const webhookSecret = conversion.webhookSecret ?? generateWebhookSecret();
  if (conversion.webhookSecret === null) {
    log(
      "github returned no webhook secret; generated one (webhook is inactive)",
    );
  }
  const pending: PendingAppCredentials = {
    appId: conversion.id,
    clientId: conversion.clientId,
    clientSecret: conversion.clientSecret,
    webhookSecret,
    privateKeyPem: conversion.pem,
  };
  const saved = persistCredentials({
    stateDir: opts.stateDir,
    name: opts.name,
    creds: pending,
    org: conversion.ownerLogin,
    orgRepo: opts.orgRepo,
    force: opts.force,
  });
  log(`private key  → ${saved.pemPath}`);
  log(`credentials  → ${saved.secretsPath}  (installation id pending)`);

  // Step 6 — install it. Always print the URL; never assume an opener.
  const installUrl = `https://github.com/apps/${conversion.slug}/installations/new`;
  log("");
  log("now install it on the repository:");
  log(`  ${installUrl}`);
  (deps.openUrl ?? openBrowser)(installUrl);
  log("");

  // Step 7 — recover the installation id from the App's own key, never from a
  // redirect parameter.
  let installationId: number;
  try {
    installationId = await awaitInstallationId({
      owner: conversion.ownerLogin,
      ownerType: conversion.ownerType,
      privateKeyPem: conversion.pem,
      clientId: conversion.clientId,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
      now: deps.now,
      attempts: deps.installAttempts,
      intervalMs: deps.installIntervalMs,
      log,
    });
  } catch (err) {
    // Now the "nothing has to be recreated" claim is TRUE, and it can name the
    // actual files rather than a directory shape. Attached here because this is
    // the only scope that knows where the persist above landed.
    if (err instanceof InstallationNeverArrivedError) {
      throw new Error(
        [
          err.message,
          "",
          "Nothing is lost. cast saved everything GitHub shows only once, before",
          "it started waiting:",
          "",
          `  ${saved.pemPath}`,
          `  ${saved.secretsPath}`,
          "",
          "Install the App from the URL above, then finish with:",
          "",
          `  cast github-app register ${opts.orgRepo} --env <env> \\`,
          `      --app-id ${conversion.id} --installation-id <id> \\`,
          `      --client-id ${conversion.clientId} \\`,
          `      --private-key ${saved.pemPath} --client-secret-stdin`,
          "",
          `The client secret and webhook secret are in ${saved.secretsPath};`,
          "the installation id is on the install's own URL, or read it from",
          "https://github.com/settings/installations.",
          "",
          "Do NOT re-run `create`: the App already exists on GitHub, and creating",
          "a second one is the thing this message exists to prevent.",
        ].join("\n"),
      );
    }
    throw err;
  }
  log(`installation id ${installationId} (recovered via the App JWT) ✓`);

  // Steps 8 + 9 — the fall-through. Identical to what `register` calls; the
  // persist inside it backfills the installation id onto the record written
  // above rather than writing a second one.
  return registerGithubApp({
    client: opts.client,
    name: opts.name,
    org: conversion.ownerLogin,
    orgRepo: opts.orgRepo,
    stateDir: opts.stateDir,
    force: opts.force,
    log,
    creds: { ...pending, installationId },
  });
}
