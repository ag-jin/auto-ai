# T005A 结果：Runtime 返修 1

- run_id：`T005A-r1-20261117T172202Z`
- attempt：2
- requirements_rev：`sha256:d8ddb3923979fa45d126fb67d78c146b10da45e63ed8e172d775ca39e4f4871c`
- template_ref：`65b382157786298b5608798e68c2dc6e14e28a68:templates/development/1.2.0.md`
- 基线：检查点 `8ff81b7`（旧执行已取消，工作树已保存，不是完成）
- 未 commit / 未 push：按任务要求由主会话提交

## summary

在检查点主体上按失败函数定位修复，没有重写整个 Runtime。原 12 项专项中失败的 4 项与三项独立复现现在全部通过；专项扩到 15 项，全量 `npm test` 78 项通过。

1. **并发合并只发送一次，返回值结构统一**（`src/runtime.mjs`）
   - 新增按候选串行化的合并状态机 `#serializeMerge`：intent 检查、源刷新、验收核对、写意图、发命令整段在同一候选的在途 Promise 内执行；不同候选各自队列，互不阻塞。
   - tick 的 pending intent 只读核验与显式 merge 共用同一队列，并在锁内重读 intent 文件，避免旧 pending 写覆盖新 merged。
   - 删除混用的 `#intentResponse`：`#reconcileIntent` 与 `#recordMergeResult` 统一返回 `{merged:true,mergeSha}` 或 `{merged:false,pending:true,note}`。
   - 候选已 completed 时，从持久 run 结果 `result.merge.mergeSha` 恢复 SHA 并回写 intent，修复“recordMerged 已提交、intent 未写成 merged”的重启窗口；显式请求本次即返回 `{merged:true,mergeSha}`，与 `getState` 一致。

2. **准备中断可恢复**（`src/runtime.mjs`）
   - `#prepareRun` 只在 `control.prepare.status === 'prepared'` 时跳过；`preparing` 记录视为仅写了意图，重跑 workspace.create / packet / prompt 写入。
   - WorkspaceAdapter 对同 runId 已存在 manifest 时复用同一工作树，因此创建前、创建后（prepared 记录写入前）中断都能续跑，不再读 undefined 的 packetPath 误入 blocked，也不会留下第二棵无人关联的工作树。

3. **确认终止后同步持久终态**（`src/runtime.mjs`）
   - 新增 `#markSpawnState`：`#pollRun` 读到 failed/cancelled，或 `cancelRun` 确认 cancelled/failed 时，把 `control.spawn.status` 写成终态后再阻塞 Run，retry 不再被过期 `unknown`/`starting` 拒绝；仍 unknown 时继续 `#hold` 保留占用与工作树。

4. **测试 fixture 与预期修正**（`test/runtime.test.mjs`）
   - `FakeGitHub.overrideIssue` 同步更新收集列表，使列表与单条读取对真实 GitHub 观测一致；旧稿因 sourceRev 变化被 discarded，手工稿 CAS 不被覆盖。
   - 并发用例的第 3 个 Issue 改由 `OTHER_REPO` 的收集器返回，并显式把 `dep/repo` 配进 repositories/rules；未放松串仓与规则检查。
   - 合并用例不再假设“正文恢复即可合并”：保留授权失效事实（decision/pinnedTemplate/reviews 清空、draftStale），正向合并改用独立的候选 #2 重新走整理→确认→执行→PR→双角色验收→合并。

5. **新增回归用例（13–15）**：并发显式 merge + tick 只发送一次并读回真实 SHA；recordMerged 后 intent 未 flush 的重启恢复；准备中断两窗口的幂等恢复与工作树复用。

## artifacts

- `src/runtime.mjs`（+150/-38 区间改动，仅合并、准备、终态同步相关函数）
- `test/runtime.test.mjs`（fixture 一致性、用例 4/9 预期修正、新增用例 13–15）
- `docs/worker-trials/T005A-result.md`（本文件）
- 证据目录：`/Users/linguojin/Workspace/auto-ai/github-first/.auto-ai/worker-evidence/T005A-r1-20261117T172202Z/`

未改动 `package.json`、`public/`、模板、合同、其他测试；未改 HTTP/UI、WorkspaceAdapter、真实 PR。

## evidence

| 对象 | 命令/方法 | 结果 | 入口 |
| --- | --- | --- | --- |
| 专项测试 | `node --test test/runtime.test.mjs`（Node v22.23.1） | passed，15/15（原 12 项中 4 项原失败已修复，新增 3 项） | `runtime-special.log` |
| 全量测试 | `npm test`（`node --test`） | passed，78/78 | `npm-test.log` |
| 并发合并独立复现 | `node .auto-ai/validation/T005A/merge-race.mjs <本工作树>` | passed：`mutations=1`（原 2）；并发两请求均 pending；MERGED 读回 `{merged:true,mergeSha}`；`candidateState=completed` | `merge-race.json` |
| 准备恢复独立复现 | `node .auto-ai/validation/T005A/prepare-recovery.mjs <本工作树>` | passed：`creates=1,spawns=1`，Run `running`，`templateRef`/`worktreePath` 已绑定，`blockedReason=null`（原 creates=0/spawns=0/blocked） | `prepare-recovery.json` |
| 真实本地 Git 交付 | 专项用例 5：临时裸远端 + WorkspaceAdapter 真 worktree，提交推送、PR 读回、归档 | passed：分支 SHA 与 PR head 一致，干净工作树被回收 | `runtime-special.log` |
| 合并边界（fake GitHub） | 用例 9/10/13/14 | passed：未确认/缺验收/错 head 均不发命令；pending 与异常后只读核验；重启恢复 SHA | `runtime-special.log` |
| 准备/启动/PR 中断恢复（fake 外部 + 真实本地文件） | 用例 7/15 | passed：不重复 spawn、不重复建 PR、不重复建工作树 | `runtime-special.log` |

分类说明：

- **fake 外部**：GitHub 与 Pi 全部由 `FakeGitHub`/`FakePi` 注入；独立脚本同样是 fixture，未操作真实 GitHub 合并。
- **真实本地**：Node 22 运行时、SQLite 领域存储、原子 JSON 控制文件、控制器 PID 锁、用例 5 的真实 `git worktree`/裸远端/提交推送。
- 每个用例均实跑；未以退出码推定测试通过。

## blockers

[]（无阻塞）

## 真实外部未验证项

- 未调用真实 GitHub API：`gh` 认证、真实 PR 创建/读回/合并、真实 Issue 刷新均为 fixture。合并命令真实行为（服务端 head 竞争、分支保护、squash 结果 SHA 格式）未验证。
- 未启动真实 Pi 进程：`pi` 可执行、`deepseek-flash / high`、会话与 monitor 恢复仅通过 FakePi 与既有的真实 Pi adapter 测试覆盖，本轮未新增真实模型调用。
- 未在真实控制器锁竞争、长时 watch 轮询、真实 detached Pi 接管场景下长时间运行；仅覆盖短时进程内的 start/close/重启路径。
- 已知保留窗口：若在 WorkspaceAdapter “git worktree add 成功、manifest 写入前”崩溃，适配器会以“工作树目录已存在”拒绝，Run 阻塞并保留现场；该窗口在 Adapter 内部，本轮范围内未复位（按现场保留处理，不静默删除）。
