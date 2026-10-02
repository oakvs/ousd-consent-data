#!/usr/bin/env bash
# Hot standby for the GitHub Actions schedule, for a homelab or laptop cron:
#
#   */30 * * * * /path/to/ousd-consent-data/scripts/standby.sh >> "$HOME/consent-standby.log" 2>&1
#
# It runs `consent run` only when GitHub Actions hasn't run recently, and
# alerts (ntfy) when nothing has succeeded for 6 hours. Needs Node 22, a
# clone that can push to GitHub, and a .env with ANTHROPIC_API_KEY,
# VERCEL_DEPLOY_HOOK_URL and NTFY_TOPIC. See RUNBOOK.md → Standby.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "--- $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git pull --ff-only --quiet

# Reinstall only when the lockfile changed.
stamp=node_modules/.package-lock.sha
want="$(shasum -a 256 package-lock.json | cut -d' ' -f1)"
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$want" ]; then
  npm ci --silent
  echo "$want" > "$stamp"
fi

exec npx tsx --env-file=.env pipeline/cli.ts standby "$@"
