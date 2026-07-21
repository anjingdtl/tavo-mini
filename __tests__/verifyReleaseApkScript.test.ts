/**
 * V2.5.14 — Release APK verification script contract tests.
 *
 * `scripts/verify-release-apk.ps1` cannot be exercised end-to-end inside Jest
 * (no Android Build Tools / signed APK on CI). These tests therefore enforce
 * a text contract: the script MUST contain and run hard assertions for every
 * required check, and MUST throw + exit non-zero on any mismatch (not just
 * print a warning). They also mirror the PowerShell parsing helpers in TS so
 * the normalization logic is covered by real unit tests.
 */

import fs from 'fs';
import path from 'path';

const scriptPath = path.resolve(
  __dirname,
  '..',
  'scripts',
  'verify-release-apk.ps1',
);
const script = fs.readFileSync(scriptPath, 'utf8');

const REQUIRED_CERT_SHA256_LOWER =
  '017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a';

describe('verify-release-apk.ps1 — hard-assertion text contract', () => {
  it('asserts the fixed release cert SHA-256', () => {
    // Lowercase canonical form must appear at least once.
    expect(script.toLowerCase()).toContain(REQUIRED_CERT_SHA256_LOWER);
    // And a comparison must throw on mismatch (throw wraps the message).
    expect(script).toMatch(/throw[^]*Cert SHA-256 mismatch/);
  });

  it('asserts exactly 1 signer', () => {
    expect(script).toMatch(/Number of signers[^]*1/);
    expect(script).toMatch(/throw[^]*NumberSigners|NumberSigners[^]*throw/);
  });

  it('asserts the v2 signature scheme', () => {
    expect(script).toMatch(/Verified\s+using\s+v2\s+scheme/);
    // v2 scheme failure must throw.
    expect(script).toMatch(/throw[^]*v2 scheme|throw[^]*VerifiedV2/);
  });

  it('V2.5.15: dot-sources the shared parser and hard-asserts V2LineFound', () => {
    // The parser is extracted so the real-PowerShell Jest test can exercise the
    // SAME function. The main script must dot-source it (not redefine it).
    expect(script).toMatch(/\. "\$PSScriptRoot\/apk-verification-parsers\.ps1"/);
    // VerifiedV2 must come ONLY from the explicit v2 line — the main flow throws
    // if that line is missing (V2LineFound) OR says false (VerifiedV2).
    expect(script).toMatch(/V2LineFound/);
    expect(script).toMatch(
      /throw[^]*does not contain an explicit v2 scheme result/,
    );
    expect(script).toMatch(
      /throw[^]*APK must be signed with APK Signature Scheme v2/,
    );
  });

  it('V2.5.15: the v2 fallback ("any scheme line => v2 true") is gone', () => {
    // The pre-fix bug set VerifiedV2=true whenever any "Verified using vN scheme"
    // line existed. The fallback variable name and comment must be absent.
    expect(script).not.toMatch(/verifiedAnySchemeLine/i);
    expect(script).not.toMatch(/Fall back to the legacy/i);
  });

  it('asserts package name == com.shinewriter', () => {
    expect(script).toContain("'com.shinewriter'");
    expect(script).toMatch(/throw[^]*Package name mismatch/);
  });

  it('asserts versionName from version.json', () => {
    // The throw wraps the message: "throw \"...versionName mismatch...\"".
    expect(script).toMatch(/throw[^]*versionName mismatch/);
  });

  it('asserts versionCode from version.json', () => {
    expect(script).toMatch(/throw[^]*versionCode mismatch/);
  });

  it('requires zipalign -c -P 16 -v 4 and throws on failure', () => {
    expect(script).toContain('-c -P 16 -v 4');
    expect(script).toContain("'Verification successful'");
    expect(script).toMatch(/zipalign[\s\S]*throw/);
  });

  it('requires apksigner verify --verbose --print-certs and throws on failure', () => {
    expect(script).toContain('verify --verbose --print-certs');
    expect(script).toMatch(/apksigner verify failed[\s\S]*throw/);
  });

  it('outputs the APK SHA-256 via Get-FileHash', () => {
    expect(script).toContain('Get-FileHash -Algorithm SHA256');
  });

  it('reads expected version from src/constants/version.json', () => {
    expect(script).toContain("Get-Content -Raw 'src/constants/version.json'");
  });

  it('cross-checks against package.json', () => {
    expect(script).toContain("Get-Content -Raw 'package.json'");
  });

  it('hard-asserts the canonical APK path and filename', () => {
    expect(script).toContain('dist/apk/release/');
    expect(script).toContain('ShineWriter-');
    expect(script).toContain('-release.apk');
    expect(script).toMatch(/APK filename[\s\S]*throw|APK not found[\s\S]*throw/);
  });

  it('uses $ErrorActionPreference = Stop so failures abort', () => {
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
  });

  it('never accepts debug signing as a fallback', () => {
    // The script must not contain any debug-keystore fallback branch. The word
    // "debug" may legitimately appear in comments/error copy, so we forbid the
    // actual fallback patterns instead.
    expect(script.toLowerCase()).not.toMatch(/debug\.keystore/);
    expect(script.toLowerCase()).not.toMatch(/fallback.*debug|debug.*fallback/);
    expect(script.toLowerCase()).not.toMatch(/if.*signer.*debug/);
  });

  it('never creates a keystore', () => {
    expect(script.toLowerCase()).not.toMatch(/keytool\s+-genkey|new-keystore|create.*keystore/);
  });

  it('never prints signing passwords', () => {
    // No reference to KEY_PASSWORD / STORE_PASSWORD values being output.
    expect(script.toLowerCase()).not.toMatch(/store_password|key_password/);
  });
});

// --- TS mirror of the PowerShell parsing helpers (pure-function coverage) ---
// V2.5.15: this mirror matches the real `Parse-ApkSignerOutput` in
// scripts/apk-verification-parsers.ps1. VerifiedV2 comes ONLY from the explicit
// v2 scheme line; there is no "any scheme line => v2 true" fallback. The real
// PowerShell function is ALSO executed by apkVerificationPowershell.test.ts.

function normalizeHash(value: string): string {
  return value.replace(/:/g, '').trim().toLowerCase();
}

function parseApkSignerOutput(output: string): {
  verifiedAny: boolean;
  v2LineFound: boolean;
  verifiedV2: boolean;
  numberSigners: number | null;
  certSha256: string | null;
} {
  const lines = output.replace(/\r\n/g, '\n').split('\n').map(l => l.trim());

  // v2 line: the ONLY source of verifiedV2 / v2LineFound.
  let v2LineFound = false;
  let verifiedV2 = false;
  for (const line of lines) {
    const m = line.match(/^Verified\s+using\s+v2\s+scheme:\s*(true|false)/i);
    if (m) {
      v2LineFound = true;
      verifiedV2 = m[1].toLowerCase() === 'true';
      break;
    }
  }

  // verifiedAny: diagnostic only — any scheme true or a legacy "Verifies" line.
  const verifiedAny = lines.some(
    l =>
      /^Verified\s+using\s+v\d+\s+scheme:\s*true/i.test(l) ||
      /^Verifies\s*$/i.test(l),
  );

  let numberSigners: number | null = null;
  for (const line of lines) {
    const m = line.match(/^Number of signers:\s*(\d+)/i);
    if (m) {
      numberSigners = parseInt(m[1], 10);
      break;
    }
  }

  let certSha256: string | null = null;
  for (const line of lines) {
    if (/SHA-256.*digest/i.test(line)) {
      const idx = line.indexOf(':');
      if (idx >= 0) {
        certSha256 = line.slice(idx + 1).trim();
        break;
      }
    }
  }

  return { verifiedAny, v2LineFound, verifiedV2, numberSigners, certSha256 };
}

function parseAaptBadging(output: string): {
  packageName: string | null;
  versionName: string | null;
  versionCode: string | null;
} {
  const normalized = output.replace(/\r\n/g, '\n');
  const packageLine = normalized
    .split('\n')
    .find(l => /^package:/.test(l));
  if (!packageLine) {
    return { packageName: null, versionName: null, versionCode: null };
  }
  const nameMatch = packageLine.match(/name='([^']*)'/);
  const versionNameMatch = packageLine.match(/versionName='([^']*)'/);
  const versionCodeMatch = packageLine.match(/versionCode='([^']*)'/);
  return {
    packageName: nameMatch ? nameMatch[1] : null,
    versionName: versionNameMatch ? versionNameMatch[1] : null,
    versionCode: versionCodeMatch ? versionCodeMatch[1] : null,
  };
}

describe('PowerShell parsing helpers — TS mirror (pure function coverage)', () => {
  it('normalizes cert SHA-256 ignoring case and colons', () => {
    // Full digest with colons and uppercase — both must normalize to the same
    // canonical lowercase no-colon form.
    const withColons =
      '017B:3F:BE:D4:00:10:83:F2:F7:0A:0C:51:E8:E4:63:32:2D:F6:6B:09:5E:1C:3A:47:6F:DD:0D:86:DC:2A:0A';
    expect(normalizeHash(withColons)).toBe(REQUIRED_CERT_SHA256_LOWER);
    expect(normalizeHash(REQUIRED_CERT_SHA256_LOWER.toUpperCase()))
      .toBe(REQUIRED_CERT_SHA256_LOWER);
  });

  it('detects Verified using v2 scheme = true and signer count', () => {
    const sample = [
      'Verifies',
      'Verified using v1 scheme: false',
      'Verified using v2 scheme: true',
      'Verified using v3 scheme: false',
      'Number of signers: 1',
      'Signer #1 certificate SHA-256 digest: 017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a',
    ].join('\r\n');
    const parsed = parseApkSignerOutput(sample);
    expect(parsed.v2LineFound).toBe(true);
    expect(parsed.verifiedV2).toBe(true);
    expect(parsed.numberSigners).toBe(1);
    expect(parsed.certSha256).toBe(REQUIRED_CERT_SHA256_LOWER);
  });

  it('rejects when v2 scheme is false even if signer count is 1 (no fallback)', () => {
    // This is the regression that V2.5.15 fixes: previously any "Verified using
    // vN scheme" line set verified=true, masking a false v2. Now verifiedV2
    // stays false and the acceptance decision must reject.
    const sample = [
      'Verified using v1 scheme: true',
      'Verified using v2 scheme: false',
      'Number of signers: 1',
      'Signer #1 certificate SHA-256 digest: 017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a',
    ].join('\n');
    const parsed = parseApkSignerOutput(sample);
    expect(parsed.v2LineFound).toBe(true);
    expect(parsed.verifiedV2).toBe(false);
  });

  it('rejects when the v2 scheme line is missing entirely (v1+v3 only)', () => {
    const sample = [
      'Verified using v1 scheme: true',
      'Verified using v3 scheme: true',
      'Number of signers: 1',
      'Signer #1 certificate SHA-256 digest: 017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a',
    ].join('\n');
    const parsed = parseApkSignerOutput(sample);
    expect(parsed.v2LineFound).toBe(false);
    expect(parsed.verifiedV2).toBe(false);
  });

  it('detects multi-signer APK (must be rejected by the script)', () => {
    const sample = [
      'Verified using v2 scheme: true',
      'Number of signers: 2',
    ].join('\n');
    const parsed = parseApkSignerOutput(sample);
    expect(parsed.numberSigners).toBe(2);
  });

  it('parses aapt badging package line', () => {
    const sample = [
      "package: name='com.shinewriter' versionCode='2051400' versionName='V2.5.14' platformBuildVersionName=''",
      'application-label:\'ShineWriter\'',
    ].join('\r\n');
    const parsed = parseAaptBadging(sample);
    expect(parsed.packageName).toBe('com.shinewriter');
    expect(parsed.versionName).toBe('V2.5.14');
    expect(parsed.versionCode).toBe('2051400');
  });

  it('returns nulls when package line is missing', () => {
    const parsed = parseAaptBadging('application-label:\'ShineWriter\'\r\n');
    expect(parsed.packageName).toBeNull();
  });
});
