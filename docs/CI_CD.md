# GitHub Actions 검증과 AWS 배포

PR과 main 변경은 GitHub Actions에서 Node.js 22.18.0과 24로 검사합니다. 수동 배포 워크플로는 동일 검증을 통과한 커밋의 아티팩트를 AWS 임시 자격 증명으로 기존 시연 인스턴스에 전달합니다. 실제 AWS 배포는 계정 설정을 완료한 뒤 실행합니다.

## CI가 확인하는 내용

`.github/workflows/ci.yml`은 `npm ci`, 애플리케이션·테스트·스크립트의 타입 검사, 프런트엔드 빌드, 전체 테스트, 셸 구문 검사와 CloudFormation lint를 실행합니다. 테스트에는 실제 RSA 서명 검증, 고객 간 접근 통제, 독립 프로세스 동시 쓰기, DB 오류 주입과 OAuth PKCE 콜백 검증이 포함됩니다.

`npm test`는 DynamoDB 전용 항목을 건너뜁니다. 이를 보완하기 위해 별도 작업 `DynamoDB Local contract`가 AWS 공식 DynamoDB Local 3.3.2 컨테이너(digest 고정)를 띄워 다음 테스트를 실행합니다. AWS 계정과 비용은 필요하지 않습니다.

- [저장소 계약 테스트](../tests/paymentStoreContract.test.ts)
- [소유권 이관 테스트](../tests/ownershipMigration.test.ts)

배포 워크플로도 이 CI를 재사용하므로, 이 작업이 실패하면 배포도 진행되지 않습니다.

Node.js 24 작업은 추가로 권한 경계 HTTP 실험을 실행하고, 해당 실행에서 검사한 소스·정적 빌드·lockfile을 `refund-tracker.tgz`로 묶습니다. 테스트 결과는 14일, 배포 아티팩트는 7일간 보관합니다. 아티팩트에는 `.env`, SQLite 파일, `.deploy`의 인증 캐시가 들어가지 않습니다.

PR 코드에는 AWS 자격 증명이 전달되지 않습니다. CI 권한은 `contents: read`이며 액션은 확인한 공식 릴리스의 전체 커밋 SHA로 고정했습니다. AWS 계정이 없어도 CI를 실행할 수 있습니다.

## CD가 배포하는 내용

`Deploy AWS demo`는 main에서 수동 실행합니다. 입력한 대상 계정이 `727847798739`인지 확인한 뒤 재사용 CI를 실행하고, **그 실행에서 생성한 아티팩트**를 다운로드합니다. 배포 단계는 GitHub environment `aws-demo`를 사용하며 OIDC로 최대 1시간의 AWS 역할 세션을 받습니다. 장기 액세스 키를 GitHub Secrets에 저장하지 않습니다.

`infra/github-oidc.yaml`의 배포 역할은 지정한 S3 버킷의 `releases/*` 업로드, 지정한 EC2 인스턴스에 SSM 명령 실행, 명령 상태 조회만 허용합니다. 인프라나 IAM 역할을 생성하는 권한은 부여하지 않습니다. SSM 명령은 해당 인스턴스에서 높은 권한으로 실행되므로 이 역할은 배포 운영 권한으로 취급합니다.

GitHub environment에는 다음 Variables를 설정합니다. 모두 리소스 식별자와 공개 로그인 설정이며 비밀번호·토큰은 넣지 않습니다.

| 변수 | 값의 출처 |
| --- | --- |
| `AWS_REGION` | 기존 스택 리전. 현재 생성된 환경은 `ap-northeast-1`(도쿄) |
| `AWS_ROLE_ARN` | OIDC 스택의 RoleArn |
| `DEMO_INSTANCE_ID` | 데모 스택의 InstanceId |
| `DEMO_ARTIFACT_BUCKET` | 데모 스택의 ArtifactBucket |
| `COGNITO_USER_POOL_ID` | 데모 스택의 CognitoUserPoolId |
| `COGNITO_CLIENT_ID` | 데모 스택의 CognitoClientId |
| `COGNITO_DOMAIN` | 데모 스택의 CognitoDomain |
| `PAYMENT_TABLE` | 데모 스택의 PaymentTable. 비우면 SQLite를 사용합니다 ([DynamoDB 전환](DYNAMODB.md#도쿄-데모-스택-전환과-복구-35)) |

**environment의 Deployment branches and tags는 main만 허용하도록 설정합니다.** OIDC trust는 `repo:chohaeminn/aws-team3:environment:aws-demo`와 audience를 검사합니다. environment가 있으면 OIDC subject에 브랜치가 직접 포함되지 않으므로 main 제한은 environment 설정으로도 적용해야 합니다.

배포는 서버 설치 후 `/api/health` 응답을 확인합니다. 이는 설치·프로세스 실행 확인이며, Cognito 실제 로그인이나 Bedrock 실제 추론 성공을 뜻하지 않습니다. 로그인 후 합성 텍스트·이미지 분석은 별도로 확인합니다. 설치 실패 시 workflow가 실패하고 리소스는 남습니다. 현재 자동 롤백과 무중단 배포는 구현하지 않았습니다.

## 포트폴리오 설명

“로컬 검증에 의존하던 변경 과정을 PR 단위 CI로 옮겼다. 두 Node.js 버전에서 정합성·권한·장애 테스트와 빌드를 실행하고, 통과한 실행의 아티팩트만 수동 배포에 사용하도록 구성했다. 배포 인증은 GitHub OIDC와 단일 인스턴스 범위의 AWS 역할로 분리했다.”

CI 성공과 실제 CD 성공은 구분해서 기록합니다. 실제 Actions 실행 내역은 [워크플로 실행 목록](https://github.com/chohaeminn/aws-team3/actions)에서 확인할 수 있습니다.
