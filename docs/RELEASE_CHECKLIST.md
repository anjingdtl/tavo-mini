# ShineWriter 正式 APK 发版检查清单

详细命令和验收规则见 [RELEASE_APK_BUILD.md](RELEASE_APK_BUILD.md)。本清单用于发版前逐项勾选，不能用历史日志代替当前提交的结果。

## 准备

- [ ] 工作区和远端基线已核对，非本次改动已隔离。
- [ ] keystore 存在于 `android/keystores/tavo-mini-release.keystore`。
- [ ] `SHINE_WRITER_RELEASE_STORE_FILE` 已指向当前仓库 keystore；User/Process 变量均无旧路径。
- [ ] alias 为 `tavo-mini-release`。
- [ ] 四项 `SHINE_WRITER_RELEASE_*` 环境变量均存在，密码没有出现在脚本或日志。
- [ ] keystore 证书 SHA-256 为 `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`。

## 版本与质量

- [ ] 使用 `npm version $nextVersion --no-git-tag-version --ignore-scripts` 同步 `package.json` 和 `package-lock.json`（`$nextVersion` 替换为实际版本）。
- [ ] 已运行 `npm run prebuild`，没有手改 `src/constants/version.json`。
- [ ] `CHANGELOG.md`、`README.md` 已更新当前版本、APK 文件名和 versionCode。
- [ ] `npm run verify:version` 通过。
- [ ] `npm run verify` 通过。

## 构建与验收

- [ ] `npm run apk:release` 成功。
- [ ] 产物位于 `dist/apk/release/ShineWriter-V<版本>-release.apk`。
- [ ] `scripts/verify-release-apk.ps1` 通过：v2、signer、证书、zipalign、包名、版本和 APK SHA-256 均通过。
- [ ] `adb install -r` 成功，设备可冷启动，且没有启动崩溃。
- [ ] 未执行卸载或清空应用数据，用户已保存章节正文保留。

## 提交与交付

- [ ] `package-lock.json` 在暂存区，且与 `package.json` 版本一致。
- [ ] 测试报告已加入提交（如本轮要求）。
- [ ] 未提交 APK、keystore、密码、数据库、截图或日志产物。
- [ ] 提交号、推送分支、APK 路径、版本、证书指纹和仍存在的问题已记录。
