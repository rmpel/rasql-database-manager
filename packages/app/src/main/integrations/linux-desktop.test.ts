import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { desktopEntry, desktopIntegrationStatus, installDesktopIntegration } from './linux-desktop';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rasql-desktop-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('Linux desktop integration', () => {
  it('is only applicable to Linux AppImages', () => {
    expect(
      desktopIntegrationStatus({ home, platform: 'darwin', appImage: '/x/RaSQL.AppImage' })
        .applicable,
    ).toBe(false);
    expect(
      desktopIntegrationStatus({ home, platform: 'linux', appImage: undefined }).applicable,
    ).toBe(false);
    expect(
      desktopIntegrationStatus({ home, platform: 'linux', appImage: '/x/RaSQL.AppImage' }),
    ).toMatchObject({ applicable: true, installed: false });
  });

  it('writes the entry, icon and mime defaults, and reports installed afterwards', async () => {
    const calls: string[] = [];
    const icon = join(home, 'icon.png');
    writeFileSync(icon, 'png');
    const status = await installDesktopIntegration(
      icon,
      { home, platform: 'linux', appImage: '/opt/apps/RaSQL.AppImage' },
      async (file, args) => {
        calls.push([file, ...args].join(' '));
      },
    );
    expect(status.installed).toBe(true);
    const entry = readFileSync(join(home, '.local/share/applications/rasql.desktop'), 'utf8');
    expect(entry).toContain('Exec="/opt/apps/RaSQL.AppImage" %u');
    expect(entry).toContain('x-scheme-handler/rasql');
    expect(entry).toContain('application/vnd.sqlite3');
    expect(existsSync(join(home, '.local/share/icons/hicolor/1024x1024/apps/rasql.png'))).toBe(
      true,
    );
    expect(calls).toContain('xdg-mime default rasql.desktop x-scheme-handler/rasql');
    expect(calls.some((c) => c.startsWith('update-desktop-database'))).toBe(true);
  });

  it('treats an entry for another executable as not installed', () => {
    const file = join(home, '.local/share/applications/rasql.desktop');
    mkdirSync(join(home, '.local/share/applications'), { recursive: true });
    writeFileSync(file, desktopEntry('/elsewhere/RaSQL.AppImage'));
    expect(
      desktopIntegrationStatus({ home, platform: 'linux', appImage: '/here/RaSQL.AppImage' })
        .installed,
    ).toBe(false);
  });
});
