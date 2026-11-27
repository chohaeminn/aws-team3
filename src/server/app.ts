import express from "express";
import type { ErrorRequestHandler } from "express";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createPrincipalResolver, type Principal, type PrincipalResolver } from "./auth/principal.js";
import { PaymentRepository, PaymentError } from "./payments/repository.js";
import { toPaymentView } from "./status/paymentStatus.js";
import { analyzeEvidence, AnalysisFailed, AnalysisUnavailable, isAiConfigured } from "./evidence/analyzer.js";
import type { EvidenceAnalyzer } from "./evidence/analyzer.js";
import { InvalidEvidenceInput, parseEvidenceInput, readEvidenceBody } from "./evidence/request.js";

export function createApp({ evidenceAnalyzer = analyzeEvidence, repository = new PaymentRepository(), principalResolver = createPrincipalResolver(), requestLogger }: {
  evidenceAnalyzer?: EvidenceAnalyzer; repository?: PaymentRepository; principalResolver?: PrincipalResolver;
  requestLogger?: (record: Record<string, unknown>) => void;
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  const authDomain = process.env.COGNITO_DOMAIN ?? "";
  const authOrigin = /^[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com$/.test(authDomain) ? `https://${authDomain}` : "";
  const metrics = { requests: 0, unauthorized: 0, forbidden: 0, serverErrors: 0, idempotentReplays: 0 };
  app.use((req, res, next) => {
    const started = performance.now();
    res.locals.requestId = randomUUID();
    res.set({ "X-Request-Id": res.locals.requestId, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
      "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' ${authOrigin}; frame-ancestors 'none'; base-uri 'self'; form-action 'self' ${authOrigin}` });
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    res.on("finish", () => {
      metrics.requests++;
      if (res.statusCode === 401) metrics.unauthorized++;
      if (res.statusCode === 403) metrics.forbidden++;
      if (res.statusCode >= 500) metrics.serverErrors++;
      if (res.get("Idempotency-Replayed") === "true") metrics.idempotentReplays++;
      const record = { requestId: res.locals.requestId, method: ["GET", "POST"].includes(req.method) ? req.method : "OTHER",
        route: req.route?.path ?? "unmatched", status: res.statusCode, durationMs: Number((performance.now() - started).toFixed(2)) };
      if (requestLogger) requestLogger(record);
      else if (process.env.NODE_ENV === "production") console.log(JSON.stringify(record));
    });
    next();
  });
  app.use(express.json({ limit: "100kb" }));
  app.get("/api/health", (_req, res) => res.json({ ok: true, synthetic: true, aiConnected: isAiConfigured() }));
  app.get("/api/auth/config", (_req, res) => res.json({
    domain: process.env.COGNITO_DOMAIN ?? "", clientId: process.env.COGNITO_CLIENT_ID ?? "",
  }));
  app.use("/api", async (req, res, next) => {
    const principal = await principalResolver(req.get("Authorization"));
    if (!principal) { res.status(401).json({ code: "UNAUTHENTICATED", message: "로그인이 필요하거나 로그인 시간이 만료됐어요." }); return; }
    res.locals.principal = principal;
    next();
  });
  const actor = (res: express.Response) => res.locals.principal as Principal;
  const owner = (res: express.Response) => actor(res).role === "admin" ? undefined : actor(res).id;
  app.get("/api/auth/me", (_req, res) => res.json(actor(res)));
  app.get("/api/admin/metrics", (_req, res) => {
    if (actor(res).role !== "admin") { res.status(403).json({ code: "FORBIDDEN", message: "관리자 권한이 필요해요." }); return; }
    res.json(metrics);
  });
  app.get("/api/payments", (_req, res) => res.json(repository.list(owner(res)).map(toPaymentView)));
  app.get("/api/payments/:id", (req, res) => {
    const payment = repository.get(req.params.id, owner(res));
    if (!payment) { res.status(404).json({ code: "NOT_FOUND", message: "결제 건을 찾을 수 없어요." }); return; }
    res.json(toPaymentView(payment));
  });
  app.post("/api/evidence/analyze", readEvidenceBody, async (req, res) => {
    try {
      const result = await evidenceAnalyzer(await parseEvidenceInput(req));
      // AI 후보도 조회·연결과 같은 소유권 범위를 적용한다.
      res.json({ ...result, candidatePaymentIds: result.candidatePaymentIds.filter(id => repository.get(id, owner(res))) });
    }
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
    const result = repository.connectEvidence(req.params.id, req.body, req.get("Idempotency-Key"), {
      actorId: actor(res).id, ownerId: owner(res), requestId: res.locals.requestId,
    });
    res.set("Idempotency-Replayed", String(result.replayed)).status(201).json(result.body);
  });
  app.post("/api/demo/reset", (_req, res) => {
    if (actor(res).role !== "admin") { res.status(403).json({ code: "FORBIDDEN", message: "시연 초기화는 관리자만 실행할 수 있어요." }); return; }
    repository.reset({ actorId: actor(res).id, requestId: res.locals.requestId }); res.json({ ok: true });
  });
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
