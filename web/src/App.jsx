import { useEffect, useRef, useState } from 'react';

const STATUS_KO = { working: '작업 중', waiting: '허가 대기', input: '입력 대기', idle: '완료', ended: '종료됨' };

const projName = (s) => (s.cwd ? s.cwd.split('/').filter(Boolean).pop() : s.id.slice(0, 8));

function question(p) {
  if (p.toolName === 'Bash') return '이 명령을 실행할까요?';
  if (['Edit', 'Write', 'NotebookEdit'].includes(p.toolName)) return '파일을 수정할까요?';
  if (p.toolName === 'Read') return '파일을 읽을까요?';
  if (p.toolName === 'WebFetch') return '이 주소를 가져올까요?';
  return `${p.toolName} 사용을 허용할까요?`;
}

function detail(p) {
  const i = p.toolInput || {};
  return i.command ?? i.file_path ?? i.url ?? p.permissionType
    ?? (Object.keys(i).length ? JSON.stringify(i, null, 1) : '');
}

// 실패(403/500/네트워크)를 삼키지 않고 상단에 잠깐 띄운다 — 안 그러면 "버튼이 안 먹는다"로만 보인다
let showError = () => {};
const respond = async (id, decision) => {
  try {
    const res = await fetch('/api/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, decision }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      showError(`응답 실패 ${res.status}: ${body.error ?? ''}`);
    } else if (body.ok && decision === 'always' && body.decision === 'once') {
      // 규칙을 못 만들거나 기록에 실패해 1회 승인으로 강등됨 — 다음에 또 묻는 이유를 알려준다
      showError('규칙을 만들 수 없는 명령이라 이번 1회만 승인했습니다 (다음에 다시 묻습니다)');
    }
  } catch (e) {
    showError(`응답 실패: ${e.message}`);
  }
};

/** WebSocket 자동 재접속 + 상태 구독 */
function useDaemonState() {
  const [state, setState] = useState({ sessions: [] });
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws = null;
    let timer = null;
    let retryMs = 1000;
    let disposed = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => { retryMs = 1000; setConnected(true); };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'state') setState(msg);
      };
      ws.onclose = () => {
        setConnected(false);
        if (disposed) return;
        timer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 15000);
      };
    };
    connect();

    return () => { disposed = true; clearTimeout(timer); ws?.close(); };
  }, []);

  return { state, connected };
}

/** Wake Lock — 화면 꺼짐 방지 */
function useWakeLock() {
  useEffect(() => {
    let wakeLock = null;
    const acquire = async () => {
      try {
        wakeLock = await navigator.wakeLock?.request('screen');
        wakeLock?.addEventListener('release', () => { wakeLock = null; });
      } catch {}
    };
    const onVisible = () => { if (document.visibilityState === 'visible') acquire(); };
    const onClick = () => { if (!wakeLock) acquire(); };
    acquire();
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('click', onClick, { passive: true });
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('click', onClick);
      wakeLock?.release().catch(() => {});
    };
  }, []);
}

function AskCard({ p }) {
  return (
    <div className="ask">
      <div className="proj">{projName(p.session)}</div>
      <div className="q">{question(p)}</div>
      <pre>{detail(p)}</pre>
      <button className="b-yes" onClick={() => respond(p.id, 'once')}>예</button>
      <button className="b-always" onClick={() => respond(p.id, 'always')}>예, 다시 묻지 않기</button>
      <button className="b-no" onClick={() => respond(p.id, 'deny')}>아니오</button>
      <button className="b-skip" onClick={() => respond(p.id, 'passthrough')}>터미널에서 응답할게요</button>
    </div>
  );
}

function SessionRow({ s }) {
  return (
    <div className="session">
      <div className={`dot ${s.status}`} />
      <div className="info">
        <div className="name">{projName(s)}</div>
        {s.lastMessage ? <div className="last">{s.lastMessage}</div> : null}
        {(s.model || s.thinking !== null || s.hasTmux) ? (
          <div className="meta">
            {s.model ? <span>{s.model}</span> : null}
            {s.thinking !== null ? <span>생각 {s.thinking ? 'ON' : 'OFF'}(추정)</span> : null}
            {s.hasTmux ? <span>tmux</span> : null}
          </div>
        ) : null}
      </div>
      <div className="st">{STATUS_KO[s.status] ?? s.status}</div>
    </div>
  );
}

export default function App() {
  const { state, connected } = useDaemonState();
  useWakeLock();

  const [error, setError] = useState(null);
  useEffect(() => {
    showError = (msg) => { setError(msg); setTimeout(() => setError(null), 5000); };
    return () => { showError = () => {}; };
  }, []);

  const sessions = state.sessions ?? [];
  const pending = sessions.flatMap((s) => s.pending.map((p) => ({ ...p, session: s })));

  // 허가 대기: 배경 점멸 + 요청이 늘어날 때마다 진동(지원 기기)
  const prevCountRef = useRef(0);
  useEffect(() => {
    document.body.classList.toggle('alert', pending.length > 0);
    if (pending.length > prevCountRef.current) navigator.vibrate?.([120, 60, 120]);
    prevCountRef.current = pending.length;
  }, [pending.length]);

  return (
    <>
      <div id="topcover" />
      <header>
        <h1>Claude Controller</h1>
        <div id="conn" className={connected ? 'on' : ''} />
      </header>
      <main>
        {error ? <div className="error">{error}</div> : null}
        {!sessions.length ? (
          <div className="empty">활성 세션이 없습니다.<br />맥에서 claude를 실행하세요 (다이얼 기능만 tmux 필요 — <code>cl</code>).</div>
        ) : (
          <>
            {pending.map((p) => <AskCard key={p.id} p={p} />)}
            {sessions.map((s) => <SessionRow key={s.id} s={s} />)}
          </>
        )}
      </main>
    </>
  );
}
