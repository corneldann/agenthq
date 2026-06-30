import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';

export const globTool = tool({
  name: 'glob',
  description: 'Find files by glob pattern. Returns relative paths, capped at 1000 results.',
  inputSchema: z.object({
    pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts"'),
    path: z.string().optional().describe('Directory to search in (default: cwd)'),
  }),
  execute: async ({ pattern, path }) => {
    try {
      const cwd = path ?? process.cwd();
      const glob = new Bun.Glob(pattern);
      const results: string[] = [];
      for await (const file of glob.scan({ cwd, dot: false })) {
        if (file.includes('node_modules')) continue;
        results.push(file);
        if (results.length >= 1000) break;
      }
      return { files: results, count: results.length };
    } catch (err: any) {
      return { error: err.message };
    }
  },
});
