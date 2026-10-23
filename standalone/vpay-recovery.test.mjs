import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// Synthetic SQLite and injected functions only. A network call is always a
// test failure; no supplier, gateway, Render, or production database is used.
delete process.env.PORTAL_POSTGRES_URL;
delete process.env.RENDER;
process.env.NODE_ENV='test';
const directory=mkdtempSync(join(tmpdir(),'master7-vpay-recovery-'));
process.env.PORTAL_DATABASE=join(directory,'recovery.sqlite');
const postgres=process.argv.includes('--postgres');
if(postgres){process.env.PORTAL_TEST_POSTGRES='1';process.env.PORTAL_TEST_POSTGRES_PATH=join(directory,'postgres');}
else delete process.env.PORTAL_TEST_POSTGRES;
globalThis.fetch=()=>{throw Error('Unexpected network access in VPay recovery test');};

const {sql,withStorage}=await import('./runtime.mjs');
const {createVPaySettlement,startVPayRecovery}=await import('./wallet.mjs');
const {createVPayStore}=await import('./vpay-store.mjs');
const fixed='2026-10-24T02:00:00.000Z';
const user={userId:'recovery_member',email:'recovery@example.test',role:'customer',tenantId:'alpha'};
await withStorage(async()=>{
 await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run('alpha','Alpha',fixed);
 await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(user.userId,'recovery_member',user.email,'synthetic-hash','customer',1,'synthetic-recovery',fixed);
 await sql.prepare('INSERT INTO members VALUES (?,?,?)').run(user.email,'alpha',fixed);
});

const baseEnv={
 PORTAL_VPAY_SETTLEMENT_ENABLED:'true',PORTAL_VPAY_RECOVERY_ENABLED:'true',
 PORTAL_VPAY_TRADER_ID:'3647',PORTAL_VPAY_ENVIRONMENT:'uat',
 PORTAL_VPAY_CALLBACK_TOKEN:'synthetic-callback-token-at-least-thirty-two-bytes',
};
let sequence=0;
async function knownOrder(settlement){
 const fingerprint=String(++sequence).padStart(64,'a');
 const order=await settlement.reserveForMember(user,{amount:'10.00',currency:'MYR',requestKey:`recovery_request_${String(sequence).padStart(8,'0')}`,fingerprint,tradeCode:'2'});
 await settlement.claimCreate(order.id,{fingerprint,attemptedAt:fixed});
 return settlement.bindCreatedOrder(order.id,{code:'0',data:{
  trader_id:'3647',out_trade_no:order.id,trade_no:`recovery_trade_${sequence}`,amount:'10.00',
  pay_url:'https://payment.vpay.club/pay/synthetic-recovery',expired_time:'2026-10-24 02:02:00',
 }},{updatedAt:fixed});
}

test('recovery is closed by default and does not allocate a timer',async()=>{
 let timers=0,calls=0;
 const lifecycle=startVPayRecovery({recoverPending:async()=>{calls++;}},{env:{},setIntervalFn:()=>{timers++;return {unref(){}};}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(lifecycle.enabled,false);assert.equal(timers,0);assert.equal(calls,0);
 lifecycle.stop();
});

test('an opted-in pass independently queries a known provider order and credits once',async()=>{
 let queries=0;
 const settlement=createVPaySettlement({env:baseEnv,now:()=>new Date(fixed),verifyOrder:async order=>{
  queries++;
  return {code:'0',data:{out_trade_no:order.id,trade_no:order.trade_no,amount:'10.00',state:'3'}};
 }});
 const order=await knownOrder(settlement);
 assert.deepEqual(await settlement.recoverPending({limit:5}),{enabled:true,processed:1,credited:1});
 assert.equal(queries,1);
 const row=await withStorage(()=>sql.prepare('SELECT settlement_status FROM portal_payment_orders WHERE id=?').get(order.id));
 const journal=await withStorage(()=>sql.prepare('SELECT count(*) AS count FROM portal_wallet_journal WHERE order_id=?').get(order.id));
 assert.equal(row.settlement_status,'credited');assert.equal(Number(journal.count),1);
 assert.deepEqual(await settlement.recoverPending({limit:5}),{enabled:true,processed:0,credited:0});assert.equal(queries,1);
});

test('the worker reclaims an expired query lease left by a crashed process',async()=>{
 let clock=new Date(fixed),queries=0;
 const settlement=createVPaySettlement({env:baseEnv,now:()=>new Date(clock),verifyOrder:async order=>{
  queries++;return {code:0,data:{out_trade_no:order.id,trade_no:order.trade_no,amount:'10.00',state:'3'}};
 }});
 const order=await knownOrder(settlement);
 const crashed=createVPayStore({merchantId:'3647',environment:'uat',now:()=>new Date(clock),queryLeaseMs:60_000,recoveryDelayMs:60_000});
 const stale=await crashed.store.claimQuery(order.id,{attemptedAt:clock.toISOString()});assert.equal(stale.claimed,true);
 assert.deepEqual(await settlement.recoverPending({limit:5}),{enabled:true,processed:0,credited:0});
 clock=new Date(clock.getTime()+61_000);
 assert.deepEqual(await settlement.recoverPending({limit:5}),{enabled:true,processed:1,credited:1});assert.equal(queries,1);
 const attempts=await withStorage(()=>sql.prepare("SELECT outcome,result_code FROM portal_vpay_attempts WHERE order_id=? AND operation='query' ORDER BY started_at,id").all(order.id));
 assert(attempts.some(row=>row.outcome==='unknown'&&row.result_code==='VPAY_QUERY_LEASE_EXPIRED'));
 assert(attempts.some(row=>row.outcome==='succeeded'&&row.result_code==='QUERY_CONFIRMED'));
});

test('an uncertain create without a provider trade number is never queried or resent',async()=>{
 let queries=0;const fingerprint='b'.repeat(64);
 const settlement=createVPaySettlement({env:baseEnv,now:()=>new Date(fixed),verifyOrder:async()=>{queries++;throw Error('must not query');}});
 const order=await settlement.reserveForMember(user,{amount:'11.00',currency:'MYR',requestKey:'unknown_create_request_0001',fingerprint,tradeCode:'2'});
 await settlement.claimCreate(order.id,{fingerprint,attemptedAt:fixed});await settlement.noteCreationPending(order);
 assert.deepEqual(await settlement.recoverPending({limit:5}),{enabled:true,processed:0,credited:0});assert.equal(queries,0);
 const row=await withStorage(()=>sql.prepare('SELECT create_outcome,trade_no FROM portal_payment_orders WHERE id=?').get(order.id));
 assert.equal(row.create_outcome,'unknown');assert.equal(row.trade_no,null);
});

test('the timer suppresses overlapping passes and resumes after completion',async()=>{
 let callback,unref=false,calls=0,release;
 const first=new Promise(resolve=>{release=resolve;});
 const settlement={recoverPending:async()=>{calls++;if(calls===1)await first;return {enabled:true,processed:0,credited:0};}};
 const lifecycle=startVPayRecovery(settlement,{env:{PORTAL_VPAY_RECOVERY_ENABLED:'true',PORTAL_VPAY_RECOVERY_INTERVAL_MS:'60000'},setIntervalFn:(run,delay)=>{
  callback=run;assert.equal(delay,60000);return {unref(){unref=true;}};
 }});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(unref,true);
 await Promise.all([callback(),callback(),callback()]);assert.equal(calls,1);
 release();await new Promise(resolve=>setImmediate(resolve));await callback();assert.equal(calls,2);
 lifecycle.stop();
});

test('a failed pass is isolated and logs no thrown secret text',async()=>{
 const marker='private-token-must-not-appear';let callback;const messages=[],original=console.error;
 console.error=(...values)=>messages.push(values.join(' '));
 try{
  const lifecycle=startVPayRecovery({recoverPending:async()=>{throw Error(marker);}},{env:{PORTAL_VPAY_RECOVERY_ENABLED:'true'},setIntervalFn:run=>{callback=run;return {unref(){}};}});
  await new Promise(resolve=>setImmediate(resolve));await callback();
  assert(messages.length>=2);assert(messages.every(value=>value==='VPay recovery pass failed.'));assert(!messages.join(' ').includes(marker));
  lifecycle.stop();
 }finally{console.error=original;}
});

test.after(async()=>{await sql.close();rmSync(directory,{recursive:true,force:true});});
