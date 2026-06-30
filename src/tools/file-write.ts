import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

export const fileWriteTool = tool({
  name: 'file_write',
  description: 'Write content to a file, creating it and any parent directories if needed. ALWAYS use relative paths (e.g. "docs/analysis/report.md"), never absolute paths.',
  inputSchema: z.object({
    path: z.string().describe('Absolute or relative path to the file'),
    content: z.string().describe('Content to write'),
  }),
  execute: async ({ path, content }) => {
    try {
      try {
        mkdirSync(dirname(path), { recursive: true });
      } catch (e: any) {
        // Bun 1.3.14 on Windows throws EEXIST even with recursive:true when dir exists — safe to ignore
        if (e.code !== 'EEXIST') throw e;
      }
      await Bun.write(path, content);
      return { written: true, path };
    } catch (err: any) {
      return { error: err.message };
    }
  },
});
