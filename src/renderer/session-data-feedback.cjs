'use strict';
// Only product-authored, data-free errors are safe to show or retain in diagnostics.
// Arbitrary filesystem/remote errors can contain paths, CSV contents or credentials.
const parserSuffix=' 폴더 열 수를 수동으로 선택해 확인하세요.';
const parserMessages=new Set(['CSV는 UTF-8 20 MiB 이하만 지원합니다.','최대 10,000행입니다.','열이 너무 많습니다.','CSV 따옴표 형식이 올바르지 않습니다.','CSV 따옴표가 닫히지 않았습니다.','중복 헤더가 모호합니다.','알 수 없거나 중복된 헤더입니다.','헤더 또는 마지막 이름·주소·프로토콜·포트를 인식할 수 없습니다.','폴더 열 수는 자동 또는 0~16입니다.']);
const ipcMessages=new Set(['창이 변경되었습니다. 다시 시도하세요.','예시 CSV를 저장하지 못했습니다. 다른 파일 이름과 쓰기 권한을 확인하세요.','CSV를 읽지 못했습니다. UTF-8 파일과 읽기 권한을 확인하세요.','가져올 세션이 없습니다.','미리보기를 다시 생성하세요.','목록 또는 창이 변경되었습니다. 미리보기를 다시 확인하세요.']);
function errorFeedback(error){
 const raw=String(error?.message||'');
 const message=raw.replace(/^Error invoking remote method 'sessions:(?:csv-preview|csv-apply|sample-csv)': (?:Error: )?/,'');
 const core=message.endsWith(parserSuffix)?message.slice(0,-parserSuffix.length):'';
 const safe=ipcMessages.has(message)||parserMessages.has(core)||/^\d{1,5}행: (?:주소|이름|프로토콜 또는 포트|폴더|ID)(?:가|이) 올바르지 않습니다\.$/.test(core)||/^\d{1,5}행: 설정 밖 열에 데이터가 있습니다\.$/.test(core);
 return {state:'error',message:safe?message:'CSV 작업을 완료하지 못했습니다. 파일 형식과 접근 권한을 확인한 뒤 다시 시도하세요.',diagnostic:safe?raw:'CSV 작업 오류: 세부 내용은 민감한 정보 보호를 위해 생략했습니다.'};
}
function setFeedback(node,message,state='info'){
 node.dataset.state=state;node.setAttribute('role',state==='error'?'alert':'status');node.textContent=message;
}
module.exports={errorFeedback,setFeedback};
