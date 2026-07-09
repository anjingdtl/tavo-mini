# LiteRT-LM 本地离线模型 Validation 报告

**日期：** 2026-07-09  
**负责人：** 塔拉（AI Agent）  
**项目：** tavo-mini / shinewriter  
**LiteRT-LM 版本：** `com.google.ai.edge.litertlm:litertlm-android:0.14.0`

---

## 1. 验证范围

本报告对应 Implementation Plan `docs/superpowers/plans/2026-07-09-litertlm-local-model.md` Phase 7 Task 7.5（真机验证）与 Task 7.6（最终回归）。

## 2. 已完成的验证

| 检查项 | 结果 | 备注 |
|--------|------|------|
| `npm test` | 待执行 | 见第 4 节 |
| `npm run lint` | 待执行 | 见第 4 节 |
| `npm run apk:release` | 待执行 | 见第 4 节 |
| LiteRT-LM 依赖锁定 | 完成 | `android/app/build.gradle` 中固定为 `0.14.0` |
| ProGuard keep 规则 | 完成 | `android/app/proguard-rules.pro` 已添加 |
| Spike Activity 清理 | 完成 | 已删除并注销 Manifest |
| README/CHANGELOG 文档 | 完成 | 已补充本地模型说明 |

## 3. 待真机补测项

以下验证必须在目标真机（如 vivo X200 Pro 或等效设备）上使用**已知可用的 `.litertlm` 模型**完成：

- [ ] 导入测试：从文件选择器导入 `.litertlm`，SHA-256 校验通过，数据库记录正确。
- [ ] GPU 后端测试：真机 GPU 能否成功创建引擎并生成中文文本。
- [ ] CPU 后端测试：GPU 不可用时回退 CPU 是否正常。
- [ ] 取消测试：生成过程中点击取消，推理任务是否真正中断。
- [ ] 飞行模式生成测试：关闭网络后，本地模型配置仍可生成文本。
- [ ] App 重启恢复测试：重启应用后已导入模型状态是否仍显示为 ready。
- [ ] 删除保护测试：模型被 LLM 配置引用时，删除操作是否被阻止并给出提示。
- [ ] Release APK 测试：release 包在真机上安装并运行本地模型。

## 4. 回归测试记录

- `npm test`：**PASS** — 50 suites / 244 tests passed（存在既有 `act(...)` 环境警告，非本次引入）。
- `npm run lint`：**PASS** — 0 errors，5 warnings（均为既有代码中的 `no-bitwise` / `no-void` 警告，非本次引入）。
- `npm run apk:release`：**FAIL** — 构建在 `:app:validateSigningRelease` 失败，错误：`Keystore file '.../android/keystores/tavo-mini-release.keystore' not found for signing config 'release'`。该失败与 LiteRT-LM 代码/模型无关，系 release 签名文件缺失。Debug 构建或补充 keystore 后可再次验证。

## 5. 已知限制与风险

1. **Kotlin 元数据版本不匹配**  
   LiteRT-LM 0.14.0 使用 Kotlin metadata 2.3.0，项目 Kotlin 2.1.20 为 metadata 2.1.0。当前通过 `-Xskip-metadata-version-check` 编译期绕过，属于临时方案。

2. **模拟器运行时问题**  
   x86_64 模拟器上 GPU 路径因 SwiftShader 挂起，CPU 路径在 `liblitertlm_jni.so` 中 abort。该问题需要在真机上用已知好模型重新验证，以区分是模型兼容性问题还是集成问题。

3. **Release 构建 ProGuard**  
   已增加 `-keep class com.google.ai.edge.litertlm.** { *; }`，但 release 包仍须在真机上实际加载模型后才能确认无反射/JNI  stripping 问题。

## 6. 结论

- **文档与清理：完成** — Phase 7 中所有文档、依赖锁定、代码清理任务已落地。
- **真机运行时验证：阻塞中** — 受限于当前无可用真机/已知好模型，CPU/GPU 实际推理尚未验证。
- **建议：** 在获取目标真机和确认可用模型后，按第 3 节清单补测，并回填第 4 节回归结果。
