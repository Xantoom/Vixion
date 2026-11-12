// Precompresses the built interface: the server sends the .br or .gz file when the browser takes it,
// so nothing is compressed at request time.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = new URL('../dist', import.meta.url).pathname;
const compressible = /\.(js|css|html|svg|json|txt|webmanifest|woff2?)$/;

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

let saved = 0;
for (const path of walk(root)) {
	// woff2 is already compressed.
	if (!compressible.test(path) || path.endsWith('.woff2')) continue;
	const data = readFileSync(path);
	if (data.length < 1024) continue;
	const br = brotliCompressSync(data, {
		params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
	});
	const gz = gzipSync(data, { level: 9 });
	if (br.length < data.length * 0.9) writeFileSync(`${path}.br`, br);
	if (gz.length < data.length * 0.9) writeFileSync(`${path}.gz`, gz);
	saved += data.length - br.length;
}
console.log(`compressed: ${Math.round(saved / 1024)} KiB saved with brotli`);
