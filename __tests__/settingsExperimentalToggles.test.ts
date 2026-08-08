/**
 * Default-capabilities contract: the Settings screen must NO LONGER surface
 * the three experimental toggles (AI 写 N 章 / 弹性上下文预算 / 定向修订
 * 流水线), the "实验功能" section, or any "重启应用后生效" copy. Those are
 * now default product capabilities; the settings screen pins their absence.
 *
 * The destructive data-maintenance switch (startup_note_repair_enabled) is
 * explicitly NOT part of this contract — it may surface under 数据维护.
 */
/* eslint-env jest */
import * as fs from 'fs';
import * as path from 'path';
import * as featureFlagsModule from '../src/services/featureFlags';

const SETTINGS_SCREEN_PATH = path.resolve(
  __dirname,
  '../src/screens/SettingsScreen.tsx',
);

const GONE_FLAG_NAMES = [
  'isElasticBudgetV2Enabled',
  'setElasticBudgetV2Enabled',
  'isMultiChapterBatchEnabled',
  'setMultiChapterBatchEnabled',
  'isOutlineWorkflowV2Enabled',
  'setOutlineWorkflowV2Enabled',
];

describe('default capabilities — experimental toggles removed', () => {
  test('SettingsScreen no longer renders the 实验功能 section', () => {
    const source = fs.readFileSync(SETTINGS_SCREEN_PATH, 'utf8');
    expect(/实验功能/.test(source)).toBe(false);
    expect(/重启应用后生效/.test(source)).toBe(false);
    expect(/该功能暂未开放/.test(source)).toBe(false);
  });

  test('SettingsScreen references none of the six removed flag functions', () => {
    const source = fs.readFileSync(SETTINGS_SCREEN_PATH, 'utf8');
    for (const name of GONE_FLAG_NAMES) {
      expect(source).not.toContain(name);
    }
  });

  test('featureFlags module no longer exports the six removed functions', () => {
    const mod = featureFlagsModule as unknown as Record<string, unknown>;
    for (const name of GONE_FLAG_NAMES) {
      expect(mod[name]).toBeUndefined();
    }
  });

  test('the three old settings keys are absent from FEATURE_FLAG_KEYS', () => {
    expect(featureFlagsModule.FEATURE_FLAG_KEYS).not.toHaveProperty(
      'elasticBudgetV2',
    );
    expect(featureFlagsModule.FEATURE_FLAG_KEYS).not.toHaveProperty(
      'multiChapterBatch',
    );
    expect(featureFlagsModule.FEATURE_FLAG_KEYS).not.toHaveProperty(
      'outlineWorkflowV2',
    );
  });
});
