// 세션/허가요청 상태. 데몬 프로세스 메모리에만 존재한다.
import { randomUUID } from 'node:crypto';

export const SessionStatus = {
  WORKING: 'working', // Claude가 작업 중
  WAITING: 'waiting', // 허가 응답 대기 중
  INPUT: 'input', // 사용자 입력 대기(idle prompt 등)
  IDLE: 'idle', // 턴 완료(Stop)
  ENDED: 'ended', // 세션 종료
};

export class Store {
  constructor({ endedTtlMs = 300_000 } = {}) {
    this.sessions = new Map(); // session_id -> session
    this.pending = new Map(); // request_id -> pending permission
    this.endedTtlMs = endedTtlMs;
    this.onChange = null; // 데몬이 브로드캐스트 콜백을 건다
  }

  #touch(session) {
    session.updatedAt = Date.now();
    this.onChange?.();
  }

  upsertSession(sessionId, patch = {}) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        id: sessionId,
        cwd: null,
        tmuxPane: null,
        status: SessionStatus.WORKING,
        model: null, // hook 페이로드에 모델 정보가 없어, 다이얼로 전환한 경우에만 안다
        thinking: null, // true/false/null(모름) — 토글 주입 시의 추정치
        lastEvent: null,
        lastMessage: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.sessions.set(sessionId, s);
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && v !== null) s[k] = v;
    }
    this.#touch(s);
    return s;
  }

  endSession(sessionId, reason) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.status = SessionStatus.ENDED;
    s.lastEvent = `ended:${reason ?? ''}`;
    // 이 세션에 걸린 허가 요청은 전부 passthrough로 정리
    for (const p of [...this.pending.values()]) {
      if (p.sessionId === sessionId) this.resolvePending(p.id, { decision: 'passthrough' });
    }
    setTimeout(() => {
      const cur = this.sessions.get(sessionId);
      if (cur && cur.status === SessionStatus.ENDED) {
        this.sessions.delete(sessionId);
        this.onChange?.();
      }
    }, this.endedTtlMs).unref();
    this.#touch(s);
  }

  /** 허가 요청 등록. resolve(result)를 호출하면 hook 응답이 나간다. */
  addPending({ sessionId, payload, resolve }) {
    const p = {
      id: randomUUID(),
      sessionId,
      toolName: payload.tool_name ?? payload.permission_type ?? 'unknown',
      toolInput: payload.tool_input ?? null,
      permissionType: payload.permission_type ?? null,
      cwd: payload.cwd ?? this.sessions.get(sessionId)?.cwd ?? null,
      createdAt: Date.now(),
      resolve,
    };
    this.pending.set(p.id, p);
    this.upsertSession(sessionId, { status: SessionStatus.WAITING });
    return p;
  }

  /** decision: once | always | deny | passthrough */
  resolvePending(requestId, result) {
    const p = this.pending.get(requestId);
    if (!p) return null;
    this.pending.delete(requestId);
    const s = this.sessions.get(p.sessionId);
    if (s && ![...this.pending.values()].some((x) => x.sessionId === p.sessionId)) {
      s.status = SessionStatus.WORKING;
    }
    p.resolve(result);
    this.onChange?.();
    return p;
  }

  /** 매크로패드 1~3번용: 가장 오래 기다린 허가 요청 */
  oldestPending() {
    let oldest = null;
    for (const p of this.pending.values()) {
      if (!oldest || p.createdAt < oldest.createdAt) oldest = p;
    }
    return oldest;
  }

  /** 다이얼(4~6번)용: 가장 최근 활동한, tmux pane을 아는 세션 */
  activeSession() {
    let best = null;
    for (const s of this.sessions.values()) {
      if (s.status === SessionStatus.ENDED || !s.tmuxPane) continue;
      if (!best || s.updatedAt > best.updatedAt) best = s;
    }
    return best;
  }

  snapshot() {
    const pendingBySession = {};
    for (const p of this.pending.values()) {
      (pendingBySession[p.sessionId] ??= []).push({
        id: p.id,
        toolName: p.toolName,
        toolInput: p.toolInput,
        permissionType: p.permissionType,
        createdAt: p.createdAt,
      });
    }
    const sessions = [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        id: s.id,
        cwd: s.cwd,
        status: s.status,
        model: s.model,
        thinking: s.thinking,
        hasTmux: Boolean(s.tmuxPane),
        lastEvent: s.lastEvent,
        lastMessage: s.lastMessage,
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
        pending: (pendingBySession[s.id] ?? []).sort((a, b) => a.createdAt - b.createdAt),
      }));
    return { sessions, now: Date.now() };
  }
}
