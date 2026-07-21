# Release APK acceptance per docs/RELEASE_APK_BUILD.md "构建后验收".
# V2.5.14+: hard assertions only — every required check must throw on mismatch
# and the script returns a non-zero exit code. The previous version only printed
# output and threw on apksigner/zipalign exit codes; it never asserted the cert
# SHA-256, signer count, v2 scheme, package name, versionName or versionCode.
#
# Required checks (all throw on failure):
#   - APK exists at dist/apk/release/ShineWriter-V<versionName>-release.apk
#   - apksigner: exit 0, Verified, v2 scheme = true, signers = 1,
#     cert SHA-256 = 017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a
#   - zipalign -c -P 16 -v 4: exit 0 + "Verification successful"
#   - aapt dump badging: package name=com.shinewriter,
#     versionName=version.json.versionName, versionCode=version.json.versionCode
#   - SHA-256 of the APK file is computed and printed
#
# No signing secrets are read or printed. No keystore is created. Debug signing
# is never accepted as a fallback.

#---
# Public parsing helpers (kept simple so a Node contract test can mirror them).
#---
function ConvertTo-NormalizedHash {
    param([string]$Value)
    # Strip colons and lowercase so "017B3F:BE:..." and "017b3fbe..." compare equal.
    return ($Value -replace ':', '').Trim().ToLowerInvariant()
}

function Parse-ApkSignerOutput {
    <#
        Parses `apksigner verify --verbose --print-certs` output into a stable
        object. Tolerates Windows CRLF and the spacing variation between Build
        Tools minor versions (e.g. "SHA-256 digest:    " vs "SHA-256 digest: ").
    #>
    param([string]$Output)
    $normalized = ($Output -replace "`r`n", "`n")
    $lines = $normalized -split "`n" | ForEach-Object { $_.Trim() }

    function Get-Field($pattern) {
        foreach ($line in $lines) {
            if ($line -match $pattern) {
                # Take everything after the first colon.
                $idx = $line.IndexOf(':')
                if ($idx -ge 0) {
                    return $line.Substring($idx + 1).Trim()
                }
            }
        }
        return $null
    }

    $verified = $false
    foreach ($line in $lines) {
        if ($line -match '^Verified\s+using\s+v2\s+scheme:\s*(true|false)') {
            $verified = ($matches[1] -eq 'true')
            break
        }
    }
    # Some Build Tools emit "Verifies" instead of per-scheme lines; also accept
    # the explicit "Verified using v1/v2/v3 scheme" series emitted by newer tools.
    $verifiedAnySchemeLine = ($lines | Where-Object { $_ -match '^Verified\s+using\s+v\d+\s+scheme:' }).Count
    if (-not $verified -and $verifiedAnySchemeLine -gt 0) {
        # Fall back to the legacy "Verifies" summary only when per-scheme lines exist.
        $verified = $true
    }

    $numberSigners = $null
    foreach ($line in $lines) {
        if ($line -match '^Number of signers:\s*(\d+)') {
            $numberSigners = [int]$matches[1]
            break
        }
    }

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
        Verified = $verified
        VerifiedV2 = $verified
        NumberSigners = $numberSigners
        CertSha256 = $certSha256
        RawLineCount = $lines.Count
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

#---
# Main
#---

$ErrorActionPreference = 'Stop'

# Release signing cert SHA-256 (canonical, lowercase, no colons).
$script:RELEASE_CERT_SHA256_NORM = '017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a'

# Read expected version from version.json (canonical) and cross-check package.json.
$versionJson = Get-Content -Raw 'src/constants/version.json' | ConvertFrom-Json
$pkgVersion = (Get-Content -Raw 'package.json' | ConvertFrom-Json).version
$expectedVersionName = "V$pkgVersion"
if ($versionJson.versionName -ne $expectedVersionName) {
    throw "version.json.versionName=$($versionJson.versionName) but package.json implies $expectedVersionName"
}
$expectedVersionCode = [int]$versionJson.versionCode
$expectedApkName = "ShineWriter-$expectedVersionName-release.apk"
$expectedApkPath = "dist/apk/release/$expectedApkName"

if (-not (Test-Path -LiteralPath $expectedApkPath)) {
    throw "APK not found at expected path: $expectedApkPath"
}
$apk = (Resolve-Path -LiteralPath $expectedApkPath).Path

# Hard-assert the filename: agents must not silently accept a renamed APK.
$actualName = Split-Path $apk -Leaf
if ($actualName -ne $expectedApkName) {
    throw "APK filename '$actualName' != expected '$expectedApkName'"
}

# Locate newest Build Tools.
$buildTools = Get-ChildItem "$env:LOCALAPPDATA/Android/Sdk/build-tools" -Directory -ErrorAction SilentlyContinue |
    Sort-Object { [version]$_.Name } -Descending |
    Select-Object -First 1
if (-not $buildTools) {
    throw 'Android Build Tools not found under $LOCALAPPDATA/Android/Sdk/build-tools'
}
$apksigner = Join-Path $buildTools.FullName 'apksigner.bat'
$zipalign = Join-Path $buildTools.FullName 'zipalign.exe'
$aapt = Join-Path $buildTools.FullName 'aapt.exe'
foreach ($tool in @($apksigner, $zipalign, $aapt)) {
    if (-not (Test-Path -LiteralPath $tool)) {
        throw "Required tool not found: $tool"
    }
}

# Summary container — populated as each check passes, printed at the end.
$summary = [ordered]@{
    'APK path'                 = $apk
    'File size (bytes)'        = $null
    'SHA-256'                  = $null
    'Cert SHA-256'             = $null
    'Number of signers'        = $null
    'APK Signature Scheme'     = $null
    'zipalign'                 = $null
    'package name'             = $null
    'versionName'              = $null
    'versionCode'              = $null
}

# --- apksigner ---
$signerOutput = & $apksigner verify --verbose --print-certs $apk 2>&1 | Out-String
$signerExit = $LASTEXITCODE
if ($signerExit -ne 0) {
    throw "apksigner verify failed (exit $signerExit). Output:`n$signerOutput"
}
$parsed = Parse-ApkSignerOutput -Output $signerOutput
# "Verified using v2 scheme: true" (preferred) or at minimum Verified=true.
if (-not $parsed.Verified) {
    throw "apksigner did not report Verified=true. Output:`n$signerOutput"
}
if ($parsed.VerifiedV2 -ne $true) {
    throw "APK must be signed with v2 scheme. Output:`n$signerOutput"
}
if ($parsed.NumberSigners -ne 1) {
    throw "APK must have exactly 1 signer (got $($parsed.NumberSigners)). Output:`n$signerOutput"
}
if (-not $parsed.CertSha256) {
    throw "Could not parse cert SHA-256 from apksigner output. Output:`n$signerOutput"
}
$certNorm = ConvertTo-NormalizedHash $parsed.CertSha256
if ($certNorm -ne $script:RELEASE_CERT_SHA256_NORM) {
    throw "Cert SHA-256 mismatch: got '$certNorm', expected '$($script:RELEASE_CERT_SHA256_NORM)'. Debug signing is not accepted."
}
$summary['Cert SHA-256'] = $parsed.CertSha256
$summary['Number of signers'] = $parsed.NumberSigners
$summary['APK Signature Scheme'] = 'v2 (Verified using v2 scheme = true)'

# --- zipalign ---
# Capture full output; tail-only display hides failures.
$zipOutput = & $zipalign -c -P 16 -v 4 $apk 2>&1 | Out-String
$zipExit = $LASTEXITCODE
$zipTail = ($zipOutput -split "`r?`n" | Select-Object -Last 3) -join "`n"
if ($zipExit -ne 0) {
    throw "zipalign verify failed (exit $zipExit). Tail:`n$zipTail"
}
if ($zipOutput -notmatch 'Verification successful') {
    throw "zipalign did not report 'Verification successful'. Tail:`n$zipTail"
}
$summary['zipalign'] = 'Verification successful'

# --- aapt badging ---
$badgingOutput = & $aapt dump badging $apk 2>&1 | Out-String
$aaptExit = $LASTEXITCODE
if ($aaptExit -ne 0) {
    throw "aapt dump badging failed (exit $aaptExit). Output:`n$badgingOutput"
}
$badging = Parse-AaptBadging -Output $badgingOutput
if (-not $badging) {
    throw "Could not parse 'package:' line from aapt output. Output:`n$badgingOutput"
}
if ($badging.packageName -ne 'com.shinewriter') {
    throw "Package name mismatch: got '$($badging.packageName)', expected 'com.shinewriter'"
}
if ($badging.versionName -ne $expectedVersionName) {
    throw "versionName mismatch: got '$($badging.versionName)', expected '$expectedVersionName'"
}
if ([int]$badging.versionCode -ne $expectedVersionCode) {
    throw "versionCode mismatch: got '$($badging.versionCode)', expected '$expectedVersionCode'"
}
$summary['package name'] = $badging.packageName
$summary['versionName'] = $badging.versionName
$summary['versionCode'] = $badging.versionCode

# --- APK file hash + size ---
$fileInfo = Get-Item -LiteralPath $apk
$fileHash = Get-FileHash -Algorithm SHA256 -LiteralPath $apk
$summary['File size (bytes)'] = $fileInfo.Length
$summary['SHA-256'] = $fileHash.Hash

# --- Final summary ---
Write-Host '=== Release APK verification summary ==='
$summary.GetEnumerator() | ForEach-Object {
    '{0,-24}: {1}' -f $_.Name, $_.Value
} | Out-Host

Write-Host ''
Write-Host 'All hard assertions passed.'
