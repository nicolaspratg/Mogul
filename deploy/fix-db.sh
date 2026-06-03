#!/usr/bin/env bash
#
# Recreate the database as mogul_dev (role: mogul), drop the earlier alpchat one.
# Idempotent. Run as root on the Hetzner box.
#
set -euo pipefail

DB_NAME="mogul_dev"
DB_ROLE="mogul"
DB_PASS="$(openssl rand -hex 16)"

echo "== Creating role ${DB_ROLE} and database ${DB_NAME} =="

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_ROLE}') THEN
    CREATE ROLE ${DB_ROLE} LOGIN PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE ${DB_ROLE} PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;
SQL

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres createdb -O "${DB_ROLE}" "${DB_NAME}"
fi

# Remove the earlier alpchat db + role (created by setup-base.sh) if present.
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS alpchat;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS alpchat;"

DB_URL="postgresql://${DB_ROLE}:${DB_PASS}@localhost:5432/${DB_NAME}"
echo "DATABASE_URL=${DB_URL}" > /root/mogul-db.env
chmod 600 /root/mogul-db.env
rm -f /root/alpchat-db.env

echo
echo "============================================================"
echo " DATABASE_URL saved to /root/mogul-db.env :"
echo " ${DB_URL}"
echo "============================================================"
