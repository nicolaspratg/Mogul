#!/usr/bin/env bash
#
# AlpChat/Mogul — clone (or update) the repo and build it.
# Idempotent. Run as root on the Hetzner box AFTER the deploy key is
# added to the GitHub repo.
#
set -euo pipefail

REPO="git@github.com:nicolaspratg/Mogul.git"
DIR="/opt/mogul"

echo "== Configuring SSH to use the GitHub deploy key =="
mkdir -p /root/.ssh
chmod 700 /root/.ssh
cat > /root/.ssh/config <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile /root/.ssh/github_deploy
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF
chmod 600 /root/.ssh/config

echo "== Cloning / updating repo =="
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch origin
  git -C "$DIR" reset --hard origin/main
else
  git clone "$REPO" "$DIR"
fi

echo "== Installing dependencies (npm ci) =="
cd "$DIR"
npm ci

echo "== Building (tsc) =="
npm run build

echo
echo "== DONE — build output =="
ls -la "$DIR/dist" | head -n 20
