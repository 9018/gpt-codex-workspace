# User Thread and internal execution boundary

A root Goal is the durable user-visible Thread. New root Goals persist `root_goal_id` equal to their own ID. Child Goals created for repair, retry, verification, integration, or follow-up inherit the parent's root identity.

User-facing Goal listings include `thread_id`, `thread_title`, `internal_title`, `phase`, `iteration`, and `is_internal_child`. Internal titles remain unchanged for audit, while `thread_title` stays stable across execution iterations. Legacy Goals are projected non-destructively with their own ID as the root.
