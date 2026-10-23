import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
delete process.env.PORTAL_POSTGRES_URL;delete process.env.RENDER;process.env.NODE_ENV='test';
const dir=mkdtempSync(join(tmpdir(),'master7-checkout-'));process.env.PORTAL_DATABASE=join(dir,'checkout.sqlite');
if(process.argv.includes('--postgres')){process.env.PORTAL_TEST_POSTGRES='1';process.env.PORTAL_TEST_POSTGRES_PATH=join(dir,'postgres');}else delete process.env.PORTAL_TEST_POSTGRES;
globalThis.fetch=()=>{throw Error('Unexpected network request in checkout tests');};
const {sql,withStorage}=await import('./runtime.mjs');
const {createVPaySettlement}=await import('./wallet.mjs');
const {createVPayCheckout}=await import('./vpay-checkout.mjs');
const {createVPayOrderCreator}=await import('./vpay-gateway.mjs');
const env={PORTAL_VPAY_SETTLEMENT_ENABLED:'true',PORTAL_VPAY_ORDERS_ENABLED:'true',PORTAL_VPAY_TRADER_ID:'123456',PORTAL_VPAY_ENVIRONMENT:'uat',PORTAL_VPAY_CALLBACK_TOKEN:'synthetic-callback-token-at-least-32-bytes',PORTAL_VPAY_QUERY_TOKEN:'synthetic-query-token-at-least-32-bytes',PORTAL_VPAY_ORDER_TOKEN:'synthetic-order-token-at-least-32-bytes',PORTAL_VPAY_TRADE_CODES:'["2"]',PUBLIC_ORIGIN:'https://portal.example.test',PORTAL_VPAY_RETURN_URL:'https://portal.example.test/payment-return'};
const member={userId:'member',role:'customer',email:'member@example.test',tenantId:'alpha'},other={userId:'other',role:'customer',email:'other@example.test',tenantId:'alpha'};
await withStorage(async()=>{
 await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run('alpha','Alpha',new Date().toISOString());
 for(const user of [member,other]){
  await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(user.userId,user.userId,user.email,'synthetic-hash','customer',1,'synthetic-hash',new Date().toISOString());
  await sql.prepare('INSERT INTO members VALUES (?,?,?)').run(user.email,'alpha',new Date().toISOString());
 }
});
let sequence=0;
const intent=()=>({requestKey:'synthetic_checkout_'+(++sequence),amount:'12.34',currency:'MYR',tradeCode:'2',payerName:'SYNTHETIC MEMBER'});
const receipt=draft=>({code:0,data:{trader_id:'123456',out_trade_no:draft.out_trade_no,trade_no:'provider_'+draft.out_trade_no,amount:draft.amount,pay_url:'https://payment.vpay.club/pay/synthetic',expired_time:'2026-10-23 23:59:59',sign:'must-never-be-stored'}});
const settlement=()=>createVPaySettlement({env,verifyOrder:async order=>({code:0,data:{trader_id:'123456',out_trade_no:order.id,trade_no:order.trade_no,amount:'12.34',state:'3'}})});
const find=id=>withStorage(()=>sql.prepare('SELECT * FROM portal_payment_orders WHERE id=?').get(id));
const rows=()=>withStorage(()=>sql.prepare('SELECT COUNT(*) AS n FROM portal_payment_orders').get()).then(row=>Number(row.n));
test.beforeEach(()=>withStorage(()=>sql.prepare('DELETE FROM portal_rate_limits').run()));
test('checkout stays disabled without every explicit server setting and never creates an order',async()=>{
 let calls=0;const before=await rows();
 for(const change of [{PORTAL_VPAY_ORDERS_ENABLED:'false'},{PORTAL_VPAY_SETTLEMENT_ENABLED:'false'},{PORTAL_VPAY_TRADE_CODES:'[]'},{PORTAL_VPAY_QUERY_TOKEN:''},{PORTAL_VPAY_ORDER_TOKEN:'short'},{PORTAL_VPAY_ORDER_TOKEN:env.PORTAL_VPAY_QUERY_TOKEN},{PORTAL_VPAY_RETURN_URL:'https://another.example.test/return'},{PUBLIC_ORIGIN:'http://localhost:8080'}]){
  const checkout=createVPayCheckout({settlement:settlement(),env:{...env,...change},createOrder:async()=>{calls++;throw Error();}});
  assert.equal((await checkout.publicStatus(member).json()).enabled,false);assert.equal((await checkout.submit(member,intent())).status,503);
 }
 assert.equal(await rows(),before);assert.equal(calls,0);
});
test('creation validates member scope and input before recording or sending anything',async()=>{
 let calls=0;const checkout=createVPayCheckout({settlement:settlement(),env,createOrder:async()=>{calls++;throw Error();}}),before=await rows();
 assert.equal((await checkout.submit(null,intent())).status,401);assert.equal((await checkout.submit({...member,role:'owner'},intent())).status,403);
 for(const change of [{amount:12.34},{amount:'0'},{currency:'USD'},{tradeCode:'1'},{payerName:'\ninvalid'},{requestKey:'short'},{amount:'100000.01'}])assert.equal((await checkout.submit(member,{...intent(),...change})).status,400);
 assert.equal(calls,0);assert.equal(await rows(),before);
});
test('concurrent retries share one durable order and a single outbound create',async()=>{
 const core=settlement();let calls=0;
 let release;const gate=new Promise(resolve=>release=resolve);
 const checkout=createVPayCheckout({settlement:core,env,createOrder:async draft=>{calls++;await gate;return receipt(draft);}}),data=intent();
 const requests=Array.from({length:8},()=>checkout.submit(member,data));
 // Let independent requests reach the claim while the provider response waits.
 await new Promise(resolve=>setTimeout(resolve,30));release();
 const responses=await Promise.all(requests),bodies=await Promise.all(responses.map(r=>r.json()));
 assert.equal(calls,1);assert.equal(new Set(bodies.map(body=>body.id)).size,1);
 const result=await (await checkout.submit(member,data)).json();assert.equal(result.status,'awaiting_payment');assert.equal(result.payUrl,'https://payment.vpay.club/pay/synthetic');assert.equal(calls,1);
 const row=await find(result.id);assert.equal(row.settlement_status,'pending');assert.equal(row.create_outcome,'created');assert.equal(row.trade_code,'2');assert.equal(row.amount_minor,1234);
 assert(!JSON.stringify(result).includes('sign'));assert(!JSON.stringify(row).includes('must-never-be-stored'));
 // Same key with changed contents cannot create or replace the existing order.
 for(const change of [{payerName:'ANOTHER NAME'},{amount:'12.35'},{tradeCode:'1'}])assert([400,409].includes((await checkout.submit(member,{...data,...change})).status));
 assert.equal(calls,1);
});
test('timeouts are retained across factory restarts and never automatically resubmitted',async()=>{
 const core=settlement();let calls=0;const createOrder=async()=>{calls++;throw Error('synthetic timeout');},data=intent();
 const first=await createVPayCheckout({settlement:core,env,createOrder}).submit(member,data);assert.equal(first.status,202);const result=await first.json();assert.equal(result.status,'awaiting_confirmation');assert.equal(result.payUrl,null);
 const restart=createVPayCheckout({settlement:core,env,createOrder});assert.equal((await restart.submit(member,data)).status,202);assert.equal(calls,1);
 const row=await find(result.id);assert.equal(row.create_outcome,'unknown');assert.equal(row.trade_no,null);assert.equal(row.review_required,0);
 const reviews=await withStorage(()=>sql.prepare('SELECT * FROM portal_payment_reviews WHERE order_id=?').all(row.id));assert.equal(reviews.length,1);assert.equal(reviews[0].reason,'VPAY_ORDER_CREATION_PENDING');
});
test('a verified paid callback recovers a lost create response, binds the supplier order and credits exactly once',async()=>{
 const core=settlement(),data=intent();let calls=0;
 const checkout=createVPayCheckout({settlement:core,env,createOrder:async()=>{calls++;throw Error('response lost');}});
 const result=await (await checkout.submit(member,data)).json();
 const callback=Buffer.from(JSON.stringify({trader_id:'123456',out_trade_no:result.id,trade_no:'provider_recovered_'+result.id,amount:'12.34',state:'3',sign:'synthetic-authenticated-gateway-signature'}));
 for(let i=0;i<3;i++)assert.equal(await (await core.receive(callback,'Bearer '+env.PORTAL_VPAY_CALLBACK_TOKEN)).text(),'SUCCESS');
 const row=await find(result.id);assert.equal(row.settlement_status,'credited');assert.equal(row.trade_no,'provider_recovered_'+result.id);assert.equal(row.create_outcome,'created');
 const entries=await withStorage(()=>sql.prepare('SELECT * FROM portal_wallet_journal WHERE order_id=?').all(result.id));assert.equal(entries.length,1);assert.equal(entries[0].member_minor,1234);
 const retry=await (await checkout.submit(member,data)).json();assert.equal(retry.status,'credited');assert.equal(retry.payUrl,null);assert.equal(calls,1);
});
test('invalid create receipts never expose an untrusted checkout URL or permit another send',async()=>{
 for(const change of [{amount:'99.00'},{trader_id:'654321'},{pay_url:'https://attacker.example.test/pay'}]){
  const core=settlement(),data=intent();let calls=0;
  const checkout=createVPayCheckout({settlement:core,env,createOrder:async draft=>{calls++;const result=receipt(draft);return {...result,data:{...result.data,...change}};}});
  const result=await (await checkout.submit(member,data)).json();assert.equal(result.payUrl,null);assert.equal(result.status,'awaiting_confirmation');
  assert.equal((await find(result.id)).trade_no,null);await checkout.submit(member,data);assert.equal(calls,1);
 }
});
test('payment notification arriving before the create response wins safely even when the create response is then lost',async()=>{
 const core=settlement();let id;
 const checkout=createVPayCheckout({settlement:core,env,createOrder:async draft=>{
  id=draft.out_trade_no;
  const callback=Buffer.from(JSON.stringify({trader_id:'123456',out_trade_no:id,trade_no:'early_provider_'+id,amount:'12.34',state:'3',sign:'synthetic-gateway-signature'}));
  assert.equal(await (await core.receive(callback,'Bearer '+env.PORTAL_VPAY_CALLBACK_TOKEN)).text(),'SUCCESS');
  throw Error('response lost after early payment');
 }});
 const result=await (await checkout.submit(member,intent())).json();assert.equal(result.status,'credited');assert.equal(result.payUrl,null);
 const count=await withStorage(()=>sql.prepare('SELECT COUNT(*) AS n FROM portal_wallet_journal WHERE order_id=?').get(id));assert.equal(Number(count.n),1);
 const reviews=await withStorage(()=>sql.prepare('SELECT COUNT(*) AS n FROM portal_payment_reviews WHERE order_id=?').get(id));assert.equal(Number(reviews.n),0);
});
test('the same request key is scoped to the authenticated member',async()=>{
 const core=settlement(),checkout=createVPayCheckout({settlement:core,env,createOrder:async draft=>receipt(draft)}),data=intent();
 const a=await (await checkout.submit(member,data)).json(),b=await (await checkout.submit(other,data)).json();assert.notEqual(a.id,b.id);
 assert.equal((await find(a.id)).user_id,'member');assert.equal((await find(b.id)).user_id,'other');
});
test('creator checks authenticated merchant, environment, channels and callback destinations before using its distinct order credential',async()=>{
 const draft={trader_id:'123456',out_trade_no:'synthetic_order',amount:'12.34',trade_code:'2',title:'MASTER7 deposit',payer_name:'SYNTHETIC MEMBER',notify_url:'https://master7-integration-gateway.onrender.com/callbacks/vpay/payment',callback_url:env.PORTAL_VPAY_RETURN_URL};
 const config={provider:'vpay',traderId:'123456',configured:true,mode:'uat',paymentReady:true,tradeCodes:['2'],notifyUrl:draft.notify_url,returnUrl:draft.callback_url};
 for(const change of [{traderId:'654321'},{mode:'production'},{paymentReady:false},{tradeCodes:['1']},{notifyUrl:'https://attacker.example.test/callback'},{returnUrl:'https://attacker.example.test/return'}]){
  let calls=0;const create=createVPayOrderCreator({queryToken:env.PORTAL_VPAY_QUERY_TOKEN,orderToken:env.PORTAL_VPAY_ORDER_TOKEN,environment:'uat',fetchImpl:async()=>{calls++;return Response.json({...config,...change});}});
  await assert.rejects(create(draft));assert.equal(calls,1);
 }
 const calls=[],create=createVPayOrderCreator({queryToken:env.PORTAL_VPAY_QUERY_TOKEN,orderToken:env.PORTAL_VPAY_ORDER_TOKEN,environment:'uat',fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/config')?config:{provider:'vpay',upstreamStatus:200,result:receipt(draft)});}});
 assert.deepEqual(await create(draft),receipt(draft));assert.equal(calls.length,2);assert.equal(calls[0].options.headers.Authorization,'Bearer '+env.PORTAL_VPAY_QUERY_TOKEN);assert.equal(calls[1].options.headers.Authorization,'Bearer '+env.PORTAL_VPAY_ORDER_TOKEN);assert.equal(calls[1].options.redirect,'error');
});
test.after(async()=>{await sql.close();rmSync(dir,{recursive:true,force:true});});
