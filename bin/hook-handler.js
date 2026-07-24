#!/usr/bin/env node
// Claude Code hook → 데몬 전달자.
// stdin으로 받은 hook JSON을 데몬(127.0.0.1:9200)에 넘기고,
// PermissionRequest면 결정이 올 때까지 기다렸다가 hook 출력 JSON을 낸다.
// 데몬이 꺼져 있으면 조용히 exit 0 — Claude Code 동작에 일절 간섭하지 않는다.

const PORT = Number(process.env.CLAUDE_CONTROLLER_PORT || 9200);
const URL_ = `http://127.0.0.1:${PORT}/hook/event`;

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return; // 파싱 불가 → 간섭하지 않음
  }

  const isPermission = payload.hook_event_name === 'PermissionRequest';
  // 허가 요청은 데몬의 대기시간보다 넉넉히, 그 외 이벤트는 짧게
  const timeoutMs = isPermission ? 3_600_000 : 3_000;

  let result;
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, tmuxPane: process.env.TMUX_PANE ?? null }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return;
    result = await res.json();
  } catch {
    return; // 데몬 미실행/타임아웃 → 기본 동작으로 fallthrough
  }

  if (!isPermission) return;

  const { decision } = result ?? {};
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

main().then(() => process.exit(0), () => process.exit(0));
