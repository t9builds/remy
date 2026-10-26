/** The sessions Claude Code itself lists (`claude agents --json`). */
import { run } from "./run";

export type AgentRow = {
  sessionId: string;
  name: string;
  kind: string;
  status: string;
  cwd: string;
  startedAt: number;
};

export async function listAgents(): Promise<AgentRow[]> {
  const out = await run(["claude", "agents", "--json"]);
  if (!out) throw new Error("`claude agents --json` failed; is Claude Code ≥ 2.1.224 on PATH?");
  return JSON.parse(out) as AgentRow[];
}
