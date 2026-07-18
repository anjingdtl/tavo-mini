/**
 * V2.2.0：TF-IDF IDF 缓存工具。
 *
 * 现状：contextBuilder.buildMemoryContext 每次调用都跑 tokenize → buildIdf → vectorize。
 * 100 章带 memory_summary 时这是 O(N²) 词汇去重 + 标量计算；连续触发会在毫秒级。
 *
 * 这里提供按项目维度的 IDF 内存缓存，配合"signature 不变就不重算"策略：
 * - signature includes chapter identity, token count, and summary content
 * - 任意章节 summary 写入/重建即 invalidate
 *
 * 这是内存缓存，进程重启会重建。适合运行时单次会话内多章流水线触发 buildContext 的场景。
 */

import type { Chapter } from '../types/novel';

type CachedIdf = {
  signature: string;
  idf: Map<string, number>;
  builtAt: number;
};

const cache = new Map<number, CachedIdf>();
const TTL_MS = 30 * 60 * 1000; // 30 分钟，防止内存累积过多项目

export function computeMemorySummarySignature(previousChapters: Chapter[]): string {
  return previousChapters
    .map(chapter => {
      const summary = chapter.memory_summary || '';
      let first = 5381;
      let second = 52711;
      for (let index = 0; index < summary.length; index += 1) {
        const code = summary.charCodeAt(index);
        first = (first * 33 + code) % 4294967291;
        second = (second * 131 + code) % 4294967279;
      }
      return `${chapter.id}:${chapter.memory_summary_tokens || 0}:${first.toString(
        36,
      )}${second.toString(36)}`;
    })
    .join('|');
}

export function getCachedIdf(
  projectId: number,
  signature: string,
): Map<string, number> | null {
  const entry = cache.get(projectId);
  if (!entry) return null;
  if (Date.now() - entry.builtAt > TTL_MS) {
    cache.delete(projectId);
    return null;
  }
  if (entry.signature !== signature) return null;
  return entry.idf;
}

export function setCachedIdf(
  projectId: number,
  signature: string,
  idf: Map<string, number>,
): void {
  // LRU 简单实现：超过 16 个项目就清掉最老的
  if (cache.size >= 16) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(projectId, { signature, idf, builtAt: Date.now() });
}

export function invalidateIdf(projectId: number): void {
  cache.delete(projectId);
}

export function clearAllIdf(): void {
  cache.clear();
}
