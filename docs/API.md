# 공통 API · 초기 계약

팀원들이 병렬 개발하기 위한 초기 구현입니다. 변경 시 영향받는 담당자 리뷰를 요청합니다.

## 공통 규칙

- 공유 타입: `src/shared/types.ts`
- 거래 ID: `PAY-001` ~ `PAY-003`, 주문번호: `ORDER-001` ~ `ORDER-003`
- 금액: 통화의 주요 단위. 현재는 KRW 양의 안전한 정수와 전액 취소만 지원
- 거래·취소 날짜: `YYYY-MM-DD`, 확인 시각: UTC ISO 8601
- 상태값: `confirmed` / `unconfirmed`, 가맹점과 카드 각각 계산
- 오류: `{ "code": "오류코드", "message": "한국어 안내" }`
- 모든 데이터는 합성 데이터. 서버 실행은 SQLite 파일 저장이며 동일 파일로 재시작하면 보존

## 엔드포인트

| 메서드 | 경로 | 결과 |
| --- | --- | --- |
| GET | `/api/health` | 서버 상태, 합성 데이터, AI 공급자 설정 여부(`aiConnected`) |
| GET | `/api/payments` | `PaymentView[]` |
| GET | `/api/payments/:id` | `PaymentView` |
| POST | `/api/evidence/analyze` | `200 AnalysisResult`, 키 미설정 시 `501 AI_NOT_CONFIGURED`, 외부 AI 호출 실패 시 `502 AI_ANALYSIS_FAILED` |
| POST | `/api/payments/:id/evidence` | 고객 확인 증빙 연결, `201 PaymentView` |
| POST | `/api/demo/reset` | 합성 데이터 초기화, `{ "ok": true }` |

## 결제 조회의 타임라인

`GET /api/payments`와 `GET /api/payments/:id`는 거래마다 같은 `events`를 반환합니다. 각 항목의 `id`는 기록 식별자, `date`는 출처에 적힌 사건 날짜(`YYYY-MM-DD`), `source`는 자료 출처, `label`은 화면에 표시할 문구입니다.

| `kind` | 날짜의 의미 | 출처 |
| --- | --- | --- |
| `payment` | 결제일 | 합성 카드 결제 기록 |
| `cancel_requested` | 고객의 취소 요청 접수일 | 합성 쇼핑몰 요청 접수 내역 |
| `merchant_cancel` | 고객이 확인한 증빙의 가맹점 취소일 | 고객 확인 취소 증빙 |
| `card_cancel` | 카드 내역에 전액 취소가 반영된 날 | 합성 카드 취소 기록 |

요청 접수 자료가 있는 거래에만 `cancel_requested`를 넣습니다. 취소 메일을 연결할 때는 그 메일의 취소일로 가맹점 이벤트를 추가하고, 요청일은 추정하지 않습니다.
PAY-002에는 11월 14일 결제, 15일 요청, 16일 가맹점 확인, 18일 카드 반영이 있습니다. PAY-003에는 17일 결제와 18일 요청만 있어 가맹점·카드 상태가 모두 `unconfirmed`입니다.

## 고객 확인 증빙 연결

`POST /api/payments/PAY-001/evidence`

```json
{
  "orderNumber": "ORDER-001",
  "amount": 50000,
  "currency": "KRW",
  "cancelledOn": "2026-11-19",
  "confirmed": true
}
```

연결 시 주문번호·금액·통화가 선택한 결제와 일치하고 취소일이 결제일 이후인지 검사합니다. 형식 오류·고객 미확인은 `400 INVALID_INPUT`, 결제 불일치는 `409 PAYMENT_MISMATCH`, 같은 취소일 중복은 `409 DUPLICATE_EVIDENCE`, 없는 거래는 `404 NOT_FOUND`입니다.

성공 응답은 거래 정보에 아래 계산 결과를 포함합니다.

```json
{
  "status": {
    "merchant": "confirmed",
    "card": "unconfirmed",
    "label": "가맹점 취소 확인 / 카드 반영 미확인"
  },
  "nextAction": "가맹점 취소 증빙은 확인됐어요. 아래 자료로 카드사에 취소 반영 여부를 문의할 수 있어요.",
  "inquirySummary": "주문번호·금액·취소일·확인 출처를 포함하는 문의 문구"
}
```

위 JSON은 `PaymentView`의 상태 관련 필드만 발췌한 예시입니다. 전체 필드는 공유 타입을 확인합니다. 고객 확인은 데이터 연결에 대한 확인이며 증빙 진위의 자동 검증을 뜻하지 않습니다.

## 증빙 연결의 멱등성

업무 API는 `Authorization: Bearer <Cognito access token>`이 필요합니다. 공개 API는 `/api/health`와 `/api/auth/config`입니다. `/api/auth/me`는 인증 주체·역할을 반환하고 `/api/admin/metrics`는 관리자에게 프로세스 수명 동안의 요청·인증 거부·서버 오류·멱등성 재현 횟수를 반환합니다.

서명·발급자·클라이언트·만료·access token 용도를 확인하지 못하면 `401 UNAUTHENTICATED`입니다. 일반 고객은 자기 소유의 목록·상세·증빙 연결·AI 후보만 접근합니다. 타인 거래와 없는 거래는 모두 404이며 `/api/demo/reset`과 운영 지표는 관리자가 아니면 403입니다. 관리자 그룹 이름은 `refund-demo-admin`입니다. 소유자는 검증한 토큰의 sub에서 결정하며 본문으로 변경할 수 없습니다.

각 응답의 `X-Request-Id`는 서버가 생성합니다. 증빙 연결 감사 기록에는 요청 ID와 인증 주체가 포함됩니다. 운영 요청 로그에는 경로 템플릿·상태·소요 시간만 기록하며 URL 쿼리·본문·Authorization은 기록하지 않습니다. 업무 API는 `Cache-Control: no-store`입니다.

증빙 연결 요청은 선택적으로 `Idempotency-Key` 헤더를 받습니다. 영문·숫자·`-`·`_`로 구성한 16~128자 키를 사용합니다. 화면은 UUID를 전송하고 같은 입력의 실패 후 재시도에서 키를 재사용합니다.

같은 키·정규화한 본문·결제 ID는 최초 201 응답 본문을 그대로 재현하고 `Idempotency-Replayed: true`를 반환합니다. 최초 응답에는 `false`가 들어갑니다. 재현된 응답은 최초 시점의 스냅샷이며 최신 상태 조회는 GET API를 사용합니다. 같은 키에 다른 유효 본문·결제 ID는 `409 IDEMPOTENCY_CONFLICT`, 잘못된 키는 `400 INVALID_IDEMPOTENCY_KEY`입니다. 키가 없으면 기존 날짜 중복 검사와 409 계약을 유지합니다.

증빙·타임라인·감사 기록·멱등성 결과는 SQLite 트랜잭션 하나로 저장합니다. `npm start`는 `PAYMENT_DB_PATH`(기본 `data/payments.sqlite`) 파일을 사용하고, `createApp()`은 테스트 격리를 위한 메모리 SQLite를 기본으로 사용합니다. 키는 인증 주체별로 분리합니다. 시연 초기화는 증빙·멱등성 결과를 초기화하되 고객 소유권과 기존 감사 기록을 보존하고 초기화 이벤트를 추가합니다. 초기화는 관리자만 실행합니다.

## AI 분석 연결 계약

| Content-Type | 요청 본문 |
| --- | --- |
| `application/json` | `{ "text": "합성 취소 메일 텍스트" }`. 공백 이외의 텍스트가 필요합니다. |
| `multipart/form-data` | `text` 필드 한 개와 반복되는 `images` 파일 필드. 텍스트와 이미지 중 하나 이상이 필요합니다. 텍스트는 최대 100 KiB, 이미지는 PNG·JPEG MIME 유형만 최대 4장, 장당 3 MiB까지 받습니다. |

빈 입력과 잘못된 필드는 `400 INVALID_INPUT`입니다. 본문 크기 제한을 넘으면 `413 INVALID_INPUT`입니다. 선택한 공급자의 설정이 없으면 `501 AI_NOT_CONFIGURED`를 반환합니다. Gemini는 `GEMINI_API_KEY`, Bedrock은 `AI_PROVIDER=bedrock`과 `AWS_REGION`·`BEDROCK_MODEL_ID`를 사용합니다. 외부 AI 호출이 실패하면 `502 AI_ANALYSIS_FAILED`를 반환하며 메시지에는 API 키와 외부 응답 본문을 담지 않습니다. 화면은 재시도를 안내합니다. 그 밖의 예상하지 못한 분석 실패는 `500 INTERNAL_ERROR`입니다. 오류 본문은 공통 `{ code, message }` 형식입니다.

② 담당이 `src/server/evidence/analyzer.ts`를 구현합니다. 반환 타입은 다음과 같습니다.

```ts
interface AnalysisResult {
  fields: Partial<EvidenceFields>;
  candidatePaymentIds: string[];
  provider: "bedrock" | "gemini";
}
```
기본 공급자는 Gemini(`provider: "gemini"`)이고 `GEMINI_MODEL`로 모델을 바꿀 수 있습니다. 기본 모델은 `gemini-3.5-flash-lite`입니다. `AI_PROVIDER=bedrock`이면 AWS 기본 인증 체인으로 Bedrock을 호출합니다. `/api/health`의 `aiConnected`는 공급자 설정 존재 여부이며 실제 인증·모델 호출 성공을 보장하지 않습니다. `candidatePaymentIds`는 추출한 주문번호·금액·통화가 모두 일치하는 결제 ID입니다. 응답 예시는 다음과 같습니다.
```json
{
  "fields": { "orderNumber": "ORDER-001", "amount": 50000, "currency": "KRW", "cancelledOn": "2026-11-19" },
  "candidatePaymentIds": ["PAY-001"],
  "provider": "gemini"
}
```
외부 호출 실패 응답 예시는 `{ "code": "AI_ANALYSIS_FAILED", "message": "AI 서버가 오류를 반환했어요. 잠시 후 다시 시도해 주세요. (HTTP 500)" }`입니다.

누락 항목은 값을 지어내지 않고 생략합니다. UI는 추출값과 결제 후보를 검토하고 고객 확인 후 별도 연결 API를 호출합니다. 분석 요청은 결제와 증빙을 읽기 전용으로 다룹니다. HTTP 테스트는 `createApp({ evidenceAnalyzer })`에 모의 분석기를 주입해 성공 응답을 재현하고, Gemini 분석기는 `fetch`를 주입해 검증합니다.

## 상태 판단 · ③ 담당

`src/server/status/paymentStatus.ts`의 순수 함수 `toPaymentView`가 상태, 다음 행동, 문의 요약을 계산합니다.

- `records.ts`: 고객 확인 출처(`customer_confirmed`)·증빙 ID·UTC 확인 시각이 있고 주문번호·전액 금액·통화가 현재 결제와 일치하는 증빙만 가맹점 취소 확인 근거로 사용합니다. 취소일은 유효한 `YYYY-MM-DD`이고 결제 당일 또는 이후여야 합니다.
- 해당 거래의 합성 `card_cancel` 기록에 ID·출처·유효한 반영 날짜가 있으면 카드 반영 확인입니다. 반영일은 결제 당일 또는 이후여야 합니다. 가맹점 증빙이 없어도 카드 기록은 독립적으로 판단합니다.
- 카드 기록이 없으면 반영 미확인. 취소 증빙만으로 환불 완료로 표시하지 않음
- 현재 전액 취소 기록만 다룸. 부분 취소·복수 카드 취소를 지원하려면 기록 금액·통화 및 합산 검증부터 확장

기존 `PaymentView`의 `status.merchant`, `status.card`, `status.label`, `nextAction`, `inquirySummary` 필드를 그대로 사용하므로 UI·조회·증빙 연결 API의 호출 형식 변경은 없습니다. 조건에 맞지 않는 기록은 상태 및 문의 요약의 확인 근거에서 제외하지만 원본 `evidence`·`events` 배열을 삭제하거나 수정하지 않습니다.

| 가맹점 증빙 | 카드 기록 | 다음 행동 |
| --- | --- | --- |
| 미확인 | 미확인 | 가맹점에 취소 처리 여부·증빙 문의 후 확인·연결 |
| 확인 | 미확인 | 확보한 취소 증빙으로 카드사에 반영 여부 문의 |
| 미확인 | 확인 | 카드 기록은 유지하고 가맹점 취소 증빙 확보·연결 |
| 확인 | 확인 | 양쪽 기록의 날짜와 금액 확인 |

`inquirySummary.ts`는 주문번호·가맹점·결제금액·결제일, 상태, 유효 증빙의 취소일·출처·ID·확인 시각, 카드 기록의 반영일·출처·ID를 줄바꿈이 있는 복사용 문자열로 만듭니다. 기록은 날짜순으로 정리하며 특정 환불 처리 기한이나 결과를 추정하지 않습니다. 데이터 출처가 없는 AI 추출이나 `merchant_cancel` 타임라인 이벤트만으로 가맹점 확인 상태가 되지 않습니다.

### 검증 및 시연

`npm test`로 네 가지 상태 조합, 잘못 연결된 증빙·출처·날짜, 원본 불변성 및 증빙 연결 API의 상태 갱신을 검증합니다.

1. `PAY-001` 조회: 가맹점·카드 모두 미확인
2. 예시 본문으로 증빙 연결: 가맹점 확인·카드 미확인, 문의 요약에 취소일·고객 확인 출처 포함
3. `PAY-002` 조회: 양쪽 확인, 문의 요약에 카드 반영일 `2026-11-18` 및 합성 카드 출처 포함
4. UI의 ‘문의자료 복사’는 기존 `inquirySummary` 필드를 그대로 복사
5. 시연 초기화 후 `PAY-001`의 가맹점·카드가 다시 미확인

담당 간 합의: ① 저장소는 거래에 연결된 `card_cancel`을 전액 취소로만 제공하고, ② AI는 고객 확인 전 `Evidence`를 생성하지 않습니다. 부분 취소 지원 시 카드 기록 금액·통화·거래 연결 필드부터 별도 합의합니다.

## 시연 범위

`/api/health`의 `aiConnected`는 공급자 설정 존재 여부만 나타냅니다. 인증, 모델 접근 권한이나 실제 분석 성공을 보장하지 않습니다. 실제 성공 여부는 분석 요청 결과로 확인합니다.

로컬 서버는 기본 `127.0.0.1`에 바인딩합니다. `HOST`와 `PORT`로 변경할 수 있습니다. Cognito 인증·고객별 거래 격리·관리자 초기화를 지원하고 실제 카드사 연동은 없습니다. AWS 시연은 SSM으로 접근을 제한합니다. 로그인 화면의 OAuth callback은 localhost:3000을 사용합니다. 외부 공개 운영은 HTTPS·운영 인증 정책·백업 복구 등을 추가 검증해야 합니다. [수동 설정](AWS_MANUAL_SETUP.md)과 [시연 체크리스트](DEMO_CHECKLIST.md)를 따릅니다.
