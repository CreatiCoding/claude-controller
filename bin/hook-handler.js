#!/usr/bin/env node
// Claude Code hook → 데몬 전달자.
// stdin으로 받은 hook JSON을 데몬(127.0.0.1:9200)에 넘기고,
// PermissionRequest면 결정이 올 때까지 기다렸다가 hook 출력 JSON을 낸다.
// 데몬이 꺼져 있으면 조용히 exit 0 — Claude Code 동작에 일절 간섭하지 않는다.
// 단, 왜 조용히 넘어갔는지는 ~/.claude-controller/logs/hook.log 에 남긴다(원인 추적용).
// 이 파일은 통째로 복사돼 실행될 수 있으므로 다른 모듈을 import하지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.CLAUDE_CONTROLLER_PORT || 9200);
const URL_ = `http://127.0.0.1:${PORT}/hook/event`;
const LOG_DIR = process.env.CLAUDE_CONTROLLER_LOG_DIR || path.join(os.homedir(), '.claude-controller', 'logs');
const LOG = path.join(LOG_DIR, 'hook.log');

function log(level, msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try { if (fs.statSync(LOG).size > 5 * 1024 * 1024) fs.renameSync(LOG, `${LOG}.1`); } catch {}
    fs.appendFileSync(LOG, `${new Date().toISOString().replace('T', ' ').replace('Z', '')} [${level}] ${msg}\n`);
  } catch { /* 로그 실패는 무시 — hook은 어떤 경우에도 Claude Code를 막지 않는다 */ }
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  let payload;
  const raw = await readStdin();
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    log('ERROR', `stdin JSON 파싱 실패(${e.message}) — 무시. 앞 120자: ${raw.slice(0, 120)}`);
    return; // 파싱 불가 → 간섭하지 않음
  }

  const event = payload.hook_event_name;
  const sid = String(payload.session_id ?? '').slice(0, 8);
  const isPermission = event === 'PermissionRequest';
  const tag = `${event} sid=${sid}${payload.tool_name ? ` tool=${payload.tool_name}` : ''}`;
  // 허가 요청은 데몬의 대기시간보다 넉넉히, 그 외 이벤트는 짧게
  const timeoutMs = isPermission ? 3_600_000 : 3_000;
  const started = Date.now();

  let result;
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, tmuxPane: process.env.TMUX_PANE ?? null }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log('WARN', `${tag} → 데몬 ${res.status} ${body.slice(0, 200)} — 무시(허가 요청이면 터미널 프롬프트로)`);
      return;
    }
    result = await res.json();
  } catch (err) {
    // undici는 연결 실패를 TypeError('fetch failed')로 감싸고 원인은 cause(.code 또는 AggregateError.errors[].code)에 둔다
    const cause = err?.cause?.code ?? err?.cause?.errors?.[0]?.code ?? err?.name ?? '';
    const why = cause === 'ECONNREFUSED' ? `데몬 없음(${URL_})`
      : err?.name === 'TimeoutError' ? `응답 없음 ${timeoutMs / 1000}s`
      : `${cause} ${err?.cause?.message ?? err?.message ?? err}`;
    log(isPermission ? 'WARN' : 'INFO', `${tag} → ${why} — 무시(허가 요청이면 터미널 프롬프트로)`);
    return; // 데몬 미실행/타임아웃 → 기본 동작으로 fallthrough
  }

  if (!isPermission) return;

  const { decision } = result ?? {};
  log('INFO', `${tag} → ${decision ?? 'passthrough'} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (decision === 'once' || decision === 'always') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    }));
  } else if (decision === 'deny') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'claude-controller에서 거부됨' },
      },
    }));
  }
  // passthrough/timeout → 출력 없음 → 터미널의 기본 허가 프롬프트로 진행
}

main().then(() => process.exit(0), (e) => { log('ERROR', `예상치 못한 오류: ${e?.stack ?? e}`); process.exit(0); });
