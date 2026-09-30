import { configureStore, createSlice, nanoid, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export type FieldType = 'text' | 'number' | 'select' | 'date';
export interface FormField { id: string; label: string; type: FieldType; required: boolean; options?: string[]; }
export interface LinkRule { id: string; fieldId: string; operator: 'equals' | 'notEmpty'; value: string; effect: 'show' | 'require'; targetId: string; }
export type VersionStatus = 'published' | 'archived';
export interface FormVersion { id: string; label: string; createdAt: string; revision: number; fields: FormField[]; rules: LinkRule[]; status: VersionStatus; }
export interface Snapshot { id: string; versionId: string; label: string; data: Record<string, string>; compatibleWith?: string; }
export type DraftStatus = 'editing' | 'expired';
export interface Draft { id: string; label: string; baseRevision: number; fields: FormField[]; rules: LinkRule[]; updatedAt: string; status: DraftStatus; }
export type TodoStatus = 'pending' | 'done';
export interface MigrationTodo { id: string; snapshotId: string; snapshotLabel: string; sourceVersionId: string; missingFieldIds: string[]; missingFieldLabels: string[]; status: TodoStatus; resolvedRecordId?: string; createdAt: string; }

interface SchemaState {
  shapeVersion: number;
  versions: FormVersion[];
  publishedRevision: number;
  activeVersionId: string;
  viewingVersionId: string | null;
  drafts: Draft[];
  currentDraftId: string | null;
  snapshots: Snapshot[];
  migrationTodos: MigrationTodo[];
  publishError: string | null;
  rollbackNotice: string | null;
  recoveryNotice: string | null;
}
type RootShape = { schema: SchemaState };

const STORAGE_KEY = 'yf55-schema-state';
const SHAPE_VERSION = 2;

const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();
// 注意：state 是 Immer 草稿（Proxy），不能用 structuredClone，否则会抛 DataCloneError。
// 这里的数据均为纯 JSON，用 JSON 深克隆即可。
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function buildInitial(): SchemaState {
  const v1Fields: FormField[] = [
    { id: 'name', label: '申请名称', type: 'text', required: true },
    { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
    { id: 'amount', label: '申请金额', type: 'number', required: true }
  ];
  const v2Fields: FormField[] = [
    { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
    { id: 'name', label: '申请名称', type: 'text', required: true },
    { id: 'budgetCode', label: '预算科目', type: 'text', required: false },
    { id: 'amount', label: '申请金额', type: 'number', required: true },
    { id: 'invoiceDate', label: '预计开票日期', type: 'date', required: false }
  ];
  const v2Rules: LinkRule[] = [
    { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'budgetCode' },
    { id: 'r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' }
  ];
  const v1: FormVersion = { id: 'v1', label: '费用申请 v1', createdAt: '2026-08-12', revision: 1, fields: v1Fields, rules: [], status: 'published' };
  const v2: FormVersion = { id: 'v2', label: '费用申请 v2', createdAt: '2026-09-28', revision: 2, fields: v2Fields, rules: v2Rules, status: 'published' };
  const draft: Draft = { id: 'draft-1', label: '我的草稿', baseRevision: 2, fields: clone(v2Fields), rules: clone(v2Rules), updatedAt: now(), status: 'editing' };
  return {
    shapeVersion: SHAPE_VERSION,
    versions: [v1, v2],
    publishedRevision: 2,
    activeVersionId: 'v2',
    viewingVersionId: null,
    drafts: [draft],
    currentDraftId: 'draft-1',
    snapshots: [
      { id: 's1', versionId: 'v1', label: '八月培训预算', data: { name: '培训预算', department: '财务', amount: '12000' } },
      { id: 's2', versionId: 'v1', label: '市场活动费用', data: { name: '新品活动', department: '市场', amount: '58000' } }
    ],
    migrationTodos: [],
    publishError: null,
    rollbackNotice: null,
    recoveryNotice: null
  };
}

function loadInitialState(): SchemaState {
  if (typeof window === 'undefined') return buildInitial();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return buildInitial();
    const parsed = JSON.parse(raw) as Partial<SchemaState>;
    if (parsed.shapeVersion !== SHAPE_VERSION || !Array.isArray(parsed.versions) || !Array.isArray(parsed.drafts)) return buildInitial();
    const state = parsed as SchemaState;
    // 重新打开时恢复未完成草稿
    const unfinished = state.drafts.find((d) => d.status === 'editing');
    if (unfinished) {
      state.currentDraftId = unfinished.id;
      state.recoveryNotice = `已恢复未完成草稿「${unfinished.label}」（基于修订号 ${unfinished.baseRevision}），可继续编辑。`;
    }
    return state;
  } catch {
    return buildInitial();
  }
}

function currentDraft(state: SchemaState): Draft | null {
  return state.drafts.find((d) => d.id === state.currentDraftId) ?? null;
}

function refreshStaleness(state: SchemaState, draft: Draft) {
  draft.status = draft.baseRevision === state.publishedRevision ? 'editing' : 'expired';
}

function reorder<T>(list: T[], activeId: string, overId: string, key: (item: T) => string) {
  const from = list.findIndex((item) => key(item) === activeId);
  const to = list.findIndex((item) => key(item) === overId);
  if (from < 0 || to < 0) return;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
}

/** 发布前校验：引用删除 / 失效规则 / 循环依赖 */
export function validateDraft(fields: FormField[], rules: LinkRule[]): string[] {
  const warnings: string[] = [];
  const ids = new Set(fields.map((f) => f.id));
  rules.forEach((rule) => {
    if (!ids.has(rule.fieldId)) warnings.push(`联动规则「${rule.id}」的条件字段已被删除，规则将失效`);
    if (!ids.has(rule.targetId)) warnings.push(`联动规则「${rule.id}」的目标字段已被删除，规则将失效`);
  });
  const adjacency = new Map<string, string[]>();
  rules
    .filter((rule) => rule.effect === 'require' && ids.has(rule.fieldId) && ids.has(rule.targetId))
    .forEach((rule) => {
      const list = adjacency.get(rule.fieldId) ?? [];
      list.push(rule.targetId);
      adjacency.set(rule.fieldId, list);
    });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (hasCycle(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  for (const id of ids) {
    if (hasCycle(id)) {
      warnings.push('联动规则存在循环依赖（字段互相要求），可能导致无法填写');
      break;
    }
  }
  return warnings;
}

/** 按最新结构重查历史快照，缺字段的记录进入迁移待办 */
export function computeMissingTodos(snapshots: Snapshot[], version: FormVersion, existing: MigrationTodo[]): MigrationTodo[] {
  const ts = now();
  return snapshots
    .map((snapshot) => {
      const missing = version.fields.filter((field) => field.required && snapshot.data[field.id] === undefined);
      return {
        id: `todo-${nanoid()}`,
        snapshotId: snapshot.id,
        snapshotLabel: snapshot.label,
        sourceVersionId: snapshot.versionId,
        missingFieldIds: missing.map((f) => f.id),
        missingFieldLabels: missing.map((f) => f.label),
        status: 'pending' as TodoStatus,
        createdAt: ts
      };
    })
    .filter((todo) => {
      if (todo.missingFieldIds.length === 0) return false;
      // 已有待办或已迁移的快照不再重复生成
      return !existing.some((t) => t.snapshotId === todo.snapshotId);
    });
}

const slice = createSlice({
  name: 'schema',
  initialState: loadInitialState(),
  reducers: {
    createDraft(state) {
      const base = state.versions.find((v) => v.id === state.activeVersionId);
      if (!base) return;
      const draft: Draft = {
        id: `draft-${nanoid()}`,
        label: `草稿 ${state.drafts.length + 1}`,
        baseRevision: state.publishedRevision,
        fields: clone(base.fields),
        rules: clone(base.rules),
        updatedAt: now(),
        status: 'editing'
      };
      state.drafts.push(draft);
      state.currentDraftId = draft.id;
      state.viewingVersionId = null;
      state.recoveryNotice = null;
    },
    selectDraft(state, action: PayloadAction<string>) {
      state.currentDraftId = action.payload;
      state.viewingVersionId = null;
    },
    discardDraft(state, action: PayloadAction<string>) {
      state.drafts = state.drafts.filter((d) => d.id !== action.payload);
      if (state.currentDraftId === action.payload) {
        state.currentDraftId = state.drafts[0]?.id ?? null;
      }
    },
    reorderDraftFields(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const draft = currentDraft(state);
      if (!draft) return;
      reorder(draft.fields, action.payload.activeId, action.payload.overId, (f) => f.id);
      draft.updatedAt = now();
      refreshStaleness(state, draft);
    },
    addDraftField(state) {
      const draft = currentDraft(state);
      if (!draft) return;
      draft.fields.push({ id: `field-${nanoid()}`, label: '新字段', type: 'text', required: false });
      draft.updatedAt = now();
      refreshStaleness(state, draft);
    },
    updateDraftField(state, action: PayloadAction<{ id: string; patch: Partial<FormField> }>) {
      const draft = currentDraft(state);
      if (!draft) return;
      const field = draft.fields.find((f) => f.id === action.payload.id);
      if (!field) return;
      Object.assign(field, action.payload.patch);
      draft.updatedAt = now();
    },
    removeDraftField(state, action: PayloadAction<string>) {
      const draft = currentDraft(state);
      if (!draft) return;
      draft.fields = draft.fields.filter((f) => f.id !== action.payload);
      draft.rules = draft.rules.filter((r) => r.fieldId !== action.payload && r.targetId !== action.payload);
      draft.updatedAt = now();
    },
    addDraftRule(state, action: PayloadAction<Omit<LinkRule, 'id'>>) {
      const draft = currentDraft(state);
      if (!draft) return;
      draft.rules.push({ ...action.payload, id: `rule-${nanoid()}` });
      draft.updatedAt = now();
      refreshStaleness(state, draft);
    },
    removeDraftRule(state, action: PayloadAction<string>) {
      const draft = currentDraft(state);
      if (!draft) return;
      draft.rules = draft.rules.filter((r) => r.id !== action.payload);
      draft.updatedAt = now();
    },
    /** 过期内容进入待合并草稿：以最新已发布结构为底，合并旧草稿中仍兼容的字段与规则 */
    mergePendingDraft(state, action: PayloadAction<string>) {
      const expired = state.drafts.find((d) => d.id === action.payload);
      const base = state.versions.find((v) => v.id === state.activeVersionId);
      if (!expired || !base) return;
      const mergedFields = clone(base.fields);
      expired.fields.forEach((field) => {
        if (!mergedFields.some((f) => f.id === field.id)) mergedFields.push(clone(field));
      });
      const mergedRules = expired.rules.filter(
        (rule) => mergedFields.some((f) => f.id === rule.fieldId) && mergedFields.some((f) => f.id === rule.targetId)
      );
      const newDraft: Draft = {
        id: `draft-${nanoid()}`,
        label: `${expired.label}（合并）`,
        baseRevision: state.publishedRevision,
        fields: mergedFields,
        rules: mergedRules,
        updatedAt: now(),
        status: 'editing'
      };
      state.drafts = state.drafts.filter((d) => d.id !== expired.id);
      state.drafts.push(newDraft);
      state.currentDraftId = newDraft.id;
      state.viewingVersionId = null;
    },
    viewPublished(state, action: PayloadAction<string>) {
      state.viewingVersionId = action.payload;
    },
    exitView(state) {
      state.viewingVersionId = null;
    },
    /** 模拟协作者先发布：产生更高修订号，使本地草稿过期 */
    simulateCollaboratorPublish(state) {
      const current = state.versions.find((v) => v.id === state.activeVersionId);
      if (!current) return;
      const newRevision = state.publishedRevision + 1;
      const newVersion: FormVersion = {
        id: `v${newRevision}-collab-${nanoid()}`,
        label: `费用申请 v${newRevision}`,
        createdAt: today(),
        revision: newRevision,
        fields: [...clone(current.fields), { id: `field-collab-${nanoid()}`, label: '协作者新增字段', type: 'text', required: false }],
        rules: clone(current.rules),
        status: 'published'
      };
      state.versions.push(newVersion);
      state.publishedRevision = newRevision;
      state.activeVersionId = newVersion.id;
      state.drafts.forEach((draft) => {
        if (draft.status === 'editing') draft.status = 'expired';
      });
      state.viewingVersionId = null;
    },
    /** 发布事务：先快照回滚点，再提交；写入失败则恢复之前可用版本 */
    publishDraft(state, action: PayloadAction<{ failWrite?: boolean }>) {
      const draft = currentDraft(state);
      if (!draft) {
        state.publishError = '没有可发布的草稿';
        return;
      }
      if (draft.status === 'expired') {
        state.publishError = '草稿已过期（他人已先发布），请先合并到最新结构后再发布';
        return;
      }
      const rollback = {
        versions: clone(state.versions),
        publishedRevision: state.publishedRevision,
        activeVersionId: state.activeVersionId,
        snapshots: clone(state.snapshots),
        migrationTodos: clone(state.migrationTodos),
        drafts: clone(state.drafts),
        currentDraftId: state.currentDraftId
      };
      // 应用发布
      const newRevision = state.publishedRevision + 1;
      const newVersion: FormVersion = {
        id: `v${newRevision}-${nanoid()}`,
        label: `费用申请 v${newRevision}`,
        createdAt: today(),
        revision: newRevision,
        fields: clone(draft.fields),
        rules: clone(draft.rules),
        status: 'published'
      };
      state.versions.push(newVersion);
      state.publishedRevision = newRevision;
      state.activeVersionId = newVersion.id;
      state.migrationTodos.push(...computeMissingTodos(state.snapshots, newVersion, state.migrationTodos));
      // 发布后用最新结构起一份新草稿，继续编辑
      const freshDraft: Draft = {
        id: `draft-${nanoid()}`,
        label: '我的草稿',
        baseRevision: newRevision,
        fields: clone(newVersion.fields),
        rules: clone(newVersion.rules),
        updatedAt: now(),
        status: 'editing'
      };
      state.drafts = state.drafts.filter((d) => d.id !== draft.id);
      state.drafts.push(freshDraft);
      state.drafts.forEach((d) => {
        if (d.id !== freshDraft.id && d.baseRevision !== newRevision) d.status = 'expired';
      });
      state.currentDraftId = freshDraft.id;
      state.viewingVersionId = null;
      // 模拟写入提交
      if (action.payload.failWrite) {
        state.versions = rollback.versions;
        state.publishedRevision = rollback.publishedRevision;
        state.activeVersionId = rollback.activeVersionId;
        state.snapshots = rollback.snapshots;
        state.migrationTodos = rollback.migrationTodos;
        state.drafts = rollback.drafts;
        state.currentDraftId = rollback.currentDraftId;
        state.publishError = '模拟写入失败：发布事务未能提交，已回滚到上一个可用版本。';
        state.rollbackNotice = '发布写入失败，已恢复之前的可用版本。';
        return;
      }
      state.publishError = null;
      state.rollbackNotice = null;
    },
    /** 把缺字段的旧记录迁移成兼容记录（保留原快照冻结，新增指向新版本的兼容副本） */
    resolveMigrationTodo(state, action: PayloadAction<string>) {
      const todo = state.migrationTodos.find((t) => t.id === action.payload);
      if (!todo || todo.status === 'done') return;
      const snapshot = state.snapshots.find((s) => s.id === todo.snapshotId);
      const target = state.versions.find((v) => v.id === state.activeVersionId);
      if (!snapshot || !target) return;
      const data: Record<string, string> = { ...snapshot.data };
      todo.missingFieldIds.forEach((id) => {
        if (data[id] === undefined) data[id] = '';
      });
      const recordId = `snap-${nanoid()}`;
      state.snapshots.push({
        id: recordId,
        versionId: target.id,
        label: `${snapshot.label}（兼容迁移）`,
        data,
        compatibleWith: snapshot.id
      });
      todo.status = 'done';
      todo.resolvedRecordId = recordId;
    },
    resolveAllMigrationTodos(state) {
      const pending = state.migrationTodos.filter((t) => t.status === 'pending');
      pending.forEach((todo) => {
        const snapshot = state.snapshots.find((s) => s.id === todo.snapshotId);
        const target = state.versions.find((v) => v.id === state.activeVersionId);
        if (!snapshot || !target) return;
        const data: Record<string, string> = { ...snapshot.data };
        todo.missingFieldIds.forEach((id) => {
          if (data[id] === undefined) data[id] = '';
        });
        const recordId = `snap-${nanoid()}`;
        state.snapshots.push({ id: recordId, versionId: target.id, label: `${snapshot.label}（兼容迁移）`, data, compatibleWith: snapshot.id });
        todo.status = 'done';
        todo.resolvedRecordId = recordId;
      });
    },
    dismissPublishError(state) { state.publishError = null; },
    dismissRollbackNotice(state) { state.rollbackNotice = null; },
    dismissRecovery(state) { state.recoveryNotice = null; },
    replaceState(_state, action: PayloadAction<SchemaState>) { return action.payload; }
  }
});

export const schemaApi = createApi({
  reducerPath: 'schemaApi',
  baseQuery: fakeBaseQuery(),
  tagTypes: ['SchemaHistory'],
  endpoints: (builder) => ({
    schemaHistory: builder.query<FormVersion[], void>({
      queryFn: () => {
        if (typeof window === 'undefined') return { data: [] };
        try {
          const raw = window.localStorage.getItem(STORAGE_KEY);
          const state = raw ? (JSON.parse(raw) as SchemaState) : buildInitial();
          return { data: state.versions.filter((v) => v.status === 'published') };
        } catch {
          return { data: [] };
        }
      },
      providesTags: ['SchemaHistory']
    })
  })
});

export const { useSchemaHistoryQuery } = schemaApi;
export const {
  createDraft, selectDraft, discardDraft, reorderDraftFields, addDraftField, updateDraftField,
  removeDraftField, addDraftRule, removeDraftRule, mergePendingDraft, viewPublished, exitView,
  simulateCollaboratorPublish, publishDraft, resolveMigrationTodo, resolveAllMigrationTodos,
  dismissPublishError, dismissRollbackNotice, dismissRecovery, replaceState
} = slice.actions;

export const store = configureStore({
  reducer: { schema: slice.reducer, [schemaApi.reducerPath]: schemaApi.reducer },
  middleware: (getDefault) => getDefault().concat(schemaApi.middleware)
});

if (typeof window !== 'undefined') {
  // 初始状态已由 loadInitialState 从 localStorage 恢复（含未完成草稿与恢复提示），
  // 这里只负责把后续变更写回 localStorage。
  store.subscribe(() => {
    const state = (store.getState() as RootShape).schema;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });
}

export type RootState = RootShape;
