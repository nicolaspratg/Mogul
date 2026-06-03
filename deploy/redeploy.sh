#!/usr/bin/env bash
#
# Pull the latest code, rebuild, restart the service, and health-check.
# This is the standard "ship an update" command. Run as root on the box.
#
set -euo pipefail

bash /root/deploy-app.sh

echo "== Restarting service =="
systemctl restart mogul
sleep 2

echo "== Status =="
systemctl is-active mogul && echo "service is active" || echo "service NOT active"

echo "== Health check =="
curl -fsS http://127.0.0.1:3000/health && echo || echo "(health check failed)"

echo "== Recent logs =="
journalctl -u mogul -n 20 --no-pager
