import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';

export const grepTool = tool({
  name: 'grep',
  description:
    'Search file contents by regex. Uses ripgrep (rg) if available, otherwise falls back to a JS implementation. Returns matches as { file, line, content }[], capped at 100.',
  inputSchema: z.object({
    pattern: z.string().describe('Regex pattern to search for'),
    path: z.string().optional().describe('Directory or file to search (default: cwd)'),
    glob: z.string().optional().describe('File filter, e.g. "*.ts"'),
    ignoreCase: z.boolean().optional().describe('Case-insensitive search'),
  }),
  execute: async ({ pattern, path, glob, ignoreCase }) => {
    const searchPath = path ?? process.cwd();

    // Try ripgrep first
    try {
      const args = ['rg', '--json', '-m', '100'];
      if (ignoreCase) args.push('-i');
      if (glob) args.push('--glob', glob);
      args.push(pattern, searchPath);

      const proc = Bun.spawnSync(args, { stderr: 'ignore' });
      if (proc.exitCode !== null && proc.exitCode <= 1) {
        const lines = new TextDecoder().decode(proc.stdout).split('\n').filter(Boolean);
        const matches: Array<{ file: string; line: number; content: string }> = [];
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'match') {
              matches.push({
                file: obj.data.path.text,
                line: obj.data.line_number,
                content: obj.data.lines.text.trimEnd(),
              });
            }
          } catch { /* skip malformed lines */ }
        }
        return { matches, count: matches.length };
      }
    } catch { /* rg not available */ }

    // JS fallback: walk directory
    const { readdirSync, statSync } = await import('fs');
    const { join } = await import('path');
    const regex = new RegExp(pattern, ignoreCase ? 'i' : '');
    const globMatcher = glob ? new Bun.Glob(glob) : null;
    const matches: Array<{ file: string; line: number; content: string }> = [];

    const walk = async (dir: string) => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        if (entry === 'node_modules') continue;
        const full = join(dir, entry);
        let stat;
        try { stat = statSync(full); } catch { continue; }
        if (stat.isDirectory()) {
          await walk(full);
        } else {
          if (globMatcher && !globMatcher.match(entry)) continue;
          try {
            const text = await Bun.file(full).text();
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                matches.push({ file: full, line: i + 1, content: lines[i] });
                if (matches.length >= 100) return;
              }
            }
          } catch { /* skip binary/unreadable */ }
        }
        if (matches.length >= 100) return;
      }
    };

    try {
      const stat = statSync(searchPath);
      if (stat.isDirectory()) {
        await walk(searchPath);
      } else {
        const text = await Bun.file(searchPath).text();
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push({ file: searchPath, line: i + 1, content: lines[i] });
            if (matches.length >= 100) break;
          }
        }
      }
    } catch (err: any) {
      return { error: err.message };
    }

    return { matches, count: matches.length };
  },
});
