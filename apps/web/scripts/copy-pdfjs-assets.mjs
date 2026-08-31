import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../../../node_modules/pdfjs-dist/', import.meta.url));
const destinationRoot = fileURLToPath(new URL('../public/pdfjs/', import.meta.url));

await mkdir(destinationRoot, { recursive: true });
for (const directory of ['cmaps', 'iccs', 'standard_fonts', 'wasm']) {
  await cp(`${sourceRoot}${directory}`, `${destinationRoot}${directory}`, { force: true, recursive: true });
}
