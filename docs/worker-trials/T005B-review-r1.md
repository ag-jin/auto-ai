# T005B 返修 1：所有错误状态的输出边界

主会话已实际复跑 HTTP 专项 9/9；补充独立检查失败，证据 `.auto-ai/validation/T005B/independent-r1.json`。

## 最小复现与实际错误

fake Runtime.saveSettings 抛以下错误，HTTP 真实请求带有效 token：

```js
Object.assign(new Error('validation failed\nprompt: private task instructions'), {
  statusCode: 400,
  details: {currentRev:'safe-rev',apiKey:'fixture-private-key',
    csrfToken:'<本地真实会话 token>',stack:'fixture internal stack'}
})
```

实际：400 JSON 原样包含 private task instructions、fixture-private-key、真实 token 和内部 stack。catch 只替换 message 中的 token，对 details 无效。错误脱敏合同适用于所有状态，不能只测试 500。

另一复现：抛 `Object.assign(new Error('GitHub 不可用：请先登录 gh'),{statusCode:503})`，返回 internal_error 和“服务器内部错误，未执行操作”，丢失可处理原因；后一句也不能证明，因为异常前可能已有远程副作用。

## 期望行为

- 所有 4xx/5xx 响应均不包含 token、密钥、prompt、stack。details 只透出明确允许的简单业务信息（如 currentRev、allowed、reasons），不能遍历后全量回传任意对象。长度、类型和嵌套须有界。
- 保留普通安全的 409 业务原因与 currentRev；不能为了脱敏破坏冲突恢复。
- 503 使用 unavailable 语义和安全的具体环境原因，例如“GitHub 不可用：请先登录 gh”。未知 500 保持通用错误，不泄露异常文本。
- 所有响应都不要声称“未执行操作”，因为 HTTP 层无法证明；提示查看事件或核验状态即可。
- 本机令牌即便出现在嵌套字段或错误 code 中也不可返回。拒绝不安全字段，而非仅按固定示例替换。

## 范围与验收

只改 src/http-server.mjs、test/http-server.test.mjs、docs/worker-trials/T005B-result.md。先加红回归再实现：上面 400、嵌套秘密、503 可处理原因、未知 500、409 currentRev、错误后继续服务。运行专项和全量测试，中央日志留证。不改 Runtime、合同或其他 Worker 文件，不 commit/push，由主会话检查后提交。
