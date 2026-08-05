import React, { useCallback, useState } from 'react';
import {
  Alert,
  FlatList,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Toast from 'react-native-toast-message';
import {
  Button,
  Card,
  Header,
  LoadingState,
  Screen,
  spacing,
} from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import appVersionJson from '../constants/version.json';
import {
  scanRecallSources,
  applyRecall,
  RECALL_TABLE_DISPLAY,
  type RecallScanReport,
  type BackupSourceFinding,
  type RecallResult,
  type RecallTable,
} from '../services/recall/dataRecallService';

type Phase = 'idle' | 'scanning' | 'scanError' | 'preview' | 'merging' | 'result';

/** 把 recoverable map 格式化成可读字符串（只列 >0 的非关联主表）。 */
function formatRecoverable(recoverable: Record<RecallTable, number>): string {
  const parts: string[] = [];
  for (const [table, count] of Object.entries(recoverable)) {
    const t = table as RecallTable;
    if (RECALL_TABLE_DISPLAY[t].isLink) continue;
    if (count > 0) parts.push(`${RECALL_TABLE_DISPLAY[t].label} +${count}`);
  }
  return parts.length > 0 ? `可召回：${parts.join('  ')}` : '无可召回的新数据';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 健壮地从任意 thrown 值提取可读消息（Error / string / {message} / 其他）。 */
function extractErrorMessage(e: unknown): string {
  if (e == null) return '未知错误';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message || e.toString();
  if (typeof e === 'object' && 'message' in e) {
    const m = (e as any).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

interface Props {
  onClose?: () => void;
}

export const RecallScreen: React.FC<Props> = ({ onClose }) => {
  const navigation = useNavigation();
  const handleClose = onClose || (() => navigation.goBack());
  const { theme } = useThemeStore();

  const [phase, setPhase] = useState<Phase>('idle');
  const [report, setReport] = useState<RecallScanReport | null>(null);
  const [result, setResult] = useState<RecallResult | null>(null);
  const [repairDrift, setRepairDrift] = useState(true);
  const [scanError, setScanError] = useState('');
  const [selectedSources, setSelectedSources] = useState<Set<string>>(
    new Set(),
  );

  const handleScan = useCallback(async () => {
    setPhase('scanning');
    try {
      const r = await scanRecallSources();
      setReport(r);
      // 默认勾选：漂移需修复 + 有可召回量的源
      setRepairDrift(r.currentDb.schemaDrift.needsRepair);
      const defaultSelected = new Set<string>();
      for (const s of r.sources) {
        if (!s.valid) continue;
        const hasRecoverable = Object.values(s.recoverable).some(c => c > 0);
        if (hasRecoverable) defaultSelected.add(s.filePath);
      }
      setSelectedSources(defaultSelected);
      setPhase('preview');
    } catch (e: any) {
      const msg = extractErrorMessage(e);
      Toast.show({ type: 'error', text1: '扫描失败', text2: msg });
      setScanError(msg);
      setPhase('scanError');
    }
  }, []);

  const toggleSource = (filePath: string) => {
    setSelectedSources(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const handleApply = useCallback(async () => {
    if (!repairDrift && selectedSources.size === 0) {
      Toast.show({ type: 'info', text1: '请至少选择一项召回操作' });
      return;
    }
    Alert.alert(
      '确认召回',
      '执行前会自动创建一份恢复备份。本操作不会删除任何现有数据，只会补回缺失的行。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '执行召回',
          onPress: async () => {
            setPhase('merging');
            try {
              const r = await applyRecall({
                repairCurrentDbDrift: repairDrift,
                sourceFilePaths: Array.from(selectedSources),
              });
              setResult(r);
              setPhase('result');
            } catch (e: any) {
              Alert.alert('召回失败', extractErrorMessage(e));
              setPhase('preview');
            }
          },
        },
      ],
    );
  }, [repairDrift, selectedSources]);

  const canApply = repairDrift || selectedSources.size > 0;

  // ===== 入口态 =====
  if (phase === 'idle' || phase === 'scanError') {
    return (
      <Screen>
        <Header
          title="召回潜在数据"
          subtitle="找回因升级或结构问题无法显示的资料"
          action={<Button label="关闭" variant="ghost" compact onPress={handleClose} />}
        />
        <View style={styles.body}>
          <View style={[styles.noticeCard, { backgroundColor: theme.colors.surface }]}>
            <Text style={[styles.noticeTitle, { color: theme.colors.textPrimary }]}>
              召回潜在数据
            </Text>
            <Text style={[styles.versionTag, { color: theme.colors.textMuted }]}>
              {appVersionJson.versionName}
            </Text>
            <Text style={[styles.noticeText, { color: theme.colors.textSecondary }]}>
              扫描当前数据库与历史备份，把因版本升级、结构漂移等原因无法正常显示的资料重新找回并合并到当前库。{'\n\n'}
              本操作不会删除任何现有数据，执行前会自动创建恢复备份。
            </Text>
            {phase === 'scanError' && scanError ? (
              <View style={[styles.errorBox, { borderColor: theme.colors.danger }]}>
                <Text style={[styles.errorText, { color: theme.colors.danger }]}>
                  {scanError}
                </Text>
              </View>
            ) : null}
          </View>
          <Button
            label={phase === 'scanError' ? '重新扫描' : '开始扫描'}
            onPress={handleScan}
            flex
          />
        </View>
      </Screen>
    );
  }

  // ===== 扫描中 =====
  if (phase === 'scanning') {
    return (
      <Screen>
        <Header title="召回潜在数据" action={<Button label="关闭" variant="ghost" compact onPress={handleClose} />} />
        <LoadingState label="正在扫描当前库与备份源..." />
      </Screen>
    );
  }

  // ===== 合并中 =====
  if (phase === 'merging') {
    return (
      <Screen>
        <Header title="召回潜在数据" action={<Button label="关闭" variant="ghost" compact onPress={handleClose} />} />
        <LoadingState label="正在执行召回（创建恢复备份→修复/合并→校验）...请勿关闭应用" />
      </Screen>
    );
  }

  // ===== 结果态 =====
  if (phase === 'result' && result) {
    const isFail = result.status === 'failed';
    const isPartial = result.status === 'partial';
    const accent = isFail
      ? theme.colors.danger
      : isPartial
        ? '#E0A030'
        : theme.colors.accent;
    return (
      <Screen>
        <Header title="召回潜在数据" action={<Button label="完成" variant="ghost" compact onPress={handleClose} />} />
        <ScrollView style={styles.body}>
          <View style={[styles.noticeCard, { backgroundColor: theme.colors.surface }]}>
            <Text style={[styles.noticeTitle, { color: accent }]}>
              {isFail ? '✗ 召回中止' : isPartial ? '⚠ 部分召回成功' : '✓ 召回完成'}
            </Text>
            <Text style={[styles.noticeText, { color: theme.colors.textSecondary }]}>
              恢复备份：{result.recoveryBackupPath.split('/').pop() || '—'}
            </Text>

            {result.driftRepairResult && (
              <Text style={[styles.noticeText, { color: theme.colors.textSecondary, marginTop: spacing.sm }]}>
                结构漂移：{result.driftRepairResult.ok ? '已修复' : '未成功'}
              </Text>
            )}

            {/* 召回明细 */}
            {Object.entries(result.applied).map(([table, r]) => {
              const t = table as RecallTable;
              if (RECALL_TABLE_DISPLAY[t].isLink) return null;
              if (r!.inserted === 0 && r!.skipped === 0) return null;
              return (
                <Text key={table} style={[styles.noticeText, { color: theme.colors.textSecondary }]}>
                  {RECALL_TABLE_DISPLAY[t].label}：+{r!.inserted}（跳过 {r!.skipped}）
                </Text>
              );
            })}

            {/* 前后对比 */}
            {!isFail && (
              <View style={{ marginTop: spacing.sm }}>
                <Text style={[styles.noticeText, { color: theme.colors.textMuted }]}>
                  合并前 → 合并后
                </Text>
                <Text style={[styles.noticeText, { color: theme.colors.textSecondary }]}>
                  角色卡：{result.beforeSnapshot.characters.count} → {result.afterSnapshot.characters.count}
                </Text>
                <Text style={[styles.noticeText, { color: theme.colors.textSecondary }]}>
                  世界书条目：{result.beforeSnapshot.worldbookEntries.count} → {result.afterSnapshot.worldbookEntries.count}
                </Text>
                <Text style={[styles.noticeText, { color: theme.colors.textSecondary }]}>
                  笔记：{result.beforeSnapshot.notes.count} → {result.afterSnapshot.notes.count}
                </Text>
              </View>
            )}

            {(isPartial || isFail) && result.error && (
              <Text style={[styles.noticeText, { color: theme.colors.danger, marginTop: spacing.sm }]}>
                {result.error.message}
              </Text>
            )}
            {result.recallMismatch && (
              <Text style={[styles.noticeText, { color: theme.colors.danger }]}>
                {result.recallMismatch.table}：{result.recallMismatch.reason}
              </Text>
            )}
          </View>
          <Button label="完成" onPress={handleClose} flex />
        </ScrollView>
      </Screen>
    );
  }

  // ===== 预览态 =====
  const dbInfo = report!.currentDb;
  return (
    <Screen>
      <Header
        title="召回潜在数据"
        subtitle="预览并选择要召回的数据"
        action={<Button label="关闭" variant="ghost" compact onPress={handleClose} />}
      />
      <FlatList
        data={report!.sources}
        keyExtractor={item => item.filePath}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View>
            {/* 区段 1：当前库诊断 */}
            <Card>
              <Text style={[styles.sectionTitle, { color: theme.colors.textPrimary }]}>
                当前库诊断
              </Text>
              {!dbInfo.reachable && (
                <View>
                  <Text style={[styles.warning, { color: theme.colors.danger }]}>
                    当前数据库存在结构漂移，部分资料暂时无法读取。
                  </Text>
                  {dbInfo.unreachableReason ? (
                    <Text style={[styles.warningDetail, { color: theme.colors.danger }]}>
                      原因：{dbInfo.unreachableReason}
                    </Text>
                  ) : null}
                  <Text style={[styles.warningHint, { color: theme.colors.textSecondary }]}>
                    你的资料可能仍在库里。点击下方"修复数据库结构漂移"尝试恢复读取。
                  </Text>
                </View>
              )}
              {dbInfo.schemaDrift.needsRepair && (
                <View style={[styles.switchRow, { borderColor: theme.colors.border }]}>
                  <View style={styles.switchTextWrap}>
                    <Text style={[styles.switchLabel, { color: theme.colors.textPrimary }]}>
                      修复数据库结构漂移
                    </Text>
                    <Text style={[styles.switchHint, { color: theme.colors.textMuted }]}>
                      修复已知 schema 漂移（canon_evidence 缺列等），修复后资料可能重新读取（推荐）
                    </Text>
                  </View>
                  <Switch
                    value={repairDrift}
                    onValueChange={setRepairDrift}
                    trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                  />
                </View>
              )}
              {/* 资料表行数 */}
              <View style={{ marginTop: spacing.sm }}>
                {(Object.entries(dbInfo.rowCount) as [RecallTable, number][])
                  .filter(([t]) => !RECALL_TABLE_DISPLAY[t].isLink)
                  .map(([table, count]) => (
                    <Text key={table} style={[styles.countRow, { color: theme.colors.textSecondary }]}>
                      {RECALL_TABLE_DISPLAY[table].label}：{count < 0 ? '读取失败' : count}
                    </Text>
                  ))}
              </View>
            </Card>

            {/* 区段 2 标题 */}
            <Text style={[styles.sectionTitle, { color: theme.colors.textPrimary, marginTop: spacing.md }]}>
              可召回的备份源
            </Text>
            {report!.sources.length === 0 && (
              <Text style={[styles.empty, { color: theme.colors.textSecondary }]}>
                未发现任何备份源（schema-recovery 目录与备份目录均为空）。
              </Text>
            )}
          </View>
        }
        ListFooterComponent={
          <View style={styles.footer}>
            <Text style={[styles.strategy, { color: theme.colors.textMuted }]}>
              合并策略：只补当前库缺失的行，已存在的相同主键将跳过。{'\n'}
              关联关系（项目-资源）将随对应资料一并恢复。
            </Text>
            <View style={styles.footerBtnRow}>
              <Button label="取消" variant="ghost" compact onPress={handleClose} />
              <Button
                label="执行召回"
                onPress={handleApply}
                disabled={!canApply}
              />
            </View>
          </View>
        }
        renderItem={({ item }) => (
          <SourceCard
            source={item}
            selected={selectedSources.has(item.filePath)}
            onToggle={() => toggleSource(item.filePath)}
            theme={theme}
          />
        )}
      />
    </Screen>
  );
};

const SourceCard: React.FC<{
  source: BackupSourceFinding;
  selected: boolean;
  onToggle: () => void;
  theme: any;
}> = ({ source, selected, onToggle, theme }) => {
  const fileName = source.filePath.split('/').pop() || source.filePath;
  const sourceLabel =
    source.sourceId === 'schema-recovery' ? '结构修复' : '用户备份';
  return (
    <Card>
      <View style={styles.row}>
        <Text style={[styles.fileName, { color: theme.colors.textPrimary }]} numberOfLines={1}>
          {fileName}
        </Text>
        <Text style={[styles.kindBadge, { color: theme.colors.accent }]}>
          {sourceLabel}
        </Text>
      </View>
      <View style={styles.metaRow}>
        <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
          {formatTime(source.createdAt)} · Schema {source.schemaVersion || '—'} · V{source.appVersion || '—'}
        </Text>
      </View>
      {!source.valid ? (
        <Text style={[styles.invalid, { color: theme.colors.danger }]}>
          备份无效或已损坏：{source.invalidReason}
        </Text>
      ) : (
        <>
          <Text style={[styles.recoverable, { color: theme.colors.textSecondary }]}>
            {formatRecoverable(source.recoverable)}
          </Text>
          <View style={[styles.switchRow, { borderColor: theme.colors.border, marginTop: spacing.sm }]}>
            <Text style={[styles.switchLabel, { color: theme.colors.textPrimary }]}>
              {selected ? '☑ 此源' : '☐ 此源'}
            </Text>
            <Switch
              value={selected}
              onValueChange={onToggle}
              disabled={!source.valid}
              trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
            />
          </View>
        </>
      )}
    </Card>
  );
};

const styles = StyleSheet.create({
  body: { padding: spacing.lg },
  noticeCard: { borderRadius: 8, padding: spacing.md, marginBottom: spacing.md },
  noticeTitle: { fontSize: 16, fontWeight: '700', marginBottom: spacing.xs },
  versionTag: { fontSize: 11, marginBottom: spacing.xs },
  noticeText: { fontSize: 13, lineHeight: 20, marginTop: spacing.xs },
  errorBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  errorText: { fontSize: 12, lineHeight: 17 },
  list: { padding: spacing.lg, paddingBottom: 120 },
  sectionTitle: { fontSize: 14, fontWeight: '700', marginBottom: spacing.sm },
  warning: { fontSize: 13, marginTop: spacing.xs },
  warningDetail: { fontSize: 11, marginTop: spacing.xs, lineHeight: 16 },
  warningHint: { fontSize: 12, marginTop: spacing.xs, lineHeight: 17 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
    marginTop: spacing.sm,
  },
  switchLabel: { fontSize: 14, fontWeight: '600' },
  switchTextWrap: { flex: 1 },
  switchHint: { fontSize: 12, marginTop: 2 },
  countRow: { fontSize: 13, lineHeight: 20 },
  empty: { fontSize: 13, paddingVertical: spacing.md, textAlign: 'center' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fileName: { fontSize: 13, fontWeight: '600', flex: 1, marginRight: spacing.sm },
  kindBadge: { fontSize: 12, fontWeight: '700' },
  metaRow: { flexDirection: 'row', marginTop: spacing.xs },
  meta: { fontSize: 12 },
  recoverable: { fontSize: 13, marginTop: spacing.xs },
  invalid: { fontSize: 12, fontWeight: '600', marginTop: spacing.xs },
  footer: { marginTop: spacing.md },
  strategy: { fontSize: 12, lineHeight: 18, marginBottom: spacing.sm },
  footerBtnRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
});
