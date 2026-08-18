/**
 * Physical HTTP accounting for a single writer-stage transport call.
 *
 * `primary` and `protocol_fallback` are distinct request kinds already
 * emitted by the OpenAI-compatible provider. This helper only counts them.
 */
import type { LLMPhysicalRequestHooks } from '../../llm/types';

export interface WritingPhysicalRequestSnapshot {
  physicalRequestCount: number;
  protocolFallbackCount: number;
}

export function createWritingPhysicalRequestAccounting(
  existing?: LLMPhysicalRequestHooks,
): {
  hooks: LLMPhysicalRequestHooks;
  snapshot: () => WritingPhysicalRequestSnapshot;
} {
  const snapshot: WritingPhysicalRequestSnapshot = {
    physicalRequestCount: 0,
    protocolFallbackCount: 0,
  };
  return {
    hooks: {
      beforeRequest: async event => {
        await existing?.beforeRequest?.(event);
        snapshot.physicalRequestCount += 1;
        if (event.kind === 'protocol_fallback') {
          snapshot.protocolFallbackCount += 1;
        }
      },
      afterRequest: async event => {
        await existing?.afterRequest?.(event);
      },
    },
    snapshot: () => ({ ...snapshot }),
  };
}
