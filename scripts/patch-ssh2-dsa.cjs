'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),file='node_modules/ssh2/lib/protocol/keyParser.js',target=path.join(root,file),upstream='ba4f40a5a9edef15ff49a38226e2be2e66f75aa2673840dd18b807bb7943eca9';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
if(require(path.join(root,'node_modules/ssh2/package.json')).version!=='1.17.0')throw new Error('Review DSA patch for changed ssh2');
const marker='return ex;';
const replacement=`// SessionDock: native Electron crypto omits legacy DSA verification.
          // Verify the complete public-key signature; never accept on error.
          if (this.type === 'ssh-dss' && algo === 'sha1'
              && (ex.code === 'ERR_OSSL_EVP_UNSUPPORTED_ALGORITHM'
                  || ex.code === 'ERR_OSSL_UNSUPPORTED'))
            return require('../../../../src/lib/dsa-host-key.cjs')
              .verifyDsaHostSignature(this[SYM_PUB_SSH], data, signature);
          return ex;`;
const bytes=fs.readFileSync(target),text=bytes.toString('utf8'),start=text.indexOf('  verify: (() => {'),end=text.indexOf('  isPrivateKey:',start);
if(start<0||end<0)throw new Error('DSA patch verification boundary differs');let section=text.slice(start,end),original;
if(hash(bytes)===upstream){if(section.split(marker).length!==3)throw new Error('DSA patch anchor differs');original=section;section=section.replaceAll(marker,replacement);}
else{if(section.split(replacement).length!==3)throw new Error('Unknown DSA patch');original=section.replaceAll(replacement,marker);if(hash(text.slice(0,start)+original+text.slice(end))!==upstream)throw new Error('SSH key parser differs from reviewed upstream');}
if(hash(bytes)===upstream)fs.writeFileSync(target,text.slice(0,start)+section+text.slice(end));
const manifest={dependency:'ssh2',version:'1.17.0',file,upstreamSha256:upstream,patchedSha256:hash(fs.readFileSync(target)),helper:'src/lib/dsa-host-key.cjs',helperSha256:hash(fs.readFileSync(path.join(root,'src/lib/dsa-host-key.cjs'))),reason:'Verify legacy DSS host signatures when native crypto lacks DSA; strict parameters and signature bounds; existing host trust remains mandatory.',reference:'https://www.rfc-editor.org/rfc/rfc4253.html#section-6.6'};
if(require(path.join(root,'node_modules/ssh2/package.json')).version!==manifest.version)throw new Error('Review DSA patch for changed ssh2');
fs.writeFileSync(path.join(root,'assets/ssh2-dsa-patch.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({ssh2:manifest.version,dsaVerificationPatch:true,sha256:manifest.patchedSha256}));
