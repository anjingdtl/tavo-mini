/* eslint-env jest */

import fs from 'fs';
import path from 'path';

const projectRoot = path.resolve(__dirname, '..');

describe('local-model generation lifecycle', () => {
  it('releases both native execution guards before dispatching the terminal event', () => {
    const jni = fs.readFileSync(
      path.join(projectRoot, 'android', 'app', 'jni', 'llamacpp_jni.cpp'),
      'utf8',
    );
    const callback = fs.readFileSync(
      path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'shinewriter', 'llamacpp', 'LlamaCppGenCallback.kt'),
      'utf8',
    );
    const module = fs.readFileSync(
      path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'shinewriter', 'llamacpp', 'LlamaCppModule.kt'),
      'utf8',
    );

    const resetIndex = jni.indexOf('g_cancelled.store(false, std::memory_order_seq_cst);', jni.indexOf('llama_sampler_free(sampler);'));
    const unlockIndex = jni.indexOf('lock.unlock();', resetIndex);
    const completedIndex = jni.indexOf('emitCompleted(', unlockIndex);

    expect(resetIndex).toBeGreaterThan(-1);
    expect(unlockIndex).toBeGreaterThan(resetIndex);
    expect(completedIndex).toBeGreaterThan(unlockIndex);
    expect(jni.lastIndexOf('cancelGuard.disarm();')).toBeGreaterThan(resetIndex);
    expect(callback.indexOf('onTerminalFn?.invoke(requestId)')).toBeLessThan(
      callback.indexOf('onCompleteFn?.invoke(requestId'),
    );
    expect(module).toContain('onTerminal = { reqId ->');
    expect(module).toContain('engineInstance.markRequestFinished(reqId)');
    expect(jni).toContain('llama_memory_clear(mem, true);');
    expect(jni).toContain('llama_set_abort_callback(g_ctx, shouldAbort, nullptr);');
    expect(jni).toContain('nativeGenerate: prefill cancelled');
    expect(jni).not.toContain('llama_synchronize(g_ctx);');
  });
});
