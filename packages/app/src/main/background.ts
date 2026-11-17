/** The argument `rasql mcp` starts the app with when it is not running (MCP.md section 8). */
export const BACKGROUND_ARG = '--mcp-background';

/** How long a background instance waits after its last bridge leaves before it quits. */
export const BACKGROUND_LINGER_MS = 30_000;

/**
 * The life of an instance started by `rasql mcp` (D-45). It runs without a main window and
 * without a Dock icon while bridges use it, and quits once no bridge is connected and no window
 * is open for a while. Opening a main window ends background mode for good.
 */
export class BackgroundLife {
  private bridges = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private active: boolean,
    private readonly opts: { lingerMs: number; hasWindows: () => boolean; quit: () => void },
  ) {
    this.check();
  }

  get background(): boolean {
    return this.active;
  }

  /** The number of `rasql mcp` bridges connected to the socket changed. */
  bridgesChanged(count: number): void {
    this.bridges = count;
    this.check();
  }

  /** A window opened or closed. */
  windowsChanged(): void {
    this.check();
  }

  /** The user opened a main window: stay running like any app they started. */
  leave(): void {
    this.active = false;
    this.check();
  }

  /** Every window closed while bridges are connected (Windows, Linux): keep serving them. */
  enter(): void {
    this.active = true;
    this.check();
  }

  /** Whether quitting now would cut off a bridge. */
  get serving(): boolean {
    return this.bridges > 0;
  }

  private idle(): boolean {
    return this.active && this.bridges === 0 && !this.opts.hasWindows();
  }

  private check(): void {
    if (!this.idle()) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.idle()) this.opts.quit();
    }, this.opts.lingerMs);
  }
}
