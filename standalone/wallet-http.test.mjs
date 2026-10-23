import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
delete process.env.PORTAL_POSTGRES_URL;delete process.env.PORTAL_TEST_POSTGRES;delete process.env.RENDER;
process.env.NODE_ENV='test';const dir=mkdtempSync(join(tmpdir(),'master7-wallet-http-'));
process.env.PORTAL_DATABASE=join(dir,'wallet.sqlite');process.env.PUBLIC_ORIGIN='http://127.0.0.1:8080';
Object.assign(process.env,{PORTAL_VPAY_SETTLEMENT_ENABLED:'true',PORTAL_VPAY_TRADER_ID:'123456',PORTAL_VPAY_ENVIRONMENT:'uat',PORTAL_VPAY_CALLBACK_TOKEN:'synthetic-callback-token-at-least-32-bytes',PORTAL_VPAY_QUERY_TOKEN:'synthetic-query-token-at-least-32-bytes'});
const nativeFetch=globalThis.fetch;let expected,queryCalls=0;
globalThis.fetch=(input,options)=>{
 const url=String(input);
 if(url==='https://master7-integration-gateway.onrender.com/providers/vpay/status')return Promise.resolve(Response.json({provider:'vpay',mode:'uat',configured:true}));
 if(url==='https://master7-integration-gateway.onrender.com/platform/vpay/order-query'){
  assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{outTradeNo:expected.id,tradeNo:expected.trade_no});queryCalls++;
  return Promise.resolve(Response.json({provider:'vpay',upstreamStatus:200,result:{code:0,data:{trader_id:'123456',out_trade_no:expected.id,trade_no:expected.trade_no,amount:'1.25',state:'3'}}}));
 }
 if(!url.startsWith('http://127.0.0.1:'))throw Error('Unexpected external network access in HTTP test');
 return nativeFetch(input,options);
};
const {sql,withStorage}=await import('./runtime.mjs');
const {newSession}=await import('./security.mjs');
const {createVPaySettlement}=await import('./wallet.mjs');
const {server}=await import('./server.mjs');
await withStorage(async()=>{
 await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run('alpha','Alpha',new Date().toISOString());
 for(const [id,role] of [['member','customer'],['owner','owner']])await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(id,id,id+'@example.test','synthetic-hash',role,1,'synthetic-recovery',new Date().toISOString());
 await sql.prepare('INSERT INTO members VALUES (?,?,?)').run('member@example.test','alpha',new Date().toISOString());
});
const core=createVPaySettlement();
const order=await core.reserveForMember({userId:'member',email:'member@example.test',role:'customer',tenantId:'alpha'},{amount:'1.25',currency:'MYR',requestKey:'synthetic_http_request'});
expected=await core.bindCreatedOrder(order.id,{code:0,data:{trader_id:'123456',out_trade_no:order.id,trade_no:'provider_http_order',amount:'1.25',pay_url:'https://payment.vpay.club/pay/synthetic',expired_time:'2026-10-23 23:59:59'}});
const memberCookie='portal_session='+await newSession('member'),ownerCookie='portal_session='+await newSession('owner');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const call=(path,options={})=>fetch(base+path,{redirect:'manual',...options});
const payload=JSON.stringify({trader_id:'123456',out_trade_no:order.id,trade_no:expected.trade_no,amount:'1.25',state:'3',sign:'synthetic-signature-verified-by-the-mocked-gateway'});
const callback=authorization=>call('/api/v1/payment-callbacks/vpay/payment',{method:'POST',headers:{'Content-Type':'application/json',...(authorization?{Authorization:authorization}:{})},body:payload});
try{
 assert.equal((await callback()).status,401);
 assert.equal((await callback('Bearer wrong-token')).status,401);
 const response=await callback('Bearer '+process.env.PORTAL_VPAY_CALLBACK_TOKEN);assert.equal(response.status,200);assert.equal(await response.text(),'SUCCESS');
 const wallet=await (await call('/api/v1/wallet?environment=uat',{headers:{Cookie:memberCookie}})).json();assert.equal(wallet.balanceMinor,'125');assert.equal(wallet.tenantId,'alpha');
 const records=await (await call('/api/v1/payment-records?tenant=alpha&environment=uat',{headers:{Cookie:ownerCookie}})).json();assert.equal(records.records[0].id,order.id);assert.equal(records.records[0].member,'member');assert.equal(records.records[0].creditedMinor,'125');
 assert.equal(await (await callback('Bearer '+process.env.PORTAL_VPAY_CALLBACK_TOKEN)).text(),'SUCCESS');assert.equal(queryCalls,1);
 assert.equal((await call('/api/v1/wallet?environment=production',{headers:{Cookie:memberCookie}})).status,200);
 assert.equal((await (await call('/api/v1/wallet?environment=production',{headers:{Cookie:memberCookie}})).json()).balanceMinor,'0');
 assert.equal((await call('/api/v1/wallet?tenant=main&environment=uat',{headers:{Cookie:memberCookie}})).status,403);
 assert.equal((await call('/api/v1/payment-records/export?tenant=alpha&environment=uat',{headers:{Cookie:memberCookie}})).status,403);
 const exported=await call('/api/v1/payment-records/export?tenant=alpha&environment=uat',{headers:{Cookie:ownerCookie}});assert.equal(exported.status,200);assert((await exported.text()).includes(order.id));
 assert.equal((await call('/api/v1/deposit-requests',{method:'POST',headers:{Cookie:memberCookie,'Content-Type':'application/json'},body:'{}'})).status,403);
 console.log('PASS: synthetic local HTTP callback → authenticated query mock → wallet credit → member balance → admin records → CSV; duplicate prevention, scope and CSRF verified. No supplier requests or real funds.');
}finally{await new Promise(resolve=>server.close(resolve));await sql.close();globalThis.fetch=nativeFetch;rmSync(dir,{recursive:true,force:true});}
