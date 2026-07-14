import type { CoolifyClient } from "./coolify.js";
import { assertNoReservedEnvNames, reservedHits } from "./reserved.js";

// smoke writes env vars onto a REAL application — the one thing in cast that
// mutates a live resource purely to learn something. So the reserved-name rule
// binds it too, and these are the two names it may pick from.
//
// Exported, and asserted below, because the rule is about what cast writes, not
// about what one function happens to have been written to write today: an
// operator renaming a probe (`COOLIFY_SMOKE_PROBE` reads like the natural name)
// would otherwise set the very trap this rule exists to prevent, on a live app,
// and the smoke would pass while suppressing the app's SOURCE_COMMIT injection
// for as long as the probe lived — and the delete at the end restores nothing:
// Coolify only injects at deploy time.
export const SMOKE_KEEP_KEY = "INFRA_SMOKE_KEEP";
export const SMOKE_PROBE_KEY = "INFRA_SMOKE_PROBE";

export async function smoke(
  client: CoolifyClient,
  targetAppUuid: string,
): Promise<void> {
  const KEEP_KEY = SMOKE_KEEP_KEY;
  const PROBE_KEY = SMOKE_PROBE_KEY;
  assertNoReservedEnvNames(
    reservedHits(`smoke probe on ${targetAppUuid}`, [KEEP_KEY, PROBE_KEY]),
  );
  const envsPath = `/applications/${targetAppUuid}/envs`;
  type EnvVar = {
    key: string;
    value: string;
    is_buildtime?: boolean;
    uuid: string;
  };
  const readEnvs = async (): Promise<EnvVar[]> =>
    (await client.get(envsPath)) as EnvVar[];

  // First var goes in via the singular envs endpoint — this is the
  // never-delete canary the bulk write below must not disturb.
  await client.post(envsPath, {
    key: KEEP_KEY,
    value: "1",
    is_buildtime: false,
    is_preview: false,
  });

  // Second var goes in via the bulk endpoint (the one apply's syncEnv uses,
  // see cli.ts) with a payload containing ONLY the second var. The bulk
  // envs endpoint is documented/verified as UPSERT-only (never deletes
  // unlisted keys) — that's the load-bearing guarantee behind the iron rule
  // that apply never deletes. If a Coolify upgrade regresses it to
  // full-replace, KEEP_KEY will vanish from the read-back below.
  await client.patch(`${envsPath}/bulk`, {
    data: [
      {
        key: PROBE_KEY,
        value: "1",
        is_buildtime: false,
        is_preview: false,
      },
    ],
  });

  const envs = await readEnvs();
  const keep = envs.find((e) => e.key === KEEP_KEY);
  const probe = envs.find((e) => e.key === PROBE_KEY);

  if (!keep) {
    // Clean up whatever did survive before failing loudly.
    if (probe) await client.delete_(`${envsPath}/${probe.uuid}`);
    throw new Error(
      "smoke FAIL: bulk env write is destructive (full-replace) — never-delete broken; do not apply with this Coolify version",
    );
  }
  if (!probe) throw new Error("smoke FAIL: probe var not readable back");
  if (probe.is_buildtime !== false) {
    throw new Error(
      `smoke FAIL: is_buildtime round-trip broken (got ${probe.is_buildtime}) — Coolify upgrade regression?`,
    );
  }

  await client.delete_(`${envsPath}/${keep.uuid}`);
  await client.delete_(`${envsPath}/${probe.uuid}`);
  console.log(`smoke OK against Coolify ${await client.version()}`);
}
