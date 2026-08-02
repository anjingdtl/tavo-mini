# tavo-mini continuation length/Repair patch bundle

This bundle implements the agreed continuation behavior:

- target Han-character length is controlled by the user's frozen `targetChapterChars`;
- accepted range is target ±500 Han characters;
- deterministic length checking runs alongside the existing LLM Checker;
- length and semantic issues are merged into the same Repair request;
- standard calls remain Writer → Checker → Repair;
- Repair supports paragraph-boundary insertion patches;
- invalid patch output never falls back to replacing the chapter with raw model text;
- the existing user-triggered one-time extra Repair remains the last step.

## Apply to a local checkout

```bash
python apply_continuation_length_repair.py /path/to/tavo-mini
cd /path/to/tavo-mini
npm run typecheck
npm test -- --runInBand __tests__/continuationLengthRepair.test.ts
```

Then run the repository's broader checks as appropriate:

```bash
npm run lint
npm run test:ci
```

## Files

- `apply_continuation_length_repair.py`: fail-fast source patcher for the current main-branch structure.
- `src/services/continuation/generation/continuationLengthContract.ts`: exact new source file.
- `src/services/continuation/generation/continuationRepairPatch.ts`: exact new source file.
- `tests/continuationLengthRepair.test.cjs`: isolated executable logic tests.
- `tests/test_patcher_fixture.sh`: patch-construction and TypeScript validation.
- `CONSTRUCTION_PLAN.md`: approved design/build plan.
- `TEST_REPORT.md`: validation evidence and remaining local checks.

The patcher refuses ambiguous or partially matching source changes. If upstream code has changed, rebase/review the affected blocks rather than forcing the script.
