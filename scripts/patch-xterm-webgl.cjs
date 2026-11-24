'use strict';
// Core ownership fix authored by 9router/deepseek-v4.1-flash-free;
// Codex reviewed and packaged the same change for pinned CJS/ESM/TS inputs.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const specs=[
  {
    "file": "lib/addon-webgl.js",
    "before": "_cursorBlinkStateManager=new m.MutableDisposable",
    "after": "_cursorBlinkStateManager=this._register(new m.MutableDisposable)",
    "upstreamSha256": "b85f8d4b3e9756bebb757e3fe47134d70f03ea3d6b187624426d2e2b65dec06c",
    "patchedSha256": "311a2455801b8815ad4e283e74bbc84f25e9291e7042f5f6825e41cc02fde898"
  },
  {
    "file": "lib/addon-webgl.mjs",
    "before": "_cursorBlinkStateManager=new be;",
    "after": "_cursorBlinkStateManager=this._register(new be);",
    "upstreamSha256": "5ac2cbbb8a861ba99176eda0ee91f10c08de32d091e3488edf699ad111131ebb",
    "patchedSha256": "162e142831fd4f68ce15eff1222d0f333bc4e569eb09699123b2e3a0a32fa471"
  },
  {
    "file": "src/WebglRenderer.ts",
    "before": "_cursorBlinkStateManager: MutableDisposable<CursorBlinkStateManager> = new MutableDisposable();",
    "after": "_cursorBlinkStateManager: MutableDisposable<CursorBlinkStateManager> = this._register(new MutableDisposable());",
    "upstreamSha256": "6539558711f60c82c25388aab042f7677e013487b5106c50d51aef5dfc9f2e9c",
    "patchedSha256": "6346fbfbb7cfcfa61d614d598b126ee79d7a38c40cced5f8883e8fa43c71422d"
  }
];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function applyPatch(root=path.resolve(__dirname,'..')){
 const directory=path.join(root,'node_modules/@xterm/addon-webgl');
 if(JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8')).version!=='0.19.0')throw Error('Review cursor ownership patch before changing addon-webgl version');
 // Validate every input before writing any file. Unknown sources fail closed.
 const plan=specs.map(spec=>{
  const file=path.join(directory,spec.file),bytes=fs.readFileSync(file),digest=hash(bytes),text=bytes.toString('utf8');
  if(digest===spec.patchedSha256)return{file,bytes,changed:false};
  if(digest!==spec.upstreamSha256||text.split(spec.before).length!==2)throw Error('addon-webgl cursor patch input differs: '+spec.file);
  const patched=Buffer.from(text.replace(spec.before,spec.after));
  if(hash(patched)!==spec.patchedSha256)throw Error('addon-webgl cursor patch output differs');
  return{file,bytes:patched,changed:true};
 });
 for(const item of plan)if(item.changed)fs.writeFileSync(item.file,item.bytes);
 const manifest={dependency:'@xterm/addon-webgl',version:'0.19.0',coreDiffAuthor:'9router/deepseek-v4.1-flash-free',reviewAndIntegration:'Codex',reason:'Register the cursor MutableDisposable with renderer lifetime so interval, timeout and animation-frame callbacks are disposed with their renderer.',files:specs.map(({file,upstreamSha256,patchedSha256})=>({file:'node_modules/@xterm/addon-webgl/'+file,upstreamSha256,patchedSha256}))};
 fs.mkdirSync(path.join(root,'assets'),{recursive:true});fs.writeFileSync(path.join(root,'assets/xterm-webgl-cursor-patch.json'),JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(require.main===module)console.log(JSON.stringify({cursorOwnershipPatch:true,...applyPatch()}));
module.exports={applyPatch,specs};
