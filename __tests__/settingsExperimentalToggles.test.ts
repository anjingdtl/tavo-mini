/**
 * RB-17 / Phase 6.7 of V2.11.34 blocker plan:
 *
 * Multi-chapter batch and elastic-budget-v2 feature flags are OFF by
 * default with NO user-visible UI in Settings. Release-build users
 * cannot toggle them and have no idea the flags exist. The plan requires
 * a Settings → 实验功能 section that exposes both flags behind an
 * "Experimental" warning.
 *
 * Contract: SettingsScreen renders an "实验功能" (Experimental) section
 * that contains UI controls for at least:
 *   - AI 写 N 章 (multi_chapter_batch_enabled)
 *   - 弹性上下文预算 (elastic_budget_v2_enabled)
 *
 * This test pins down the contract by reading the SettingsScreen source.
 */
/* eslint-env jest */
import * as fs from 'fs';
import * as path from 'path';

const SETTINGS_SCREEN_PATH = path.resolve(
  __dirname,
  '../src/screens/SettingsScreen.tsx',
);

describe('RB-17 experimental feature toggles (V2.11.34 blocker)', () => {
  test('SettingsScreen exposes a 实验功能 section with multi-chapter batch toggle', () => {
    const source = fs.readFileSync(SETTINGS_SCREEN_PATH, 'utf8');

    // The new section title.
    const hasExperimentalSection = /实验功能/.test(source);

    // The toggle for multi-chapter batch.
    const hasBatchToggle =
      /setMultiChapterBatchEnabled/.test(source) ||
      /isMultiChapterBatchEnabled/.test(source);

    expect(hasExperimentalSection).toBe(true);
    expect(hasBatchToggle).toBe(true);
  });

  test('SettingsScreen exposes elastic budget v2 toggle in the experimental section', () => {
    const source = fs.readFileSync(SETTINGS_SCREEN_PATH, 'utf8');

    const hasElasticToggle =
      /setElasticBudgetV2Enabled/.test(source) ||
      /isElasticBudgetV2Enabled/.test(source);

    expect(hasElasticToggle).toBe(true);
  });
});
