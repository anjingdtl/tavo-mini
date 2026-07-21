#---
# Public parsing helpers for Release APK verification (V2.5.15+).
#
# Kept in a separate file so it can be dot-sourced both by the main
# `verify-release-apk.ps1` script AND by the real-PowerShell Jest test
# (`apkVerificationPowershell.test.ts`), which launches `powershell`/`pwsh` as a
# subprocess and calls `Parse-ApkSignerOutput` / `Test-ApkSignerAcceptance`
# directly. The previous inline parser lived inside the main script and could
# only be covered by a TS mirror, which drifted from the real semantics.
#
# CRITICAL INVARIANT (the bug this file fixes):
#   `VerifiedV2` is sourced ONLY from the explicit
#       `Verified using v2 scheme: true|false`
#   line. There is NO fallback that treats "any `Verified using vN scheme` line
#   exists" as v2 success. An APK signed with only v1 (v2: false) or an output
#   that omits the v2 line entirely MUST NOT be accepted.
#---

function ConvertTo-NormalizedHash {
    param([string]$Value)
    # Strip colons and lowercase so "017B3F:BE:..." and "017b3fbe..." compare equal.
    return ($Value -replace ':', '').Trim().ToLowerInvariant()
}

function Parse-ApkSignerOutput {
    <#
        Parses `apksigner verify --verbose --print-certs` output into a stable
        object with independent fields:

          VerifiedAny    - diagnostic: true if any "Verified using vN scheme:
                           true" line OR a legacy "Verifies" summary is present.
                           NOT used by the acceptance decision.
          V2LineFound    - true iff the explicit
                           "Verified using v2 scheme: true|false" line exists.
          VerifiedV2     - the boolean from THAT v2 line ONLY. False when the
                           line is missing or says false. Never derived from
                           v1/v3/v4 lines.
          NumberSigners  - integer from "Number of signers: N", or $null.
          CertSha256     - raw cert SHA-256 digest string, or $null.

        Tolerates Windows CRLF and the spacing variation between Build Tools
        minor versions (e.g. "SHA-256 digest:    " vs "SHA-256 digest: ").
    #>
    param([string]$Output)
    $normalized = ($Output -replace "`r`n", "`n")
    $lines = $normalized -split "`n" | ForEach-Object { $_.Trim() }

    # --- v2 line: the ONLY source of VerifiedV2 / V2LineFound ---
    $v2LineFound = $false
    $verifiedV2 = $false
    foreach ($line in $lines) {
        if ($line -match '^Verified\s+using\s+v2\s+scheme:\s*(true|false)') {
            $v2LineFound = $true
            $verifiedV2 = ($matches[1] -eq 'true')
            break
        }
    }

    # --- VerifiedAny: diagnostic only (any scheme true, or legacy "Verifies") ---
    $verifiedAny = $false
    foreach ($line in $lines) {
        if ($line -match '^Verified\s+using\s+v\d+\s+scheme:\s*true') {
            $verifiedAny = $true
            break
        }
    }
    if (-not $verifiedAny) {
        foreach ($line in $lines) {
            if ($line -match '^Verifies\s*$') {
                $verifiedAny = $true
                break
            }
        }
    }

    # --- signer count ---
    $numberSigners = $null
    foreach ($line in $lines) {
        if ($line -match '^Number of signers:\s*(\d+)') {
            $numberSigners = [int]$matches[1]
            break
        }
    }

    # --- cert SHA-256 digest ---
    $certSha256 = $null
    foreach ($line in $lines) {
        if ($line -match 'SHA-256.*digest') {
            $idx = $line.IndexOf(':')
            if ($idx -ge 0) {
                $certSha256 = $line.Substring($idx + 1).Trim()
                break
            }
        }
    }

    return @{
        VerifiedAny = $verifiedAny
        V2LineFound = $v2LineFound
        VerifiedV2 = $verifiedV2
        NumberSigners = $numberSigners
        CertSha256 = $certSha256
    }
}

function Parse-AaptBadging {
    <#
        Parses `aapt dump badging` first `package:` line. Returns a hashtable
        with packageName / versionName / versionCode (strings).
    #>
    param([string]$Output)
    $normalized = ($Output -replace "`r`n", "`n")
    $packageLine = ($normalized -split "`n" | Where-Object { $_ -match '^package:' } | Select-Object -First 1)
    if (-not $packageLine) {
        return $null
    }
    $result = @{ packageName = $null; versionName = $null; versionCode = $null }
    if ($packageLine -match "name='([^']*)'") { $result.packageName = $matches[1] }
    if ($packageLine -match "versionName='([^']*)'") { $result.versionName = $matches[1] }
    if ($packageLine -match "versionCode='([^']*)'") { $result.versionCode = $matches[1] }
    return $result
}

<#
    .SYNOPSIS
        Mirrors the main script's hard-assert acceptance decision as a pure
        function, so the Jest subprocess test can assert the END-TO-END
        accept/reject outcome (not just parsed fields).

    .DESCRIPTION
        Returns @{ Accepted = $bool; Reason = '<why>' }.

        Accepted is true ONLY when ALL of:
          - the explicit v2 scheme line is present (V2LineFound)
          - VerifiedV2 is true
          - exactly 1 signer
          - a cert SHA-256 was parsed
          - the parsed cert (normalized) equals ExpectedCertSha256Normalized

        This intentionally does NOT consult VerifiedAny — a v1-only or
        v3-only signature must never be accepted even if those schemes verify.
#>
function Test-ApkSignerAcceptance {
    param(
        [hashtable]$Parsed,
        [string]$ExpectedCertSha256Normalized
    )
    if (-not $Parsed.V2LineFound) {
        return @{ Accepted = $false; Reason = 'no_v2_line' }
    }
    if ($Parsed.VerifiedV2 -ne $true) {
        return @{ Accepted = $false; Reason = 'v2_not_true' }
    }
    if ($Parsed.NumberSigners -ne 1) {
        return @{ Accepted = $false; Reason = "signers=$($Parsed.NumberSigners)" }
    }
    if (-not $Parsed.CertSha256) {
        return @{ Accepted = $false; Reason = 'no_cert' }
    }
    $certNorm = ConvertTo-NormalizedHash $Parsed.CertSha256
    if ($certNorm -ne $ExpectedCertSha256Normalized) {
        return @{ Accepted = $false; Reason = 'cert_mismatch' }
    }
    return @{ Accepted = $true; Reason = 'ok' }
}
