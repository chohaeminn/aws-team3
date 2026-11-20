import { useEffect, useState } from "react";
import type { AnalysisResult, EvidenceFields, PaymentView } from "../shared/types";
import { request } from "./api";

const emptyFields: EvidenceFields = { orderNumber: "", amount: 0, currency: "KRW", cancelledOn: "" };
export function App() {
  const [payments, setPayments] = useState<PaymentView[]>([]);
  const [selectedId, setSelectedId] = useState("PAY-001");
  const [fields, setFields] = useState<EvidenceFields>(emptyFields);
  const [text, setText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const selected = payments.find(p => p.id === selectedId);
  useEffect(() => { request<PaymentView[]>("/api/payments").then(setPayments).catch(e => setMessage(e.message)); }, []);
  function edit(patch: Partial<EvidenceFields>) { setFields(old => ({ ...old, ...patch })); setConfirmed(false); setNotice(""); }
  function select(id: string) { setSelectedId(id); setFields(emptyFields); setConfirmed(false); setNotice(""); setMessage(""); }
  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await action(); } catch (e) { setMessage(e instanceof Error ? e.message : "오류가 발생했어요."); }
    finally { setBusy(false); }
  }
  return <main>
    <header><span className="eyebrow">AWS TEAM 3 · 합성 데이터</span><h1>취소 안내 다음이<br />궁금할 때.</h1><p>결제와 취소 기록을 연결하고, 확인된 상태로 문의를 준비하세요.</p></header>
    <aside>로컬 시연 · 모든 거래는 합성 데이터입니다. AI 미연결 · 직접 입력 및 예시 확인 흐름을 제공합니다.</aside>
    <nav aria-label="결제 선택">{payments.map(p => <button key={p.id} disabled={busy} aria-pressed={p.id === selectedId} onClick={() => select(p.id)}><strong>{p.merchant}</strong><span>{p.amount.toLocaleString()} {p.currency}</span><small>{p.orderNumber}</small></button>)}</nav>
    {message && <p className="error" role="alert">{message}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {selected && <div className="grid"><section><h2>01 / 취소 증빙 확인</h2><label>취소 메일 텍스트<textarea value={text} onChange={e => setText(e.target.value)} placeholder="합성 취소 메일 내용을 입력하세요" /></label>
      <div className="actions"><button disabled={busy || !text.trim()} onClick={() => run(async () => {
        const result = await request<AnalysisResult>("/api/evidence/analyze", { text });
        setFields({ ...emptyFields, ...result.fields }); setConfirmed(false);
        setNotice("AI 추출 결과를 수정·확인하고, 결제 후보와 선택한 결제를 대조해 주세요.");
      })}>AI 분석 요청</button><button disabled={busy} onClick={() => {
        setFields({ orderNumber: selected.orderNumber, amount: selected.amount, currency: selected.currency, cancelledOn: "2026-11-19" });
        setConfirmed(false); setMessage(""); setNotice("합성 예시를 불러왔습니다. AI 분석 결과가 아닙니다.");
      }}>합성 예시 불러오기</button></div>
      <p className="hint">직접 입력하거나 예시를 불러와 수정할 수 있어요. 현재는 텍스트 입력만 지원합니다.</p>
      <form onSubmit={e => { e.preventDefault(); void run(async () => {
        const updated = await request<PaymentView>(`/api/payments/${selectedId}/evidence`, { ...fields, confirmed });
        setPayments(old => old.map(p => p.id === updated.id ? updated : p)); setConfirmed(false); setNotice("확인한 증빙을 결제에 연결했어요.");
      }); }}>
        <label>주문번호<input required value={fields.orderNumber} onChange={e => edit({ orderNumber: e.target.value })} /></label>
        <div className="row"><label>전액 취소 금액<input required type="number" min="1" step="1" value={fields.amount || ""} onChange={e => edit({ amount: Number(e.target.value) })} /></label><label>통화<input value="KRW" readOnly /></label></div>
        <label>취소일<input required type="date" min={selected.paidOn} value={fields.cancelledOn} onChange={e => edit({ cancelledOn: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />증빙 내용과 선택한 결제가 일치함을 확인했습니다.</label>
        <button className="primary" disabled={busy || !confirmed}>확인하고 결제에 연결</button>
      </form>
    </section><section><h2>02 / 현재 확인된 상태</h2><div className="status">{selected.status.label}</div><p>{selected.nextAction}</p><h3>결제·취소 타임라인</h3><ol>{[...selected.events].sort((a,b) => a.date.localeCompare(b.date)).map(event => <li key={event.id}><time>{event.date}</time><strong>{event.label}</strong><small>{event.source}</small></li>)}</ol><h3>문의용 요약</h3><pre>{selected.inquirySummary}</pre><button disabled={busy} onClick={() => run(async () => { await navigator.clipboard.writeText(selected.inquirySummary); setNotice("문의자료를 복사했어요."); })}>문의자료 복사</button></section></div>}
    <footer><span>메모리 저장 · 서버 재시작 시 초기화됩니다.</span><button disabled={busy} onClick={() => {
      if (!window.confirm("모든 시연 데이터를 초기 상태로 되돌릴까요?")) return;
      void run(async () => { await request("/api/demo/reset", {}); setPayments(await request<PaymentView[]>("/api/payments")); select("PAY-001"); setNotice("시연 데이터를 초기화했어요."); });
    }}>시연 초기화</button></footer>
  </main>;
}
