import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The release flow (#96), proven offline. Two surfaces: the changelog-section
// extraction release.yml publishes (.github/scripts/release-notes.sh), and
// the installer's three channels — REAL install.sh runs against throwaway
// roots, with a stub curl on PATH standing in for GitHub and a POISONED npm
// proving the release channels never build. Nothing here touches the
// network. (`cast --version` itself is test/version-cli.test.ts's; the
// versioned LAYOUT every channel lands in is test/install-sh.test.ts's —
// here the layout is asserted only where a channel decides what fills it.)

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NOTES = join(ROOT, ".github/scripts/release-notes.sh");

function run(
  cmd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
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

// --- release-notes.sh — the extraction release.yml publishes ----------------
// A fixture changelog carrying every boundary: an Unreleased section that
// must never leak into a release, adjacent versions, a version that prefixes
// another (0.7.0 vs 0.7.0-rc1), and a stamped-but-empty section that must
// refuse.

const FIXTURE = `# Changelog

Intro prose that belongs to no section.

## Unreleased

- **Not yet released** — must never appear in a release body.

## 0.7.0 — 2026-07-20

### Added

- **The seven-oh entry** — prose for 0.7.0, and only 0.7.0.

## 0.7.0-rc1 — 2026-07-19

- **The rc entry** — must not ride along with 0.7.0.

## 0.6.0 — 2026-07-18

- **The six-oh entry** — the previous release's prose.

## 0.5.0 — 2026-07-15

`;

describe("release-notes.sh", () => {
  const work = mkdtempSync(join(tmpdir(), "cast-relnotes-"));
  const fix = join(work, "CHANGELOG.md");
  writeFileSync(fix, FIXTURE);
  const notes = (ver: string, file = fix) => run("bash", [NOTES, ver, file]);

  it("prints the asked-for version's section, subheaders included", async () => {
    const r = await notes("0.7.0");
    expect(r.code).toBe(0);
    expect(r.output).toContain("The seven-oh entry");
    expect(r.output).toContain("### Added");
  });

  it("stops at the next section and never prints a header", async () => {
    const r = await notes("0.7.0");
    expect(r.output).not.toContain("The rc entry");
    expect(r.output).not.toContain("six-oh");
    expect(r.output).not.toMatch(/^## /m);
  });

  it("never leaks Unreleased into a release body", async () => {
    const r = await notes("0.7.0");
    expect(r.output).not.toContain("Not yet released");
  });

  it("matches the version WHOLE — 0.7.0-rc1 is its own section", async () => {
    const r = await notes("0.7.0-rc1");
    expect(r.code).toBe(0);
    expect(r.output).toContain("The rc entry");
    expect(r.output).not.toContain("seven-oh");
  });

  it("an adjacent older version still resolves", async () => {
    const r = await notes("0.6.0");
    expect(r.code).toBe(0);
    expect(r.output).toContain("six-oh");
  });

  it("a missing version refuses by name, citing the ritual", async () => {
    const r = await notes("9.9.9");
    expect(r.code).toBe(1);
    expect(r.output).toContain("no section for '9.9.9'");
    expect(r.output).toContain("#96");
  });

  it("a stamped-but-EMPTY section refuses", async () => {
    const r = await notes("0.5.0");
    expect(r.code).toBe(1);
    expect(r.output).toContain("no section for '0.5.0'");
  });

  it("no version argument is a usage error", async () => {
    const r = await run("bash", [NOTES]);
    expect(r.code).toBe(2);
    expect(r.output).toContain("usage:");
  });

  it("a missing changelog refuses by path", async () => {
    const r = await notes("1.0.0", join(work, "nope.md"));
    expect(r.code).toBe(1);
    expect(r.output).toContain("no such file");
  });

  // The REAL changelog: the guard against header-format drift. The file has
  // two legitimate states, and this test used to know only one (#108, found
  // the day the first release PR turned CI red): BETWEEN releases the top
  // section is `## Unreleased`; on a `release: X.Y.Z` tree — the ceremony's
  // own PR stamps that heading into `## X.Y.Z — date` — and on main right
  // after it, the top section IS the stamped release. Demanding the literal
  // Unreleased (with an issue number inside it, rotting per release) made
  // the release PR unshippable by construction, invisible to fork
  // rehearsals (a tag push runs release.yml, never ci.yml). Whatever the
  // top section is called, the exact tool release.yml runs must extract it
  // non-empty.
  it("the real CHANGELOG.md's top section extracts", async () => {
    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    const top = changelog.match(/^## (\S+)/m);
    if (!top) throw new Error("CHANGELOG.md has no ## section at all");
    const r = await notes(top[1], join(ROOT, "CHANGELOG.md"));
    expect(r.code).toBe(0);
    expect(r.output.trim()).not.toBe("");
  });
});

// --- release.yml — the wiring, pinned --------------------------------------
// The workflow itself only runs on a tag push upstream, so its load-bearing
// pieces are pinned here, fail-closed (the house discipline: the labels
// harness greps its workflow the same way).

describe("release.yml", () => {
  const RY = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");

  it("triggers on EVERY tag — the manual fallback survives, and a mismatch must fail loudly, not be pattern-skipped", () => {
    expect(RY).toContain('tags: ["**"]');
  });

  it("the merge door rides pushes to main — fork PR tokens are read-only (#111 r1)", () => {
    // A pull_request run from a public fork gets a read-only GITHUB_TOKEN
    // (permissions: cannot raise it), and every ceremony PR this org merges
    // is cross-repo from the bot fork — the tag create would 403 after
    // green asserts. The door triggers on push to main; the doors split on
    // the pushed ref; the release label — still the operator's declared
    // intent — is read via the API off the merge commit's PR, and a
    // transition with no labeled PR behind it refuses.
    expect(RY).toContain("branches: [main]");
    // YAML maps are last-key-wins: a second sibling push: key silently
    // replaces the first and kills a door (grok's round-2 catch — the tag
    // fallback had stopped triggering). Exactly ONE push key may exist.
    expect(RY.match(/^  push:$/gm)).toHaveLength(1);
    expect(RY).toContain("startsWith(github.ref, 'refs/tags/')");
    expect(RY).toContain("github.ref == 'refs/heads/main'");
    expect(RY).toContain("commits/$GITHUB_SHA/pulls");
    expect(RY).toContain("no merged, release-labeled PR is behind this commit");
    expect(RY).not.toContain("pull_request:");
  });

  it("the release re-arms main itself — the -dev bump folds into the release act", () => {
    // Operator decision (#111 followup): the post-release bump PR was
    // ceremony debris. Direct push with the job's token, PR fallback when
    // branch protection refuses, merge-door only.
    expect(RY).toContain("bump main to the next -dev");
    expect(RY).toContain("opening the bump PR instead");
    expect(RY).toContain("npm install --package-lock-only");
  });

  it("asserts tag == package.json version, and the assert precedes the create", () => {
    expect(RY).toContain('require("./package.json").version');
    expect(RY).toContain("creating nothing");
    expect(RY.indexOf("creating nothing")).toBeLessThan(
      RY.indexOf('gh release create "$RELEASE_VERSION"'),
    );
  });

  it("the merge path decides, then asserts, IN ORDER, all before tag-create, build, and publish", () => {
    // The decide step (the fused version asserts — see the workflow's
    // four-state table): base read from git, versions via node, work under
    // the label no-ops green, half-ceremonies refuse. Then: the shared
    // notes extraction, the no-existing-tag/release asserts, and only then
    // the acts — API-tag the merge commit, build, publish. Every marker
    // present, strictly in file order, fail-closed.
    const markers = [
      'git show "$BASE_SHA:package.json"', // decide — base vs merge
      // Code-unique phrasings (the workflow's own comment table paraphrases
      // these states, so the pins anchor on the echo strings, not prose):
      "release-flow work under the release label, not a ceremony. Nothing to publish.", // work no-op, green
      "a dev tree is by definition not a release", // -dev endstate: always work (the bump PR no-ops green)
      "release-flow work merged in the post-release window (before the -dev bump)", // window no-op
      "Refusing to guess — creating nothing.", // bare, unchanged, unreleased: refuse
      ".github/scripts/release-notes.sh", // assert: notes extract
      'git ls-remote --exit-code origin "refs/tags/$RELEASE_VERSION"', // assert: no tag
      'gh release view "$RELEASE_VERSION"', // assert: no release (the decide's own view sits earlier — count checked below)
      'gh api "repos/$GITHUB_REPOSITORY/git/refs"', // act: tag the merge commit
      "npm prune --omit=dev", // act: build
      'gh release create "$RELEASE_VERSION"', // act: publish
    ];
    let at = -1;
    for (const m of markers) {
      const i = RY.indexOf(m);
      expect(i, m).toBeGreaterThan(at);
      at = i;
    }
  });

  it("the -dev interlock reads versions via node, never regex, and names the 0.1.0 first-release edge", () => {
    expect(RY).not.toMatch(/grep.*version/);
    expect(RY).toContain("node -p 'require(\"./package.json\").version'");
    // 0.1.0 never carried -dev, so the interlock correctly skips #110's
    // ceremony — the workflow must say so where the next reader will look.
    expect(RY).toContain("applies from 0.1.1");
  });

  it("tag, build, and publish happen in the SAME job — a GITHUB_TOKEN tag fires no workflows", () => {
    const jobs = RY.slice(RY.indexOf("\njobs:")).match(/^ {2}\S+:\s*$/gm) ?? [];
    expect(jobs).toEqual(["  release:"]); // one job under jobs:
    expect(RY).toContain("does not trigger other workflows");
    expect(RY).toContain('-f "sha=$MERGE_SHA"');
  });

  it("the body comes from the shared extraction script", () => {
    expect(RY).toContain(".github/scripts/release-notes.sh");
  });

  it("the release is bound to its tag (--verify-tag)", () => {
    expect(RY).toContain("--verify-tag");
  });

  it("builds the prod-only tree once and attaches it as the asset", () => {
    expect(RY).toContain("npm prune --omit=dev");
    expect(RY).toContain("cp -R bin dist node_modules package.json");
    expect(RY).toContain("cast-$RELEASE_VERSION.tgz");
  });

  it("both trigger paths converge on the SAME asset name — one build, one tar, no per-path naming", () => {
    // Each path's entry step exports RELEASE_VERSION; everything downstream
    // (notes, stage dir, tarball, release title) reads only that. A second
    // tar or a $GITHUB_REF_NAME-named asset would be the paths drifting
    // apart — the exact failure this shape exists to prevent.
    expect(RY.match(/>> "\$GITHUB_ENV"/g)).toHaveLength(2);
    expect(RY.match(/tar -C/g)).toHaveLength(1);
    expect(RY).not.toContain("cast-$GITHUB_REF_NAME");
  });

  it("runs no tests — ci.yml gated the merge commit already", () => {
    expect(RY).not.toContain("npm test");
    expect(RY).not.toContain("npm run check");
  });
});

// --- the installer's three channels, driven for real ------------------------
// Full install.sh runs against throwaway roots. The curl on PATH is a stub
// scripted via env (CURL_*); the npm on PATH is POISONED (exits 97) unless a
// test opts into the stub build — so any release-channel install that
// touches npm fails its assertion by failing the install.

const STUB = mkdtempSync(join(tmpdir(), "cast-stub-"));
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
  const work = mkdtempSync(join(tmpdir(), "cast-inst-"));
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
  const work = mkdtempSync(join(tmpdir(), "cast-tarballs-"));
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
