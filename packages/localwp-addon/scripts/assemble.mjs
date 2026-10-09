// Turns the compiled sources into the folder Local expects: a package.json it understands plus the icon.
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
mkdirSync(dist, { recursive: true });
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
writeFileSync(
  resolve(dist, 'package.json'),
  JSON.stringify(
    {
      name: 'rasql-localwp',
      productName: 'RaSQL',
      version: pkg.version,
      description: pkg.description,
      author: 'Remon Pel',
      license: pkg.license,
      keywords: ['local-addon'],
      icon: 'icon.svg',
      bgColor: '#1b2a4a',
      main: 'main.js',
      renderer: 'renderer.js',
      engines: { 'local-by-flywheel': '>=9.0.0' },
    },
    null,
    2,
  ) + '\n',
);
copyFileSync(resolve(root, 'icon.svg'), resolve(dist, 'icon.svg'));
console.log(`assembled rasql-localwp ${pkg.version} in ${dist}`);
