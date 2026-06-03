#!/usr/bin/env bash
#
# Point /opt/mogul/.env at the server's mogul_dev DB, force NODE_ENV=production,
# then create the schema. Run as root AFTER scp-ing your local .env to
# /opt/mogul/.env. Idempotent (schema.sql uses CREATE TABLE IF NOT EXISTS).
#
set -euo pipefail

ENV_FILE=/opt/mogul/.env
[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found — scp your local .env there first."; exit 1; }
[ -f /root/mogul-db.env ] || { echo "ERROR: /root/mogul-db.env not found — run fix-db.sh first."; exit 1; }

echo "== Rewriting DATABASE_URL + NODE_ENV in .env =="
# Strip any existing DATABASE_URL / NODE_ENV lines, then append the correct ones.
grep -vE '^(DATABASE_URL|NODE_ENV)=' "$ENV_FILE" > /tmp/mogul.env.tmp || true
cat /root/mogul-db.env >> /tmp/mogul.env.tmp
echo "NODE_ENV=production" >> /tmp/mogul.env.tmp
mv /tmp/mogul.env.tmp "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "== .env keys present (values masked) =="
sed -E 's/^([A-Za-z0-9_]+)=.*/\1=***/' "$ENV_FILE"

echo "== Running schema migration =="
set -a; . /root/mogul-db.env; set +a
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /opt/mogul/src/db/schema.sql

echo "== Tables now in mogul_dev =="
psql "$DATABASE_URL" -c "\dt"
