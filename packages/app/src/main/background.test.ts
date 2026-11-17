import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundLife } from './background';

describe('BackgroundLife', () => {
  let windows = false;
  let quit: ReturnType<typeof vi.fn<() => void>>;
  const make = (active = true): BackgroundLife =>
    new BackgroundLife(active, { lingerMs: 1000, hasWindows: () => windows, quit });

  beforeEach(() => {
    vi.useFakeTimers();
    windows = false;
    quit = vi.fn<() => void>();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('quits when no bridge connects in time', () => {
    make();
    vi.advanceTimersByTime(1000);
    expect(quit).toHaveBeenCalledOnce();
  });

  it('stays while a bridge is connected, and quits after the last one leaves', () => {
    const life = make();
    life.bridgesChanged(1);
    vi.advanceTimersByTime(5000);
    expect(quit).not.toHaveBeenCalled();
    life.bridgesChanged(0);
    vi.advanceTimersByTime(999);
    expect(quit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(quit).toHaveBeenCalledOnce();
  });

  it('waits for an open prompt window', () => {
    const life = make();
    windows = true;
    life.windowsChanged();
    vi.advanceTimersByTime(5000);
    expect(quit).not.toHaveBeenCalled();
    windows = false;
    life.windowsChanged();
    vi.advanceTimersByTime(1000);
    expect(quit).toHaveBeenCalledOnce();
  });

  it('a bridge that reconnects within the linger time keeps it running', () => {
    const life = make();
    life.bridgesChanged(1);
    life.bridgesChanged(0);
    vi.advanceTimersByTime(500);
    life.bridgesChanged(1);
    vi.advanceTimersByTime(5000);
    expect(quit).not.toHaveBeenCalled();
  });

  it('never quits once the user opened a main window', () => {
    const life = make();
    life.leave();
    vi.advanceTimersByTime(5000);
    expect(quit).not.toHaveBeenCalled();
    expect(life.background).toBe(false);
  });

  it('an instance the user started never quits on its own', () => {
    make(false);
    vi.advanceTimersByTime(5000);
    expect(quit).not.toHaveBeenCalled();
  });

  it('goes back to the background when every window closed while bridges are connected', () => {
    const life = make(false);
    life.bridgesChanged(1);
    life.enter();
    expect(life.serving).toBe(true);
    life.bridgesChanged(0);
    vi.advanceTimersByTime(1000);
    expect(quit).toHaveBeenCalledOnce();
  });
});
