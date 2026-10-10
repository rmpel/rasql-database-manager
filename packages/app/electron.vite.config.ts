import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const version = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string })
  .version;

/** Short commit of the build, with +dirty when the tree had uncommitted changes; "unknown" outside git. */
function buildCommit(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const dirty =
      execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() !== '';
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return process.env['GITHUB_SHA']?.slice(0, 7) ?? 'unknown';
  }
}
const buildInfo = {
  __APP_VERSION__: JSON.stringify(version),
  __APP_COMMIT__: JSON.stringify(buildCommit()),
  __APP_BUILT_AT__: JSON.stringify(new Date().toISOString()),
};

// Workspace packages are bundled from source so the packaged app needs no node_modules.
const workspace = (name: string): string => resolve(`../${name}/src/index.ts`);
const alias = {
  '@rasql/driver-protocol': workspace('driver-protocol'),
  '@rasql/driver-sdk': workspace('driver-sdk'),
  '@rasql/driver-sqlite': workspace('driver-sqlite'),
  '@rasql/driver-mysql': workspace('driver-mysql'),
  '@shared': resolve('src/shared'),
};
const bundled = Object.keys(alias).filter((k) => k.startsWith('@rasql/'));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
    resolve: { alias },
    define: buildInfo,
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    define: buildInfo,
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: { alias },
  },
});
