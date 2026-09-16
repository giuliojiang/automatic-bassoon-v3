// Scans ./sheets/<piece>/*.{png,jpg,mp3} and writes manifest.json.
// Usage: npm run rebuild   (run from the repo root after adding/removing sheets)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const sheetsDir = path.join(root, 'sheets');
const natural = new Intl.Collator(undefined, { numeric: true });

function prettify(name) {
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

const pieces = [];
for (const name of fs.readdirSync(sheetsDir)) {
  const dir = path.join(sheetsDir, name);
  if (!fs.statSync(dir).isDirectory()) continue;
  const files = fs.readdirSync(dir);
  const pages = files.filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f)).sort(natural.compare);
  const audios = files.filter(f => /\.mp3$/i.test(f)).sort(natural.compare);
  if (pages.length === 0) {
    console.warn(`Skipping "${name}": no page images found`);
    continue;
  }
  pieces.push({ name, title: prettify(name), pages, audios });
}
pieces.sort((a, b) => a.title.localeCompare(b.title));

const out = path.join(root, 'manifest.json');
fs.writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), pieces }, null, 2));
const pageCount = pieces.reduce((s, p) => s + p.pages.length, 0);
console.log(`Wrote manifest.json: ${pieces.length} pieces, ${pageCount} pages`);
