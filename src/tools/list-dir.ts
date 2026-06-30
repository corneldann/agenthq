import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

export const listDirTool = tool({
  name: 'list_dir',
  description: 'List directory contents, sorted alphabetically. Directories are shown with a trailing /. Capped at 500 entries.',
  inputSchema: z.object({
    path: z.string().optional().describe('Directory path (default: cwd)'),
  }),
  execute: async ({ path }) => {
    const dir = path ?? process.cwd();
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      const sorted = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 500)
        .map((e) => {
          const isDir = e.isDirectory();
          let size: number | undefined;
          if (!isDir) {
            try { size = statSync(join(dir, e.name)).size; } catch { /* ignore */ }
          }
          return { name: isDir ? e.name + '/' : e.name, ...(size !== undefined && { size }) };
        });
      return { entries: sorted, count: sorted.length };
    } catch (err: any) {
      if (err.code === 'ENOENT') return { error: `Directory not found: ${dir}` };
      return { error: err.message };
    }
  },
});
