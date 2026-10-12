// Downloads and unpacks the Violentmonkey release the userscript security test runs under.
// Pinned by version and sha256, so CI tests the same build every time.
// Output: .cache/violentmonkey-<version>/ (an unpacked MV3 extension). Prints that path.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const VERSION = '2.49.0';
const URL = `https://github.com/violentmonkey/violentmonkey/releases/download/v${VERSION}/Violentmonkey-mv3-v${VERSION}.zip`;
const SHA256 = '3fa676c803a9698453ed23dfe496d4bc29a4bec52f6a95e55c43c2955921f8ee';
const CACHE = path.join(__dirname, '..', '.cache');
const ZIP = path.join(CACHE, 'dl', `Violentmonkey-mv3-v${VERSION}.zip`);
const OUT = path.join(CACHE, `violentmonkey-${VERSION}`);

// Minimal zip reader (stored and deflated entries, via the central directory).
function unzip(buf, dir) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    const target = path.resolve(dir, name);
    if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error(`unsafe path in zip: ${name}`);
    if (name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, method === 0 ? data : zlib.inflateRawSync(data));
  }
}

(async () => {
  if (fs.existsSync(path.join(OUT, 'manifest.json'))) { console.log(OUT); return; }
  let buf = fs.existsSync(ZIP) ? fs.readFileSync(ZIP) : null;
  if (!buf) {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  if (hash !== SHA256) throw new Error(`sha256 mismatch: ${hash}`);
  fs.mkdirSync(path.dirname(ZIP), { recursive: true });
  fs.writeFileSync(ZIP, buf);
  fs.rmSync(OUT, { recursive: true, force: true });
  unzip(buf, OUT);
  console.log(OUT);
})().catch((e) => { console.error(e.message); process.exit(1); });
