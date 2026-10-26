/** The built-in extensions: the one index file, so the core reaches them only through this list. */
import type { Extension } from "../sdk/extension";
import factory from "./factory/factory";
import mergedCleanup from "./merged-cleanup";
import slackTasks from "./slack-tasks";
import waitingListCommand from "./waiting-list-command";

/** Remy's own extensions, by name; `extensions.disabled` in the config turns one off. */
export const BUILTINS: Record<string, Extension> = {
  "merged-cleanup": mergedCleanup,
  "slack-tasks": slackTasks,
  queue: waitingListCommand, // named after `/queue`; users' `extensions.disabled` lists it by this name
  factory,
};
