import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Plus, X } from 'lucide-react-native';
import { Button, Card, Field, spacing } from './ui';
import { useThemeStore } from '../store/themeStore';

// ---------------------------------------------------------------------------
// Simple debounce for serializing card to JSON
// 8.8 修复：_debounceTimer 从模块级改为实例级 useRef，避免多实例互相 clearTimeout
function debounceNotifyFactory(timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) {
  return (fn: () => void, ms = 300) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(fn, ms);
  };
}

// Types
// ---------------------------------------------------------------------------

interface CharacterEditorProps {
  dataJson: string;
  onChange: (dataJson: string) => void;
}

interface DialogueTurn {
  speaker: 'char' | 'user' | 'narrator';
  content: string;
}

interface DialogueGroup {
  turns: DialogueTurn[];
}

// ---------------------------------------------------------------------------
// JSON parse / serialize helpers
// ---------------------------------------------------------------------------

function safeParseCard(raw: string): { hasEnvelope: boolean; outer: Record<string, unknown>; data: Record<string, string | string[] | unknown> } | null {
  try {
    const outer = JSON.parse(raw || '{}');
    if (!outer || typeof outer !== 'object') return null;
    const hasEnvelope = Boolean(outer.data && typeof outer.data === 'object' && !Array.isArray(outer.data));
    const data = hasEnvelope ? outer.data : outer;
    return { hasEnvelope, outer, data: data as Record<string, any> };
  } catch {
    return null;
  }
}

function serializeCard(hasEnvelope: boolean, outer: Record<string, unknown>, data: Record<string, unknown>): string {
  if (hasEnvelope) {
    const envelopeData =
      outer.data && typeof outer.data === 'object' && !Array.isArray(outer.data)
        ? (outer.data as Record<string, unknown>)
        : {};
    return JSON.stringify({ ...outer, data: { ...envelopeData, ...data } });
  }
  return JSON.stringify({ ...outer, ...data });
}

// ---------------------------------------------------------------------------
// mes_example parser / serializer
// ---------------------------------------------------------------------------

const SPEAKER_OPTIONS: { value: DialogueTurn['speaker']; label: string }[] = [
  { value: 'char', label: '角色' },
  { value: 'user', label: '用户' },
  { value: 'narrator', label: '旁白' },
];

function parseMesExample(text: string): DialogueGroup[] {
  if (!text?.trim()) return [{ turns: [] }];
  const blocks = text.split(/<START>/i).filter((b) => b.trim());
  if (blocks.length === 0) return [{ turns: [] }];

  return blocks.map((block) => {
    const turns: DialogueTurn[] = [];
    const lines = block.split('\n');
    let currentSpeaker: DialogueTurn['speaker'] | null = null;
    let currentContent: string[] = [];

    const flushTurn = () => {
      if (currentSpeaker !== null) {
        turns.push({ speaker: currentSpeaker, content: currentContent.join('\n').trim() });
      }
      currentSpeaker = null;
      currentContent = [];
    };

    for (const line of lines) {
      const charMatch = line.match(/^\s*\{\{char\}\}\s*[:：]\s*(.*)/i);
      const userMatch = line.match(/^\s*\{\{user\}\}\s*[:：]\s*(.*)/i);
      if (charMatch) {
        flushTurn();
        currentSpeaker = 'char';
        currentContent = [charMatch[1]];
      } else if (userMatch) {
        flushTurn();
        currentSpeaker = 'user';
        currentContent = [userMatch[1]];
      } else {
        currentContent.push(line);
      }
    }
    flushTurn();

    // Remove empty narrator turns at boundaries
    while (turns.length > 0 && turns[0].speaker === 'narrator' && !turns[0].content.trim()) turns.shift();
    while (turns.length > 0 && turns[turns.length - 1].speaker === 'narrator' && !turns[turns.length - 1].content.trim()) turns.pop();

    return { turns };
  });
}

function serializeMesExample(groups: DialogueGroup[]): string {
  const parts = groups.map((group) => {
    const lines = group.turns.map((turn) => {
      if (turn.speaker === 'char') return `{{char}}: ${turn.content}`;
      if (turn.speaker === 'user') return `{{user}}: ${turn.content}`;
      return turn.content;
    });
    return lines.join('\n');
  });
  return parts.filter((p) => p.trim()).join('\n<START>\n');
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const CharacterEditor: React.FC<CharacterEditorProps> = ({ dataJson, onChange }) => {
  const { theme } = useThemeStore();
  const [parseError, setParseError] = useState(false);
  const [fallbackJson, setFallbackJson] = useState(dataJson);

  // Stable parsed state
  const [hasEnvelope, setHasEnvelope] = useState(false);
  const [outerRef, setOuterRef] = useState<Record<string, unknown>>({});

  // Individual field states
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [personality, setPersonality] = useState('');
  const [scenario, setScenario] = useState('');
  const [firstMes, setFirstMes] = useState('');
  const [mesExample, setMesExample] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [postHistory, setPostHistory] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [alternateGreetings, setAlternateGreetings] = useState<string[]>([]);
  const [creator, setCreator] = useState('');
  const [version, setVersion] = useState('');
  const [tagInput, setTagInput] = useState('');

  // Dialogue groups for mes_example visual editor
  const [dialogueGroups, setDialogueGroups] = useState<DialogueGroup[]>([{ turns: [] }]);
  const [showRawDialogue, setShowRawDialogue] = useState(false);

  // Track the last dataJson we parsed from externally, to avoid re-parsing on our own onChange
  // 初始化为 null 而非 dataJson，确保首次 mount 时 useEffect 一定会执行解析
  const lastParsedJsonRef = useRef<string | null>(null);

  // Parse dataJson into fields only when it changes externally (not from our own emitChange)
  useEffect(() => {
    // Skip if this is a change we triggered ourselves
    if (lastParsedJsonRef.current === dataJson) return;
    lastParsedJsonRef.current = dataJson;

    const parsed = safeParseCard(dataJson);
    if (!parsed) {
      setParseError(true);
      setFallbackJson(dataJson);
      return;
    }
    setParseError(false);
    setHasEnvelope(parsed.hasEnvelope);
    setOuterRef(parsed.outer);
    const d = parsed.data;
    setName(String(d.name || ''));
    setDescription(String(d.description || ''));
    setPersonality(String(d.personality || ''));
    setScenario(String(d.scenario || ''));
    setFirstMes(String(d.first_mes || ''));
    const mesEx = String(d.mes_example || '');
    setMesExample(mesEx);
    setDialogueGroups(parseMesExample(mesEx));
    setSystemPrompt(String(d.system_prompt || ''));
    setPostHistory(String(d.post_history_instructions || ''));
    setTags(Array.isArray(d.tags) ? d.tags.map(String) : []);
    setAlternateGreetings(Array.isArray(d.alternate_greetings) ? d.alternate_greetings.map(String) : []);
    setCreator(String(d.creator || ''));
    setVersion(String(d.character_version || ''));
  }, [dataJson]);

  // Debounced serializer — collects latest field values and notifies parent
  // 8.8 修复：debounce timer 从模块级改为实例 useRef
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceNotify = debounceNotifyFactory(debounceTimerRef);
  const fieldsRef = useRef<Record<string, unknown>>({});
  const metaRef = useRef<{ hasEnvelope: boolean; outer: Record<string, unknown> }>({ hasEnvelope: false, outer: {} });

  // 8.1 修复 emitChange 闭包陷阱：每帧同步 fieldsRef.current 为最新字段值，
  // emitChange 仅合并 updates，不再从闭包读取可能过期的值
  fieldsRef.current = {
    name,
    description,
    personality,
    scenario,
    first_mes: firstMes,
    mes_example: mesExample,
    system_prompt: systemPrompt,
    post_history_instructions: postHistory,
    tags,
    alternate_greetings: alternateGreetings,
    creator,
    character_version: version,
  };
  metaRef.current = { hasEnvelope, outer: outerRef };

  const emitChange = useCallback(
    (updates: Partial<Record<string, unknown>>) => {
      // 仅合并 updates，fieldsRef 已在每帧同步为最新值
      Object.assign(fieldsRef.current, updates);
      const capturedFields = { ...fieldsRef.current };
      const capturedMeta = { ...metaRef.current };

      debounceNotify(() => {
        const json = serializeCard(capturedMeta.hasEnvelope, capturedMeta.outer, capturedFields);
        lastParsedJsonRef.current = json;
        onChange(json);
      });
    },
    // 依赖 onChange + debounceNotify（现在 debounceNotify 每帧重建，但引用稳定因 debounceNotifyFactory 闭包）
    [onChange, debounceNotify],
  );

  // Field update helpers
  const updateField = useCallback(
    (field: string, value: unknown) => emitChange({ [field]: value }),
    [emitChange],
  );

  // Dialogue group helpers
  const updateDialogueFromVisual = useCallback(
    (groups: DialogueGroup[]) => {
      setDialogueGroups(groups);
      const text = serializeMesExample(groups);
      setMesExample(text);
      emitChange({ mes_example: text });
    },
    [emitChange],
  );

  // If JSON parse failed, show raw fallback editor
  if (parseError) {
    return (
      <View>
        <Text style={[styles.warnText, { color: theme.colors.danger }]}>
          JSON 解析失败，显示原始编辑模式
        </Text>
        <Field
          label="角色卡 JSON"
          value={fallbackJson}
          onChangeText={(text) => {
            setFallbackJson(text);
            onChange(text);
          }}
          multiline
          inputStyle={styles.largeInput}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* 基本信息 */}
      <SectionTitle theme={theme}>基本信息</SectionTitle>
      <Field label="角色名称（{{char}}）" value={name} onChangeText={(v) => { setName(v); updateField('name', v); }} />

      {/* 角色描述 */}
      <SectionTitle theme={theme}>角色描述</SectionTitle>
      <Field label="外貌、背景、身份等" value={description} onChangeText={(v) => { setDescription(v); updateField('description', v); }} multiline inputStyle={styles.largeInput} />

      {/* 性格 */}
      <SectionTitle theme={theme}>性格</SectionTitle>
      <Field label="性格特征、行为倾向" value={personality} onChangeText={(v) => { setPersonality(v); updateField('personality', v); }} multiline inputStyle={styles.mediumInput} />

      {/* 场景 */}
      <SectionTitle theme={theme}>场景</SectionTitle>
      <Field label="故事背景、环境设定" value={scenario} onChangeText={(v) => { setScenario(v); updateField('scenario', v); }} multiline inputStyle={styles.mediumInput} />

      {/* 第一条消息 */}
      <SectionTitle theme={theme}>第一条消息</SectionTitle>
      <Field label="角色开场白（first_mes）" value={firstMes} onChangeText={(v) => { setFirstMes(v); updateField('first_mes', v); }} multiline inputStyle={styles.largeInput} />

      {/* 替代问候 */}
      <SectionTitle theme={theme}>替代问候</SectionTitle>
      {alternateGreetings.map((greeting, gi) => (
        <Card key={gi} style={styles.greetingCard}>
          <View style={styles.greetingRow}>
            <Text style={[styles.greetingIndex, { color: theme.colors.textSecondary }]}>#{gi + 1}</Text>
            <TouchableOpacity onPress={() => {
              const next = alternateGreetings.filter((_, i) => i !== gi);
              setAlternateGreetings(next);
              updateField('alternate_greetings', next);
            }}>
              <X size={16} color={theme.colors.danger} />
            </TouchableOpacity>
          </View>
          <TextInput
            value={greeting}
            onChangeText={(v) => {
              const next = [...alternateGreetings];
              next[gi] = v;
              setAlternateGreetings(next);
              updateField('alternate_greetings', next);
            }}
            multiline
            style={[styles.greetingInput, { backgroundColor: theme.colors.card, borderColor: theme.colors.border, color: theme.colors.textPrimary }]}
            placeholderTextColor={theme.colors.textMuted}
          />
        </Card>
      ))}
      <Button label="添加替代问候" icon={Plus} variant="secondary" compact onPress={() => {
        const next = [...alternateGreetings, ''];
        setAlternateGreetings(next);
        updateField('alternate_greetings', next);
      }} />

      {/* 对话示例 */}
      <SectionTitle theme={theme}>对话示例</SectionTitle>
      <View style={styles.toggleRow}>
        <TouchableOpacity
          onPress={() => {
            // 8.9 修复：切换到可视化时重新 parse mesExample，避免显示旧对话组
            setShowRawDialogue(false);
            setDialogueGroups(parseMesExample(mesExample));
          }}
          style={[styles.toggleBtn, !showRawDialogue && styles.activeTab, !showRawDialogue && { borderBottomColor: theme.colors.accent }]}
        >
          <Text style={[styles.toggleText, { color: !showRawDialogue ? theme.colors.accent : theme.colors.textSecondary }]}>可视化</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setShowRawDialogue(true)} style={[styles.toggleBtn, showRawDialogue && styles.activeTab, showRawDialogue && { borderBottomColor: theme.colors.accent }]}>
          <Text style={[styles.toggleText, { color: showRawDialogue ? theme.colors.accent : theme.colors.textSecondary }]}>纯文本</Text>
        </TouchableOpacity>
      </View>

      {showRawDialogue ? (
        <Field
          label="mes_example"
          value={mesExample}
          onChangeText={(v) => { setMesExample(v); setDialogueGroups(parseMesExample(v)); updateField('mes_example', v); }}
          multiline
          inputStyle={styles.largeInput}
        />
      ) : (
        <DialogueEditor groups={dialogueGroups} onChange={updateDialogueFromVisual} theme={theme} />
      )}

      {/* 系统提示词 */}
      <SectionTitle theme={theme}>系统提示词</SectionTitle>
      <Field label="system_prompt" value={systemPrompt} onChangeText={(v) => { setSystemPrompt(v); updateField('system_prompt', v); }} multiline inputStyle={styles.largeInput} />

      {/* 后置指令 */}
      <SectionTitle theme={theme}>后置指令</SectionTitle>
      <Field label="post_history_instructions" value={postHistory} onChangeText={(v) => { setPostHistory(v); updateField('post_history_instructions', v); }} multiline inputStyle={styles.mediumInput} />

      {/* 标签 */}
      <SectionTitle theme={theme}>标签</SectionTitle>
      <View style={styles.tagsContainer}>
        {tags.map((tag, ti) => (
          <View key={ti} style={[styles.tagPill, { backgroundColor: theme.colors.accentSoft }]}>
            <Text style={[styles.tagText, { color: theme.colors.accent }]}>{tag}</Text>
            <TouchableOpacity onPress={() => {
              const next = tags.filter((_, i) => i !== ti);
              setTags(next);
              updateField('tags', next);
            }}>
              <X size={12} color={theme.colors.accent} />
            </TouchableOpacity>
          </View>
        ))}
      </View>
      <View style={styles.tagInputRow}>
        <TextInput
          value={tagInput}
          onChangeText={setTagInput}
          onSubmitEditing={() => {
            const val = tagInput.trim();
            if (val && !tags.includes(val)) {
              const next = [...tags, val];
              setTags(next);
              updateField('tags', next);
            }
            setTagInput('');
          }}
          placeholder="输入标签后回车添加"
          placeholderTextColor={theme.colors.textMuted}
          style={[styles.tagTextInput, { backgroundColor: theme.colors.card, borderColor: theme.colors.border, color: theme.colors.textPrimary }]}
          returnKeyType="done"
        />
      </View>

      {/* 元信息 */}
      <SectionTitle theme={theme}>元信息</SectionTitle>
      <Field label="创作者" value={creator} onChangeText={(v) => { setCreator(v); updateField('creator', v); }} />
      <Field label="角色版本" value={version} onChangeText={(v) => { setVersion(v); updateField('character_version', v); }} />
    </View>
  );
};

// ---------------------------------------------------------------------------
// Section Title
// ---------------------------------------------------------------------------

function SectionTitle({ theme, children }: { theme: any; children: React.ReactNode }) {
  return <Text style={[styles.sectionTitle, { color: theme.colors.accent }]}>{children}</Text>;
}

// ---------------------------------------------------------------------------
// Dialogue Editor
// ---------------------------------------------------------------------------

function DialogueEditor({ groups, onChange, theme }: { groups: DialogueGroup[]; onChange: (g: DialogueGroup[]) => void; theme: any }) {
  const updateGroup = (gi: number, group: DialogueGroup) => {
    const next = [...groups];
    next[gi] = group;
    onChange(next);
  };

  const removeGroup = (gi: number) => {
    if (groups.length <= 1) return;
    onChange(groups.filter((_, i) => i !== gi));
  };

  return (
    <View style={styles.dialogueContainer}>
      {groups.map((group, gi) => (
        <Card key={gi} style={styles.dialogueCard}>
          <View style={styles.dialogueGroupHeader}>
            <Text style={[styles.dialogueGroupLabel, { color: theme.colors.textSecondary }]}>
              对话组 #{gi + 1}
            </Text>
            {groups.length > 1 && (
              <TouchableOpacity onPress={() => removeGroup(gi)}>
                <X size={16} color={theme.colors.danger} />
              </TouchableOpacity>
            )}
          </View>

          {group.turns.map((turn, ti) => (
            <View key={ti} style={styles.turnRow}>
              <View style={styles.speakerSelector}>
                {SPEAKER_OPTIONS.map((opt) => {
                  const active = turn.speaker === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      onPress={() => {
                        const turns = [...group.turns];
                        turns[ti] = { ...turn, speaker: opt.value };
                        updateGroup(gi, { ...group, turns });
                      }}
                      style={[styles.speakerBtn, active && { backgroundColor: theme.colors.accentSoft }]}
                    >
                      <Text style={[styles.speakerBtnText, { color: active ? theme.colors.accent : theme.colors.textSecondary }]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View style={styles.turnContentRow}>
                <TextInput
                  value={turn.content}
                  onChangeText={(v) => {
                    const turns = [...group.turns];
                    turns[ti] = { ...turn, content: v };
                    updateGroup(gi, { ...group, turns });
                  }}
                  multiline
                  placeholder="对话内容..."
                  placeholderTextColor={theme.colors.textMuted}
                  style={[
                    styles.turnInput,
                    { backgroundColor: theme.colors.card, borderColor: theme.colors.border, color: theme.colors.textPrimary },
                  ]}
                />
                <TouchableOpacity onPress={() => {
                  const turns = group.turns.filter((_, i) => i !== ti);
                  updateGroup(gi, { ...group, turns });
                }}>
                  <X size={14} color={theme.colors.textMuted} />
                </TouchableOpacity>
              </View>
            </View>
          ))}

          <Button
            label="添加轮次"
            icon={Plus}
            variant="ghost"
            compact
            onPress={() => {
              updateGroup(gi, { ...group, turns: [...group.turns, { speaker: 'char', content: '' }] });
            }}
          />
        </Card>
      ))}

      <Button
        label="添加对话组"
        icon={Plus}
        variant="secondary"
        compact
        onPress={() => onChange([...groups, { turns: [] }])}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  warnText: { fontSize: 13, fontWeight: '700', marginBottom: spacing.md },
  largeInput: { minHeight: 140, textAlignVertical: 'top' },
  mediumInput: { minHeight: 80, textAlignVertical: 'top' },
  sectionTitle: { fontSize: 14, fontWeight: '800', marginTop: spacing.md, marginBottom: spacing.xs },
  // Dialogue
  toggleRow: { flexDirection: 'row', marginBottom: spacing.sm },
  toggleBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  activeTab: { borderBottomWidth: 2 },
  toggleText: { fontSize: 13, fontWeight: '700' },
  dialogueContainer: { gap: spacing.md },
  dialogueCard: { padding: spacing.sm },
  dialogueGroupHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  dialogueGroupLabel: { fontSize: 12, fontWeight: '700' },
  turnRow: { marginBottom: spacing.sm },
  speakerSelector: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.xs },
  speakerBtn: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: 6 },
  speakerBtnText: { fontSize: 12, fontWeight: '700' },
  turnContentRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.xs },
  turnInput: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, fontSize: 14, minHeight: 40, textAlignVertical: 'top' },
  // Greetings
  greetingCard: { padding: spacing.sm },
  greetingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  greetingIndex: { fontSize: 12, fontWeight: '700' },
  greetingInput: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, fontSize: 14, minHeight: 60, textAlignVertical: 'top' },
  // Tags
  tagsContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
  tagPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 14 },
  tagText: { fontSize: 13, fontWeight: '600' },
  tagInputRow: { flexDirection: 'row', gap: spacing.sm },
  tagTextInput: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 14 },
});
