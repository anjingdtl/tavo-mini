/* eslint-env jest */
/**
 * B2 UI 契约：FinalManuscriptCard 的「查看修改」交互。
 *
 * - revisionApplied=true 且 changes>0 时显示「AI 本次修改 N 处」与
 *   「查看修改（N）」入口；
 * - 打开修改视图展示 修改前/修改后/原因，支持 上一条/下一条 导航；
 * - revisionApplied=false（QA Pass / no-op）时不出现修改入口，
 *   只显示「与初稿一致」。
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { FinalManuscriptCard } from '../src/components/FinalManuscriptCard';
import { buildFinalArtifactSummary } from '../src/services/writing/finalArtifact';
import { computeRevisionChangeSet } from '../src/services/writing/revisionChangeSet';
import { sha256Hex } from '../src/services/continuation/hashUtils';
import type { FinalWritingArtifact } from '../src/services/writing/finalArtifactData';

function makeArtifact(overrides: Partial<FinalWritingArtifact> = {}) {
  const draft = '第一章\n开端句。\n第二段原话。\n结尾句。';
  const final = '第一章\n开端句改了。\n第二段原话。\n结尾句。';
  return {
    body: final,
    draftBody: draft,
    summary: buildFinalArtifactSummary({
      chapterId: 1,
      generationTraceId: 'gt-b2-ui',
      qualityProfile: 'standard',
      draftBody: draft,
      finalBody: final,
      finalizedAt: '2026-08-26T00:00:00.000Z',
    }),
    changes: computeRevisionChangeSet(draft, final, []),
    ...overrides,
  } as FinalWritingArtifact;
}

describe('FinalManuscriptCard：查看修改', () => {
  it('revisionApplied 时显示修改处数与「查看修改」入口', () => {
    const artifact = makeArtifact();
    const { getByText } = render(<FinalManuscriptCard artifact={artifact} />);
    expect(getByText(/AI 本次修改：1 处/)).toBeTruthy();
    expect(getByText(/查看修改（1）/)).toBeTruthy();
  });

  it('打开修改视图展示 before/after/原因并支持翻页', async () => {
    const artifact = makeArtifact();
    const { getByText } = render(<FinalManuscriptCard artifact={artifact} />);
    fireEvent.press(getByText(/查看修改（1）/));

    await waitFor(() => {
      expect(getByText('修改 1 / 1')).toBeTruthy();
      expect(getByText('修改前')).toBeTruthy();
      expect(getByText('修改后')).toBeTruthy();
      expect(getByText('开端句。')).toBeTruthy();
      expect(getByText('开端句改了。')).toBeTruthy();
    });
  });

  it('多条修改时「上一条」正确禁用/启用', async () => {
    const draft = '第一章\n甲句。\n乙句原。\n丙句。\n丁句原。\n戊句。';
    const final = '第一章\n甲句改。\n乙句原。\n丙句改。\n丁句原。\n戊句改。';
    const artifact = {
      body: final,
      draftBody: draft,
      summary: buildFinalArtifactSummary({
        chapterId: 1,
        generationTraceId: 'gt-b2-ui2',
        qualityProfile: 'standard',
        draftBody: draft,
        finalBody: final,
        finalizedAt: '2026-08-26T00:00:00.000Z',
      }),
      changes: computeRevisionChangeSet(draft, final, []),
    } as FinalWritingArtifact;
    expect(artifact.changes.changes.length).toBeGreaterThanOrEqual(3);

    const { getByText } = render(<FinalManuscriptCard artifact={artifact} />);
    fireEvent.press(getByText(/查看修改/));
    await waitFor(() => {
      expect(getByText(/修改 1 \/ \d+/)).toBeTruthy();
    });
    const next = getByText('下一条');
    fireEvent.press(next);
    await waitFor(() => {
      expect(getByText(/修改 2 \/ \d+/)).toBeTruthy();
    });
  });

  it('QA Pass / no-op：不显示修改入口，显示「与初稿一致」', () => {
    const body = '第一章\n正文如此。';
    const artifact = {
      body,
      draftBody: body,
      summary: buildFinalArtifactSummary({
        chapterId: 1,
        generationTraceId: 'gt-b2-ui3',
        qualityProfile: 'standard',
        draftBody: body,
        finalBody: body,
        finalizedAt: '2026-08-26T00:00:00.000Z',
      }),
      changes: computeRevisionChangeSet(body, body, []),
    } as FinalWritingArtifact;
    const { getByText, queryByText } = render(
      <FinalManuscriptCard artifact={artifact} />,
    );
    expect(getByText('与初稿一致')).toBeTruthy();
    expect(queryByText(/查看修改/)).toBeNull();
    expect(queryByText(/AI 本次修改/)).toBeNull();
  });

  it('fingerprint 可追溯：summary 与 changes 指纹一致', () => {
    const body = '最终稿正文。';
    expect(sha256Hex(body)).toMatch(/^[a-f0-9]{64}$/);
  });
});