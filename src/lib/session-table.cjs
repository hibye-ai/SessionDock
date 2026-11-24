'use strict';
const {isIP}=require('node:net');
const schema=require('../../assets/session-table-schema.json');
const MAX_BYTES=20*1024*1024;
const fail=message=>{throw new Error(`${message} 폴더 열 수를 수동으로 선택해 확인하세요.`);};
function sampleCsv(){return Buffer.from('\ufeff'+[schema.headers,...schema.sampleRows].map(row=>row.map(v=>`"${v.replaceAll('"','""')}"`).join(',')).join('\r\n')+'\r\n','utf8');}
function csvRows(input){
 const text=Buffer.isBuffer(input)?new TextDecoder('utf-8',{fatal:true}).decode(input):input;
 if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BYTES)fail('CSV는 UTF-8 20 MiB 이하만 지원합니다.');
 const rows=[];let row=[],cell='',quoted=false,closed=false,started=false;
 const field=()=>{row.push(cell.trim());cell='';closed=false;started=false;};
 const record=()=>{field();rows.push(row);row=[];if(rows.length>10001)fail('최대 10,000행입니다.');};
 const data=text.replace(/^\ufeff/,'');
 for(let i=0;i<data.length;i++){
  const c=data[i];
  if(quoted){if(c==='"'){if(data[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
  if(c===','){field();if(row.length>22)fail('열이 너무 많습니다.');}
  else if(c==='\r'||c==='\n'){if(c==='\r'&&data[i+1]==='\n')i++;record();}
  else if(c==='"'&&!started&&!closed){quoted=true;started=true;}
  else {if(closed||c==='"')fail('CSV 따옴표 형식이 올바르지 않습니다.');cell+=c;started=true;}
 }
 if(quoted)fail('CSV 따옴표가 닫히지 않았습니다.');
 if(cell||row.length||closed)record();return rows;
}
function validate(item,n){
 const clean=(s,max)=>typeof s==='string'&&s.length<=max&&!/[\x00-\x1f\x7f]/.test(s);
 let host=item.host;if(host.startsWith('[')&&host.endsWith(']'))host=host.slice(1,-1);
 if(!clean(host,253)||!host||(!isIP(host)&&(/^[\d.]+$/.test(host)||!host.replace(/\.$/,'').split('.').every(p=>/^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/.test(p)))))fail(`${n}행: 주소가 올바르지 않습니다.`);
 if(!clean(item.name,256)||!item.name)fail(`${n}행: 이름이 올바르지 않습니다.`);
 const protocol=(item.protocol||'ssh').toLowerCase(),port=item.port||(protocol==='telnet'?'23':'22');
 if(!['ssh','telnet'].includes(protocol)||!/^\d{1,5}$/.test(port)||Number(port)<1||Number(port)>65535)fail(`${n}행: 프로토콜 또는 포트가 올바르지 않습니다.`);
 const folder=item.folder.replaceAll('\\','/').replace(/\/+/g,'/').replace(/^\/|\/$/g,'');
 if(!clean(folder,1024)||folder.split('/').some(p=>p==='.'||p==='..'))fail(`${n}행: 폴더가 올바르지 않습니다.`);
 if(item.id&&(!/^[A-Za-z0-9_-]{1,128}$/.test(item.id)||['__proto__','constructor','prototype'].includes(item.id)))fail(`${n}행: ID가 올바르지 않습니다.`);
 return {...(item.id?{id:item.id}:{}),name:item.name,host,protocol,port:Number(port),folder};
}
function parseCsv(input,{folderCount='auto',header=true,hasId=false}={}){
 const rows=csvRows(input).map((v,i)=>({v,n:i+1})).filter(r=>r.v.some(Boolean));
 if(folderCount==='auto')for(const r of rows)while(r.v.length&&!r.v.at(-1))r.v.pop();
 if(!rows.length)return {sessions:[],warnings:[],mapping:'빈 CSV'};
 let mapping={},folders=[],start=0,description,used;
 if(folderCount==='auto'){
  const unknown=[];
  rows[0].v.forEach((v,i)=>{const k=v.toLowerCase().replace(/[\s_-]+/g,'');let f=Object.keys(schema.aliases).find(f=>schema.aliases[f].includes(k));if(/^(folder|폴더)[1-9][0-9]*$/.test(k))f='folder';
   if(f==='folder')folders.push(i);else if(f){if(Object.hasOwn(mapping,f))fail('중복 헤더가 모호합니다.');mapping[f]=i;}else if(v)unknown.push(i);});
  if(['name','host','protocol','port'].every(k=>Object.hasOwn(mapping,k))){
   if(unknown.length||folders.length>16||new Set(folders.map(i=>rows[0].v[i].toLowerCase())).size!==folders.length)fail('알 수 없거나 중복된 헤더입니다.');
   start=1;description='자동: 헤더 인식';
  }else{
   const width=rows[0].v.length;
   if(width<4||width>20||rows.some(r=>r.v.length!==width||!['ssh','telnet'].includes(r.v[width-2].toLowerCase())||!/^\d{1,5}$/.test(r.v[width-1])))fail('헤더 또는 마지막 이름·주소·프로토콜·포트를 인식할 수 없습니다.');
   folders=Array.from({length:width-4},(_,i)=>i);mapping=Object.fromEntries(['name','host','protocol','port'].map((k,i)=>[k,width-4+i]));description=`자동: 앞 ${folders.length}개 폴더 열 · 마지막 이름/주소/프로토콜/포트`;
  }
 }else{
  if(!Number.isInteger(folderCount)||folderCount<0||folderCount>16)fail('폴더 열 수는 자동 또는 0~16입니다.');
  const offset=hasId?1:0;folders=Array.from({length:folderCount},(_,i)=>offset+i);mapping=Object.fromEntries(['name','host','protocol','port'].map((k,i)=>[k,offset+folderCount+i]));if(hasId)mapping.id=0;
  start=header?1:0;description=`수동: 폴더 ${folderCount}열`;
 }
 used=new Set([...Object.values(mapping),...folders]);
 const sessions=rows.slice(start).map(({v,n})=>{if(v.some((s,i)=>s&&!used.has(i)))fail(`${n}행: 설정 밖 열에 데이터가 있습니다.`);const item=Object.fromEntries(Object.entries(mapping).map(([k,i])=>[k,v[i]||'']));item.folder=folders.map(i=>v[i]||'').filter(Boolean).join('/');return validate(item,n);});
 return {sessions,warnings:[],mapping:description};
}
module.exports={sampleCsv,parseCsv};
