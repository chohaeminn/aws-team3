# AWS 배포 및 Bedrock 연결

Cognito 인증과 GitHub Actions를 추가한 최신 수동 진행 순서는 [AWS 수동 설정](AWS_MANUAL_SETUP.md)과 [CI/CD 안내](CI_CD.md)를 따릅니다. 업무 API는 인증이 없으면 차단되며 합성 거래는 운영자가 고객에게 배정해야 합니다.

실제 생성된 스택 출력은 도쿄 `ap-northeast-1`입니다. 아래 서울 리전 예시는 초기 계획이며 기존 스택에는 `-Region ap-northeast-1`을 사용합니다. GitHub environment의 `AWS_REGION`도 `ap-northeast-1`로 맞춥니다. 배포 코드는 pool ID·도메인과 리전의 일치를 확인합니다.

대상 계정은 `727847798739` (`squarenetedu003`), 리전은 서울 `ap-northeast-2`입니다. 이메일·정규 사용자 ID는 인증 수단이 아닙니다. AWS 자격 증명은 저장소나 채팅에 넣지 않습니다.

## 준비된 구성과 아직 필요한 검증

- Bedrock Converse API로 텍스트와 PNG/JPEG를 분석합니다. `AI_PROVIDER=bedrock`을 선택하며 기존 Gemini 모드도 유지합니다.
- 모델은 `apac.amazon.nova-lite-v1:0`입니다. APAC 교차 리전 추론이므로 서울 밖 APAC 리전에서도 처리될 수 있습니다. 합성 증빙으로 시연합니다.
- CloudFormation은 단일 EC2 t3.small, 암호화된 gp3 12GB, 전용 VPC, 비공개 S3 아티팩트 버킷과 EC2 역할을 생성합니다. NAT Gateway·로드밸런서는 만들지 않습니다.
- 인바운드 포트는 열지 않습니다. 앱은 localhost에서 실행하고 SSM 포트 포워딩으로 팀원이 접속합니다. EC2에는 아웃바운드 통신용 공인 IPv4가 부여됩니다.
- EC2 역할에는 SSM 관리 권한, 해당 버킷의 배포 파일 읽기, Nova Lite 호출 권한만 부여합니다. 배포 사용자에게는 별도로 CloudFormation, EC2/VPC, S3, IAM 역할 생성·PassRole, SSM 실행 권한이 필요합니다.
- AWS 인증·크레딧 잔액·모델 사용 가능 여부·실제 배포·실제 AI 호출은 아직 확인하지 않았습니다.

## PC 인증

AWS CLI v2와 Session Manager plugin을 설치하고 터미널을 다시 엽니다. Node.js 22.18 이상인 22.x 또는 24 이상과 npm, tar도 필요합니다.

조직에서 IAM Identity Center를 제공하면 다음처럼 로그인합니다. SSO 시작 URL과 권한 역할은 해당 계정의 설정을 사용합니다.

```powershell
aws configure sso --profile refund-demo
aws sso login --profile refund-demo
aws sts get-caller-identity --profile refund-demo
```

Identity Center를 사용하지 않는 계정이면 IAM 사용자 또는 임시 역할 자격 증명을 로컬 AWS 프로필 `refund-demo`에 설정합니다. 루트 액세스 키는 만들지 않습니다. 스크립트는 다른 계정과 루트 인증을 거부합니다.

## 실행

```powershell
npm ci
# 읽기 전용: 계정 및 템플릿 검증
.\scripts\deploy-aws.ps1 -CheckOnly
# 로컬 검사 → 스택 생성/갱신 → 파일 업로드 → SSM 설치 및 health 확인
.\scripts\deploy-aws.ps1
```

완료 시 출력되는 `aws ssm start-session ...` 명령을 실행하고 http://localhost:3000 에 접속합니다. 팀원도 해당 인스턴스로 SSM 세션을 시작할 AWS 권한과 플러그인이 필요합니다. 공개 서비스 URL은 생성하지 않습니다.

배포는 인프라 생성 이후 설치에 실패할 수 있습니다. 스크립트는 이 경우 오류로 종료하며 생성된 리소스는 남습니다. CloudFormation 이벤트·SSM 명령 결과를 확인하고 수정 후 재실행합니다. SQLite 파일은 systemd StateDirectory인 `/var/lib/refund-tracker`에 저장하므로 같은 인스턴스의 앱 재시작·재배포 후 보존됩니다. 인스턴스 교체·스택 삭제 시에는 EBS가 삭제되므로 데이터가 사라집니다. 백업과 복구 검증은 별도 과제입니다.

## 실제 검증

`/api/health`의 `aiConnected`는 설정 존재 여부입니다. 인증·권한·모델 호출 성공을 보장하지 않습니다. 다음을 직접 확인해 [시연 체크리스트](DEMO_CHECKLIST.md)에 기록합니다.

1. 합성 취소 텍스트 실제 분석 → 주문번호·금액·통화·취소일 확인.
2. PNG/JPEG 실제 분석 → 추출값 수정·고객 확인·PAY-001 연결.
3. 상태·타임라인·문의자료 복사·시연 초기화 확인.
4. 다른 팀원 PC에서 SSM 접속과 동일 흐름 확인.

모델 접근 거부는 역할 권한·모델 사용 가능 여부·조직 SCP·APAC 대상 리전 제한을 확인합니다. 비용은 EC2, EBS, 공인 IPv4, S3, Bedrock 사용량에 따라 발생합니다. Billing에서 크레딧 만료일과 적용 대상을 확인하고 예산 알림을 설정합니다. 크레딧 적용과 무료 사용을 가정하지 않습니다.

## 종료 및 삭제

EC2 중지만으로 EBS·공인 IPv4 등 모든 비용이 없어지는 것은 아닙니다. 완전히 정리하려면 대상 계정을 다시 확인하고, 이 스택의 `ArtifactBucket` 출력으로 확인한 버킷만 비운 뒤 스택을 삭제합니다. 버킷이 비어 있지 않으면 CloudFormation 삭제가 실패합니다. 다른 계정·스택의 버킷을 비우지 않습니다.

```powershell
aws sts get-caller-identity --profile refund-demo
aws cloudformation describe-stacks --stack-name refund-tracker-demo --region ap-northeast-2 --profile refund-demo
# 위 출력에서 확인한 이 데모의 ArtifactBucket 값만 사용
aws s3 rm s3://<ArtifactBucket> --recursive --profile refund-demo
aws cloudformation delete-stack --stack-name refund-tracker-demo --region ap-northeast-2 --profile refund-demo
aws cloudformation wait stack-delete-complete --stack-name refund-tracker-demo --region ap-northeast-2 --profile refund-demo
```

참고: [AWS JavaScript Converse 예제](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_bedrock-runtime_code_examples.html), [Nova Lite 모델·리전](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-lite.html), [Amazon Linux Node.js](https://docs.aws.amazon.com/linux/al2023/ug/nodejs.html).
