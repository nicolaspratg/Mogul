#!/usr/bin/env bash
#
# Seed the Riml Sports shop row and install + start the mogul systemd service.
# Idempotent. Run as root on the Hetzner box.
#
set -euo pipefail

echo "== Seeding Riml Sports shop row (ON CONFLICT DO NOTHING) =="
set -a; . /root/mogul-db.env; set +a
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /opt/mogul/src/db/seed-riml-sports.sql

echo "== Installing systemd unit =="
cat > /etc/systemd/system/mogul.service <<'EOF'
[Unit]
Description=Mogul AlpChat WhatsApp bot
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/mogul
ExecStart=/usr/bin/node /opt/mogul/dist/index.js
Restart=always
RestartSec=3
User=root
StandardOutput=journal
StandardError=journal
SyslogIdentifier=mogul

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable mogul >/dev/null 2>&1
systemctl restart mogul
sleep 2

echo "== Service status =="
systemctl --no-pager --full status mogul | head -n 12 || true

echo "== Local health check =="
sleep 1
curl -fsS http://127.0.0.1:3000/health && echo || echo "(health check failed — see logs below)"

echo "== Recent logs =="
journalctl -u mogul -n 25 --no-pager
