import assert from 'node:assert';
import { build } from 'esbuild';

// --- 不新增依赖：手写最小 localStorage / window 桩，让 store 的持久化可运行 ---
const memory = new Map();
const localStorageStub = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  clear: () => memory.clear()
};
globalThis.localStorage = localStorageStub;
globalThis.window = { localStorage: localStorageStub };

// esbuild 打包 src/store.ts（configureStore 纯 JS，可直接在 node 跑）
const result = await build({
  entryPoints: ['src/store.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent'
});
const code = result.outputFiles[0].text;
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const mod = await import(dataUrl);
const {
  store, selectPublishedVersion, selectEditorDraft, selectStaleDrafts,
  simulatePeerPublish, runPreflight, publishVersion, recoverPublish,
  setAutoFailNextPublish, migrateTodo, mergeStaleDraft, newDraft
} = mod;

function get() { return store.getState().schema; }

// 初始：head r2，存在一份基于 r2 的未完成草稿（含新增必填字段 invoiceTitle）
let s = get();
assert.equal(s.headRevision, 2);
const draft = selectEditorDraft(store.getState());
assert.ok(draft, '应能找回未完成草稿');
assert.equal(draft.baseRevision, 2);
assert.equal(selectPublishedVersion(store.getState()).revision, 2);
console.log('OK 初始：编辑留在草稿（基于 r' + draft.baseRevision + '），已发布 r2 可看');

// 1) 发布前检查：r1 历史快照缺 invoiceTitle -> 迁移待办
store.dispatch(runPreflight(draft.id));
let pending = get().migrationTodos.filter((t) => t.status === 'pending');
assert.ok(pending.length >= 2, '两条 r1 旧数据缺新版必填字段，应入迁移待办');
assert.ok(pending.every((t) => t.targetRevision === 3));
console.log('OK 发布前按最新结构重查，' + pending.length + ' 条缺字段记录进入迁移待办');

// 2) 模拟同事抢先发布 r3 -> 草稿过期，进入待合并；已发布继续可读
store.dispatch(simulatePeerPublish());
assert.equal(get().headRevision, 3);
assert.equal(selectStaleDrafts(store.getState()).length, 1, '旧稿应标记过期');
assert.equal(selectPublishedVersion(store.getState()).revision, 3, '已发布结构继续能看');

// 直接发布过期稿应被拒绝，head 不变
const headBefore = get().headRevision;
store.dispatch(runPreflight(draft.id));
assert.equal(get().preflight?.stale, true, '修订号提示旧稿过期');
store.dispatch(publishVersion(draft.id));
assert.equal(get().headRevision, headBefore, '过期稿不得覆盖已发布结构');
console.log('OK 修订号过期检测：草稿 r2 vs 已发布 r3，发布被阻止');

// 3) 合并过期草稿 -> 基于 r3 的新草稿，双方字段都保留
store.dispatch(mergeStaleDraft(draft.id));
const merged = selectEditorDraft(store.getState());
assert.ok(merged, '合并后生成新草稿');
assert.equal(merged.baseRevision, 3);
assert.ok(merged.fields.some((f) => f.id === 'invoiceTitle'), '草稿新增字段应保留');
assert.ok(merged.fields.some((f) => f.label === '成本中心'), '同事发布的字段应并入');
assert.equal(selectStaleDrafts(store.getState()).length, 0);
console.log('OK 过期内容进入待合并草稿，合并稿基于 r3 且保留双方改动');

// 4) 合并稿预检：待办按目标 r4 重建；迁移一条 -> 兼容记录
store.dispatch(runPreflight(merged.id));
pending = get().migrationTodos.filter((t) => t.status === 'pending');
assert.ok(pending.length >= 2, '应按 r4 重新生成待办');
assert.ok(pending.every((t) => t.targetRevision === 4));
const todo = pending[0];
store.dispatch(migrateTodo(todo.id));
const compat = get().compatibilityRecords.find((c) => c.snapshotId === todo.snapshotId);
assert.ok(compat, '应生成兼容记录');
assert.equal(compat.fromRevision, 1);
assert.equal(compat.toRevision, 4);
assert.equal(compat.filled.invoiceTitle, '待补充');
const snap = get().snapshots.find((x) => x.id === todo.snapshotId);
assert.equal(snap.sourceRevision, 1, '原始版本来源不可改');
assert.equal(snap.migratedRevision, 4, '记录已兼容到 r4');
console.log('OK 旧数据版本来源迁移为兼容记录（来源 r1 -> 兼容 r4）');

// 5) 发布写入失败 -> 之前可用版本仍在，未完成草稿保留，可恢复
store.dispatch(setAutoFailNextPublish(true));
store.dispatch(publishVersion(merged.id));
assert.ok(get().publishFailure, '应记录发布失败');
assert.equal(get().headRevision, 3, '失败版本未写入，head 保持 r3');
assert.ok(selectEditorDraft(store.getState()), '未完成草稿保留，重新打开可找回');
store.dispatch(recoverPublish());
assert.equal(get().headRevision, 3);
assert.ok(!get().publishFailure);
console.log('OK 发布写入失败后恢复到之前可用版本 r3，草稿仍在');

// 6) 重试发布合并稿 -> r4
store.dispatch(runPreflight(merged.id));
store.dispatch(publishVersion(merged.id));
assert.equal(get().headRevision, 4, '重试发布成功，产生 r4');
assert.equal(selectPublishedVersion(store.getState()).revision, 4);
assert.ok(!get().drafts.some((d) => d.id === merged.id), '已发布草稿已移除');
console.log('OK 恢复后重试发布成功，已发布为 r4');

// 7) 新建草稿跟随最新修订；持久化已写入 localStorage
store.dispatch(newDraft());
const fresh = selectEditorDraft(store.getState());
assert.equal(fresh.baseRevision, 4);
assert.ok(localStorageStub.getItem('yf55-schema-state-v2'), '状态已本地持久化，刷新可找回草稿');
const persisted = JSON.parse(localStorageStub.getItem('yf55-schema-state-v2'));
assert.equal(persisted.headRevision, 4);
console.log('OK 新草稿基于最新 r4，运行态与版本差异共用同一份已发布内容，状态已持久化');

console.log('\n全部协作流程冒烟测试通过 ✅');
