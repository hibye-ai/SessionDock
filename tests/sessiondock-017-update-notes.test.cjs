'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createUpdateNotice}=require('../src/lib/update-service.cjs');
test('0.1.8 release metadata contains the exact two approved notice lines',()=>{
 const pkg=require('../package.json');
 assert.equal(pkg.version,'0.1.8');
 assert.equal(pkg.sessionDockReleaseNotes,'공식 웹 업데이트와 공유 세션 게시를 추가했습니다.\n장비 비밀번호는 저장하지 않고 연결할 때마다 입력합니다.');
});
test('notice exposes optional candidate-bound plain summary and rejects malformed values without blocking',()=>{
 let candidate={name:'SessionDock.zip',version:'0.1.8',buildID:'sha256-1',notes:'연결 흐름을 개선했습니다.\n오류 안내를 보완했습니다.'};
 const service=createUpdateNotice({getSettings:()=>({updateDirectory:'C:/updates',updateFromLocalFolder:true,updateSnoozeUntil:0}),saveSettings:()=>{},getStatus:()=>({folder:'C:/updates',candidate}),getGeneration:()=>7});
 assert.equal(service.publish(candidate,'C:/updates',7),true);assert.equal(service.peek().notes,candidate.notes);
 candidate={...candidate,notes:'<img src=x onerror=alert(1)>'};service.publish(candidate,'C:/updates',7);assert.equal(service.peek().notes,candidate.notes);
 for(const notes of [null,42,'','a\nb\nc','a'.repeat(401),'x\u0000y','\ud800']){candidate={...candidate,notes};assert.equal(service.publish(candidate,'C:/updates',7),true);assert.ok(!service.peek().notes);}
});
