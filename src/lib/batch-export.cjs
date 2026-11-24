'use strict';
const zlib=require('node:zlib');
const {writeAtomicFile}=require('./session-file.cjs');
const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function zip(files){let offset=0;const bodies=[],entries=[];for(const [filename,text] of Object.entries(files)){
  const name=Buffer.from(filename),raw=Buffer.from(text),bytes=zlib.deflateRawSync(raw),crc=crc32(raw),local=Buffer.alloc(30),central=Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(8,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(bytes.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
  bodies.push(local,name,bytes);entries.push(central,name);offset+=local.length+name.length+bytes.length;
  }const directory=Buffer.concat(entries),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...bodies,directory,end]);}
function xml(text){return String(text??'').toWellFormed().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));}
function column(n){let value='';do{value=String.fromCharCode(65+n%26)+value;n=Math.floor(n/26)-1;}while(n>=0);return value;}
// Explicit inline strings prevent remote output from becoming Excel formulas.
// Excel's 32,767 UTF-16 unit cell limit is handled without silently truncating.
function chunks(text){if(!text)return [''];const rows=[];for(let i=0;i<text.length;){let end=Math.min(text.length,i+32000);if(end<text.length&&/[\ud800-\udbff]/.test(text[end-1]))end--;rows.push(text.slice(i,end));i=end;}return rows;}
function xlsx(rows){
  if (!rows.length || rows.length > 16384) throw new Error('Excel에 저장할 장비 열 수가 올바르지 않습니다.');
  // SmartNetwork MyWindow1.btn_clicked5: one Sheet1, endpoint headers in row 1,
  // then each device's complete received transcript vertically in its column.
  // Build only populated cells, never a longest-output × device-count matrix.
  const cells = new Map(), headers = [], hosts = new Map(); let lastRow = 1, count = 0;
  for (const row of rows) hosts.set(row.host, (hosts.get(row.host) || 0) + 1);
  const cell = (name, text) => `<c r="${name}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
  rows.forEach((device, index) => {
    const col = column(index), defaultPort = device.protocol === 'telnet' ? 23 : 22;
    const endpoint = device.port && Number(device.port) !== defaultPort ? `${device.host}:${device.port}` : device.host;
    const label = String(device.protocol || '').toUpperCase();
    const title = hosts.get(device.host) > 1 && label ? `${endpoint} [${label}]` : endpoint;
    headers.push(cell(`${col}1`, title));
    let text = String(device.output || '');
    if (['error','cancelled'].includes(device.status)) text += `${text && !text.endsWith('\n') ? '\n' : ''}[${device.statusText}] ${device.message || ''}`;
    const lines = /([^\r\n]*)(\r\n|\r|\n|$)/g; let number = 2;
    for (const match of text.matchAll(lines)) {
      for (const part of chunks(match[1])) {
        if (number > 1048576) throw new Error('Excel의 행 제한을 초과했습니다. 장비를 나눠 저장하거나 TXT로 저장해 주세요.');
        if (part) {
          if (++count > 1000000) throw new Error('Excel 결과 셀이 너무 많습니다. 장비를 나눠 저장하거나 TXT로 저장해 주세요.');
          if (!cells.has(number)) cells.set(number, []);
          cells.get(number).push(cell(`${col}${number}`, part)); lastRow = Math.max(lastRow, number);
        }
        number++;
      }
      if (!match[2]) break;
    }
  });
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${column(rows.length-1)}${lastRow}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData><row r="1">${headers.join('')}</row>${[...cells].sort((a,b)=>a[0]-b[0]).map(([number,values])=>`<row r="${number}">${values.join('')}</row>`).join('')}</sheetData></worksheet>`;
  const ns='http://schemas.openxmlformats.org/package/2006/relationships';
  return zip({
    '[Content_Types].xml':`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels':`<Relationships xmlns="${ns}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':`<Relationships xmlns="${ns}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml':'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    'xl/worksheets/sheet1.xml':worksheet
  });
}
function txt(rows){return '\ufeff'+rows.map(row=>{const protocol=String(row.protocol||'').toUpperCase();return `===== ${row.group} | ${row.host}:${row.port}${protocol?' | '+protocol:''} =====\r\n상태: ${row.statusText} · 명령 ${row.commandIndex}/${row.commandCount}\r\n시작: ${row.startedAt||''}\r\n종료: ${row.finishedAt||''}\r\n${row.message??''}\r\n\r\n${String(row.output??'').replace(/\n/g,'\r\n')}\r\n`;}).join('\r\n');}
function encode(format,rows){
  if(!['txt','xlsx'].includes(format))throw new Error('TXT 또는 Excel 형식을 선택해 주세요.');
  if(!rows.length)throw new Error('저장할 결과가 없습니다.');
  return format==='xlsx'?xlsx(rows):Buffer.from(txt(rows));
}
function writeResult(filename,format,rows,{protectedFiles=[]}={}){
  const bytes=encode(format,rows);
  const target=writeAtomicFile(filename,bytes,protectedFiles);return {path:target,devices:rows.length,bytes:bytes.length};
}
module.exports={xlsx,txt,encode,writeResult,crc32};
