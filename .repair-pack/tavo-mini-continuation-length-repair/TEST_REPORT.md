# Code-level validation report

## Environment

- Node.js: v22.16.0
- TypeScript: 5.8.3
- Android emulator: not run, intentionally deferred to the local repository

## Focused logic suite

Command:

```bash
npm run typecheck
npm test
```

Results:

- TypeScript strict typecheck: passed
- Tests: 7 passed, 0 failed

Covered behavior:

1. Target 3000 resolves to inclusive 2500–3500 Han characters.
2. Punctuation, whitespace, numbers and Latin text are excluded from the Han count.
3. 2500 and 3500 pass; 2499 is under; 3501 is over.
4. Pure insertion patches (`start === end`) work at paragraph boundaries.
5. Mid-sentence insertions are rejected.
6. Raw full-text/summary output is not accepted as a patch.
7. Overlapping and duplicate insertion patches are rejected.
8. A 3000-Han valid chapter cannot be collapsed to 600 or pushed below the allowed band.
9. A safe first Repair may improve an under-length Writer candidate while leaving the optional user-triggered extra Repair available.

## Patch-construction validation

Command:

```bash
tests/test_patcher_fixture.sh
```

Results:

- Patch script applied successfully to a fixture matching the current source structure.
- Required Checker, Prompt Compiler and Runner changes were asserted.
- Generated fixture passed TypeScript syntax/type validation with repository-style module resolution.

## Not performed

- Full repository Jest suite: the execution environment cannot download/clone the repository or dependencies.
- Android build and emulator UI test: intentionally left for local follow-up.
- GitHub push/PR: blocked by the connected GitHub App returning HTTP 403 for all Git write endpoints.
