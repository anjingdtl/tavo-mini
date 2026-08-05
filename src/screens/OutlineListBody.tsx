/**
 * Outline management body (大纲创作模式升级).
 *
 * Rendered as the "大纲" tab inside ResourceLibrary for outline-mode projects.
 * Self-contained: loads its own list, manages enable/position/CRUD, and offers
 * TXT multi-file import + in-app editing. Outlines are a first-class resource
 * with their own table, so this component talks to the outline repository
 * directly rather than going through the polymorphic project_resources path.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { ChevronUp, ChevronDown, FileText, Plus, Upload, Trash2, Edit3, ArrowLeft } from 'lucide-react-native';
import { Button, Card, EmptyState, LoadingState, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';
import { importOutlinesFromTxt } from '../services/outlineImport';
import { estimateTokens } from '../utils/tokenEstimator';
import type { Outline } from '../types/outline';
import {
  deriveOutlineBudgetTokens,
  computeOutlineBudgetGuidance,
  type OutlineBudgetGuidance,
} from '../services/outlineContextBuilder';
import Toast from 'react-native-toast-message';

export const OutlineListBody: React.FC<{ projectId: number }> = ({ projectId }) => {
  const { theme } = useThemeStore();
  const [outlines, setOutlines] = useState<Outline[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Outline | 'new' | null>(null);
  const [contextWindow, setContextWindow] = useState(0);

  const loadOutlines = useCallback(async () => {
    try {
      const list = await db.getOutlinesByProject(projectId);
      setOutlines(list);
      // Fetch the active model's context window so the budget bar can show the
      // outline token budget. Failures (no LLM configured) leave it at 0,
      // which disables the over-budget warning rather than showing a false one.
      try {
        const llmConfig = await db.getActiveLLMConfig();
        setContextWindow(Number(llmConfig?.context_window) || 0);
      } catch {
        setContextWindow(0);
      }
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '加载大纲失败', text2: error?.message });
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    loadOutlines();
  }, [loadOutlines]);

  // Budget guidance for the top summary bar + per-item "suggested disable"
  // hint. Enabled outlines are taken in position order (same as the context
  // builder) so the suggested-disable set matches what the pipeline would
  // actually drop. Recomputed on every outlines/contextWindow change so the
  // bar stays live as the user toggles / reorders.
  const enabledGuidance: OutlineBudgetGuidance = useMemo(() => {
    const enabled = outlines.filter(o => o.enabled);
    const perTokens = enabled.map(o => estimateTokens(o.content || ''));
    const ids = enabled.map(o => o.id);
    const budget = deriveOutlineBudgetTokens(contextWindow);
    return computeOutlineBudgetGuidance(perTokens, ids, budget);
  }, [outlines, contextWindow]);

  const suggestedDisableSet = useMemo(
    () => new Set(enabledGuidance.suggestedDisableIds),
    [enabledGuidance],
  );

  const handleImportTxt = useCallback(async () => {
    try {
      const result = await importOutlinesFromTxt(projectId);
      if (!result) return; // user cancelled
      await loadOutlines();
      const parts: string[] = [];
      if (result.successCount > 0) parts.push(`成功导入 ${result.successCount} 份大纲`);
      if (result.failureCount > 0) parts.push(`${result.failureCount} 份失败`);
      Toast.show({
        type: result.failureCount > 0 ? 'error' : 'success',
        text1: parts.join('，') || '未导入任何大纲',
      });
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '导入失败', text2: error?.message });
    }
  }, [projectId, loadOutlines]);

  const handleToggleEnabled = useCallback(
    async (outline: Outline, value: boolean) => {
      // Optimistic update for responsiveness.
      setOutlines(prev =>
        prev.map(o => (o.id === outline.id ? { ...o, enabled: value } : o)),
      );
      try {
        await db.setOutlineEnabled(projectId, outline.id, value);
      } catch (error: any) {
        // Revert on failure.
        setOutlines(prev =>
          prev.map(o => (o.id === outline.id ? { ...o, enabled: !value } : o)),
        );
        Toast.show({ type: 'error', text1: '切换失败', text2: error?.message });
      }
    },
    [projectId],
  );

  const handleMove = useCallback(
    async (outline: Outline, direction: -1 | 1) => {
      const index = outlines.findIndex(o => o.id === outline.id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= outlines.length) return;
      const reordered = [...outlines];
      [reordered[index], reordered[targetIndex]] = [
        reordered[targetIndex],
        reordered[index],
      ];
      const orderedIds = reordered.map(o => o.id);
      // Optimistic reorder.
      setOutlines(prev => {
        const next = [...prev];
        const i = next.findIndex(o => o.id === outline.id);
        const t = i + direction;
        if (i < 0 || t < 0 || t >= next.length) return prev;
        [next[i], next[t]] = [next[t], next[i]];
        return next.map((o, idx) => ({ ...o, position: idx }));
      });
      try {
        await db.reorderOutlines(projectId, orderedIds);
      } catch (error: any) {
        await loadOutlines();
        Toast.show({ type: 'error', text1: '排序失败', text2: error?.message });
      }
    },
    [outlines, projectId, loadOutlines],
  );

  const handleDelete = useCallback(
    (outline: Outline) => {
      Alert.alert(
        '删除大纲',
        `确定删除「${outline.title || '未命名大纲'}」吗？此操作不可撤销。`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '删除',
            style: 'destructive',
            onPress: async () => {
              try {
                await db.deleteOutline(outline.id);
                await loadOutlines();
                Toast.show({ type: 'success', text1: '已删除大纲' });
              } catch (error: any) {
                Toast.show({ type: 'error', text1: '删除失败', text2: error?.message });
              }
            },
          },
        ],
      );
    },
    [loadOutlines],
  );

  const handleSaved = useCallback(() => {
    setEditing(null);
    loadOutlines();
  }, [loadOutlines]);

  if (editing) {
    return (
      <OutlineEditor
        projectId={projectId}
        outline={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={handleSaved}
      />
    );
  }

  if (loading) {
    return <LoadingState label="加载大纲..." />;
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={styles.scrollContent}
    >
      <View style={styles.actions}>
        <Button
          label="导入 TXT"
          onPress={handleImportTxt}
          icon={Upload}
          variant="secondary"
        />
        <Button
          label="新建大纲"
          onPress={() => setEditing('new')}
          icon={Plus}
        />
      </View>

      {/* Outline budget summary bar — only when at least one outline is
          enabled. Shows total enabled tokens vs the model-derived budget and
          turns red + suggests segmented enablement when over budget. */}
      {enabledGuidance.totalTokens > 0 ? (
        <View
          style={[
            styles.budgetBar,
            {
              backgroundColor: enabledGuidance.overBudget
                ? `${theme.colors.danger}1A`
                : theme.colors.accentSoft,
              borderColor: enabledGuidance.overBudget
                ? theme.colors.danger
                : theme.colors.border,
            },
          ]}
        >
          <Text
            style={[
              styles.budgetText,
              { color: enabledGuidance.overBudget ? theme.colors.danger : theme.colors.textPrimary },
            ]}
          >
            {enabledGuidance.overBudget
              ? `⚠ 已启用大纲超出预算：${enabledGuidance.totalTokens.toLocaleString()} / ${enabledGuidance.budgetTokens.toLocaleString()} tokens（超 ${enabledGuidance.overageTokens.toLocaleString()}）`
              : `已启用大纲：${enabledGuidance.totalTokens.toLocaleString()} / ${enabledGuidance.budgetTokens.toLocaleString()} tokens`}
          </Text>
          {enabledGuidance.overBudget ? (
            <Text style={[styles.budgetHint, { color: theme.colors.danger }]}>
              {enabledGuidance.suggestedDisableIds.length > 0
                ? `建议关闭靠后的 ${enabledGuidance.suggestedDisableIds.length} 份大纲（标记为"建议关闭"），或缩短内容，或更换更大上下文模型。`
                : '建议缩短内容，或更换更大上下文模型。'}
            </Text>
          ) : null}
        </View>
      ) : null}

      {outlines.length === 0 ? (
        <EmptyState
          title="还没有大纲"
          description="导入 TXT 文件或新建大纲，作为本项目的最高创作约束。新建和导入的大纲默认关闭，启用后才会注入生成上下文。"
        />
      ) : (
        <View style={styles.list}>
          {outlines.map((outline, index) => (
            <Card key={outline.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.titleRow}>
                  <FileText size={18} color={theme.colors.accent} />
                  <Text
                    style={[styles.title, { color: theme.colors.textPrimary }]}
                    numberOfLines={1}
                  >
                    {outline.title || '未命名大纲'}
                  </Text>
                </View>
                <Switch
                  value={outline.enabled}
                  onValueChange={value => handleToggleEnabled(outline, value)}
                  trackColor={{
                    false: theme.colors.border,
                    true: theme.colors.accent,
                  }}
                />
              </View>
              <View style={styles.metaRow}>
                <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
                  {outline.sourceType === 'txt' ? 'TXT 导入' : '手动创建'}
                  {outline.sourceFileName ? ` · ${outline.sourceFileName}` : ''}
                </Text>
                <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
                  {outline.estimatedTokens.toLocaleString()} tokens
                </Text>
                <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
                  顺序 {index + 1}
                </Text>
              </View>
              {outline.enabled && suggestedDisableSet.has(outline.id) ? (
                <View style={[styles.suggestBadge, { borderColor: theme.colors.danger }]}>
                  <Text style={[styles.suggestText, { color: theme.colors.danger }]}>
                    建议关闭：分段启用，关闭后剩余大纲可完整注入
                  </Text>
                </View>
              ) : null}
              <View style={styles.actionRow}>
                <TouchableOpacity
                  onPress={() => handleMove(outline, -1)}
                  disabled={index === 0}
                  style={[styles.iconBtn, index === 0 && styles.iconBtnDisabled]}
                >
                  <ChevronUp size={18} color={index === 0 ? theme.colors.border : theme.colors.textSecondary} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => handleMove(outline, 1)}
                  disabled={index === outlines.length - 1}
                  style={[styles.iconBtn, index === outlines.length - 1 && styles.iconBtnDisabled]}
                >
                  <ChevronDown size={18} color={index === outlines.length - 1 ? theme.colors.border : theme.colors.textSecondary} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setEditing(outline)}
                  style={styles.iconBtn}
                >
                  <Edit3 size={18} color={theme.colors.textSecondary} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => handleDelete(outline)}
                  style={styles.iconBtn}
                >
                  <Trash2 size={18} color={theme.colors.danger || '#dc2626'} />
                </TouchableOpacity>
              </View>
            </Card>
          ))}
        </View>
      )}
    </ScrollView>
  );
};

/** Inline outline editor for creating / editing a single outline. */
const OutlineEditor: React.FC<{
  projectId: number;
  outline: Outline | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ projectId, outline, onClose, onSaved }) => {
  const { theme } = useThemeStore();
  const [title, setTitle] = useState(outline?.title ?? '');
  const [content, setContent] = useState(outline?.content ?? '');
  const [enabled, setEnabled] = useState(outline?.enabled ?? false);
  const [saving, setSaving] = useState(false);

  const tokenEstimate = estimateTokens(content);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      if (outline) {
        await db.updateOutline(outline.id, { title, content });
        await db.setOutlineEnabled(projectId, outline.id, enabled);
      } else {
        const newId = await db.createOutline(projectId, {
          title,
          content,
          sourceType: 'manual',
        });
        await db.setOutlineEnabled(projectId, newId, enabled);
      }
      Toast.show({ type: 'success', text1: '已保存大纲' });
      onSaved();
    } catch (error: any) {
      Toast.show({ type: 'error', text1: '保存失败', text2: error?.message });
    } finally {
      setSaving(false);
    }
  }, [outline, projectId, title, content, enabled, onSaved]);

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.editorHeader}>
        <TouchableOpacity onPress={onClose} style={styles.backBtn}>
          <ArrowLeft size={20} color={theme.colors.textPrimary} />
          <Text style={[styles.backText, { color: theme.colors.textPrimary }]}>
            返回列表
          </Text>
        </TouchableOpacity>
      </View>

      <Card style={styles.editorCard}>
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
          标题
        </Text>
        <TextInput
          style={[styles.input, { color: theme.colors.textPrimary, borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}
          value={title}
          onChangeText={setTitle}
          placeholder="大纲标题"
          placeholderTextColor={theme.colors.textSecondary}
        />

        <View style={styles.contentHeader}>
          <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
            正文
          </Text>
          <Text style={[styles.tokenCount, { color: theme.colors.textSecondary }]}>
            {tokenEstimate.toLocaleString()} tokens
          </Text>
        </View>
        <TextInput
          style={[styles.contentInput, { color: theme.colors.textPrimary, borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}
          value={content}
          onChangeText={setContent}
          placeholder="在此输入或粘贴大纲内容..."
          placeholderTextColor={theme.colors.textSecondary}
          multiline
          textAlignVertical="top"
          autoFocus={!outline}
        />

        <View style={styles.enableRow}>
          <Text style={[styles.label, { color: theme.colors.textPrimary }]}>
            启用此大纲
          </Text>
          <Switch
            value={enabled}
            onValueChange={setEnabled}
            trackColor={{
              false: theme.colors.border,
              true: theme.colors.accent,
            }}
          />
        </View>
        <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
          只有启用的大纲才会注入生成上下文。多份启用的大纲按顺序合并，靠前的优先级更高。
        </Text>

        <Button
          label={saving ? '保存中...' : '保存'}
          onPress={handleSave}
          disabled={saving}
        />
      </Card>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  scrollContent: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  budgetBar: {
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.sm,
    marginBottom: spacing.md,
    gap: spacing.xs,
  },
  budgetText: {
    fontSize: 13,
    fontWeight: '600',
  },
  budgetHint: {
    fontSize: 12,
  },
  suggestBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    marginTop: spacing.xs,
    alignSelf: 'flex-start',
  },
  suggestText: {
    fontSize: 12,
    fontWeight: '600',
  },
  list: {
    gap: spacing.sm,
  },
  card: {
    padding: spacing.md,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flex: 1,
    marginRight: spacing.sm,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
  },
  metaRow: {
    flexDirection: 'row',
    gap: spacing.md,
    flexWrap: 'wrap',
    marginBottom: spacing.xs,
  },
  metaText: {
    fontSize: 12,
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  iconBtn: {
    padding: spacing.xs,
  },
  iconBtnDisabled: {
    opacity: 0.4,
  },
  editorHeader: {
    marginBottom: spacing.md,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  backText: {
    fontSize: 16,
  },
  editorCard: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.sm,
    fontSize: 16,
  },
  contentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  contentInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.sm,
    fontSize: 15,
    minHeight: 240,
  },
  tokenCount: {
    fontSize: 12,
  },
  enableRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  hint: {
    fontSize: 12,
    marginBottom: spacing.sm,
  },
});
