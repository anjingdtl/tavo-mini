import fs from 'fs';
import path from 'path';

const projectRoot = path.resolve(__dirname, '..');

describe('LlamaCpp TurboModule codegen contract', () => {
  it('registers the app codegen source directory for Android', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    );

    expect(pkg.codegenConfig).toMatchObject({
      name: 'ShineWriterSpec',
      type: 'modules',
      jsSrcsDir: 'src',
      android: {
        javaPackageName: 'com.shinewriter.specs',
      },
    });
  });

  it('declares LlamaCpp through TurboModuleRegistry.getEnforcing', () => {
    const specPath = path.join(
      projectRoot,
      'src',
      'native',
      'specs',
      'NativeLlamaCpp.ts',
    );
    const spec = fs.readFileSync(specPath, 'utf8');

    expect(spec).toContain('interface Spec extends TurboModule');
    expect(spec).toContain("TurboModuleRegistry.getEnforcing<Spec>('LlamaCpp')");
    for (const methodName of [
      'getCapabilities',
      'importModel',
      'validateModel',
      'loadModel',
      'generate',
      'cancel',
      'unloadModel',
      'deleteModelFiles',
      'modelFileExists',
      'cleanupStagingFiles',
      'addListener',
      'removeListeners',
    ]) {
      expect(spec).toContain(methodName);
    }
  });

  it('keeps the runtime bridge off the enforcing codegen entrypoint', () => {
    const bridge = fs.readFileSync(
      path.join(projectRoot, 'src', 'native', 'LlamaCppModule.ts'),
      'utf8',
    );

    expect(bridge).toContain("TurboModuleRegistry?.get?.('LlamaCpp')");
    expect(bridge).not.toContain("require('./specs/NativeLlamaCpp')");
  });
});
