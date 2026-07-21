/**
 * V2.5.14 — version generation boundary tests.
 *
 * Root cause being guarded against: pre-V2.5.14 the generator auto-pulled
 * `GITHUB_RUN_NUMBER`. CI run numbers > 99 then made `npm run prebuild`
 * hard-throw, breaking the Android Debug CI job. The fix is to source the
 * build suffix ONLY from SHINE_WRITER_BUILD_NUMBER and default to 0.
 *
 * Each case spawns the script in a clean child process with an isolated env
 * so other Jest cases are never polluted.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const root = path.resolve(__dirname, '..');
const scriptPath = path.join(root, 'scripts', 'generate-version-json.js');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const version = String(packageJson.version);
const [major, minor, patch] = version.split('.').map(Number);
const baseVersionCode =
  major * 1_000_000 + minor * 10_000 + patch * 100;

function makeTempProject(): {
  projectDir: string;
  versionJsonPath: string;
  readmePath: string;
  cleanup: () => void;
} {
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shinewriter-ver-'),
  );
  // Minimal scripts dir copy + version.json + package.json + README.
  fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'src', 'constants'), {
    recursive: true,
  });
  fs.copyFileSync(scriptPath, path.join(projectDir, 'scripts', 'generate-version-json.js'));
  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ ...packageJson, version }),
  );
  fs.writeFileSync(
    path.join(projectDir, 'README.md'),
    '[![Version](https://img.shields.io/badge/Version-V0.0.0-blue.svg)](CHANGELOG.md)\n',
  );
  return {
    projectDir,
    versionJsonPath: path.join(
      projectDir,
      'src',
      'constants',
      'version.json',
    ),
    readmePath: path.join(projectDir, 'README.md'),
    cleanup: () => {
      fs.rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  versionJson: any;
}

function runScript(
  projectDir: string,
  envOverrides: Record<string, string | undefined>,
): RunResult {
  // Start from a minimal clean env so previous process env (including a real
  // GITHUB_RUN_NUMBER on CI) cannot leak in.
  const cleanEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '',
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    // Windows needs these for child_process to spawn node reliably.
    PATHEXT: process.env.PATHEXT,
    ComSpec: process.env.ComSpec,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    USERPROFILE: process.env.USERPROFILE,
    USERNAME: process.env.USERNAME,
  };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) {
      delete cleanEnv[k];
    } else {
      cleanEnv[k] = v;
    }
  }
  const result = spawnSync(
    process.execPath,
    [path.join(projectDir, 'scripts', 'generate-version-json.js')],
    { cwd: projectDir, env: cleanEnv, encoding: 'utf8' },
  );
  const versionJsonPath = path.join(
    projectDir,
    'src',
    'constants',
    'version.json',
  );
  let versionJson: any = null;
  try {
    versionJson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
  } catch {
    versionJson = null;
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    versionJson,
  };
}

describe('generate-version-json.js build suffix source (V2.5.14)', () => {
  it('GITHUB_RUN_NUMBER no longer affects versionCode, even at large values', () => {
    for (const runNumber of ['100', '999', '10000']) {
      const proj = makeTempProject();
      try {
        const result = runScript(proj.projectDir, {
          GITHUB_RUN_NUMBER: runNumber,
        });
        expect(result.status).toBe(0);
        expect(result.versionJson.versionCode).toBe(baseVersionCode);
        expect(result.versionJson.versionName).toBe(`V${version}`);
      } finally {
        proj.cleanup();
      }
    }
  });

  it('SHINE_WRITER_BUILD_NUMBER unset → base versionCode (suffix 0)', () => {
    const proj = makeTempProject();
    try {
      const result = runScript(proj.projectDir, {});
      expect(result.status).toBe(0);
      expect(result.versionJson.versionCode).toBe(baseVersionCode);
    } finally {
      proj.cleanup();
    }
  });

  it('SHINE_WRITER_BUILD_NUMBER=0 → base versionCode', () => {
    const proj = makeTempProject();
    try {
      const result = runScript(proj.projectDir, {
        SHINE_WRITER_BUILD_NUMBER: '0',
      });
      expect(result.status).toBe(0);
      expect(result.versionJson.versionCode).toBe(baseVersionCode);
    } finally {
      proj.cleanup();
    }
  });

  it('SHINE_WRITER_BUILD_NUMBER=1 → base + 1', () => {
    const proj = makeTempProject();
    try {
      const result = runScript(proj.projectDir, {
        SHINE_WRITER_BUILD_NUMBER: '1',
      });
      expect(result.status).toBe(0);
      expect(result.versionJson.versionCode).toBe(baseVersionCode + 1);
    } finally {
      proj.cleanup();
    }
  });

  it('SHINE_WRITER_BUILD_NUMBER=99 → base + 99 (upper bound)', () => {
    const proj = makeTempProject();
    try {
      const result = runScript(proj.projectDir, {
        SHINE_WRITER_BUILD_NUMBER: '99',
      });
      expect(result.status).toBe(0);
      expect(result.versionJson.versionCode).toBe(baseVersionCode + 99);
    } finally {
      proj.cleanup();
    }
  });

  it('SHINE_WRITER_BUILD_NUMBER=100 → hard error', () => {
    const proj = makeTempProject();
    try {
      const result = runScript(proj.projectDir, {
        SHINE_WRITER_BUILD_NUMBER: '100',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/0 to 99/);
    } finally {
      proj.cleanup();
    }
  });

  it('SHINE_WRITER_BUILD_NUMBER=-1 → hard error', () => {
    const proj = makeTempProject();
    try {
      const result = runScript(proj.projectDir, {
        SHINE_WRITER_BUILD_NUMBER: '-1',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/0 to 99/);
    } finally {
      proj.cleanup();
    }
  });

  it('SHINE_WRITER_BUILD_NUMBER=abc → hard error', () => {
    const proj = makeTempProject();
    try {
      const result = runScript(proj.projectDir, {
        SHINE_WRITER_BUILD_NUMBER: 'abc',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/0 to 99/);
    } finally {
      proj.cleanup();
    }
  });

  it('explicit SHINE_WRITER_BUILD_NUMBER wins over a noisy GITHUB_RUN_NUMBER', () => {
    const proj = makeTempProject();
    try {
      const result = runScript(proj.projectDir, {
        SHINE_WRITER_BUILD_NUMBER: '5',
        GITHUB_RUN_NUMBER: '12345',
      });
      expect(result.status).toBe(0);
      expect(result.versionJson.versionCode).toBe(baseVersionCode + 5);
    } finally {
      proj.cleanup();
    }
  });

  it('preserves build suffix on re-run for the same version when no explicit env', () => {
    const proj = makeTempProject();
    try {
      // First run with explicit suffix 7.
      const first = runScript(proj.projectDir, {
        SHINE_WRITER_BUILD_NUMBER: '7',
      });
      expect(first.status).toBe(0);
      expect(first.versionJson.versionCode).toBe(baseVersionCode + 7);
      // Re-run without explicit env → previous suffix is preserved.
      const second = runScript(proj.projectDir, {});
      expect(second.status).toBe(0);
      expect(second.versionJson.versionCode).toBe(baseVersionCode + 7);
    } finally {
      proj.cleanup();
    }
  });
});
