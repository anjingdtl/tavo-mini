# Changelog

All notable changes to ShineWriter are documented here. This file follows the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Version
numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

No unreleased changes are currently recorded.

## [2.4.4] - 2026-07-16

### Added

- Added test-only migration/restore statement injection and real device flows for autosave kill, network interruption, and TTS background transitions.
- Added final per-flow Maestro/JUnit, logcat, UI-tree, screenshot, APK hash, and GitHub Actions evidence.

### Changed

- Node.js support is now `>=24.3.0`; CI uses Node 24.14.1.
- Jest CI and coverage run naturally without `--forceExit`, and GitHub Actions runs coverage once instead of executing the full suite twice.
- Backup publication now writes a staging file and atomically moves it into place after a successful write.
- The verification baseline is 82 Jest suites / 401 tests with 78.33% statements, 60.37% branches, 86.05% functions, and 79.95% lines.

### Fixed

- Autosave database failures propagate to exit guards and retain retryable pending state.
- Clearing chapter content now serializes with pending autosave and cannot be overwritten by a stale debounced write.
- Maestro selectors and navigation match the current Android UI, including API 37 compatibility prompts and deterministic pipeline cancellation.

### Known limitations

- `V2.4.4` is a Tag-only engineering release; no signed Release or Minified Release APK is attached because signing environment variables were unavailable.
- Migration-kill, restore-kill, GGUF-import-kill, and native OOM execution remain blocked by missing pause injectors/model assets; TTS background verification is partial because the API 37 emulator engine returned native error `-7` after playback began.
- API 37 reports a 16KB page-size/RELRO compatibility warning for native libraries; an ARM64 physical-device matrix remains required before distributing an RC APK.

### Security

- Fault-injection switches are test-only, cannot be enabled by remote input, and are disabled in Release builds.
- Release signing still requires process environment variables; no signing password, API key, or user database is committed.

### Removed

- No production capability was removed in V2.4.4.

## [2.4.3] - 2026-07-12

### Added

- Added Android llama.cpp local GGUF generation, import validation, progress reporting, cancellation, and local-model settings.
- Added Schema 14 runtime validation, note-mode compatibility repair, manifest-driven v3 backups, SHA-256 checksums, atomic restore, and external local-model references.
- Added TTS foreground keep-alive, unified notification permission handling, and background pipeline service timing fixes.

### Changed

- Release metadata is generated from `package.json`; Release signing requires explicit external environment variables.
- The database initialization path repairs known legacy defects before final schema validation.

### Fixed

- Fixed the legacy `project_note_config` upgrade path that could omit retrieval columns and make note-mode saving fail.
- Fixed world-book field preservation, background pipeline startup timing, and TTS foreground-service cleanup.

### Security

- Backup payloads do not contain LLM credentials; restoring a configuration clears any stale matching Keychain credential.

### Compatibility and upgrade risk

- Existing Schema 13 databases migrate to Schema 14. The startup repair path also handles databases that reached the current tables without all expected columns.
- Existing local GGUF files remain external assets and must be present or re-imported after restore; API keys must be entered again.

### Local model and API compatibility

- The supported local engine is Android llama.cpp with GGUF models. Online configuration remains OpenAI-compatible.

## [2.4.2] - 2026-07-11

### Added

- Added chapter-aware note navigation and chunking for the resource library.

### Changed

- Kept the database Schema unchanged from 2.4.1 while improving note retrieval context.

### Fixed

- Improved chapter selection and resource-library behavior for long notes.

### Security

- No new credential or network behavior was introduced in this release.

### Compatibility and upgrade risk

- No database migration is required from 2.4.1. Existing notes remain readable; chapter-aware indexing changes how long note content is presented to retrieval.

### Local model and API compatibility

- Local llama.cpp/GGUF and OpenAI-compatible API contracts remain unchanged.

## [2.4.1] - 2026-07-10

### Added

- Added stronger local-generation progress, startup, and failure feedback.

### Changed

- Hardened local-model generation controls, JNI concurrency/cancellation behavior, Qwen reasoning handling, and APK version-bundle validation.
- Kept the database Schema unchanged from 2.4.0.

### Fixed

- Fixed stale JavaScript bundles, cold-start pipeline results, inactive local configuration selection, and several local import/generation hangs.

### Security

- No new credential storage behavior was introduced in this release.

### Compatibility and upgrade risk

- No database migration is required from 2.4.0. Existing GGUF model records are retained; devices should re-test model loading after upgrading because native generation control changed.

### Local model and API compatibility

- GGUF models continue to use Android llama.cpp. OpenAI-compatible online endpoints remain supported.

## [2.4.0] - 2026-07-10

### Added

- Added the Android llama.cpp engine, JNI bridge, GGUF local-model manager, streaming generation, cancellation, and model lifecycle controls.
- Added TurboModule compatibility and regression coverage for the React Native 0.85 Android architecture.

### Changed

- Database Schema advanced from 12 to 13 for local-model metadata.
- The supported local-model path changed to GGUF + llama.cpp; the previous experimental local runtime was removed from the product path.

### Fixed

- Fixed native model-load/generation serialization, request cancellation races, model import state handling, and core TurboModule registration.

### Security

- Local GGUF inference runs on-device and does not require network access.

### Compatibility and upgrade risk

- Upgrading from 2.3.x runs the Schema 12→13 migration. Legacy local-model records may require re-import when their source file or runtime is no longer available.

### Local model and API compatibility

- Android supports `.gguf` models through llama.cpp. Online APIs remain OpenAI-compatible and are independent of the local engine.
