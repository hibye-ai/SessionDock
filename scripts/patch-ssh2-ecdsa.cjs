'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),file='node_modules/ssh2/lib/protocol/utils.js',target=path.join(root,file);
const upstream='402b39e75ede9e3dc99af5e8af008602546f35aa1472bd4232c06f606987f053';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
// Only canonicalize the same positive integer value before DER verification.
// Do not use PR #1473 verbatim: its current diff changes outbound signatures.
const marker=`      case 'ecdsa-sha2-nistp521': {
        utilBufferParser.init(sig, 0);
        const r = utilBufferParser.readString();
        const s = utilBufferParser.readString();
        utilBufferParser.clear();
        if (r === undefined || s === undefined)
          return;

        const asnWriter = new Ber.Writer();
        asnWriter.startSequence();
        asnWriter.writeBuffer(r, Ber.Integer);
        asnWriter.writeBuffer(s, Ber.Integer);`;
const replacement=marker.replace('r === undefined || s === undefined','r === undefined || s === undefined || r.length === 0 || s.length === 0')
  .replace('        const asnWriter = new Ber.Writer();',`        // SessionDock: tolerate redundant positive mpint padding (Huawei).
        // Keep the integer value/sign and verify the signature normally.
        const minimalInteger = value => {
          let start = 0;
          while (start + 1 < value.length && value[start] === 0
                 && !(value[start + 1] & 0x80)) ++start;
          return value.subarray(start);
        };
        const asnWriter = new Ber.Writer();`)
  .replace('writeBuffer(r, Ber.Integer)','writeBuffer(minimalInteger(r), Ber.Integer)')
  .replace('writeBuffer(s, Ber.Integer)','writeBuffer(minimalInteger(s), Ber.Integer)');
if(require(path.join(root,'node_modules/ssh2/package.json')).version!=='1.17.0')throw new Error('Review the ECDSA compatibility patch before changing ssh2 version.');
let bytes=fs.readFileSync(target),source=bytes.toString('utf8');
if(hash(bytes)===upstream){if(source.split(marker).length!==2)throw new Error('ECDSA patch anchor differs');fs.writeFileSync(target,source.replace(marker,replacement));}
else if(!source.includes(replacement)||hash(source.replace(replacement,marker))!==upstream)throw new Error('SSH ECDSA library differs from the reviewed upstream/patch.');
const manifest={dependency:'ssh2',version:'1.17.0',file,upstreamSha256:upstream,patchedSha256:hash(fs.readFileSync(target)),reason:'Canonicalize redundant leading zero octets in inbound positive ECDSA r/s mpints before normal cryptographic verification; preserve sign, value, algorithm order and host-key checks.',reference:'https://github.com/mscdex/ssh2/issues/1472'};
fs.writeFileSync(path.join(root,'assets/ssh2-ecdsa-patch.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({ssh2:manifest.version,ecdsaPaddingPatch:true,sha256:manifest.patchedSha256}));
