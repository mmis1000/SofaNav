// Builds dist/gamepad-nav.user.js from extension/content.js.
// Usage: node build-userscript.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'extension', 'content.js'), 'utf8');
const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, 'extension', 'manifest.json'), 'utf8'));

const header = `// ==UserScript==
// @name         Gamepad Spatial Navigation
// @namespace    gamepad-spatial-nav
// @version      ${version}
// @description  Navigate web pages with a controller: D-pad / left stick move focus, A click, B back, Y graph view.
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
// Generated from extension/content.js by build-userscript.js. Edit that file, not this one.
// LB/RB (switch tabs) needs the extension; in a userscript they do nothing.

`;

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
const out = path.join(__dirname, 'dist', 'gamepad-nav.user.js');
fs.writeFileSync(out, header + src);
console.log('wrote', path.relative(__dirname, out));
