# LiteRT-LM 本地离线模型技术 Spike 报告

**日期：** 2026-07-09  
**Spike 负责人：** 塔拉（AI Agent）  
**项目：** tavo-mini / shinewriter  
**LiteRT-LM 版本：** `com.google.ai.edge.litertlm:litertlm-android:0.14.0`

---

## 1. 目标

验证 LiteRT-LM Android SDK 能否在 tavo-mini 的 React Native 0.85.3 + Kotlin 2.1.20 + Gradle 构建体系中成功集成、编译、安装并启动到 Spike Activity。

## 2. 环境

- React Native：0.85.3
- Kotlin：2.1.20（项目锁定）
- Gradle/AGP：项目现有版本
- LiteRT-LM：`0.14.0`（已锁定，不再使用 `latest.release`）
- 构建环境：Windows 11 + Android SDK + JDK 21
- 验证设备：x86_64 模拟器
- 测试模型：`gemma-4-E2B-it-Uncensored-MAX.litertlm`

## 3. 验证结果

| 验证项 | 结果 |
|--------|------|
| Gradle 构建 | **SUCCESS** |
| APK 安装 | **SUCCESS** |
| `LiteRtLmSpikeActivity` 启动 | **SUCCESS** |
| ABI | x86_64 emulator |
| GPU 后端 | ** hangs ** — 模拟器 SwiftShader 无真实 GPU，符合预期 |
| CPU 后端 | **engine creation aborts in `liblitertlm_jni.so`** — 使用测试模型 `gemma-4-E2B-it-Uncensored-MAX.litertlm` 时出现 native abort |

## 4. 关键发现

### 4.1 Kotlin 元数据版本不匹配

LiteRT-LM 0.14.0 使用 Kotlin metadata 2.3.0，而项目锁定 Kotlin 2.1.20（metadata 2.1.0）。直接编译报错：

```
Class 'com.google.ai.edge.litertlm.Engine' was compiled with an incompatible version of Kotlin.
```

当前保留编译期放宽参数：

```gradle
tasks.withType(org.jetbrains.kotlin.gradle.tasks.KotlinCompile).configureEach {
    compilerOptions {
        freeCompilerArgs.add("-Xskip-metadata-version-check")
    }
}
```

该参数为临时方案，后续应升级 Kotlin 到 2.2.x/2.3.x，或等待官方发布与 Kotlin 2.1.20 二进制兼容的 LiteRT-LM 版本。

### 4.2 运行时行为

- Spike Activity 能正常启动并进入推理协程。
- GPU 路径在模拟器上因无真实 GPU/SwiftShader 实现而挂起，属预期行为。
- CPU 路径在 `Engine` 创建阶段触发 `liblitertlm_jni.so` abort，怀疑与测试模型格式/兼容性有关，而非集成本身错误。

## 5. 结论

- **集成/编译/安装/启动：Go** — LiteRT-LM 0.14.0 可以成功加入项目、编译出 APK、安装到 x86_64 模拟器并启动 Spike Activity。
- **模型运行：No-Go** — 当前测试模型在模拟器 CPU 后端下无法完成引擎创建；GPU 在模拟器上也不可用。
- **后续必须动作：**
  1. 在目标真机（如 vivo X200 Pro）上使用已知可用的 `.litertlm` 模型重新验证 CPU/GPU 推理。
  2. 决定 Kotlin 元数据兼容方案：升级 Kotlin 或继续保留 `-Xskip-metadata-version-check` 临时标志。
  3. 确认生产用模型来源与格式要求。

## 6. 附录：关键文件

- `android/app/build.gradle`
- `android/app/proguard-rules.pro`
- `android/app/src/main/AndroidManifest.xml`
- `docs/superpowers/plans/2026-07-09-litertlm-local-model.md`
