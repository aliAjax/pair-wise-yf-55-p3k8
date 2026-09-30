import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Alert, AppBar, Box, Button, Card, CardContent, Checkbox, Chip, Container, Divider,
  FormControl, FormControlLabel, Grid, IconButton, InputLabel, MenuItem,
  Select, Stack, Switch, Tab, Tabs, TextField, Toolbar, Tooltip, Typography
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  addField, addRule, discardDraft, dismissRecovery, mergeStaleDraft, migrateTodo,
  newDraft, publishVersion, recoverPublish, removeField, removeMigrationTodo, removeRule,
  reorderFields, runPreflight, selectDraft, selectEditorDraft, selectPublishedVersion,
  selectStaleDrafts, selectViewVersion, setAutoFailNextPublish, simulatePeerPublish,
  touchDraft, updateField,
  type FormField, type LinkRule, type RootState
} from './store';

type RuleDraft = { fieldId: string; operator: LinkRule['operator']; value: string; effect: LinkRule['effect']; targetId: string };

function SortableField({ field, onRemove, onPatch }: {
  field: FormField;
  onRemove: () => void;
  onPatch: (patch: Partial<FormField>) => void;
}) {
  const sortable = useSortable({ id: field.id });
  return (
    <Card ref={sortable.setNodeRef} variant="outlined" sx={{ mb: 1 }} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}>
      <CardContent sx={{ py: '12px !important', px: 2 }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Button size="small" {...sortable.attributes} {...sortable.listeners}>拖拽</Button>
          <TextField size="small" label="字段名称" value={field.label} onChange={(event) => onPatch({ label: event.target.value })} sx={{ flex: 1 }} />
          <FormControlLabel control={<Checkbox size="small" checked={field.required} onChange={(event) => onPatch({ required: event.target.checked })} />} label="必填" />
          <Chip size="small" label={field.type} variant="outlined" />
          <Tooltip title="删除字段（关联规则一并移除）"><IconButton size="small" onClick={onRemove}><DeleteOutlineIcon /></IconButton></Tooltip>
        </Stack>
      </CardContent>
    </Card>
  );
}

function RuleText({ rule, fields }: { rule: LinkRule; fields: FormField[] }) {
  const name = (id: string) => fields.find((field) => field.id === id)?.label ?? id;
  return `${name(rule.fieldId)} ${rule.operator === 'equals' ? `等于「${rule.value}」` : '非空'} 时，${rule.effect === 'require' ? '要求必填' : '显示'}「${name(rule.targetId)}」`;
}

export default function App() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const published = useSelector(selectPublishedVersion);
  const draft = useSelector(selectEditorDraft);
  const staleDrafts = useSelector(selectStaleDrafts);

  const [tab, setTab] = useState(0);
  const [runtimeResult, setRuntimeResult] = useState<Record<string, string> | null>(null);
  const [runtimeErrors, setRuntimeErrors] = useState<Record<string, string>>({});
  const [peerHint, setPeerHint] = useState(false);

  const editingDrafts = state.drafts.filter((item) => item.status === 'editing');
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const form = useForm<Record<string, string>>({ defaultValues: {} });
  const runtimeValues = form.watch();

  const [ruleDraft, setRuleDraft] = useState<RuleDraft>({ fieldId: '', operator: 'equals', value: '', effect: 'require', targetId: '' });
  useEffect(() => {
    if (draft && !ruleDraft.fieldId) {
      setRuleDraft((prev) => ({
        ...prev,
        fieldId: draft.fields[0]?.id ?? '',
        targetId: draft.fields[1]?.id ?? draft.fields[0]?.id ?? ''
      }));
    }
  }, [draft, ruleDraft.fieldId]);

  // 已发布内容切换（发布/回滚）后重置运行态表单，保证始终读取同一份已发布结构
  useEffect(() => {
    form.reset({});
    setRuntimeErrors({});
    setRuntimeResult(null);
  }, [published.revision, form]);

  const compareVersion = useMemo(() => {
    if (state.viewVersionId) return state.versions.find((item) => item.id === state.viewVersionId && item.revision !== published.revision);
    return [...state.versions].filter((item) => item.revision !== published.revision).sort((a, b) => b.revision - a.revision)[0];
  }, [state.viewVersionId, state.versions, published.revision]);

  const diff = useMemo(() => {
    if (!compareVersion) return null;
    const oldIds = new Map(compareVersion.fields.map((field) => [field.id, field]));
    const newIds = new Map(published.fields.map((field) => [field.id, field]));
    return {
      added: published.fields.filter((field) => !oldIds.has(field.id)),
      removed: compareVersion.fields.filter((field) => !newIds.has(field.id)),
      rulesAdded: published.rules.filter((rule) => !compareVersion.rules.some((item) => item.id === rule.id)),
      rulesRemoved: compareVersion.rules.filter((rule) => !published.rules.some((item) => item.id === rule.id))
    };
  }, [compareVersion, published]);

  function dragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) {
      dispatch(reorderFields({ activeId: String(event.active.id), overId: String(event.over.id) }));
    }
  }

  function handlePeerPublish() {
    dispatch(simulatePeerPublish());
    setPeerHint(true);
  }

  function handlePublish() {
    if (!draft) return;
    dispatch(runPreflight(draft.id));
    // 预检发现过期：留在待合并草稿，不覆盖已发布结构
    if (draft.baseRevision !== state.headRevision) { setTab(4); return; }
    dispatch(publishVersion(draft.id));
  }

  // 运行态规则求值（与版本差异共用 published 这份已发布内容）
  const ruleState = useMemo(() => {
    const hidden = new Set<string>();
    const extraRequired = new Set<string>();
    for (const rule of published.rules) {
      const current = runtimeValues[rule.fieldId];
      const hit = rule.operator === 'equals' ? current === rule.value : Boolean(current && String(current).trim());
      if (rule.effect === 'show' && !hit) hidden.add(rule.targetId);
      if (rule.effect === 'require' && hit) extraRequired.add(rule.targetId);
    }
    return { hidden, extraRequired };
  }, [published.rules, runtimeValues]);

  function handleRuntimeSubmit(values: Record<string, string>) {
    const errors: Record<string, string> = {};
    for (const field of published.fields) {
      if (ruleState.hidden.has(field.id)) continue;
      const required = field.required || ruleState.extraRequired.has(field.id);
      if (required && !(values[field.id] && String(values[field.id]).trim())) {
        errors[field.id] = `「${field.label}」为必填项`;
      }
    }
    setRuntimeErrors(errors);
    setRuntimeResult(Object.keys(errors).length ? null : values);
  }

  const pendingTodos = state.migrationTodos.filter((todo) => todo.status === 'pending');
  const preflight = state.preflight && state.preflight.draftId === draft?.id ? state.preflight : null;
  const recoveryDraft = draft && !state.dismissedRecovery.includes(draft.id) ? draft : null;

  return (
    <Box minHeight="100vh" bgcolor="#f7f8fc">
      <AppBar position="sticky" color="primary">
        <Toolbar>
          <Typography variant="h6" flexGrow={1}>{t('title')}</Typography>
          <Chip size="small" label={`已发布 r${published.revision}`} sx={{ bgcolor: 'rgba(255,255,255,0.2)', color: '#fff', mr: 2 }} />
          <Tooltip title="本地模拟器：制造发布写入失败，验证可回滚到之前可用版本">
            <FormControlLabel control={<Switch size="small" checked={state.autoFailNextPublish} onChange={(event) => dispatch(setAutoFailNextPublish(event.target.checked))} sx={{ color: '#fff' }} />} label={<Typography variant="caption" color="#fff">下次发布失败</Typography>} sx={{ mr: 2 }} />
          </Tooltip>
          <Tooltip title="模拟另一位协作者基于最新结构抢先发布一个新版本">
            <Button color="inherit" onClick={handlePeerPublish}>模拟同事抢先发布</Button>
          </Tooltip>
          <Button color="inherit" disabled={!draft} onClick={handlePublish}>{t('publish')}</Button>
        </Toolbar>
      </AppBar>

      <Container maxWidth="xl" sx={{ py: 3 }}>
        {state.publishFailure && (
          <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => dispatch(recoverPublish())}>恢复到 r{state.publishFailure.rollbackRevision}</Button>}>
            {state.publishFailure.reason}：目标 r{state.publishFailure.targetRevision} 未写入，已发布结构仍停留在 r{state.publishFailure.rollbackRevision}，草稿内容保留。恢复后可重试发布。
          </Alert>
        )}
        {peerHint && staleDrafts.length > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }} onClose={() => setPeerHint(false)}>
            检测到新的已发布修订 r{state.headRevision}，{staleDrafts.length} 份草稿基于旧修订号，已标记过期并移入「待合并草稿」；已发布结构仍可正常查看与运行。
          </Alert>
        )}

        <Grid container spacing={3}>
          {/* 左：草稿编辑区 —— 所有编辑只落在草稿版本 */}
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card>
              <CardContent>
                <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
                  <div>
                    <Typography variant="h6">草稿编排</Typography>
                    <Typography variant="body2" color="text.secondary">编辑只保存在草稿版本；已发布结构冻结，发布成功后才产生新修订号。</Typography>
                  </div>
                  <Button variant="contained" onClick={() => dispatch(newDraft())}>基于 r{state.headRevision} 新建草稿</Button>
                </Stack>

                <FormControl size="small" fullWidth sx={{ mb: 2 }}>
                  <InputLabel>当前草稿</InputLabel>
                  <Select label="当前草稿" value={draft?.id ?? ''} onChange={(event) => dispatch(selectDraft(event.target.value))}>
                    {editingDrafts.length === 0 && <MenuItem value="">（无草稿）</MenuItem>}
                    {editingDrafts.map((item) => (
                      <MenuItem key={item.id} value={item.id}>{item.label} · 基于 r{item.baseRevision} · {item.updatedAt}</MenuItem>
                    ))}
                  </Select>
                </FormControl>

                {recoveryDraft && (
                  <Alert severity="info" sx={{ mb: 2 }}
                    action={<Stack direction="row"><Button size="small" onClick={() => { dispatch(touchDraft()); dispatch(dismissRecovery(recoveryDraft.id)); }}>继续编辑</Button><Button size="small" color="error" onClick={() => dispatch(discardDraft(recoveryDraft.id))}>丢弃</Button></Stack>}
                    onClose={() => dispatch(dismissRecovery(recoveryDraft.id))}>
                    重新打开时找回未完成草稿：{recoveryDraft.label}（基于 r{recoveryDraft.baseRevision}，最近保存 {recoveryDraft.updatedAt}），字段与联动规则均已自动保存。
                  </Alert>
                )}

                {draft?.status === 'stale' && (
                  <Alert severity="warning" sx={{ mb: 2 }} action={<Button size="small" onClick={() => dispatch(mergeStaleDraft(draft.id))}>合并到最新</Button>}>
                    本草稿基于 r{draft.baseRevision}，最新已发布为 r{state.headRevision}，旧稿已过期，不能直接发布覆盖。请合并到基于最新结构的新草稿后继续。
                  </Alert>
                )}

                {!draft ? (
                  <Alert severity="info">没有进行中的草稿。点击右上角基于最新已发布版本新建一份；过期草稿请在右侧「待合并草稿」处理。</Alert>
                ) : (
                  <>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                      <Typography fontWeight={700}>字段（拖拡排序）</Typography>
                      <Button size="small" variant="outlined" onClick={() => dispatch(addField())}>添加字段</Button>
                    </Stack>
                    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
                      <SortableContext items={draft.fields.map((field) => field.id)} strategy={verticalListSortingStrategy}>
                        {draft.fields.map((field) => (
                          <SortableField key={field.id} field={field} onRemove={() => dispatch(removeField(field.id))} onPatch={(patch) => dispatch(updateField({ fieldId: field.id, patch }))} />
                        ))}
                      </SortableContext>
                    </DndContext>

                    <Divider sx={{ my: 2 }} />
                    <Typography fontWeight={700} mb={1}>联动规则</Typography>
                    {draft.rules.length === 0 && <Typography variant="body2" color="text.secondary" mb={1}>暂无规则。</Typography>}
                    {draft.rules.map((rule) => (
                      <Alert key={rule.id} severity="info" sx={{ mb: 1 }} onClose={() => dispatch(removeRule(rule.id))}>{RuleText({ rule, fields: draft.fields })}</Alert>
                    ))}
                    <Stack direction="row" spacing={1} mt={1} flexWrap="wrap" useFlexGap>
                      <FormControl size="small" sx={{ minWidth: 130 }}>
                        <InputLabel>条件字段</InputLabel>
                        <Select label="条件字段" value={ruleDraft.fieldId} onChange={(event) => setRuleDraft({ ...ruleDraft, fieldId: event.target.value })}>
                          {draft.fields.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}
                        </Select>
                      </FormControl>
                      <FormControl size="small" sx={{ minWidth: 100 }}>
                        <InputLabel>条件</InputLabel>
                        <Select label="条件" value={ruleDraft.operator} onChange={(event) => setRuleDraft({ ...ruleDraft, operator: event.target.value as LinkRule['operator'] })}>
                          <MenuItem value="equals">等于</MenuItem>
                          <MenuItem value="notEmpty">非空</MenuItem>
                        </Select>
                      </FormControl>
                      {ruleDraft.operator === 'equals' && <TextField size="small" label="值" value={ruleDraft.value} onChange={(event) => setRuleDraft({ ...ruleDraft, value: event.target.value })} />}
                      <FormControl size="small" sx={{ minWidth: 100 }}>
                        <InputLabel>效果</InputLabel>
                        <Select label="效果" value={ruleDraft.effect} onChange={(event) => setRuleDraft({ ...ruleDraft, effect: event.target.value as LinkRule['effect'] })}>
                          <MenuItem value="show">显示</MenuItem>
                          <MenuItem value="require">要求必填</MenuItem>
                        </Select>
                      </FormControl>
                      <FormControl size="small" sx={{ minWidth: 130 }}>
                        <InputLabel>目标字段</InputLabel>
                        <Select label="目标字段" value={ruleDraft.targetId} onChange={(event) => setRuleDraft({ ...ruleDraft, targetId: event.target.value })}>
                          {draft.fields.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}
                        </Select>
                      </FormControl>
                      <Button variant="outlined"
                        disabled={!ruleDraft.fieldId || !ruleDraft.targetId || (ruleDraft.operator === 'equals' && !ruleDraft.value)}
                        onClick={() => dispatch(addRule(ruleDraft))}>
                        添加规则
                      </Button>
                    </Stack>

                    <Divider sx={{ my: 2 }} />
                    <Stack direction="row" spacing={2} justifyContent="flex-end">
                      <Button color="error" onClick={() => dispatch(discardDraft(draft.id))}>丢弃草稿</Button>
                      <Button variant="outlined" onClick={() => dispatch(runPreflight(draft.id))}>发布前检查</Button>
                      <Button variant="contained" onClick={handlePublish}>发布为 r{Math.max(...state.versions.map((item) => item.revision)) + 1}</Button>
                    </Stack>

                    {preflight && (
                      <Box mt={2}>
                        {preflight.stale ? (
                          <Alert severity="warning" action={<Button size="small" onClick={() => { setTab(4); }}>前往待合并</Button>}>
                            草稿基于 r{preflight.baseRevision}，已发布已推进到 r{preflight.headRevision}：旧稿过期，发布被阻止。请在「待合并草稿」里并入最新结构后再发布。
                          </Alert>
                        ) : preflight.gaps.length > 0 ? (
                          <Alert severity="warning" action={<Button size="small" onClick={() => setTab(2)}>查看迁移待办</Button>}>
                            按 r{preflight.headRevision} 最新结构重查了 {state.snapshots.length} 条历史快照，{preflight.gaps.length} 条缺少新版必填字段，已进入迁移待办；处理完即可发布。
                          </Alert>
                        ) : (
                          <Alert severity="success">检查通过：草稿基于最新 r{preflight.headRevision}，全部历史快照与新结构兼容，可以发布。</Alert>
                        )}
                      </Box>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </Grid>

          {/* 右：已发布 / 差异 / 迁移 / 运行态 / 待合并 —— 都读同一份已发布内容 */}
          <Grid size={{ xs: 12, lg: 5 }}>
            <Card>
              <CardContent>
                <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="scrollable" scrollButtons="auto">
                  <Tab label="已发布结构" />
                  <Tab label="版本差异" />
                  <Tab label={`迁移待办${pendingTodos.length ? ` (${pendingTodos.length})` : ''}`} />
                  <Tab label={t('runtime')} />
                  <Tab label={`待合并草稿${staleDrafts.length ? ` (${staleDrafts.length})` : ''}`} />
                </Tabs>

                {/* 已发布结构：单一数据源 */}
                {tab === 0 && (
                  <Box mt={2}>
                    <Alert severity="info" sx={{ mb: 2 }} icon={false}>当前生效：{published.label}（{published.createdAt} 发布）。运行态表单与版本差异均读取此处，不单独缓存。</Alert>
                    {published.fields.map((field) => (
                      <Stack key={field.id} direction="row" justifyContent="space-between" sx={{ py: 0.5 }}>
                        <Typography>{field.label}</Typography>
                        <Typography variant="caption" color="text.secondary">{field.type} · {field.required ? '必填' : '选填'}</Typography>
                      </Stack>
                    ))}
                    {published.rules.length > 0 && <>
                      <Divider sx={{ my: 1.5 }} />
                      <Typography fontWeight={700} mb={1}>生效中的联动规则</Typography>
                      {published.rules.map((rule) => <Typography key={rule.id} variant="body2" sx={{ mb: 0.5 }}>· {RuleText({ rule, fields: published.fields })}</Typography>)}
                    </>}
                    <Divider sx={{ my: 1.5 }} />
                    <Typography fontWeight={700} mb={1}>历史已发布版本（冻结只读）</Typography>
                    {state.versions.filter((item) => item.revision !== published.revision).map((version) => (
                      <Button key={version.id} fullWidth sx={{ justifyContent: 'space-between' }} onClick={() => { dispatch(selectViewVersion(version.id)); setTab(1); }}>
                        <span>r{version.revision} · {version.label}</span><span>{version.createdAt}</span>
                      </Button>
                    ))}
                  </Box>
                )}

                {/* 版本差异：读 published 与历史已发布版本 */}
                {tab === 1 && (
                  <Box mt={2}>
                    <FormControl size="small" fullWidth sx={{ mb: 2 }}>
                      <InputLabel>对比基准版本</InputLabel>
                      <Select label="对比基准版本" value={compareVersion?.id ?? ''} onChange={(event) => dispatch(selectViewVersion(event.target.value || null))}>
                        {state.versions.filter((item) => item.revision !== published.revision).map((version) => <MenuItem key={version.id} value={version.id}>r{version.revision} · {version.label}</MenuItem>)}
                      </Select>
                    </FormControl>
                    {!diff ? <Typography variant="body2" color="text.secondary">暂无历史版本可对比。</Typography> : (
                      <>
                        <Typography fontWeight={700} mb={1}>r{compareVersion!.revision} → r{published.revision}</Typography>
                        <Typography variant="body2" mb={0.5}>新增字段</Typography>
                        <Stack direction="row" gap={1} flexWrap="wrap" mb={1.5}>{diff.added.length ? diff.added.map((field) => <Chip key={field.id} size="small" color="success" label={field.label} variant="outlined" />) : <Typography variant="caption" color="text.secondary">无</Typography>}</Stack>
                        <Typography variant="body2" mb={0.5}>删除字段</Typography>
                        <Stack direction="row" gap={1} flexWrap="wrap" mb={1.5}>{diff.removed.length ? diff.removed.map((field) => <Chip key={field.id} size="small" color="error" label={field.label} variant="outlined" />) : <Typography variant="caption" color="text.secondary">无</Typography>}</Stack>
                        <Typography variant="body2" mb={0.5}>新增规则</Typography>
                        <Stack spacing={0.5} mb={1.5}>{diff.rulesAdded.length ? diff.rulesAdded.map((rule) => <Alert key={rule.id} severity="success" icon={false}>{RuleText({ rule, fields: published.fields })}</Alert>) : <Typography variant="caption" color="text.secondary">无</Typography>}</Stack>
                        <Typography variant="body2" mb={0.5}>移除规则</Typography>
                        <Stack spacing={0.5}>{diff.rulesRemoved.length ? diff.rulesRemoved.map((rule) => <Alert key={rule.id} severity="warning" icon={false}>{RuleText({ rule, fields: compareVersion!.fields })}</Alert>) : <Typography variant="caption" color="text.secondary">无</Typography>}</Stack>
                        <Alert severity="info" sx={{ mt: 2 }}>历史快照按其版本来源解释，不按新结构重新解释；需要迁移时在「迁移待办」中生成兼容记录。</Alert>
                      </>
                    )}
                  </Box>
                )}

                {/* 迁移待办与兼容记录 */}
                {tab === 2 && (
                  <Box mt={2}>
                    <Typography fontWeight={700} mb={1}>待迁移记录（缺新版必填字段）</Typography>
                    {pendingTodos.length === 0 && <Typography variant="body2" color="text.secondary" mb={2}>暂无待办。在草稿上点「发布前检查」，会按最新结构重查全部历史快照。</Typography>}
                    {pendingTodos.map((todo) => (
                      <Card key={todo.id} variant="outlined" sx={{ p: 1.5, mb: 1 }}>
                        <Typography fontWeight={700}>{todo.label}</Typography>
                        <Typography variant="body2" color="text.secondary">版本来源 r{todo.sourceRevision} → 兼容 r{todo.targetRevision}；缺少：{todo.missing.map((item) => item.label).join('、')}</Typography>
                        <Stack direction="row" spacing={1} mt={1}>
                          <Button size="small" variant="contained" onClick={() => dispatch(migrateTodo(todo.id))}>迁移为兼容记录</Button>
                          <Button size="small" color="error" onClick={() => dispatch(removeMigrationTodo(todo.id))}>忽略</Button>
                        </Stack>
                      </Card>
                    ))}
                    <Divider sx={{ my: 2 }} />
                    <Typography fontWeight={700} mb={1}>兼容记录（旧数据版本来源已迁移）</Typography>
                    {state.compatibilityRecords.length === 0 && <Typography variant="body2" color="text.secondary">暂无。</Typography>}
                    {state.compatibilityRecords.map((record) => (
                      <Alert key={record.id} severity="success" sx={{ mb: 1 }}>
                        {record.label}：r{record.fromRevision} → r{record.toRevision}，补默认值 {JSON.stringify(record.filled)}（{record.migratedAt}）
                      </Alert>
                    ))}
                    <Divider sx={{ my: 2 }} />
                    <Typography fontWeight={700} mb={1}>历史快照</Typography>
                    {state.snapshots.map((snapshot) => (
                      <Card key={snapshot.id} variant="outlined" sx={{ p: 1.5, mb: 1 }}>
                        <Stack direction="row" justifyContent="space-between">
                          <Typography>{snapshot.label}</Typography>
                          <Chip size="small" label={snapshot.migratedRevision ? `来源 r${snapshot.sourceRevision} · 已兼容 r${snapshot.migratedRevision}` : `来源 r${snapshot.sourceRevision}`} color={snapshot.migratedRevision ? 'success' : 'default'} variant="outlined" />
                        </Stack>
                        <Typography variant="caption" color="text.secondary">{JSON.stringify(snapshot.data)}</Typography>
                      </Card>
                    ))}
                  </Box>
                )}

                {/* 运行态表单：直接读 published */}
                {tab === 3 && (
                  <Box component="form" mt={2} onSubmit={form.handleSubmit(handleRuntimeSubmit)}>
                    <Alert severity="info" icon={false} sx={{ mb: 2 }}>运行态只按已发布 r{published.revision} 渲染与校验，草稿改动在发布前不会影响此处。</Alert>
                    <Stack spacing={2}>
                      {published.fields.map((field) => {
                        if (ruleState.hidden.has(field.id)) return null;
                        const required = field.required || ruleState.extraRequired.has(field.id);
                        const common = {
                          size: 'small' as const,
                          label: field.label + (ruleState.extraRequired.has(field.id) ? '（联动必填）' : ''),
                          required,
                          error: Boolean(runtimeErrors[field.id]),
                          helperText: runtimeErrors[field.id]
                        };
                        if (field.type === 'select') {
                          return (
                            <FormControl key={field.id} size="small" required={required} error={Boolean(runtimeErrors[field.id])}>
                              <InputLabel>{common.label}</InputLabel>
                              <Select
                                label={common.label}
                                value={runtimeValues[field.id] ?? ''}
                                onChange={(event) => form.setValue(field.id, String(event.target.value), { shouldValidate: false })}
                              >
                                {(field.options ?? []).map((option) => <MenuItem key={option} value={option}>{option}</MenuItem>)}
                              </Select>
                              {runtimeErrors[field.id] && <Typography variant="caption" color="error">{runtimeErrors[field.id]}</Typography>}
                            </FormControl>
                          );
                        }
                        return (
                          <TextField
                            key={field.id}
                            {...common}
                            type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                            InputLabelProps={field.type === 'date' ? { shrink: true } : undefined}
                            {...form.register(field.id)}
                          />
                        );
                      })}
                      <Button type="submit" variant="contained">按已发布版本提交</Button>
                    </Stack>
                    {runtimeResult && <Alert severity="success" sx={{ mt: 2 }}>提交成功：{JSON.stringify(runtimeResult)}</Alert>}
                  </Box>
                )}

                {/* 待合并草稿 */}
                {tab === 4 && (
                  <Box mt={2}>
                    <Typography fontWeight={700} mb={1}>过期草稿（旧修订号）</Typography>
                    {staleDrafts.length === 0 && <Typography variant="body2" color="text.secondary">没有过期草稿。点左上角「模拟同事抢先发布」可制造并发发布场景。</Typography>}
                    {staleDrafts.map((item) => (
                      <Card key={item.id} variant="outlined" sx={{ p: 1.5, mb: 1 }}>
                        <Typography fontWeight={700}>{item.label}</Typography>
                        <Typography variant="body2" color="text.secondary" mb={1}>
                          基于 r{item.baseRevision}，当前已发布 r{state.headRevision}；包含 {item.fields.length} 个字段、{item.rules.length} 条规则。合并会以最新结构为底，仅追加草稿里新增且引用仍有效的字段和规则。
                        </Typography>
                        <Stack direction="row" spacing={1}>
                          <Button size="small" variant="contained" onClick={() => dispatch(mergeStaleDraft(item.id))}>合并为新草稿</Button>
                          <Button size="small" color="error" onClick={() => dispatch(discardDraft(item.id))}>丢弃</Button>
                        </Stack>
                      </Card>
                    ))}
                  </Box>
                )}
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      </Container>
    </Box>
  );
}
