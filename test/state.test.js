import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, SessionStatus } from '../src/state.js';

const perm = (store, sid, command = 'ls') =>
  new Promise((resolve) => store.addPending({ sessionId: sid, payload: { tool_name: 'Bash', tool_input: { command } }, resolve }));

test('허가 요청 등록 → waiting, 전부 해소돼야 working', async () => {
  const store = new Store();
  store.upsertSession('A', { cwd: '/p' });
  const p1 = perm(store, 'A', 'ls');
  const p2 = perm(store, 'A', 'pwd');
  assert.equal(store.sessions.get('A').status, SessionStatus.WAITING);
  const [id1, id2] = [...store.pending.keys()];
  store.resolvePending(id1, { decision: 'once' });
  assert.equal(store.sessions.get('A').status, SessionStatus.WAITING, '하나 남아 있으면 계속 waiting');
  store.resolvePending(id2, { decision: 'deny' });
  assert.equal(store.sessions.get('A').status, SessionStatus.WORKING);
  assert.deepEqual(await p1, { decision: 'once' });
  assert.deepEqual(await p2, { decision: 'deny' });
});

test('이미 처리된 요청은 null, oldestPending은 가장 오래된 것', () => {
  const store = new Store();
  store.addPending({ sessionId: 'A', payload: {}, resolve() {} });
  const first = store.oldestPending();
  first.createdAt -= 10;
  store.addPending({ sessionId: 'B', payload: {}, resolve() {} });
  assert.equal(store.oldestPending().id, first.id);
  assert.ok(store.resolvePending(first.id, { decision: 'once' }));
  assert.equal(store.resolvePending(first.id, { decision: 'once' }), null);
});

test('세션 종료 시 남은 요청은 passthrough, TTL 후 제거', async () => {
  const store = new Store({ endedTtlMs: 20 });
  store.upsertSession('A');
  const p = perm(store, 'A');
  store.endSession('A', 'exit');
  assert.deepEqual(await p, { decision: 'passthrough' });
  assert.equal(store.sessions.get('A').status, SessionStatus.ENDED);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(store.sessions.has('A'), false);
});

test('스냅샷: 최근 활동 순 세션, 세션별 pending은 오래된 순, null 필드는 patch로 덮이지 않음', () => {
  const store = new Store();
  store.upsertSession('A', { cwd: '/a', tmuxPane: '%1' });
  store.upsertSession('A', { cwd: null, tmuxPane: undefined }); // null/undefined는 무시
  store.upsertSession('B', { cwd: '/b' });
  store.sessions.get('B').updatedAt += 5; // 같은 ms에 만들어져도 순서가 결정되게
  const snap = store.snapshot();
  assert.equal(snap.sessions[0].id, 'B');
  assert.equal(snap.sessions[1].cwd, '/a');
  assert.equal(snap.sessions[1].hasTmux, true);
  assert.equal(store.activeSession().id, 'A', '다이얼 대상은 pane을 아는 세션');
});
