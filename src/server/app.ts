import express from "express";
import type { ErrorRequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { EvidenceFields } from "../shared/types.js";
import { createPaymentStore } from "./payments/store.js";
import { toPaymentView } from "./status/paymentStatus.js";
import { analyzeEvidence, AnalysisUnavailable } from "./evidence/analyzer.js";
import type { EvidenceAnalyzer } from "./evidence/analyzer.js";
import { InvalidEvidenceInput, parseEvidenceInput, readEvidenceBody } from "./evidence/request.js";

export function createApp({ evidenceAnalyzer = analyzeEvidence }: { evidenceAnalyzer?: EvidenceAnalyzer } = {}) {
  const app = express();
  let payments = createPaymentStore();
  app.use(express.json({ limit: "100kb" }));
  app.get("/api/health", (_req, res) => res.json({ ok: true, synthetic: true, aiConnected: false }));
  app.get("/api/payments", (_req, res) => res.json(payments.map(toPaymentView)));
  app.get("/api/payments/:id", (req, res) => {
    const payment = payments.find(item => item.id === req.params.id);
    if (!payment) { res.status(404).json({ code: "NOT_FOUND", message: "결제 건을 찾을 수 없어요." }); return; }
    res.json(toPaymentView(payment));
  });
  app.post("/api/evidence/analyze", readEvidenceBody, async (req, res) => {
    try { res.json(await evidenceAnalyzer(await parseEvidenceInput(req))); }
    catch (error) {
      if (error instanceof InvalidEvidenceInput) {
        res.status(400).json({ code: "INVALID_INPUT", message: error.message }); return;
      }
      if (!(error instanceof AnalysisUnavailable)) throw error;
      res.status(501).json({ code: "AI_NOT_CONFIGURED", message: error.message });
    }
  });
  app.post("/api/payments/:id/evidence", (req, res) => {
    const payment = payments.find(item => item.id === req.params.id);
    if (!payment) { res.status(404).json({ code: "NOT_FOUND", message: "결제 건을 찾을 수 없어요." }); return; }
    const b = req.body;
    const validDate = typeof b?.cancelledOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.cancelledOn)
      && !Number.isNaN(Date.parse(b.cancelledOn)) && new Date(b.cancelledOn).toISOString().slice(0, 10) === b.cancelledOn;
    if (b?.confirmed !== true || typeof b.orderNumber !== "string" || !b.orderNumber.trim()
        || !Number.isSafeInteger(b.amount) || b.amount <= 0 || b.currency !== "KRW" || !validDate) {
      res.status(400).json({ code: "INVALID_INPUT", message: "주문번호·금액·통화·유효한 취소일과 고객 확인이 필요해요." }); return;
    }
    if (b.orderNumber.trim() !== payment.orderNumber || b.amount !== payment.amount || b.currency !== payment.currency || b.cancelledOn < payment.paidOn) {
      res.status(409).json({ code: "PAYMENT_MISMATCH", message: "선택한 결제의 주문번호·전액 금액·통화·결제일을 확인해 주세요." }); return;
    }
    if (payment.evidence.some(e => e.cancelledOn === b.cancelledOn)) {
      res.status(409).json({ code: "DUPLICATE_EVIDENCE", message: "같은 취소일의 증빙이 이미 연결되어 있어요." }); return;
    }
    const fields: EvidenceFields = { orderNumber: b.orderNumber.trim(), amount: b.amount, currency: b.currency, cancelledOn: b.cancelledOn };
    const id = randomUUID();
    payment.evidence.push({ ...fields, id, source: "customer_confirmed", confirmedAt: new Date().toISOString() });
    payment.events.push({ id, kind: "merchant_cancel", date: fields.cancelledOn, source: "고객 확인 취소 증빙", label: "가맹점 전액 취소 확인" });
    res.status(201).json(toPaymentView(payment));
  });
  app.post("/api/demo/reset", (_req, res) => { payments = createPaymentStore(); res.json({ ok: true }); });
  app.use("/api", (_req, res) => res.status(404).json({ code: "NOT_FOUND", message: "API 주소를 확인해 주세요." }));
  app.use(express.static(fileURLToPath(new URL("../../dist/web", import.meta.url))));
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error.type === "entity.parse.failed" ? 400 : error.type === "entity.too.large" ? 413 : 500;
    res.status(status).json({ code: status === 500 ? "INTERNAL_ERROR" : "INVALID_INPUT", message: status === 500 ? "처리 중 오류가 발생했어요." : "요청 형식 또는 크기를 확인해 주세요." });
  };
  app.use(errorHandler);
  return app;
}
