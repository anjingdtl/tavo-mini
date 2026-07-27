/**
 * Lightweight UUID-v4-style generator (Spec §9.6 import job ids).
 *
 * The codebase already generates random ids via `Date.now() + Math.random()`
 * (see requestScheduler / voiceStore). This centralizes a v4-shaped variant so
 * import-job ids are stable-length and sortable, without adding a uuid dep.
 * Uses crypto.getRandomValues when available (RN Hermes exposes it), with a
 * Math.random fallback.
 */
function randomBytes(count: number): Uint8Array {
  const out = new Uint8Array(count);
  if (typeof globalThis !== 'undefined' && (globalThis as any).crypto?.getRandomValues) {
    (globalThis as any).crypto.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < count; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function hex(bytes: Uint8Array, count: number): string {
  let s = '';
  for (let i = 0; i < count; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** RFC-4122 v4 shaped string (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx). */
export function v4(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  return `${hex(b, 4)}-${hex(b.subarray(4), 2)}-${hex(b.subarray(6), 2)}-${hex(b.subarray(8), 2)}-${hex(b.subarray(10), 6)}`;
}
