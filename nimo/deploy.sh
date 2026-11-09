#!/bin/bash
# Build NimoTavern locally and deploy it to the Proxmox LXC.
# usage: nimo/deploy.sh            (env: PVE_HOST=root@10.0.0.34 CTID=105)
set -euo pipefail
cd "$(dirname "$0")/.."
PVE_HOST=${PVE_HOST:-root@10.0.0.34}
CTID=${CTID:-105}
export NIMO_BUILD=$(date +%s | tail -c 9)$(git rev-parse --short HEAD 2>/dev/null || echo x)

node --check nimo/server/index.js
[ -f dist/lib.js ] || node nimo/build-lib.mjs
node nimo/build.mjs all ${DEV:+--dev}

TAR=$(mktemp -t nimotavern.XXXXXX.tgz)
tar czf "$TAR" --owner=0 --group=0 --exclude='node_modules' LICENSE package.json public default src/tokenizers dist/lib.js nimo/server nimo/dist nimo/web/static
echo "package: $(du -h "$TAR" | cut -f1)"
scp -q "$TAR" "$PVE_HOST:/tmp/nimotavern.tgz"
ssh "$PVE_HOST" "pct push $CTID /tmp/nimotavern.tgz /tmp/nimotavern.tgz && rm /tmp/nimotavern.tgz && pct exec $CTID -- bash -s" <<'REMOTE'
set -e
NEW=/opt/nimotavern/app.new
rm -rf $NEW && mkdir -p $NEW && tar xzf /tmp/nimotavern.tgz --no-same-owner -C $NEW && rm /tmp/nimotavern.tgz
cd $NEW/nimo/server && npm install --omit=dev --no-audit --no-fund --silent
chown -R root:root $NEW && chmod -R a+rX $NEW
rm -rf /opt/nimotavern/app.old
[ -d /opt/nimotavern/app ] && mv /opt/nimotavern/app /opt/nimotavern/app.old
mv $NEW /opt/nimotavern/app
systemctl enable --now nimotavern >/dev/null 2>&1 || true
systemctl reset-failed nimotavern 2>/dev/null || true
systemctl restart nimotavern
for i in $(seq 1 15); do curl -sf -o /dev/null http://127.0.0.1:8400/home && break; sleep 1; done
if ! curl -sf -o /dev/null http://127.0.0.1:8400/home; then
  echo "DEPLOY FAILED, rolling back"; journalctl -u nimotavern -n 15 --no-pager -o cat
  rm -rf /opt/nimotavern/app.failed; mv /opt/nimotavern/app /opt/nimotavern/app.failed; mv /opt/nimotavern/app.old /opt/nimotavern/app
  systemctl reset-failed nimotavern; systemctl restart nimotavern; exit 1
fi
echo "deployed: $(systemctl is-active nimotavern)"
REMOTE
rm -f "$TAR"
