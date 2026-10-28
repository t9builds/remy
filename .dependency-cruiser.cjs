/**
 * Which folder may import which: the architecture in AGENTS.md, checked. `bun run deps` runs it; `bun run check`
 * includes it. Type-only imports count too, so the public SDK can't come to depend on internals by a `type` import.
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Import cycles make load order and testing fragile. Move what both sides need to the lower module.",
      from: {},
      to: { circular: true },
    },
    {
      name: "sdk-stands-alone",
      severity: "error",
      comment:
        "src/sdk/ is what extensions and factory.ts files import. It defines its own types and imports nothing else of Remy's.",
      from: { path: "^src/sdk/" },
      to: { path: "^src/", pathNot: "^src/sdk/" },
    },
    {
      name: "shared-is-a-leaf",
      severity: "error",
      comment:
        "src/shared/ is pure code that the core and the built-in extensions both use; it imports only shared/ and sdk/.",
      from: { path: "^src/shared/" },
      to: { path: "^src/", pathNot: "^src/(shared|sdk)/" },
    },
    {
      name: "extensions-use-the-sdk",
      severity: "error",
      comment:
        "A built-in extension acts through the Remy API like anyone's extension (ADR-0003): it imports sdk/, shared/ and its own files only. Need more? Add it to the API in sdk/extension.ts.",
      from: { path: "^src/extensions/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/(extensions|sdk|shared)/" },
    },
    {
      name: "extension-tests-use-the-host",
      severity: "error",
      comment:
        "An extension's tests may run it in a real ExtensionHost with the default config, and nothing else of the core.",
      from: { path: "^src/extensions/.+\\.test\\.ts$" },
      to: { path: "^src/", pathNot: ["^src/(extensions|sdk|shared|extension-host)/", "^src/config/config\\.ts$"] },
    },
    {
      name: "extensions-are-private",
      severity: "error",
      comment:
        "The core reaches built-in extensions only through the list in extensions/index.ts; the CLI commands that read the factory's files (factory, report, trace) are the one exception.",
      from: { path: "^src/", pathNot: ["^src/extensions/", "^src/cli/commands/(factory|trace)\\.ts$"] },
      to: { path: "^src/extensions/", pathNot: "^src/extensions/index\\.ts$" },
    },
    {
      name: "messengers-are-adapters",
      severity: "error",
      comment:
        "Slack and Telegram stay behind the Messenger contract: messengers/ knows config, not sessions, the daemon or extensions.",
      from: { path: "^src/messengers/" },
      to: { path: "^src/", pathNot: "^src/(messengers|config|shared|sdk)/" },
    },
    {
      name: "sessions-are-the-domain",
      severity: "error",
      comment:
        "sessions/ is what Remy knows about Claude Code sessions; it doesn't know which app the user talks through.",
      from: { path: "^src/sessions/" },
      to: { path: "^src/", pathNot: "^src/(sessions|config|shared|sdk)/" },
    },
    {
      name: "config-is-low",
      severity: "error",
      from: { path: "^src/config/" },
      to: { path: "^src/", pathNot: "^src/(config|shared|sdk)/" },
    },
    {
      name: "link-is-the-protocol",
      severity: "error",
      comment: "link/ is the socket protocol between the daemon and its clients, not either side's logic.",
      from: { path: "^src/link/" },
      to: { path: "^src/", pathNot: ["^src/(link|config|shared|sdk)/", "^src/messengers/messenger\\.ts$"] },
    },
    {
      name: "extension-host-runs-extensions",
      severity: "error",
      from: { path: "^src/extension-host/" },
      to: { path: "^src/", pathNot: ["^src/(extension-host|config|shared|sdk)/", "^src/extensions/index\\.ts$"] },
    },
    {
      name: "daemon-is-not-a-library",
      severity: "error",
      comment: "Only the CLI starts the daemon; nothing else imports it.",
      from: { path: "^src/", pathNot: "^src/(daemon/|cli/|cli\\.ts$)" },
      to: { path: "^src/daemon/" },
    },
    {
      name: "cli-is-not-a-library",
      severity: "error",
      comment: "cli/ and the two entrypoints are leaves: put shared logic where its domain is.",
      from: { path: "^src/", pathNot: "^src/(cli/|cli\\.ts$)" },
      to: { path: "^src/(cli/|cli\\.ts$|channel\\.ts$)" },
    },
    {
      name: "no-orphans",
      severity: "error",
      comment: "A module nothing imports is dead code, or an entrypoint that belongs in package.json.",
      from: { orphan: true, pathNot: ["\\.test\\.ts$", "\\.d\\.ts$", "^src/(cli|channel)\\.ts$"] },
      to: {},
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "not-to-dev-dep",
      severity: "error",
      comment: "The plugin ships dist/ without node_modules; runtime code can't use a devDependency.",
      from: { path: "^src/", pathNot: "\\.test\\.ts$" },
      to: { dependencyTypes: ["npm-dev"], dependencyTypesNot: ["type-only"], pathNot: "node_modules/@types/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^(dist|node_modules)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
  },
};
