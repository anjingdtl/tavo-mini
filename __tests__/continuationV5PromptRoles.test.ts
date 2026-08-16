import {
  compileContinuationV5AuditorMessages,
  compileContinuationV5DraftWriterMessages,
  compileContinuationV5FinalReviserMessages,
  compileContinuationV5RevisionWriterMessages,
  buildContinuationV5RevisionAnchors,
  buildContinuationV5EditWorkPacket,
  formatContinuationV5EditWorkPacket,
} from '../src/services/continuation/generation/continuationV5PromptCompiler';
import {
  buildFallbackArchitecture,
  buildFallbackAuditContract,
  hashArchitectureEnvelope,
  hashAuditEnvelope,
} from '../src/services/continuation/generation/continuationV5Contracts';

function baseView(overrides: Record<string, unknown> = {}) {
  return {
    stage: 'revision_writer' as const,
    projectId: 1,
    targetChapterId: 1,
    targetPosition: 0 as any,
    targetChapterChars: 5000,
    preferredMinHan: 4500,
    preferredMaxHan: 5500,
    severeUnderHan: 3250,
    userInstruction: '推进本章',
    lockedRules: [],
    canon: {
      hardFacts: [],
      softFacts: [],
      evidenceIds: [],
    },
    effectiveState: {
      characterStates: [],
      relationships: [],
      plotThreads: [],
      knowledge: [],
      experiences: [],
    },
    primaryAnchorSummary: '',
    primaryAnchorSeamText: '',
    recentBridgeSummary: '',
    style: {
      profileId: null,
      profileHash: null,
      rendererVersion: null,
      renderLevel: null,
      text: '',
      quantitative: {
        averageSentenceLength: 0,
        averageParagraphLength: 0,
        dialogueRatio: 0,
        descriptionRatio: 0,
        narrativePerson: '',
        tense: '',
      },
      omittedReason: null,
    },
    supplements: {
      text: '',
      selected: [],
      omitted: [],
      contentHashes: [],
      wrapper: '',
    },
    budget: {
      stage: 'revision_writer' as const,
      configId: 1,
      contextWindow: 128000,
      effectiveWindow: 120000,
      declaredMaxOutputTokens: 16000,
      compiledPromptTokens: 2000,
      protocolSkeletonTokens: 200,
      promptReserveTokens: 100,
      safetyReserveTokens: 100,
      hardContextTokens: 0,
      inputBudget: 100000,
      availableOutputTokens: 16000,
      demandTokens: 18000,
      minimumOutputTokens: 10000,
      maximumOutputTokens: 16000,
      targetChapterChars: 5000,
      pressure: 0.2,
      blockedReason: null,
    },
    snapshotRefs: {
      canonSnapshotId: 'cs',
      canonRevision: 1,
      inputRevisionHash: 'ir',
      styleProfileHash: null,
      styleRendererVersion: null,
    },
    ...overrides,
  };
}

describe('V5 prompt roles: V2 expands length, V3 polishes', () => {
  test('Auditor receives actual V2 as client-owned selectable anchors', () => {
    const architecture = buildFallbackArchitecture({ userInstruction: '推进' });
    const architectureHash = hashArchitectureEnvelope(architecture);
    const compiled = compileContinuationV5AuditorMessages({
      view: baseView({ stage: 'adversarial_auditor' }) as any,
      draftContent: 'V1 原始表达。',
      draftArtifactHash: 'd'.repeat(64),
      revisionContent: 'V2 待润色表达。',
      revisionArtifactHash: 'r'.repeat(64),
      revisionAnchors: buildContinuationV5RevisionAnchors('V2 待润色表达。'),
      architecture,
      architectureHash,
    });
    const system =
      compiled.messages.find(m => m.role === 'system')?.content ?? '';
    const user = compiled.messages.find(m => m.role === 'user')?.content ?? '';
    expect(system).toMatch(/V2 完成后/);
    expect(system).toMatch(/3–6 条/);
    expect(system).toMatch(/anchorId/);
    expect(user).toMatch(/完整 V2/);
    expect(user).toMatch(/V2 待润色表达/);
    expect(user).toMatch(/v2-p-001/);
    expect(user).toMatch(/revisionArtifactHash/);
  });

  test('V2 anchor builder keeps the exact paragraph text and offsets', () => {
    const content = '第一段。\n\n  第二段。  \n\n第三段。';
    expect(buildContinuationV5RevisionAnchors(content)).toEqual([
      { anchorId: 'v2-p-001', start: 0, end: 4, text: '第一段。' },
      { anchorId: 'v2-p-002', start: 8, end: 12, text: '第二段。' },
      { anchorId: 'v2-p-003', start: 16, end: 20, text: '第三段。' },
    ]);
  });

  test('V2 anchor builder normalizes CRLF input so offsets match LF baseline', () => {
    // Same prose as the LF case above, but with Windows CRLF line endings.
    // Offsets must match the LF result exactly (not be inflated by \r).
    const crlf = '第一段。\r\n\r\n  第二段。  \r\n\r\n第三段。';
    expect(buildContinuationV5RevisionAnchors(crlf)).toEqual([
      { anchorId: 'v2-p-001', start: 0, end: 4, text: '第一段。' },
      { anchorId: 'v2-p-002', start: 8, end: 12, text: '第二段。' },
      { anchorId: 'v2-p-003', start: 16, end: 20, text: '第三段。' },
    ]);
  });

  test('Revision Writer owns target band and forbids early stop under preferredMin', () => {
    const architecture = buildFallbackArchitecture({ userInstruction: '推进' });
    const architectureHash = hashArchitectureEnvelope(architecture);
    const compiled = compileContinuationV5RevisionWriterMessages({
      view: baseView({ stage: 'revision_writer' }) as any,
      draftContent: '初稿正文。',
      draftHan: 1800,
      draftArtifactHash: 'a'.repeat(64),
      architecture,
      architectureHash,
    });
    const system =
      compiled.messages.find(m => m.role === 'system')?.content ?? '';
    const user = compiled.messages.find(m => m.role === 'user')?.content ?? '';
    expect(system).toMatch(/主扩写稿/);
    expect(system).toMatch(/4500/);
    expect(system).toMatch(/5500/);
    expect(system).toMatch(/不得提前收束/);
    expect(system).toMatch(/V3 只做润色/);
    expect(user).toMatch(/篇幅自检/);
    expect(user).toMatch(/≥ 4500/);
  });

  test('Final Reviser is polish-first when V2 already in band', () => {
    const architecture = buildFallbackArchitecture({ userInstruction: '推进' });
    const architectureHash = hashArchitectureEnvelope(architecture);
    const audit = buildFallbackAuditContract({
      draftArtifactHash: 'd'.repeat(64),
      revisionArtifactHash: 'r'.repeat(64),
      architectureHash,
      canonSnapshotId: 'cs',
      canonRevision: 1,
      inputRevisionHash: 'ir',
      styleProfileHash: null,
      styleRendererVersion: null,
      lockedRules: [],
      hardCanonFacts: [],
    });
    const compiled = compileContinuationV5FinalReviserMessages({
      view: {
        ...baseView({ stage: 'final_reviser' }),
        budget: {
          ...baseView().budget,
          stage: 'final_reviser' as const,
        },
      } as any,
      revisionContent: '完整 V2。'.repeat(100),
      revisionHan: 4800,
      revisionArtifactHash: 'r'.repeat(64),
      architecture,
      architectureHash,
      audit,
      auditContractHash: hashAuditEnvelope(audit),
    });
    const system =
      compiled.messages.find(m => m.role === 'system')?.content ?? '';
    expect(system).toMatch(/润色与 C2 合同履约/);
    expect(system).toMatch(/不要把 V3 当成主要加长环节/);
    expect(system).toMatch(/真实 V2 编辑工作包/);
    expect(system).toMatch(/禁止以删词、改标点或只替换一两个近义词/);
    expect(system).toMatch(/已在目标区间内/);
    expect(system).toMatch(/±10%/);
  });

  test('Final Reviser must settle every obligation and preserve client hashes', () => {
    const architecture = buildFallbackArchitecture({ userInstruction: '推进' });
    const architectureHash = hashArchitectureEnvelope(architecture);
    const audit = buildFallbackAuditContract({
      draftArtifactHash: 'd'.repeat(64),
      revisionArtifactHash: 'r'.repeat(64),
      architectureHash,
      canonSnapshotId: 'cs',
      canonRevision: 1,
      inputRevisionHash: 'ir',
      styleProfileHash: null,
      styleRendererVersion: null,
      lockedRules: ['不得越界'],
      hardCanonFacts: [],
    });
    const compiled = compileContinuationV5FinalReviserMessages({
      view: {
        ...baseView({ stage: 'final_reviser' }),
        budget: {
          ...baseView().budget,
          stage: 'final_reviser' as const,
        },
      } as any,
      revisionContent: '完整 V2。'.repeat(100),
      revisionHan: 5000,
      revisionArtifactHash: 'r'.repeat(64),
      architecture,
      architectureHash,
      audit,
      auditContractHash: hashAuditEnvelope(audit),
    });
    const system =
      compiled.messages.find(m => m.role === 'system')?.content ?? '';
    const user = compiled.messages.find(m => m.role === 'user')?.content ?? '';
    expect(system).toMatch(/appliedObligationIds 与 unappliedItems 不得同时为空/);
    expect(user).toContain('fallback_user_rule_1');
    expect(user).toContain('revisionArtifactHash":"' + 'r'.repeat(64));
    expect(user).toMatch(/数组只能填写实际执行结果/);
  });

  test('Final Reviser allows length fallback only when V2 is still short', () => {
    const architecture = buildFallbackArchitecture({ userInstruction: '推进' });
    const architectureHash = hashArchitectureEnvelope(architecture);
    const audit = buildFallbackAuditContract({
      draftArtifactHash: 'd'.repeat(64),
      revisionArtifactHash: 'r'.repeat(64),
      architectureHash,
      canonSnapshotId: 'cs',
      canonRevision: 1,
      inputRevisionHash: 'ir',
      styleProfileHash: null,
      styleRendererVersion: null,
      lockedRules: [],
      hardCanonFacts: [],
    });
    const compiled = compileContinuationV5FinalReviserMessages({
      view: {
        ...baseView({ stage: 'final_reviser' }),
        budget: {
          ...baseView().budget,
          stage: 'final_reviser' as const,
        },
      } as any,
      revisionContent: '短 V2。',
      revisionHan: 2000,
      revisionArtifactHash: 'r'.repeat(64),
      architecture,
      architectureHash,
      audit,
      auditContractHash: hashAuditEnvelope(audit),
    });
    const system =
      compiled.messages.find(m => m.role === 'system')?.content ?? '';
    expect(system).toMatch(/仍低于首选下限/);
    expect(system).toMatch(/兜底补写/);
  });
});

describe('V5 edit work packet drives V3 polish', () => {
  function anchoredAudit() {
    const audit = buildFallbackAuditContract({
      draftArtifactHash: 'd'.repeat(64),
      revisionArtifactHash: 'r'.repeat(64),
      architectureHash: 'a'.repeat(64),
      canonSnapshotId: 'cs',
      canonRevision: 1,
      inputRevisionHash: 'ir',
      styleProfileHash: null,
      styleRendererVersion: null,
      lockedRules: [],
      hardCanonFacts: [],
    });
    // Inject two real anchored style corrections so the packet is non-empty.
    audit.styleAudit.requiredCorrections = [
      {
        requirementId: 'style_1',
        anchorId: 'v2-p-002',
        dimension: 'sentence_rhythm',
        severity: 'warning',
        confidence: 0.8,
        generatedStart: 8,
        generatedEnd: 12,
        generatedExcerpt: '真实 V2 第二段原句。',
        description: '节奏过平，长句堆叠。',
        styleEvidenceIds: [],
        rewriteGoal: '拆成短促动作与留白交替的段落。',
        preserveMeaning: ['门外的威胁', '主角选择迎击'],
      },
      {
        requirementId: 'style_2',
        anchorId: 'v2-p-005',
        dimension: 'dialogue_voice',
        severity: 'warning',
        confidence: 0.7,
        generatedStart: 60,
        generatedEnd: 90,
        generatedExcerpt: '真实 V2 第五段对白原句。',
        description: '对白过于书面。',
        styleEvidenceIds: [],
        rewriteGoal: '改为更口语化、带停顿的对白。',
        preserveMeaning: [],
      },
    ];
    return audit;
  }

  function legacyAnchorlessAudit() {
    const audit = buildFallbackAuditContract({
      draftArtifactHash: 'd'.repeat(64),
      revisionArtifactHash: 'r'.repeat(64),
      architectureHash: 'a'.repeat(64),
      canonSnapshotId: 'cs',
      canonRevision: 1,
      inputRevisionHash: 'ir',
      styleProfileHash: null,
      styleRendererVersion: null,
      lockedRules: [],
      hardCanonFacts: [],
    });
    // Legacy contract: anchorId null on every style correction.
    audit.styleAudit.requiredCorrections = [
      {
        requirementId: 'style_legacy_1',
        anchorId: null,
        dimension: 'narrative_voice',
        severity: 'warning',
        confidence: 0.5,
        generatedStart: null,
        generatedEnd: null,
        generatedExcerpt: '模型自由转述的旧引文。',
        description: '整体语气偏差。',
        styleEvidenceIds: [],
        rewriteGoal: '统一为更贴近原著的叙述口吻。',
        preserveMeaning: [],
      },
    ];
    return audit;
  }

  test('buildContinuationV5EditWorkPacket maps real anchors to work items', () => {
    const audit = anchoredAudit();
    const packet = buildContinuationV5EditWorkPacket(audit);
    expect(packet).toHaveLength(2);
    expect(packet[0]).toMatchObject({
      requirementId: 'style_1',
      anchorId: 'v2-p-002',
      sourceText: '真实 V2 第二段原句。',
      sourceStart: 8,
      sourceEnd: 12,
      dimension: 'sentence_rhythm',
      rewriteGoal: '拆成短促动作与留白交替的段落。',
    });
    expect(packet[0].preserveMeaning).toEqual(['门外的威胁', '主角选择迎击']);
  });

  test('legacy anchorId=null corrections are skipped without throwing', () => {
    const audit = legacyAnchorlessAudit();
    const packet = buildContinuationV5EditWorkPacket(audit);
    expect(packet).toEqual([]);
    // Formatter must still produce a usable (no-op) block for V3.
    const block = formatContinuationV5EditWorkPacket(packet);
    expect(block).toMatch(/无可定位的真实 V2 锚点任务/);
  });

  test('edit work packet precedes full V2 in Final Reviser user message', () => {
    const architecture = buildFallbackArchitecture({ userInstruction: '推进' });
    const architectureHash = hashArchitectureEnvelope(architecture);
    const audit = anchoredAudit();
    const compiled = compileContinuationV5FinalReviserMessages({
      view: {
        ...baseView({ stage: 'final_reviser' }),
        budget: {
          ...baseView().budget,
          stage: 'final_reviser' as const,
        },
      } as any,
      revisionContent: '完整 V2 正文，作为合成 V3 的连续性基线。',
      revisionHan: 4800,
      revisionArtifactHash: 'r'.repeat(64),
      architecture,
      architectureHash,
      audit,
      auditContractHash: hashAuditEnvelope(audit),
    });
    const user = compiled.messages.find(m => m.role === 'user')?.content ?? '';
    const packetIdx = user.indexOf('V3 必须先完成的定点编辑工作包');
    const v2Idx = user.indexOf('完整 V2（合成 V3');
    expect(packetIdx).toBeGreaterThan(-1);
    expect(v2Idx).toBeGreaterThan(-1);
    expect(packetIdx).toBeLessThan(v2Idx);
  });

  test('Final prompt work items carry real V2 source text and full-rewrite instruction', () => {
    const architecture = buildFallbackArchitecture({ userInstruction: '推进' });
    const architectureHash = hashArchitectureEnvelope(architecture);
    const audit = anchoredAudit();
    const compiled = compileContinuationV5FinalReviserMessages({
      view: {
        ...baseView({ stage: 'final_reviser' }),
        budget: {
          ...baseView().budget,
          stage: 'final_reviser' as const,
        },
      } as any,
      revisionContent: '完整 V2 正文，作为合成 V3 的连续性基线。',
      revisionHan: 4800,
      revisionArtifactHash: 'r'.repeat(64),
      architecture,
      architectureHash,
      audit,
      auditContractHash: hashAuditEnvelope(audit),
    });
    const user = compiled.messages.find(m => m.role === 'user')?.content ?? '';
    expect(user).toContain('真实 V2 第二段原句。');
    expect(user).toContain('真实 V2 第五段对白原句。');
    expect(user).toMatch(/将整段重新组织为新的叙述表达/);
    expect(user).toMatch(/禁止以删词、改标点或只替换一两个近义词/);
    // System prompt now explicitly orders per-item work first.
    const system =
      compiled.messages.find(m => m.role === 'system')?.content ?? '';
    expect(system).toMatch(/先执行下方按编号给出的真实 V2 编辑工作包/);
    expect(system).toMatch(/完成所有工作包后.*通读全文/);
  });
});

describe('V5 chapter linkage: previous-chapter seam is injected into every stage', () => {
  const PREV_CHAPTER_TAIL = '他推开门，雨水顺着衣角滴落，廊下的灯笼在风里摇。';

  function draftWriterView(seamText: string) {
    return {
      ...baseView({ stage: 'draft_writer' }),
      budget: {
        ...baseView().budget,
        stage: 'draft_writer' as const,
      },
      primaryAnchor: {
        kind: 'continuation_chapter' as const,
        summary: '续写章节「第二章」',
        excerpt: PREV_CHAPTER_TAIL,
        chapterId: 42,
        position: 1,
      },
      recentChapters: [],
      storyMemory: {
        summary: '',
        estimatedTokens: 0,
        eligibilityReason: '',
        throughPosition: 0,
      },
      episodic: [],
      historicalDigests: [],
      fullCanon: {
        worldRules: [],
        characters: [],
        characterStates: [],
        relationships: [],
        experiences: [],
        knowledge: [],
        plotThreads: [],
        timelineEvents: [],
      },
      primaryAnchorSeamText: seamText,
    } as any;
  }

  test('Draft Writer receives the real previous-chapter excerpt, not the placeholder label', () => {
    const seamText = `续写章节「第二章」\n${PREV_CHAPTER_TAIL}`;
    const compiled = compileContinuationV5DraftWriterMessages({
      view: draftWriterView(seamText),
    });
    const user = compiled.messages.find(m => m.role === 'user')?.content ?? '';

    // Regression: previously the prompt emitted "（已由最近续写正文接缝替代）"
    // (a placeholder) and never the real previous-chapter prose. Now the real
    // tail must be present so the model can connect chapter N+1 to chapter N.
    expect(user).toContain(PREV_CHAPTER_TAIL);
    expect(user).not.toMatch(/已由最近续写正文接缝替代/);
    expect(user).toMatch(/上一章正文接缝/);
  });

  test('Revision Writer receives the previous-chapter seam to preserve linkage', () => {
    const architecture = buildFallbackArchitecture({ userInstruction: '推进' });
    const architectureHash = hashArchitectureEnvelope(architecture);
    const seamText = `续写章节「第二章」\n${PREV_CHAPTER_TAIL}`;
    const draftHash = 'a'.repeat(64);
    const compiled = compileContinuationV5RevisionWriterMessages({
      view: {
        ...baseView({ stage: 'revision_writer' }),
        primaryAnchorSeamText: seamText,
      } as any,
      draftContent: '初稿正文。',
      draftHan: 1800,
      draftArtifactHash: draftHash,
      architecture,
      architectureHash,
    });
    const user = compiled.messages.find(m => m.role === 'user')?.content ?? '';
    const system =
      compiled.messages.find(m => m.role === 'system')?.content ?? '';
    expect(user).toContain(PREV_CHAPTER_TAIL);
    expect(user).toMatch(/上一章正文接缝/);
    expect(system).toMatch(/逐字符原样复制/);
    expect(user).toContain(`draftArtifactHash":"${draftHash}"`);
    expect(user).toContain(`architectureHash":"${architectureHash}"`);
    expect(user).toMatch(/不是示例、不是“\.\.\.”占位符/);
  });

  test('Auditor receives the seam and a linkage-check mandate', () => {
    const architecture = buildFallbackArchitecture({ userInstruction: '推进' });
    const architectureHash = hashArchitectureEnvelope(architecture);
    const seamText = `续写章节「第二章」\n${PREV_CHAPTER_TAIL}`;
    const compiled = compileContinuationV5AuditorMessages({
      view: {
        ...baseView({ stage: 'adversarial_auditor' }),
        primaryAnchorSeamText: seamText,
      } as any,
      draftContent: 'V1 原始表达。',
      draftArtifactHash: 'd'.repeat(64),
      revisionContent: 'V2 待润色表达。',
      revisionArtifactHash: 'r'.repeat(64),
      revisionAnchors: buildContinuationV5RevisionAnchors('V2 待润色表达。'),
      architecture,
      architectureHash,
    });
    const user = compiled.messages.find(m => m.role === 'user')?.content ?? '';
    const system =
      compiled.messages.find(m => m.role === 'system')?.content ?? '';
    expect(user).toContain(PREV_CHAPTER_TAIL);
    expect(system).toMatch(/衔接检查/);
  });

  test('Final Reviser receives the seam and a linkage-preservation hint', () => {
    const architecture = buildFallbackArchitecture({ userInstruction: '推进' });
    const architectureHash = hashArchitectureEnvelope(architecture);
    const audit = buildFallbackAuditContract({
      draftArtifactHash: 'd'.repeat(64),
      revisionArtifactHash: 'r'.repeat(64),
      architectureHash,
      canonSnapshotId: 'cs',
      canonRevision: 1,
      inputRevisionHash: 'ir',
      styleProfileHash: null,
      styleRendererVersion: null,
      lockedRules: [],
      hardCanonFacts: [],
    });
    const seamText = `续写章节「第二章」\n${PREV_CHAPTER_TAIL}`;
    const compiled = compileContinuationV5FinalReviserMessages({
      view: {
        ...baseView({ stage: 'final_reviser' }),
        budget: {
          ...baseView().budget,
          stage: 'final_reviser' as const,
        },
        primaryAnchorSeamText: seamText,
      } as any,
      revisionContent: '完整 V2。',
      revisionHan: 4800,
      revisionArtifactHash: 'r'.repeat(64),
      architecture,
      architectureHash,
      audit,
      auditContractHash: hashAuditEnvelope(audit),
    });
    const user = compiled.messages.find(m => m.role === 'user')?.content ?? '';
    const system =
      compiled.messages.find(m => m.role === 'system')?.content ?? '';
    expect(user).toContain(PREV_CHAPTER_TAIL);
    expect(system).toMatch(/上一章正文接缝.*自然衔接/);
  });

  test('Empty seam (opening chapter) renders a graceful placeholder, not the bug string', () => {
    const compiled = compileContinuationV5DraftWriterMessages({
      view: draftWriterView(''),
    });
    const user = compiled.messages.find(m => m.role === 'user')?.content ?? '';
    // No real previous chapter (e.g. first continuation from source opening):
    // the channel is present but explicit, and must never fall back to the
    // legacy broken label.
    expect(user).toMatch(/上一章正文接缝/);
    expect(user).not.toMatch(/已由最近续写正文接缝替代/);
  });
});

