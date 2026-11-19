# T003B 独立核验返修 r1：以实际状态确认合并

固定 Pi deepseek-flash / high，仍在 T003B 独立 worktree。初版已保存为任务分支提交，48 项自测通过；以下仅使用注入 runner 复现，没有操作真实 PR。

## 实际缺陷

runner 对 `gh pr merge` 返回成功，但后续 `gh pr view --json mergeCommit,state` 返回：

```json
{"state":"OPEN","mergeCommit":null}
```

主会话实际得到：

```json
{"result":{"merged":true,"mergeSha":null},"mergeCalls":1,"remoteReadbackState":"OPEN"}
```

命令成功不能证明 PR 已合并；GitHub 可能仍在等待检查/队列，或读回失败。当前实现以及“读回失败仍返回 merged:true”的分支会让上层误记完成。

## 需要的行为

- 只有读回 `state=MERGED` 且有有效完整 merge SHA 时返回 `{merged:true,mergeSha}`。
- merge 命令已发出，但读回 OPEN/无 SHA/失败时返回明确的 `{merged:false,pending:true,note}`（可附已确认的实际状态），不伪造成功，也不自动重新发送 merge 命令。
- `readPullRequest` 额外返回实际 `mergeSha`（未知为 null），供重启后的只读核对。
- 相同 head 的 PR 已实际 MERGED 时，显式 confirmed 请求可幂等读回 `{merged:true,mergeSha}`，不再次调用 merge；已关闭未合并或 head 不同仍拒绝。
- 保留未确认拒绝、合法 method、head 核对、`--match-head-commit`、不 force/不 admin 等原有边界。

## 范围与回归

仅修改 github-adapter、对应测试和 T003B-result。保留 Workspace/模板 Adapter、包版本和所有既有测试。

先加入真实失败回归，再修复，覆盖：命令成功但 OPEN、readback error、MERGED 但无 SHA、正确 MERGED+SHA、已合并幂等、旧 head 与未确认仍拒绝。运行 npm test，记录红绿结果与剩余限制；不操作真实 GitHub PR，不提交 Git。
