import type { AnalysisResult } from "../../shared/types.js";

export interface EvidenceImage {
  mediaType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
}

export interface EvidenceAnalysisInput {
  text?: string;
  images: readonly EvidenceImage[];
}

export type EvidenceAnalyzer = (input: EvidenceAnalysisInput) => Promise<AnalysisResult>;

export class AnalysisUnavailable extends Error {}
// ② 담당: Bedrock 어댑터로 교체. 예시를 실제 AI 결과처럼 반환하지 않는다.
export async function analyzeEvidence(_input: EvidenceAnalysisInput): Promise<AnalysisResult> {
  throw new AnalysisUnavailable("Bedrock 분석은 아직 연결되지 않았어요. 예시를 불러오거나 직접 입력해 고객 확인 흐름을 시연할 수 있어요.");
}
