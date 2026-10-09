import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const version = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string })
  .version;

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
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    define: { __APP_VERSION__: JSON.stringify(version) },
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: { alias },
  },
});
