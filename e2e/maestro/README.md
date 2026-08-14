# Maestro E2E flows

These 14 flows cover the current ShineWriter Android package `com.shinewriter`.
They target stable `testID` / `accessibilityLabel` selectors. Chinese text is
used only to assert user-visible results.

Run them on a disposable emulator with Maestro installed:

```text
maestro test e2e/maestro/01-first-start.yaml
maestro test e2e/maestro/02-writing-lifecycle.yaml
maestro test e2e/maestro/03-resource-library.yaml
maestro test e2e/maestro/04-backup-restore.yaml
maestro test e2e/maestro/05-llm-configuration.yaml
maestro test e2e/maestro/06-pipeline-cancel.yaml
maestro test e2e/maestro/07-continuation-import.yaml
maestro test e2e/maestro/08-continuation-canon-analysis.yaml
maestro test e2e/maestro/09-continuation-generate-and-adopt.yaml
maestro test e2e/maestro/10-continuation-check-and-repair.yaml
maestro test e2e/maestro/11-continuation-state-rebuild.yaml
maestro test e2e/maestro/12-continuation-style-overview.yaml
maestro test e2e/maestro/13-phase2-resource-context.yaml
maestro test e2e/maestro/14-third-phase-writer-style.yaml
```

None of these flows use `clearState`. Always upgrade-install with
`adb install -r` so Android Keystore LLM keys and the local database survive.
`01-first-start.yaml` only asserts the current 作品库 and tab IDs.

| Flow | Current journey |
| --- | --- |
| 01 | First start → 作品库 and tab IDs |
| 02 | Create outline project, add chapter, persist body |
| 03 | ResourceLibrary characters / worldbook / Writer Style tab |
| 04 | Backup then restore chapter body |
| 05 | LLM configuration and LAN HTTP confirm |
| 06 | Chapter AI generate / stop and pipeline task center |
| 07 | Continuation project + TXT import CTA |
| 08 | Continuation Canon analysis or import gate |
| 09 | Continuation workspace + AI generate control |
| 10 | Continuation check/repair entry surfaces |
| 11 | Continuation 定稿 control |
| 12 | Continuation style / 文风 config |
| 13 | Writer Style tab + Context Preview V2 |
| 14 | Structured Writer Style editor |
