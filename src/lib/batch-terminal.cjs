'use strict';
// Only the bounded current terminal line is needed for prompt detection. Keep
// control-sequence state across packets; transcript cleanup is a separate job.
class TerminalTail {
  constructor(){
    this.cells=[];this.ages=[];this.column=0;this.state='text';this.control='';this.version=0;
    this.previousLine='';this.previousMin=0;
    // Prompt provenance. `ages[i]` is the generation in which the character at
    // column i was last written, so `contentStamp()` reports the *oldest*
    // character still visible in the line. A prompt counts as freshly received
    // only when every visible character was written after the command mark:
    // appending trailing spaces to an already visible prompt, or overwriting a
    // single cell with `\rR`, can never promote a stale prompt.
    this.stamp=0;this.lineStamp=0;this.previousStamp=0;
  }
  get line(){return this.cells.join('').trimEnd();}
  get activeLine(){const cur=this.line.trim();return cur||this.previousLine;}
  get promptStamp(){return this.contentStamp();}
  // True only when the whole visible prompt was written after `mark`.
  freshSince(mark){return Number.isFinite(mark)&&mark>=0&&this.contentStamp()>mark;}
  contentStamp(){
    const text=this.line;
    if(!text)return this.previousMin;
    // `write()` stores one cell per *code point* (`for (const char of text)`), so
    // the age column must be advanced per code point too. Indexing by UTF-16
    // code unit double-counts a surrogate pair (`<𠀀>` is 4 units but 3 cells)
    // and pushed every age of a supplementary-plane prompt into the `??0`
    // fallback, which made the line look permanently stale.
    let oldest=Infinity,index=0;
    for(const _char of text){const age=this.ages[index++]??0;if(age<oldest)oldest=age;}
    return oldest===Infinity?0:oldest;
  }
  closeLine(){
    const text=this.cells.join('').trimEnd();
    if(text){const oldest=this.contentStamp();this.previousLine=text;this.previousStamp=this.lineStamp;this.previousMin=oldest;}
    this.cells=[];this.ages=[];this.column=0;
  }
  write(text){for(const char of text){
    if(this.state==='osc'){if(char==='\x07')this.state='text';else if(char==='\x1b')this.state='osc-escape';continue;}
    if(this.state==='osc-escape'){this.state=char==='\\'?'text':'osc';continue;}
    if(this.state==='escape'){if(char==='['){this.state='csi';this.control='';}else if(char===']')this.state='osc';else if('()*+'.includes(char))this.state='charset';else this.state='text';continue;}
    if(this.state==='charset'){this.state='text';continue;}
    if(this.state==='csi'){if(char>='@'&&char<='~'){this.apply(char);this.state='text';}else if(this.control.length<64)this.control+=char;else this.state='text';continue;}
    if(char==='\x1b'){this.state='escape';continue;}
    if(char==='\r'){this.column=0;continue;}
    if(char==='\n'){this.closeLine();this.version++;this.lineStamp=++this.stamp;continue;}
    if(char==='\b'){this.column=Math.max(0,this.column-1);continue;}
    if(char==='\t'){this.column=Math.min(1023,Math.ceil((this.column+1)/8)*8);continue;}
    if(char<' '||char==='\x7f')continue;
    while(this.cells.length<this.column){this.cells.push(' ');this.ages.push(this.stamp);}
    this.cells[this.column]=char;this.ages[this.column]=++this.stamp;this.column++;this.version++;this.lineStamp=this.stamp;
    if(this.column>=1024){this.cells=this.cells.slice(-512);this.ages=this.ages.slice(-512);this.column=this.cells.length;}
  }}
  apply(final){const value=Number(this.control.split(';')[0])||0;
    if(final==='K'){
      if(value===2){this.cells=[];this.ages=[];}
      else if(value===1){for(let i=0;i<=this.column;i++){this.cells[i]=' ';this.ages[i]=this.stamp;}}
      else{this.cells.length=Math.min(this.cells.length,this.column);this.ages.length=this.cells.length;}
    }
    else if(final==='G')this.column=Math.max(0,Math.min(1023,(value||1)-1));
    else if(final==='C')this.column=Math.min(1023,this.column+(value||1));
    else if(final==='D')this.column=Math.max(0,Math.min(1023,this.column-(value||1)));
    else if(final==='H'||final==='f'){this.closeLine();this.lineStamp=++this.stamp;}
  }
}
// Characters allowed inside a vendor hostname, including non-Latin names such
// as [서울스위치] or <부산-코어>. Shared by every bracket/angle prompt check.
const HOST_BODY=/^[\p{L}\p{N}_.:/@() -]+$/u;
// Kinds whose learned identity names the device; those must stay stable.
const IDENTITY_KINDS=new Set(['network','bracket','sros','shell','shell-bracket']);
// One device prints several prompt identities, but only in documented ways:
//   * a Cisco stack member appends a numeric member suffix (`Switch-1`,
//     `Switch-1/2`), and
//   * a Huawei/H3C sub-view appends an *interface* or VTY view name
//     (`[Host-GigabitEthernet0/0/1]`, `[Host-ui-vty0-4]`).
// Anything else is another device. A bare `startsWith(identity+'-')` test also
// accepted a sibling such as `Router-backup`, which let a stranger's prompt
// finish the running command (H-01).
const STACK_MEMBER=/^[-/]\d{1,3}(?:[-/]\d{1,3})*$/;
// Every alternative is anchored *and* spelled completely: a view name is the
// whole suffix, and an interface view must carry a real number. A prefix test
// (`console`, `GE\d*`) accepted `Router-console-backup` and `Router-GEvil` as
// the same device, so a stranger's delayed body was skipped as if the command
// had already finished (V4 H-01). `$` plus the mandatory number is what makes
// `-con0` a view and `-console-backup` a different host.
const VIEW_SUFFIX=new RegExp('^(?:'
  // Huawei/H3C VTY and console views: -ui-vty0-4, -vty0, -console, -aux0.
  +'-ui-vty\\d+(?:-\\d+)?'
  +'|-vty\\d*'
  +'|-console\\d*'
  +'|-aux\\d*'
  +'|-con\\d+'
  +'|-tty\\d*'
  +'|-pts\\/\\d+'
  // Physical/logical interface views. The trailing number is mandatory and may
  // be a slot path (0/0/1) with an optional sub-interface (.10).
  +'|-(?:GigabitEthernet|FastEthernet|TenGigabitEthernet|FortyGigabitEthernet|HundredGigabitEthernet'
  +'|TwentyFiveGigE|TwoGigabitEthernet|FiveGigabitEthernet|M-GigabitEthernet|XGigabitEthernet'
  +'|Ethernet|MEth|MgmtEth|GE|XGE|Eth)\\d+(?:\\/\\d+)*(?:\\.\\d+)?'
  +'|-(?:Eth-Trunk|Port-channel|Bridge-Aggregation|Route-Aggregation)\\d+(?:\\/\\d+)*'
  +'|-(?:LoopBack|Loopback|Vlanif|Vlan|Tunnel|Serial|Dialer|BVI|Virtual-Template|Null|NULL|mgmt|Management)\\d*'
  +')$','i');
// `seen` may be `known` itself, a stack member of it, or one of its views.
function sameView(known,seen){
  known=String(known??'');seen=String(seen??'');
  if(!known||!seen)return false;
  if(known===seen)return true;
  if(!seen.startsWith(known))return false;
  const suffix=seen.slice(known.length);
  return STACK_MEMBER.test(suffix)||VIEW_SUFFIX.test(suffix);
}
function candidate(line){
  line=line.trim();if(!line||line.length>240)return null;
  // An authentication challenge is not a prompt, even though its shape parses
  // as one: `Password>`/`Username>`/`Passcode>`/`User>` all satisfy the Cisco
  // network rule below. Learning one as the session identity made the runner
  // send the command list into the login dialogue (V3-H-07).
  if(credentialPrompt(line))return null;
  // Second, independent guard for the account half of the dialogue. A device
  // that answers a rejected account by re-printing the challenge on the same
  // physical line (`User>User>`, `login: User>`, ANSI-coloured `User>`) can end
  // in a shape the anchored classifier misses, and *any* of those forms parses
  // as a network prompt named `User`. The account words are reserved here, so
  // no `User`/`Username`/`Login` token can ever be learned as a device.
  if(/^[~*]?(?:user|user\s*name|username|login)(?:\s*[:>].*)?$/i.test(line.replace(/^[~*]/,'')))return null;
  let match;
  // SR OS classic CLI keeps the CPM/device identity as context and the unsaved
  // marker change, e.g. A:router# -> *A:router>config>system#.
  if((match=/^\*?([A-D]:[A-Za-z0-9_.-]+)(?:>[A-Za-z0-9_.:/-]+)*[#$]$/.exec(line)))return {kind:'sros',identity:match[1],line};
  // Huawei VRP/H3C hostnames (<Huawei>, <SW-01>, <~Huawei>, <*Huawei>, etc.)
  if((match=/^<([~*]?[^<>\r\n]+)>$/.exec(line))){
    const id=match[1].trim().replace(/^[~*]/,'');
    if(id)return {kind:'network',identity:id,line};
  }
  if((match=/^\[([~*]?[^\[\]\r\n]+)\]$/.exec(line))){
    const raw=match[1].trim(),body=raw.replace(/^[~*]/,'');
    if(body&&!/^(?:OK|FAILED|INFO|SUCCESS|WARNING|ERROR)$/i.test(body))return {kind:'bracket',identity:body,line};
  }
  if((match=/^([^\s@]+@[^\s:]+)(?::[^\r\n]{0,160})?[#>$%]$/.exec(line)))return {kind:'shell',identity:match[1],line};
  if((match=/^\[([^\s@]+@[^\s:]+) [^\r\n]{0,160}\][#$]$/.exec(line)))return {kind:'shell-bracket',identity:match[1],line};
  if(/^PS [^\r\n]{0,200}>$/.test(line))return {kind:'powershell',identity:'PS ',line};
  // Cisco prints `*` in front of a prompt whose configuration is unsaved; it is
  // still the same device, so the marker must not hide the prompt identity.
  if((match=/^\*?([\p{L}\p{N}_.:@/-]+)(?:\([^\r\n()]{0,100}\))?[#>$]$/u.exec(line)))return {kind:'network',identity:match[1],line};
  if(/^[#>$%]$/.test(line))return {kind:'single',identity:line,line};
  return null;
}
class PromptMatcher {
  constructor(){this.learned=null;}
  initial(line,explicit=''){line=line.trim();
    // A challenge is never an identity, not even under an explicit phrase: the
    // literal fallback below would otherwise accept `User>` because the operator
    // typed a completion prompt (V3-H-07).
    if(credentialPrompt(line))return false;
    if(explicit){const expected=explicit.trim();if(line!==expected&&!(/^[#>$%]$/.test(expected)&&line.endsWith(expected)))return false;}
    const found=candidate(line);if(!found&&!explicit)return false;this.learned=found||{kind:'literal',identity:line,line};return true;}
  // SmartNetwork decides "ready" from a settled stream, not from a prompt
  // string. When a settled line carries no recognizable prompt, remember it
  // verbatim so the session still has an identity, and tell the caller that
  // completion must fall back to output stabilization (quiet completion).
  settle(line){
    line=String(line??'').trim().slice(0,240);
    if(credentialPrompt(line))return true;
    const found=candidate(line);
    this.learned=found||{kind:'literal',identity:line||'prompt',line:line||'prompt'};
    return !found;
  }
  // Does `line` still belong to the device learned at login? An explicit
  // completion prompt may change the spelling, but never the host name.
  sameHost(line){
    const learned=this.learned;if(!learned)return false;
    if(!IDENTITY_KINDS.has(learned.kind))return true;
    const found=candidate(line);
    return !!found&&found.identity===learned.identity;
  }
  // Field reality: one device presents several prompt identities in one session.
  // A Cisco stack member reports `Switch-1#` where login learned `Switch>`, and
  // Huawei sub-views report `[Host-ui-vty0-4]` for `<Host>`. Only those exact
  // shapes are accepted, so an unrelated `OtherDevice#` and a sibling such as
  // `Router-backup` are still rejected.
  sameDevice(line){
    if(this.sameHost(line))return true;
    const learned=this.learned,found=candidate(line);
    if(!learned||!found)return false;
    if(!IDENTITY_KINDS.has(learned.kind)||!IDENTITY_KINDS.has(found.kind))return false;
    return sameView(String(learned.identity??'').toLowerCase(),String(found.identity??'').toLowerCase());
  }
  matches(line,explicit=''){
    line=line.trim();if(!this.learned)return false;
    const expected=explicit.trim(),{kind,identity}=this.learned;
    // A literal prompt is an extra spelling requirement, never a way to accept
    // a different device: Cisco enable still has to prove same-host identity.
    if(expected.length>1)return line===expected&&this.sameHost(line);
    if(expected&&!line.endsWith(expected))return false;
    if(kind==='literal'||kind==='single')return line===identity;
    if((kind==='network'||kind==='bracket')&&line.startsWith('[')&&line.endsWith(']')){
      const body=line.slice(1,-1).replace(/^[~*]/,'').trim();
      return HOST_BODY.test(body)&&sameView(String(identity).toLowerCase(),body.toLowerCase());
    }
    // A session that starts inside a Huawei/H3C sub-view ([Host-ui-vty0-4])
    // later returns to the parent prompt (<Host>), so allow that direction too.
    if((kind==='network'||kind==='bracket')&&line.startsWith('<')&&line.endsWith('>')){
      const body=line.slice(1,-1).replace(/^[~*]/,'').trim();
      if(!body||!HOST_BODY.test(body))return false;
      return body===identity||(kind==='bracket'&&sameView(body.toLowerCase(),String(identity).toLowerCase()));
    }
    const found=candidate(line);
    if(!found)return false;
    if(kind==='powershell')return found.kind==='powershell';
    if(kind==='sros')return found.kind==='sros'&&found.identity===identity;
    if(kind.startsWith('shell'))return found.identity===identity&&found.kind.startsWith('shell');
    // Huawei/H3C system-view and interface-view brackets share the initial
    // device identity. Never learn a new identity from arbitrary command output.
    return found.kind==='network'&&found.identity===identity;
  }
}
function hasResponse(text,command,prompt){const lines=text.split(/\r\n|\r|\n/).map(line=>line.trim()).filter(Boolean);return lines.some(line=>line!==command&&!(prompt&&line.startsWith(prompt)&&line.slice(prompt.length).trim()===command));}
function denied(text){return /(?:^|\n)\s*(?:%\s*)?(?:access denied|authentication failed|authorization failed|permission denied|invalid password|bad secrets?)(?:[\s.:!]|$)/i.test(text);}
function commandError(text){return /(?:^|\n)\s*%\s*(?:invalid input|unknown command|incomplete command|ambiguous command|error:)/i.test(text);}
// Huawei VRP/Versatile Routing Platform and H3C Comware banners commonly wait
// for a key press before they print the <Huawei> prompt. Accept the many ways
// that hint is spelled (Press ENTER, Hit any key, Press [Enter], Press <Enter>,
// Press the Return key, [Enter]) so the batch runner answers it promptly.
const ENTER_HINT=/(?:press|hit)\s+(?:the\s+)?['"<\[(]?\s*(?:any\s+key|enter|return)\s*['">\])]?/i;
function needsEnter(line){
  if(!line)return false;
  return ENTER_HINT.test(line)||/\[\s*(?:enter|return)\s*\]/i.test(line)||/\b(?:enter|return)\s+key\b/i.test(line);
}
// Vendor pagers: Cisco `--More--`, Huawei/H3C `---- More ----`, Juniper
// `<--- More --->` and the "Press any key" family. Output that merely mentions
// "More" must not match, so each form is anchored to the end of the line.
function pager(line){return /(?:-{2,}\s*More\s*-{2,}|<-{2,}\s*More\s*-{2,}>|Press (?:any key|SPACE))\s*$/i.test(line);}
// An ANSI sequence carries no text, so it must not hide a challenge: a device
// that colours its prompts prints `\x1b[0mPassword: `. Stripping first keeps the
// "preceding character is not a letter" rule honest instead of teaching it to
// treat `m` as a boundary.
const ANSI_ESCAPES=/\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][\w]|\x1b./g;
function plainLine(line){return String(line??'').replace(ANSI_ESCAPES,'');}
// A bare CR wake-up must never be pressed into a credential prompt, where it
// would submit an empty password/username. The keyword only needs a *non-word*
// character in front of it, so a device that prints the challenge on the same
// physical line as the previous text (`continue...Username: `,
// `Password>Password>`) is still classified as a challenge, while a longer word
// (`myusername:`) is not.
// `user` is a first-class keyword: Telnet/SSH appliances ask `User>` or `User:`
// and the old list only had `user ?name`, so `User>` parsed as the network
// prompt of a device called `User`, the session was declared ready and the
// command list was typed into the login dialogue (V3-H-07).
const CREDENTIAL_WORD='(?:login|username|user(?:\\s*name)?|password|passwd|passcode|passphrase)';
const CREDENTIAL_PROMPT=new RegExp(`(?:^|[^\\p{L}\\p{N}_-])(${CREDENTIAL_WORD})\\s*[:>]\\s*$`,'iu');
function credentialPrompt(line){return CREDENTIAL_PROMPT.test(plainLine(line));}
// Which half of the dialogue a challenge asks for. One classifier serves both
// the *send* path (answer the account/password once) and the *readiness* path
// (never learn a challenge as a prompt), so the two can no longer disagree.
function credentialKind(line){
  const word=CREDENTIAL_PROMPT.exec(plainLine(line));
  if(!word)return null;
  return /^(?:login|user(?:name)?|user\s*name)$/i.test(word[1])?'username':'password';
}
function lastNonEmptyLine(text){
  if(!text)return '';
  const lines=text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  for(let i=lines.length-1;i>=0;i--){
    const trimmed=lines[i].replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b[()][\w]/g,'').replace(/\x1b./g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').trim();
    if(trimmed)return trimmed;
  }
  return '';
}
module.exports={TerminalTail,PromptMatcher,candidate,hasResponse,denied,commandError,needsEnter,pager,credentialPrompt,credentialKind,lastNonEmptyLine,sameView,HOST_BODY};
