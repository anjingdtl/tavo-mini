import fs from 'fs';
import path from 'path';

const projectRoot = path.resolve(__dirname, '..');

describe('local-model native import handshake', () => {
  it('emits copying synchronously before dispatching the file copy coroutine', () => {
    const source = fs.readFileSync(
      path.join(
        projectRoot,
        'android',
        'app',
        'src',
        'main',
        'java',
        'com',
        'shinewriter',
        'llamacpp',
        'ModelImporter.kt',
      ),
      'utf8',
    );

    const initialStateEvent = source.indexOf('onStateChanged(importId, "copying")');
    const coroutineStart = source.indexOf('val job = scope.launch');

    expect(initialStateEvent).toBeGreaterThan(-1);
    expect(coroutineStart).toBeGreaterThan(initialStateEvent);
  });
});
