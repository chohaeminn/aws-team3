import express from "express";
import type { ErrorRequestHandler } from "express";
import { fileURLToPath } from "node:url";
import { PaymentRepository, PaymentError } from "./payments/repository.js";
import { toPaymentView } from "./status/paymentStatus.js";
import { analyzeEvidence, AnalysisFailed, AnalysisUnavailable, isAiConfigured } from "./evidence/analyzer.js";
import type { EvidenceAnalyzer } from "./evidence/analyzer.js";
import { InvalidEvidenceInput, parseEvidenceInput, readEvidenceBody } from "./evidence/request.js";

export function createApp({ evidenceAnalyzer = analyzeEvidence, repository = new PaymentRepository() }: { evidenceAnalyzer?: EvidenceAnalyzer; repository?: PaymentRepository } = {}) {
  const app = express();

  app.use(express.json({ limit: "100kb" }));
  app.get("/api/health", (_req, res) => res.json({ ok: true, synthetic: true, aiConnected: isAiConfigured() }));
  app.get("/api/payments", (_req, res) => res.json(repository.list().map(toPaymentView)));
  app.get("/api/payments/:id", (req, res) => {
    const payment = repository.get(req.params.id);
    if (!payment) { res.status(404).json({ code: "NOT_FOUND", message: "결제 건을 찾을 수 없어요." }); return; }
    res.json(toPaymentView(payment));
  });
  app.post("/api/evidence/analyze", readEvidenceBody, async (req, res) => {
    try { res.json(await evidenceAnalyzer(await parseEvidenceInput(req))); }
    catch (error) {
      if (error instanceof InvalidEvidenceInput) {
        res.status(400).json({ code: "INVALID_INPUT", message: error.message }); return;
      }
      if (error instanceof AnalysisFailed) {
        res.status(502).json({ code: "AI_ANALYSIS_FAILED", message: error.message }); return;
      }
      if (!(error instanceof AnalysisUnavailable)) throw error;
      res.status(501).json({ code: "AI_NOT_CONFIGURED", message: error.message });
    }
  });
  app.post("/api/payments/:id/evidence", (req, res) => {
    const result = repository.connectEvidence(req.params.id, req.body, req.get("Idempotency-Key"));
    res.set("Idempotency-Replayed", String(result.replayed)).status(201).json(result.body);
  });
  app.post("/api/demo/reset", (_req, res) => { repository.reset(); res.json({ ok: true }); });
  app.use("/api", (_req, res) => res.status(404).json({ code: "NOT_FOUND", message: "API 주소를 확인해 주세요." }));
  app.use(express.static(fileURLToPath(new URL("../../dist/web", import.meta.url))));
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof PaymentError) {
      res.status(error.status).json({ code: error.code, message: error.message }); return;
    }
    const status = error.type === "entity.parse.failed" ? 400 : error.type === "entity.too.large" ? 413 : 500;
    res.status(status).json({ code: status === 500 ? "INTERNAL_ERROR" : "INVALID_INPUT", message: status === 500 ? "처리 중 오류가 발생했어요." : "요청 형식 또는 크기를 확인해 주세요." });
  };
  app.use(errorHandler);
  return app;
}
