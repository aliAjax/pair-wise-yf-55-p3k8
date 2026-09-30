import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type FieldType = 'text' | 'number' | 'select' | 'date';
export interface FormField { id: string; label: string; type: FieldType; required: boolean; options?: string[]; }
export interface LinkRule { id: string; fieldId: string; operator: 'equals' | 'notEmpty'; value: string; effect: 'show' | 'require'; targetId: string; }
export interface FormVersion { id: string; revision: number; label: string; createdAt: string; fields: FormField[]; rules: LinkRule[]; }

export type DraftStatus = 'editing' | 'stale';
export interface Draft {
  id: string;
  label: string;
  baseRevision: number;
  status: DraftStatus;
  fields: FormField[];
  rules: LinkRule[];
  updatedAt: string;
}

export interface Snapshot {
  id: string;
  versionId: string;
  /** 历史数据创建时的版本来源（修订号），永不被草稿改动覆盖 */
  sourceRevision: number;
  /** 已通过兼容记录迁移到的修订号 */
  migratedRevision?: number;
  label: string;
  data: Record<string, string>;
}

export interface MigrationGapField { id: string; label: string; type: FieldType; options?: string[]; }

export interface MigrationTodo {
  id: string;
  snapshotId: string;
  label: string;
  sourceRevision: number;
  targetRevision: number;
  /** 缺口字段在“即将发布结构”里的定义，保证发布前后都能计算迁移默认值 */
  missing: MigrationGapField[];
  status: 'pending' | 'migrated';
}

/** 旧数据的版本来源迁移后留下的兼容记录 */
export interface CompatibilityRecord {
  id: string;
  snapshotId: string;
  label: string;
  fromRevision: number;
  toRevision: number;
  filled: Record<string, string>;
  migratedAt: string;
}

export interface PreflightGap { snapshotId: string; label: string; sourceRevision: number; missing: MigrationGapField[]; }
export interface PreflightReport {
  draftId: string;
  checkedAt: string;
  baseRevision: number;
  headRevision: number;
  nextRevision: number;
  stale: boolean;
  gaps: PreflightGap[];
}

export interface PublishFailure { targetRevision: number; rollbackRevision: number; reason: string; draftId: string; }

interface SchemaState {
  /** 已发布结构，只增不改，运行态表单与版本差异共用这一份数据源 */
  versions: FormVersion[];
  headRevision: number;
  drafts: Draft[];
  editorDraftId: string | null;
  snapshots: Snapshot[];
  migrationTodos: MigrationTodo[];
  compatibilityRecords: CompatibilityRecord[];
  preflight: PreflightReport | null;
  publishFailure: PublishFailure | null;
  /** 模拟器开关：让下一次发布写入失败，用于验证回滚恢复 */
  autoFailNextPublish: boolean;
  /** 用户已关闭“未完成草稿找回”提示的草稿 */
  dismissedRecovery: string[];
  /** 版本差异面板中用于对比的历史版本，null 表示与更早一个版本对比 */
  viewVersionId: string | null;
}

type RootShape = { schema: SchemaState };

const STORAGE_KEY = 'yf55-schema-state-v2';

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
/** 纯 JSON 深拷贝：避免 structuredClone 遇到 Immer draft 代理抛 DataCloneError */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function maxRevision(versions: FormVersion[]): number {
  return versions.reduce((max, item) => Math.max(max, item.revision), 0);
}
function defaultFor(type: FieldType, options?: string[]): string {
  if (type === 'number') return '0';
  if (type === 'select') return options?.[0] ?? '待补充';
  if (type === 'date') return new Date().toISOString().slice(0, 10);
  return '待补充';
}

function buildInitialState(): SchemaState {
  const v1: FormVersion = {
    id: 'v1', revision: 1, label: '费用申请 r1', createdAt: '2026-08-12',
    fields: [
      { id: 'name', label: '申请名称', type: 'text', required: true },
      { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
      { id: 'amount', label: '申请金额', type: 'number', required: true }
    ], rules: []
  };
  const v2: FormVersion = {
    id: 'v2', revision: 2, label: '费用申请 r2', createdAt: '2026-09-28',
    fields: [
      { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
      { id: 'name', label: '申请名称', type: 'text', required: true },
      { id: 'budgetCode', label: '预算科目', type: 'text', required: false },
      { id: 'amount', label: '申请金额', type: 'number', required: true },
      { id: 'invoiceDate', label: '预计开票日期', type: 'date', required: false }
    ],
    rules: [
      { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'budgetCode' },
      { id: 'r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' }
    ]
  };
  // 一份未完成草稿：刷新页面后应能找回
  const draft: Draft = {
    id: 'draft-v3',
    label: '费用申请 r3 草稿',
    baseRevision: 2,
    status: 'editing',
    updatedAt: '2026-09-29 18:20',
    fields: [
      ...clone(v2.fields),
      { id: 'invoiceTitle', label: '发票抬头', type: 'text', required: true }
    ],
    rules: clone(v2.rules)
  };
  return {
    versions: [v1, v2],
    headRevision: 2,
    drafts: [draft],
    editorDraftId: draft.id,
    snapshots: [
      { id: 's1', versionId: 'v1', sourceRevision: 1, label: '八月培训预算', data: { name: '培训预算', department: '财务', amount: '12000' } },
      { id: 's2', versionId: 'v1', sourceRevision: 1, label: '市场活动费用', data: { name: '新品活动', department: '市场', amount: '58000' } }
    ],
    migrationTodos: [],
    compatibilityRecords: [],
    preflight: null,
    publishFailure: null,
    autoFailNextPublish: false,
    dismissedRecovery: [],
    viewVersionId: null
  };
}

function loadState(): SchemaState {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return { ...buildInitialState(), ...(JSON.parse(raw) as SchemaState) };
    }
  } catch {
    // 持久化损坏时回退到内置数据，不影响协作流程本身
  }
  return buildInitialState();
}

/** 运行态表单、版本差异、发布对比都通过它读取同一份已发布内容 */
export const selectPublishedVersion = (root: RootState): FormVersion => {
  const { versions, headRevision } = root.schema;
  return versions.find((item) => item.revision === headRevision) ?? versions[versions.length - 1];
};
export const selectEditorDraft = (root: RootState): Draft | undefined =>
  root.schema.drafts.find((item) => item.id === root.schema.editorDraftId);
export const selectStaleDrafts = (root: RootState): Draft[] =>
  root.schema.drafts.filter((item) => item.status === 'stale');

const slice = createSlice({
  name: 'schema',
  initialState: loadState,
  reducers: {
    newDraft(state) {
      const head = state.versions.find((item) => item.revision === state.headRevision);
      if (!head) return;
      const next = maxRevision(state.versions) + 1;
      const draft: Draft = {
        id: uid('draft'),
        label: `费用申请 r${next} 草稿`,
        baseRevision: head.revision,
        status: 'editing',
        fields: clone(head.fields),
        rules: clone(head.rules),
        updatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ')
      };
      state.drafts.push(draft);
      state.editorDraftId = draft.id;
      state.preflight = null;
    },
    selectDraft(state, action: PayloadAction<string>) {
      const draft = state.drafts.find((item) => item.id === action.payload && item.status === 'editing');
      if (!draft) return;
      state.editorDraftId = draft.id;
      state.preflight = null;
    },
    discardDraft(state, action: PayloadAction<string>) {
      state.drafts = state.drafts.filter((item) => item.id !== action.payload);
      if (state.editorDraftId === action.payload) state.editorDraftId = null;
      state.preflight = null;
    },
    dismissRecovery(state, action: PayloadAction<string>) {
      if (!state.dismissedRecovery.includes(action.payload)) state.dismissedRecovery.push(action.payload);
    },
    touchDraft(state) {
      const draft = state.drafts.find((item) => item.id === state.editorDraftId && item.status === 'editing');
      if (draft) draft.updatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
    },
    reorderFields(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const draft = state.drafts.find((item) => item.id === state.editorDraftId && item.status === 'editing');
      if (!draft) return;
      const from = draft.fields.findIndex((item) => item.id === action.payload.activeId);
      const to = draft.fields.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = draft.fields.splice(from, 1);
      draft.fields.splice(to, 0, moved);
      draft.updatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
      state.preflight = null;
    },
    addField(state) {
      const draft = state.drafts.find((item) => item.id === state.editorDraftId && item.status === 'editing');
      if (!draft) return;
      draft.fields.push({ id: uid('field'), label: `新字段 ${draft.fields.length + 1}`, type: 'text', required: false });
      draft.updatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
      state.preflight = null;
    },
    updateField(state, action: PayloadAction<{ fieldId: string; patch: Partial<FormField> }>) {
      const draft = state.drafts.find((item) => item.id === state.editorDraftId && item.status === 'editing');
      const field = draft?.fields.find((item) => item.id === action.payload.fieldId);
      if (!field) return;
      Object.assign(field, action.payload.patch);
      draft!.updatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
      state.preflight = null;
    },
    removeField(state, action: PayloadAction<string>) {
      const draft = state.drafts.find((item) => item.id === state.editorDraftId && item.status === 'editing');
      if (!draft) return;
      draft.fields = draft.fields.filter((item) => item.id !== action.payload);
      draft.rules = draft.rules.filter((rule) => rule.fieldId !== action.payload && rule.targetId !== action.payload);
      draft.updatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
      state.preflight = null;
    },
    addRule(state, action: PayloadAction<Omit<LinkRule, 'id'>>) {
      const draft = state.drafts.find((item) => item.id === state.editorDraftId && item.status === 'editing');
      if (!draft) return;
      draft.rules.push({ ...action.payload, id: uid('rule') });
      draft.updatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
      state.preflight = null;
    },
    removeRule(state, action: PayloadAction<string>) {
      const draft = state.drafts.find((item) => item.id === state.editorDraftId && item.status === 'editing');
      if (!draft) return;
      draft.rules = draft.rules.filter((item) => item.id !== action.payload);
      draft.updatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
      state.preflight = null;
    },
    /** 模拟“另一位同事抢先发布”：已发布修订号 +1，基于旧修订号的草稿立即标记为过期 */
    simulatePeerPublish(state) {
      const head = state.versions.find((item) => item.revision === state.headRevision);
      if (!head) return;
      const nextRevision = maxRevision(state.versions) + 1;
      const peerVersion: FormVersion = {
        ...clone(head),
        id: uid('v'),
        revision: nextRevision,
        label: `费用申请 r${nextRevision}`,
        createdAt: new Date().toISOString().slice(0, 10),
        fields: [
          ...clone(head.fields),
          { id: uid('cost-center'), label: '成本中心', type: 'select', required: true, options: ['总公司', '分公司'] }
        ]
      };
      peerVersion.rules.push({
        id: uid('rule'), fieldId: 'department', operator: 'equals', value: '市场', effect: 'require', targetId: peerVersion.fields[peerVersion.fields.length - 1].id
      });
      state.versions.push(peerVersion);
      state.headRevision = nextRevision;
      for (const draft of state.drafts) {
        if (draft.baseRevision < nextRevision) draft.status = 'stale';
      }
      state.preflight = null;
    },
    /** 发布前按最新已发布结构重查历史快照，缺字段记录落入迁移待办 */
    runPreflight(state, action: PayloadAction<string>) {
      const draft = state.drafts.find((item) => item.id === action.payload);
      if (!draft) return;
      const headRevision = state.headRevision;
      const stale = draft.baseRevision !== headRevision;
      if (stale) draft.status = 'stale';
      const nextRevision = maxRevision(state.versions) + 1;
      const gaps: PreflightGap[] = [];
      if (!stale) {
        for (const snapshot of state.snapshots) {
          const missing = draft.fields
            .filter((field) => field.required && snapshot.data[field.id] === undefined)
            .map((field) => ({ id: field.id, label: field.label, type: field.type, options: field.options }));
          if (missing.length) gaps.push({ snapshotId: snapshot.id, label: snapshot.label, sourceRevision: snapshot.sourceRevision, missing });
        }
        // 上一次预检生成、仍未迁移的待办作废后重建，保证始终按最新结构检查
        state.migrationTodos = state.migrationTodos.filter((todo) => todo.status === 'migrated');
        for (const gap of gaps) {
          state.migrationTodos.push({
            id: uid('todo'), snapshotId: gap.snapshotId, label: gap.label,
            sourceRevision: gap.sourceRevision, targetRevision: nextRevision,
            missing: gap.missing, status: 'pending'
          });
        }
      }
      state.preflight = {
        draftId: draft.id, checkedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
        baseRevision: draft.baseRevision, headRevision, nextRevision, stale, gaps
      };
    },
    /** 确认发布：乐观写入新版本；写入失败时保留并恢复之前可用版本 */
    publishVersion(state, action: PayloadAction<string>) {
      const draft = state.drafts.find((item) => item.id === action.payload);
      if (!draft) return;
      if (draft.baseRevision !== state.headRevision) {
        draft.status = 'stale';
        state.preflight = {
          draftId: draft.id, checkedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
          baseRevision: draft.baseRevision, headRevision: state.headRevision,
          nextRevision: maxRevision(state.versions) + 1, stale: true, gaps: []
        };
        return;
      }
      const nextRevision = maxRevision(state.versions) + 1;
      if (state.autoFailNextPublish) {
        // 新版本未提交：已发布结构保持在 rollbackRevision，等待人工恢复确认
        state.autoFailNextPublish = false;
        state.publishFailure = { targetRevision: nextRevision, rollbackRevision: state.headRevision, reason: '发布写入失败（模拟存储不可用），新版本未落库', draftId: draft.id };
        return;
      }
      state.versions.push({
        ...clone(draft),
        id: uid('v'),
        revision: nextRevision,
        label: `费用申请 r${nextRevision}`,
        createdAt: new Date().toISOString().slice(0, 10)
      });
      state.headRevision = nextRevision;
      state.drafts = state.drafts.filter((item) => item.id !== draft.id);
      if (state.editorDraftId === draft.id) state.editorDraftId = null;
      state.preflight = null;
    },
    /** 发布失败后恢复：回到之前可用的已发布版本（失败版本从未写入） */
    recoverPublish(state) {
      if (!state.publishFailure) return;
      const target = state.versions.find((item) => item.revision === state.publishFailure!.rollbackRevision);
      if (target) state.headRevision = target.revision;
      state.publishFailure = null;
    },
    setAutoFailNextPublish(state, action: PayloadAction<boolean>) {
      state.autoFailNextPublish = action.payload;
    },
    /** 把待办迁移为兼容记录：旧数据的版本来源 fromRevision 被记录下来 */
    migrateTodo(state, action: PayloadAction<string>) {
      const todo = state.migrationTodos.find((item) => item.id === action.payload && item.status === 'pending');
      if (!todo) return;
      const filled: Record<string, string> = {};
      for (const gap of todo.missing) {
        filled[gap.id] = defaultFor(gap.type, gap.options);
      }
      todo.status = 'migrated';
      state.compatibilityRecords.push({
        id: uid('compat'), snapshotId: todo.snapshotId, label: todo.label,
        fromRevision: todo.sourceRevision, toRevision: todo.targetRevision,
        filled, migratedAt: new Date().toISOString().slice(0, 16).replace('T', ' ')
      });
      const snapshot = state.snapshots.find((item) => item.id === todo.snapshotId);
      if (snapshot) snapshot.migratedRevision = todo.targetRevision;
    },
    removeMigrationTodo(state, action: PayloadAction<string>) {
      state.migrationTodos = state.migrationTodos.filter((item) => item.id !== action.payload);
    },
    /** 过期草稿合并：以最新已发布结构为底，追加草稿中仍有效的新增字段/规则 */
    mergeStaleDraft(state, action: PayloadAction<string>) {
      const stale = state.drafts.find((item) => item.id === action.payload && item.status === 'stale');
      const head = state.versions.find((item) => item.revision === state.headRevision);
      if (!stale || !head) return;
      const headFieldIds = new Set(head.fields.map((field) => field.id));
      const headRuleIds = new Set(head.rules.map((rule) => rule.id));
      const fields = [
        ...clone(head.fields),
        ...stale.fields.filter((field) => !headFieldIds.has(field.id)).map((field) => clone(field))
      ];
      const validFieldIds = new Set(fields.map((field) => field.id));
      const rules = [
        ...clone(head.rules),
        ...stale.rules.filter((rule) => !headRuleIds.has(rule.id) && validFieldIds.has(rule.fieldId) && validFieldIds.has(rule.targetId)).map((rule) => clone(rule))
      ];
      const merged: Draft = {
        id: uid('draft'),
        label: `${stale.label.replace(/ 草稿$/, '')}（合并稿）`,
        baseRevision: head.revision,
        status: 'editing',
        fields, rules,
        updatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ')
      };
      state.drafts = state.drafts.filter((item) => item.id !== stale.id);
      state.drafts.push(merged);
      state.editorDraftId = merged.id;
      state.preflight = null;
    },
    selectViewVersion(state, action: PayloadAction<string | null>) {
      state.viewVersionId = action.payload;
    }
  }
});

export const {
  newDraft, selectDraft, discardDraft, dismissRecovery, touchDraft,
  reorderFields, addField, updateField, removeField, addRule, removeRule,
  simulatePeerPublish, runPreflight, publishVersion, recoverPublish, setAutoFailNextPublish,
  migrateTodo, removeMigrationTodo, mergeStaleDraft, selectViewVersion
} = slice.actions;

export const store = configureStore({ reducer: { schema: slice.reducer } });

if (typeof window !== 'undefined') {
  store.subscribe(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify((store.getState() as RootShape).schema));
    } catch {
      // 本地写入失败不影响内存中的协作流程
    }
  });
}

export type RootState = RootShape;
