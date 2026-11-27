import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { AnalysisFailed, findCandidatePaymentIds, instruction, sanitizeFields, type EvidenceAnalyzer } from "./analyzer.js";

type Send = (command: ConverseCommand, options: { abortSignal: AbortSignal }) => Promise<ConverseCommandOutput>;

export function createBedrockAnalyzer({
  region = process.env.AWS_REGION,
  modelId = process.env.BEDROCK_MODEL_ID,
  send,
}: { region?: string; modelId?: string; send?: Send } = {}): EvidenceAnalyzer {
  // SDK 기본 인증 체인: 로컬 프로필 또는 EC2 역할. 코드에 액세스 키를 저장하지 않는다.
  return async input => {
    const client = send ? undefined : new BedrockRuntimeClient({ region, maxAttempts: 2 });
    const invoke: Send = send ?? ((command, options) => client!.send(command, options));
    const content: NonNullable<ConverseCommandInput["messages"]>[number]["content"] = [];
    content.push({ text: input.text?.trim() || "첨부된 취소 증빙 이미지에서 항목을 추출해 주세요." });
    for (const image of input.images) content.push({ image: {
      format: image.mediaType === "image/png" ? "png" : "jpeg", source: { bytes: image.bytes },
    } });
    try {
      const response = await invoke(new ConverseCommand({
        modelId, system: [{ text: instruction }], messages: [{ role: "user", content }],
        inferenceConfig: { temperature: 0, maxTokens: 512 },
      }), { abortSignal: AbortSignal.timeout(30_000) });
      if (response.stopReason !== "end_turn") throw new Error("IncompleteResponse");
      const text = (response.output?.message?.content ?? []).map(part => part.text ?? "").join("").trim();
      const json = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      const fields = sanitizeFields(JSON.parse(json));
      return { fields, candidatePaymentIds: findCandidatePaymentIds(fields), provider: "bedrock" };
    } catch (error) {
      // 증빙 원문·AWS 응답 본문·자격 증명은 기록하지 않는다.
      const name = error instanceof Error ? error.name : "UnknownError";
      console.error(`[bedrock] ${name}`);
      if (name === "AccessDeniedException" || name === "CredentialsProviderError") {
        throw new AnalysisFailed("Bedrock 인증 또는 모델 호출 권한을 확인해 주세요.");
      }
      if (name === "ThrottlingException") throw new AnalysisFailed("AI 요청 한도를 초과했어요. 잠시 후 다시 시도해 주세요.");
      throw new AnalysisFailed("Bedrock 분석에 실패했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      client?.destroy();
    }
  };
}
