import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';

/**
 * Placeholder for domain-specific SW tools.
 * Rename/extend this for Scottish Water-specific operations,
 * e.g. running SQLcl queries, parsing DAX, diffing model tables.
 */
export const swCustomTool = tool({
  name: 'sw_custom',
  description: 'Scottish Water domain tool placeholder — not yet implemented.',
  inputSchema: z.object({
    action: z.string().describe('Action name'),
    params: z.record(z.string(), z.unknown()).optional().describe('Action parameters'),
  }),
  execute: async ({ action }) => {
    return { error: `sw_custom action '${action}' not yet implemented.` };
  },
});
