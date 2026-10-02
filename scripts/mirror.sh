#!/usr/bin/env bash
# Push main and tags to the Codeberg mirror with a write deploy key.
#
#   CODEBERG_DEPLOY_KEY    private key (the public half is a deploy key with write access on Codeberg)
#   CODEBERG_KNOWN_HOSTS   optional: pinned codeberg.org host key line(s); otherwise fetched with ssh-keyscan
#   CODEBERG_REMOTE        optional: defaults to git@codeberg.org:oakvs/ousd-consent-data.git
set -euo pipefail

if [ -z "${CODEBERG_DEPLOY_KEY:-}" ]; then
  echo "mirror: CODEBERG_DEPLOY_KEY is not set; skipping"
  exit 0
fi
remote="${CODEBERG_REMOTE:-git@codeberg.org:oakvs/ousd-consent-data.git}"

dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
printf '%s\n' "$CODEBERG_DEPLOY_KEY" > "$dir/key"
chmod 600 "$dir/key"
if [ -n "${CODEBERG_KNOWN_HOSTS:-}" ]; then
  printf '%s\n' "$CODEBERG_KNOWN_HOSTS" > "$dir/known_hosts"
else
  ssh-keyscan -t ed25519 codeberg.org > "$dir/known_hosts" 2>/dev/null
fi

export GIT_SSH_COMMAND="ssh -i $dir/key -o IdentitiesOnly=yes -o UserKnownHostsFile=$dir/known_hosts -o StrictHostKeyChecking=yes"
# Not forced: if Codeberg has diverged (someone pushed there directly), this fails loudly instead of overwriting.
git push --quiet "$remote" HEAD:refs/heads/main
git push --quiet "$remote" --tags
echo "mirror: pushed to $remote"
