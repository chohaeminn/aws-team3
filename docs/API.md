# 공통 API · 초기 계약

팀원들이 병렬 개발하기 위한 초기 구현입니다. 변경 시 영향받는 담당자 리뷰를 요청합니다.

## 공통 규칙

- 공유 타입: `src/shared/types.ts`
- 거래 ID: `PAY-001` ~ `PAY-003`, 주문번호: `ORDER-001` ~ `ORDER-003`
- 금액: 통화의 주요 단위. 현재는 KRW 양의 안전한 정수와 전액 취소만 지원
- 거래·취소 날짜: `YYYY-MM-DD`, 확인 시각: UTC ISO 8601
- 상태값: `confirmed` / `unconfirmed`, 가맹점과 카드 각각 계산
- 오류: `{ "code": "오류코드", "message": "한국어 안내" }`
- 모든 데이터는 합성 데이터. 저장은 프로세스 메모리이며 서버 재시작 시 초기화

## 엔드포인트

| 메서드 | 경로 | 결과 |
| --- | --- | --- |
| GET | `/api/health` | 서버 상태, 합성 데이터·AI 연결 여부 |
| GET | `/api/payments` | `PaymentView[]` |
| GET | `/api/payments/:id` | `PaymentView` |
| POST | `/api/evidence/analyze` | ② 담당 연결 전 `501 AI_NOT_CONFIGURED` |
| POST | `/api/payments/:id/evidence` | 고객 확인 증빙 연결, `201 PaymentView` |
| POST | `/api/demo/reset` | 합성 데이터 초기화, `{ "ok": true }` |

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

## AI 분석 연결 계약

입력은 `{ "text": "합성 취소 메일 텍스트" }`입니다. 빈 입력은 `400 INVALID_INPUT`입니다.

② 담당이 `src/server/evidence/analyzer.ts`를 구현합니다. 반환 타입은 다음과 같습니다.

```ts
interface AnalysisResult {
  fields: Partial<EvidenceFields>;
  candidatePaymentIds: string[];
  provider: "bedrock";
}
```

누락 항목은 값을 지어내지 않고 생략합니다. 후보는 자동 확정하지 않습니다. UI는 추출값을 편집할 수 있고 고객 확인 후 별도 연결 API를 호출합니다. 후보 선택 UI, 캡처 업로드, Bedrock 오류별 재시도는 후속 구현 대상입니다. 실제 어댑터를 연결할 때 health 응답과 화면의 AI 미연결 안내도 함께 수정합니다.

## 상태 판단 · ③ 담당

`src/server/status/paymentStatus.ts`의 순수 함수 `toPaymentView`가 상태, 다음 행동, 문의 요약을 계산합니다.

- 고객이 확인해 연결한 증빙이 있으면 가맹점 취소 확인
- 해당 거래의 합성 `card_cancel` 기록이 있으면 카드 반영 확인
- 카드 기록이 없으면 반영 미확인. 취소 증빙만으로 환불 완료로 표시하지 않음
- 현재 전액 취소 기록만 다룸. 부분 취소·복수 카드 취소를 지원하려면 기록 금액·통화 및 합산 검증부터 확장

## 시연 범위

로컬 서버는 `127.0.0.1`에만 바인딩합니다. 인증·영속 저장·실제 카드사 연동은 없습니다. 공유 배포 전 인증, 데이터 격리, 초기화 API 접근 제어를 구현해야 합니다.
