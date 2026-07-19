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
  // rehearsals (a tag push runs release.yml, never ci.yml).
  //
  // But keying the assert to the TOP section was only ever a stand-in for
  // "the section release.yml will publish", and the re-arm (#113) breaks the
  // stand-in: the ceremony PR now leaves a fresh, deliberately EMPTY
  // `## Unreleased` on top of the section it just stamped, and an empty
  // section is exactly what release-notes.sh refuses. Asserting the top
  // section extracts would make the re-armed ceremony tree CI-red — #108's
  // unshippability by another route, and the re-arm and the guard would
  // contradict each other. So the assert retargets to the section that
  // SHIPS, keyed on package.json the same way the arming rule below is
  // (rig#67 made the identical move):
  //
  //   version BARE  — the tree is, or follows, the release of that version.
  //                   `## <version>` is what release.yml extracts. It must
  //                   exist and be non-empty. The top section is NOT
  //                   constrained here; an empty re-armed Unreleased above
  //                   it is correct.
  //   version -dev  — nothing ships from this tree, and the top section is
  //                   `## Unreleased`, legitimately empty between releases.
  //                   Drift coverage retargets to the most recent STAMPED
  //                   section, which release.yml did publish. Before the
  //                   first release there is none, and that is not a fault.
  it("the real CHANGELOG.md's SHIPPING section extracts (#113)", async () => {
    const version = realVersion();
    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    const target = version.endsWith("-dev") ? firstStamped(changelog) : version;
    if (!target) return; // greenfield -dev: nothing has shipped yet.
    const r = await notes(target, join(ROOT, "CHANGELOG.md"));
    expect(r.code).toBe(0);
    expect(r.output.trim()).not.toBe("");
  });
});

// --- the changelog is ARMED — the version says which state is legal --------
// heavy-duty/rig#66. The section above proves the SHIPPING section extracts;
// it deliberately does not care what the top section is CALLED, and cannot:
// #108 relaxed exactly that, because the ceremony PR's own tree has a
// stamped `## X.Y.Z` on top and a literal-Unreleased demand made the
// release unshippable by construction. So nothing on main notices when
// `## Unreleased` is simply gone.
//
// That gap is not theoretical. A PR that writes its entry under
// `## Unreleased`, is authored before a release and merged after, has that
// entry land under whatever heading now occupies the position — the
// just-shipped `## X.Y.Z`. Git merges it CLEANLY: the stamped heading and
// the incoming entry never overlap textually, so the one signal an author
// relies on ("git told me to look") is absent precisely when the outcome is
// wrong. It happened in rig: #60's entry landed inside published `## 0.1.0`.
//
// The rule that separates the two states #108 collapsed, without demanding
// Unreleased unconditionally: **the package.json version keys it.** A bare
// `X.Y.Z` means the tree IS (or immediately follows) a release — the
// ceremony's stamped top section is legal there, and so is a re-armed
// Unreleased. A `-dev` version means main between releases, where a stamped
// top section can only mean the re-arm was skipped: `## Unreleased` is
// mandatory. Green through the whole ceremony; red on a disarmed `-dev`
// main, which is the state the guard exists to name.

/** package.json's version — the fact the whole rule is keyed on. */
function realVersion(): string {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
    .version as string;
}

/** The top `## ` section's token — `Unreleased`, or a stamped version. */
function topSection(changelog: string): string {
  const top = changelog.match(/^## (\S+)/m);
  if (!top) throw new Error("changelog has no ## section at all");
  return top[1];
}

/** The newest stamped (non-Unreleased) section's token, or null if none. */
function firstStamped(changelog: string): string | null {
  for (const m of changelog.matchAll(/^## (\S+)/gm)) {
    if (m[1] !== "Unreleased") return m[1];
  }
  return null;
}

/** Does `## <token>` appear as a section heading at all? */
function hasSection(changelog: string, token: string): boolean {
  return [...changelog.matchAll(/^## (\S+)/gm)].some((m) => m[1] === token);
}

/** null = armed. A string = why this (version, changelog) pair is illegal. */
function disarmedBecause(version: string, changelog: string): string | null {
  const top = topSection(changelog);

  // Idempotence: re-arming twice leaves two `## Unreleased` headings, and
  // the section awk extracts is then the EMPTY first one — armed by the
  // heading test, unpublishable in fact. One heading, always.
  const unreleased = [...changelog.matchAll(/^## Unreleased\s*$/gm)].length;
  if (unreleased > 1) {
    return `the changelog carries ${unreleased} '## Unreleased' headings — the re-arm ran twice. Entries split across them, and the section release-notes.sh extracts is the empty first one.`;
  }

  if (version.endsWith("-dev")) {
    return top === "Unreleased"
      ? null
      : `version ${version} is a dev tree, so the top section must be '## Unreleased' — found '## ${top}'. The release ceremony stamps Unreleased into the shipped version and must re-add an empty one (heavy-duty/rig#66); without it the next PR's entry lands inside ${top}'s published notes, with no merge conflict to warn anyone.`;
  }

  if (top !== "Unreleased" && top !== version) {
    return `version ${version} is bare, so the top section must be '## Unreleased' (re-armed) or the matching '## ${version}' (the ceremony tree) — found '## ${top}'.`;
  }

  // A bare version is a SHIP claim: release.yml will extract `## <version>`
  // and publish it. Every legal bare state has that section — the ceremony
  // tree (stamped on top), the re-armed ceremony tree (stamped under an
  // empty Unreleased), and main in the post-release window. Its absence is
  // the half-ceremony: bumped, never stamped. That passed the heading rule
  // alone and failed only AFTER merge, in release.yml's notes step — past
  // the ship decision, leaving main with a minted, unreleased bare version
  // the decide step then refuses on re-runs. Red here, one round earlier.
  if (!hasSection(changelog, version)) {
    return `version ${version} is bare — a ship claim — but there is no '## ${version}' section to publish. The ceremony bumped the version without stamping the changelog; release.yml's notes step would refuse AFTER the merge, past the ship decision.`;
  }

  return null;
}

describe("the changelog is armed for the next entry (rig#66)", () => {
  const work = mkdtempSync(join(tmpdir(), "cast-arming-"));
  const dated = (v: string) => `## ${v} — 2026-07-19`;
  const body = "\n\n- **An entry** — prose.\n";
  const armed = `# Changelog\n\n## Unreleased${body}\n${dated("0.2.0")}${body}`;
  const stamped = `# Changelog\n\n${dated("0.2.0")}${body}`;
  // The tree CONTRIBUTING step 1 actually mandates: the stamped section with
  // a fresh, EMPTY `## Unreleased` above it. The `armed` fixture gives
  // Unreleased a body and so never exercises this one.
  const rearmed = `# Changelog\n\n## Unreleased\n\n${dated("0.2.0")}${body}`;

  /** Run the REAL release-notes.sh against a fixture changelog. */
  const extract = (name: string, changelog: string, ver: string) => {
    const file = join(work, `${name}.md`);
    writeFileSync(file, changelog);
    return run("bash", [NOTES, ver, file]);
  };

  it("the REAL tree is armed — package.json and CHANGELOG.md agree", () => {
    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    expect(disarmedBecause(realVersion(), changelog)).toBeNull();
  });

  // The ceremony, walked end to end. Every state green — this is the #108
  // regression the guard must not re-introduce.
  it("stays green through the ceremony: the release PR's own stamped tree", () => {
    expect(disarmedBecause("0.2.0", stamped)).toBeNull();
  });

  it("stays green through the ceremony: the ceremony PR that re-arms too", () => {
    expect(disarmedBecause("0.2.0", armed)).toBeNull();
  });

  // The state the whole re-arm turns on, and the one this guard is most at
  // risk of contradicting: CONTRIBUTING's mandated tree, whose top section is
  // an EMPTY `## Unreleased`. Asserted end to end — the arming rule passes it
  // AND the exact tool release.yml runs extracts the section that ships. An
  // assert aimed at the TOP section here is #108's unshippability again
  // (rig#67 retargeted the same assert for the same reason).
  it("the MANDATED ceremony tree — empty Unreleased over the stamp — is green end to end", async () => {
    expect(disarmedBecause("0.2.0", rearmed)).toBeNull();
    const r = await extract("rearmed", rearmed, "0.2.0");
    expect(r.code).toBe(0);
    expect(r.output).toContain("An entry");
    // And the empty top section is untouchable by release.yml, as intended.
    const top = await extract("rearmed", rearmed, "Unreleased");
    expect(top.code).toBe(1);
  });

  it("stays green through the ceremony: main in the post-release window", () => {
    // Merged, tagged, published — the -dev bump has not landed yet.
    expect(disarmedBecause("0.2.0", stamped)).toBeNull();
  });

  it("stays green through the ceremony: main after the -dev bump, re-armed", () => {
    expect(disarmedBecause("0.2.1-dev", armed)).toBeNull();
  });

  // And red on the one state the extraction guard cannot see.
  it("goes RED on a disarmed -dev main — the rig#66 failure, exactly", () => {
    const why = disarmedBecause("0.2.1-dev", stamped);
    expect(why).toContain("must be '## Unreleased'");
    expect(why).toContain("rig#66");
  });

  it("goes RED when a bare version's stamp names a different release", () => {
    // A hand-stamp that drifted from the bump it shipped with.
    expect(
      disarmedBecause("0.2.0", `# Changelog\n\n${dated("0.1.9")}${body}`),
    ).toContain("the ceremony tree");
  });

  // The half-ceremony: bumped, never stamped. Green under the heading rule
  // alone — the top IS `## Unreleased`, re-armed and populated — and it fails
  // only after the merge, in release.yml's notes step, past the ship
  // decision. Asserted against the real tool so the post-merge failure this
  // pre-empts is the actual one, not a paraphrase of it.
  it("goes RED on the half-ceremony: bumped bare, changelog never stamped", async () => {
    const half = `# Changelog\n\n## Unreleased${body}`;
    const why = disarmedBecause("0.2.0", half);
    expect(why).toContain("no '## 0.2.0' section");
    // Exactly what release.yml would have done instead, after the merge.
    const r = await extract("half", half, "0.2.0");
    expect(r.code).toBe(1);
    expect(r.output).toContain("no section for '0.2.0'");
  });

  // Idempotence: re-arming an already-armed file is silently wrong, because
  // the section awk extracts is then the empty first heading.
  it("goes RED on a double re-arm — two Unreleased headings", () => {
    const twice = `# Changelog\n\n## Unreleased\n\n## Unreleased${body}\n${dated("0.2.0")}${body}`;
    expect(disarmedBecause("0.2.1-dev", twice)).toContain(
      "2 '## Unreleased' headings",
    );
  });

  it("refuses a changelog with no sections at all rather than passing it", () => {
    expect(() => disarmedBecause("0.2.1-dev", "# Changelog\n")).toThrow(
      "no ## section",
    );
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
    expect(RY.match(/^ {2}push:$/gm)).toHaveLength(1);
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
