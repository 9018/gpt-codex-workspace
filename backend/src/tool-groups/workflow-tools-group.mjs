/**
 * workflow-tools-group.mjs — GPTWork one-click workflow advance tools
 *
 * MCP tools:
 *   workflow_status        — read-only state snapshot
 *   workflow_record_result — persist user verdict
 *   workflow_advance       — gather state + generate proposal + optional apply
 *
 * These tools work together so the user no longer needs to type
 * "检查任务" / "下发任务" after each manual acceptance step.
 */
import {
  collectWorkflowDiagnostics,
  computeFingerprint,
  createProposalTask,
  findExistingProposal,
  findExistingResult,
  generateProposal,
  loadWorkflowState,
  resolveTask,
  saveWorkflowState,
  storeCreatedTaskId,
  storeManualResult,
  autoAcceptTask,
  storeProposal,
} from "../workflow-state-service.mjs";
import { TASK_STATUSES, isHumanReviewStatus } from "../task-status-taxonomy.mjs";

export const WORKFLOW_ADVANCE_HANDLER_VERSION = "workflow_advance.v2.acceptance_first";

function workflowQueueActionableReview(queue = {}) {
  const policy = queue.policy_counts || queue;
  return queue.actionable_review ?? policy[TASK_STATUSES.WAITING_FOR_REVIEW] ?? queue[TASK_STATUSES.WAITING_FOR_REVIEW] ?? 0;
}

function workflowQueueCurrentBlockers(queue = {}) {
  const policy = queue.policy_counts || queue;
  return (policy[TASK_STATUSES.WAITING_FOR_LOCK] ?? 0)
    + (policy[TASK_STATUSES.WAITING_FOR_INTEGRATION] ?? 0)
    + (policy[TASK_STATUSES.WAITING_FOR_REPAIR] ?? 0)
    + workflowQueueActionableReview(queue)
    + (policy[TASK_STATUSES.FAILED] ?? 0);
}

function workflowQueueDisplay(queue = {}) {
  const policy = queue.policy_counts || queue;
  return {
    ...queue,
    ...policy,
    current_blockers: queue.current_blockers ?? workflowQueueCurrentBlockers(queue),
    actionable_review: workflowQueueActionableReview(queue),
  };
}

function handlerDiagnostics(diagnostics) {
  return {
    workflow_advance_handler_version: WORKFLOW_ADVANCE_HANDLER_VERSION,
    runtime_handler_commit: diagnostics?.runtime?.running_commit || diagnostics?.runtime?.repo_head || null,
  };
}

/**
 * Factory for workflow MCP tool registration.
 * Dependencies are passed in to match the pattern in server-tools.mjs.
 */
export function createWorkflowToolsGroup({
  tool,
  schema,
  store,
  config,
  workerState,
  collectWorkerQueueCounts,
}) {
  const cardMeta = {
    modes: ["standard", "codex", "full"],
    audience: ["chatgpt", "codex"],
    tags: ["workflow"],
    outputTemplate: "ui://widget/gptwork-card-v2.html",
    resourceUri: "ui://widget/gptwork-card-v2.html",
  };

  return {
    // -----------------------------------------------------------------------
    // workflow_status — read-only snapshot
    // -----------------------------------------------------------------------
    workflow_status: tool({
      name: "workflow_status",
      description:
        "Read-only snapshot of the current workflow state: latest task info, " +
        "runtime git state, worktree health, repo locks, worker status, and queue " +
        "summary. Use this before recording a result or advancing the workflow.",
      inputSchema: schema({
        workflow_id: {
          type: "string",
          description:
            "Workflow identifier. Defaults to 'default' if not provided.",
          examples: ["default", "my-feature-workflow"],
        },
        task_id: {
          type: "string",
          description:
            "Specific task ID to focus on. Use 'latest' (default) for the " +
            "most recent Codex-assigned task.",
          examples: ["latest", "task_abc123"],
        },
      }),
      ...cardMeta,
      handler: async ({ workflow_id, task_id }) => {
        const wfId = workflow_id || "default";
        const task = await resolveTask(store, task_id || "latest");
        const diagnostics = await collectWorkflowDiagnostics({
          store,
          config,
          workerState,
          collectWorkerQueueCounts,
          task,
          workflowId: wfId,
        });

        // Load workflow state if it exists
        let workflowState = null;
        try {
          workflowState = loadWorkflowState(
            config.defaultWorkspaceRoot,
            wfId
          );
        } catch {
          // Non-fatal: workflow state may not exist yet
        }

        // Auto-accept check: if a waiting_for_review task qualifies, trigger auto-accept
        if (task && isHumanReviewStatus(task.status)) {
          const autoAccepted = await autoAcceptTask({ store, config, task, diagnostics });
          if (autoAccepted.auto_accepted) {
            // Re-resolve task to get updated status
            try {
              const updatedTask = await resolveTask(store, task_id || "latest");
              if (updatedTask && diagnostics.latest_task) {
                diagnostics.latest_task.status = updatedTask.status;
                diagnostics.latest_task.reviewer_decision = updatedTask.result?.reviewer_decision || null;
                diagnostics.latest_task.acceptance_findings = Array.isArray(updatedTask.result?.acceptance_findings) ? updatedTask.result.acceptance_findings : [];
                diagnostics.latest_task.next_tasks = Array.isArray(updatedTask.result?.next_tasks) ? updatedTask.result.next_tasks : [];
              }
              diagnostics.queue = await collectWorkerQueueCounts(store);
            } catch {}
          }
        }

        const queueDisplay = workflowQueueDisplay(diagnostics.queue);

        return {
          title: "Workflow Status",
          summary: `Workflow: ${wfId}`,
          workflow_id: wfId,
          workflow_state: workflowState
            ? {
                current_phase: workflowState.current_phase,
                last_task_id: workflowState.last_task_id,
                last_known_good_commit: workflowState.last_known_good_commit,
                manual_results_count: (
                  workflowState.manual_results || []
                ).length,
                proposals_count: (workflowState.proposals || []).length,
                created_task_ids: workflowState.created_task_ids || [],
              }
            : null,
          latest_task: diagnostics.latest_task,
          runtime: diagnostics.runtime,
          worktree: diagnostics.worktree,
          repo_locks: diagnostics.repo_locks,
          worker: {
            enabled: diagnostics.worker.enabled,
            running: diagnostics.worker.running,
            health: diagnostics.worker.health,
          },
          queue: queueDisplay,
          status_checks: {
            worker_idle: !diagnostics.worker.running,
            no_active_locks: diagnostics.repo_locks.active === 0,
            worktree_clean: !diagnostics.worktree.dirty,
            safe_to_advance:
              !diagnostics.worker.running &&
              diagnostics.repo_locks.active === 0 &&
              !diagnostics.worktree.dirty,
          },
          keyValues: [
            { key: "Workflow ID", value: wfId },
            {
              key: "Latest Task",
              value: task
                ? `${task.id} (${task.status})`
                : "none",
            },
            {
              key: "Running Commit",
              value: diagnostics.runtime.running_commit || "unknown",
            },
            {
              key: "Worktree",
              value: diagnostics.worktree.dirty ? "dirty" : "clean",
            },
            {
              key: "Worker",
              value: diagnostics.worker.running ? "running" : "idle",
            },
            {
              key: "Active Locks",
              value: String(diagnostics.repo_locks.active),
            },
            {
              key: "Current Blockers",
              value: String(queueDisplay.current_blockers),
            },
            {
              key: "Actionable Review",
              value: String(queueDisplay.actionable_review),
            },
            {
              key: "Repair Backlog",
              value: String(queueDisplay[TASK_STATUSES.WAITING_FOR_REPAIR] || 0),
            },
          ],
        };
      },
    }),

    // -----------------------------------------------------------------------
    // workflow_record_result — persist user verdict
    // -----------------------------------------------------------------------
    workflow_record_result: tool({
      name: "workflow_record_result",
      description:
        "Record a manual acceptance verdict for a task. Persists the result " +
        "in .gptwork/workflows/<workflow_id>.json and returns the stored record " +
        "along with a current task summary. GPTChat should then analyze the " +
        "result and call workflow_advance if appropriate.",
      inputSchema: schema(
        {
          workflow_id: {
            type: "string",
            description:
              "Workflow identifier. Defaults to 'default' if not provided.",
          },
          task_id: {
            type: "string",
            description:
              "Task ID to record the verdict for. Use 'latest' to target " +
              "the most recent Codex-assigned task.",
            examples: ["latest", "task_abc123"],
          },
          verdict: {
            type: "string",
            description:
              "Manual acceptance verdict:\n" +
              '- "passed" — task accepted, ready to advance\n' +
              '- "failed" — task rejected, needs fix task\n' +
              '- "partial" — partially accepted, needs convergence task\n' +
              '- "blocked" — blocked by external factors',
            enum: ["passed", "failed", "partial", "blocked"],
          },
          note: {
            type: "string",
            description:
              "Optional user note explaining the verdict. This is included " +
              "in the idempotency fingerprint, so changing the note produces " +
              "a different record.",
          },
          attachments: {
            type: "array",
            description:
              "Future: optional attachment references (not yet implemented).",
            items: { type: "string" },
          },
        },
        ["task_id", "verdict"]
      ),
      ...cardMeta,
      handler: async ({ workflow_id, task_id, verdict, note }) => {
        const wfId = workflow_id || "default";
        const task = await resolveTask(store, task_id || "latest");
        if (!task) {
          throw new Error(
            `Task not found: ${task_id || "latest"}. Cannot record result.`
          );
        }

        const diagnostics = await collectWorkflowDiagnostics({
          store,
          config,
          workerState,
          collectWorkerQueueCounts,
          task,
          workflowId: wfId,
        });

        // Compute fingerprint for idempotency
        const fingerprint = computeFingerprint({
          workflowId: wfId,
          taskId: task.id,
          manualVerdict: verdict,
          manualNote: note,
          runningCommit: diagnostics.runtime.running_commit,
          taskResultCommit: task.result?.commit || null,
          nextActionType: "record_result",
        });

        // Load and update workflow state
        const workflowState = loadWorkflowState(
          config.defaultWorkspaceRoot,
          wfId
        );

        // Idempotency: check if same result already recorded
        const existing = findExistingResult(workflowState, fingerprint);
        if (existing) {
          return {
            title: "Workflow Result (duplicate)",
            summary: `Verdict already recorded for task ${task.id}`,
            recorded: existing,
            workflow_id: wfId,
            task_summary: {
              id: task.id,
              status: task.status,
              result: task.result?.summary || null,
            },
            fingerprint,
            duplicate: true,
            keyValues: [
              { key: "Task ID", value: task.id },
              { key: "Verdict", value: verdict },
              { key: "Status", value: "already recorded" },
            ],
          };
        }

        // Store the new result
        storeManualResult(workflowState, {
          taskId: task.id,
          verdict,
          note,
          fingerprint,
        });
        workflowState.latest_running_commit =
          diagnostics.runtime.running_commit;
        if (task.result?.commit) {
          workflowState.last_known_good_commit = task.result.commit;
        }
        saveWorkflowState(config.defaultWorkspaceRoot, wfId, workflowState);

        return {
          title: "Workflow Result Recorded",
          summary: `Verdict: ${verdict} for task ${task.id}`,
          recorded: {
            task_id: task.id,
            verdict,
            note: note || "",
            fingerprint,
            recorded_at: new Date().toISOString(),
          },
          workflow_id: wfId,
          task_summary: {
            id: task.id,
            title: task.title,
            status: task.status,
            result: task.result?.summary || null,
            commit: task.result?.commit || null,
          },
          fingerprint,
          next_steps: [
            'Call workflow_advance(mode="propose") to generate a structured proposal.',
            'Or call workflow_advance(mode="dry_run") for a preview without persistence.',
          ],
          keyValues: [
            { key: "Task ID", value: task.id },
            { key: "Verdict", value: verdict },
            { key: "Fingerprint", value: fingerprint },
            {
              key: "Next Step",
              value: "workflow_advance",
            },
          ],
        };
      },
    }),

    // -----------------------------------------------------------------------
    // workflow_advance — gather state + generate proposal + optional apply
    // -----------------------------------------------------------------------
    workflow_advance: tool({
      name: "workflow_advance",
      description:
        "Gather current workflow/runtime/worker/repo state and generate a " +
        "structured proposal for the next action. In 'propose' or 'dry_run' " +
        "mode, no task is created — GPTChat analyzes the proposal and calls " +
        "create_task. In 'apply' mode, creates the next task only when " +
        "unambiguous and safe; otherwise returns needs_gptchat_decision.\n\n" +
        "Idempotent: repeated calls with the same inputs return the existing " +
        "proposal rather than creating duplicates.",
      inputSchema: schema(
        {
          workflow_id: {
            type: "string",
            description:
              "Workflow identifier. Defaults to 'default' if not provided.",
          },
          task_id: {
            type: "string",
            description:
              "Task ID to advance from. Use 'latest' (default) for the " +
              "most recent Codex-assigned task.",
            examples: ["latest", "task_abc123"],
          },
          manual_verdict: {
            type: "string",
            description:
              "Manual acceptance verdict:\n" +
              '- "passed" — task accepted, ready to advance\n' +
              '- "failed" — task rejected, needs fix task\n' +
              '- "partial" — partially accepted, needs convergence task\n' +
              '- "blocked" — blocked by external factors',
            enum: ["passed", "failed", "partial", "blocked"],
          },
          manual_note: {
            type: "string",
            description:
              "Optional user note explaining the verdict. Included in the " +
              "idempotency fingerprint.",
          },
          mode: {
            type: "string",
            description:
              'Operation mode:\n' +
              '- "dry_run": gather state and compute proposal, do not persist\n' +
              '- "propose": gather state, persist result, return proposal (default)\n' +
              '- "apply": if safe and unambiguous, create the next task directly',
            enum: ["dry_run", "propose", "apply"],
            default: "propose",
          },
        },
        ["mode"]
      ),
      ...cardMeta,
      handler: async (
        { workflow_id, task_id, manual_verdict, manual_note, mode },
        context
      ) => {
        const wfId = workflow_id || "default";
        const resolvedMode = mode || "propose";
        const task = await resolveTask(store, task_id || "latest");

        const diagnostics = await collectWorkflowDiagnostics({
          store,
          config,
          workerState,
          collectWorkerQueueCounts,
          task,
          workflowId: wfId,
        });

        // Check safety for creating tasks
        const isSafe =
          !diagnostics.worker.running &&
          diagnostics.repo_locks.active === 0 &&
          !diagnostics.worktree.dirty;

        if (!isSafe && resolvedMode === "apply" && !isHumanReviewStatus(task?.status)) {
          const reasons = [];
          if (diagnostics.worker.running)
            reasons.push("worker is running");
          if (diagnostics.repo_locks.active > 0)
            reasons.push(`${diagnostics.repo_locks.active} active repo lock(s)`);
          if (diagnostics.worktree.dirty)
            reasons.push("worktree is dirty");
          return {
            title: "Workflow Blocked",
            ...handlerDiagnostics(diagnostics),
            summary: "Cannot advance: unsafe state",
            workflow_id: wfId,
            next_action: "blocked",
            recommendation: `Cannot create next task: ${reasons.join("; ")}. Resolve these issues first.`,
            task: diagnostics.latest_task,
            runtime: diagnostics.runtime,
            worktree: diagnostics.worktree,
            repo_locks: diagnostics.repo_locks,
            worker: {
              enabled: diagnostics.worker.enabled,
              running: diagnostics.worker.running,
            },
            needs_gptchat_decision: true,
            keyValues: [
              { key: "Workflow", value: wfId },
              { key: "Status", value: "blocked" },
              { key: "Reason", value: reasons.join("; ") },
            ],
          };
        }

        // Generate the proposal
        const proposal = generateProposal({
          diagnostics,
          task,
          manualVerdict: manual_verdict || "passed",
          manualNote: manual_note,
        });

        // Compute fingerprint for idempotency
        const fingerprint = computeFingerprint({
          workflowId: wfId,
          taskId: task?.id || "none",
          manualVerdict: manual_verdict || "none",
          manualNote: manual_note,
          runningCommit: diagnostics.runtime.running_commit,
          taskResultCommit: task?.result?.commit || null,
          nextActionType: proposal.next_action,
        });

        // Load workflow state for persistence / idempotency checks
        const workflowState = loadWorkflowState(
          config.defaultWorkspaceRoot,
          wfId
        );

        // Idempotency: check if same proposal already exists
        const existingProposal = findExistingProposal(
          workflowState,
          fingerprint
        );
        const existingIsStaleWaitingReviewShortCircuit =
          isHumanReviewStatus(task?.status) &&
          existingProposal?.next_action === "needs_gptchat_decision" &&
          !existingProposal?.acceptance;
        if (existingProposal && !existingIsStaleWaitingReviewShortCircuit) {
          // If in apply mode and task was already created, return existing
          if (
            resolvedMode === "apply" &&
            existingProposal.created_task_id
          ) {
            return {
              title: "Workflow Advance (already applied)",
              ...handlerDiagnostics(diagnostics),
              summary: `Task already created: ${existingProposal.created_task_id}`,
              workflow_id: wfId,
              proposal: existingProposal,
              created_task_id: existingProposal.created_task_id,
              fingerprint,
              duplicate: true,
              keyValues: [
                { key: "Task ID", value: existingProposal.created_task_id },
                { key: "Status", value: "already created" },
              ],
            };
          }
          return {
            title: "Workflow Proposal (existing)",
            ...handlerDiagnostics(diagnostics),
            summary: `Proposal already generated for task ${task?.id}`,
            workflow_id: wfId,
            proposal: existingProposal,
            task: diagnostics.latest_task,
            runtime: diagnostics.runtime,
            worktree: diagnostics.worktree,
            repo_locks: diagnostics.repo_locks,
            worker: {
              enabled: diagnostics.worker.enabled,
              running: diagnostics.worker.running,
            },
            fingerprint,
            duplicate: true,
            keyValues: [
              { key: "Workflow", value: wfId },
              { key: "Proposal", value: existingProposal.next_action },
              { key: "Status", value: "already generated" },
              { key: "Fingerprint", value: fingerprint },
            ],
          };
        }

        // Build the full proposal object
        const proposalRecord = {
          proposal_id: fingerprint,
          fingerprint,
          next_action: proposal.next_action,
          proposed_next_task: proposal.proposed_next_task,
          recommendation: proposal.recommendation,
          needs_gptchat_decision: proposal.needs_gptchat_decision,
          auto_accepted: proposal.auto_accepted || false,
          acceptance: proposal.acceptance || null,
          repair_proposal: proposal.repair_proposal || null,
          created_task_id: null,
          manual_verdict: manual_verdict || null,
          manual_note: manual_note || null,
          generated_at: new Date().toISOString(),
        };

        // In propose mode, persist the proposal and result
        if (resolvedMode === "propose" || resolvedMode === "apply") {
          // Record result if a verdict was provided
          if (manual_verdict) {
            storeManualResult(workflowState, {
              taskId: task?.id,
              verdict: manual_verdict,
              note: manual_note,
              fingerprint: fingerprint + "_result",
            });
          }
          storeProposal(workflowState, proposalRecord);
          if (task?.result?.commit) {
            workflowState.last_known_good_commit = task.result.commit;
          }
          workflowState.latest_running_commit =
            diagnostics.runtime.running_commit;
          saveWorkflowState(config.defaultWorkspaceRoot, wfId, workflowState);
        }

        let autoAcceptResult = null;
        // In apply mode, create the task if safe and unambiguous
        let createdTaskId = null;
        // Auto-accept in apply mode
        if (resolvedMode === "apply" && proposal.next_action === "auto_accepted" && isHumanReviewStatus(task?.status)) {
          autoAcceptResult = await autoAcceptTask({ store, config, task, diagnostics });
        }
        if (
          resolvedMode === "apply" &&
          !isSafe &&
          !proposal.needs_gptchat_decision &&
          proposal.proposed_next_task
        ) {
          return {
            title: "Workflow Advance Proposal",
            ...handlerDiagnostics(diagnostics),
            summary: `${proposal.recommendation} Task creation is deferred until worker, repo lock, and worktree safety checks are clear.`,
            workflow_id: wfId,
            proposal: proposalRecord,
            needs_gptchat_decision: false,
            task: diagnostics.latest_task,
            runtime: diagnostics.runtime,
            worktree: diagnostics.worktree,
            repo_locks: diagnostics.repo_locks,
            worker: {
              enabled: diagnostics.worker.enabled,
              running: diagnostics.worker.running,
            },
            fingerprint,
            created_task_id: null,
            mode: resolvedMode,
            status_checks: {
              worker_idle: !diagnostics.worker.running,
              no_active_locks: diagnostics.repo_locks.active === 0,
              worktree_clean: !diagnostics.worktree.dirty,
              safe_to_advance: isSafe,
            },
            next_steps: ['Call workflow_advance(mode="apply") again after runtime safety checks are clear to create the proposed task.'],
            keyValues: [
              { key: "Workflow", value: wfId },
              { key: "Task", value: task ? `${task.id} (${task.status})` : "none" },
              { key: "Next Action", value: proposal.next_action },
              { key: "Needs GPTChat", value: "false" },
              { key: "Created Task", value: "deferred" },
              { key: "Fingerprint", value: fingerprint },
              { key: "Mode", value: resolvedMode },
            ],
          };
        }
        if (
          resolvedMode === "apply" &&
          !proposal.needs_gptchat_decision &&
          proposal.proposed_next_task
        ) {
          try {
            const newTask = await createProposalTask(
              store,
              config,
              proposal,
              context
            );
            createdTaskId = newTask.id;
            proposalRecord.created_task_id = createdTaskId;
            storeCreatedTaskId(workflowState, createdTaskId);
            // Update the persisted proposal with the created task id
            saveWorkflowState(
              config.defaultWorkspaceRoot,
              wfId,
              workflowState
            );
          } catch (err) {
            return {
              title: "Workflow Advance Error",
              ...handlerDiagnostics(diagnostics),
              summary: `Failed to create task: ${err.message}`,
              workflow_id: wfId,
              proposal: proposalRecord,
              error: err.message,
              needs_gptchat_decision: true,
              keyValues: [
                { key: "Workflow", value: wfId },
                { key: "Status", value: "error" },
              ],
            };
          }
        }

        // If auto-accepted, show different response
        if (autoAcceptResult?.auto_accepted) {
          return {
            title: "Workflow Advance — Auto-accepted",
            ...handlerDiagnostics(diagnostics),
            summary: `Task "${task?.title}" auto-accepted. Result validated.`,
            workflow_id: wfId,
            needs_gptchat_decision: false,
            auto_accepted: true,
            proposal: {
              ...proposalRecord,
              created_task_id: createdTaskId,
            },
            task: {
              ...diagnostics.latest_task,
              status: "completed",
              result: { ...(diagnostics.latest_task?.result || {}), auto_accepted: true },
            },
            runtime: diagnostics.runtime,
            worktree: diagnostics.worktree,
            repo_locks: diagnostics.repo_locks,
            worker: {
              enabled: diagnostics.worker.enabled,
              running: diagnostics.worker.running,
            },
            fingerprint,
            created_task_id: createdTaskId,
            mode: resolvedMode,
            status_checks: {
              worker_idle: !diagnostics.worker.running,
              no_active_locks: diagnostics.repo_locks.active === 0,
              worktree_clean: !diagnostics.worktree.dirty,
              safe_to_advance: isSafe,
            },
            next_steps: [],
            keyValues: [
              { key: "Workflow", value: wfId },
              { key: "Task", value: `${task?.id} (completed)` },
              { key: "Next Action", value: "auto_accepted" },
              { key: "Auto-accepted", value: "true" },
              { key: "Fingerprint", value: fingerprint },
              { key: "Mode", value: resolvedMode },
            ],
          };
        }

        // Original return for non-auto-accept
        return {
          title: "Workflow Advance Proposal",
          ...handlerDiagnostics(diagnostics),
          summary: proposal.recommendation,
          workflow_id: wfId,
          proposal: proposalRecord,
          needs_gptchat_decision: proposal.needs_gptchat_decision,
          task: diagnostics.latest_task,
          runtime: diagnostics.runtime,
          worktree: diagnostics.worktree,
          repo_locks: diagnostics.repo_locks,
          worker: {
            enabled: diagnostics.worker.enabled,
            running: diagnostics.worker.running,
          },
          fingerprint,
          created_task_id: createdTaskId,
          mode: resolvedMode,
          status_checks: {
            worker_idle: !diagnostics.worker.running,
            no_active_locks: diagnostics.repo_locks.active === 0,
            worktree_clean: !diagnostics.worktree.dirty,
            safe_to_advance: isSafe,
          },
          next_steps: proposal.needs_gptchat_decision
            ? [
                "GPTChat should analyze this proposal and determine the next task.",
                'After analysis, call create_task with the chosen task details.',
              ]
            : [
                `Proposed next task: ${proposal.proposed_next_task?.title || "N/A"}`,
                resolvedMode === "apply" && createdTaskId
                  ? `Task ${createdTaskId} has been created.`
                  : 'Call workflow_advance(mode="apply") to create this task directly.',
              ],
          keyValues: [
            { key: "Workflow", value: wfId },
            {
              key: "Task",
              value: task ? `${task.id} (${task.status})` : "none",
            },
            {
              key: "Next Action",
              value: proposal.next_action,
            },
            {
              key: "Needs GPTChat",
              value: String(proposal.needs_gptchat_decision),
            },
            { key: "Fingerprint", value: fingerprint },
            {
              key: "Mode",
              value: resolvedMode,
            },
            ...(createdTaskId
              ? [{ key: "Created Task", value: createdTaskId }]
              : []),
          ],
        };
      },
    }),

    // -----------------------------------------------------------------------
    // workflow_apply_proposal — create task from existing proposal
    // -----------------------------------------------------------------------
    workflow_apply_proposal: tool({
      name: "workflow_apply_proposal",
      description:
        "Create a task from an existing proposal. Looks up the proposal " +
        "by fingerprint or proposal_id in the workflow state. If the proposal " +
        "already resulted in a created task, returns the existing task id. " +
        "Use this after GPTChat has reviewed and approved a proposal.",
      inputSchema: schema(
        {
          workflow_id: {
            type: "string",
            description:
              "Workflow identifier. Defaults to 'default' if not provided.",
          },
          proposal_id: {
            type: "string",
            description:
              "The proposal_id (fingerprint) returned by workflow_advance " +
              "to identify which proposal to apply.",
          },
        },
        ["proposal_id"]
      ),
      ...cardMeta,
      handler: async ({ workflow_id, proposal_id }, context) => {
        const wfId = workflow_id || "default";
        const workflowState = loadWorkflowState(
          config.defaultWorkspaceRoot,
          wfId
        );

        const proposal = (workflowState.proposals || []).find(
          (p) => p.fingerprint === proposal_id || p.proposal_id === proposal_id
        );

        if (!proposal) {
          throw new Error(
            `Proposal not found: ${proposal_id}. Call workflow_advance first.`
          );
        }

        if (proposal.needs_gptchat_decision) {
          throw new Error(
            `Proposal ${proposal_id} requires GPTChat decision. ` +
            "This proposal cannot be applied automatically."
          );
        }

        if (proposal.created_task_id) {
          return {
            title: "Proposal Already Applied",
            summary: `Task already created: ${proposal.created_task_id}`,
            proposal_id,
            created_task_id: proposal.created_task_id,
            duplicate: true,
            keyValues: [
              {
                key: "Created Task",
                value: proposal.created_task_id,
              },
              { key: "Status", value: "already applied" },
            ],
          };
        }

        if (!proposal.proposed_next_task) {
          throw new Error(
            `Proposal ${proposal_id} has no proposed_next_task. Cannot apply.`
          );
        }

        const newTask = await createProposalTask(
          store,
          config,
          proposal,
          context
        );
        proposal.created_task_id = newTask.id;
        storeCreatedTaskId(workflowState, newTask.id);
        saveWorkflowState(config.defaultWorkspaceRoot, wfId, workflowState);

        return {
          title: "Proposal Applied",
          summary: `Task created: ${newTask.title}`,
          proposal_id,
          created_task_id: newTask.id,
          task: {
            id: newTask.id,
            title: newTask.title,
            status: newTask.status,
          },
          keyValues: [
            { key: "Created Task ID", value: newTask.id },
            { key: "Title", value: newTask.title },
            { key: "Status", value: newTask.status },
          ],
        };
      },
    }),
  };
}
