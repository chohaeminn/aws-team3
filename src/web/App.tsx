import { useEffect, useRef, useState, type DragEvent } from "react";
import type { AnalysisResult, EvidenceFields, PaymentView } from "../shared/types";
import { request } from "./api";

const emptyFields: EvidenceFields = { orderNumber: "", amount: 0, currency: "KRW", cancelledOn: "" };
function Icon({ name, size = 20 }: { name: "grid" | "file" | "shield" | "upload" | "spark" | "copy"; size?: number }) {
  const paths = { grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z", file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5", shield: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z M8 12l3 3 5-6", upload: "M12 16V3 M7 8l5-5 5 5 M4 16v4h16v-4", spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z", copy: "M9 9h12v12H9z M15 5V3H3v12h2" };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
type Capture = { id: string; file: File; url: string };
const MAX_CAPTURES = 4;
const MAX_CAPTURE_BYTES = 3 * 1024 * 1024;
const MAX_TEXT_BYTES = 100 * 1024;
const CAPTURE_TYPES = ["image/png", "image/jpeg"];
async function analyzeWithFormData(text: string, images: File[]): Promise<AnalysisResult> {
  const formData = new FormData();
  formData.append("text", text);
  for (const file of images) formData.append("images", file);
  // Content-Type은 지정하지 않아 브라우저가 multipart boundary를 자동 설정한다.
  const response = await fetch("/api/evidence/analyze", { method: "POST", body: formData });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.message ?? "요청에 실패했어요.";
    // 텍스트·캡처를 보냈는데 "텍스트를 입력해 주세요" 400이 오면 서버가 FormData를 아직 파싱하지 못하는 경우로 본다.
    if (response.status === 400 && detail === "취소 메일 텍스트를 입력해 주세요.") throw new Error("서버가 아직 이미지/FormData 요청을 처리할 준비가 되지 않았습니다.");
    throw new Error(detail);
  }
  return data as AnalysisResult;
}
// 서버 응답을 입력란 값으로 바꾼다. 숫자 문자열("50,000")은 정수로, 날짜는 YYYY-MM-DD만 받고, 없는 값은 빈 값으로 둔다.
function toFormFields(raw: unknown): EvidenceFields {
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const amount = typeof src.amount === "number" ? src.amount : typeof src.amount === "string" ? Number(src.amount.replace(/[,\s]/g, "")) : NaN;
  const date = typeof src.cancelledOn === "string" ? src.cancelledOn.trim().slice(0, 10) : "";
  return {
    orderNumber: typeof src.orderNumber === "string" ? src.orderNumber : "",
    amount: Number.isSafeInteger(amount) && amount > 0 ? amount : 0,
    currency: "KRW",
    cancelledOn: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
  };
}
function formatSize(bytes: number) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`; }
export function App() {
  const [payments, setPayments] = useState<PaymentView[]>([]);
  const [activeTab, setActiveTab] = useState<"status" | "evidence" | "inquiry">("status");
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState("PAY-001");
  const [fields, setFields] = useState<EvidenceFields>(emptyFields);
  const [text, setText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [captureError, setCaptureError] = useState("");
  const [candidateIds, setCandidateIds] = useState<string[]>([]);
  const [analysisError, setAnalysisError] = useState("");
  const [inputError, setInputError] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [aiConnected, setAiConnected] = useState(false);
  const capturesRef = useRef<Capture[]>([]);
  const trackRef = useRef<HTMLUListElement>(null);
  const [zoomId, setZoomId] = useState("");
  const zoomed = captures.find(c => c.id === zoomId);
  const selected = payments.find(p => p.id === selectedId);
  const candidates = candidateIds.map(id => payments.find(p => p.id === id)).filter((p): p is PaymentView => Boolean(p));
  const textTooLong = new TextEncoder().encode(text).length > MAX_TEXT_BYTES;
  const canAnalyze = Boolean(text.trim()) || captures.length > 0;
  useEffect(() => { capturesRef.current = captures; }, [captures]);
  useEffect(() => {
    if (!zoomId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setZoomId(""); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomId]);
  function slide(dir: 1 | -1) { const el = trackRef.current; if (el) el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.8), behavior: "smooth" }); }
  useEffect(() => () => capturesRef.current.forEach(c => URL.revokeObjectURL(c.url)), []);
  useEffect(() => { request<{ aiConnected?: boolean }>("/api/health").then(h => setAiConnected(h.aiConnected === true)).catch(() => setAiConnected(false)); }, []);
  useEffect(() => { request<PaymentView[]>("/api/payments").then(setPayments).catch(e => setMessage(e.message)).finally(() => setLoaded(true)); }, []);
  function edit(patch: Partial<EvidenceFields>) { setFields(old => ({ ...old, ...patch })); setConfirmed(false); setNotice(""); }
  function select(id: string) { setSelectedId(id); setActiveTab("status"); setFields(emptyFields); setConfirmed(false); setNotice(""); setMessage(""); setCandidateIds([]); setAnalysisError(""); }
  function chooseCandidate(id: string) { setSelectedId(id); setConfirmed(false); setMessage(""); setNotice("선택한 결제 후보로 바꿨어요. 증빙 값과 비교해 확인해 주세요."); }
  function addCaptures(list: FileList | File[] | null) {
    if (!list) return;
    const added: Capture[] = []; const errors: string[] = [];
    for (const file of Array.from(list)) {
      if (!CAPTURE_TYPES.includes(file.type)) errors.push(`${file.name}: PNG·JPG 이미지만 올릴 수 있어요.`);
      else if (file.size > MAX_CAPTURE_BYTES) errors.push(`${file.name}: 3MiB 이하 파일만 올릴 수 있어요.`);
      else if (captures.length + added.length >= MAX_CAPTURES) errors.push(`${file.name}: 캡처는 최대 ${MAX_CAPTURES}장까지 올릴 수 있어요.`);
      else added.push({ id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`, file, url: URL.createObjectURL(file) });
    }
    setCaptureError(errors.join(" "));
    if (added.length) { setCaptures(old => [...old, ...added]); setConfirmed(false); }
  }
  const dropDisabled = busy || captures.length >= MAX_CAPTURES;
  const hasFiles = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer.types).includes("Files");
  const dropHandlers = {
    onDragEnter: (e: DragEvent<HTMLLabelElement>) => { if (!hasFiles(e)) return; e.preventDefault(); if (!dropDisabled) setIsDragging(true); },
    onDragOver: (e: DragEvent<HTMLLabelElement>) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = dropDisabled ? "none" : "copy"; if (!dropDisabled) setIsDragging(true); },
    onDragLeave: (e: DragEvent<HTMLLabelElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIsDragging(false); },
    onDrop: (e: DragEvent<HTMLLabelElement>) => { if (!hasFiles(e)) return; e.preventDefault(); setIsDragging(false); if (!dropDisabled) addCaptures(Array.from(e.dataTransfer.files)); },
  };
  function removeCapture(id: string) {
    const target = captures.find(c => c.id === id);
    if (target) URL.revokeObjectURL(target.url);
    setCaptures(old => old.filter(c => c.id !== id)); setCaptureError(""); setConfirmed(false);
  }
  async function analyze() {
    if (textTooLong) { setAnalysisError(""); return; }
    if (!text.trim() && captures.length === 0) { setAnalysisError(""); setInputError(true); return; }
    setInputError(false);
    setBusy(true); setConfirmed(false); setMessage(""); setNotice(""); setAnalysisError(""); setCandidateIds([]);
    try {
      const result = await analyzeWithFormData(text, captures.map(c => c.file));
      setFields(toFormFields(result.fields)); setConfirmed(false);
      setCandidateIds(result.candidatePaymentIds);
      const many = result.candidatePaymentIds.length > 1;
      setNotice(many ? "결제 후보가 여러 건이에요. 비교해서 맞는 결제를 선택해 주세요." : "추출 결과를 수정·확인하고, 선택한 결제와 대조해 주세요.");
    } catch (e) {

      setAnalysisError(e instanceof Error ? e.message : "알 수 없는 오류");
    } finally { setBusy(false); }
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await action(); } catch (e) { setMessage(e instanceof Error ? e.message : "오류가 발생했어요."); }
    finally { setBusy(false); }
  }
  return <div className="app-shell">
    <a className="skip-link" href="#workspace">본문으로 건너뛰기</a>
    <div className="app-bar"><a className="brand" href="#workspace"><span className="brand-mark">r</span>reflo<span className="brand-caption">결제 취소·환불 추적</span></a><span className="demo-badge">합성 데이터 · 시연 버전</span></div>
    <main id="workspace">
    <header className="page-header"><h1>내 결제의 취소 진행 상황</h1><p>결제를 선택하면 현재 상태와 다음에 할 일을 확인할 수 있어요.</p></header>
    <div className="demo-banner"><Icon name="shield" size={18} /><span>실제 결제·카드사에 연결되지 않은 시연입니다. {aiConnected ? "AI 키 설정됨 · 분석 요청 후 결과를 확인해 주세요. 결과는 고객이 확인한 뒤에만 결제에 연결돼요." : "AI 분석은 준비 중이며, 직접 입력하거나 합성 예시를 사용할 수 있어요."}</span></div>
    <div className="workspace-layout"><aside className="payment-panel"><div className="list-heading"><h2>결제 내역</h2><span>{payments.length}건</span></div>
    {!loaded && <div className="empty-state" role="status">결제 내역을 불러오고 있어요…</div>}
    {loaded && payments.length === 0 && <div className="empty-state">{message ? "결제 내역을 불러오지 못했어요. 잠시 후 페이지를 새로고침해 주세요." : "등록된 결제 내역이 없어요."}</div>}
    <nav className="payment-list" aria-label="결제 선택">{payments.map(p => <button key={p.id} disabled={busy} aria-pressed={p.id === selectedId} onClick={() => select(p.id)}><strong>{p.merchant}</strong><span className="payment-amount">{p.amount.toLocaleString("ko-KR")} <small>{p.currency}</small></span><small>{p.paidOn} · {p.orderNumber}</small><span className={`badge ${p.status.card === "confirmed" ? "verified" : "pending"}`}>{p.status.card === "confirmed" ? "카드 반영 확인" : "카드 반영 미확인"}</span></button>)}</nav></aside>
    <div className="payment-content">
    {selected && <><div className="selected-heading"><div><span className="eyebrow">선택한 결제</span><h2>{selected.merchant}</h2><p>{selected.orderNumber} · 결제일 {selected.paidOn}</p></div><strong>{selected.amount.toLocaleString("ko-KR")} <small>{selected.currency}</small></strong></div>
    <div className="view-tabs" role="tablist" aria-label="결제 상세 보기">{([{ id: "status", label: "진행 상태" }, { id: "evidence", label: "증빙 등록" }, { id: "inquiry", label: "문의자료" }] as const).map(tab => <button key={tab.id} id={`tab-${tab.id}`} role="tab" aria-selected={activeTab === tab.id} aria-controls={`panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} onKeyDown={e => {
      const tabs = ["status", "evidence", "inquiry"] as const;
      const index = tabs.indexOf(tab.id);
      const next = e.key === "ArrowRight" ? (index + 1) % tabs.length : e.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
      if (next < 0) return;
      e.preventDefault(); setActiveTab(tabs[next]);
      document.getElementById(`tab-${tabs[next]}`)?.focus();
    }} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}</div></>}
    {message && <p className="error" role="alert">{message}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {selected && <div className="detail-views"><section id="panel-evidence" role="tabpanel" aria-labelledby="tab-evidence" hidden={activeTab !== "evidence"}><div className="section-heading"><span className="section-icon"><Icon name="file" /></span><div><h2>취소 증빙 확인</h2><p>메일이나 캡처에서 취소 정보를 확인하세요.</p></div></div><label>취소 메일 텍스트<textarea value={text} disabled={busy} onChange={e => { setText(e.target.value); setConfirmed(false); }} placeholder="취소 안내 메일을 여기에 붙여넣으세요." /></label>
      <div className="upload"><span className="upload-title">영수증·취소 메일 캡처 ({captures.length}/{MAX_CAPTURES})</span>
        <input id="capture-input" className="visually-hidden" type="file" accept={CAPTURE_TYPES.join(",")} multiple disabled={busy || captures.length >= MAX_CAPTURES} onChange={e => { addCaptures(e.target.files); e.target.value = ""; }} />
        <label htmlFor="capture-input" className={`upload-drop${isDragging ? " dragging" : ""}`} aria-disabled={dropDisabled} {...dropHandlers}><span className="upload-icon"><Icon name="upload" size={23} /></span><strong>{isDragging ? "여기에 이미지를 놓으세요" : "클릭해서 업로드하거나 끌어다 놓으세요"}</strong><small>PNG, JPG · 장당 최대 3MiB · 최대 4장</small></label>
        {captureError && <p className="error" role="alert">{captureError}</p>}
        {captures.length > 0 && <div className="carousel">
          <button type="button" className="slide-btn" onClick={() => slide(-1)} aria-label="이전 캡처 보기">‹</button>
          <ul className="thumbs" ref={trackRef} tabIndex={0} aria-label="업로드한 캡처 목록">{captures.map(c => <li key={c.id}>
            <button type="button" className="thumb-img" onClick={() => setZoomId(c.id)} aria-label={`${c.file.name} 크게 보기`}><img src={c.url} alt={`${c.file.name} 미리보기`} /></button>
            <span>{c.file.name}</span><small>{formatSize(c.file.size)}</small>
            <div className="thumb-actions"><button type="button" onClick={() => setZoomId(c.id)} aria-label={`${c.file.name} 확대`}>🔍 확대</button><button type="button" disabled={busy} onClick={() => removeCapture(c.id)} aria-label={`${c.file.name} 삭제`}>✕ 삭제</button></div>
          </li>)}</ul>
          <button type="button" className="slide-btn" onClick={() => slide(1)} aria-label="다음 캡처 보기">›</button></div>}
        <small>AI 분석 요청 시 텍스트와 캡처가 함께 서버로 전송돼요.</small></div>
      <div className="actions"><button className="analyze-button" disabled={busy} onClick={() => void analyze()}><Icon name="spark" size={17} />{busy ? "분석 중…" : "AI로 증빙 분석"}</button><button disabled={busy} onClick={() => {
        setFields({ orderNumber: selected.orderNumber, amount: selected.amount, currency: selected.currency, cancelledOn: "2026-11-19" });
        setConfirmed(false); setMessage(""); setAnalysisError(""); setInputError(false); setCandidateIds([]); setNotice("합성 예시를 불러왔습니다. AI 분석 결과가 아닙니다.");
      }}>합성 예시 불러오기</button></div>
      {textTooLong && <p className="error" role="alert">취소 메일 텍스트가 100 KiB를 넘어요. 내용을 줄여서 다시 입력해 주세요.</p>}
      {inputError && !canAnalyze && <p className="error" role="alert">취소 메일 텍스트 또는 캡처 이미지를 입력해 주세요.</p>}
      {analysisError && <div className="error analysis-error" role="alert"><strong>증빙을 분석하지 못했어요.</strong><p>잠시 후 다시 시도하거나, 아래 입력란에 직접 입력해 주세요. 입력한 내용과 캡처는 그대로 유지돼요.</p><p className="error-detail">{analysisError.startsWith("서버가 아직") ? analysisError : `상세: ${analysisError}`}</p><div className="actions"><button type="button" disabled={busy} onClick={() => void analyze()}>분석 재시도</button></div></div>}
      {candidates.length > 0 && <div className="candidates"><h3>결제 후보 {candidates.length}건</h3>
        {candidates.length > 1 && !candidates.some(c => c.id === selectedId) && <p className="hint">현재 선택한 결제는 후보에 없어요. 아래에서 맞는 결제를 골라 주세요.</p>}
        <ul className="candidate-list">{candidates.map(c => { const orderOk = c.orderNumber === fields.orderNumber; const amountOk = c.amount === fields.amount; const dateOk = Boolean(fields.cancelledOn) && fields.cancelledOn >= c.paidOn;
          return <li key={c.id}><button type="button" className="candidate" disabled={busy} aria-pressed={c.id === selectedId} onClick={() => chooseCandidate(c.id)}>
            <strong>{c.merchant}</strong>
            <span>주문번호 {c.orderNumber} <em className={orderOk ? "ok" : "diff"}>{orderOk ? "일치" : "다름"}</em></span>
            <span>금액 {c.amount.toLocaleString()} {c.currency} <em className={amountOk ? "ok" : "diff"}>{amountOk ? "일치" : "다름"}</em></span>
            <span>결제일 {c.paidOn} <em className={dateOk ? "ok" : "diff"}>{dateOk ? "취소일이 이후" : "취소일 확인"}</em></span>
            <small>{c.id === selectedId ? "선택됨" : "클릭해서 선택"}</small></button></li>; })}</ul></div>}
      <p className="hint">직접 입력하거나 예시를 불러와 수정할 수 있어요. 캡처 이미지는 AI 분석 요청 시 함께 전송됩니다.</p>
      <div className="form-divider"><h3>추출 정보 확인</h3><span>직접 수정할 수 있어요</span></div>
      <form onSubmit={e => { e.preventDefault(); void run(async () => {
        const updated = await request<PaymentView>(`/api/payments/${selectedId}/evidence`, { ...fields, confirmed });
        setPayments(old => old.map(p => p.id === updated.id ? updated : p)); setActiveTab("status"); setConfirmed(false); setNotice("확인한 증빙을 결제에 연결했어요.");
      }); }}>
        <fieldset disabled={busy}>
        <label>주문번호<input required value={fields.orderNumber} onChange={e => edit({ orderNumber: e.target.value })} /></label>
        <div className="row"><label>전액 취소 금액<input required type="number" min="1" step="1" value={fields.amount || ""} onChange={e => edit({ amount: Number(e.target.value) })} /></label><label>통화<input value="KRW" readOnly /></label></div>
        <label>취소일<input required type="date" min={selected.paidOn} value={fields.cancelledOn} onChange={e => edit({ cancelledOn: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />증빙 내용과 선택한 결제가 일치함을 확인했습니다.</label>
        <button className="primary" disabled={busy || !confirmed}>확인하고 결제에 연결</button>
        </fieldset>
      </form>
    </section><div className="detail-stack" id="panel-status" role="tabpanel" aria-labelledby="tab-status" hidden={activeTab !== "status"}><section className="status-section"><div className="section-heading"><span className="section-icon"><Icon name="shield" /></span><div><h2>현재 확인된 상태</h2><p>{selected.merchant} · {selected.orderNumber}</p></div></div><div className="status-pair"><div><span>가맹점 취소</span><strong className={selected.status.merchant === "confirmed" ? "state-verified" : "state-pending"}>{selected.status.merchant === "confirmed" ? "확인됨" : "미확인"}</strong><small>고객이 확인한 취소 증빙 기준</small></div><div><span>카드 반영</span><strong className={selected.status.card === "confirmed" ? "state-verified" : "state-pending"}>{selected.status.card === "confirmed" ? "확인됨" : "미확인"}</strong><small>확보된 카드 취소 기록 기준</small></div></div><div className="next-action"><span>다음으로 할 일</span><p>{selected.nextAction}</p></div><div className="status-actions"><button className="primary" onClick={() => setActiveTab("evidence")}>취소 증빙 등록하기</button><button onClick={() => setActiveTab("inquiry")}>문의자료 보기</button></div><p className="status-footnote">미확인은 처리 실패를 뜻하지 않아요. 확보된 기록을 기준으로 안내합니다.</p></section>
    <section><div className="subheading"><h2>결제·취소 타임라인</h2><span className="badge neutral">{selected.events.length}개 기록</span></div><ol className="timeline">{[...selected.events].sort((a,b) => a.date.localeCompare(b.date)).map(event => <li key={event.id} className={event.kind === "card_cancel" ? "card-event" : ""}><time>{event.date}</time><strong>{event.label}</strong><small>{event.source}</small></li>)}</ol></section>
    </div><section id="panel-inquiry" role="tabpanel" aria-labelledby="tab-inquiry" hidden={activeTab !== "inquiry"} className="inquiry-section"><div className="section-heading"><span className="section-icon"><Icon name="copy" /></span><div><h2>문의자료</h2><p>확인된 기록을 정리했어요. 복사해서 전달하세요.</p></div></div><pre>{selected.inquirySummary}</pre><button className="copy-button" disabled={busy} onClick={() => run(async () => { await navigator.clipboard.writeText(selected.inquirySummary); setNotice("문의자료를 복사했어요."); })}><Icon name="copy" size={17} />문의자료 복사</button></section></div>}
    </div></div>
    {zoomed && <div className="lightbox" role="dialog" aria-modal="true" aria-label="캡처 크게 보기" onClick={() => setZoomId("")}>
      <button type="button" className="lightbox-close" autoFocus onClick={() => setZoomId("")} aria-label="닫기">✕</button>
      <img src={zoomed.url} alt={`${zoomed.file.name} 원본 보기`} onClick={e => e.stopPropagation()} />
    </div>}
    <footer><span>메모리 저장 · 서버 재시작 시 초기화됩니다.</span><button disabled={busy} onClick={() => {
      if (!window.confirm("모든 시연 데이터를 초기 상태로 되돌릴까요?")) return;
      void run(async () => { await request("/api/demo/reset", {}); setPayments(await request<PaymentView[]>("/api/payments")); select("PAY-001"); setNotice("시연 데이터를 초기화했어요."); });
    }}>시연 초기화</button></footer>
  </main></div>;
}
