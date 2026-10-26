/** Runs a command for what sessions/ asks claude, git and gh: its trimmed stdout, or undefined when it fails. */
export async function run(cmd: string[], cwd?: string): Promise<string | undefined> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return code === 0 ? out.trim() : undefined;
  } catch {
    return undefined;
  }
}
