import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';

function unifiedDiff(original: string, modified: string, path: string): string {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');
  const lines: string[] = [`--- ${path}`, `+++ ${path}`];

  // Simple line-by-line diff with 3 lines context
  let i = 0, j = 0;
  while (i < origLines.length || j < modLines.length) {
    if (i < origLines.length && j < modLines.length && origLines[i] === modLines[j]) {
      i++; j++;
    } else {
      // Find extent of change
      const hunkStart = i;
      const hunkStartJ = j;
      while (
        (i < origLines.length || j < modLines.length) &&
        !(i < origLines.length && j < modLines.length && origLines[i] === modLines[j])
      ) {
        if (i < origLines.length) i++;
        if (j < modLines.length) j++;
      }
      lines.push(`@@ -${hunkStart + 1},${i - hunkStart} +${hunkStartJ + 1},${j - hunkStartJ} @@`);
      for (let k = hunkStart; k < i; k++) lines.push(`-${origLines[k] ?? ''}`);
      for (let k = hunkStartJ; k < j; k++) lines.push(`+${modLines[k] ?? ''}`);
    }
  }
  return lines.join('\n');
}

export const fileEditTool = tool({
  name: 'file_edit',
  description:
    'Apply search-and-replace edits to a file. Each edit must match exactly once in the file. Returns a unified diff of all changes.',
  inputSchema: z.object({
    path: z.string().describe('Absolute or relative path to the file'),
    edits: z
      .array(
        z.object({
          old_text: z.string().describe('Text to find — must appear exactly once'),
          new_text: z.string().describe('Replacement text'),
        }),
      )
      .describe('List of search-and-replace operations to apply in order'),
  }),
  execute: async ({ path, edits }) => {
    try {
      const original = await Bun.file(path).text();
      let current = original;

      for (const { old_text, new_text } of edits) {
        const count = current.split(old_text).length - 1;
        if (count === 0) return { error: `old_text not found in file: ${JSON.stringify(old_text.slice(0, 80))}` };
        if (count > 1) return { error: `old_text is ambiguous (${count} matches): ${JSON.stringify(old_text.slice(0, 80))}` };
        current = current.replace(old_text, new_text);
      }

      await Bun.write(path, current);
      const diff = unifiedDiff(original, current, path);
      return { edited: true, path, diff };
    } catch (err: any) {
      if (err.code === 'ENOENT') return { error: `File not found: ${path}` };
      return { error: err.message };
    }
  },
});
