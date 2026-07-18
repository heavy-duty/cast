#!/usr/bin/env bash
set -euo pipefail

# changelog-section.sh <version> [changelog-file]
#
# Print the body of CHANGELOG.md's `## <version>` section — everything
# between that heading and the next `## ` heading (or EOF), with the
# leading/trailing blank lines trimmed. release.yml uses this as the
# GitHub release body, so the notes are the curated prose we actually
# wrote, never an auto-generated PR list (cast#96 / box#83).
#
# Fails loudly when the section is missing or empty: a release with no
# written history is a release that skipped the changelog discipline,
# and the tag push is exactly the moment to catch that — before a
# release object exists.

version="${1:-}"
file="${2:-CHANGELOG.md}"

[ -n "$version" ] || { echo "usage: changelog-section.sh <version> [changelog-file]" >&2; exit 2; }
[ -f "$file" ] || { echo "changelog-section: no such file: $file" >&2; exit 1; }

# The heading is `## <version>` optionally followed by more (a date stamp:
# `## 0.1.0 — 2026-07-18`). Match on the version as the second word so the
# stamp's format never becomes load-bearing here.
section="$(awk -v ver="$version" '
  /^## / { if (found) exit; if ($2 == ver) { found = 1; next } }
  found { print }
  END { exit found ? 0 : 3 }
' "$file")" || {
  echo "changelog-section: no \"## $version\" section in $file" >&2
  exit 1
}

# Trim leading blank lines; command substitution already ate the trailing ones.
section="$(printf '%s\n' "$section" | sed '/./,$!d')"

[ -n "$section" ] || {
  echo "changelog-section: the \"## $version\" section in $file is empty" >&2
  exit 1
}

printf '%s\n' "$section"
