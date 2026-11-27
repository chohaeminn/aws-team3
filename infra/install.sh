#!/bin/bash
set -euo pipefail
artifact_uri="$1"
region="$2"
dnf install -y nodejs22 nodejs22-npm
id refund-tracker &>/dev/null || useradd --system --home-dir /opt/refund-tracker refund-tracker
install -d -o refund-tracker -g refund-tracker /opt/refund-tracker
aws s3 cp "$artifact_uri" /tmp/refund-tracker.tgz --region "$region"
systemctl stop refund-tracker.service || true
tar -xzf /tmp/refund-tracker.tgz -C /opt/refund-tracker
cd /opt/refund-tracker
# Amazon Linux installs versioned Node binaries.
install -d /opt/refund-tracker/bin
ln -sf /usr/bin/node-22 /opt/refund-tracker/bin/node
ln -sf /usr/bin/npm-22 /opt/refund-tracker/bin/npm
export PATH="/opt/refund-tracker/bin:$PATH"
node --version
npm ci --no-audit --no-fund
cat >/etc/refund-tracker.env <<EOF
HOST=127.0.0.1
PORT=3000
AI_PROVIDER=bedrock
AWS_REGION=$region
BEDROCK_MODEL_ID=apac.amazon.nova-lite-v1:0
NODE_ENV=production
PAYMENT_DB_PATH=/var/lib/refund-tracker/payments.sqlite
EOF
cat >/etc/systemd/system/refund-tracker.service <<'EOF'
[Unit]
Description=Refund Tracker demo
After=network-online.target
Wants=network-online.target
[Service]
User=refund-tracker
Group=refund-tracker
WorkingDirectory=/opt/refund-tracker
EnvironmentFile=/etc/refund-tracker.env
Environment=PATH=/opt/refund-tracker/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/opt/refund-tracker/bin/node node_modules/tsx/dist/cli.mjs src/server/index.ts
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
StateDirectory=refund-tracker
StateDirectoryMode=0700
ProtectSystem=strict
ProtectHome=true
[Install]
WantedBy=multi-user.target
EOF
chmod 644 /etc/refund-tracker.env
chown -R refund-tracker:refund-tracker /opt/refund-tracker
systemctl daemon-reload
systemctl enable --now refund-tracker
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:3000/api/health; then exit 0; fi
  sleep 2
done
journalctl -u refund-tracker -n 30 --no-pager
exit 1
