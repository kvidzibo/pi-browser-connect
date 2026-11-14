import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Requires librsvg's rsvg-convert; the SVG is the source for both status colors.
const directory = new URL('../browser-extension/icons/', import.meta.url);
const source = readFileSync(new URL('icon.svg', directory), 'utf8');
for (const size of [16, 32, 48, 128]) {
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', fileURLToPath(new URL(`icon-${size}.png`, directory))], { input: source });
}
for (const size of [16, 32]) {
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', fileURLToPath(new URL(`icon-connected-${size}.png`, directory))], { input: source.replace('#EF4444', '#22C55E') });
}
