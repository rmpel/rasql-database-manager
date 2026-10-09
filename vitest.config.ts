import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@rasql/driver-protocol': pkg('driver-protocol'),
      '@rasql/driver-sdk': pkg('driver-sdk'),
      '@rasql/driver-sqlite': pkg('driver-sqlite'),
      '@rasql/driver-mysql': pkg('driver-mysql'),
      '@shared': fileURLToPath(new URL('./packages/app/src/shared', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**'],
    projects: [
      {
        extends: true,
        test: { name: 'driver-protocol', include: ['packages/driver-protocol/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'driver-sdk', include: ['packages/driver-sdk/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'driver-sqlite', include: ['packages/driver-sqlite/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'driver-mysql', include: ['packages/driver-mysql/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'app',
          include: ['packages/app/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/e2e/**'],
        },
      },
      {
        extends: true,
        test: { name: 'localwp-addon', include: ['packages/localwp-addon/src/**/*.test.ts'] },
      },
    ],
  },
});
