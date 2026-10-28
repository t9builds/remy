/**
 * The branch a session works on in a GitButler workspace. There every session's checkout is on `gitbutler/workspace`
 * with several branches applied at once, so git can't say whose is whose. The session's own commands can: the
 * branches it named in `but commit -b`, `but branch new`, `but push`, `but pr new` and `gh pr create --head`.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { run } from "./run";

export const GITBUTLER_WORKSPACE = "gitbutler/workspace";

/** The session's branch given its checkout's git branch: `gitbutler/workspace` is resolved from the transcript. */
export async function resolveBranch(
  gitBranch: string | undefined,
  cwd: string,
  transcriptPath: string | undefined,
): Promise<string | undefined> {
  if (gitBranch !== GITBUTLER_WORKSPACE) return gitBranch;
  return (await sessionBranch(cwd, transcriptPath)) ?? gitBranch;
}

/** The branch the session named last that still exists here or on origin; undefined when it named none. */
export async function sessionBranch(cwd: string, transcriptPath: string | undefined): Promise<string | undefined> {
  if (!transcriptPath) return undefined;
  const named = [...new Set(transcriptBranches(transcriptPath).toReversed())];
  if (!named.length) return undefined;
  // A typo, a GitButler CLI id ("to") or a branch removed once merged names no ref; an earlier branch may still.
  // Ref patterns would also match a prefix (`tomas` for `tomas/x`) or a glob (`*`), so compare exact names.
  const out = await run(["git", "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"], cwd);
  if (!out) return undefined;
  const refs = new Set(out.split("\n"));
  return named.find((b) => refs.has(`refs/heads/${b}`) || refs.has(`refs/remotes/origin/${b}`));
}

type Scan = { offset: number; branches: string[] };
const scans = new Map<string, Scan>();

/** Branches the session's Bash commands named, oldest first. Each look reads only what the transcript gained since. */
export function transcriptBranches(path: string): string[] {
  let scan = scans.get(path) ?? { offset: 0, branches: [] };
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    if (size < scan.offset) scan = { offset: 0, branches: [] };
    if (size === scan.offset) return scan.branches;
    fd = openSync(path, "r");
    const buf = Buffer.alloc(size - scan.offset);
    readSync(fd, buf, 0, buf.length, scan.offset);
    // Stop at the last full line; a line still being written is read whole next time.
    const end = buf.lastIndexOf(0x0a) + 1;
    const branches = [...scan.branches];
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      if (line.includes('"name":"Bash"')) branches.push(...lineBranches(line));
    }
    scan = { offset: scan.offset + end, branches };
    scans.set(path, scan);
    return scan.branches;
  } catch {
    return scan.branches; // no transcript yet, or it's gone
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function lineBranches(line: string): string[] {
  try {
    const content = JSON.parse(line)?.message?.content;
    if (!Array.isArray(content)) return [];
    return content
      .filter((c) => c?.type === "tool_use" && c.name === "Bash" && typeof c.input?.command === "string")
      .flatMap((c) => branchesNamed(c.input.command));
  } catch {
    return [];
  }
}

/** Branches a shell command line names in `but` and `gh pr create` commands, in order. */
export function branchesNamed(command: string): string[] {
  return simpleCommands(command)
    .map(branchOf)
    .filter((b): b is string => !!b && !b.startsWith("gitbutler/"));
}

function branchOf(words: string[]): string | undefined {
  // The program is the first word after any `NAME=value` assignments, called by name or by path.
  const at = words.findIndex((w) => !/^\w+=/.test(w));
  const program = words[at]?.split("/").pop();
  const args = words.slice(at + 1);
  if (program === "gh") {
    // `gh -R owner/repo pr create`: the global option takes a value.
    let g = 0;
    while (args[g]?.startsWith("-")) g += args[g] === "-R" || args[g] === "--repo" ? 2 : 1;
    if (args[g] !== "pr" || args[g + 1] !== "create") return undefined;
    // `--head owner:branch` names a branch of a fork.
    return optionValue(args, "-H", "--head")?.replace(/^[^:]*:/, "");
  }
  if (program !== "but") return undefined;
  // `but -C <path> <command>`: the global option takes a value.
  const sub = args.findIndex((w, j) => !w.startsWith("-") && args[j - 1] !== "-C" && args[j - 1] !== "--current-dir");
  if (sub < 0) return undefined;
  const [cmd, ...rest] = args.slice(sub);
  if (cmd === "commit") return optionValue(rest, "-b", "--branch");
  if (cmd === "push") return positional(rest, []);
  if (cmd === "branch" && rest[0] === "new") return positional(rest.slice(1), ["-A", "--above", "-B", "--below"]);
  if (cmd === "pr" && rest[0] === "new") return positional(rest.slice(1), ["-m", "--message", "-F", "--file"]);
  return undefined;
}

/** The value of option `short` or `long`, written `-b x`, `--branch x` or `--branch=x`. */
function optionValue(args: string[], short: string, long: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === short || a === long) return args[i + 1];
    if (a.startsWith(`${long}=`)) return a.slice(long.length + 1);
  }
  return undefined;
}

/** The first argument that isn't an option or the value of one of `valued`. */
function positional(args: string[], valued: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.includes(a)) i++;
    else if (!a.startsWith("-")) return a;
  }
  return undefined;
}

/**
 * The words of each simple command in a shell command line, with quotes and backslashes resolved. `;`, `&`, `|`,
 * parentheses and newlines outside quotes end a command. Heredoc bodies and `#` comments are text, not commands, and
 * are skipped. Enough to find `but` and `gh` in what agents run, not a shell.
 */
export function simpleCommands(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word: string | undefined;
  // The word after a redirection (`> file`) is its target, not an argument.
  let target = false;
  const endWord = () => {
    if (word !== undefined && !target) words.push(word);
    if (word !== undefined) target = false;
    word = undefined;
  };
  // Heredocs opened on the current line; their bodies start after its newline.
  const heredocs: { delimiter: string; tabs: boolean }[] = [];
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
    target = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const close = line.indexOf("'", i + 1);
      const to = close < 0 ? line.length : close;
      word = (word ?? "") + line.slice(i + 1, to);
      i = to;
    } else if (c === '"') {
      word ??= "";
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) i++;
        word += line[i];
      }
    } else if (c === "\\") {
      if (line[i + 1] === "\n") i++;
      else word = (word ?? "") + (line[++i] ?? "");
    } else if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      if (word !== undefined && /^\d+$/.test(word)) word = undefined;
      endWord();
      const tabs = line[i + 2] === "-";
      i += tabs ? 2 : 1;
      while (line[i + 1] === " " || line[i + 1] === "\t") i++;
      let delimiter = "";
      for (i++; i < line.length && !" \t\n;&|()<>".includes(line[i]!); i++) {
        if (line[i] === "'" || line[i] === '"') {
          const close = line.indexOf(line[i]!, i + 1);
          const to = close < 0 ? line.length : close;
          delimiter += line.slice(i + 1, to);
          i = to;
        } else delimiter += line[i];
      }
      i--;
      heredocs.push({ delimiter, tabs });
    } else if (c === "#" && word === undefined) {
      const eol = line.indexOf("\n", i);
      i = eol < 0 ? line.length : eol - 1;
    } else if (c === "<" || c === ">") {
      if (word !== undefined && /^\d+$/.test(word)) word = undefined; // the fd in `2>`
      endWord();
      while (line[i + 1] === "<" || line[i + 1] === ">") i++;
      // `2>&1` duplicates a descriptor and names no file.
      if (line[i + 1] === "&") while (/[&\d-]/.test(line[i + 1] ?? "")) i++;
      else target = true;
    } else if (c === " " || c === "\t") endWord();
    else if (";&|()\n".includes(c)) {
      endCommand();
      if (c === "\n") for (const h of heredocs.splice(0)) i = endOfHeredoc(line, i + 1, h.delimiter, h.tabs);
    } else word = (word ?? "") + c;
  }
  endCommand();
  return commands;
}

/** Where a heredoc body starting at `from` ends: its terminator line (the delimiter alone), or the end of the text. */
function endOfHeredoc(text: string, from: number, delimiter: string, tabs: boolean): number {
  let start = from;
  while (start < text.length) {
    const eol = text.indexOf("\n", start);
    const end = eol < 0 ? text.length : eol;
    const row = text.slice(start, end);
    if ((tabs ? row.replace(/^\t+/, "") : row) === delimiter) return end;
    start = end + 1;
  }
  return text.length;
}
