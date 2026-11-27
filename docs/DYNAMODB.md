# DynamoDB 결제 저장소

결제·증빙·타임라인·감사 기록과 재전송(멱등성) 결과를 DynamoDB에 저장하는 구현입니다. 기본 저장소는 계속 SQLite이며, 환경 변수로 선택합니다. 도쿄 스택 연결과 재배포 후 보존 검증은 #35에서 진행합니다.

## 저장소 선택

| 변수 | 값 | 설명 |
| --- | --- | --- |
| `PAYMENT_STORE` | `sqlite`(기본) · `dynamodb` | 저장소 구현 선택 |
| `PAYMENT_DB_PATH` | 기본 `data/payments.sqlite` | SQLite 파일 경로 |
| `PAYMENT_TABLE` | 테이블 이름 | DynamoDB 사용 시 필수 |
| `AWS_REGION` | 예: `ap-northeast-1` | DynamoDB 리전 |
| `DYNAMODB_ENDPOINT` | 예: `http://127.0.0.1:8000` | 로컬 에뮬레이터 전용. AWS에서는 설정하지 않습니다 |

AWS 자격 증명은 SDK 기본 인증 체인(EC2 역할, 로컬 프로필)을 사용하며 코드와 설정 파일에 저장하지 않습니다. 앱과 [`scripts/assign-demo-owner.ts`](../scripts/assign-demo-owner.ts)는 같은 변수로 저장소를 엽니다.

## 테이블 설계

테이블 하나를 사용합니다. 키는 `PK`(문자열, 파티션)와 `SK`(문자열, 정렬)이며 온디맨드 과금입니다. 보조 인덱스는 없습니다.

| PK | SK | 내용 |
| --- | --- | --- |
| `STATE` | `STATE` | 현재 시연 세대 `generation` |
| `PAYMENTS` | `PAYMENT#<결제 ID>` | 결제 정보와 소유자 `ownerId`. 초기화해도 유지 |
| `PAYMENT#<결제 ID>` | `G#<세대>#EVIDENCE#<취소일>` | 고객 확인 증빙. 키로 같은 취소일 중복을 막음 |
| `PAYMENT#<결제 ID>` | `G#<세대>#EVENT#<순서>` | 타임라인 이벤트 |
| `IDEMPOTENCY#<세대>#<주체별 키 해시>` | `IDEMPOTENCY` | 최초 응답과 요청 지문 |
| `AUDIT` | `<시각>#<UUID>` | 감사 기록. 삭제하지 않음 |

- **원자적 저장:** 증빙 연결은 `TransactWriteItems` 한 번으로 다음 항목을 함께 커밋합니다.
  - 세대 확인
  - 결제 존재·소유자 확인
  - 증빙
  - 이벤트
  - 감사 기록
  - 재전송 기록
  
  하나라도 실패하면 전체가 취소됩니다.
- **동시 요청:** 같은 키나 같은 취소일 경쟁에서 진 요청, 트랜잭션 충돌이 난 요청은 최신 상태를 강한 일관성으로 다시 읽습니다. 그 결과 최초 응답을 재현하거나 `DUPLICATE_EVIDENCE`로 거절합니다.
- **시연 초기화:** 데이터를 지우는 대신 세대 번호를 1 올리고, 새 세대에 합성 증빙·이벤트를 다시 씁니다. 이 과정은 트랜잭션 한 번으로 끝납니다.
  - 이전 세대의 증빙·재전송 기록은 조회되지 않습니다.
  - 소유권과 감사 기록은 그대로 남습니다.
  - 이전 세대 항목은 테이블에 남습니다. 시연 규모에서는 문제가 없지만 장기 운영에는 TTL 정리가 필요합니다.
- **최초 시드:** 빈 테이블을 처음 열 때 합성 결제 3건을 조건부 트랜잭션으로 한 번만 씁니다. 여러 프로세스가 동시에 열어도 결과는 같습니다.
- **감사 기록 순서:** 감사 기록은 시각순 키라서 같은 밀리초 안의 순서는 보장하지 않습니다.

## 로컬 검증

DynamoDB Local(AWS 공식 에뮬레이터)과 Java 17 이상이 필요합니다. AWS 계정이나 비용은 필요하지 않습니다.

```powershell
# AWS 공식 배포본을 .dynamodb-local/ 에 압축 해제 (.gitignore 대상)
New-Item -ItemType Directory -Force .dynamodb-local
Invoke-WebRequest https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.zip -OutFile .dynamodb-local\ddb.zip
Expand-Archive .dynamodb-local\ddb.zip -DestinationPath .dynamodb-local -Force
npm run test:dynamodb
```

`npm run test:dynamodb`는 빈 포트에 인메모리 DynamoDB Local을 띄웁니다. 이어서 [저장소 계약 테스트](../tests/paymentStoreContract.test.ts)를 SQLite와 DynamoDB에 똑같이 실행한 뒤 에뮬레이터를 종료합니다. `npm test`에서는 DynamoDB 항목을 건너뛰고 SQLite 항목만 실행합니다.

계약 테스트가 확인하는 항목은 다음과 같습니다.

- 동시 시드 1회와 소유자별 조회
- 4개 인스턴스에서 같은 키로 100회 동시 요청 시 1회 저장과 최초 응답 재현, 재시작 후 재현
- 다른 키로 같은 취소일 20회 동시 요청 시 1회 저장
- 입력·키·내용 충돌·결제 불일치·소유권 오류
- HTTP 응답 계약
- 초기화 후 소유권·감사 기록 보존
- 트랜잭션 실패 주입 시 전체 롤백 (DynamoDB)

DynamoDB Local은 실제 서비스와 처리량·지연·제한이 다릅니다. 로컬 통과를 AWS 실제 검증으로 기록하지 않습니다.
