# Release APK acceptance per docs/RELEASE_APK_BUILD.md "构建后验收".
# V2.5.14+: hard assertions only — every required check must throw on mismatch
# and the script returns a non-zero exit code. The previous version only printed
# output and threw on apksigner/zipalign exit codes; it never asserted the cert
# SHA-256, signer count, v2 scheme, package name, versionName or versionCode.
#
# V2.5.15+: the apksigner parser was extracted to `apk-verification-parsers.ps1`
# and the v2 acceptance was tightened. The old inline parser had a fallback that
# set VerifiedV2=true whenever ANY "Verified using vN scheme" line existed, so an
# APK signed with v1 only (v2: false) — or an output that omitted the v2 line —
# was wrongly accepted. VerifiedV2 now comes ONLY from the explicit
# "Verified using v2 scheme: true" line.
#
# V2.5.16+: the main flow MUST call `Test-ApkSignerAcceptance` for the accept/
# reject decision. Do NOT re-implement V2LineFound / VerifiedV2 / NumberSigners /
# CertSha256 comparisons as independent if/throw blocks here — that caused
# test/prod drift. The main script still owns: run apksigner, check exit code,
# call parser, call acceptance, fill summary, zipalign, aapt, APK SHA-256.
#
# Required checks (all throw on failure):
#   - APK exists at dist/apk/release/ShineWriter-V<versionName>-release.apk
#   - apksigner: exit 0, explicit v2 scheme line present, VerifiedV2 = true,
#     signers = 1,
#     cert SHA-256 = 017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a
#   - zipalign -c -P 16 -v 4: exit 0 + "Verification successful"
#   - aapt dump badging: package name=com.shinewriter,
#     versionName=version.json.versionName, versionCode=version.json.versionCode
#   - SHA-256 of the APK file is computed and printed
#
# No signing secrets are read or printed. No keystore is created. Debug signing
# is never accepted as a fallback.

#---
# Dot-source the shared parsing helpers (also exercised by the real-PowerShell
# Jest test). Keeping them out-of-line guarantees the test exercises the SAME
# parser the script uses, instead of a TS mirror that can drift.
#---
. "$PSScriptRoot/apk-verification-parsers.ps1"

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
# V2.5.16: SINGLE acceptance entry — all V2LineFound / VerifiedV2 /
# NumberSigners / CertSha256 decisions live in Test-ApkSignerAcceptance.
# Main script must not re-implement those hard asserts as independent if/throw.
$acceptance = Test-ApkSignerAcceptance `
    -Parsed $parsed `
    -ExpectedCertSha256Normalized $script:RELEASE_CERT_SHA256_NORM
if (-not $acceptance.Accepted) {
    throw "APK signer acceptance failed: $($acceptance.Reason). Output:`n$signerOutput"
}
$summary['Cert SHA-256'] = $acceptance.NormalizedCertSha256
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
