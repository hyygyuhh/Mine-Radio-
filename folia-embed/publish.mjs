import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const vendor = path.resolve(root, '../vendor/folia');
const assetsSrc = path.join(dist, 'assets');
const assetsDest = path.join(vendor, 'assets');

if (!fs.existsSync(assetsSrc)) {
  throw new Error('dist/assets is missing. Run vite build first.');
}

fs.rmSync(assetsDest, { recursive: true, force: true });
fs.cpSync(assetsSrc, assetsDest, { recursive: true });

// Hashed asset names already change every build. Do not append a cache query:
// chunks import this entry as ./index-<hash>.js, and a different query is a
// second module that runs createRoot again.
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
fs.writeFileSync(path.join(vendor, 'mineradio-embed.html'), html);
console.log('Published Folia embed to vendor/folia');
