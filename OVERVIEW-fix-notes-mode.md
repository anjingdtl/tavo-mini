# 资料-笔记双模式持久化 + 风格画像注入修复

## 改了什么

| 文件 | 改动 |
|---|---|
| `src/screens/ResourceLibrary.tsx` | 移除调试 self-test `useEffect`（依赖 `[currentProject?.id]`，每次进资料页覆盖 mode 为 `none`）和配套 `console.log` |
| `src/services/contextBuilder.ts` | `buildStyleContext` 的 `Promise.all` 改为 `Promise.allSettled` + 过滤，单条笔记风格分析失败不再拖垮整体注入；`trace.reason` 体现失败计数 |
| `__tests__/noteModePersistence.test.ts` (新增) | 3 组回归测试 |

## 为什么改

**问题 1：模式自动回退到「禁用」**
上一位开发为定位笔记模式持久化 bug 加了一段 self-test 在 `ResourceLibrary.tsx`，每次项目切换就执行 `set style → set retrieval → set none`，最终 mode 永远被覆盖为 `none`。这种「调试代码忘了删」是 mobile 项目最常见的 bug 类型之一。

**问题 2：风格画像不进 context**
两个原因叠加：
1. self-test 把 mode 改没了，写作时调 `buildNoteContext` 走的是 `buildNoteContextOriginal` 分支（注入原文）而不是 `buildStyleContext`（注入画像）
2. 即使 mode 保留，`buildStyleContext` 用 `Promise.all`，只要任一笔记风格分析抛错（空内容 / LLM 报错）整个就拒绝，悄悄回退到原始全量注入

## 验证

| 项 | 结果 |
|---|---|
| Jest 全套 | 35 套件 169 测试全过 |
| 新增回归测试 | 3 组全过：模式持久化 / 单条失败不影响整体 / 全 weight=0 不误注入 |
| Lint | 通过 |
| 模拟器（Pixel_10 Android 16）端到端 | mode=仿写 → 切项目 tab → 回资料：mode 仍为仿写 ✓<br>mode=资料库 → 切项目 tab → 回资料：mode 仍为资料库 ✓ |

## Commit

`fa4566c fix(notes): 修复资料笔记模式持久化与风格画像鲁棒注入`

`git push origin main` 已推送。