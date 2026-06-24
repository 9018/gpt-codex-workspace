# 最终交付 Checklist

## 功能闭环

- [ ] ChatGPT 可以创建 encoded goal。
- [ ] goal 会写入 goal.md/context.json/transcript.md/context.bundle.md。
- [ ] Zvec/local context-index 能生成 retrieval provenance。
- [ ] queue dry-run 无副作用。
- [ ] worker 执行时才创建 task worktree。
- [ ] 三个无依赖任务可并发执行。
- [ ] 每个任务在独立 worktree 修改代码。
- [ ] result.json 绝对路径明确。
- [ ] 验收检查 task worktree，不检查错 canonical repo。
- [ ] acceptance failed 自动 repair。
- [ ] repair 超过预算进入 waiting_for_review。
- [ ] accepted code task 进入 integration queue。
- [ ] 同一 repo/branch integration 串行。
- [ ] integration 成功后才 completed。
- [ ] worktree cleanup/retain 策略生效。

## 自愈

- [ ] ENOSPC 可触发 tmp cleanup + retry。
- [ ] stale lock 可 reconcile。
- [ ] no first output 可 compact retry。
- [ ] worker crash 后 running task 可恢复/转态。
- [ ] safe restart marker 可验证。

## 用户交付

- [ ] setup-connect 文档可从零部署。
- [ ] Codex 接入步骤可验证。
- [ ] self-test 能发现缺失依赖。
- [ ] e2e-delivery smoke 可模拟三任务。
- [ ] release:delivery-check 存在。

## 发布门禁

```bash
npm --prefix backend run check:imports
npm --prefix backend run check:syntax
npm --prefix backend test
npm --prefix backend run test:e2e-acceptance
npm --prefix backend run release:delivery-check
```
