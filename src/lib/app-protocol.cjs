'use strict';
const fs = require('node:fs');
const path = require('node:path');
const APP_SCHEME = 'sessiondock';
const APP_URL = 'sessiondock://app/src/renderer/index.html';
const resources = new Map([
  ['/src/renderer/index.html', 'text/html; charset=utf-8'],
  ['/src/renderer/bundle.js', 'text/javascript; charset=utf-8'],
  ['/src/renderer/desktop.css', 'text/css; charset=utf-8'],
  ['/src/renderer/font-picker.css', 'text/css; charset=utf-8'],
  ['/src/renderer/operations.css', 'text/css; charset=utf-8'],
  ['/src/renderer/advanced-terminal.css', 'text/css; charset=utf-8'],
  ['/src/renderer/batch.css', 'text/css; charset=utf-8'],
  ['/node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8']
]);

// A fixed resource table, not a general filesystem server. Node's ASAR-aware
// read also works with file-protocol privileges disabled in the shipped app.
function createAppProtocol(root, readFile = fs.promises.readFile) {
  return async request => {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, {status:405});
    let url;
    try { url = new URL(request.url); } catch { return new Response(null, {status:400}); }
    const contentType = resources.get(url.pathname);
    if (url.protocol !== APP_SCHEME + ':' || url.hostname !== 'app' || url.port || url.username || url.password || url.search || !contentType) return new Response(null, {status:404});
    try {
      const bytes = await readFile(path.join(root, ...url.pathname.slice(1).split('/')));
      return new Response(request.method === 'HEAD' ? null : bytes, {headers:{
        'Content-Type': contentType, 'X-Content-Type-Options':'nosniff', 'Cache-Control':'no-store'
      }});
    } catch { return new Response(null, {status:404}); }
  };
}
module.exports = { APP_SCHEME, APP_URL, createAppProtocol };
