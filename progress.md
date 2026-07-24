# ShineWriter 进度交接

> 最后更新：2026-07-25（V2.5.22 发版完成）
> 状态：**V2.5.22 已完成**。「构建」模块正式上线并完成回归，未发现代码缺陷；Release APK 已构建。

## 版本进度

- **V2.5.22（2026-07-25）**：「构建」模块正式上线（底部导航第五个 Tab，用在线 OpenAI 兼容 LLM 独立生成可移植角色卡与多条目世界书），资料库「AI 一键生成」入口下线并收敛至此。回归通过，Release APK 已构建。
- **V2.5.21（2026-07-24）**：父合集「合集启用」开关展示来源修正（只读项目级配置）；AI 一键生成提示词框滚动修复。
- **V2.5.20（2026-07-23）**：角色 / 世界书 / 笔记的项目级父合集开关独立持久化；Schema 升级至 18。
- **V2.5.17**：多阶段流水线修订收口（Phase 0–4）；LLM 设置页改「上下文长度」时可联动同步流水线各阶段 Max Tokens。
- **V2.5.16**：多阶段流水线修订启动。

详见各版本 [`CHANGELOG.md`](CHANGELOG.md) 与 [`README.md`](README.md)。

---

## 多阶段流水线修订（Phase 0–4，已完成）

- 修正 4 模式（noReview / twoStage / conditional / full）的阶段依赖：twoStage / conditional 串行，full 仅 review ∥ factCheck 并行。
- 引入共享上下文快照 `PipelineContextSnapshot`、分区 token 预算裁剪、初稿后二次本地召回。
- LLM 设置页新增「上下文长度」「最大输出 Token」输入框，改上下文长度时弹窗确认是否按 50/15/15/20 比例同步流水线各阶段 Max Tokens。
- 单元测试、类型检查、Lint、Debug 与 Release 构建全部通过。

> 详细的内部穿测记录（设备标识、模型配置、token 数据、各阶段耗时与返回示例、验收产物路径等）保存在本地未跟踪文档 `PROGRESS-INTERNAL.md`，不纳入仓库。
