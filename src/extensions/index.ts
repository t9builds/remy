import type { Extension } from "../sdk/extension";
import factory from "./factory";
import mergedCleanup from "./merged-cleanup";
import queueCommand from "./queue-command";
import slackTasks from "./slack-tasks";

/** Remy's own extensions, by name; `extensions.disabled` in the config turns one off. */
export const BUILTINS: Record<string, Extension> = {
  "merged-cleanup": mergedCleanup,
  "slack-tasks": slackTasks,
  queue: queueCommand,
  factory,
};
