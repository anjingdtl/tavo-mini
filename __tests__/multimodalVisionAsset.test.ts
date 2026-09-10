import {
  formatLLMError,
  openAICompatibleProvider,
  serializeChatMessagesForOpenAI,
} from '../src/services/llm/openAICompatibleProvider';
import {
  resolveVisionSupport,
} from '../src/services/llm/providerCapabilities';
import type { ChatMessage } from '../src/services/llm/types';
import { estimateMessagesTokens } from '../src/utils/tokenEstimator';
import { buildConstructionMessages } from '../src/services/constructionAiGenerator';

describe('role visual asset multimodal contract', () => {
  const officialOpenAI = {
    provider_type: 'openai_compatible' as const,
    url: 'https://api.openai.com/v1/chat/completions',
    model_name: 'gpt-4.1',
  };

  it('resolves vision capability by exact registration and fail-closed unknown gateways', () => {
    expect(resolveVisionSupport({ ...officialOpenAI, vision_support: 'auto' })).toBe(
      'supported',
    );
    expect(
      resolveVisionSupport({
        ...officialOpenAI,
        model_name: 'gpt-4.1-preview',
        vision_support: 'auto',
      }),
    ).toBe('unknown');
    expect(
      resolveVisionSupport({
        ...officialOpenAI,
        url: 'https://gateway.example.com/v1/chat/completions',
        model_name: 'some-vision-model',
        vision_support: 'auto',
      }),
    ).toBe('unknown');
    expect(
      resolveVisionSupport({
        ...officialOpenAI,
        vision_support: 'supported',
      }),
    ).toBe('supported');
  });

  it('serializes text plus image without exposing internal image fields', () => {
    const messages: Array<ChatMessage<any>> = [
      { role: 'system', content: 'system' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '文字需求优先' },
          { type: 'image', mimeType: 'image/webp', base64: 'AQID' },
        ],
      },
    ];
    expect(serializeChatMessagesForOpenAI(messages)).toEqual([
      { role: 'system', content: 'system' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '文字需求优先' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/webp;base64,AQID' },
          },
        ],
      },
    ]);
  });

  it('does not count image Base64 as input tokens', () => {
    const textOnly = estimateMessagesTokens([
      { role: 'user', content: '角色参考图' },
    ]);
    const withImage = estimateMessagesTokens([
      {
        role: 'user',
        content: [
          { type: 'text', text: '角色参考图' },
          { type: 'image', mimeType: 'image/png', base64: 'A'.repeat(100_000) },
        ],
      },
    ]);
    expect(withImage).toBe(textOnly);
  });

  it('keeps user text before the one-shot visual reference in the construction request', () => {
    const { messages } = buildConstructionMessages(
      {
        mode: 'character_independent',
        extra: '用户明确文字事实',
      },
      { type: 'image', mimeType: 'image/jpeg', base64: 'AQID' },
    );
    expect(messages[0].content).toContain('用户明确给出的事实优先');
    expect(Array.isArray(messages[1].content)).toBe(true);
    expect(messages[1].content).toEqual([
      expect.objectContaining({ type: 'text' }),
      expect.objectContaining({ type: 'image', mimeType: 'image/jpeg' }),
    ]);
  });

  it('surfaces an explicit vision error and never silently drops the image', async () => {
    const error = formatLLMError(
      400,
      JSON.stringify({ error: { message: 'This model does not support image input' } }),
    );
    expect(error.code).toBe('VISION_UNSUPPORTED');
    expect(error.message).toContain('不支持图像输入');

    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as any;
    await expect(
      openAICompatibleProvider.generate(
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: '生成角色' },
              { type: 'image', mimeType: 'image/png', base64: 'AQID' },
            ],
          },
        ],
        {
          requestConfig: {
            provider_type: 'openai_compatible',
            url: 'https://gateway.example.com/v1/chat/completions',
            api_key: 'test-key',
            model_name: 'vision-model',
            context_window: 32_000,
            vision_support: 'auto',
          },
        },
      ),
    ).rejects.toThrow('不支持图像输入');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
