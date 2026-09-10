# TAVO-MINI 角色视觉资产改造方案（PDCA）

> 文档用途：指导开发 Agent 对现有“角色卡构建 + 资料库角色卡”进行端到端改造。
> 改造目标：支持“上传人物图片 → 多模态 LLM 识别 → 生成角色卡 → 可选保存为角色图片 → 资料库预览/更换/删除”，并保持现有纯文本构建、世界书、预设、导入导出能力不受影响。
> 适用项目：TAVO-MINI / ShineWriter 当前主线版本。
> 开发机目录：**不固定，不在本文档中写死**。开发 Agent 应以当前打开的 Git 仓库根目录为准。
> 方法：PDCA（Plan → Do → Check → Act）闭环。
> 强制要求：包含自动化测试、Android Release/Debug 构建验证及模拟器真实交互测试。

---

## 0. 改造边界

本次改造必须严格控制范围，避免把一个“角色图片能力”演变成全局媒体系统重构。

### 0.1 本次必须完成

1. 在“独立构建 → 角色卡”中支持上传 **1 张人物参考图**。
2. 支持：
   - 仅图片生成角色卡；
   - 图片 + 文字共同生成角色卡；
   - 纯文字生成角色卡保持原行为。
3. 图片真正进入多模态 LLM 请求，不得只做本地预览。
4. 用户文字设定优先于图片识别结果。
5. 当前模型不支持或未确认支持视觉输入时，必须显式阻止发送，禁止静默丢图。
6. 图片生成角色卡成功后，用户保存角色到资料库时，可选择把参考图保存为角色图片。
7. 资料库角色卡：
   - 有图时显示角色图片预览；
   - 无图时显示占位；
   - 支持添加 / 更换 / 删除角色图片。
8. 如资料库角色列表已有适合的卡片位，可增加缩略图；不能为了缩略图重构整个资料库列表。
9. 删除角色时清理对应图片文件。
10. 更换角色图片成功后清理旧图片文件。
11. 构建过程中的临时图片不得因为保存失败、取消、替换而长期残留。
12. 多模态消息、Provider 序列化、能力判断、Token 估算、错误处理、日志与隐私保护都必须完成端到端适配。
13. 完成全量回归和 Android 模拟器验收。

### 0.2 本次明确不做

1. 不给世界书、预设、作家风格增加图片输入。
2. 不支持一次上传多张人物图片。
3. 不实现相机拍照能力。
4. 不实现在线图片 URL 抓取。
5. 不实现图片裁剪、抠图、美颜、滤镜、AI 修图。
6. 不建立通用相册或媒体库。
7. 不把图片二进制/Base64 写进角色卡 JSON、数据库正文、日志、埋点或备份正文。
8. 不对角色卡标准协议做破坏性修改。
9. 不改变现有 CharaCardV3 适配逻辑的核心语义。
10. 不把“人物图片”强行解释为人物真实身份信息。
11. 不因为当前改造而重写整个 LLM Provider 层。
12. 不因该功能顺带升级大版本或修改版本号，除非另有明确要求。
13. 不新增无必要的图片选择依赖；优先复用现有文件选择与 RNFS 能力。
14. 不在未验证前自动宣称任意 OpenAI-Compatible 模型支持视觉。

---

# P — Plan：规划与设计

## 1. 目标用户流程

最终应形成以下闭环：

```text
角色卡独立构建
    ↓
上传人物参考图（可选）
    ↓
本地预览
    ↓
用户补充文字设定（可选）
    ↓
检查当前模型视觉能力
    ↓
发送多模态请求
    ↓
LLM 返回角色卡结构化 JSON
    ↓
现有角色卡适配/预览流程
    ↓
保存到资料库
    ↓
如“保存为角色图片”开启：
将临时参考图复制到永久角色图片目录
    ↓
资料库角色卡列表/详情显示图片
    ↓
可查看大图 / 更换 / 删除
```

核心原则：

```text
用户明确文字
    >
图片中直接可观察事实
    >
模型合理补全
```

不得反向覆盖。

---

## 2. 现有架构基线

开发前必须先确认当前主线代码，不能仅根据本文档机械改文件。

重点检查现有模块：

- `src/screens/BuildScreen.tsx`
- `src/services/construction/targets.ts`
- `src/services/constructionAiGenerator.ts`
- `src/services/llm/types.ts`
- `src/types/llmProvider.ts`
- `src/services/llm/openAICompatibleProvider.ts`
- `src/services/llm/providerCapabilities.ts`
- `src/utils/tokenEstimator.ts`
- `src/services/fileImport.ts`
- `src/types/novel.ts`
- `src/store/settingsStore.ts`
- 角色资料库列表页面
- 角色详情/编辑页面
- 角色保存、删除、导入、导出相关 repository/service
- 数据库 schema 与 migration
- Android 原生权限与文件访问配置
- 现有 Jest / 单元测试 / 集成测试目录

如仓库在改造前已发生重构，应以**现有职责**为准迁移方案，而不是为了贴合本文档恢复旧结构。

---

## 3. 数据模型设计

## 3.1 构建阶段临时视觉引用

不要把 Base64 放进 React State 或 `ConstructionInput`。

建议定义：

```ts
export interface CharacterVisualReference {
  localPath: string;
  name: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  size?: number;
}
```

构建页面只保存轻量元数据。

### 生命周期

```text
选择图片
  ↓
复制/获得 cache 临时文件
  ↓
CharacterVisualReference
  ↓
点击生成时再读取 Base64
  ↓
请求完成/失败/取消后仍可保留当前选择供用户再次生成
  ↓
用户替换/移除/离开页面时清理临时副本
  ↓
只有保存角色并开启“保存为角色图片”时才转为永久资产
```

需要根据现有 picker 的 `keepLocalCopy` 行为确认临时文件所有权。

---

## 3.2 ConstructionInput 保持语义纯净

`ConstructionInput` 应继续表达“用户希望生成什么角色”。

图片属于生成请求附件，不属于角色语义 DTO。

建议把视觉引用放在生成参数：

```ts
export interface GenerateOptions {
  maxTokens: number;
  signal?: AbortSignal;

  // 其他现有参数保持
  visualReference?: CharacterVisualReference;
}
```

调用示意：

```ts
generateConstruction(input, {
  maxTokens,
  signal,
  visualReference: selectedCharacterImage ?? undefined,
});
```

仅允许：

```text
character_independent + visualReference
```

进入图片生成逻辑。

其他 mode 即使错误传入图片，也应：
- 开发环境显式告警；
- 生产逻辑忽略或阻止；
- 不发送给 Provider。

---

## 3.3 永久角色图片资产

沿用项目现有角色图片机制，不另造一套协议。

如果当前角色卡已经通过类似：

```ts
__tavo.imagePath
```

保存图片路径，则继续使用。

永久文件建议统一位于现有：

```text
DocumentDirectoryPath/character-images/
```

目录。

如当前实际实现不同，应复用当前正式目录。

### 文件名要求

避免直接使用用户原始文件名。

建议：

```text
character_<character-id-or-uuid>_<timestamp>.<ext>
```

或项目现有 UUID 命名策略。

必须避免：

- `../../`
- 特殊路径字符
- 文件名冲突
- 同名覆盖其他角色图片

---

## 4. LLM 多模态消息抽象

## 4.1 内部统一消息格式

当前 `ChatMessage.content` 若仅支持字符串，需要升级为：

```ts
export interface LLMTextContentPart {
  type: 'text';
  text: string;
}

export interface LLMImageContentPart {
  type: 'image';
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  base64: string;
}

export type LLMMessageContent =
  | string
  | Array<LLMTextContentPart | LLMImageContentPart>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: LLMMessageContent;
}
```

关键约束：

1. Build 层不得出现 OpenAI 私有 `image_url` 格式。
2. Construction 层只构造平台无关的 `image` part。
3. Provider 负责协议序列化。
4. Provider 返回值继续统一转换成字符串文本。
5. 不得在任何 debug log 中打印 Base64。

---

## 4.2 OpenAI-Compatible Provider 序列化

内部：

```ts
{
  role: 'user',
  content: [
    { type: 'text', text: '...' },
    {
      type: 'image',
      mimeType: 'image/jpeg',
      base64: '...'
    }
  ]
}
```

Provider 转为 OpenAI-Compatible 请求：

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "..."
    },
    {
      "type": "image_url",
      "image_url": {
        "url": "data:image/jpeg;base64,..."
      }
    }
  ]
}
```

仅 Provider 层允许知道：

```text
image_url
data:image/...;base64,
```

---

## 5. 视觉能力模型

TAVO 支持用户自定义：

- base_url
- api_key
- model_name
- provider

因此不能只靠模型名称字符串猜视觉能力。

建议给 LLM 配置新增：

```ts
type VisionSupportPreference =
  | 'auto'
  | 'supported'
  | 'unsupported';
```

数据库字段建议：

```text
vision_support
```

默认：

```text
auto
```

### 5.1 能力解析优先级

```text
用户明确配置
    ↓
官方/项目内已登记的精确 Provider + Model 能力
    ↓
unknown
```

最终解析：

```ts
type LLMProviderCapabilitySupport =
  | 'supported'
  | 'unsupported'
  | 'unknown';
```

`LLMProviderCapability` 增加：

```ts
supportsVision: LLMProviderCapabilitySupport;
```

### 5.2 禁止做法

禁止：

```ts
if (modelName.includes('gpt')) {
  supportsVision = true;
}
```

禁止仅凭：

- `vision`
- `vl`
- `4o`
- `gemini`
- `claude`

等名称片段给出 supported。

Generic OpenAI-Compatible 默认：

```text
unknown
```

### 5.3 用户体验

设置页建议：

```text
图片理解能力

○ 自动判断
○ 此模型支持图片输入
○ 此模型不支持图片输入
```

说明：

```text
部分第三方 OpenAI-Compatible 服务无法自动识别能力。
如确认当前模型支持图片，可手动开启。
```

---

## 6. 数据库迁移

如果 `LLMConfig` 持久化在 SQLite，必须正规 migration。

流程：

1. 检查当前数据库 schema version。
2. 新增下一版 migration。
3. 添加：
   ```text
   vision_support TEXT NOT NULL DEFAULT 'auto'
   ```
4. 读取旧数据库时自动获得 `auto`。
5. 确保已有用户配置不丢失。
6. 设置保存/恢复/复制模型配置时包含新字段。
7. 如存在导出设置功能，评估是否应包含该字段。
8. 不允许通过删除数据库解决 migration。

需要测试：

- 空库新建；
- 老库升级；
- 多个已有模型配置升级；
- 激活模型不变化；
- API Key 不变化；
- 默认值正确。

---

## 7. 角色卡构建页面 UI

仅修改“独立构建 → 角色卡”。

### 7.1 推荐布局

在文本输入字段前或“外貌”字段附近增加：

```text
角色参考图（可选）

┌──────────────────────┐
│                      │
│      图片预览区域      │
│                      │
└──────────────────────┘

[添加图片]

选择后：
[更换图片] [移除]

☑ 保存为角色图片
```

说明文案：

```text
AI 将识别人物的外貌、服饰、饰品、装备和视觉风格，
用于补充角色设定。文字设定与图片推断冲突时，
以你的文字设定为准。
```

隐私提示：

```text
图片仅在点击“生成角色卡”时发送给当前配置的 LLM。
```

对于“保存为角色图片”：

```text
开启后，保存角色卡到资料库时会将该图片保存为角色图片。
```

### 7.2 默认行为

- 未选择图片：
  - 不显示删除；
  - “保存为角色图片”可隐藏或置灰。
- 选中图片：
  - 默认勾选“保存为角色图片”。
- 用户移除图片：
  - 自动清空该开关状态。
- 更换图片：
  - 新图片替换旧临时引用；
  - 旧 cache 文件按所有权规则清理。

---

## 8. 图片选择限制

第一版：

| 项目 | 限制 |
|---|---|
| 数量 | 1 张 |
| JPEG | 支持 |
| PNG | 支持 |
| WebP | 支持 |
| GIF | 不支持 |
| SVG | 不支持 |
| HEIC/HEIF | 第一版不支持 |
| 最大大小 | 20 MB |
| 在线 URL | 不支持 |
| 相机 | 不支持 |

需要在选择后验证：

1. MIME；
2. 扩展名只作辅助；
3. 文件存在；
4. 文件大小；
5. RNFS 可读。

错误示例：

```text
暂不支持该图片格式，请选择 JPEG、PNG 或 WebP。
```

```text
图片不能超过 20 MB，请更换较小的图片。
```

---

## 9. 生成按钮可用条件

旧逻辑可能类似：

```text
hasText
```

新逻辑：

```text
hasText || hasImage
```

允许：

```text
只有图片，无任何文本
```

生成角色卡。

但在真正调用 LLM 前必须检查：

```text
如果 hasImage
  → resolvedVisionSupport 必须是 supported
```

若为：

```text
unsupported
unknown
```

阻止生成。

推荐提示：

```text
当前模型未确认支持图片识别。
请切换支持视觉输入的模型，
或在模型配置中确认“支持图片输入”。
```

不能：

```text
自动删掉图片后继续发纯文字请求
```

否则用户会误以为图片被模型识别。

---

## 10. 角色生成 Prompt

现有角色 Prompt 基础上增加视觉规则。

建议核心要求：

```text
如果用户提供人物参考图片：

1. 只依据图片中可直接观察到的视觉信息补充角色资料；
2. 优先分析：
   - 发型、发色
   - 可见面部特征
   - 体态、身形轮廓、姿势
   - 服装款式、颜色、材质、层次
   - 饰品
   - 武器、工具、装备
   - 表情
   - 整体视觉风格
   - 可明确观察的时代/职业视觉线索
3. 可把视觉信息主要用于：
   - appearance
   - identity
   - abilities
   - behavior_habits
   等合适字段；
4. 用户文字与图片推断冲突时，以用户文字为准；
5. 不得把无法从图片确认的背景、人格、动机、关系、
   种族/民族、宗教、疾病、真实身份等写成图片事实；
6. 可进行小说创作所需的合理补全，但要与用户设定一致，
   不得声称这些补全来自图片。
```

输出协议仍保持当前角色 JSON schema。

不要新增“图片分析报告”字段进入正式角色卡。

---

## 11. 单次多模态生成

坚持：

```text
一次 LLM 请求
```

完成图片理解 + 角色卡生成。

不采用：

```text
第 1 次请求：图片分析
第 2 次请求：根据分析生成角色
```

原因：

- 多一次 API 成本；
- 增加延迟；
- 增加失败点；
- 图片信息在中间文本总结中会损失；
- 两次生成可能互相偏移。

除非未来经真实 Provider 兼容性验证必须拆分，本次禁止两阶段架构。

---

## 12. Token 估算

现有 Token 估算如果按：

```ts
estimateTokens(message.content)
```

必须修改。

对于数组消息：

```text
text part → 正常估算
image part → 不把 Base64 字符数当文本 token
```

第一版建议：

```ts
estimateMessageTokens(message) {
  if (typeof content === 'string') ...
  for each part:
      text → estimateTokens(part.text)
      image → 0 或独立未知预算
}
```

不得把 5 MB Base64 算成数百万文本 token。

界面若显示 token 估值，可注明图片 token 不计入当前文本估算。

---

## 13. 图片读取时机

禁止选择图片后立刻：

```ts
RNFS.readFile(path, 'base64')
```

长期保存在页面 State。

正确：

```text
选图
  ↓
仅保存 localPath / mime / size
  ↓
用户点击生成
  ↓
立即读取 Base64
  ↓
构建请求对象
  ↓
发送
  ↓
释放大字符串引用
```

避免：

- 页面重渲染携带巨大 Base64；
- React DevTools 暴露；
- 状态持久化误保存；
- 内存峰值长时间存在。

---

## 14. 资料库角色图片设计

## 14.1 角色详情/编辑页面

有图：

```text
┌────────────────────────────┐
│                            │
│        角色图片预览          │
│                            │
└────────────────────────────┘

[查看大图]  [更换图片]  [删除图片]
```

无图：

```text
┌────────────────────────────┐
│         暂无角色图片         │
│                            │
│          [添加图片]          │
└────────────────────────────┘
```

### 交互

#### 查看大图
- 全屏 Modal 或项目现有图片预览方式；
- 保持比例；
- contain 模式；
- 可关闭；
- 不要求手势缩放作为第一版硬条件。

#### 更换图片
1. 选择新文件；
2. 验证 MIME / 大小；
3. 复制到永久目录；
4. 成功更新角色数据；
5. 再删除旧文件。

必须采用：

```text
先新后旧
```

不能先删旧图再保存新图。

#### 删除图片
1. 二次确认；
2. 更新角色元数据；
3. 删除文件；
4. UI 回到无图占位。

如果文件本身不存在：
- 元数据仍允许清理；
- 不阻塞角色卡打开。

---

## 14.2 资料库角色列表缩略图

如果当前列表结构允许，增加：

```text
有图 → 显示缩略图
无图 → 显示原默认角色图标
```

约束：

- 固定缩略图尺寸；
- `cover` 或现有统一模式；
- 不改变列表主要信息层级；
- 图片加载失败 fallback 默认图标；
- 不为此引入复杂缓存框架。

如果当前列表 UI 结构修改成本明显过高，可以在本次实现中将“详情大图预览”设为 MUST，“列表缩略图”设为 SHOULD，但必须在最终报告说明原因。

---

## 15. 从构建页保存角色时的图片转正

场景：

```text
参考图片临时路径：
Caches/.../picked-image.jpg
```

用户生成角色卡并保存：

### 保存为角色图片 = ON

流程：

1. 先保存/获得角色唯一标识；
2. 创建永久目标路径；
3. 复制临时图到永久角色图片目录；
4. 更新角色的图片元数据；
5. 提交角色保存；
6. 成功后保留永久文件；
7. 清理临时 cache。

注意事务顺序。

如果第 3~5 步失败：

- 不得留下错误元数据；
- 不得让角色指向不存在路径；
- 尽量清理新创建的孤儿文件。

### 保存为角色图片 = OFF

- 角色保存不记录图片；
- 临时图片按页面生命周期清理。

---

## 16. 角色删除与孤儿文件治理

角色删除时：

```text
获取 imagePath
  ↓
删除角色数据
  ↓
删除对应文件
```

或根据当前 repository 事务能力：

```text
先记录 imagePath
→ 完成 DB 删除
→ best-effort 删除文件
```

不要因为图片文件已经不存在导致角色删除失败。

### 更换角色图片

```text
复制新图
  ↓
角色元数据更新成功
  ↓
删除旧图
```

如旧图删除失败：
- 记录非敏感错误；
- 不回滚已经成功的新图。

---

## 17. PNG 角色卡导入兼容

现有 PNG 角色卡导入可能同时承担：

1. 读取 PNG 内嵌角色卡元数据；
2. 将 PNG 本身作为角色图片保存。

本次不得破坏。

需要回归：

```text
旧 PNG 角色卡导入
  ↓
元数据解析正常
  ↓
角色保存正常
  ↓
资料库详情能显示 PNG 图片
```

“上传人物参考图生成角色卡”与“导入 SillyTavern PNG 角色卡”是两个概念。

不得共用错误的解析入口。

---

## 18. 日志、隐私与安全

必须确保：

### 禁止记录

- Base64；
- data URL；
- 图片文件二进制；
- 完整 LLM request body；
- 用户图片本地完整路径（如果日志会上传）；
- API Key。

允许记录：

```text
mime=image/jpeg
size=123456
hasVisualReference=true
provider=xxx
visionSupport=supported
```

如当前日志层原则是“不记录 prompt/body”，继续保持。

---

## 19. Provider 错误处理

多模态请求可能收到：

```text
400
422
unsupported content type
image input not supported
invalid image_url
unsupported modality
```

需要归类为尽可能明确的用户错误。

例如：

```text
当前模型或服务端拒绝了图片输入。
请确认模型支持视觉能力，或更换模型后重试。
```

### 禁止自动降级

收到图片不支持错误时，不允许：

```text
catch → 去掉图片 → 自动重试
```

因为会改变用户请求语义。

---

# D — Do：实施步骤

## 20. Phase D1：代码基线与保护

Agent 开始修改前：

1. `git status`
2. 记录当前 branch / commit
3. 检查未提交修改
4. 不覆盖用户已有修改
5. 搜索角色构建调用链
6. 搜索角色图片已有实现
7. 搜索 LLMConfig 数据库字段及 migration
8. 搜索所有 `ChatMessage.content` 使用点
9. 搜索 token estimator 使用点
10. 搜索 provider capability resolver
11. 搜索角色删除路径
12. 搜索资料库列表和详情页

必须先形成影响面清单再编辑。

---

## 21. Phase D2：多模态底层

建议顺序：

1. 扩展 `ChatMessage`。
2. 修复 TypeScript 编译错误。
3. 更新 token estimator。
4. 更新 OpenAI-Compatible serialization。
5. 增加视觉 capability。
6. 增加 LLMConfig `vision_support`。
7. 完成 DB migration。
8. 设置 UI 加入视觉能力配置。
9. 单测底层。

此时暂不改 Build UI。

---

## 22. Phase D3：角色构建

1. 定义临时 `CharacterVisualReference`。
2. 复用现有 Documents Picker + RNFS。
3. 增加 MIME/大小验证。
4. BuildScreen 增加选图预览。
5. 修改 generate enabled 条件。
6. 生成前做视觉 capability guard。
7. 点击生成时读取 Base64。
8. `buildConstructionMessages` 支持文本 + 图片 part。
9. 更新角色 system prompt。
10. 保持现有 JSON 解析、repair、adapter 流程。
11. 增加“保存为角色图片”选项。
12. 保证用户取消/替换/离开页面后的 cache 清理。

---

## 23. Phase D4：资料库视觉资产

1. 定位角色详情/编辑页。
2. 增加图片预览区域。
3. 增加查看大图。
4. 增加添加图片。
5. 增加更换图片。
6. 增加删除图片。
7. 建立或复用统一角色图片 service。
8. 角色删除时清理图片。
9. PNG 导入使用同一正式存储入口。
10. 如果结构合适，在列表增加缩略图。

尽量避免多个页面各自实现：

```text
copy/delete/path validation
```

应抽一个小而稳定的角色图片资产服务。

例如职责：

```ts
saveCharacterImage(...)
replaceCharacterImage(...)
deleteCharacterImage(...)
getCharacterImageUri(...)
validateCharacterImage(...)
```

不要扩展成通用媒体中心。

---

## 24. Phase D5：保存链整合

角色构建保存时：

```text
GeneratedCharacter
+ selected image
+ saveImageAsCharacterImage
```

共同进入保存逻辑。

确保：

```text
图片失败
```

不会造成：

```text
角色保存了一半
```

或：

```text
图片写入成功但角色未保存
```

需要设计补偿清理。

---

# C — Check：验证与测试

## 25. TypeScript / 静态检查

至少执行仓库已有命令中的等价项：

```bash
npm run typecheck
npm run lint
```

如果命令名称不同，使用 `package.json` 实际脚本。

要求：

```text
0 TypeScript errors
0 新增 lint errors
```

不能通过：

- `any`
- `@ts-ignore`
- 全局 eslint disable

掩盖设计问题。

---

## 26. 单元测试

必须新增/更新测试。

### 26.1 ChatMessage

测试：

```text
string content
text parts
text + image parts
```

保持旧文本 API 兼容。

### 26.2 OpenAI-Compatible serializer

断言：

```text
内部 image
→ image_url
→ data:<mime>;base64,<data>
```

JPEG/PNG/WebP 分别覆盖。

保证：

```text
system/user text-only
```

序列化完全不退化。

### 26.3 Token estimator

构造：

```text
10 字文本 + 超长 Base64
```

断言估算不会随 Base64 长度线性暴涨。

### 26.4 Vision capability

覆盖：

```text
auto + known supported
auto + known unsupported
auto + unknown
manual supported
manual unsupported
```

优先级正确。

### 26.5 DB migration

覆盖：

- 旧版本库；
- 新版本库；
- 默认 `auto`；
- 老 LLMConfig 不丢字段。

### 26.6 图片验证

覆盖：

```text
jpg <20MB → pass
png <20MB → pass
webp <20MB → pass
gif → reject
svg → reject
heic → reject
>20MB → reject
不存在文件 → reject
```

### 26.7 Construction

覆盖：

```text
纯文字角色生成
仅图片
图片+文字
```

检查：

- 仅独立角色接收 image；
- 世界书不接收；
- 预设不接收。

### 26.8 模型不支持视觉

选择图片：

```text
supportsVision=unsupported
```

断言：

- 不调用 Provider；
- 显示明确错误。

选择图片：

```text
supportsVision=unknown
```

也不得静默发送。

### 26.9 用户优先级 Prompt

断言 Prompt 包含：

```text
用户文字高于图片推断
```

以及禁止错误推断规则。

### 26.10 角色图片资产

覆盖：

- save；
- replace；
- delete；
- 文件不存在；
- 复制失败；
- DB 保存失败后的补偿清理。

---

## 27. 集成/回归测试

至少运行：

```bash
npm run test:ci
```

如仓库存在：

```bash
npm run verify
```

也应执行。

必须确认以下老功能：

| 功能 | 预期 |
|---|---|
| 独立角色纯文本构建 | 不变 |
| 世界书独立构建 | 不变 |
| 角色基于世界书 | 不变 |
| 世界书基于角色 | 不变 |
| TXT 构建 | 不变 |
| 预设构建 | 不变 |
| 作家风格 | 不变 |
| 角色卡导入 | 不变 |
| PNG 角色卡导入 | 不变 |
| 角色卡导出 | 不变 |
| LLM 普通文本聊天请求 | 不变 |
| 推理/Thinking 能力 | 不变 |
| Abort/取消生成 | 不变 |
| 生成错误提示 | 不退化 |

---

# Android 模拟器测试

## 28. 构建前检查

根据当前仓库脚本：

```bash
npm install
```

仅在依赖确有变化时。

然后：

```bash
npm run typecheck
npm run lint
npm run test:ci
```

Debug 构建：

```bash
cd android
gradlew assembleDebug
```

Release 构建根据仓库现有脚本：

```bash
npm run apk:release
```

或：

```bash
cd android
gradlew assembleRelease
```

以项目真实签名配置为准，不创建新的 release signing key。

---

## 29. 模拟器环境

优先使用项目已有 Android Emulator/AVD。

测试至少覆盖：

- Android 当前项目主要目标版本；
- 建议一个较新 API；
- 如当前已有 Release AVD，继续复用。

安装 Debug 或 Release APK。

启动前可执行：

```bash
adb logcat -c
```

测试期间持续观察：

```bash
adb logcat
```

关注：

```text
FATAL EXCEPTION
AndroidRuntime
OutOfMemoryError
FileNotFoundException
SecurityException
ReactNativeJS
Unhandled promise rejection
```

---

## 30. 模拟器手工验收用例

### CASE A：纯文字角色卡

1. 打开构建。
2. 进入独立角色卡。
3. 不选择图片。
4. 输入原有角色设定。
5. 生成。

通过标准：

- UI 不要求图片；
- 生成与改造前一致；
- 请求仍是纯文本；
- 无视觉能力提示干扰。

---

### CASE B：选图预览

1. 添加 JPEG。
2. 观察预览。
3. 更换 PNG。
4. 移除。
5. 再选择 WebP。

通过：

- 不崩溃；
- 预览比例正常；
- 替换立即更新；
- 移除后状态清空；
- 无旧图残留 UI。

---

### CASE C：格式限制

选择：

- GIF；
- HEIC；
- >20 MB 图片。

通过：

- 明确提示；
- 不进入生成；
- 不崩溃。

---

### CASE D：仅图片生成

1. 清空所有文字输入。
2. 选择一张人物图。
3. 使用已明确支持视觉的模型。
4. 生成。

通过：

- 生成按钮可用；
- Provider 收到 image；
- 角色卡正常生成；
- appearance 等字段合理产生。

---

### CASE E：图文共同生成

文字明确指定：

```text
角色设定：黑发
```

选择一张明显浅色头发的人物图。

通过：

```text
最终设定以“黑发”文字为准。
```

不能被视觉推断覆盖。

---

### CASE F：未知视觉能力

1. 模型设置为 `auto`。
2. 使用 Generic OpenAI-Compatible，能力 unknown。
3. 选择图片。
4. 点击生成。

通过：

- 请求未发出；
- 提示去模型配置确认；
- 不偷偷转纯文字。

---

### CASE G：手动确认视觉能力

1. 把该模型设置为“支持图片输入”。
2. 回到构建。
3. 再次生成。

通过：

- 允许发送；
- 请求包含图片。

---

### CASE H：服务端拒绝图片

使用一个实际不接受图片的 endpoint，或用测试 mock。

通过：

- 明确提示“模型/服务拒绝图片输入”；
- 不自动无图重试；
- App 不崩。

---

### CASE I：保存为角色图片

1. 图片 + 文字生成角色。
2. “保存为角色图片”保持开启。
3. 保存到资料库。
4. 打开该角色。

通过：

- 图片可显示；
- App 重启后仍显示；
- 清理 Android cache 后仍显示；
- 证明不是引用 cache 路径。

---

### CASE J：不保存图片

1. 图片生成角色。
2. 关闭“保存为角色图片”。
3. 保存。

通过：

- 角色卡存在；
- 资料库显示无角色图；
- 临时文件可被清理。

---

### CASE K：资料库添加图片

打开一个旧的无图角色：

1. 添加图片。
2. 返回。
3. 重新进入。
4. 重启 App。

通过：

- 图片持久存在；
- 角色文本无变化。

---

### CASE L：更换图片

1. 有旧图角色。
2. 选择新图。
3. 保存。
4. 重进页面。

通过：

- 新图存在；
- 旧图不再引用；
- 老文件得到清理。

---

### CASE M：删除图片

1. 删除角色图片。
2. 确认。
3. 重开角色。

通过：

- 角色仍存在；
- 图片为空；
- 文件被删除。

---

### CASE N：删除角色

1. 记录角色图片文件。
2. 删除角色。
3. 检查文件目录。

通过：

- 角色删除；
- 对应角色图片不再残留。

---

### CASE O：PNG 角色卡导入

1. 使用原有带角色元数据的 PNG 卡。
2. 导入。
3. 打开资料库。

通过：

- 角色数据正常；
- PNG 图片正常显示；
- 不被误走“AI 图片分析”逻辑。

---

### CASE P：快速反复操作

执行：

```text
选图
→ 更换
→ 删除
→ 再选
→ 生成
→ 取消
→ 再生成
```

通过：

- 无崩溃；
- 无明显内存异常；
- 无错误图片错位；
- 无重复请求。

---

## 31. 模拟器日志验收

完成测试后检查：

```bash
adb logcat -d
```

不允许出现：

```text
FATAL EXCEPTION
OutOfMemoryError
未捕获 JS 异常
图片 Base64 明文
API key
完整 request body
```

如果有既存 Android warning：

- 记录；
- 判断是否本次引入；
- 非本次问题不得伪装成本次已修复。

---

## 32. Release APK 验收

不能只跑 Metro Debug。

必须至少完成一次 Release APK：

```text
assembleRelease
```

并在模拟器或测试机完成：

1. 安装；
2. 冷启动；
3. 构建页打开；
4. 选图；
5. 角色保存；
6. 资料库图片预览；
7. App 重启；
8. Crash marker 检查。

Release 与 Debug 行为需一致。

---

# A — Act：收尾、修正与封板

## 33. 问题分类

验收发现问题后分为：

### P0
- 崩溃；
- 角色数据损坏；
- API Key 泄漏；
- 图片 Base64 落日志；
- 删除角色误删别的文件；
- DB migration 失败。

必须修复。

### P1
- 图片根本没送进 LLM；
- unknown 模型仍发送图片；
- 图片保存后重启消失；
- 旧功能回归失败；
- PNG 导入坏掉；
- 更换图片留下错误引用。

必须修复。

### P2
- UI 间距；
- 图片占位细节；
- 文案；
- 缩略图裁切。

尽量修复，不能影响 P0/P1 收口。

---

## 34. 清理与重构

在功能通过后进行一次有限收口：

1. 删除重复图片路径逻辑；
2. 删除无用临时代码；
3. 删除 console 调试；
4. 检查 Base64 不进入 log；
5. 检查没有新增无必要依赖；
6. 检查不存在未处理 Promise；
7. 检查图片 asset service 职责不过度扩张；
8. 检查没有世界书/预设意外支持图片。

不要在 Act 阶段顺带做大型架构重构。

---

## 35. 最终回归

最终必须再次执行：

```text
typecheck
lint
unit tests
test:ci
verify（如存在）
Debug Android build
Release Android build
模拟器核心流程
```

修复后的代码必须重新完整测试，不能拿修复前结果充当最终结果。

---

# 36. 验收标准

以下全部成立才算完成。

## 功能

- [ ] 独立角色构建支持选择 1 张 JPEG/PNG/WebP。
- [ ] 支持仅图片生成。
- [ ] 支持图片 + 文字生成。
- [ ] 纯文本角色生成无回归。
- [ ] 用户文字优先于图片。
- [ ] 图片真正进入 LLM 多模态请求。
- [ ] unknown/unsupported 模型不会发送图片。
- [ ] 用户可手动确认模型视觉能力。
- [ ] 保存角色时可选择是否保存参考图片。
- [ ] 图片永久保存后不依赖 cache。
- [ ] 角色详情可预览图片。
- [ ] 角色详情可添加图片。
- [ ] 角色详情可更换图片。
- [ ] 角色详情可删除图片。
- [ ] 删除角色会清理角色图片。
- [ ] PNG 角色卡导入继续正常。
- [ ] 资料库列表缩略图在结构允许时完成，或明确说明未纳入原因。

## 架构

- [ ] Build 层不出现 OpenAI `image_url` 协议。
- [ ] Base64 不进入 ConstructionInput。
- [ ] Base64 不长期进入 React State。
- [ ] Base64 不进入 DB。
- [ ] Base64 不进入日志。
- [ ] Provider 层负责多模态协议序列化。
- [ ] Token estimator 不计算 Base64 文本长度。
- [ ] capability 不依靠模糊模型名猜测。
- [ ] DB migration 正规完成。

## 质量

- [ ] TypeScript 通过。
- [ ] Lint 通过。
- [ ] 单测通过。
- [ ] test:ci 通过。
- [ ] verify 通过（如存在）。
- [ ] Debug APK 构建成功。
- [ ] Release APK 构建成功。
- [ ] 模拟器冷启动成功。
- [ ] 模拟器 CASE A-P 完成。
- [ ] 无新增 crash。
- [ ] 无敏感日志。
- [ ] 现有世界书/预设/TXT/作家风格无回归。

---

# 37. Agent 最终交付报告格式

开发 Agent 完成后必须输出以下报告，不接受只说“已完成”。

## 1. 改动摘要

```text
实现了哪些用户能力
```

## 2. 修改文件

逐个列出：

```text
文件
修改目的
关键逻辑
```

## 3. 数据库变化

```text
旧 schema version
新 schema version
新增字段
默认值
迁移验证结果
```

## 4. 多模态请求

必须展示**脱敏后的结构**：

```json
{
  "role": "user",
  "content": [
    {
      "type": "text"
    },
    {
      "type": "image_url",
      "image_url": {
        "url": "data:image/jpeg;base64,<redacted>"
      }
    }
  ]
}
```

严禁报告真实 Base64。

## 5. 测试结果

列出实际执行命令：

```text
command
PASS / FAIL
```

禁止只写“测试通过”。

## 6. Android 模拟器验收

按 CASE A-P 报告：

```text
CASE
结果
证据/现象
```

## 7. Release 验收

```text
Release APK build
install
cold start
main flow
crash
```

## 8. 已知限制

如实记录：

```text
哪些 Provider 尚无法自动识别视觉能力
是否未做列表缩略图
哪些图片格式暂未支持
```

## 9. Git 状态

```text
git status
当前 branch
当前 commit
是否存在未提交文件
```

---

# 38. 实施原则总结

本次改造的核心不是“在 UI 上加一个上传按钮”，而是建立一条受控、可回归的角色视觉资产链：

```text
临时图片
→ 多模态模型理解
→ 角色卡生成
→ 用户确认
→ 图片资产转正
→ 资料库预览
→ 生命周期管理
```

同时必须维持以下不变量：

```text
文字优先
图片可选
模型能力显式
协议隔离
临时/永久文件分离
失败可恢复
旧功能不回归
Release + 模拟器验收
```

只有上述链路从 UI、LLM、数据、文件系统、资料库到 Android Release 全部闭环，本次改造才可以封板。
