import test from "node:test";
import assert from "node:assert/strict";
import { createBedrockAnalyzer } from "../src/server/evidence/bedrock.js";
import { AnalysisFailed, isAiConfigured } from "../src/server/evidence/analyzer.js";

test("Bedrock 텍스트·이미지 요청과 결제 후보를 연결한다", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const analyze = createBedrockAnalyzer({ region: "ap-northeast-2", modelId: "test-model", send: async (command, options) => {
    assert.equal(command.input.modelId, "test-model");
    assert.equal(command.input.messages?.[0].content?.[0].text, "취소 안내");
    assert.deepEqual(command.input.messages?.[0].content?.[1].image, { format: "png", source: { bytes } });
    assert.ok(options.abortSignal instanceof AbortSignal);
    return { $metadata: {}, stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: '```json\n{"orderNumber":"ORDER-001","amount":50000,"currency":"KRW","cancelledOn":"2026-11-19"}\n```' }] } } };
  } });
  assert.deepEqual(await analyze({ text: "취소 안내", images: [{ mediaType: "image/png", bytes }] }), {
    fields: { orderNumber: "ORDER-001", amount: 50000, currency: "KRW", cancelledOn: "2026-11-19" },
    candidatePaymentIds: ["PAY-001"], provider: "bedrock",
  });
});

test("Bedrock 권한·한도·깨진 응답·출력 잘림은 재시도 가능한 분석 오류다", async () => {
  for (const name of ["AccessDeniedException", "CredentialsProviderError", "ThrottlingException", "TimeoutError"]) {
    const analyze = createBedrockAnalyzer({ send: async () => { throw Object.assign(new Error("secret"), { name }); } });
    await assert.rejects(analyze({ text: "x", images: [] }), error => error instanceof AnalysisFailed && !error.message.includes("secret"));
  }
  for (const [text, stopReason] of [["not json", "end_turn"], ['{"amount":50000}', "max_tokens"]] as const) {
    const analyze = createBedrockAnalyzer({ send: async () => ({ $metadata: {}, stopReason, output: { message: { role: "assistant", content: [{ text }] } } }) });
    await assert.rejects(analyze({ images: [] }), AnalysisFailed);
  }
});

test("Bedrock 설정 여부는 실제 인증 성공을 의미하지 않는다", () => {
  assert.equal(isAiConfigured({ AI_PROVIDER: "bedrock", AWS_REGION: "ap-northeast-2", BEDROCK_MODEL_ID: "model" }), true);
  assert.equal(isAiConfigured({ AI_PROVIDER: "bedrock", GEMINI_API_KEY: "unused" }), false);
});
