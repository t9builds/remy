import plugin from "../../.claude-plugin/plugin.json" with { type: "json" };

/** The plugin's version; the daemon and `remy start` compare theirs to tell an outdated daemon apart. */
export const VERSION: string = plugin.version;
