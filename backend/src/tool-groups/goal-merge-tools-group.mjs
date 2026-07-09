import { previewMergeGate, applyMergeGate } from '../merge-gate-service.mjs';

export function createGoalMergeToolsGroup({ tool, schema, findGoalWorkspace, config }) {
  return {
    goal_merge_preview: tool({
      name: 'goal_merge_preview',
      description: 'Preview whether a goal candidate branch is eligible to merge into its target branch.',
      inputSchema: schema({ goal_id: 'string' }, ['goal_id']),
      handler: async ({ goal_id }) => {
        const { goal, workspace } = await findGoalWorkspace(goal_id);
        return previewMergeGate({ goalId: goal.id, workspace, config });
      }
    }),

    goal_merge_apply: tool({
      name: 'goal_merge_apply',
      description: 'Apply merge for a goal candidate branch after merge gate passes.',
      inputSchema: schema({ goal_id: 'string' }, ['goal_id']),
      handler: async ({ goal_id }) => {
        const { goal, workspace } = await findGoalWorkspace(goal_id);
        return applyMergeGate({ goalId: goal.id, workspace, config });
      }
    })
  };
}
