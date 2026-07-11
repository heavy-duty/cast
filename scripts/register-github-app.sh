#!/usr/bin/env bash
# Register a GitHub App (created via the manifest flow on your org) with a
# Coolify instance, so cast can create applications from private repos.
#
# usage: CAST_STATE=~/infra ./register-github-app.sh
#
# Takes everything as input — the app's identity is yours, not this tool's.
# APP_NAME must match the `github_apps.<repo>` value in your environments.yaml:
# that is the name cast resolves when it creates an application.
set -euo pipefail

STATE="${CAST_STATE:-.}"
# shellcheck disable=SC1091
source "${STATE}/.coolify.env"

: "${APP_NAME:?the Coolify-facing GitHub App name (must match github_apps.<repo> in environments.yaml)}"
: "${ORG:?the GitHub org or user the App is installed on}"
: "${APP_ID:?}"; : "${INSTALLATION_ID:?}"; : "${CLIENT_ID:?}"; : "${CLIENT_SECRET:?}"
: "${WEBHOOK_SECRET:?}"; : "${PRIVATE_KEY_FILE:?path to the App private key PEM}"

api() { curl -fsS -H "Authorization: Bearer ${COOLIFY_ACCESS_TOKEN}" -H "Content-Type: application/json" "$@"; }

KEY_UUID=$(api -X POST "${COOLIFY_BASE_URL}/api/v1/security/keys" \
  -d "$(jq -n --arg name "${APP_NAME}-key" --rawfile pk "$PRIVATE_KEY_FILE" \
    '{name:$name, private_key:$pk}')" | jq -r .uuid)

api -X POST "${COOLIFY_BASE_URL}/api/v1/github-apps" -d "$(jq -n \
  --arg name "$APP_NAME" --arg org "$ORG" \
  --arg app_id "$APP_ID" --arg inst "$INSTALLATION_ID" --arg cid "$CLIENT_ID" \
  --arg csec "$CLIENT_SECRET" --arg wh "$WEBHOOK_SECRET" --arg key "$KEY_UUID" \
  --arg api_url "https://api.github.com" --arg html_url "https://github.com" \
  '{name:$name, organization:$org, api_url:$api_url, html_url:$html_url,
    app_id:($app_id|tonumber), installation_id:($inst|tonumber), client_id:$cid, client_secret:$csec,
    webhook_secret:$wh, private_key_uuid:$key}')"

echo "github app registered as ${APP_NAME}"
