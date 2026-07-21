/**
 * V2.5.15 — REAL PowerShell parser test for the Release APK verification.
 *
 * `verifyReleaseApkScript.test.ts` mirrors the parser in TS, but a mirror can
 * drift from the real semantics (which is exactly how the v2 false-positive bug
 * survived: the mirror reproduced the buggy fallback). This file therefore
 * launches `pwsh` (or Windows `powershell`) as a subprocess, dot-sources the
 * REAL `scripts/apk-verification-parsers.ps1`, and calls `Parse-ApkSignerOutput`
 * + `Test-ApkSignerAcceptance` directly on the spec's acceptance matrix.
 *
 * Cross-platform behavior:
 *   - Windows (this build host): `powershell.exe` is available → the real
 *     parser runs and every matrix scenario is asserted.
 *   - Linux CI (no PowerShell): the suite is `describe.skip`-ed with an
 *     explicit log line. It is NEVER reported as "real PowerShell executed"
 *     when it was skipped. The TS mirror in verifyReleaseApkScript.test.ts
 *     still provides pure-function coverage on every platform.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const root = path.resolve(__dirname, '..');
const parsersPath = path.join(root, 'scripts', 'apk-verification-parsers.ps1');

const REQUIRED_CERT_SHA256_LOWER =
  '017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a';
const WRONG_CERT_SHA256_LOWER =
  'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/** Locate a real PowerShell binary; returns null if none is on PATH. */
function findPowerShell(): { bin: string; args: string[] } | null {
  for (const bin of ['pwsh', 'powershell']) {
    const probe = spawnSync(bin, ['-NoProfile', '-Command', 'echo OK'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (probe.status === 0 && (probe.stdout || '').trim() === 'OK') {
      return { bin, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass'] };
    }
  }
  return null;
}

interface PsResult {
  VerifiedAny: boolean;
  V2LineFound: boolean;
  VerifiedV2: boolean;
  NumberSigners: number | null;
  CertSha256: string | null;
  Accepted: boolean;
  Reason: string;
}

/** Run the real parser + acceptance decision on one apksigner output sample. */
function runRealParser(
  sample: string,
  expectedCert: string,
): { result: PsResult | null; stdout: string; stderr: string; status: number | null } {
  const ps = findPowerShell();
  if (!ps) {
    return { result: null, stdout: '', stderr: '', status: null };
  }
  const tmp = path.join(
    os.tmpdir(),
    `apk-sample-${process.pid}-${Math.random().toString(36).slice(2)}.txt`,
  );
  fs.writeFileSync(tmp, sample, 'utf8');
  try {
    const command = [
      '. $env:APK_PARSERS_PATH',
      '$s = Get-Content -Raw -LiteralPath $env:APK_SAMPLE_PATH',
      '$p = Parse-ApkSignerOutput -Output $s',
      '$a = Test-ApkSignerAcceptance -Parsed $p -ExpectedCertSha256Normalized $env:APK_EXPECTED_CERT',
      '@{ VerifiedAny = $p.VerifiedAny; V2LineFound = $p.V2LineFound; VerifiedV2 = $p.VerifiedV2; NumberSigners = $p.NumberSigners; CertSha256 = $p.CertSha256; Accepted = $a.Accepted; Reason = $a.Reason } | ConvertTo-Json -Compress',
    ].join('; ');
    const out = spawnSync(
      ps.bin,
      [...ps.args, '-Command', command],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          APK_PARSERS_PATH: parsersPath,
          APK_SAMPLE_PATH: tmp,
          APK_EXPECTED_CERT: expectedCert,
        },
      },
    );
    let result: PsResult | null = null;
    const stdout = out.stdout || '';
    const jsonStart = stdout.indexOf('{');
    const jsonEnd = stdout.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      try {
        result = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
      } catch {
        result = null;
      }
    }
    return {
      result,
      stdout,
      stderr: out.stderr || '',
      status: out.status,
    };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
  }
}

const PS = findPowerShell();
// If no PowerShell is available, skip the whole suite (Linux CI). This must NOT
// be reported as "real PowerShell test executed".
const describeReal = PS ? describe : describe.skip;

describeReal(
  'Parse-ApkSignerOutput + Test-ApkSignerAcceptance — REAL PowerShell (V2.5.15)',
  () => {
    if (!PS) {
      // eslint-disable-next-line no-console
      console.warn(
        '[apkVerificationPowershell] PowerShell not available on PATH — ' +
          'real parser test SKIPPED. TS mirror in verifyReleaseApkScript.test.ts ' +
          'still covers pure-function semantics.',
      );
    }

    it('scenario 1 — normal v2 (v1=false, v2=true, v3=false, signers=1): ACCEPTED', () => {
      const sample = [
        'Verifies',
        'Verified using v1 scheme: false',
        'Verified using v2 scheme: true',
        'Verified using v3 scheme: false',
        'Number of signers: 1',
        `Signer #1 certificate SHA-256 digest: ${REQUIRED_CERT_SHA256_LOWER}`,
      ].join('\r\n');
      const { result, stderr, status } = runRealParser(
        sample,
        REQUIRED_CERT_SHA256_LOWER,
      );
      expect(status).toBe(0);
      expect(stderr).toBe('');
      expect(result).not.toBeNull();
      expect(result!.V2LineFound).toBe(true);
      expect(result!.VerifiedV2).toBe(true);
      expect(result!.NumberSigners).toBe(1);
      expect(result!.Accepted).toBe(true);
      expect(result!.Reason).toBe('ok');
    });

    it('scenario 2 — v1 only (v1=true, v2=false, signers=1): REJECTED (no fallback)', () => {
      // The exact regression V2.5.15 fixes: previously VerifiedV2 became true
      // because a v1 scheme line existed. VerifiedV2 must now be false and the
      // acceptance must reject.
      const sample = [
        'Verified using v1 scheme: true',
        'Verified using v2 scheme: false',
        'Number of signers: 1',
        `Signer #1 certificate SHA-256 digest: ${REQUIRED_CERT_SHA256_LOWER}`,
      ].join('\n');
      const { result } = runRealParser(sample, REQUIRED_CERT_SHA256_LOWER);
      expect(result).not.toBeNull();
      expect(result!.V2LineFound).toBe(true);
      expect(result!.VerifiedV2).toBe(false);
      expect(result!.Accepted).toBe(false);
      expect(result!.Reason).toBe('v2_not_true');
    });

    it('scenario 3 — missing v2 line (v1=true, v3=true, no v2): REJECTED', () => {
      const sample = [
        'Verified using v1 scheme: true',
        'Verified using v3 scheme: true',
        'Number of signers: 1',
        `Signer #1 certificate SHA-256 digest: ${REQUIRED_CERT_SHA256_LOWER}`,
      ].join('\n');
      const { result } = runRealParser(sample, REQUIRED_CERT_SHA256_LOWER);
      expect(result).not.toBeNull();
      expect(result!.V2LineFound).toBe(false);
      expect(result!.VerifiedV2).toBe(false);
      expect(result!.Accepted).toBe(false);
      expect(result!.Reason).toBe('no_v2_line');
    });

    it('scenario 4 — multi-signer (v2=true, signers=2): REJECTED', () => {
      const sample = [
        'Verified using v2 scheme: true',
        'Number of signers: 2',
        `Signer #1 certificate SHA-256 digest: ${REQUIRED_CERT_SHA256_LOWER}`,
      ].join('\n');
      const { result } = runRealParser(sample, REQUIRED_CERT_SHA256_LOWER);
      expect(result).not.toBeNull();
      expect(result!.VerifiedV2).toBe(true);
      expect(result!.NumberSigners).toBe(2);
      expect(result!.Accepted).toBe(false);
      // V2.5.16: stable reason code (no longer embeds the count in Reason).
      expect(result!.Reason).toBe('invalid_signer_count');
    });

    it('scenario 5 — wrong cert (v2=true, signers=1, bad SHA-256): REJECTED', () => {
      const sample = [
        'Verified using v2 scheme: true',
        'Number of signers: 1',
        `Signer #1 certificate SHA-256 digest: ${WRONG_CERT_SHA256_LOWER}`,
      ].join('\n');
      const { result } = runRealParser(sample, REQUIRED_CERT_SHA256_LOWER);
      expect(result).not.toBeNull();
      expect(result!.VerifiedV2).toBe(true);
      expect(result!.NumberSigners).toBe(1);
      expect(result!.Accepted).toBe(false);
      expect(result!.Reason).toBe('cert_mismatch');
    });

    it('VerifiedV2 never derives from v1/v3 lines (the bug must stay fixed)', () => {
      // v1=true, v3=true, v2 line ABSENT. The old fallback would set v2 true.
      const sample = [
        'Verified using v1 scheme: true',
        'Verified using v3 scheme: true',
        'Verified using v4 scheme: true',
        'Number of signers: 1',
        `Signer #1 certificate SHA-256 digest: ${REQUIRED_CERT_SHA256_LOWER}`,
      ].join('\n');
      const { result } = runRealParser(sample, REQUIRED_CERT_SHA256_LOWER);
      expect(result).not.toBeNull();
      // Any vN line existing must NOT flip VerifiedV2 on.
      expect(result!.V2LineFound).toBe(false);
      expect(result!.VerifiedV2).toBe(false);
      // VerifiedAny is the only place v1/v3 true shows up (diagnostic only).
      expect(result!.VerifiedAny).toBe(true);
    });
  },
);

// Always runs: confirms the parsers file exists and is dot-sourceable text, so
// a CI without PowerShell still proves the script wiring is in place.
describe('apk-verification-parsers.ps1 — file wiring', () => {
  it('exists alongside verify-release-apk.ps1 and declares the required functions', () => {
    expect(fs.existsSync(parsersPath)).toBe(true);
    const src = fs.readFileSync(parsersPath, 'utf8');
    expect(src).toMatch(/function Parse-ApkSignerOutput/);
    expect(src).toMatch(/function Test-ApkSignerAcceptance/);
    expect(src).toMatch(/function ConvertTo-NormalizedHash/);
    // The buggy fallback variable/comment must be absent here too.
    expect(src).not.toMatch(/Fall back to the legacy/i);
  });

  it('verify-release-apk.ps1 dot-sources the shared parser', () => {
    const main = fs.readFileSync(
      path.join(root, 'scripts', 'verify-release-apk.ps1'),
      'utf8',
    );
    expect(main).toMatch(/\. "\$PSScriptRoot\/apk-verification-parsers\.ps1"/);
    expect(main).not.toMatch(/verifiedAnySchemeLine/i);
  });

  // V2.5.16: production main script must reuse Test-ApkSignerAcceptance as the
  // SINGLE accept/reject entry — never re-implement V2/signer/cert hard asserts.
  it('V2.5.16: verify-release-apk.ps1 calls Test-ApkSignerAcceptance (single acceptance entry)', () => {
    const main = fs.readFileSync(
      path.join(root, 'scripts', 'verify-release-apk.ps1'),
      'utf8',
    );
    expect(main).toMatch(/Test-ApkSignerAcceptance/);
    // Main script must not independently decide accept/reject on these fields.
    expect(main).not.toMatch(
      /if\s*\(\s*-not\s+\$parsed\.V2LineFound\s*\)/,
    );
    expect(main).not.toMatch(
      /if\s*\(\s*\$parsed\.VerifiedV2\s+-ne\s+\$true\s*\)/,
    );
    expect(main).not.toMatch(
      /if\s*\(\s*\$parsed\.NumberSigners\s+-ne\s+1\s*\)/,
    );
    // No independent cert hash comparison for acceptance.
    expect(main).not.toMatch(
      /if\s*\(\s*\$certNorm\s+-ne\s+\$script:RELEASE_CERT_SHA256_NORM\s*\)/,
    );
  });
});
