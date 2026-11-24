'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),target=path.join(root,'node_modules/ssh2/lib/protocol/kex.js');
const upstream='054ba4b81801596350f0e2e939746d2966297cffd4303b342c25b2fd5d295755';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const prime='ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece65381ffffffffffffffff';
const marker='        this._dh = createDiffieHellmanGroup(this.groupName);';
const replacement=[
  '        // SessionDock: RFC 4253 section 8.1, exact group1 (MODP group 2).',
  '        // Electron may omit the named group while supporting explicit DH.',
  '        // This path is reached only if SSH negotiated that same group.',
  '        try { this._dh = createDiffieHellmanGroup(this.groupName); }',
  '        catch (error) {',
  "          if (this.groupName !== 'modp2' || error.code !== 'ERR_CRYPTO_UNKNOWN_DH_GROUP') throw error;",
  `          this._dh = createDiffieHellman(Buffer.from('${prime}', 'hex'), 2);`,
  '        }',
].join('\n');
if(require(path.join(root,'node_modules/ssh2/package.json')).version!=='1.17.0')throw new Error('Review the SSH compatibility patch before changing ssh2 version.');
let bytes=fs.readFileSync(target),text=bytes.toString('utf8');
if(hash(bytes)===upstream){if(text.split(marker).length!==2)throw new Error('SSH patch anchor differs');text=text.replace(marker,replacement);fs.writeFileSync(target,text);}
else{if(!text.includes(replacement)||hash(text.replace(replacement,marker))!==upstream)throw new Error('SSH library differs from the reviewed upstream/patch.');}
const manifest={dependency:'ssh2',version:'1.17.0',file:'node_modules/ssh2/lib/protocol/kex.js',upstreamSha256:upstream,patchedSha256:hash(fs.readFileSync(target)),reason:'Electron named MODP group 2 fallback to the identical RFC 4253 8.1 explicit prime and generator; no global algorithm changes.',reference:'https://www.rfc-editor.org/rfc/rfc4253.html#section-8.1'};
fs.writeFileSync(path.join(root,'assets/ssh2-legacy-patch.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({ssh2:manifest.version,legacyDhPatch:true,sha256:manifest.patchedSha256}));
require('./patch-ssh2-ecdsa.cjs');
require('./patch-ssh2-dsa.cjs');
require('./patch-ssh2-auth.cjs');

