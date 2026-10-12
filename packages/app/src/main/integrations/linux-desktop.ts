import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const URL_SCHEMES = ['rasql', 'mysql', 'mariadb', 'sqlite'] as const;
export const SQLITE_MIME_TYPES = ['application/vnd.sqlite3', 'application/x-sqlite3'] as const;

export interface DesktopIntegrationStatus {
  /** Only Linux AppImages need this; .deb installs ship a system-wide entry. */
  applicable: boolean;
  executable: string | null;
  desktopFile: string;
  /** A desktop entry exists and points at this executable. */
  installed: boolean;
  /** The AppImage sits at a fixed path, so updates can replace it without breaking the entry. */
  placed: boolean;
  /** Where a downloaded AppImage is moved to: ~/Applications/RaSQL.AppImage. */
  target: string;
}

export interface DesktopPaths {
  home?: string;
  /** The AppImage path Electron sees in `process.env.APPIMAGE`. */
  appImage?: string | undefined;
  platform?: NodeJS.Platform;
}

/**
 * Where a downloaded AppImage settles. One fixed name, so a newer download replaces the older one
 * and the desktop entry keeps pointing at the right file.
 */
export function appImageTarget(home = homedir()): string {
  return join(home, 'Applications', 'RaSQL.AppImage');
}

/** ~/Applications is where AppImage tools put them; ~/.local/bin is where install-linux.sh does. */
export function isPlaced(executable: string, home = homedir()): boolean {
  return (
    executable === appImageTarget(home) ||
    executable === join(home, '.local', 'bin', 'RaSQL.AppImage')
  );
}

/**
 * Move the running AppImage to ~/Applications/RaSQL.AppImage, replacing an older copy, and return
 * the new path. Moving a running AppImage is safe: its mount holds the file open. Across
 * filesystems it is copied next to the target first, so the replacement is still one rename.
 */
export function placeAppImage(executable: string, home = homedir()): string {
  const target = appImageTarget(home);
  if (executable === target) return target;
  mkdirSync(dirname(target), { recursive: true });
  try {
    renameSync(executable, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    const partial = `${target}.partial`;
    copyFileSync(executable, partial);
    chmodSync(partial, 0o755);
    renameSync(partial, target);
    unlinkSync(executable);
  }
  chmodSync(target, 0o755);
  return target;
}

export function desktopFilePath(home = homedir()): string {
  return join(home, '.local', 'share', 'applications', 'rasql.desktop');
}

/** The entry that makes RaSQL appear in menus and own the rasql:// links and database files. */
export function desktopEntry(executable: string): string {
  const mime = [...URL_SCHEMES.map((s) => `x-scheme-handler/${s}`), ...SQLITE_MIME_TYPES].join(';');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=RaSQL',
    'Comment=A fast, keyboard-first database manager for web developers',
    `Exec="${executable}" %u`,
    'Icon=rasql',
    'Terminal=false',
    'Categories=Development;Database;',
    `MimeType=${mime};`,
    'StartupWMClass=RaSQL',
    '',
  ].join('\n');
}

export function desktopIntegrationStatus(paths: DesktopPaths = {}): DesktopIntegrationStatus {
  const platform = paths.platform ?? process.platform;
  const executable = paths.appImage ?? process.env['APPIMAGE'] ?? null;
  const desktopFile = desktopFilePath(paths.home);
  const applicable = platform === 'linux' && executable !== null;
  const home = paths.home ?? homedir();
  let installed = false;
  if (applicable && existsSync(desktopFile)) {
    installed = readFileSync(desktopFile, 'utf8').includes(`Exec="${executable}" %u`);
  }
  const placed = executable !== null && isPlaced(executable, home);
  return { applicable, executable, desktopFile, installed, placed, target: appImageTarget(home) };
}

/**
 * Write the desktop entry and icon for the current user and make RaSQL the default handler for
 * its URL schemes. Nothing here needs root; it is what scripts/install-linux.sh does too.
 */
export async function installDesktopIntegration(
  iconSource: string | null,
  paths: DesktopPaths = {},
  exec: (file: string, args: string[]) => Promise<unknown> = (f, a) => run(f, a),
): Promise<DesktopIntegrationStatus> {
  const status = desktopIntegrationStatus(paths);
  if (!status.applicable || !status.executable)
    throw new Error('Desktop integration applies to Linux AppImages only');
  const home = paths.home ?? homedir();
  mkdirSync(dirname(status.desktopFile), { recursive: true });
  writeFileSync(status.desktopFile, desktopEntry(status.executable));
  if (iconSource && existsSync(iconSource)) {
    const iconDir = join(home, '.local', 'share', 'icons', 'hicolor', '1024x1024', 'apps');
    mkdirSync(iconDir, { recursive: true });
    copyFileSync(iconSource, join(iconDir, 'rasql.png'));
  }
  await exec('update-desktop-database', [dirname(status.desktopFile)]).catch(() => undefined);
  for (const scheme of URL_SCHEMES) {
    await exec('xdg-mime', ['default', 'rasql.desktop', `x-scheme-handler/${scheme}`]).catch(
      () => undefined,
    );
  }
  for (const mime of SQLITE_MIME_TYPES) {
    await exec('xdg-mime', ['default', 'rasql.desktop', mime]).catch(() => undefined);
  }
  return desktopIntegrationStatus(paths);
}
