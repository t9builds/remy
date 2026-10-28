# Remy agent guide

Remy relays Slack and Telegram to the Claude Code sessions on one person's machine, and runs a factory that takes
their PRs to production. It is a Claude Code plugin: a Bun CLI, a long-running daemon, and the coordinator's channel.

Read before changing:

- Naming a concept, or using one: [GLOSSARY.md](GLOSSARY.md). Code uses its terms (`waitingList`, not `queue`).
- Reversing or extending a recorded decision: the matching ADR in [docs/adr/](docs/adr/).

## Working principles

Ship the smallest correct change. Keep unrelated cleanup out of the change you were asked for.

Find the module that owns the behavior and the closest existing analogue, and follow it. Extend what exists when its
meaning matches; add a new module only for a new responsibility. Small local duplication beats a shared helper with
one caller. Code decides what code can: waits, gates, routing and fixed wording are deterministic, and an LLM turn is
for judgment ([ADR-0007](docs/adr/0007-deterministic-where-possible.md)).

## Where code goes

Each folder in `src/` has one owner. `src/cli.ts` and `src/channel.ts` are the only files at the root: the two
entrypoints `dist/` is built from.

| Folder | Owns |
|---|---|
| `cli/` | The `remy` commands, one file per command in `cli/commands/`; setup, doctor and the hook runner |
| `daemon/` | The long-running process: routing, the pinned waiting list, turning what it sees into extension events |
| `link/` | The socket protocol between the daemon and its clients (the channel, the CLI) |
| `messengers/` | Slack and Telegram behind the `Messenger` contract (`messenger.ts`) |
| `sessions/` | What Remy knows about sessions: snapshots, changes, names, spawning and closing agents, the waiting list |
| `config/` | Loading and saving `~/.remy/config.json`, routing sessions to workspaces, tokens, repo lookup |
| `sdk/` | The public surface: the extension API and the `remy/factory` DSL, with their own types and the config schema |
| `extension-host/` | Loading extensions and running them in the daemon |
| `extensions/` | The built-in extensions, listed in `extensions/index.ts`; the factory is all in `extensions/factory/` |
| `shared/` | Pure leaf code the core and the built-ins both use: paths, JSON files, CI rollups, notices |

Imports point toward `sdk/`. `cli/` and `daemon/` compose the rest, and nothing imports them. `sessions/`,
`messengers/`, `link/` and `extension-host/` stay out of each other (`link/` uses only the `Messenger` types), and all
of them build on `config/`, `shared/` and `sdk/`. `sdk/` imports nothing of Remy's. A built-in extension acts through
the Remy API like anyone's extension: it imports `sdk/`, `shared/` and its own files. When it needs more, add that to `sdk/extension.ts` and
implement it in `extension-host/host.ts`. The core reaches built-ins only through `extensions/index.ts`; the one
exception is `cli/commands/factory.ts` and `cli/commands/trace.ts`, which use the factory's own modules to read and
write its files, so `remy factory`, `remy report` and `remy trace` work while the daemon is down. `.dependency-cruiser.cjs` holds the exact rules; when it
reports a violation, move the code to the module that owns it and keep the rule.

## Conventions

- Files are kebab-case. Tests sit next to their subject as `name.test.ts`.
- Each module opens with a comment saying what it is for. Other comments give the reason behind non-obvious code.
- Import from the module that defines a symbol; `extensions/index.ts` (the built-ins list) is the only index file.
- `sdk/` is a contract for extensions and repos' `.remy/factory.ts` files: a change there is a breaking change for
  them, so say so in the commit (`refactor!:` / `BREAKING CHANGE:`).
- Files in `~/.remy` keep their names across releases (`queue.json`, `state/builtin_factory.json`): users upgrade
  with state on disk.
- Find the plugin's folder with `PLUGIN_ROOT` (`shared/paths.ts`). `import.meta.dir` differs between `src/` and the
  bundle in `dist/`.

## Verify

Run `bun run check` before you commit: types, Biome lint and format, module boundaries, unused code (knip), tests,
and whether `dist/` matches the source. An installed plugin runs the committed `dist/`, so after changing `src/`
run `bun run build` and commit `dist/` with it. `bun run format` fixes formatting and import order.

Cover changed logic with a test beside it; pure functions with a fake world (see `extensions/factory/pipeline.test.ts`)
are the cheapest. To see a change work for real, the `verify-remy` skill (`.claude/skills/verify-remy/`) runs this
checkout's daemon and coordinator against a test Slack workspace and drives them as the user. Report what you ran, and
what you couldn't exercise against real Slack, Telegram, gh or Claude Code.

## Documentation

- A decision with real alternatives: a new ADR in `docs/adr/`, numbered after the highest one.
- A new domain term: `GLOSSARY.md`.
- What users see or configure, including the extension API: `README.md`.
- The coordinator's behavior: `coordinator.md`, its system prompt.
