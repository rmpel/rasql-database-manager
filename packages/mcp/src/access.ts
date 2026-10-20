/**
 * The MCP setting of a connection (MCP.md section 1, D-40). Set in the app, never over MCP.
 *
 * - hidden: the connection does not exist for agents. The default.
 * - read:   reads only; writes are refused without a prompt.
 * - ask:    reads, and writes after the user allows them in a prompt.
 * - secure: like ask, but every change set needs the user's Touch ID, not just a click (D-43).
 * - write:  reads and writes without a prompt, except destructive changes, which always ask.
 */
export type McpAccess = 'hidden' | 'read' | 'ask' | 'secure' | 'write';

export const MCP_ACCESS_LEVELS: readonly McpAccess[] = ['hidden', 'read', 'ask', 'secure', 'write'];

/** The MCP settings a connection may have. A read-only connection never writes for anyone. */
export function allowedAccess(readOnly: boolean): McpAccess[] {
  return readOnly ? ['hidden', 'read'] : ['hidden', 'read', 'ask', 'secure', 'write'];
}

/** The setting that applies: absent means hidden, and the read-only flag caps it at read. */
export function effectiveAccess(stored: McpAccess | undefined, readOnly: boolean): McpAccess {
  const access = stored && MCP_ACCESS_LEVELS.includes(stored) ? stored : 'hidden';
  if (readOnly && canWrite(access)) return 'read';
  return access;
}

export const canRead = (a: McpAccess): boolean => a !== 'hidden';
export const canWrite = (a: McpAccess): boolean => a === 'ask' || a === 'secure' || a === 'write';

/** Every change set waits for the user, and nothing the user said earlier skips that. */
export const confirmsEveryChange = (a: McpAccess): boolean => a === 'secure';
