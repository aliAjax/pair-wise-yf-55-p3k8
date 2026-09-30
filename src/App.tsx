import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert, AppBar, Box, Button, Card, CardContent, Checkbox, Chip, Container, Dialog, DialogActions, DialogContent,
  DialogTitle, Divider, FormControl, FormControlLabel, Grid, IconButton, InputLabel, MenuItem, Select, Stack,
  Switch, Tab, Tabs, TextField, Toolbar, Typography
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  addDraftField, addDraftRule, createDraft, discardDraft, dismissPublishError, dismissRecovery, dismissRollbackNotice,
  exitView, mergePendingDraft, publishDraft, reorderDraftFields, removeDraftField, removeDraftRule, resolveAllMigrationTodos,
  resolveMigrationTodo, selectDraft, simulateCollaboratorPublish, updateDraftField, viewPublished,
  computeMissingTodos, validateDraft,
  type FormField, type FormVersion, type LinkRule, type RootState
} from './store';

const fieldTypes: FormField['type'][] = ['text', 'number', 'select', 'date'];

function isVisible(fields: FormField[], rules: LinkRule[], values: Record<string, unknown>, fieldId: string): boolean {
  const showRules = rules.filter((rule) => rule.effect === 'show' && rule.targetId === fieldId);
  if (showRules.length === 0) return true;
  return showRules.some((rule) => {
    const value = values[rule.fieldId];
    return rule.operator === 'equals' ? value === rule.value : value !== '' && value !== undefined;
  });
}

function buildRuntimeSchema(fields: FormField[], rules: LinkRule[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  fields.forEach((field) => {
    let schema: z.ZodTypeAny;
    if (field.type === 'number') {
      schema = z.preprocess((value) => (value === '' || value === undefined ? undefined : Number(value)), z.number());
    } else {
      schema = z.string();
    }
    if (field.required) {
      schema = field.type === 'number'
        ? (schema as z.ZodNumber).positive(`${field.label}必须大于0`)
        : (schema as z.ZodString).min(1, `${field.label}不能为空`);
    } else {
      schema = schema.optional();
    }
    shape[field.id] = schema;
  });
  return z.object(shape).superRefine((data, ctx) => {
    const values = data as Record<string, unknown>;
    rules.forEach((rule) => {
      if (rule.effect !== 'require' || !isVisible(fields, rules, values, rule.targetId)) return;
      const value = values[rule.fieldId];
      const conditionMet = rule.operator === 'equals' ? value === rule.value : value !== '' && value !== undefined;
      if (!conditionMet) return;
      const target = values[rule.targetId];
      if (target === undefined || target === '' || target === null) {
        ctx.addIssue({ code: 'custom', path: [rule.targetId], message: `联动要求：${rule.targetId} 必填` });
      }
    });
  });
}

function buildDefaults(fields: FormField[]): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  fields.forEach((field) => { defaults[field.id] = field.type === 'number' ? '' : ''; });
  return defaults;
}

function RuntimeForm({ fields, rules }: { fields: FormField[]; rules: LinkRule[] }) {
  const schema = useMemo(() => buildRuntimeSchema(fields, rules), [fields, rules]);
  const defaults = useMemo(() => buildDefaults(fields), [fields]);
  const { register, handleSubmit, watch, formState: { errors } } = useForm({ resolver: zodResolver(schema), defaultValues: defaults });
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const values = watch();
  const visibleFields = fields.filter((field) => isVisible(fields, rules, values, field.id));
  return (
    <Box component="form" onSubmit={handleSubmit((values) => setResult(values))}>
      <Stack spacing={2}>
        {visibleFields.map((field) => (
          <TextField
            key={field.id}
            label={field.label}
            type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
            required={field.required}
            {...register(field.id)}
            error={Boolean(errors[field.id])}
            helperText={errors[field.id]?.message as string}
            InputLabelProps={field.type === 'date' ? { shrink: true } : undefined}
          />
        ))}
        <Button type="submit" variant="contained">按当前已发布版本提交</Button>
      </Stack>
      {result && <Alert severity="success" sx={{ mt: 2 }}>运行态数据：{JSON.stringify(result)}</Alert>}
      <Alert severity="info" sx={{ mt: 2 }}>运行态表单与版本差异读取同一份已发布内容；历史数据按创建时版本解释。</Alert>
    </Box>
  );
}

function SortableField({ field, readOnly }: { field: FormField; readOnly: boolean }) {
  const dispatch = useDispatch();
  const sortable = useSortable({ id: field.id, disabled: readOnly });
  return (
    <Card ref={sortable.setNodeRef} variant="outlined" sx={{ mb: 1 }}>
      <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: '12px !important' }}>
        <Button size="small" {...sortable.attributes} {...sortable.listeners} sx={{ cursor: readOnly ? 'default' : 'grab' }}>拖拽</Button>
        <TextField size="small" label="字段名" value={field.label} disabled={readOnly}
          onChange={(event) => dispatch(updateDraftField({ id: field.id, patch: { label: event.target.value } }))} sx={{ width: 140 }} />
        <FormControl size="small" sx={{ width: 110 }} disabled={readOnly}>
          <InputLabel>类型</InputLabel>
          <Select label="类型" value={field.type}
            onChange={(event) => dispatch(updateDraftField({ id: field.id, patch: { type: event.target.value as FormField['type'] } }))}>
            {fieldTypes.map((type) => <MenuItem key={type} value={type}>{type}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControlLabel control={<Checkbox checked={field.required} disabled={readOnly}
          onChange={(event) => dispatch(updateDraftField({ id: field.id, patch: { required: event.target.checked } }))} />} label="必填" />
        <Box flexGrow={1} />
        <IconButton size="small" color="error" disabled={readOnly} onClick={() => dispatch(removeDraftField(field.id))}><DeleteOutlineIcon /></IconButton>
      </CardContent>
    </Card>
  );
}

function fieldLabel(fields: FormField[], id: string): string {
  return fields.find((f) => f.id === id)?.label ?? id;
}

function computeDiff(prev: FormVersion, next: FormVersion) {
  const prevIds = prev.fields.map((f) => f.id);
  const nextIds = next.fields.map((f) => f.id);
  const added = next.fields.filter((f) => !prevIds.includes(f.id));
  const removed = prev.fields.filter((f) => !nextIds.includes(f.id));
  const reordered = added.length === 0 && removed.length === 0 && prevIds.some((id, index) => id !== nextIds[index]);
  const addedRules = next.rules.filter((rule) => !prev.rules.some((r) => r.id === rule.id));
  const removedRules = prev.rules.filter((rule) => !next.rules.some((r) => r.id === rule.id));
  return { added, removed, reordered, addedRules, removedRules };
}

export default function App() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const { versions, publishedRevision, activeVersionId, viewingVersionId, drafts, currentDraftId, snapshots, migrationTodos, publishError, rollbackNotice, recoveryNotice } = state;

  const publishedVersion = versions.find((v) => v.id === activeVersionId) ?? versions[0];
  const draft = drafts.find((d) => d.id === currentDraftId) ?? null;
  const viewingVersion = versions.find((v) => v.id === viewingVersionId) ?? null;
  const displayVersion: FormVersion = viewingVersion
    ?? (draft ? { id: draft.id, label: draft.label, createdAt: draft.updatedAt, revision: draft.baseRevision, fields: draft.fields, rules: draft.rules, status: 'published' } : publishedVersion);
  const isReadOnly = Boolean(viewingVersion) || draft?.status === 'expired';

  const [tab, setTab] = useState(0);
  const [publishOpen, setPublishOpen] = useState(false);
  const [failWrite, setFailWrite] = useState(false);
  const [newRule, setNewRule] = useState<{ fieldId: string; operator: 'equals' | 'notEmpty'; value: string; effect: 'show' | 'require'; targetId: string }>({
    fieldId: '', operator: 'equals', value: '', effect: 'require', targetId: ''
  });
  const sensors = useSensors(useSensor(PointerSensor));
  const history = versions.filter((version) => version.status === 'published');

  const draftAsVersion: FormVersion = draft
    ? { id: draft.id, label: draft.label, createdAt: draft.updatedAt, revision: draft.baseRevision, fields: draft.fields, rules: draft.rules, status: 'published' }
    : publishedVersion;
  const diff = useMemo(() => computeDiff(publishedVersion, draftAsVersion), [publishedVersion, draftAsVersion]);
  const ruleWarnings = useMemo(() => (draft ? validateDraft(draft.fields, draft.rules) : []), [draft]);
  const todoPreview = useMemo(() => computeMissingTodos(snapshots, draftAsVersion, []), [snapshots, draftAsVersion]);
  const pendingDrafts = drafts.filter((d) => d.status === 'expired');
  const editingDrafts = drafts.filter((d) => d.status === 'editing');

  function openPublish() {
    setFailWrite(false);
    setPublishOpen(true);
  }
  function confirmPublish() {
    dispatch(publishDraft({ failWrite }));
    setPublishOpen(false);
  }
  function dragEnd(event: DragEndEvent) {
    if (!draft || isReadOnly) return;
    if (event.over && event.active.id !== event.over.id) {
      dispatch(reorderDraftFields({ activeId: String(event.active.id), overId: String(event.over.id) }));
    }
  }
  function addRule() {
    if (!draft) return;
    const fieldId = newRule.fieldId || draft.fields[0]?.id;
    const targetId = newRule.targetId || draft.fields[1]?.id || draft.fields[0]?.id;
    if (!fieldId || !targetId) return;
    dispatch(addDraftRule({ ...newRule, fieldId, targetId }));
  }

  return (
    <Box minHeight="100vh" bgcolor="#f7f8fc">
      <AppBar position="sticky" color="primary">
        <Toolbar>
          <Typography variant="h6" flexGrow={1}>{t('title')}</Typography>
          <Chip label={`已发布修订号 r${publishedRevision}`} color="secondary" size="small" sx={{ mr: 2 }} />
          <Button color="inherit" onClick={() => dispatch(simulateCollaboratorPublish())}>模拟协作者先发布</Button>
          <Button color="inherit" variant="outlined" sx={{ ml: 1 }} onClick={openPublish} disabled={!draft || draft.status === 'expired'}>发布草稿</Button>
        </Toolbar>
      </AppBar>
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Stack spacing={2} mb={2}>
          {recoveryNotice && <Alert severity="success" onClose={() => dispatch(dismissRecovery())}>{recoveryNotice}</Alert>}
          {publishError && <Alert severity="error" onClose={() => dispatch(dismissPublishError())}>{publishError}</Alert>}
          {rollbackNotice && <Alert severity="warning" onClose={() => dispatch(dismissRollbackNotice())}>{rollbackNotice}</Alert>}
          {draft?.status === 'expired' && !viewingVersion && (
            <Alert severity="warning" action={<Button color="inherit" size="small" onClick={() => dispatch(mergePendingDraft(draft.id))}>合并为新草稿</Button>}>
              草稿已过期：你的草稿基于修订号 r{draft.baseRevision}，但已发布结构已到 r{publishedRevision}。过期内容可进入待合并草稿，已发布结构仍可只读查看。
            </Alert>
          )}
          {viewingVersion && (
            <Alert severity="info" action={<Button color="inherit" size="small" onClick={() => dispatch(exitView())}>返回草稿</Button>}>
              正在只读查看已发布版本「{viewingVersion.label}」（修订号 r{viewingVersion.revision}），编辑请回到草稿。
            </Alert>
          )}
        </Stack>
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card>
              <CardContent>
                <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2} flexWrap="wrap" gap={1}>
                  <div>
                    <Typography variant="h6">{viewingVersion ? '已发布版本（只读）' : '草稿编辑'}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {viewingVersion
                        ? `${viewingVersion.label} · 修订号 r${viewingVersion.revision}`
                        : `草稿「${draft?.label ?? ''}」· 基于修订号 r${draft?.baseRevision ?? '-'} · 编辑只留在草稿，发布后才成为新版本`}
                    </Typography>
                  </div>
                  {!viewingVersion && (
                    <Stack direction="row" spacing={1}>
                      <Button variant="outlined" onClick={() => dispatch(createDraft())}>新建草稿</Button>
                      <Button variant="contained" onClick={() => dispatch(addDraftField())} disabled={!draft || isReadOnly}>添加字段</Button>
                    </Stack>
                  )}
                </Stack>

                {!viewingVersion && drafts.length > 0 && (
                  <Stack direction="row" gap={1} flexWrap="wrap" mb={2}>
                    {drafts.map((item) => (
                      <Chip key={item.id} label={`${item.label}（r${item.baseRevision}）${item.status === 'expired' ? '· 已过期' : ''}`}
                        color={item.id === currentDraftId ? 'primary' : item.status === 'expired' ? 'warning' : 'default'}
                        variant={item.id === currentDraftId ? 'filled' : 'outlined'}
                        onClick={() => dispatch(selectDraft(item.id))}
                        onDelete={drafts.length > 1 ? () => dispatch(discardDraft(item.id)) : undefined} />
                    ))}
                  </Stack>
                )}

                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
                  <SortableContext items={displayVersion.fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                    <Stack>{displayVersion.fields.map((field) => <SortableField key={field.id} field={field} readOnly={isReadOnly} />)}</Stack>
                  </SortableContext>
                </DndContext>

                <Divider sx={{ my: 3 }} />
                <Typography variant="h6" mb={1}>联动规则</Typography>
                {displayVersion.rules.length === 0 && <Typography variant="body2" color="text.secondary">暂无联动规则</Typography>}
                {displayVersion.rules.map((rule) => (
                  <Alert key={rule.id} severity="info" sx={{ mb: 1 }}
                    action={!isReadOnly ? <IconButton size="small" onClick={() => dispatch(removeDraftRule(rule.id))}><DeleteOutlineIcon /></IconButton> : undefined}>
                    当「{fieldLabel(displayVersion.fields, rule.fieldId)}」{rule.operator === 'equals' ? `等于「${rule.value}」` : '非空'} 时，{rule.effect === 'require' ? '要求填写' : '显示'}「{fieldLabel(displayVersion.fields, rule.targetId)}」
                  </Alert>
                ))}
                {!isReadOnly && draft && (
                  <Stack direction="row" spacing={1} mt={2} flexWrap="wrap" useFlexGap>
                    <FormControl size="small" sx={{ minWidth: 120 }}>
                      <InputLabel>条件字段</InputLabel>
                      <Select label="条件字段" value={newRule.fieldId} onChange={(event) => setNewRule({ ...newRule, fieldId: event.target.value })}>
                        {draft.fields.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}
                      </Select>
                    </FormControl>
                    <FormControl size="small" sx={{ minWidth: 110 }}>
                      <InputLabel>条件</InputLabel>
                      <Select label="条件" value={newRule.operator} onChange={(event) => setNewRule({ ...newRule, operator: event.target.value as 'equals' | 'notEmpty' })}>
                        <MenuItem value="equals">等于</MenuItem>
                        <MenuItem value="notEmpty">非空</MenuItem>
                      </Select>
                    </FormControl>
                    {newRule.operator === 'equals' && <TextField size="small" label="值" value={newRule.value} onChange={(event) => setNewRule({ ...newRule, value: event.target.value })} sx={{ width: 100 }} />}
                    <FormControl size="small" sx={{ minWidth: 110 }}>
                      <InputLabel>效果</InputLabel>
                      <Select label="效果" value={newRule.effect} onChange={(event) => setNewRule({ ...newRule, effect: event.target.value as 'show' | 'require' })}>
                        <MenuItem value="require">必填</MenuItem>
                        <MenuItem value="show">显示</MenuItem>
                      </Select>
                    </FormControl>
                    <FormControl size="small" sx={{ minWidth: 120 }}>
                      <InputLabel>目标字段</InputLabel>
                      <Select label="目标字段" value={newRule.targetId} onChange={(event) => setNewRule({ ...newRule, targetId: event.target.value })}>
                        {draft.fields.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}
                      </Select>
                    </FormControl>
                    <Button variant="outlined" onClick={addRule}>添加联动</Button>
                  </Stack>
                )}
              </CardContent>
            </Card>
          </Grid>

          <Grid size={{ xs: 12, lg: 5 }}>
            <Card>
              <CardContent>
                <Tabs value={tab} onChange={(_, value) => setTab(value)}>
                  <Tab label="版本差异" />
                  <Tab label="迁移模拟" />
                  <Tab label={t('runtime')} />
                  <Tab label={`待合并草稿${pendingDrafts.length ? `（${pendingDrafts.length}）` : ''}`} />
                </Tabs>

                {tab === 0 && (
                  <Box mt={2}>
                    <Typography fontWeight={700} mb={1}>已发布 r{publishedVersion.revision} → 草稿 r{draft?.baseRevision ?? '-'}（发布后 r{publishedRevision + 1}）</Typography>
                    <Stack direction="row" gap={1} flexWrap="wrap">
                      {diff.added.map((field) => <Chip key={field.id} label={`新增 ${field.label}`} color="success" variant="outlined" />)}
                      {diff.removed.map((field) => <Chip key={field.id} label={`删除 ${field.label}`} color="error" variant="outlined" />)}
                      {diff.reordered && <Chip label="顺序调整" color="warning" variant="outlined" />}
                      {diff.addedRules.map((rule) => <Chip key={rule.id} label={`新增规则 ${rule.id}`} color="success" variant="outlined" />)}
                      {diff.removedRules.map((rule) => <Chip key={rule.id} label={`删除规则 ${rule.id}`} color="error" variant="outlined" />)}
                      {!diff.added.length && !diff.removed.length && !diff.reordered && !diff.addedRules.length && !diff.removedRules.length && (
                        <Chip label="草稿与已发布结构一致" variant="outlined" />
                      )}
                    </Stack>
                    {ruleWarnings.length > 0 && (
                      <Alert severity="warning" sx={{ mt: 2 }}>
                        {ruleWarnings.map((warning) => <div key={warning}>· {warning}</div>)}
                      </Alert>
                    )}
                    <Alert severity="info" sx={{ mt: 2 }}>运行态表单与本差异页都读取同一份已发布内容；历史版本解释保持冻结。</Alert>
                    <Typography mt={2} fontWeight={700}>已发布历史版本</Typography>
                    {history.map((version) => (
                      <Button key={version.id} fullWidth sx={{ justifyContent: 'space-between' }}
                        onClick={() => { dispatch(viewPublished(version.id)); setTab(0); }}>
                        <span>{version.label} · r{version.revision}</span><span>{version.createdAt}</span>
                      </Button>
                    ))}
                  </Box>
                )}

                {tab === 1 && (
                  <Box mt={2}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                      <Typography fontWeight={700}>历史快照（按发布前最新结构重查）</Typography>
                      <Button size="small" onClick={() => dispatch(resolveAllMigrationTodos())}
                        disabled={!migrationTodos.some((todo) => todo.status === 'pending')}>全部迁移为兼容记录</Button>
                    </Stack>
                    {snapshots.map((snapshot) => {
                      const todo = migrationTodos.find((item) => item.snapshotId === snapshot.id && item.status === 'pending');
                      const done = migrationTodos.find((item) => item.snapshotId === snapshot.id && item.status === 'done');
                      return (
                        <Card key={snapshot.id} variant="outlined" sx={{ p: 2, mb: 1 }}>
                          <Stack direction="row" justifyContent="space-between" alignItems="center">
                            <Typography fontWeight={600}>{snapshot.label}</Typography>
                            <Chip size="small" label={`来源 r${versions.find((v) => v.id === snapshot.versionId)?.revision ?? '-'}`} />
                          </Stack>
                          <Typography variant="body2" color="text.secondary" mb={1}>{JSON.stringify(snapshot.data)}</Typography>
                          {todo && (
                            <Alert severity="warning" sx={{ mt: 1 }} action={<Button size="small" color="inherit" onClick={() => dispatch(resolveMigrationTodo(todo.id))}>迁移为兼容记录</Button>}>
                              缺少新结构必填字段：{todo.missingFieldLabels.join('、')}
                            </Alert>
                          )}
                          {done && <Alert severity="success" sx={{ mt: 1 }}>已迁移为兼容记录 → {done.resolvedRecordId}</Alert>}
                          {!todo && !done && <Alert severity="success" sx={{ mt: 1 }}>与当前结构兼容，无需迁移</Alert>}
                        </Card>
                      );
                    })}
                  </Box>
                )}

                {tab === 2 && <Box mt={2}><RuntimeForm key={publishedVersion.id} fields={publishedVersion.fields} rules={publishedVersion.rules} /></Box>}

                {tab === 3 && (
                  <Box mt={2}>
                    <Typography fontWeight={700} mb={1}>待合并草稿</Typography>
                    {pendingDrafts.length === 0 && <Typography variant="body2" color="text.secondary">没有过期草稿。协作者先发布后，你的草稿会进入这里。</Typography>}
                    {pendingDrafts.map((item) => (
                      <Card key={item.id} variant="outlined" sx={{ p: 2, mb: 1 }}>
                        <Stack direction="row" justifyContent="space-between" alignItems="center">
                          <div>
                            <Typography fontWeight={600}>{item.label}</Typography>
                            <Typography variant="body2" color="text.secondary">基于 r{item.baseRevision} · {item.fields.length} 个字段 · {item.rules.length} 条规则</Typography>
                          </div>
                          <Chip label="已过期" color="warning" size="small" />
                        </Stack>
                        <Stack direction="row" spacing={1} mt={1}>
                          <Button size="small" variant="contained" onClick={() => dispatch(mergePendingDraft(item.id))}>合并为新草稿</Button>
                          <Button size="small" onClick={() => dispatch(selectDraft(item.id))}>查看内容</Button>
                          <Button size="small" color="error" onClick={() => dispatch(discardDraft(item.id))}>放弃</Button>
                        </Stack>
                      </Card>
                    ))}
                    <Divider sx={{ my: 2 }} />
                    <Typography fontWeight={700} mb={1}>编辑中的草稿</Typography>
                    {editingDrafts.map((item) => (
                      <Card key={item.id} variant="outlined" sx={{ p: 2, mb: 1 }}>
                        <Stack direction="row" justifyContent="space-between" alignItems="center">
                          <Typography fontWeight={600}>{item.label} · r{item.baseRevision}</Typography>
                          <Stack direction="row" spacing={1}>
                            <Button size="small" onClick={() => dispatch(selectDraft(item.id))}>继续编辑</Button>
                            <Button size="small" color="error" onClick={() => dispatch(discardDraft(item.id))}>放弃</Button>
                          </Stack>
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

      <Dialog open={publishOpen} onClose={() => setPublishOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>发布草稿</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            草稿基于修订号 r{draft?.baseRevision ?? '-'}，发布后将成为修订号 r{publishedRevision + 1}。
          </Typography>
          <Divider sx={{ my: 1 }} />
          <Typography fontWeight={700} variant="body2">结构差异</Typography>
          <Typography variant="body2" color="text.secondary">
            新增 {diff.added.length} · 删除 {diff.removed.length} · 顺序调整 {diff.reordered ? '是' : '否'} · 新增规则 {diff.addedRules.length} · 删除规则 {diff.removedRules.length}
          </Typography>
          {ruleWarnings.length > 0 && (
            <Alert severity="warning" sx={{ mt: 1 }}>
              {ruleWarnings.map((warning) => <div key={warning}>· {warning}</div>)}
            </Alert>
          )}
          <Typography fontWeight={700} variant="body2" sx={{ mt: 2 }}>迁移待办预览</Typography>
          {todoPreview.length === 0
            ? <Typography variant="body2" color="text.secondary">历史快照均兼容，无需迁移。</Typography>
            : (
              <Stack spacing={1} mt={1}>
                {todoPreview.map((todo) => (
                  <Alert key={todo.id} severity="warning">
                    「{todo.snapshotLabel}」缺少必填字段：{todo.missingFieldLabels.join('、')}（来源 r{versions.find((v) => v.id === todo.sourceVersionId)?.revision ?? '-'}）
                  </Alert>
                ))}
              </Stack>
            )}
          <FormControlLabel sx={{ mt: 2 }} control={<Switch checked={failWrite} onChange={(event) => setFailWrite(event.target.checked)} />} label="模拟写入失败（验证回滚到上一个可用版本）" />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPublishOpen(false)}>取消</Button>
          <Button variant="contained" onClick={confirmPublish}>确认发布</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
