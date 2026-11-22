import type { EvidenceAnalyzer } from "../../src/server/evidence/analyzer.js";
import type { AnalysisResult } from "../../src/shared/types.js";

export function createMockEvidenceAnalyzer(result: AnalysisResult): EvidenceAnalyzer {
  const fixture = structuredClone(result);
  return async () => structuredClone(fixture);
}
