// Builds dist/gamepad-nav.user.js from extension/content.js.
// Usage: node build-userscript.js   (npm run build)
//
// The build is stamped with a hash of content.js so you can tell which copy is
// running (console: "[webpad] build <hash>", the View on/off toast, the
// description, and a "// Build <hash>" comment after the metadata block, kept
// out of the block itself because @build isn't a userscript key). The
// @version gets a UTC timestamp suffix (0.3.0.202610121930) so userscript
// managers see every code change as an update; rebuilding unchanged code keeps
// the previous version, so the output (and git) stay unchanged.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const srcPath = path.join(__dirname, 'extension', 'content.js');
const outPath = path.join(__dirname, 'dist', 'gamepad-nav.user.js');
// Normalized to LF so the hash is the same on every checkout (git stores LF, Windows editors may write CRLF).
const src = fs.readFileSync(srcPath, 'utf8').replace(/\r\n/g, '\n');
const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, 'extension', 'manifest.json'), 'utf8'));

const hash = crypto.createHash('sha256').update(src).digest('hex').slice(0, 12);
const PLACEHOLDER = "const BUILD = 'dev';";
if (!src.includes(PLACEHOLDER)) throw new Error(`${PLACEHOLDER} not found in content.js`);
const body = src.replace(PLACEHOLDER, `const BUILD = '${hash}';`);

// Keep the previous version if the code hasn't changed.
let stamp = null;
if (fs.existsSync(outPath)) {
  const prev = fs.readFileSync(outPath, 'utf8');
  const prevHash = prev.match(/^\/\/ Build ([0-9a-f]+) =/m)?.[1];
  const prevVersion = prev.match(/^\/\/ @version\s+(\S+)/m)?.[1];
  if (prevHash === hash && prevVersion?.startsWith(version + '.')) stamp = prevVersion.slice(version.length + 1);
}
stamp ??= new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12); // UTC yyyymmddhhmm

const header = `// ==UserScript==
// @name         Gamepad Spatial Navigation
// @namespace    gamepad-spatial-nav
// @version      ${version}.${stamp}
// @description  Navigate web pages with a controller: D-pad / left stick move focus, A click, B back, X enter, Y graph view. (build ${hash})
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
// Generated from extension/content.js by build-userscript.js. Edit that file, not this one.
// Build ${hash} = first 12 hex digits of sha256(extension/content.js).
// LB/RB (switch tabs) needs the extension; in a userscript they do nothing.

`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, header + body);
console.log(`wrote ${path.relative(__dirname, outPath)}  version ${version}.${stamp}  build ${hash}`);
