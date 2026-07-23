import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tmp } from "./helpers/tmp.js";

// What remains CAST'S OWN of the release flow, after the ceremony moved
// upstream (heavy-duty/ceremony#15): the caller stubs' load-bearing shape,
// the artifact hook's install contract, the drill doctrine cast's docs must
// not lose, and the installer's three channels — REAL install.sh runs
// against throwaway roots, with a stub curl on PATH standing in for GitHub
// and a POISONED npm proving the release channels never build. Nothing here
// touches the network. The machinery the old halves of this file drove —
// notes extraction, arming, monotonicity, the drill gate — is tested
// upstream in ceremony's test/ and enforced here by the pinned actions in
// ci.yml. (`cast --version` itself is test/version-cli.test.ts's; the
// versioned LAYOUT every channel lands in is test/install-sh.test.ts's —
// here the layout is asserted only where a channel decides what fills it.)

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function run(
  cmd: string,
  args: string[],
  env: Record<string, string> = {},
  cwd?: string,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
      env: { ...process.env, ...env },
    });
    let output = "";
    child.stdout.on("data", (d) => {
      output += String(d);
    });
    child.stderr.on("data", (d) => {
      output += String(d);
    });
    child.on("close", (code) => resolve({ code: code ?? 0, output }));
  });
}

// --- the ceremony callers — the stubs' load-bearing shape -------------------
// The workflow logic lives upstream at the pin; what can still break HERE is
// the caller: its triggers, its permissions grant, its backend input, and the
// pins themselves. Fail-closed, same discipline as the old workflow pins.

describe("the ceremony callers", () => {
  const RY = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");

  it("ONE push key, both filters — a second sibling push: silently kills a door", () => {
    // YAML maps are last-key-wins (grok's round-2 catch on the old
    // workflow: the tag fallback had stopped triggering).
    expect(RY.match(/^ {2}push:$/gm)).toHaveLength(1);
    expect(RY).toContain('tags: ["**"]');
    expect(RY).toContain("branches: [main]");
    // The merge door rides push, never pull_request: a fork PR's token is
    // read-only and permissions: cannot raise it (box#97).
    expect(RY).not.toContain("pull_request:");
  });

  it("the version backend is package-json", () => {
    expect(RY).toContain("version-source: package-json");
  });

  it("every ceremony reference in .github/ names ONE tag", () => {
    // CONSUMERS.md's same-tag rule: the two workflow callers and each guard
    // step pin the same ceremony tag — one reference bumped alone leaves
    // the repo split across ceremony versions.
    const all = [
      "workflows/release.yml",
      "workflows/labels.yml",
      "workflows/ci.yml",
    ]
      .map((f) => readFileSync(join(ROOT, ".github", f), "utf8"))
      .join("\n");
    const refs = [...all.matchAll(/heavy-duty\/ceremony\/[^@\s]+@(\S+)/g)].map(
      (m) => m[1],
    );
    expect(refs.length).toBeGreaterThanOrEqual(6); // 2 callers + 4 guards
    expect(new Set(refs).size).toBe(1);
  });
});

// --- the artifact hook — the install contract the workflow used to carry ----
// The asset name `cast-X.Y.Z.tgz` and the staged layout are what the
// installer's release channels download; they never run npm or tsc, so the
// build happens ONCE, in the hook, and the asset is the runnable tree.

describe("release-artifact hook", () => {
  const HOOK = readFileSync(
    join(ROOT, ".github/actions/release-artifact/action.yml"),
    "utf8",
  );

  it("builds the prod-only tree once and stages the runnable layout", () => {
    expect(HOOK).toContain("npm ci");
    expect(HOOK).toContain("npm run build");
    expect(HOOK).toContain("npm prune --omit=dev");
    expect(HOOK).toContain("cp -R bin dist node_modules package.json");
  });

  it("drops cast-<version>.tgz into $RELEASE_ASSETS_DIR — the channels' exact download name", () => {
    expect(HOOK).toContain('"$RELEASE_ASSETS_DIR/cast-$VERSION.tgz"');
    expect(HOOK).toContain('"$RUNNER_TEMP/stage/cast-$VERSION"');
  });

  it("runs no tests — ci.yml gated the merge commit already, and the suite needs age", () => {
    expect(HOOK).not.toContain("npm test");
    expect(HOOK).not.toContain("npm run check");
  });

  it("owns its toolchain — setup-node moved INTO the hook; the shared workflow is node-free", () => {
    expect(HOOK).toContain("actions/setup-node");
  });
});

// --- the drill doctrine, in cast's own docs ---------------------------------
// The drill-recorded GATE is ceremony's (actions/drill-recorded, tested
// upstream); the MEANING is cast's. The three drills are INDEPENDENT — any
// order, any schedule, separate sittings — because each pins the same fixed
// candidate refs: static identifiers that exist as soon as the release
// branches do, which is what dissolves the box<->rig recursion. The docs
// must not re-acquire an ordering rule between repos.

describe("drills/README.md — the independent, ref-pinned drills", () => {
  it("documents the record files and the INDEPENDENT, ref-pinned drills", () => {
    const doc = readFileSync(join(ROOT, "drills/README.md"), "utf8");
    expect(doc).toContain("`<version>.md`");
    expect(doc).toMatch(/drills are independent/i);
    expect(doc).toMatch(/any order/i);
    expect(doc).toMatch(/pins the same fixed set of\s+candidate\s+refs/i);
    expect(doc).toMatch(/not sequencing/i);
    // box and rig stay mutually recursive; the pinning is what makes that a
    // non-problem, so both halves have to survive together.
    expect(doc).toMatch(/mutually recursive/);
    expect(doc).toContain("RIG_REF");
    expect(doc).toMatch(/candidate refs, not released artifacts/);
    expect(doc).toMatch(/no fixed order/i);
    // Each repo drills a different thing — which is WHY records are per-repo.
    expect(doc).toMatch(/isolation\s+contract/i);
    expect(doc).toMatch(/convergence/i);
    expect(doc).toMatch(/promotion/i);
    // Separate records, one pinned set: each cites the shared run ID.
    expect(doc).toMatch(/run ID/i);
  });
});

// --- the installer's three channels, driven for real ------------------------
// Full install.sh runs against throwaway roots. The curl on PATH is a stub
// scripted via env (CURL_*); the npm on PATH is POISONED (exits 97) unless a
// test opts into the stub build — so any release-channel install that
// touches npm fails its assertion by failing the install.

const STUB = tmp("cast-stub-");
writeFileSync(
  join(STUB, "curl"),
  `#!/usr/bin/env bash
# Stub curl — never the network. Scripted via env:
#   CURL_FAIL_ALL      nonempty -> every call exits 6 (network down)
#   CURL_REDIRECT      what -w %{redirect_url} answers (the HEAD probe)
#   CURL_SERVE_SUBSTR  substring a download URL must carry to succeed
#   CURL_TARBALL       copied to -o's target on a successful download
#   CURL_LOG           every URL asked for, one per line, appended
url="" out="" probe=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) probe=1; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [ -n "\${CURL_LOG:-}" ]; then printf '%s\\n' "$url" >> "$CURL_LOG"; fi
if [ -n "\${CURL_FAIL_ALL:-}" ]; then exit 6; fi
if [ "$probe" -eq 1 ]; then printf '%s' "\${CURL_REDIRECT:-}"; exit 0; fi
case "$url" in
  *"\${CURL_SERVE_SUBSTR:-/__nothing_succeeds__/}"*)
    cp "\${CURL_TARBALL:?}" "\${out:?}"; exit 0 ;;
  *) exit 22 ;;
esac
`,
);
writeFileSync(
  join(STUB, "npm"),
  `#!/usr/bin/env bash
# Poisoned npm: the release-asset channels must NEVER build (#96). A test
# that legitimately builds from source sets NPM_EXIT=0; every invocation is
# logged so order can be asserted.
if [ -n "\${NPM_LOG:-}" ]; then printf '%s\\n' "$*" >> "$NPM_LOG"; fi
exit "\${NPM_EXIT:-97}"
`,
);
chmodSync(join(STUB, "curl"), 0o755);
chmodSync(join(STUB, "npm"), 0o755);

// A fabricated tree shaped like release.yml's staging (one top-level
// cast-<ref>/ dir — the same shape GitHub's source tarballs have), tarred.
// Version 9.9.9 so nothing collides with the tree under test.
function makeTarball(
  work: string,
  ref: string,
  opts: { dist?: boolean; nodeModules?: boolean } = {},
): string {
  const top = join(work, `cast-${ref}`);
  mkdirSync(join(top, "bin"), { recursive: true });
  cpSync(join(ROOT, "bin/cast"), join(top, "bin/cast"));
  chmodSync(join(top, "bin/cast"), 0o755);
  if (opts.dist !== false) {
    mkdirSync(join(top, "dist"), { recursive: true });
    writeFileSync(join(top, "dist/cli.js"), `console.log("cast 9.9.9");\n`);
  }
  if (opts.nodeModules !== false) {
    mkdirSync(join(top, "node_modules"), { recursive: true });
    writeFileSync(join(top, "node_modules/.package-lock.json"), "{}");
  }
  writeFileSync(
    join(top, "package.json"),
    JSON.stringify({ name: "cast", version: "9.9.9" }),
  );
  const tgz = join(work, `cast-${ref}.tgz`);
  execFileSync("tar", ["-C", work, "-czf", tgz, `cast-${ref}`]);
  return tgz;
}

type Install = {
  code: number;
  output: string;
  dest: string;
  bin: string;
  curlLog: string[];
  npmLog: string[];
};

async function runInstall(
  env: Record<string, string>,
  opts: { preexistingDest?: boolean } = {},
): Promise<Install> {
  const work = tmp("cast-inst-");
  const dest = join(work, "dest");
  const bin = join(work, "bin");
  const curlLog = join(work, "curl.log");
  const npmLog = join(work, "npm.log");
  if (opts.preexistingDest) {
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "MARKER"), "the previous install\n");
  }
  mkdirSync(join(work, "home"), { recursive: true });
  const r = await run("bash", [join(ROOT, "install.sh")], {
    PATH: `${STUB}:${process.env.PATH}`,
    HOME: join(work, "home"),
    CAST_HOME: dest,
    CAST_BIN: bin,
    CAST_NO_MODIFY_PATH: "1",
    CURL_LOG: curlLog,
    NPM_LOG: npmLog,
    ...env,
  });
  const lines = (f: string) =>
    existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
  return {
    code: r.code,
    output: r.output,
    dest,
    bin,
    curlLog: lines(curlLog),
    npmLog: lines(npmLog),
  };
}

describe("install.sh — the three channels", () => {
  const work = tmp("cast-tarballs-");
  const asset = makeTarball(work, "9.9.9");
  const mainSrc = makeTarball(work, "main");
  const brokenAsset = makeTarball(join(work, "broken"), "9.9.9", {
    dist: false,
  });

  it("default channel: resolves the latest release and installs its PREBUILT asset — npm never runs", async () => {
    const r = await runInstall({
      CURL_REDIRECT: "https://github.com/heavy-duty/cast/releases/tag/9.9.9",
      CURL_SERVE_SUBSTR: "releases/download/9.9.9/cast-9.9.9.tgz",
      CURL_TARBALL: asset,
    });
    expect(r.output).toContain("latest release: 9.9.9");
    expect(r.code).toBe(0);
    // The download was the asset — never a source tarball...
    expect(r.curlLog.some((u) => u.includes("releases/download/"))).toBe(true);
    expect(r.curlLog.some((u) => u.includes("archive/"))).toBe(false);
    // ...and the poisoned npm was never touched.
    expect(r.npmLog).toEqual([]);
    // The channel decided WHAT arrived; the versioned layout decided WHERE:
    // the prebuilt tree landed in versions/<its package.json version>, with
    // current flipped to it and the PATH link pointing through the chain.
    expect(existsSync(join(r.dest, "versions/9.9.9/dist/cli.js"))).toBe(true);
    expect(realpathSync(join(r.dest, "current"))).toBe(
      realpathSync(join(r.dest, "versions/9.9.9")),
    );
    expect(readlinkSync(join(r.bin, "cast"))).toBe(
      join(r.dest, "current/bin/cast"),
    );
    expect(
      readFileSync(join(r.dest, "versions/9.9.9/INSTALLED_FROM"), "utf8"),
    ).toBe("heavy-duty/cast@9.9.9 (release asset)\n");
    // The installed tree runs, through the whole chain — with zero build
    // steps on this machine.
    const v = await run(join(r.bin, "cast"), []);
    expect(v.output.trim()).toBe("cast 9.9.9");
  });

  it("default channel, no releases yet: dies LOUDLY naming CAST_REF=main, installs nothing", async () => {
    // A repo with no releases redirects releases/latest to /releases —
    // GitHub's real shape (measured; rig pinned the same fact).
    const r = await runInstall({
      CURL_REDIRECT: "https://github.com/heavy-duty/cast/releases",
      CURL_SERVE_SUBSTR: "archive/refs/heads/main",
      CURL_TARBALL: mainSrc,
    });
    expect(r.code).toBe(1);
    expect(r.output).toContain("no release");
    expect(r.output).toContain("CAST_REF=main");
    // The stub would have happily served main — a silent fallback would
    // succeed here and FAIL this test. Nothing was downloaded or created.
    expect(r.curlLog.filter((u) => !u.includes("releases/latest"))).toEqual([]);
    expect(existsSync(r.dest)).toBe(false);
  });

  it("default channel: a resolved release with a missing asset refuses — no source fallback", async () => {
    const r = await runInstall({
      CURL_REDIRECT: "https://github.com/heavy-duty/cast/releases/tag/9.9.9",
      // Nothing served: the asset 404s, and so would the source tarballs.
    });
    expect(r.code).toBe(1);
    expect(r.output).toContain("no cast-9.9.9.tgz asset");
    expect(r.curlLog.some((u) => u.includes("archive/"))).toBe(false);
    expect(existsSync(r.dest)).toBe(false);
  });

  it("pinned channel: CAST_REF=<tag> installs that release's asset, resolves nothing, builds nothing", async () => {
    const r = await runInstall({
      CAST_REF: "9.9.9",
      CURL_SERVE_SUBSTR: "releases/download/9.9.9/cast-9.9.9.tgz",
      CURL_TARBALL: asset,
    });
    expect(r.code).toBe(0);
    expect(r.curlLog.some((u) => u.includes("releases/latest"))).toBe(false);
    expect(r.npmLog).toEqual([]);
    expect(existsSync(join(r.dest, "versions/9.9.9/dist/cli.js"))).toBe(true);
  });

  it("pinned channel: a ref without an asset falls back to source — refs/tags first, then the build", async () => {
    const r = await runInstall({
      CAST_REF: "9.9.9",
      CURL_SERVE_SUBSTR: "archive/refs/tags/9.9.9.tar.gz",
      CURL_TARBALL: asset,
      NPM_EXIT: "0",
    });
    expect(r.code).toBe(0);
    // Asset first, tag second — and the build ran, in order.
    expect(r.curlLog[0]).toContain("releases/download/9.9.9/cast-9.9.9.tgz");
    expect(r.curlLog[1]).toContain("archive/refs/tags/9.9.9.tar.gz");
    expect(r.npmLog[0]).toContain("ci");
    expect(r.npmLog[1]).toContain("run build");
    expect(r.npmLog[2]).toContain("prune");
    // The source-built tree lands by the same rule as everything else:
    // versions/<its package.json version>.
    expect(existsSync(join(r.dest, "versions/9.9.9/bin/cast"))).toBe(true);
  });

  it("dev channel: CAST_REF=main tries asset, tag, then branch — and builds from source", async () => {
    const r = await runInstall({
      CAST_REF: "main",
      CURL_SERVE_SUBSTR: "archive/refs/heads/main.tar.gz",
      CURL_TARBALL: mainSrc,
      NPM_EXIT: "0",
    });
    expect(r.code).toBe(0);
    expect(r.curlLog[0]).toContain("releases/download/main/cast-main.tgz");
    expect(r.curlLog[1]).toContain("archive/refs/tags/main.tar.gz");
    expect(r.curlLog[2]).toContain("archive/refs/heads/main.tar.gz");
    expect(r.npmLog.length).toBe(3);
    // The version dir is named by the TREE's package.json (9.9.9 in this
    // fixture), never by the ref that fetched it — main's tree between
    // releases must say so in its own version.
    expect(existsSync(join(r.dest, "versions/9.9.9/bin/cast"))).toBe(true);
  });

  it("a ref that is neither a release, a tag nor a branch dies naming all three tries", async () => {
    const r = await runInstall({ CAST_REF: "no-such-ref", NPM_EXIT: "0" });
    expect(r.code).toBe(1);
    expect(r.output).toContain("neither a tag nor a branch");
  });

  it("a broken asset (no dist/) refuses BEFORE touching an existing install", async () => {
    const r = await runInstall(
      {
        CAST_REF: "9.9.9",
        CURL_SERVE_SUBSTR: "releases/download/9.9.9/cast-9.9.9.tgz",
        CURL_TARBALL: brokenAsset,
      },
      { preexistingDest: true },
    );
    expect(r.code).toBe(1);
    expect(r.output).toContain("not a runnable cast tree");
    // The sanity check ran before anything landed in $DEST: whatever was
    // already there survives, untouched.
    expect(existsSync(join(r.dest, "MARKER"))).toBe(true);
    expect(existsSync(join(r.dest, "versions"))).toBe(false);
  });
});
