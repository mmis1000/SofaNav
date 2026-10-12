// Assembles the GitHub Pages site into _site/:
//   site/*                     the landing page
//   sofanav.js                 the built script (dist/sofanav.user.js), run by the page itself
//   sofanav.user.js            userscript install link (Tampermonkey/Violentmonkey open it)
//   sofanav-extension.zip      extension/ folder, for "Load unpacked"
//   sofanav-demo.mp4           demo video
// Usage: npm run build && npm run site   (CI does both; see .github/workflows/ci.yml)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const out = path.join(root, '_site');
// Empty it rather than delete it: on Windows a folder being served (npm run serve:site) can't be removed.
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) fs.rmSync(path.join(out, f), { recursive: true, force: true });

for (const f of fs.readdirSync(path.join(root, 'site'))) fs.copyFileSync(path.join(root, 'site', f), path.join(out, f));
const userscript = fs.readFileSync(path.join(root, 'dist', 'sofanav.user.js'));
fs.writeFileSync(path.join(out, 'sofanav.user.js'), userscript);
fs.writeFileSync(path.join(out, 'sofanav.js'), userscript); // the page runs the same build
fs.copyFileSync(path.join(root, 'demo', 'sofanav-demo.mp4'), path.join(out, 'sofanav-demo.mp4'));
fs.writeFileSync(path.join(out, 'sofanav-extension.zip'), zip(path.join(root, 'extension'), 'sofanav-extension'));
// Build id for the page footer.
const build = userscript.toString('utf8').match(/^\/\/ Build ([0-9a-f]+) =/m)?.[1] || 'dev';
const version = userscript.toString('utf8').match(/^\/\/ @version\s+(\S+)/m)?.[1] || '';
fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify({ build, version }));
console.log(`_site/ ready: build ${build}, version ${version}`);
for (const f of fs.readdirSync(out)) console.log('  ' + f.padEnd(24) + fs.statSync(path.join(out, f)).size + ' bytes');

// Minimal ZIP writer (deflate), so building the site needs no extra dependencies.
function zip(dir, prefix) {
  const files = [];
  (function walk(d, rel) {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name), r = rel ? rel + '/' + name : name;
      if (fs.statSync(p).isDirectory()) walk(p, r);
      else files.push({ name: `${prefix}/${r}`, data: fs.readFileSync(p) });
    }
  })(dir, '');
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const local = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const comp = zlib.deflateRawSync(f.data);
    const crc = crc32(f.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(comp.length, 18); head.writeUInt32LE(f.data.length, 22); head.writeUInt16LE(name.length, 26);
    local.push(head, name, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(f.data.length, 24); cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += head.length + name.length + comp.length;
  }
  const cenSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
