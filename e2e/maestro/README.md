# Maestro E2E flows

These flows exercise the 16 Phase 4.3 acceptance checkpoints against the Android package `com.shinewriter`.

Run them on a disposable emulator with Maestro installed:

```text
maestro test e2e/maestro/01-first-start.yaml
maestro test e2e/maestro/02-writing-lifecycle.yaml
maestro test e2e/maestro/03-resource-library.yaml
maestro test e2e/maestro/04-backup-restore.yaml
maestro test e2e/maestro/05-llm-configuration.yaml
maestro test e2e/maestro/06-pipeline-cancel.yaml
```

`01-first-start.yaml` uses `clearState: true` and must only run on a disposable test device. The remaining flows preserve state and are intended to run in the order above. They use stable React Native `testID` selectors for editable fields and semantic Chinese labels for buttons and tabs.

Checkpoint mapping:

| Checkpoint                                 | Flow |
| ------------------------------------------ | ---- |
| 首次启动                                   | 01   |
| 新建项目、章节、正文、退出、重进并确认正文 | 02   |
| 角色集合、角色、世界书                     | 03   |
| 创建备份、修改后恢复、确认正文恢复         | 04   |
| 配置在线 LLM、测试连接                     | 05   |
| 流水线开始、取消、失败提示                 | 06   |

The current Windows QA environment has an Android emulator and adb but no Maestro binary. Until Maestro is installed, the first six writing checkpoints are verified through the adb/UI-tree smoke path; the YAML remains the portable CI/device runner.
