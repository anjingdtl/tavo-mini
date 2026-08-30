import {
  resolveWritingGovernorCurrentRequestWire,
  resolveWritingGovernorShadow,
} from '../src/services/writing/governor/writingGovernor';

const input = {
  stage: 'draft',
  messages: [
    { role: 'system' as const, content: '写完整正文。' },
    { role: 'user' as const, content: '当前章节任务。' },
  ],
  legacyWireMax: 120_000,
  contextWindow: 1_000_000,
  completionCapability: 200_000,
  providerWireCeiling: 131_072,
  providerAdapterId: 'open.bigmodel.cn-v4',
  modelName: 'GLM-5.3-Flash',
  targetChars: 1_000,
  outputContract: 'prose' as const,
  qualityProfile: 'standard',
  executionProfile: 'standard',
  thinking: { type: 'enabled' as const },
  reasoningEffort: 'high' as const,
};

describe('Phase IV-3 Governor current-request bypass', () => {
  test('ignores a learned recommendation below demand and does not block the request', () => {
    const shadow = resolveWritingGovernorShadow(input);
    const constrained = {
      ...shadow,
      recommendedWireMax: Math.max(1, shadow.demandFloor - 1),
      recommendationMeetsDemandFloor: false,
      preflightBlocked: false,
    };
    const decision = resolveWritingGovernorCurrentRequestWire(
      constrained,
      input.legacyWireMax,
    );
    expect(decision.blocked).toBe(false);
    expect(decision.reason).toBeNull();
    expect(decision.wireMax).toBeGreaterThan(0);
    expect(decision.wireMax).toBeLessThanOrEqual(shadow.hardCeiling);
  });

  test('only the mathematical hard capability boundary may block', () => {
    const shadow = resolveWritingGovernorShadow(input);
    const impossible = {
      ...shadow,
      hardCeiling: Math.max(0, shadow.demandFloor - 1),
      preflightBlocked: true,
    };
    const decision = resolveWritingGovernorCurrentRequestWire(
      impossible,
      input.legacyWireMax,
    );
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe('demand_exceeds_hard_ceiling');
  });

  test('Governor remains a calculation and never creates a physical call', () => {
    const governorCall = jest.fn();
    const shadow = resolveWritingGovernorShadow(input);
    resolveWritingGovernorCurrentRequestWire(shadow, input.legacyWireMax);
    expect(governorCall).not.toHaveBeenCalled();
  });
});
