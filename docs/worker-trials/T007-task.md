# T007 提议：需求整理方法纳入版本化模板

任务稿 v1，**待用户确认，尚未获开发授权**。这是下一件真实自举开发候选，不是已派发任务。精确输入及 rev 见同目录 `T007-proposed-draft.json`；确认后保持输入不变。

## 目标

当前需求整理方法写在 Runtime 的 #draftPrompt 中，调整方法仍需改程序。把它迁入 Git 中可迭代的 requirements 模板；新整理固定当时 commit/path/version，在途任务与重启恢复继续使用原引用和原始提示。

此工作拟由现有工作台完整执行：真实 GitHub Issue → 只读整理 → 保存用户批准的精确稿 → 自动安排 Pi → 真实工作树与 Git → 实际 PR。最终验收/合并仍是独立用户操作，本次开发批准不等于合并批准。

## 范围与 Interface

- 沿用 `templates/catalog.yml` 与现有 TemplateAdapter，不创建第二套模板注册系统。
- 为模板增加可校验 role 元数据：旧模板缺省为 worker，requirements 模板必须为 draft；Runtime 永远以无工具 draft 角色启动需求整理。
- 新增 `templates/requirements/1.0.0.md`，迁移现有已实测规则，包含明确的 JSON 输出合同与实质待决策定义，不扩大权限。
- requestDraft 固定并持久记录 promptRef/版本及最终提示文本。方法升级只影响新请求，不改写运行中任务；旧记录可保守恢复。
- 保持模板 API 向后兼容；前端开发模板列表只列 worker 模板，develop 入口也拒绝把 draft 模板用于开发。
- 模板缺失或非法须给出具体阻塞，不用旧硬编码提示静默兜底。
- 改动限 Runtime、TemplateAdapter、catalog/requirements 模板、相关测试、合同及任务结果文档；不改凭据、系统服务或真实 PR 的合并状态。

## 验收

1. 从固定 Git commit 解析 requirements 模板，校验 id/role/version/path；原 development/research 模板保持可用。
2. 整理启动后切换默认版本，旧请求和重启接管仍保留旧 promptRef/文本，新请求采用新版本。
3. 非法/缺失模板不调用模型，展示具体原因；显式修复后可按原重试语义继续。
4. 无工具、严格 JSON、sourceRev/CAS/用户决定快照保护全部保留，迟到稿不能覆盖用户意图。
5. UI/HTTP 不能把 draft 模板用于 Worker 开发；模板文字或元数据不能增加工具、授予开发或合并权限。
6. 旧持久数据兼容；既有全量回归与真实 Pi 隔离闭环实际通过，并明确哪些 GitHub 行为使用替身。
7. 在临时 Git 仓库构造新版模板测试 fixture；不要依赖尚未提交的模板文件，也不要弱化固定 commit 读取规则来通过测试。

## 执行与权限

批准后才在 `ag-jin/auto-ai` 创建对应 Issue，按 JSON 的精确字段保存当前任务稿并核对 rev，再记录开发决定；源内容变化或稿件修改需要重新核对授权。

执行模型固定 Pi / deepseek-flash / high。每个 Worker 独立会话、任务分支与工作树。按实际项目规则运行检查，输出 summary/artifacts/evidence/blockers。范围内失败由主会话处理，不自动扩大到新功能。

只提交 PR 供实际验收，不代用户记录最终通过，也不合并。成功交付先保存证据再回收工作树。若用户暂缓或忽略，本任务不创建 Issue、不启动开发 Worker。
