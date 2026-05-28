import { extractJSON } from '../src/utils/jsonExtractor';

test('extracts the first JSON object from model prose', () => {
  expect(extractJSON('说明：\n```json\n{"brief":"雨夜相遇"}\n```')).toBe('{"brief":"雨夜相遇"}');
});
