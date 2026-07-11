#!/usr/bin/env bash
# usage: ./scripts/restore-db.sh <artifact.sql.gz> <target-host> <postgres-container> <db-name>
# Streams a Coolify Postgres backup artifact into the target container over
# tailnet SSH. Refuses to run without explicit confirmation of the target.
set -euo pipefail
ARTIFACT="${1:?backup artifact (.sql.gz)}"; HOST="${2:?target host (tailnet name)}"; CONTAINER="${3:?postgres container name}"; DBNAME="${4:?target database name (docker exec <container> psql -U postgres -lqt to list)}"
echo "About to RESTORE ${ARTIFACT} into database ${DBNAME} in ${CONTAINER} on ${HOST} — this overwrites that database."
read -r -p "Type the target host to confirm: " CONFIRM
[ "$CONFIRM" = "$HOST" ] || { echo "confirmation mismatch; aborting"; exit 1; }
# shellcheck disable=SC2029 # intentional: $CONTAINER/$DBNAME are local vars, expand client-side before they reach the remote shell
gunzip -c "$ARTIFACT" | ssh "root@${HOST}" "docker exec -i ${CONTAINER} psql -U postgres -d ${DBNAME} -v ON_ERROR_STOP=1"
echo "restore complete — run the verification checks in runbooks/restore-drill.md step 4"
