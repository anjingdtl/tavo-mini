import fs from 'fs';
import path from 'path';

const projectRoot = path.resolve(__dirname, '..');

describe('Android GGUF validator', () => {
  it('matches the little-endian GGUF magic bytes', () => {
    const validator = fs.readFileSync(
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
        'GgufValidator.kt',
      ),
      'utf8',
    );

    expect(validator).toContain('private const val GGUF_MAGIC: Long = 0x46554747L');
  });
});
