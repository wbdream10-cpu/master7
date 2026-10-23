import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// Isolated synthetic database only; no Render, Neon, gateway or supplier calls.
delete process.env.PORTAL_POSTGRES_URL;delete process.env.RENDER;process.env.NODE_ENV='test';
const postgres=process.argv.includes('--postgres'),dir=mkdtempSync(join(tmpdir(),'master7-wallet-'));
process.env.PORTAL_DATABASE=join(dir,'wallet.sqlite');
if(postgres){process.env.PORTAL_TEST_POSTGRES='1';process.env.PORTAL_TEST_POSTGRES_PATH=join(dir,'postgres');}else delete process.env.PORTAL_TEST_POSTGRES;
globalThis.fetch=()=>{throw Error('Unexpected network access in wallet test');};
const {sql,withStorage}=await import('./runtime.mjs');
const {createVPaySettlement,getPaymentRecords,getWallet}=await import('./wallet.mjs');
const {createVPayOrderVerifier}=await import('./vpay-gateway.mjs');
const at=new Date().toISOString();
await withStorage(async()=>{
 for(const id of ['alpha','beta'])await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run(id,id,at);
 for(const [id,username,tenant] of [['alice','alice','alpha'],['bob','bob','beta'],['charlie','=imported-member','alpha']]){
  await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(id,username,id+'@example.test','synthetic-password-hash','customer',1,'synthetic-recovery-hash',at);
  await sql.prepare('INSERT INTO members VALUES (?,?,?)').run(id+'@example.test',tenant,at);
 }
});
const alice={userId:'alice',email:'alice@example.test',role:'customer',tenantId:'alpha'},bob={userId:'bob',email:'bob@example.test',role:'customer',tenantId:'beta'};
const owner={userId:'owner',email:'owner@example.test',role:'owner'},boss={userId:'boss',email:'boss@example.test',role:'tenant_owner',tenantId:'alpha'},staff={userId:'staff',email:'staff@example.test',role:'employee',tenantId:'alpha'};
const callbackToken='synthetic-callback-key-never-used-in-production';
const env={PORTAL_VPAY_SETTLEMENT_ENABLED:'true',PORTAL_VPAY_TRADER_ID:'123456',PORTAL_VPAY_ENVIRONMENT:'uat',PORTAL_VPAY_CALLBACK_TOKEN:callbackToken};
let sequence=0;
const fields=(order,extra={})=>({trader_id:'123456',out_trade_no:order.id,trade_no:order.trade_no,amount:'12.34',state:'3',sign:'private-signature-must-never-be-stored',acc_no:'private-account-must-never-be-stored',...extra});
const query=(order,extra={})=>({code:0,data:fields(order,extra)});
const raw=(order,extra)=>Buffer.from(JSON.stringify(fields(order,extra)));
const auth='Bearer '+callbackToken;
const core=options=>createVPaySettlement({env,verifyOrder:async order=>query(order),...options});
async function orderFor(settlement=core(),user=alice,extra={}){
 const order=await settlement.reserveForMember(user,{amount:'12.34',currency:'MYR',requestKey:'synthetic_request_'+(++sequence),...extra});
 return settlement.bindCreatedOrder(order.id,{code:0,data:fields({...order,trade_no:'provider_'+sequence},{pay_url:'https://payment.vpay.club/pay/synthetic-order',expired_time:'2026-10-23 23:59:59'})});
}
const count=table=>withStorage(()=>sql.prepare('SELECT count(*) AS n FROM '+table).get()).then(r=>Number(r.n));
const find=id=>withStorage(()=>sql.prepare('SELECT * FROM portal_payment_orders WHERE id=?').get(id));
const records=(user,extra={})=>withStorage(()=>getPaymentRecords(user,new URLSearchParams({environment:'uat',...extra})));
const balance=user=>withStorage(()=>getWallet(user,user.tenantId,'uat')).then(r=>r.json());

test('callbacks are disabled by default and reject missing, wrong, oversized and malformed authentication',async()=>{
 assert.equal((await createVPaySettlement({env:{}}).receive(Buffer.from('{}'),auth)).status,503);
 const s=core();
 for(const token of [undefined,'Bearer wrong','',auth+' ','Bearer '+callbackToken.repeat(50)])assert.equal((await s.receive(Buffer.from('{}'),token)).status,401);
 assert.equal((await s.receive(Buffer.from('not-json'),auth)).status,400);
 assert.equal((await s.receive(Buffer.alloc(16385),auth)).status,400);
 assert.equal((await s.receive(Buffer.from('[]'),auth)).status,400);
 assert.equal((await s.receive(Buffer.from(JSON.stringify({trader_id:'123456',out_trade_no:'unknown'})),auth)).status,409);
 assert.equal(await count('portal_wallet_journal'),0);
});

test('orders use database member identity and an immutable idempotency binding',async()=>{
 const s=core(),requestKey='same_synthetic_request_key';
 const a=await s.reserveForMember(alice,{amount:'12.34',currency:'MYR',requestKey});
 const b=await s.reserveForMember(alice,{amount:'12.34',currency:'MYR',requestKey});
 assert.equal(a.id,b.id);assert.equal(a.tenant_id,'alpha');assert.equal(a.user_id,'alice');
 await assert.rejects(s.reserveForMember(alice,{amount:'12.35',currency:'MYR',requestKey}),/IDEMPOTENCY_CONFLICT/);
 await assert.rejects(s.reserveForMember({...alice,tenantId:'beta'},{amount:'12.34',currency:'MYR',requestKey:'forged_tenant_request'}),/MEMBER_UNAVAILABLE/);
 await assert.rejects(s.reserveForMember(owner,{amount:'12.34',currency:'MYR',requestKey:'owner_deposit_request'}),/MEMBER_UNAVAILABLE/);
 assert.equal(a.trade_no,null);assert.equal(a.settlement_status,'created');
 assert.equal((await s.receive(raw({...a,trade_no:'early'}),auth)).status,503);
});

test('a confirmed payment atomically creates one balanced credit, order record and audit entry',async()=>{
 const s=core(),order=await orderFor(s),before=await count('portal_wallet_journal');
 const result=await s.receive(raw(order),auth);assert.equal(result.status,200);assert.equal(await result.text(),'SUCCESS');
 assert.equal(await count('portal_wallet_journal'),before+1);
 const current=await find(order.id);assert.equal(current.settlement_status,'credited');assert.equal(current.verified_at,current.credited_at);
 const journal=await sql.prepare('SELECT * FROM portal_wallet_journal WHERE order_id=?').get(order.id);
 assert.equal(Number(journal.member_minor),1234);assert.equal(Number(journal.clearing_minor),-1234);assert.equal(journal.tenant_id,'alpha');
 const audit=await sql.prepare('SELECT * FROM audit WHERE action=?').get('VPay 充值核验并入账：'+order.id);assert.equal(audit.actor,'system:vpay');
 const statement=await (await records(boss)).json();const row=statement.records.find(r=>r.id===order.id);
 assert.equal(row.member,'alice');assert.equal(row.providerOrderId,order.trade_no);assert.equal(row.amountMinor,'1234');assert.equal(row.creditedMinor,'1234');assert.equal(row.status,'credited');
});

test('concurrent and later duplicate notifications credit exactly once',async()=>{
 let calls=0;const s=core({verifyOrder:async order=>{calls++;return query(order);}}),order=await orderFor(s),before=await count('portal_wallet_journal');
 const results=await Promise.all(Array.from({length:12},()=>s.receive(raw(order),auth)));
 assert(results.every(r=>r.status===200));assert.equal(await count('portal_wallet_journal'),before+1);
 const queried=calls;assert.equal(await (await s.receive(raw(order),auth)).text(),'SUCCESS');assert.equal(calls,queried);
});

test('wrong merchant, order, provider reference, currency or amount never credits and leaves a review record when bound',async()=>{
 for(const extra of [{amount:'12.35'},{trade_no:'other_provider_order'},{currency:'USD'}]){
  const s=core(),order=await orderFor(s),before=await count('portal_wallet_journal');
  assert.equal((await s.receive(raw(order,extra),auth)).status,409);assert.equal(await count('portal_wallet_journal'),before);
  assert.equal((await find(order.id)).review_required,1);
  const details=await (await records(boss)).json(),review=details.records.find(r=>r.id===order.id).reviews[0];
  if(extra.amount)assert.equal(review.observedMinor,'1235');
  assert.equal((await s.receive(raw(order),auth)).status,503);
 }
 const s=core(),order=await orderFor(s);
 assert.equal((await s.receive(raw(order,{trader_id:'999999'}),auth)).status,400);
 assert.equal((await s.receive(raw(order,{out_trade_no:'unknown_order'}),auth)).status,409);
});

test('a paid browser claim, callback alone, pending query, failed query and mismatched authenticated query do not credit',async()=>{
 for(const verifyOrder of [async()=>{throw Error('offline');},async order=>query(order,{state:'2'}),async order=>query(order,{amount:'12.35'}),async order=>({...query(order),code:9}),async order=>query(order,{trade_no:'different'})]){
  const s=core({verifyOrder}),order=await orderFor(s),before=await count('portal_wallet_journal');
  assert.equal((await s.receive(raw(order),auth)).status,503);assert.equal(await count('portal_wallet_journal'),before);
 }
});

test('transaction failure after journal insertion rolls back the wallet, order and audit together',async()=>{
 const s=core(),order=await orderFor(s),before=await count('portal_wallet_journal'),prepare=sql.prepare;
 try{
  sql.prepare=function(source){if(source.startsWith('INSERT INTO audit'))throw Error('synthetic audit failure');return prepare(source);};
  assert.equal((await s.receive(raw(order),auth)).status,503);
 }finally{sql.prepare=prepare;}
 assert.equal(await count('portal_wallet_journal'),before);const current=await find(order.id);assert.equal(current.settlement_status,'pending');assert.equal(current.credited_at,null);
 const failed=await (await records(boss)).json(),failure=failed.records.find(r=>r.id===order.id);assert.equal(failure.reviewRequired,false);assert(failure.reviews.some(r=>r.reason==='VPAY_SETTLEMENT_RETRY'));
 assert.equal((await s.receive(raw(order),auth)).status,200);assert.equal(await count('portal_wallet_journal'),before+1);
});

test('a member moved to another tenant is held for review instead of crediting the wrong wallet',async()=>{
 const s=core(),order=await orderFor(s,bob),before=await count('portal_wallet_journal');
 await sql.prepare('UPDATE members SET tenant_id=? WHERE email=?').run('alpha',bob.email);
 try{assert.equal((await s.receive(raw(order),auth)).status,503);assert.equal(await count('portal_wallet_journal'),before);assert.equal((await find(order.id)).review_required,1);}
 finally{await sql.prepare('UPDATE members SET tenant_id=? WHERE email=?').run('beta',bob.email);}
});

test('staff assignments block new VPay orders and hold pre-promotion orders without credit',async()=>{
 const s=core(),charlie={userId:'charlie',email:'charlie@example.test',role:'customer',tenantId:'alpha'};
 await sql.prepare('INSERT INTO portal_staff VALUES (?,?,?)').run(charlie.userId,'alpha','employee');
 try{
  await assert.rejects(s.reserveForMember(charlie,{amount:'12.34',currency:'MYR',requestKey:'staff_reserve_request_01'}),/MEMBER_UNAVAILABLE/);
 }finally{await sql.prepare('DELETE FROM portal_staff WHERE user_id=?').run(charlie.userId);}

 const order=await orderFor(s,alice),before=await count('portal_wallet_journal');
 await sql.prepare('INSERT INTO portal_staff VALUES (?,?,?)').run(alice.userId,'alpha','employee');
 try{
  assert.equal((await s.receive(raw(order),auth)).status,503);
  assert.equal(await count('portal_wallet_journal'),before);
  assert.equal((await find(order.id)).review_required,1);
  const review=await sql.prepare('SELECT reason FROM portal_payment_reviews WHERE order_id=?').get(order.id);assert.equal(review.reason,'VPAY_MEMBERSHIP_CHANGED');
 }finally{await sql.prepare('DELETE FROM portal_staff WHERE user_id=?').run(alice.userId);}
});

test('a reversal after credit is visible for review and never silently deletes or debits history',async()=>{
 const s=core(),order=await orderFor(s);assert.equal((await s.receive(raw(order),auth)).status,200);
 const before=(await balance(alice)).balanceMinor;
 assert.equal((await s.receive(raw(order,{state:'4'}),auth)).status,503);
 assert.equal((await balance(alice)).balanceMinor,before);assert.equal((await find(order.id)).review_required,1);
 const data=await (await records(boss)).json(),row=data.records.find(r=>r.id===order.id);assert.equal(row.status,'credited');assert.equal(row.reviewRequired,true);assert.equal(row.reviewCount,1);
});

test('wallet totals and financial records are separated by user, tenant and UAT/production environment',async()=>{
 assert.equal((await records(null)).status,401);assert.equal((await records(staff)).status,403);assert.equal((await records({...alice,role:'unknown'})).status,403);assert.equal((await records(boss,{tenant:'beta'})).status,403);assert.equal((await records(alice,{tenant:'beta'})).status,403);
 const beta=await (await records(owner,{tenant:'beta'})).json();assert(beta.records.every(r=>r.tenantId==='beta'));
 const own=await (await records(alice)).json();assert(own.records.every(r=>r.member==='alice'));
 const prod=await (await records(boss,{environment:'production'})).json();assert.equal(prod.records.length,0);assert.equal(prod.summary.creditedMinor,'0');
 const prodBalance=await withStorage(()=>getWallet(alice,'alpha','production'));assert.equal((await prodBalance.json()).balanceMinor,'0');
 assert.equal((await withStorage(()=>getWallet(boss,'beta','uat'))).status,403);
 for(const params of [{from:'2026-02-30'},{from:'2026-01-01',to:'2026-12-31'},{environment:'wrong'},{cursor:'bad!'}])assert.equal((await records(owner,params)).status,400);
});

test('CSV export is manager-only, complete for the selected period, safe for spreadsheets and audited',async()=>{
 const params=new URLSearchParams({tenant:'alpha',environment:'uat'});
 assert.equal((await withStorage(()=>getPaymentRecords(alice,params,{exportCSV:true}))).status,403);
 const s=core(),charlie={userId:'charlie',email:'charlie@example.test',role:'customer',tenantId:'alpha'},order=await orderFor(s,charlie);
 assert.equal((await s.receive(raw(order),auth)).status,200);
 const response=await withStorage(()=>getPaymentRecords(boss,params,{exportCSV:true}));assert.equal(response.status,200);assert(response.headers.get('content-type').startsWith('text/csv'));
 const csv=await response.text();assert(csv.includes(order.id));assert(csv.includes('"\'=imported-member"'));assert(!csv.includes('private-signature'));assert(!csv.includes('private-account'));
 const audits=await sql.prepare("SELECT count(*) AS n FROM audit WHERE action LIKE '导出充值核对记录%'").get();assert(Number(audits.n)>0);
});

test('record pagination has stable boundaries and period totals include every page',async()=>{
 await withStorage(async()=>{
  for(let i=0;i<105;i++)await sql.prepare("INSERT INTO portal_payment_orders(id,tenant_id,user_id,request_key,merchant_id,environment,amount_minor,currency,settlement_status,created_at,provider) VALUES (?,?,?,?,'123456','uat',100,'MYR','created',?,'vpay')").run('page_'+String(i).padStart(4,'0'),'beta','bob','page_key_'+i,at);
 });
 const first=await (await records(owner,{tenant:'beta'})).json();assert.equal(first.records.length,100);assert(first.nextCursor);
 const second=await (await records(owner,{tenant:'beta',cursor:first.nextCursor})).json();assert.equal(first.summary.orders,second.summary.orders);assert(second.records.length>0);assert.equal(second.nextCursor,null);
 const ids=[...first.records,...second.records].map(r=>r.id);assert.equal(new Set(ids).size,ids.length);assert.equal(ids.length,first.summary.orders);
});

test('database constraints reject unbalanced credits and duplicate credits for an order',async()=>{
 const s=core(),order=await orderFor(s);
 await assert.rejects(withStorage(()=>sql.prepare('INSERT INTO portal_wallet_journal VALUES (?,?,?,?,?,?,?,?,?)').run('bad-credit',order.id,'alpha','alice','uat','MYR',100,-99,at)));
 assert.equal((await s.receive(raw(order),auth)).status,200);
 await assert.rejects(withStorage(()=>sql.prepare('INSERT INTO portal_wallet_journal VALUES (?,?,?,?,?,?,?,?,?)').run('duplicate-credit',order.id,'alpha','alice','uat','MYR',1234,-1234,at)));
});

test('verification reads authenticated fixed gateway configuration and order query and rejects an environment mismatch',async()=>{
 const calls=[],order={id:'synthetic_order',trade_no:'provider_synthetic_order',merchant_id:'123456'};
 const verifier=createVPayOrderVerifier({token:'synthetic-admin-query-token-minimum-32-bytes',environment:'uat',fetchImpl:async(url,options)=>{
  calls.push({url,options});
  return Response.json(url.endsWith('/config')?{provider:'vpay',traderId:'123456',mode:'uat',configured:true}:{provider:'vpay',upstreamStatus:200,result:{code:0,data:{}}});
 }});
 assert.deepEqual(await verifier(order),{code:0,data:{}});assert.equal(calls.length,2);assert(calls.every(r=>r.url.startsWith('https://master7-integration-gateway.onrender.com/')));
 assert.equal(calls[1].url.endsWith('/platform/vpay/order-query'),true);assert.equal(calls[1].options.redirect,'error');assert.deepEqual(JSON.parse(calls[1].options.body),{outTradeNo:order.id,tradeNo:order.trade_no});
 assert(calls.every(call=>call.options.headers.Authorization==='Bearer synthetic-admin-query-token-minimum-32-bytes'));
 const wrong=createVPayOrderVerifier({token:'synthetic-query-token-at-least-32-bytes',environment:'production',fetchImpl:async()=>Response.json({provider:'vpay',mode:'uat',configured:true})});
 await assert.rejects(wrong(order),/ENVIRONMENT_UNCONFIRMED/);
});

test.after(async()=>{await sql.close();rmSync(dir,{recursive:true,force:true});});
