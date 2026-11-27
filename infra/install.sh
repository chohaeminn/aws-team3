#!/bin/bash
set -euo pipefail
artifact_uri="$1"
region="$2"
pool_id="${3:?Cognito user pool ID required}"
client_id="${4:?Cognito client ID required}"
domain="${5:?Cognito domain required}"
payment_table="${6:-}"
[[ "$region" =~ ^ap-northeast-[12]$ ]]
[[ "$pool_id" =~ ^${region}_[a-zA-Z0-9]+$ ]]
[[ "$client_id" =~ ^[a-zA-Z0-9]+$ ]]
[[ "$domain" =~ ^[a-z0-9-]+\.auth\.${region}\.amazoncognito\.com$ ]]
# 테이블 이름이 주어지면 DynamoDB, 없으면 기존 SQLite를 사용한다. SQLite 파일은 되돌릴 때를 위해 그대로 둔다.
if [[ -n "$payment_table" ]]; then
  [[ "$payment_table" =~ ^[A-Za-z0-9_.-]{3,255}$ ]]
  payment_store="PAYMENT_STORE=dynamodb
PAYMENT_TABLE=$payment_table"
else
  payment_store="PAYMENT_STORE=sqlite"
fi
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
$payment_store
COGNITO_USER_POOL_ID=$pool_id
COGNITO_CLIENT_ID=$client_id
COGNITO_DOMAIN=$domain
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
if [[ -n "$payment_table" ]]; then
  # Copy customer ownership from the previous SQLite file before the app serves requests. Idempotent; prints no customer IDs.
  install -d -o refund-tracker -g refund-tracker -m 0700 /var/lib/refund-tracker
  runuser -u refund-tracker -- bash -c 'set -a; . /etc/refund-tracker.env; set +a; cd /opt/refund-tracker; exec /opt/refund-tracker/bin/node node_modules/tsx/dist/cli.mjs scripts/migrate-sqlite-owners.ts'
fi
systemctl daemon-reload
systemctl enable --now refund-tracker
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:3000/api/health; then exit 0; fi
  sleep 2
done
journalctl -u refund-tracker -n 30 --no-pager
exit 1
