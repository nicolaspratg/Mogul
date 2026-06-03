#!/usr/bin/env bash
#
# AlpChat — base server setup (idempotent, safe to re-run).
# Installs Node 22, PostgreSQL, build tools; creates the alpchat DB + role.
# Run as root on the Hetzner box.
#
set -euo pipefail

log() { echo -e "\n\033[1;36m== $1 ==\033[0m"; }

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

log "Updating apt and installing base packages"
apt-get update -y
apt-get install -y build-essential ca-certificates curl git gnupg openssl

log "Installing Node.js 22 (NodeSource)"
if ! command -v node >/dev/null 2>&1 || ! node --version | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh
  apt-get install -y nodejs
fi

log "Installing PostgreSQL"
apt-get install -y postgresql postgresql-contrib
systemctl enable --now postgresql

log "Creating alpchat database role and database"
DB_PASS="$(openssl rand -hex 16)"

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'alpchat') THEN
    CREATE ROLE alpchat LOGIN PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE alpchat PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;
SQL

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='alpchat'" | grep -q 1; then
  sudo -u postgres createdb -O alpchat alpchat
fi

# Persist the connection string for later steps (root-only readable).
DB_URL="postgresql://alpchat:${DB_PASS}@localhost:5432/alpchat"
echo "DATABASE_URL=${DB_URL}" > /root/alpchat-db.env
chmod 600 /root/alpchat-db.env

log "DONE — versions"
node --version
npm --version
psql --version | head -n1

echo
echo "============================================================"
echo " DATABASE_URL saved to /root/alpchat-db.env :"
echo " ${DB_URL}"
echo "============================================================"
