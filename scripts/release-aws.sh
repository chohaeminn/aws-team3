#!/bin/bash
set -euo pipefail
archive="${1:?Pass the verified release archive}"
: "${DEMO_INSTANCE_ID:?}" "${DEMO_ARTIFACT_BUCKET:?}" "${COGNITO_USER_POOL_ID:?}" "${COGNITO_CLIENT_ID:?}" "${COGNITO_DOMAIN:?}"
region="${AWS_REGION:?Set the region of the existing demo stack}"
[[ "$region" =~ ^ap-northeast-[12]$ ]]
[[ "$DEMO_INSTANCE_ID" =~ ^i-[a-f0-9]+$ ]]
[[ "$DEMO_ARTIFACT_BUCKET" =~ ^[a-z0-9.-]{3,63}$ ]]
[[ "$COGNITO_USER_POOL_ID" =~ ^${region}_[a-zA-Z0-9]+$ ]]
[[ "$COGNITO_CLIENT_ID" =~ ^[a-zA-Z0-9]+$ ]]
[[ "$COGNITO_DOMAIN" =~ ^[a-z0-9-]+\.auth\.${region}\.amazoncognito\.com$ ]]
payment_table="${PAYMENT_TABLE:-}"
[[ -z "$payment_table" || "$payment_table" =~ ^[A-Za-z0-9_.-]{3,255}$ ]]
account=$(aws sts get-caller-identity --query Account --output text)
[[ "$account" == 727847798739 ]] || { echo 'Wrong AWS account'; exit 1; }
key="releases/${GITHUB_SHA:-manual}-$(date +%s).tgz"
uri="s3://$DEMO_ARTIFACT_BUCKET/$key"
aws s3 cp "$archive" "$uri" --region "$region"
parameters=$(mktemp)
trap 'rm -f "$parameters"' EXIT
jq -n --arg uri "$uri" --arg region "$region" --arg pool "$COGNITO_USER_POOL_ID" --arg client "$COGNITO_CLIENT_ID" --arg domain "$COGNITO_DOMAIN" --arg table "$payment_table" \
  '{commands:["set -eu",("aws s3 cp "+$uri+" /tmp/refund-tracker.tgz --region "+$region),"tar -xzf /tmp/refund-tracker.tgz -C /tmp infra/install.sh",("bash /tmp/infra/install.sh "+$uri+" "+$region+" "+$pool+" "+$client+" "+$domain+(if $table == "" then "" else " "+$table end))],executionTimeout:["1200"]}' > "$parameters"
command_id=$(aws ssm send-command --instance-ids "$DEMO_INSTANCE_ID" --document-name AWS-RunShellScript --parameters "file://$parameters" --query Command.CommandId --output text --region "$region")
for attempt in {1..250}; do
  sleep 5
  status=$(aws ssm list-command-invocations --command-id "$command_id" --query 'CommandInvocations[0].Status' --output text --region "$region")
  case "$status" in
    Success) echo "Installed release on $DEMO_INSTANCE_ID (SSM $command_id)"; exit 0 ;;
    Pending|InProgress|Delayed|None) ;;
    *) echo "Release failed: $status. Inspect SSM command $command_id; infrastructure remains allocated."; exit 1 ;;
  esac
done
echo "Release timed out. Inspect SSM command $command_id."
exit 1
