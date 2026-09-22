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
    // 종료된 세션에 늦게 도착한 Stop/Notification 등은 통째로 무시한다 — 상태를 되살리면 카드가
    // 영구 잔존하고, updatedAt/lastMessage만 갱신해도 "종료됨" 카드가 목록 맨 위로 튀어오른다.
    // 같은 id로 SessionStart가 다시 오면(resume) 종료를 해제하고 TTL 삭제도 취소한다.
    if (s.endedAt) {
      if (!String(patch.lastEvent ?? '').startsWith('start:')) return s;
      delete s.endedAt;
      clearTimeout(s.ttlTimer);
      s.ttlTimer = null;
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
    // 이 세션에 걸린 허가 요청은 전부 passthrough로 정리한다.
    // resolvePending이 상태를 working으로 되돌리므로 ENDED 표시는 그 뒤에 한다.
    for (const p of [...this.pending.values()]) {
      if (p.sessionId === sessionId) this.resolvePending(p.id, { decision: 'passthrough' });
    }
    s.status = SessionStatus.ENDED;
    s.endedAt = Date.now();
    s.lastEvent = `ended:${reason ?? ''}`;
    clearTimeout(s.ttlTimer); // 재종료 시 이전 타이머가 조기 삭제하지 않도록
    s.ttlTimer = setTimeout(() => {
      const cur = this.sessions.get(sessionId);
      if (cur?.endedAt) {
        this.sessions.delete(sessionId);
        this.onChange?.();
      }
    }, this.endedTtlMs);
    s.ttlTimer.unref();
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
    if (s && !s.endedAt && ![...this.pending.values()].some((x) => x.sessionId === p.sessionId)) {
      s.status = SessionStatus.WORKING; // 종료된 세션은 되살리지 않는다
    }
    p.resolve(result);
    this.onChange?.();
    return p;
  }

  hasPending(sessionId) {
    for (const p of this.pending.values()) if (p.sessionId === sessionId) return true;
    return false;
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
      .sort((a, b) => b.updatedAt - a.updatedAt || b.startedAt - a.startedAt)
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
