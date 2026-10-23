import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

delete process.env.PORTAL_POSTGRES_URL;
delete process.env.PORTAL_TEST_POSTGRES;
delete process.env.RENDER;
process.env.NODE_ENV='test';
const directory=mkdtempSync(join(tmpdir(),'master7-bank-deposits-http-'));
process.env.PORTAL_DATABASE=join(directory,'portal.sqlite');
process.env.PUBLIC_ORIGIN='https://portal.example.test';

const {sql,withStorage}=await import('./runtime.mjs');
const {newSession}=await import('./security.mjs');
const {server}=await import('./server.mjs');

await withStorage(async()=>{
 const now=new Date().toISOString();
 await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run('owner','owner','owner@example.test','synthetic-hash','owner',1,'synthetic-recovery',now);
 await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run('member','member','member@example.test','synthetic-hash','customer',1,'synthetic-recovery',now);
 await sql.prepare('INSERT INTO members(email,tenant_id,created_at) VALUES (?,?,?)').run('member@example.test','main',now);
});
const ownerCookie='portal_session='+await withStorage(()=>newSession('owner'));
const memberCookie='portal_session='+await withStorage(()=>newSession('member'));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const call=(path,options={})=>fetch(base+path,{redirect:'manual',...options});
const jsonHeaders=(cookie,extra={})=>({Cookie:cookie,Origin:process.env.PUBLIC_ORIGIN,'Content-Type':'application/json','X-Portal-Request':'1',...extra});

try{
 for(const path of ['/api/v1/bank-transfer/config','/api/v1/bank-deposits','/api/v1/finance-staff','/api/v1/finance-metrics','/api/v1/bank-deposits/missing/receipt']){
  assert.equal((await call(path)).status,401,path+' must reject anonymous reads');
 }
 assert.equal((await call('/api/v1/bank-transfer/config',{method:'DELETE',headers:{Cookie:ownerCookie}})).status,405);
 assert.equal((await call('/api/v1/bank-deposits/missing/review',{method:'GET',headers:{Cookie:ownerCookie}})).status,405);
 assert.equal((await call('/api/v1/bank-deposits/missing/receipt',{method:'POST',headers:{Cookie:memberCookie}})).status,405);

 const configuration={bankName:'Maybank',accountHolder:'MASTER7 SDN BHD',accountNumber:'1234 5678 90',enabled:true};
 assert.equal((await call('/api/v1/bank-transfer/config',{method:'POST',headers:jsonHeaders(ownerCookie,{Origin:'https://attacker.example.test'}),body:JSON.stringify(configuration)})).status,403);
 assert.equal((await call('/api/v1/bank-transfer/config',{method:'POST',headers:jsonHeaders(ownerCookie,{'X-Portal-Request':''}),body:JSON.stringify(configuration)})).status,415);
 assert.equal((await call('/api/v1/bank-transfer/config',{method:'POST',headers:{Cookie:ownerCookie,Origin:process.env.PUBLIC_ORIGIN,'Content-Type':'text/plain','X-Portal-Request':'1'},body:JSON.stringify(configuration)})).status,415);
 const excessiveJson=JSON.stringify({...configuration,padding:'x'.repeat(17000)});
 assert.equal((await call('/api/v1/bank-transfer/config',{method:'POST',headers:jsonHeaders(ownerCookie),body:excessiveJson})).status,413,'ordinary JSON must retain the 16 KiB cap');

 const configured=await call('/api/v1/bank-transfer/config',{method:'POST',headers:jsonHeaders(ownerCookie),body:JSON.stringify(configuration)});
 assert.equal(configured.status,200);
 assert.equal((await configured.json()).bankAccount.accountNumber,configuration.accountNumber);
 const visible=await (await call('/api/v1/bank-transfer/config',{headers:{Cookie:memberCookie}})).json();
 assert.equal(visible.bankAccount.bankName,configuration.bankName);

 const submission={requestKey:'bank_http_request_0001',amount:'12.34',currency:'MYR',payerName:'SYNTHETIC MEMBER',transferReference:'HTTPREF001',transferredAt:new Date().toISOString(),bankConfigUpdatedAt:visible.bankAccount.updatedAt};
 const created=await call('/api/v1/bank-deposits',{method:'POST',headers:jsonHeaders(memberCookie),body:JSON.stringify(submission)});
 assert.equal(created.status,201);
 const deposit=(await created.json()).deposit;
 assert.equal(deposit.amountMinor,1234);

 const receiptPath='/api/v1/bank-deposits/'+deposit.id+'/receipt';
 assert.equal((await call(receiptPath,{method:'PUT',headers:{Cookie:memberCookie,Origin:process.env.PUBLIC_ORIGIN,'Content-Type':'image/png'}})).status,415);
 assert.equal((await call(receiptPath,{method:'PUT',headers:{Cookie:memberCookie,Origin:'https://attacker.example.test','Content-Type':'image/png','X-Portal-Request':'1'}})).status,403);
 assert.equal((await call(receiptPath,{method:'PUT',headers:{Cookie:memberCookie,Origin:process.env.PUBLIC_ORIGIN,'Content-Type':'text/plain','X-Portal-Request':'1'},body:'not an image'})).status,415);
 const oversized=Buffer.alloc(2*1024*1024+1,0x41);
 assert.equal((await call(receiptPath,{method:'PUT',headers:{Cookie:memberCookie,Origin:process.env.PUBLIC_ORIGIN,'Content-Type':'image/png','X-Portal-Request':'1'},body:oversized})).status,413,'receipt uploads must use the independent 2 MiB cap');

 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
 const uploaded=await call(receiptPath,{method:'PUT',headers:{Cookie:memberCookie,Origin:process.env.PUBLIC_ORIGIN,'Content-Type':'image/png','X-Portal-Request':'1'},body:png});
 assert.equal(uploaded.status,200);
 assert.equal((await uploaded.json()).receipt.size,png.length);
 const receipt=await call(receiptPath,{headers:{Cookie:memberCookie}});
 assert.equal(receipt.status,200);
 assert.equal(receipt.headers.get('content-type'),'image/png');
 assert.equal(receipt.headers.get('content-disposition'),'inline; filename="bank-receipt.png"');
 assert.equal(receipt.headers.get('cache-control'),'private, no-store');
 assert.equal(receipt.headers.get('cross-origin-resource-policy'),'same-origin');
 assert.equal(receipt.headers.get('x-content-type-options'),'nosniff');
 assert.deepEqual(Buffer.from(await receipt.arrayBuffer()),png);

 console.log('PASS: real local HTTP bank-deposit routes enforce authentication, methods, same-origin JSON CSRF controls, the normal 16 KiB cap, the separate 2 MiB receipt cap, and private receipt response headers. Synthetic data only.');
}finally{
 await new Promise(resolve=>server.close(resolve));
 await sql.close();
 rmSync(directory,{recursive:true,force:true});
}
