// 세션/허가요청 상태. 데몬 프로세스 메모리에만 존재한다.
import { randomUUID } from 'node:crypto';

export const SessionStatus = {
  WORKING: 'working', // Claude가 작업 중
  WAITING: 'waiting', // 허가 응답 대기 중
  INPUT: 'input', // 사용자 입력 대기(idle prompt 등)
  IDLE: 'idle', // 턴 완료(Stop)
  ENDED: 'ended', // 세션 종료
};

// 폰에 보내는 스냅샷은 표시용이다. hook 페이로드는 Write content 등으로 수 MB가 될 수 있으므로
// 문자열 필드를 잘라 매 브로드캐스트가 무거워지지 않게 한다(규칙 생성은 원본 toolInput을 쓴다).
export const DISPLAY_LIMIT = 4000;
export function trimString(s) {
  if (typeof s !== 'string' || s.length <= DISPLAY_LIMIT) return s;
  let head = s.slice(0, DISPLAY_LIMIT);
  // 서로게이트 쌍(이모지 등) 중간에서 자르면 끝 글자가 U+FFFD로 보인다
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head}… (+${s.length - head.length}자)`;
}
// 중첩 객체/배열(MultiEdit의 edits[], MCP 도구 입력)까지 재귀로 자른다
function trimForDisplay(input, depth = 0) {
  if (typeof input === 'string') return trimString(input);
  if (!input || typeof input !== 'object') return input;
  if (depth > 8) return '… (중첩 깊이 초과)'; // 원본을 그대로 흘리지 않는다
  if (Array.isArray(input)) {
    const out = input.slice(0, 200).map((v) => trimForDisplay(v, depth + 1));
    if (input.length > 200) out.push(`… (+${input.length - 200}개)`);
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(input)) out[k] = trimForDisplay(v, depth + 1);
  return out;
}

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
  addPending({ sessionId, payload, resolve, cwd = null, tmuxPane = null }) {
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
    // 종료로 표시된 세션에 허가 요청이 왔다 = 실제로는 살아 있다(resume인데 SessionStart hook이
    // 유실된 경우 등). 종료를 해제해야 카드가 대기 상태로 보이고 TTL 삭제로 고아 pending이 안 생긴다.
    this.upsertSession(sessionId, { status: SessionStatus.WAITING, lastEvent: 'start:permission', cwd, tmuxPane });
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
        toolInput: trimForDisplay(p.toolInput),
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
        lastMessage: trimString(s.lastMessage),
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
        pending: (pendingBySession[s.id] ?? []).sort((a, b) => a.createdAt - b.createdAt),
      }));
    return { sessions, now: Date.now() };
  }
}
