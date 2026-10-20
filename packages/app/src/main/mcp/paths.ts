import { app } from 'electron';
import { createHash } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where the app listens for `rasql mcp`. Both sides compute it from the user data directory,
 * so a test install with its own RASQL_USER_DATA gets its own socket.
 */
export function mcpSocketPath(): string {
  const userData = app.getPath('userData');
  const tag = createHash('sha256').update(userData).digest('hex').slice(0, 12);
  if (process.platform === 'win32') return `\\\\.\\pipe\\rasql-mcp-${userInfo().username}-${tag}`;
  const inData = join(userData, 'mcp.sock');
  // Unix socket paths are limited to about 104 bytes.
  return inData.length < 100 ? inData : join(tmpdir(), `rasql-mcp-${tag}.sock`);
}

/** The command an MCP client runs: this executable with the `mcp` argument. */
export function mcpCommand(): string[] {
  if (app.isPackaged) return [process.execPath, 'mcp'];
  // Unpackaged, Electron needs the app it was started with: a directory or out/main/index.js.
  return [process.execPath, resolve(process.argv[1] ?? app.getAppPath()), 'mcp'];
}
