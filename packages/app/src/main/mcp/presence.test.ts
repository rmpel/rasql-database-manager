import { describe, expect, it } from 'vitest';
import { cached, presenceForPlatform, type PresenceCheck } from './presence';

describe('presence checks', () => {
  it('picks one provider per platform, and none elsewhere', async () => {
    expect(presenceForPlatform('darwin').id).toBe('macos-local-authentication');
    expect(presenceForPlatform('win32').id).toBe('windows-hello');
    expect(presenceForPlatform('linux').id).toBe('linux-polkit');
    const other = presenceForPlatform('freebsd');
    expect(await other.available()).toBe(false);
    expect(await other.verify('anything')).toBe(false);
  });

  it('remembers availability for a while, but never a verification', async () => {
    let asked = 0;
    let verified = 0;
    const inner: PresenceCheck = {
      id: 'fake',
      label: 'Fake',
      available: async () => ++asked > 0,
      verify: async () => ++verified > 0,
    };
    const check = cached(inner, 60_000);
    await check.available();
    await check.available();
    expect(asked).toBe(1);
    await check.verify('x');
    await check.verify('x');
    expect(verified).toBe(2);
  });

  it('counts a provider that throws as unavailable', async () => {
    const check = cached({
      id: 'broken',
      label: 'Broken',
      available: async () => {
        throw new Error('no');
      },
      verify: async () => false,
    });
    expect(await check.available()).toBe(false);
  });

  it.runIf(process.platform === 'darwin')(
    'macOS reports whether the device-owner check can run, without showing a dialog',
    async () => {
      // Every Mac with a login password can; this proves the osascript bridge works.
      expect(await presenceForPlatform('darwin').available()).toBe(true);
    },
  );
});
