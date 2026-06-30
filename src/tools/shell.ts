import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';

const MAX_OUTPUT_LINES = 2000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export const shellTool = tool({
  name: 'shell',
  description:
    'Execute a shell command and return stdout+stderr. Output is capped at 2000 lines / 256KB. On Windows, uses cmd.exe.',
  inputSchema: z.object({
    command: z.string().describe('Shell command to execute'),
    timeout: z.number().optional().describe('Timeout in seconds (default: 120)'),
    cwd: z.string().optional().describe('Working directory (default: process cwd)'),
  }),
  execute: async ({ command, timeout = 120, cwd }) => {
    const isWindows = process.platform === 'win32';
    // On Windows use PowerShell so paths with spaces work reliably.
    // cmd.exe mangles quoted paths when they contain spaces or special chars.
    const shell = isWindows ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash');
    const shellArgs = isWindows ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];

    let timedOut = false;
    const proc = Bun.spawn([shell, ...shellArgs], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: cwd ?? process.cwd(),
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeout * 1000);

    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    const combined = (stdoutText + (stderrText ? '\n' + stderrText : '')).trimEnd();
    const lines = combined.split('\n');

    let truncated = false;
    let output: string;

    if (Buffer.byteLength(combined) > MAX_OUTPUT_BYTES) {
      // byte truncation
      const buf = Buffer.from(combined, 'utf8').subarray(0, MAX_OUTPUT_BYTES);
      output = buf.toString('utf8').replace(/\uFFFD$/, ''); // drop partial char
      truncated = true;
    } else if (lines.length > MAX_OUTPUT_LINES) {
      output = lines.slice(-MAX_OUTPUT_LINES).join('\n');
      truncated = true;
    } else {
      output = combined;
    }

    const out: Record<string, unknown> = { output, exitCode };
    if (truncated) out.truncated = true;
    if (timedOut) out.timedOut = true;
    return out;
  },
});
