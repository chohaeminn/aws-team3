import { useEffect, useRef, useState, type DragEvent } from "react";
import type { AnalysisResult, EvidenceFields, PaymentView } from "../shared/types";
import { request } from "./api";

const emptyFields: EvidenceFields = { orderNumber: "", amount: 0, currency: "KRW", cancelledOn: "" };
type MockMode = "off" | "success" | "multi" | "fail";
type Capture = { id: string; file: File; url: string };
const MAX_CAPTURES = 4;
const MAX_CAPTURE_BYTES = 3 * 1024 * 1024;
const CAPTURE_TYPES = ["image/png", "image/jpeg"];
const mockLabels: Record<MockMode, string> = { off: "사용 안 함 (실제 API)", success: "성공 (후보 1건)", multi: "후보 다수", fail: "실패 시뮬레이션" };
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
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function formatSize(bytes: number) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`; }
export function App() {
  const [payments, setPayments] = useState<PaymentView[]>([]);
  const [selectedId, setSelectedId] = useState("PAY-001");
  const [fields, setFields] = useState<EvidenceFields>(emptyFields);
  const [text, setText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [captureError, setCaptureError] = useState("");
  const [mockMode, setMockMode] = useState<MockMode>("off");
  const [candidateIds, setCandidateIds] = useState<string[]>([]);
  const [analysisSource, setAnalysisSource] = useState<"api" | "mock" | "">("");
  const [analysisError, setAnalysisError] = useState("");
  const [inputError, setInputError] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const capturesRef = useRef<Capture[]>([]);
  const trackRef = useRef<HTMLUListElement>(null);
  const [zoomId, setZoomId] = useState("");
  const zoomed = captures.find(c => c.id === zoomId);
  const selected = payments.find(p => p.id === selectedId);
  const candidates = candidateIds.map(id => payments.find(p => p.id === id)).filter((p): p is PaymentView => Boolean(p));
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
  useEffect(() => { request<PaymentView[]>("/api/payments").then(setPayments).catch(e => setMessage(e.message)); }, []);
  function edit(patch: Partial<EvidenceFields>) { setFields(old => ({ ...old, ...patch })); setConfirmed(false); setNotice(""); }
  function select(id: string) { setSelectedId(id); setFields(emptyFields); setConfirmed(false); setNotice(""); setMessage(""); setCandidateIds([]); setAnalysisSource(""); setAnalysisError(""); }
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
    if (added.length) setCaptures(old => [...old, ...added]);
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
    setCaptures(old => old.filter(c => c.id !== id)); setCaptureError("");
  }
  async function analyze() {
    if (!text.trim() && captures.length === 0) { setAnalysisError(""); setAnalysisSource(""); setInputError(true); return; }
    setInputError(false);
    setBusy(true); setConfirmed(false); setMessage(""); setNotice(""); setAnalysisError(""); setCandidateIds([]); setAnalysisSource("");
    try {
      let result: AnalysisResult; let source: "api" | "mock";
      if (mockMode === "off") { result = await analyzeWithFormData(text, captures.map(c => c.file)); source = "api"; }
      else {
        await wait(700); source = "mock";
        if (mockMode === "fail") throw new Error("Mock 시뮬레이션: AI 분석 서버가 응답하지 않습니다.");
        const base = payments.find(p => p.id === selectedId) ?? payments[0];
        if (!base) throw new Error("Mock 응답을 만들 결제 데이터가 없어요.");
        result = {
          fields: { orderNumber: base.orderNumber, amount: base.amount, currency: base.currency, cancelledOn: "2026-11-19" },
          candidatePaymentIds: mockMode === "multi" ? payments.map(p => p.id) : [base.id], provider: "bedrock",
        };
      }
      setFields({ ...emptyFields, ...result.fields }); setConfirmed(false);
      setCandidateIds(result.candidatePaymentIds); setAnalysisSource(source);
      const many = result.candidatePaymentIds.length > 1;
      setNotice(`${source === "mock" ? "Mock 응답(AI 결과 아님): " : ""}${many ? "결제 후보가 여러 건이에요. 비교해서 맞는 결제를 선택해 주세요." : "추출 결과를 수정·확인하고, 선택한 결제와 대조해 주세요."}`);
    } catch (e) {
      setAnalysisSource(mockMode === "off" ? "api" : "mock");
      setAnalysisError(e instanceof Error ? e.message : "알 수 없는 오류");
    } finally { setBusy(false); }
  }
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
      <div className="mock-panel"><label>시연용 Mock 응답 (임시)<select value={mockMode} disabled={busy} onChange={e => { setMockMode(e.target.value as MockMode); setAnalysisError(""); }}>{(Object.keys(mockLabels) as MockMode[]).map(m => <option key={m} value={m}>{mockLabels[m]}</option>)}</select></label>{mockMode !== "off" && <small>백엔드를 호출하지 않고 가짜 응답을 사용합니다. 실제 AI 결과가 아닙니다.</small>}</div>
      <div className="upload"><span className="upload-title">영수증·취소 메일 캡처 ({captures.length}/{MAX_CAPTURES})</span>
        <input id="capture-input" className="visually-hidden" type="file" accept={CAPTURE_TYPES.join(",")} multiple disabled={busy || captures.length >= MAX_CAPTURES} onChange={e => { addCaptures(e.target.files); e.target.value = ""; }} />
        <label htmlFor="capture-input" className={`upload-drop${isDragging ? " dragging" : ""}`} aria-disabled={dropDisabled} {...dropHandlers}>{isDragging ? "여기에 놓으면 업로드돼요" : "클릭하거나 이미지를 여기로 끌어다 놓으세요 (PNG·JPG, 장당 3MiB 이하)"}</label>
        {captureError && <p className="error" role="alert">{captureError}</p>}
        {captures.length > 0 && <div className="carousel">
          <button type="button" className="slide-btn" onClick={() => slide(-1)} aria-label="이전 캡처 보기">‹</button>
          <ul className="thumbs" ref={trackRef} tabIndex={0} aria-label="업로드한 캡처 목록">{captures.map(c => <li key={c.id}>
            <button type="button" className="thumb-img" onClick={() => setZoomId(c.id)} aria-label={`${c.file.name} 크게 보기`}><img src={c.url} alt={`${c.file.name} 미리보기`} /></button>
            <span>{c.file.name}</span><small>{formatSize(c.file.size)}</small>
            <div className="thumb-actions"><button type="button" onClick={() => setZoomId(c.id)} aria-label={`${c.file.name} 확대`}>🔍 확대</button><button type="button" disabled={busy} onClick={() => removeCapture(c.id)} aria-label={`${c.file.name} 삭제`}>✕ 삭제</button></div>
          </li>)}</ul>
          <button type="button" className="slide-btn" onClick={() => slide(1)} aria-label="다음 캡처 보기">›</button></div>}
        <small>{mockMode === "off" ? "AI 분석 요청 시 텍스트와 캡처가 함께 서버로 전송돼요." : "Mock 모드에서는 캡처만으로도 분석을 시연할 수 있어요."}</small></div>
      <div className="actions"><button disabled={busy} onClick={() => void analyze()}>{busy ? "분석 중…" : "AI 분석 요청"}</button><button disabled={busy} onClick={() => {
        setFields({ orderNumber: selected.orderNumber, amount: selected.amount, currency: selected.currency, cancelledOn: "2026-11-19" });
        setConfirmed(false); setMessage(""); setNotice("합성 예시를 불러왔습니다. AI 분석 결과가 아닙니다.");
      }}>합성 예시 불러오기</button></div>
      {inputError && !canAnalyze && <p className="error" role="alert">취소 메일 텍스트 또는 캡처 이미지를 입력해 주세요.</p>}
      {analysisError && <div className="error analysis-error" role="alert"><strong>증빙을 분석하지 못했어요{analysisSource === "mock" ? " (Mock)" : ""}.</strong><p>잠시 후 다시 시도하거나, 아래 입력란에 직접 입력해 주세요. 입력한 내용과 캡처는 그대로 유지돼요.</p><p className="error-detail">{analysisError.startsWith("서버가 아직") ? analysisError : `상세: ${analysisError}`}</p><div className="actions"><button type="button" disabled={busy} onClick={() => void analyze()}>분석 재시도</button></div></div>}
      {candidates.length > 0 && <div className="candidates"><h3>결제 후보 {candidates.length}건{analysisSource === "mock" ? " · Mock" : ""}</h3>
        {candidates.length > 1 && !candidates.some(c => c.id === selectedId) && <p className="hint">현재 선택한 결제는 후보에 없어요. 아래에서 맞는 결제를 골라 주세요.</p>}
        <ul className="candidate-list">{candidates.map(c => { const orderOk = c.orderNumber === fields.orderNumber; const amountOk = c.amount === fields.amount; const dateOk = Boolean(fields.cancelledOn) && fields.cancelledOn >= c.paidOn;
          return <li key={c.id}><button type="button" className="candidate" disabled={busy} aria-pressed={c.id === selectedId} onClick={() => chooseCandidate(c.id)}>
            <strong>{c.merchant}</strong>
            <span>주문번호 {c.orderNumber} <em className={orderOk ? "ok" : "diff"}>{orderOk ? "일치" : "다름"}</em></span>
            <span>금액 {c.amount.toLocaleString()} {c.currency} <em className={amountOk ? "ok" : "diff"}>{amountOk ? "일치" : "다름"}</em></span>
            <span>결제일 {c.paidOn} <em className={dateOk ? "ok" : "diff"}>{dateOk ? "취소일이 이후" : "취소일 확인"}</em></span>
            <small>{c.id === selectedId ? "선택됨" : "클릭해서 선택"}</small></button></li>; })}</ul></div>}
      <p className="hint">직접 입력하거나 예시를 불러와 수정할 수 있어요. 캡처 이미지는 AI 분석 요청 시 함께 전송됩니다.</p>
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
    {zoomed && <div className="lightbox" role="dialog" aria-modal="true" aria-label="캡처 크게 보기" onClick={() => setZoomId("")}>
      <button type="button" className="lightbox-close" autoFocus onClick={() => setZoomId("")} aria-label="닫기">✕</button>
      <img src={zoomed.url} alt={`${zoomed.file.name} 원본 보기`} onClick={e => e.stopPropagation()} />
    </div>}
    <footer><span>메모리 저장 · 서버 재시작 시 초기화됩니다.</span><button disabled={busy} onClick={() => {
      if (!window.confirm("모든 시연 데이터를 초기 상태로 되돌릴까요?")) return;
      void run(async () => { await request("/api/demo/reset", {}); setPayments(await request<PaymentView[]>("/api/payments")); select("PAY-001"); setNotice("시연 데이터를 초기화했어요."); });
    }}>시연 초기화</button></footer>
  </main>;
}
