#!/usr/bin/env bash
# Nightly on the coolify box: dump Coolify's own Postgres, age-encrypt
# client-side (dump holds GitHub App key, server SSH keys, all env values),
# ship to S3. Forensics only — a fresh instance is recreated, never restored.
set -euo pipefail
: "${AGE_RECIPIENT:?age public key for the backup identity}"
: "${S3_BUCKET:?s3 bucket, e.g. s3://my-backups/coolify-db}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="/tmp/coolify-db-${STAMP}.sql.age"
docker exec coolify-db pg_dump -U coolify coolify | age -r "$AGE_RECIPIENT" -o "$OUT"
aws s3 cp "$OUT" "${S3_BUCKET}/" --endpoint-url "${S3_ENDPOINT:?hetzner s3 endpoint}"
rm -f "$OUT"
