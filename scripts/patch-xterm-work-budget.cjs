'use strict';
// xterm 6.0.0: saturating geometry operations and lossless cooperative REP.
// Input/output hashes pin the reviewed vendor source. No input sanitization.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const repBody=`
    if (!text.length) return true;
    // One fixed UTF-32 scratch buffer, irrespective of CSI Ps or cluster length.
    const data = new Uint32Array(1024);
    let offset = 0, remaining = count, first = true;
    const step = () => {
      if (this._store.isDisposed) return true;
      const available = 1024 - (this._sessiondockRepWork || 0);
      if (available === 0) return false;
      let used = 0;
      while (used < available && remaining > 0) {
        const cp = text.codePointAt(offset) || 0;
        data[used++] = cp;
        offset += cp > 65535 ? 2 : 1;
        if (offset >= text.length) { offset = 0; remaining--; }
      }
      this._sessiondockRepWork = (this._sessiondockRepWork || 0) + used;
      // Preserve print's wide-cell boundary cleanup across all chunks, including
      // clusters split across a chunk. The parser owns ordering until resolution.
      this.print(data, 0, used, first, remaining === 0);
      first = false;
      return remaining === 0;
    };
    if (step()) return true;
    return new Promise(resolve => {
      const next = () => {
        this._sessiondockRepWork = 0;
        if (step()) resolve(true); else setTimeout(next, 0);
      };
      setTimeout(next, 0);
    });
`;
function replaceOnce(text,before,after){if(text.split(before).length!==2)throw Error('xterm patch anchor mismatch: '+before.slice(0,70));return text.replace(before,after);}
function transform(text,kind){
 if(kind==='types')return replaceOnce(text,'repeatPrecedingCharacter(params: IParams): boolean;','repeatPrecedingCharacter(params: IParams): boolean | Promise<boolean>;');
 const ts=kind==='ts';
 for(const method of ['cursorForwardTab','cursorBackwardTab','insertLines','deleteLines','scrollUp','scrollDown']){
  const rx=ts?new RegExp('  public '+method+'\\(params: IParams\\): boolean \\{[\\s\\S]*?\\n  \\}'):new RegExp(method+'\\(\\w+\\)\\{.*?(?=\\}[a-zA-Z_]+\\()');
  const match=text.match(rx);if(!match)throw Error('Missing '+method);
  const geometry=method.includes('Tab')?'this._bufferService.cols':`this._activeBuffer.scrollBottom - this._activeBuffer.${method.endsWith('Lines')?'y':'scrollTop'} + 1`;
  const body=match[0].replace(ts?'params.params[0] || 1':/\w+\.params\[0\]\|\|1/,m=>`Math.min(${m}, ${geometry})`);
  text=replaceOnce(text,match[0],body);
 }
 if(ts){
  text=replaceOnce(text,'  public repeatPrecedingCharacter(params: IParams): boolean {','  public repeatPrecedingCharacter(params: IParams): boolean | Promise<boolean> {');
  const start=text.indexOf('    const data = new Uint32Array(text.length * length);'),end=text.indexOf('\n  }',start);if(start<0||end<0)throw Error('REP TS anchor');
  text=text.slice(0,start)+'    return this._sessiondockRepeat(text, length);'+text.slice(end);
  text=replaceOnce(text,'  public print(data: Uint32Array, start: number, end: number): void {','  private _sessiondockRepWork = 0;\n  private _sessiondockRepeat(text: string, count: number): boolean | Promise<boolean> {'+repBody.replace('new Promise(resolve =>','new Promise<boolean>(resolve =>')+'\n  }\n\n  public print(data: Uint32Array, start: number, end: number, first = true, last = true): void {');
  text=replaceOnce(text,'if (this._activeBuffer.x && end - start > 0 && bufferRow.getWidth(this._activeBuffer.x - 1) === 2)', 'if (first && this._activeBuffer.x && end - start > 0 && bufferRow.getWidth(this._activeBuffer.x - 1) === 2)');
  text=replaceOnce(text,'if (this._activeBuffer.x < cols && end - start > 0 && bufferRow.getWidth(this._activeBuffer.x) === 0', 'if (last && this._activeBuffer.x < cols && end - start > 0 && bufferRow.getWidth(this._activeBuffer.x) === 0');
 }else{
  const method=text.match(/repeatPrecedingCharacter\(\w+\)\{.*?(?=\}[a-zA-Z_]+\()/)[0];
  const count=method.match(/(?:const|let) (\w+)=\w+\.params\[0\]\|\|1/)[1];
  const txt=method.match(/,(\w+)=this\._activeBuffer\.lines\.get\(.*?\)\.getString\(\w+\),\w+=new Uint32Array/)[1];
  const cut=method.search(/,\w+=new Uint32Array/);
  if(cut<0)throw Error('REP runtime anchor');
  text=replaceOnce(text,method,method.slice(0,cut)+`;return this._sessiondockRepeat(${txt},${count})`);
  const print=text.match(/print\((\w+),(\w+),(\w+)\)\{.*?(?=\}registerCsiHandler\()/)[0];
  let body=print.replace(/^print\((\w+),(\w+),(\w+)\)\{/,'print($1,$2,$3,sdFirst=true,sdLast=true){');
  // CJS/ESM optimize the two boundary guards to && expressions.
  body=replaceOnce(body,'this._activeBuffer.x&&','sdFirst&&this._activeBuffer.x&&');
  const endGuard=body.match(/this\._activeBuffer\.x<\w+&&[^;]*?\.getWidth\(this\._activeBuffer\.x\)/);
  if(!endGuard)throw Error('print tail guard');
  body=replaceOnce(body,endGuard[0],'sdLast&&'+endGuard[0]);
  text=replaceOnce(text,print,'_sessiondockRepeat(text,count){'+repBody+'}'+body);
 }
 return text;
}
function applyPatch(root=path.resolve(__dirname,'..')){
 const base=path.join(root,'node_modules/@xterm/xterm');
 if(JSON.parse(fs.readFileSync(path.join(base,'package.json'),'utf8')).version!=='6.0.0')throw Error('Review work budget patch for new xterm version');
 const specs=require('../assets/xterm-work-budget-patch.json').files;
 const plan=specs.map(s=>{const file=path.join(root,s.file),bytes=fs.readFileSync(file),sha=hash(bytes);if(sha===s.patchedSha256)return {file,bytes,changed:false};if(sha!==s.upstreamSha256)throw Error('Unknown xterm work budget input: '+s.file);const out=Buffer.from(transform(bytes.toString('utf8'),s.file.endsWith('/Types.ts')?'types':s.file.endsWith('.ts')?'ts':'js'));if(hash(out)!==s.patchedSha256)throw Error('xterm work budget output mismatch');return {file,bytes:out,changed:true};});
 for(const p of plan)if(p.changed)fs.writeFileSync(p.file,p.bytes);
 return {version:'6.0.0',files:specs,changed:plan.filter(p=>p.changed).length};
}
if(require.main===module)console.log(JSON.stringify(applyPatch()));
module.exports={applyPatch,transform};
