# AWS에서 직접 진행할 설정 순서

애플리케이션·테스트·CI/CD 코드는 저장소에서 준비합니다. 이 절차는 계정 `727847798739`, 서울 `ap-northeast-2`, 유료 시연용 단일 인스턴스를 대상으로 합니다. 실제 고객 정보나 카드 데이터는 사용하지 않습니다.

## 데모 인프라 생성

1. AWS 콘솔 오른쪽 위에서 계정 ID와 서울 리전을 확인합니다.
2. CloudFormation에서 **새 리소스로 스택 생성**을 선택하고 저장소의 `infra/demo.yaml`을 업로드합니다. 스택 이름은 `refund-tracker-demo`를 사용합니다.
3. 기본 AMI 값을 유지합니다. 검토 화면에서 EC2용 IAM 역할이 생성되는 내용을 확인하고 생성합니다. 이 역할은 SSM, 배포 파일 읽기, Nova Lite 호출에 사용됩니다.
4. `CREATE_COMPLETE` 이후 Outputs의 InstanceId, ArtifactBucket, CognitoUserPoolId, CognitoClientId, CognitoDomain을 기록합니다. 비밀번호나 액세스 키는 공유하지 않습니다.

인프라만 생성하면 앱은 아직 설치되지 않습니다. 아래 OIDC와 GitHub 설정을 마친 후 CD로 설치합니다. EC2 t3.small·gp3 12GB·공인 IPv4·S3·Cognito·Bedrock 사용료가 발생할 수 있습니다. 사용 후 정리 절차는 [AWS 배포 안내](AWS_DEPLOYMENT.md)를 따릅니다.

## GitHub 배포 역할 생성

1. GitHub 저장소 Settings → Environments에서 `aws-demo`를 만듭니다. Deployment branches and tags는 **main만** 허용합니다. 필요하면 수동 승인자도 지정합니다.
2. AWS IAM → Identity providers에 `token.actions.githubusercontent.com`이 이미 있으면 해당 ARN을 확인합니다.
3. CloudFormation에 `infra/github-oidc.yaml`을 업로드해 별도 스택을 생성합니다. ArtifactBucket과 InstanceId에는 앞 단계 Outputs의 정확한 값을 넣습니다. ExistingProviderArn은 기존 provider가 있을 때만 넣습니다. 없으면 빈 값으로 두어 생성합니다.
4. 생성되는 역할의 신뢰 대상이 `chohaeminn/aws-team3`의 `aws-demo` environment이고, S3와 SSM 대상이 해당 데모 리소스인지 확인합니다.
5. Outputs의 RoleArn과 데모 스택의 공개 설정을 [CI/CD 변수 표](CI_CD.md)에 따라 GitHub environment Variables에 등록합니다. AWS 액세스 키를 Secrets에 넣지 않습니다.

## 앱 설치

GitHub → Actions → **Deploy AWS demo** → Run workflow에서 main을 선택하고 계정 ID를 확인해 실행합니다. 검증 두 작업과 deploy 작업이 성공했는지 확인합니다. 실패하면 해당 단계 로그와 SSM Command ID를 확인합니다.

로컬 CLI를 사용할 경우 [AWS 공식 CLI 로그인](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html)으로 임시 인증을 연결할 수 있습니다. 이 작업 환경에는 공식 CLI를 `.deploy/aws-cli/Amazon/AWSCLIV2/aws.exe`에 준비했으며 저장소에는 포함하지 않습니다. 해당 경로를 PATH에 추가하거나 공식 설치본을 사용합니다.

## 시연 사용자와 거래 배정

1. Cognito → 생성된 User pool → Users에서 시연 사용자 두 명과 관리자 한 명을 생성합니다. 실제 고객 대신 통제할 수 있는 테스트 이메일을 사용합니다. 공개 회원 가입은 꺼져 있습니다. 초기 비밀번호와 변경 절차는 Cognito 화면에서 직접 처리합니다.
2. 관리자를 `refund-demo-admin` 그룹에 추가합니다. 일반 고객은 이 그룹에 넣지 않습니다. AWS 콘솔 사용자와 앱 고객 계정은 별개의 계정입니다.
3. 고객 상세의 `sub` UUID를 확인합니다. 거래는 처음에 `unassigned`이며 어떤 고객에게도 자동 배정되지 않습니다.
4. EC2 → 해당 인스턴스 → Connect → Session Manager로 접속하고 다음 명령으로 **아직 배정되지 않은 합성 거래만** 첫 고객에게 배정합니다. 실제 고객의 sub 대신 방금 만든 시연 고객의 sub를 넣습니다.

```sh
sudo -u refund-tracker env PAYMENT_DB_PATH=/var/lib/refund-tracker/payments.sqlite /opt/refund-tracker/bin/node /opt/refund-tracker/node_modules/tsx/dist/cli.mjs /opt/refund-tracker/scripts/assign-demo-owner.ts '<시연 고객 sub UUID>'
```

현재는 합성 거래 3건을 첫 고객에게 배정합니다. 두 번째 고객은 목록이 비어 있어야 하며 첫 고객의 거래 ID로 요청해도 404여야 합니다. 실제 데이터 입력·고객 관리 UI는 구현 범위에 없습니다.

## 브라우저 접속과 실제 확인

PC에 AWS CLI와 Session Manager plugin을 준비하고 로컬 3000번 포트를 비운 뒤 실행합니다.

```sh
aws ssm start-session --target <InstanceId> --document-name AWS-StartPortForwardingSession --parameters portNumber=3000,localPortNumber=3000 --region ap-northeast-2 --profile refund-demo
```

http://localhost:3000 에서 로그인합니다. Cognito callback과 logout URL이 이 주소로 설정돼 있으므로 다른 포트나 127.0.0.1 주소로 바꾸지 않습니다. HTTP localhost는 SSM 로컬 시연용이며 외부 공개 운영에는 HTTPS와 callback 변경이 필요합니다.

다음 결과를 실제 수행한 날짜·커밋과 함께 [시연 체크리스트](DEMO_CHECKLIST.md)에 기록합니다.

- 고객 1: 배정된 거래 조회·합성 증빙 연결·문의자료 확인
- 고객 2: 타인 거래 조회/연결 거부, 관리자 초기화 거부
- 관리자: 전체 합성 거래 조회·초기화, 고객 소유권 유지
- Bedrock: 텍스트와 PNG/JPEG 실제 추론, 추출 4개 필드와 사용 모델 확인
- 앱 재시작: 증빙·멱등성 결과 보존

AWS 설정 전 로컬에서 통과한 서명·권한 테스트는 실제 Cognito 로그인 검증으로 기록하지 않습니다. 토큰·비밀번호·AWS 자격 증명은 이슈, 로그, 화면 캡처, 채팅에 넣지 않습니다.
