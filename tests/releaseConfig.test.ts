import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
function validate(region: string, poolRegion = region, domainRegion = region) {
  return spawnSync(bash, ["-c", "aws() { echo identity-check >&2; return 99; }; export -f aws; bash scripts/release-aws.sh synthetic.tgz"], {
    encoding: "utf8", env: { ...process.env, AWS_REGION: region, DEMO_INSTANCE_ID: "i-0123456789abcdef0", DEMO_ARTIFACT_BUCKET: "synthetic-release-bucket",
      COGNITO_USER_POOL_ID: `${poolRegion}_Test123`, COGNITO_CLIENT_ID: "syntheticclient", COGNITO_DOMAIN: `synthetic.auth.${domainRegion}.amazoncognito.com` },
  });
}
test("기존 스택과 일치하는 도쿄·서울 설정은 인증 확인 단계까지 진행한다", () => {
  for (const region of ["ap-northeast-1", "ap-northeast-2"]) {
    const result = validate(region);
    assert.equal(result.status, 99); // A stub deliberately stops at identity verification; no AWS requests.
    assert.match(result.stderr, /identity-check/);
  }
});
test("다른 리전의 pool·domain과 미지원 리전은 AWS 호출 전에 거부한다", () => {
  for (const values of [["ap-northeast-1", "ap-northeast-2", "ap-northeast-1"], ["ap-northeast-1", "ap-northeast-1", "ap-northeast-2"], ["us-east-1", "us-east-1", "us-east-1"]]) {
    const result = validate(...values as [string, string, string]);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /identity-check/);
  }
});
