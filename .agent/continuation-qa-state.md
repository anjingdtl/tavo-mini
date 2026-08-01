# Continuation QA State

- Repository: D:\ClaudeCodeWorkSpace\projects\tavo-mini
- Base commit: 04e4dd7ec332042c069a533e62098a8214938dd2
- Current branch: main
- Current commit: e777ec1 (fix(continuation): clean stale style profiles before resume)
- Emulator serial: emulator-5554
- Emulator API: 36 (Android 16)
- Emulator model: sdk_gphone64_x86_64
- App version: V2.11.8 / versionCode 2110800
- Package: com.shinewriter
- Current phase: E (Canon) and F (performance); CAN-001/002/005/101/105/201 and PERF-001 PASS
- Active test case: completed; commit `a9dd320` pushed to `origin/main`
- Last successful command: 1M-context real DeepSeek run completed with Canon snapshot/style profile ready; no FATAL/OOM/ANR/SQLite UNIQUE
- Last failure: 50 MiB single-line import reproduced Android OOM; fixed with streaming line/chunk accounting and passed rerun
- Evidence directory: artifacts/qa/20260801-emulator-qa-2/FINAL-REAL-1M/
- Open bug IDs: none for the tested continuation scope
- Fixed: BUG-001 picker lifecycle; BUG-002 awaiting_review; BUG-003 failed copy orphans; BUG-004 evidence cleanup SQL; BUG-005 QA LLM config import; BUG-006 style JSON coercion; BUG-007 style retry UNIQUE; BUG-008 resume/cold-start style UNIQUE; BUG-009 ready style profile reuse; BUG-010 long-line import OOM
- Next exact command: none for this QA scope; future work can start from `a9dd320`
- Note: current branch is `main`; do not push secrets

## LLM test config (desensitized)

- base_url: https://api.deepseek.com
- model: deepseek-v4-flash
- api_key: stored in Android Keystore for the active LLM config; never log, print, or commit
- Prefer configure via App Settings UI; do not commit key

## Workspace notes

- Untracked (user): docs/LLMTesti.txt, docs/tavo-mini_续写模块_Android模拟器自动测试与修复长程执行计划.md
- Do NOT commit LLMTesti.txt or secrets
- Do NOT git reset --hard / clean -fd / force-push

## Completed

- [x] Read execution plan (full)
- [x] Read LLM test config (desensitized)
- [x] Environment check (node 24.18.1, npm 11.16.0, JDK 17, adb, emulator-5554 online)
- [x] Continue on existing main branch without resetting user history
- [x] Create .agent/continuation-qa-state.md

## Blocked

- [ ]

## Notes

- Plan baseline commit was 19d8679…; current HEAD is a9dd320
- Run-id: 20260801-emulator-qa-2
- CAN-101 evidence: stale failed and running profiles were cleaned before retry; analysis completed after cold start; no UNIQUE/FATAL/ReactNativeJS errors in final log
- CAN-002 evidence: `artifacts/qa/20260801-emulator-qa-2/CAN-002/`; run count stayed 1 and LLM config was restored after the test
- CAN-005 evidence: four contiguous real DeepSeek batches covered the 100K single chapter without gaps.
- CAN-105 evidence: `artifacts/qa/20260801-emulator-qa-2/CAN-105/`; malformed JSON did not create a UNIQUE/crash and ready style was preserved.
- CAN-201 evidence: `artifacts/qa/20260801-emulator-qa-2/CAN-201/`; force-stop recovery changed running to paused/queued and the resumed run completed.
- PERF-001 evidence: `artifacts/qa/20260801-emulator-qa-2/PERF-001/`; first-run OOM and fixed 50 MiB rerun are both captured, with 800 contiguous chunks.
- FINAL-REAL evidence: `artifacts/qa/20260801-emulator-qa-2/FINAL-REAL/`; real DeepSeek run completed with ready Canon/style records.
- FINAL-REAL-1M evidence: `artifacts/qa/20260801-emulator-qa-2/FINAL-REAL-1M/`; `context_window=1000000` preflight and real DeepSeek run completed with ready Canon/style records.
- Release evidence: `dist/apk/release/ShineWriter-V2.11.8-release.apk`; signature fingerprint and 16KB zipalign verified, SHA-256 `003E6911A96A52C1241DC120C8E4448B62C7C035A615E9B30E4BEAECF7D15810`.
