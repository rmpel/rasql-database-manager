import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, Notification } from 'electron';
import type { ChangeSetSummary } from '@rasql/mcp';
import { clientLabel } from '@rasql/mcp';
import type { McpPrompt, McpPromptAnswer } from '@shared/api';
import { IPC } from '@shared/api';
import type { WindowManager } from '../windows';

interface Pending {
  prompt: McpPrompt;
  resolve: (answer: McpPromptAnswer | null) => void;
  window: BrowserWindow | null;
  timer: NodeJS.Timeout;
}

type PromptBody = McpPrompt extends infer P
  ? P extends { id: string }
    ? Omit<P, 'id'>
    : never
  : never;

/**
 * Prompts for agents: a client's first contact, a connection an agent wants to add, and
 * change sets to commit. Each is a small window of its own; closing it counts as Deny, and
 * a prompt nobody answers in time expires as Deny (MCP.md section 5).
 */
export class PromptManager {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly windows: WindowManager,
    private readonly windowsFor: (connectionId: string) => number[],
  ) {}

  /** Resolves with the answer, or null when the prompt expired. */
  ask(
    body: PromptBody,
    opts: { connectionId?: string; timeoutMs: number },
  ): Promise<McpPromptAnswer | null> {
    const id = randomUUID();
    const prompt = { ...body, id } as McpPrompt;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(id, null), opts.timeoutMs);
      const entry: Pending = { prompt, resolve, window: null, timer };
      this.pending.set(id, entry);

      const focused = BrowserWindow.getFocusedWindow();
      const parentId = opts.connectionId ? this.windowsFor(opts.connectionId)[0] : undefined;
      const parent =
        parentId === undefined ? undefined : (BrowserWindow.fromId(parentId) ?? undefined);
      const inForeground = focused !== null;
      const win = this.windows.createPrompt(id, parent, inForeground);
      entry.window = win;
      win.on('closed', () => {
        // Closing the window without answering is a Deny.
        if (this.pending.has(id)) this.finish(id, { decision: 'deny' });
      });
      if (!inForeground) this.notify(prompt, win);
    });
  }

  get(id: string): McpPrompt | null {
    return this.pending.get(id)?.prompt ?? null;
  }

  answer(id: string, answer: McpPromptAnswer): void {
    this.finish(id, answer);
  }

  /** Keep an open commit prompt in step with its change set. */
  changeSetUpdated(summary: ChangeSetSummary): void {
    for (const p of this.pending.values()) {
      if (p.prompt.kind === 'commit' && p.prompt.changeSet.id === summary.id) {
        p.prompt.changeSet = summary;
        if (p.window && !p.window.isDestroyed()) p.window.webContents.send(IPC.mcpChanged);
      }
    }
  }

  /** Deny everything still open, e.g. when the user revokes all access. */
  denyAll(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, { decision: 'deny' });
  }

  private finish(id: string, answer: McpPromptAnswer | null): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(answer);
    if (p.window && !p.window.isDestroyed()) p.window.close();
  }

  private notify(prompt: McpPrompt, win: BrowserWindow): void {
    if (!Notification.isSupported()) return;
    const who = clientLabel(prompt.client);
    const body =
      prompt.kind === 'client'
        ? `${who} wants to use RaSQL.`
        : prompt.kind === 'connection'
          ? `${who} wants to add the connection ${prompt.connection.name}.`
          : `${who} wants to commit changes to ${prompt.changeSet.database ?? prompt.changeSet.connectionName}.`;
    const n = new Notification({ title: 'RaSQL', body });
    n.on('click', () => {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
      }
    });
    n.show();
    if (process.platform === 'darwin') app.dock?.bounce('informational');
  }
}
