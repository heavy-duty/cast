#!/usr/bin/env bash
# usage: ./scripts/restore-db.sh <artifact.sql.gz> <target-host> <postgres-container>
# Streams a Coolify Postgres backup artifact into the target container over
# tailnet SSH. Refuses to run without explicit confirmation of the target.
set -euo pipefail
ARTIFACT="${1:?backup artifact (.sql.gz)}"; HOST="${2:?target host (tailnet name)}"; CONTAINER="${3:?postgres container name}"
echo "About to RESTORE ${ARTIFACT} into ${CONTAINER} on ${HOST} — this overwrites that database."
read -r -p "Type the target host to confirm: " CONFIRM
[ "$CONFIRM" = "$HOST" ] || { echo "confirmation mismatch; aborting"; exit 1; }
# shellcheck disable=SC2029 # intentional: $CONTAINER is a local var, expand client-side before it reaches the remote shell
gunzip -c "$ARTIFACT" | ssh "root@${HOST}" "docker exec -i ${CONTAINER} psql -U postgres"
echo "restore complete — run the verification checks in runbooks/restore-drill.md step 4"
