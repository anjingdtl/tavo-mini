# Optimization baseline

## Immutable start state

- Captured: `2026-07-15T17:03:39+08:00`
- Initial commit: `67063bdb8bc493608fec4c6ae51b6555e78c1d71`
- Initial branch: `codex/data-reliability-optimization`
- Initial Git status: clean (`git status --porcelain=v1` produced no output)
- Node.js: `v25.2.1`
- Java:

  ```text
  java version "17.0.12" 2024-07-16 LTS
  Java(TM) SE Runtime Environment (build 17.0.12+8-LTS-286)
  Java HotSpot(TM) 64-Bit Server VM (build 17.0.12+8-LTS-286, mixed mode, sharing)
  ```

- Android SDK configured path (`android/local.properties`): `sdk.dir=C:\\Users\\Administrator\\AppData\\Local\\Android\\Sdk`
- Android SDK installed platform: `android-36`
- Android SDK installed Build Tools: `35.0.0`, `36.0.0`
- Package version: `2.4.3`
- `SCHEMA_VERSION`: `14` (`src/services/migrations/index.ts`)

## Required command evidence

Commands were run in the order below. Initial evidence capture completed at `2026-07-15T17:09:18+08:00`. The TypeScript command was re-verified deterministically at `2026-07-15T17:22:43+08:00`; that result supersedes the initial console-transport summary.

| Command | Exit | Result |
| --- | ---: | --- |
| `npm install` | 0 | Passed; postinstall reported `[patch-deps] All upstreams already match the expected shape.` |
| `npm run lint` | 1 | Failed; 1 error and 5 warnings. |
| `npx tsc --noEmit` | 2 | Fresh deterministic re-verification: 1,588 TypeScript diagnostics across 1,641 output lines. |
| `npm test -- --runInBand` | 0 | Passed: 64 suites / 293 tests. |
| `npm run apk:debug` | 1 | Failed before producing `ShineWriter-V2.4.3-debug.apk`. |
| `git diff --check` | 0 | Passed; no whitespace errors were reported. |

### `npm install` (exit 0)

```text
> ShineWriter@2.4.3 postinstall
> node scripts/patch-sqlite-storage-gradle.js && node scripts/patch-deps.js

[patch-deps] All upstreams already match the expected shape.

up to date, audited 933 packages in 28s
```

The command also reported 3 moderate audit vulnerabilities; it exited successfully and no remediation was attempted.

### `npm run lint` (exit 1)

```text
> ShineWriter@2.4.3 lint
> eslint .

D:\\ClaudeCodeWorkSpace\\projects\\tavo-mini\\__tests__\\databaseNoteConfigSchema.test.ts
  97:11  error  'createNoteConfig' is assigned a value but never used  @typescript-eslint/no-unused-vars

D:\\ClaudeCodeWorkSpace\\projects\\tavo-mini\\__tests__\\noteDualModeDb.test.ts
  30:17  warning  Unexpected use of '<<'  no-bitwise
  31:16  warning  Unexpected use of '&'   no-bitwise

D:\\ClaudeCodeWorkSpace\\projects\\tavo-mini\\src\\screens\\ChapterEditor.tsx
  396:5  warning  Expected 'undefined' and instead saw 'void'  no-void

D:\\ClaudeCodeWorkSpace\\projects\\tavo-mini\\src\\services\\database.ts
  3822:13  warning  Unexpected use of '<<'  no-bitwise
  3823:12  warning  Unexpected use of '&'   no-bitwise

✖ 6 problems (1 error, 5 warnings)
```

Cause: the unused `createNoteConfig` binding is an ESLint error; the remaining five diagnostics are warnings.

### `npx tsc --noEmit` (exit 2, deterministic re-verification)

The original baseline invocation was captured at `2026-07-15T17:09:18+08:00`, but its console-output transport conflated the 1,641 output-line count with the diagnostic count. A fresh invocation of the exact command at `2026-07-15T17:22:43+08:00` exited with `2`. Its complete output was counted before disposal: 1,588 lines matching `: error TS\\d+:` across 1,641 output lines. The following opening and closing diagnostics are verbatim evidence from the command output:

```text
__tests__/contextBuilderNoteMode.test.ts(86,28): error TS2339: Property 'resolve' does not exist on type 'NodeRequire'.
__tests__/contextBuilderNoteMode.test.ts(87,20): error TS2339: Property 'cache' does not exist on type 'NodeRequire'.
__tests__/contextBuilderNoteMode.test.ts(88,28): error TS2339: Property 'resolve' does not exist on type 'NodeRequire'.
__tests__/contextBuilderNoteMode.test.ts(89,20): error TS2339: Property 'cache' does not exist on type 'NodeRequire'.
...
src/services/pipelineRunner.ts(977,44): error TS2367: This comparison appears to be unintentional because the types '"full" | "conditional"' and '"twoStage"' have no overlap.
src/store/settingsStore.ts(20,7): error TS2739: Type '{ id: number; name: string; base_url: string; api_key: string; model_name: string; is_active: number; }' is missing the following properties from type 'LLMConfig': provider_type, local_model_id, local_backend, context_window, max_output_tokens
src/store/voiceStore.ts(83,63): error TS2739: Type '{ engine: TtsEngine; config: VoiceConfig; apiKey: string; systemConfig: SystemTtsConfig; isSynthesizing: false; isPlaying: false; activeTtsSessionId: null; ... 8 more ...; stop: () => Promise<...>; }' is missing the following properties from type 'VoiceState': playbackState, lastPlayEndedAt
```

Cause: the TypeScript invocation includes tests and vendored `android/app/jni/llama.cpp/tools/ui` sources that lack their dependency/type environments, in addition to application and test type incompatibilities (for example `LLMConfig`, voice settings, and navigation types). No source was changed.

### `npm test -- --runInBand` (exit 0)

```text
Test Suites: 64 passed, 64 total
Tests:       293 passed, 293 total
Snapshots:   0 total
Time:        27.584 s
Ran all test suites.
```

Console warnings were emitted by tests (including React `act(...)` environment warnings, expected foreground-service failure logging, and non-HTTPS LLM warnings), but Jest completed successfully.

### `npm run apk:debug` (exit 1)

Expected deliverable: `dist/apk/debug/ShineWriter-V2.4.3-debug.apk`.

Result: not produced. The existing APKs in `dist/apk/debug` predate this run; they are not evidence of a successful V2.4.3 build. The native intermediate `android/app/build/outputs/apk/debug/app-debug.apk` also predates this run.

```text
> Task :app:buildCMakeDebug[arm64-v8a] FAILED
C/C++: ninja: error: Stat(default-app-setup-build/safeareacontext_autolinked_build/CMakeFiles/react_codegen_safeareacontext.dir/D_/ClaudeCodeWorkSpace/projects/tavo-mini/node_modules/react-native-safe-area-context/common/cpp/react/renderer/components/safeareacontext/RNCSafeAreaViewShadowNode.cpp.o): Filename longer than 260 characters

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:buildCMakeDebug[arm64-v8a]'.
> com.android.ide.common.process.ProcessException: ninja: Entering directory `D:\\ClaudeCodeWorkSpace\\projects\\tavo-mini\\android\\app\\.cxx\\Debug\\3k4t5c4l\\arm64-v8a'
...
  ninja: error: Stat(default-app-setup-build/safeareacontext_autolinked_build/CMakeFiles/react_codegen_safeareacontext.dir/D_/ClaudeCodeWorkSpace/projects/tavo-mini/node_modules/react-native-safe-area-context/common/cpp/react/renderer/components/safeareacontext/RNCSafeAreaViewShadowNode.cpp.o): Filename longer than 260 characters

BUILD FAILED in 2m 11s
```

Cause: the Windows CMake/Ninja object filename exceeded the 260-character path limit. No APK byte size is available for V2.4.3 because the required delivery artifact was not produced.

### `git diff --check` (exit 0)

`git diff --check` completed with exit code 0 after the documentation update. Git emitted only line-ending conversion warnings for the working copy; it reported no whitespace errors.

## Baseline conclusion

The baseline is blocked. `npm run lint`, `npx tsc --noEmit`, and `npm run apk:debug` failed; no repair was attempted. Required build commands also left generated changes in `package-lock.json` and `src/constants/version.json`; they are outside this documentation-only change and are intentionally not staged or committed.
