param(
  [string]$Profile = 'refund-demo',
  [string]$Region = 'ap-northeast-2',
  [string]$Stack = 'refund-tracker-demo',
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
if ($Region -ne 'ap-northeast-2') { throw 'This demo is configured for ap-northeast-2.' }
function Invoke-Aws {
  $cliArguments = $args
  $result = & aws @cliArguments --profile $Profile --region $Region --no-cli-pager
  if ($LASTEXITCODE -ne 0) { throw "AWS command failed: $($cliArguments[0]) $($cliArguments[1])" }
  return $result
}
$identity = Invoke-Aws @('sts', 'get-caller-identity', '--output', 'json') | ConvertFrom-Json
if ($identity.Account -ne '727847798739') { throw "Wrong account: $($identity.Account). Expected 727847798739." }
if ($identity.Arn -match ':root$') { throw 'Use an IAM/SSO role instead of root credentials.' }
Write-Host "Verified target account $($identity.Account), region $Region"
Invoke-Aws @('cloudformation', 'validate-template', '--template-body', 'file://infra/demo.yaml') | Out-Null
if ($CheckOnly) { return }
foreach ($task in @('typecheck', 'build', 'test')) {
  $npmCommand = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { 'npm.cmd' } else { 'npm' }
  & $npmCommand run $task
  if ($LASTEXITCODE -ne 0) { throw "npm run $task failed" }
}
$artifactDir = Join-Path $repo '.deploy'
New-Item -ItemType Directory -Force $artifactDir | Out-Null
$archive = Join-Path $artifactDir 'refund-tracker.tgz'
& tar -czf $archive src dist/web package.json package-lock.json infra/install.sh scripts/assign-demo-owner.ts
if ($LASTEXITCODE -ne 0) { throw 'Artifact creation failed' }
Invoke-Aws @('cloudformation', 'deploy', '--template-file', 'infra/demo.yaml', '--stack-name', $Stack, '--capabilities', 'CAPABILITY_IAM', '--no-fail-on-empty-changeset') | Out-Host
$description = Invoke-Aws @('cloudformation', 'describe-stacks', '--stack-name', $Stack, '--output', 'json') | ConvertFrom-Json
$outputs = $description.Stacks[0].Outputs
$bucket = ($outputs | Where-Object OutputKey -eq 'ArtifactBucket').OutputValue
$instance = ($outputs | Where-Object OutputKey -eq 'InstanceId').OutputValue
$pool = ($outputs | Where-Object OutputKey -eq 'CognitoUserPoolId').OutputValue
$client = ($outputs | Where-Object OutputKey -eq 'CognitoClientId').OutputValue
$domain = ($outputs | Where-Object OutputKey -eq 'CognitoDomain').OutputValue
$key = 'releases/' + [guid]::NewGuid().ToString() + '.tgz'
Invoke-Aws @('s3', 'cp', $archive, "s3://$bucket/$key") | Out-Host
$online = $false
for ($i = 0; $i -lt 60; $i++) {
  $info = Invoke-Aws @('ssm', 'describe-instance-information', '--filters', "Key=InstanceIds,Values=$instance", '--output', 'json') | ConvertFrom-Json
  if ($info.InstanceInformationList.PingStatus -contains 'Online') { $online = $true; break }
  Start-Sleep -Seconds 5
}
if (-not $online) { throw 'SSM is not online. Inspect instance and IAM role before retrying.' }
$commands = @(
  'set -eu',
  "aws s3 cp s3://$bucket/$key /tmp/refund-tracker.tgz --region $Region",
  'tar -xzf /tmp/refund-tracker.tgz -C /tmp infra/install.sh',
  "bash /tmp/infra/install.sh s3://$bucket/$key $Region $pool $client $domain"
)
$parameters = Join-Path $artifactDir 'ssm-parameters.json'
[IO.File]::WriteAllText($parameters, (@{commands=$commands; executionTimeout=@('1200')} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$command = Invoke-Aws @('ssm', 'send-command', '--instance-ids', $instance, '--document-name', 'AWS-RunShellScript', '--parameters', "file://$parameters", '--output', 'json') | ConvertFrom-Json
$commandId = $command.Command.CommandId
$status = 'Pending'
for ($i = 0; $i -lt 250; $i++) {
  Start-Sleep -Seconds 5
  $invocations = Invoke-Aws @('ssm', 'list-command-invocations', '--command-id', $commandId, '--details', '--output', 'json') | ConvertFrom-Json
  if ($invocations.CommandInvocations.Count -gt 0) {
    $status = $invocations.CommandInvocations[0].Status
    if ($status -notin @('Pending', 'InProgress', 'Delayed')) { break }
  }
}
if ($status -ne 'Success') { throw "Install status: $status. Inspect SSM command $commandId. Resources remain allocated." }
Write-Host "Installed on $instance. Actual Bedrock inference still needs verification."
Write-Host "aws ssm start-session --target $instance --document-name AWS-StartPortForwardingSession --parameters portNumber=3000,localPortNumber=3000 --profile $Profile --region $Region"
Write-Host 'Open http://localhost:3000 and run the synthetic evidence analysis.'
