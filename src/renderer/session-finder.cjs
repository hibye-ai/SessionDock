'use strict';
const labelKey=value=>value.normalize('NFKC').toLowerCase().replace(/[_\-\s]+/gu,' ').trim();
class SessionFinder {
  constructor(sessions) {
    this.records = sessions.map(session => {
      const protocol=session.protocol==='telnet'?'telnet':'ssh',host=session.host.toLowerCase(),name=session.name.toLowerCase();
      const authority=`${host.includes(':')?`[${host}]`:host}:${session.port||(protocol==='ssh'?22:23)}`;
      const user=session.username?`${session.username.toLowerCase()}@`:'';
      return {session,protocol,name,host,label:labelKey(name),exact:new Set([name,host,authority,`${user}${host}`,`${user}${authority}`,`${protocol}://${user}${authority}`]),text:`${name} ${host} ${session.folder||''} ${(session.tags||[]).join(' ')}`.toLowerCase(),normalized:labelKey(`${name} ${session.folder||''} ${(session.tags||[]).join(' ')}`)};
    });
  }
  search(value,limit=12,protocol=null) {
    const query=value.trim().toLowerCase();if(!query)return {items:[],total:0,exactIds:[]};
    const normalized=labelKey(query),words=normalized.split(' ').filter(Boolean);if(!normalized)return {items:[],total:0,exactIds:[]};
    const matches=[],exactIds=[];
    // Keep stable ordering on equal keys: insert after existing equal entries.
    // Other slice() limits retain the original full-sort semantics.
    const bounded=Number.isSafeInteger(limit)&&limit>=0&&limit<=128;
    const compare=(a,b)=>a.rank-b.rank||SessionFinder.collator.compare(a.session.name,b.session.name)||a.session.id.localeCompare(b.session.id);
    let total=0;
    for(const record of this.records){
      if(protocol&&record.protocol!==protocol)continue;
      const rawExact=record.exact.has(query),labelExact=record.label===normalized,exact=rawExact||labelExact;
      const tokenMatch=words.every(word=>record.normalized.includes(word));
      if(!exact&&!record.text.includes(query)&&!tokenMatch)continue;
      if(exact)exactIds.push(record.session.id);
      const rank=record.name===query?0:rawExact?1:labelExact?2:record.name.startsWith(query)?3:record.label.startsWith(normalized)?4:record.host.startsWith(query)?5:record.name.includes(query)?6:record.label.includes(normalized)?7:words.every(word=>record.label.includes(word))?8:9;
      total++;
      const item={session:record.session,rank};
      if(!bounded) matches.push(item);
      else if(limit && (matches.length<limit||compare(item,matches[matches.length-1])<0)) {
        let lo=0,hi=matches.length;
        while(lo<hi){const mid=(lo+hi)>>>1;if(compare(item,matches[mid])<0)hi=mid;else lo=mid+1;}
        matches.splice(lo,0,item);if(matches.length>limit)matches.pop();
      }
    }
    if(!bounded) matches.sort(compare);
    return {items:matches.slice(0,limit).map(item=>item.session),total,exactIds};
  }
}
SessionFinder.collator=new Intl.Collator('ko');
module.exports={SessionFinder};
