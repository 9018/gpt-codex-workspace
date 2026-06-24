/**
 * bark-notifier.mjs — compatibility facade for Bark notification helpers.
 */

export { createBarkNotifier } from "./bark-notifier-core.mjs";
export { classifyNotification, classifyCreatedNotification, classifyTaskNotificationSuppression } from "./bark-notification-policy.mjs";
export { formatNotification, formatManualTestNotification, formatCreatedNotification } from "./bark-notification-formatters.mjs";
