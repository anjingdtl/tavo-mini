/**
 * 原著写作风格画像详情（Spec §10.1）。
 * 只读展示冻结 V2 画像字段，并支持编辑 userOverrides。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { useFocusEffect } from '@react-navigation/native';
import {
  Button,
  Card,
  Field,
  Header,
  Screen,
  spacing,
} from '../../components/ui';
import { useThemeStore } from '../../store/themeStore';
import {
  getStyleProfileById,
  saveStyleProfileUserOverrides,
  type ContinuationStyleProfileRow,
} from '../../services/continuation/styleProfile/styleProfileRepository';
import type { OriginalStyleProfileV2 } from '../../services/continuation/styleProfile/styleProfileV2Schema';

const STATE_LABELS: Record<ContinuationStyleProfileRow['state'], string> = {
  queued: '排队中',
  running: '分析中',
  ready: '就绪',
  failed: '失败',
  interrupted: '已中断',
  cancelled: '已取消',
  outdated: '已过期',
};

const REVIEW_LABELS: Record<
  ContinuationStyleProfileRow['reviewStatus'],
  string
> = {
  pending: '待确认',
  confirmed: '已确认',
  ignored: '已忽略',
};

function asProfile(json: Record<string, unknown>): OriginalStyleProfileV2 | null {
  if (!json || typeof json !== 'object') return null;
  if ((json as { schemaVersion?: number }).schemaVersion !== 2) return null;
  return json as unknown as OriginalStyleProfileV2;
}

function Section({
  title,
  lines,
  colorPrimary,
  colorSecondary,
}: {
  title: string;
  lines: Array<string | false | null | undefined>;
  colorPrimary: string;
  colorSecondary: string;
}) {
  const filtered = lines.filter((line): line is string => Boolean(line));
  if (!filtered.length) return null;
  return (
    <Card style={styles.card}>
      <Text style={[styles.sectionTitle, { color: colorPrimary }]}>{title}</Text>
      {filtered.map((line, i) => (
        <Text key={`${title}-${i}`} style={{ color: colorSecondary, lineHeight: 20 }}>
          {line}
        </Text>
      ))}
    </Card>
  );
}

export const StyleProfileDetailScreen: React.FC<{
  route: { params: { profileId: string } };
  navigation: { goBack: () => void };
}> = ({ route, navigation }) => {
  const { theme } = useThemeStore();
  const profileId = route.params.profileId;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [row, setRow] = useState<ContinuationStyleProfileRow | null>(null);
  const [overrideNote, setOverrideNote] = useState('');
  const [overrideAvoid, setOverrideAvoid] = useState('');
  const [overrideTone, setOverrideTone] = useState('');

  const reload = useCallback(async () => {
    try {
      const next = await getStyleProfileById(profileId);
      setRow(next);
      const ov = (next?.userOverridesJson ?? {}) as Record<string, unknown>;
      setOverrideNote(typeof ov.note === 'string' ? ov.note : '');
      setOverrideAvoid(
        Array.isArray(ov.extraAvoid)
          ? (ov.extraAvoid as string[]).join('、')
          : typeof ov.extraAvoid === 'string'
          ? ov.extraAvoid
          : '',
      );
      setOverrideTone(typeof ov.toneHint === 'string' ? ov.toneHint : '');
    } catch (e: any) {
      Toast.show({
        type: 'error',
        text1: '加载风格画像失败',
        text2: e?.message,
      });
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void reload();
    }, [reload]),
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const profile = useMemo(
    () => (row ? asProfile(row.profileJson) : null),
    [row],
  );

  const saveOverrides = async () => {
    if (!row) return;
    setSaving(true);
    try {
      const next: Record<string, unknown> = {
        ...(row.userOverridesJson ?? {}),
      };
      if (overrideNote.trim()) next.note = overrideNote.trim();
      else delete next.note;
      if (overrideTone.trim()) next.toneHint = overrideTone.trim();
      else delete next.toneHint;
      const avoidList = overrideAvoid
        .split(/[、,，;；\n]/)
        .map(s => s.trim())
        .filter(Boolean);
      if (avoidList.length) next.extraAvoid = avoidList;
      else delete next.extraAvoid;
      await saveStyleProfileUserOverrides(row.id, next);
      Toast.show({ type: 'success', text1: '用户修正已保存' });
      await reload();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '保存失败', text2: e?.message });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <Header
          title="风格画像"
          action={
            <Button
              label="返回"
              variant="ghost"
              onPress={() => navigation.goBack()}
            />
          }
        />
        <ActivityIndicator color={theme.colors.accent} style={{ marginTop: 24 }} />
      </Screen>
    );
  }

  if (!row) {
    return (
      <Screen>
        <Header
          title="风格画像"
          action={
            <Button
              label="返回"
              variant="ghost"
              onPress={() => navigation.goBack()}
            />
          }
        />
        <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
          画像不存在或已被清理。
        </Text>
      </Screen>
    );
  }

  const g = profile?.global;
  const primary = theme.colors.textPrimary;
  const secondary = theme.colors.textSecondary;

  return (
    <Screen>
      <Header
        title="原著写作风格"
        subtitle={`${STATE_LABELS[row.state]} · ${REVIEW_LABELS[row.reviewStatus]}`}
        action={
          <Button
            label="返回"
            variant="ghost"
            onPress={() => navigation.goBack()}
          />
        }
      />
      <ScrollView contentContainerStyle={styles.body}>
        <Card style={styles.card}>
          <Text style={[styles.sectionTitle, { color: primary }]}>概览</Text>
          <Text style={{ color: secondary }}>
            置信度 {Math.round((row.confidence || 0) * 100)}% · 分析器{' '}
            {row.analyzerVersion}
          </Text>
          <Text style={{ color: secondary }}>
            边界：第 {row.boundaryPosition + 1} 章 · 偏移{' '}
            {row.boundaryCharOffsetExclusive}
          </Text>
          <Text style={{ color: secondary }}>
            更新时间 {row.updatedAt}
            {row.completedAt ? ` · 完成 ${row.completedAt}` : ''}
          </Text>
          {profile?.summary ? (
            <Text style={{ color: primary, marginTop: spacing.xs, lineHeight: 22 }}>
              {profile.summary}
            </Text>
          ) : null}
          {row.errorMessage ? (
            <Text style={{ color: theme.colors.danger, marginTop: spacing.xs }}>
              {row.errorMessage}
            </Text>
          ) : null}
        </Card>

        <Section
          title="叙事与人称"
          colorPrimary={primary}
          colorSecondary={secondary}
          lines={[
            g?.narrative.person && `人称：${g.narrative.person}`,
            g?.narrative.focalization && `视角：${g.narrative.focalization}`,
            g?.narrative.narrativeDistance &&
              `叙事距离：${g.narrative.narrativeDistance}`,
            g?.narrative.tenseAndTimeHandling &&
              `时态：${g.narrative.tenseAndTimeHandling}`,
            ...(g?.narrative.perspectiveSwitchRules ?? []).map(
              r => `视角切换：${r}`,
            ),
          ]}
        />

        <Section
          title="句法与节奏"
          colorPrimary={primary}
          colorSecondary={secondary}
          lines={[
            g?.syntax.sentenceLengthPattern &&
              `句长：${g.syntax.sentenceLengthPattern}`,
            g?.syntax.paragraphPattern && `段落：${g.syntax.paragraphPattern}`,
            ...(g?.syntax.sentenceStructures ?? []).map(s => `句式：${s}`),
            ...(g?.syntax.punctuationHabits ?? []).map(s => `标点：${s}`),
            g?.rhythm.scenePacing && `场景节奏：${g.rhythm.scenePacing}`,
            g?.rhythm.expositionDensity &&
              `说明密度：${g.rhythm.expositionDensity}`,
            ...(g?.rhythm.transitionMethods ?? []).map(s => `过渡：${s}`),
            ...(g?.rhythm.chapterEndingPatterns ?? []).map(s => `章末：${s}`),
          ]}
        />

        <Section
          title="用词与语气"
          colorPrimary={primary}
          colorSecondary={secondary}
          lines={[
            g?.diction.register && `语域：${g.diction.register}`,
            g?.diction.concreteness && `具象度：${g.diction.concreteness}`,
            g?.tone.baseline && `基调：${g.tone.baseline}`,
            g?.tone.emotionalAmplitude &&
              `情绪幅度：${g.tone.emotionalAmplitude}`,
            g?.tone.humorAndRestraint &&
              `幽默与克制：${g.tone.humorAndRestraint}`,
            ...(g?.diction.lexicalPreferences ?? []).map(s => `偏好：${s}`),
            ...(g?.diction.expressionsToAvoid ?? []).map(s => `避免：${s}`),
          ]}
        />

        <Section
          title="描写与对话"
          colorPrimary={primary}
          colorSecondary={secondary}
          lines={[
            g?.description.environmentUsage &&
              `环境：${g.description.environmentUsage}`,
            g?.description.actionVsInteriorBalance &&
              `动作/内心：${g.description.actionVsInteriorBalance}`,
            ...(g?.description.sensoryPriorities ?? []).map(s => `感官：${s}`),
            g?.dialogue.dialogueDensity &&
              `对话密度：${g.dialogue.dialogueDensity}`,
            g?.dialogue.turnLength && `对白长度：${g.dialogue.turnLength}`,
            g?.dialogue.attributionStyle &&
              `说话标注：${g.dialogue.attributionStyle}`,
            g?.dialogue.subtextStyle && `潜台词：${g.dialogue.subtextStyle}`,
            ...(g?.dialogue.expositionAvoidance ?? []).map(
              s => `对话禁忌：${s}`,
            ),
          ]}
        />

        <Section
          title="边界附近风格增量"
          colorPrimary={primary}
          colorSecondary={secondary}
          lines={[
            profile?.boundaryLocalDelta.tone &&
              `语气：${profile.boundaryLocalDelta.tone}`,
            profile?.boundaryLocalDelta.pacing &&
              `节奏：${profile.boundaryLocalDelta.pacing}`,
            profile?.boundaryLocalDelta.sentenceAndParagraphShift &&
              `句段变化：${profile.boundaryLocalDelta.sentenceAndParagraphShift}`,
            ...(profile?.boundaryLocalDelta.activeNarrativePatterns ?? []).map(
              s => `活跃模式：${s}`,
            ),
          ]}
        />

        <Section
          title="场景变体"
          colorPrimary={primary}
          colorSecondary={secondary}
          lines={(profile?.sceneVariants ?? []).flatMap(v => [
            `【${v.sceneType}】置信 ${Math.round((v.confidence || 0) * 100)}%`,
            ...v.instructions.map(i => `· ${i}`),
            ...v.avoid.map(a => `× ${a}`),
          ])}
        />

        <Section
          title="人物口吻"
          colorPrimary={primary}
          colorSecondary={secondary}
          lines={(profile?.characterVoices ?? []).flatMap(v => [
            `【${v.sourceName}】${v.speechRegister} · 置信 ${Math.round(
              (v.confidence || 0) * 100,
            )}%`,
            ...v.sentenceHabits.map(h => `句式：${h}`),
            ...v.interactionHabits.map(h => `互动：${h}`),
            ...v.avoid.map(a => `避免：${a}`),
          ])}
        />

        <Section
          title="全书禁忌"
          colorPrimary={primary}
          colorSecondary={secondary}
          lines={(profile?.globalAvoid ?? []).map(a => `× ${a}`)}
        />

        <Card style={styles.card}>
          <Text style={[styles.sectionTitle, { color: primary }]}>
            用户修正
          </Text>
          <Text style={[styles.hint, { color: secondary }]}>
            修正会覆盖自动画像中的对应提示；重新分析风格时会保留这些字段。
          </Text>
          <Field
            label="补充说明"
            value={overrideNote}
            onChangeText={setOverrideNote}
            multiline
            placeholder="例如：少用感叹号，保持冷峻"
          />
          <Field
            label="语气提示"
            value={overrideTone}
            onChangeText={setOverrideTone}
            placeholder="例如：更克制"
          />
          <Field
            label="额外避免（顿号分隔）"
            value={overrideAvoid}
            onChangeText={setOverrideAvoid}
            placeholder="例如：系统面板、突然觉醒"
          />
          <Button
            label={saving ? '保存中…' : '保存用户修正'}
            onPress={() => {
              void saveOverrides();
            }}
            disabled={saving}
          />
        </Card>
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  body: { padding: spacing.md, paddingBottom: spacing.xl * 2, gap: spacing.sm },
  card: { marginBottom: spacing.sm, gap: spacing.xs },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginBottom: spacing.xs },
  hint: { fontSize: 13, lineHeight: 18, marginBottom: spacing.sm },
});
