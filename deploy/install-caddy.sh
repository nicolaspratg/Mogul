#!/usr/bin/env bash
#
# Install Caddy and configure it as an HTTPS reverse proxy for the bot.
# Caddy auto-obtains + renews a Let's Encrypt cert for wa.mogul-ski.com and
# forwards requests to the app on 127.0.0.1:3000.
# Idempotent. Run as root on the Hetzner box. Requires DNS for the host to
# already point at this server (port 80 must be reachable for the cert).
#
set -euo pipefail

DOMAIN="wa.mogul-ski.com"
ACME_EMAIL="nicoprat@hotmail.com"

export DEBIAN_FRONTEND=noninteractive

echo "== Adding Caddy apt repo =="
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list

echo "== Installing Caddy =="
apt-get update -y
apt-get install -y caddy

echo "== Writing Caddyfile =="
cat > /etc/caddy/Caddyfile <<EOF
{
    email ${ACME_EMAIL}
}

${DOMAIN} {
    reverse_proxy 127.0.0.1:3000
}
EOF

echo "== Reloading Caddy =="
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
echo "Waiting for certificate issuance..."
sleep 12

echo "== Caddy status =="
systemctl is-active caddy && echo "caddy is active" || echo "caddy NOT active"

echo "== HTTPS health check via the public hostname =="
curl -fsS "https://${DOMAIN}/health" && echo || echo "(not ready yet — cert may still be issuing; re-run the curl in a minute)"

echo "== Recent Caddy logs =="
journalctl -u caddy -n 15 --no-pager
