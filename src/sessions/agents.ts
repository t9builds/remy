/** The sessions Claude Code itself lists (`claude agents --json`). */
export type AgentRow = {
  sessionId: string;
  name: string;
  kind: string;
  status: string;
  cwd: string;
  startedAt: number;
};

async function run(cmd: string[], cwd?: string): Promise<string | undefined> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return code === 0 ? out.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function listAgents(): Promise<AgentRow[]> {
  const out = await run(["claude", "agents", "--json"]);
  if (!out) throw new Error("`claude agents --json` failed; is Claude Code ≥ 2.1.224 on PATH?");
  return JSON.parse(out) as AgentRow[];
}
