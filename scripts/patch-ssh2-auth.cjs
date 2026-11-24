'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'), file = 'node_modules/ssh2/lib/client.js', target = path.join(root, file);
const upstream = 'edd3484daa9d942bc5a6412edc9cf11f85df40b2db10b07877bbfe694beac7f4';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const marker = '        USERAUTH_FAILURE: (p, authMethods, partialSuccess) => {';
const replacement = marker + `
          // SessionDock: RFC 4252 partial success completes this factor.
          // Advance to the advertised next factor instead of exhausting agent
          // identities or signature algorithms for an already accepted key.
          if (partialSuccess === true) {
            curPartial = true;
            curAuthsLeft = authMethods;
            tryNextAuth();
            return;
          }`;
if (require(path.join(root, 'node_modules/ssh2/package.json')).version !== '1.17.0') throw new Error('Review SSH authentication patch for changed ssh2');
const windowPatch = require('./patch-ssh2-window.cjs');
const text = windowPatch.stripClient(fs.readFileSync(target, 'utf8')), bytes = Buffer.from(text);
if (hash(bytes) === upstream) {
  if (text.split(marker).length !== 2) throw new Error('SSH authentication patch anchor differs');
  fs.writeFileSync(target, text.replace(marker, replacement));
} else if (text.split(replacement).length !== 2 || hash(text.replace(replacement, marker)) !== upstream) {
  throw new Error('SSH client differs from reviewed upstream/authentication patch');
}
windowPatch.apply();
const manifest = { dependency: 'ssh2', version: '1.17.0', file, upstreamSha256: upstream, patchedSha256: hash(fs.readFileSync(target)),
  reason: 'Advance explicit partial authentication success to the next factor before agent/key retry. Ordinary rejection, signature verification and host trust are unchanged.',
  reference: 'https://www.rfc-editor.org/rfc/rfc4252.html#section-5.1' };
fs.writeFileSync(path.join(root, 'assets/ssh2-auth-patch.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ ssh2: manifest.version, partialAuthenticationPatch: true, sha256: manifest.patchedSha256 }));
