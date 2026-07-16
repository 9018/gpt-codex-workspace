# 04 TUI 全自动无人值守运行时方案

## 目标

把 `codex tui` 从“人工接管/Operator fallback”改造成与 `codex exec` 同等级的全自动执行后端。正常路径不需要人观察或输入。

## 不可妥协的产品语义

TUI 必须自动完成：

```text
自动启动
→ 自动等待首屏
→ 自动识别屏幕状态
→ 自动生成输入
→ 自动处理确认/选择/错误
→ 自动判断任务进展
→ 自动防卡死
→ 自动识别终态
→ 自动收集 result/evidence/git/test
→ 自动验收
→ 自动修复或重试
→ 自动写回
→ 自动推进后续任务
```

TUI 不得把以下状态当作正常成功路径：

```text
waiting_for_operator
waiting_for_manual_input
operator_takeover_required
human_attach_required
```

只有自动策略预算耗尽且无法安全推断下一步时，才进入 typed terminal blocker。

## 主要文件

### 新增

- `backend/src/tui-autopilot/tui-screen-model.mjs`
- `backend/src/tui-autopilot/tui-screen-parser.mjs`
- `backend/src/tui-autopilot/tui-state-classifier.mjs`
- `backend/src/tui-autopilot/tui-action-policy.mjs`
- `backend/src/tui-autopilot/tui-action-executor.mjs`
- `backend/src/tui-autopilot/tui-progress-tracker.mjs`
- `backend/src/tui-autopilot/tui-terminal-detector.mjs`
- `backend/src/tui-autopilot/tui-confirmation-policy.mjs`
- `backend/src/tui-autopilot/tui-recovery-policy.mjs`
- `backend/src/tui-autopilot/tui-autopilot-controller.mjs`
- `backend/src/tui-autopilot/tui-transcript-window.mjs`
- `backend/src/tui-autopilot/tui-autopilot-events.mjs`
- `backend/src/tui-autopilot/tui-autopilot-schema.mjs`

### 修改

- `backend/src/codex-tui-session-manager.mjs`
- `backend/src/codex-tui-pty-adapter.mjs`
- `backend/src/codex-tui-completion-collector.mjs`
- `backend/src/codex-tui-evidence-cycle.mjs`
- `backend/src/codex-tui-evidence-writeback.mjs`
- `backend/src/codex-tui-runtime-diagnostics.mjs`
- `backend/src/codex-tui-session-store.mjs`
- `backend/src/codex-tui-agent-run-reconciler.mjs`
- `backend/src/tool-groups/codex-tui-tools-group.mjs`
- `backend/src/task-general-processor.mjs`
- `backend/src/runtime-config.mjs`
- `docs/codex-tui-mode.md`

### 测试

- 新增 `backend/test/tui-autopilot-screen-parser.test.mjs`
- 新增 `backend/test/tui-autopilot-state-classifier.test.mjs`
- 新增 `backend/test/tui-autopilot-action-policy.test.mjs`
- 新增 `backend/test/tui-autopilot-confirmation-policy.test.mjs`
- 新增 `backend/test/tui-autopilot-terminal-detector.test.mjs`
- 新增 `backend/test/tui-autopilot-no-progress-recovery.test.mjs`
- 新增 `backend/test/tui-autopilot-e2e.test.mjs`
- 修改现有全部 `codex-tui-*` 测试
- 修改 `backend/scripts/e2e-tui-first-loop.mjs`
- 修改 `backend/scripts/release-tui-first-loop-gate.mjs`

## 状态机

```text
created
starting
waiting_first_frame
classifying
ready_for_instruction
executing
awaiting_confirmation
awaiting_choice
awaiting_more_input
collecting_result
verifying_terminal
recovering
completed
failed
timed_out
```

其中 `awaiting_*` 是内部瞬时状态，autopilot 必须自动处理，不能暴露为人工等待。

## 实施任务

### Task 1：建立屏幕快照模型

每次 PTY 输出形成：

```js
{
  sequence,
  captured_at,
  raw_tail,
  normalized_text,
  stable_lines,
  prompt_markers,
  selectable_options,
  confirmation_markers,
  error_markers,
  progress_markers,
  terminal_markers,
  content_digest
}
```

去除 ANSI、光标移动、重复重绘和 spinner 噪声。

### Task 2：增量 transcript window

只保留：

- 最近固定字符窗口。
- 最近 N 个稳定 frame。
- 最近一次用户/自动输入后的增量。
- 结构化事件摘要。

避免每次让 Agent 读取完整 TUI transcript。

### Task 3：状态分类器

先用确定性规则：

```js
if (hasResultJsonAndPromptReturned) return "collecting_result";
if (matchesConfirmationPrompt) return "awaiting_confirmation";
if (matchesChoiceList) return "awaiting_choice";
if (matchesShellOrCodexPrompt) return "ready_for_instruction";
if (hasNewProgressSinceLastInput) return "executing";
```

规则无法分类时，才调用 bounded classifier，输入只含稳定 frame 和任务摘要，输出严格 JSON：

```json
{
  "state": "awaiting_more_input",
  "confidence": 0.91,
  "reason_code": "codex_requests_next_instruction",
  "suggested_action": "send_continue_instruction"
}
```

### Task 4：初始自动指令

启动后自动发送由 task contract 编译的完整 instruction：

```text
你正在无人值守 TUI 自动执行模式。
完成目标、修改代码、运行验证、写 result.json。
遇到可自动决定的确认或选择必须继续执行。
禁止等待人工回复。
```

指令包含：

- goal/task。
- allowed repo/worktree。
- acceptance contract。
- required artifact。
- result.json path/schema。
- 禁止人工等待。
- 失败时的诊断输出要求。

### Task 5：确认策略

对确认提示分类：

```text
read_only
write_within_worktree
run_test
install_declared_dependency
git_commit
git_status
```

默认自动确认。

对无法识别或越界动作，自动拒绝并发送替代指令，不进入人工等待：

```text
拒绝该越界动作。请在当前 worktree 内采用替代实现继续完成任务。
```

### Task 6：选择策略

对于菜单/多选：

1. 基于 task execution policy 规则选择。
2. 规则不覆盖时使用 bounded decision Agent。
3. 输出 option index + reason code。
4. 自动按键发送。

必须记录每次选择事件和屏幕 digest。

### Task 7：继续执行策略

当 TUI 返回提示符但任务未满足终态：

```js
const missing = computeMissingAcceptanceItems(snapshot);
send(buildContinuationPrompt(missing));
```

例如：

```text
任务尚未完成：缺少测试结果和 result.json。继续执行，不要等待人工输入。
```

### Task 8：no-progress 检测

分别跟踪：

- 首帧超时。
- 内容首输出超时。
- frame digest 长时间不变。
- 有 spinner 但无语义进展。
- 重复相同确认。
- 重复相同错误。
- prompt 返回但 artifact 缺失。

恢复动作顺序：

```text
发送轻量探测
→ 发送继续/纠偏指令
→ Ctrl+C 中断当前子命令但保留 TUI
→ 重新提示剩余目标
→ 重启同一 native session
→ 新 attempt 继承 checkpoint
→ 终止失败
```

### Task 9：终态检测

完成必须同时满足：

- TUI 进程或会话处于可收口状态。
- `result.json` schema 有效，或 collector 可从可验证事实重建。
- Git 状态和 changed files 已采集。
- required tests 有结果。
- task acceptance items 可验证。
- 没有未处理确认/错误状态。

禁止仅凭“Done”“完成”文本判定成功。

### Task 10：自动 evidence cycle

TUI 终态后自动执行：

```text
read result.json
→ validate schema
→ collect git diff/status/commit
→ collect test receipts
→ normalize task result
→ unified decision
→ progression commands
```

缺失 result 时自动向同一 session 发送修复指令一次；仍缺失则 collector 基于事实生成 fail-closed result。

### Task 11：自动 repair

verification/acceptance 失败时：

- 若 session 可继续，向同一 TUI session 发送结构化 repair instruction。
- 若 session 不健康，使用 native session resume。
- 若 resume 不可用，新建 TUI attempt，附带 checkpoint。
- repair budget 用完才失败。

### Task 12：服务重启恢复

session store 持久化：

```js
autopilot_state
last_frame_digest
last_action
action_attempts
native_session_id
pid
checkpoint
remaining_acceptance
```

服务启动后：

1. 检查 PID/session。
2. 可附着则恢复 controller。
3. 不可附着则用 native session resume。
4. 已有 terminal evidence 则直接进入 collector。
5. 不得创建重复 task 或重复 repair。

### Task 13：工具组调整

保留 `read/send/stop` 供诊断，但产品默认工具新增：

```text
codex_tui_start_autonomous
codex_tui_autopilot_status
codex_tui_autopilot_reconcile
```

`codex_tui_start_goal` 默认 `autonomous=true`。

### Task 14：运行配置

新增：

```text
GPTWORK_TUI_AUTOPILOT_ENABLED=true
GPTWORK_TUI_AUTOPILOT_MAX_ACTIONS=100
GPTWORK_TUI_AUTOPILOT_MAX_REPAIRS=3
GPTWORK_TUI_FRAME_STABLE_MS=500
GPTWORK_TUI_NO_PROGRESS_SECONDS=120
GPTWORK_TUI_CLASSIFIER_ENABLED=true
```

生产 profile 必须开启 autopilot，否则 doctor fail。

### Task 15：真实 canary

真实 canary 必须覆盖：

- 自动确认。
- 自动选择。
- 自动继续。
- 自动生成 result。
- 测试失败后自动修复。
- TUI 进程中断后 resume。
- 服务重启后恢复。
- 完成后 task/goal/queue 自动收口。

## 验收命令

```bash
cd backend
node --test test/tui-autopilot-screen-parser.test.mjs
node --test test/tui-autopilot-state-classifier.test.mjs
node --test test/tui-autopilot-action-policy.test.mjs
node --test test/tui-autopilot-confirmation-policy.test.mjs
node --test test/tui-autopilot-terminal-detector.test.mjs
node --test test/tui-autopilot-no-progress-recovery.test.mjs
node --test test/tui-autopilot-e2e.test.mjs
node --test 'test/codex-tui-*.test.mjs'
npm run e2e:tui-first-loop
npm run release:tui-first-loop-gate
npm run check:syntax
npm run check:imports
```

## 完成标准

- 正常 TUI 任务全程不需要人工输入。
- 所有确认、选择、继续、修复都自动执行。
- TUI 断连、重启、服务重启后自动恢复。
- 完成后自动进入统一验收和推进链。
