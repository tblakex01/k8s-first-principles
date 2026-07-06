/*
 * Assembles the single self-contained deliverable from src/ parts:
 *   index.html      — full standalone page (the repo deliverable)
 *   dist/artifact.html — same content without the outer document wrapper,
 *                        for hosting environments that provide the skeleton
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = dirname(fileURLToPath(import.meta.url));
const root = join(src, '..');
const read = (f) => readFileSync(join(src, f), 'utf8');

const head = read('head.html');
const body = read('body.html');
const engine = read('engine.js');
const ui = read('ui.js');

const scripts =
  '<script id="sim-engine">\n' + engine + '</script>\n' +
  '<script>\n' + ui + '</script>\n';

writeFileSync(join(root, 'index.html'),
  head + body + scripts + '</body>\n</html>\n');

// artifact variant: <title> + <style> + body content + scripts, no document tags
const title = head.match(/<title>[\s\S]*?<\/title>/)[0];
const style = head.match(/<style>[\s\S]*?<\/style>/)[0];
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'artifact.html'),
  title + '\n' + style + '\n' + body + scripts);

console.log('built index.html and dist/artifact.html');
