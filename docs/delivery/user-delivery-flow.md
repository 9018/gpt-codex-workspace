# User Delivery Flow

> Complete user journey from request to completed delivery.

## Flow Steps

1. **Create Goal**: User submits a request via ChatGPT or Codex
2. **Context Bundle**: System builds a compressed context from Zvec/full transcript
3. **Queue Enqueue**: Goal enters execution queue with dependency checks
4. **Worktree Materialization**: A Git worktree is created for isolated execution
5. **Codex Execution**: Task runs in the worktree
6. **Verification**: Results are verified against acceptance profiles
7. **Repair Loop**: If verification fails, automatic repair task is created
8. **Integration**: Accepted changes go through serial merge/push
9. **Completion**: Task completed, worktree cleaned up, user notified

## Verification Commands

- Health: `npm start` → check health endpoint
- Queue: `list_goal_queue` tool
- Status: `gptwork_doctor` tool
- Tests: `npm test`
