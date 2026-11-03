/** The sessions Claude Code itself lists (`claude agents --json`). */
import { run } from "./run";

export type AgentRow = {
  sessionId: string;
  name: string;
  kind: string;
  status: string;
  cwd: string;
  startedAt: number;
  /** A background session's short id, the one `claude stop`, `logs` and `rm` take (they don't take the full id). */
  id?: string;
  /** The session's process. A background session whose process is gone has none, and no status. */
  pid?: number;
  /** A background session's state (working, blocked, done, stopped), kept after its process is gone. */
  state?: string;
};

/** `all` adds the background sessions that are done or stopped. */
export async function listAgents(all = false): Promise<AgentRow[]> {
  const out = await run(["claude", "agents", "--json", ...(all ? ["--all"] : [])]);
  if (!out) throw new Error("`claude agents --json` failed; is Claude Code ≥ 2.1.224 on PATH?");
  return JSON.parse(out) as AgentRow[];
}
