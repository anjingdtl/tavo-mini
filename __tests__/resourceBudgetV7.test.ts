import { allocateHierarchicalContextBudget } from '../src/services/context/hierarchicalContextAllocator';
import { intensityToDetailSoftRatio } from '../src/services/context/resources/resourceContextV2';
import { RESOURCE_AWARENESS_OVER_BUDGET_MESSAGE } from '../src/services/context/resources/resourceContextErrors';

test('32K prefers shrinking details, not dropping protected awareness', () => {
  const awareness = 1800;
  const protocol = 256;
  const preset = 400;
  const outline = 800;
  const mandatory = protocol + preset + outline + awareness;
  const result = allocateHierarchicalContextBudget({
    contextWindow: 32000,
    reservedOutputTokens: 4000,
    mandatoryTokens: mandatory,
    boards: {
      storyState: { actualDemandTokens: 6000 },
      resources: { actualDemandTokens: 12000 },
      slidingWindow: { actualDemandTokens: 8000 },
      episodic: { actualDemandTokens: 5000 },
    },
    resourceItems: [
      {
        id: 'character-detail:1',
        sourceKind: 'character',
        actualTokens: 4000,
        explicitSelected: true,
        activated: true,
        sourceOrder: 0,
        relevance: 0.97,
      },
      {
        id: 'worldbook-detail:8',
        sourceKind: 'worldbook',
        actualTokens: 8000,
        explicitSelected: false,
        activated: true,
        sourceOrder: 1,
        relevance: 0.2,
      },
    ],
  });
  expect(result.envelope.mandatoryTokens).toBe(mandatory);
  expect(result.envelope.mandatoryTokens).toBeLessThanOrEqual(
    result.envelope.hardInputLimit,
  );
  const detailsAllocated = result.resourceItemAllocations
    ? Array.from(result.resourceItemAllocations.values()).reduce((a, b) => a + b, 0)
    : 0;
  expect(detailsAllocated).toBeLessThan(12000);
  expect(result.resourceItemAllocations?.get('character-detail:1') || 0).toBeGreaterThan(
    result.resourceItemAllocations?.get('worldbook-detail:8') || 0,
  );
});

test('1M window can almost full-fit details while awareness stays mandatory', () => {
  const mandatory = 3000;
  const small = allocateHierarchicalContextBudget({
    contextWindow: 32000,
    reservedOutputTokens: 4000,
    mandatoryTokens: mandatory,
    boards: {
      storyState: { actualDemandTokens: 2000 },
      resources: { actualDemandTokens: 5000 },
      slidingWindow: { actualDemandTokens: 2000 },
      episodic: { actualDemandTokens: 2000 },
    },
    resourceItems: [
      {
        id: 'd1',
        sourceKind: 'character',
        actualTokens: 5000,
        explicitSelected: true,
        activated: true,
        sourceOrder: 0,
        relevance: 0.9,
      },
    ],
  });
  const large = allocateHierarchicalContextBudget({
    contextWindow: 1_000_000,
    reservedOutputTokens: 8000,
    mandatoryTokens: mandatory,
    boards: {
      storyState: { actualDemandTokens: 2000 },
      resources: { actualDemandTokens: 5000 },
      slidingWindow: { actualDemandTokens: 2000 },
      episodic: { actualDemandTokens: 2000 },
    },
    resourceItems: [
      {
        id: 'd1',
        sourceKind: 'character',
        actualTokens: 5000,
        explicitSelected: true,
        activated: true,
        sourceOrder: 0,
        relevance: 0.9,
      },
    ],
  });
  expect(large.envelope.mandatoryTokens).toBe(small.envelope.mandatoryTokens);
  expect(large.boardAllocations.resources.allocatedTokens).toBeGreaterThanOrEqual(
    small.boardAllocations.resources.allocatedTokens,
  );
});

test('resourceBudget must not be used as an awareness hard cap', () => {
  expect(RESOURCE_AWARENESS_OVER_BUDGET_MESSAGE).toContain('全局一致性约束');
  expect(intensityToDetailSoftRatio('save')).toBeLessThan(
    intensityToDetailSoftRatio('balanced'),
  );
  expect(intensityToDetailSoftRatio('rich')).toBeGreaterThan(
    intensityToDetailSoftRatio('balanced'),
  );
});
