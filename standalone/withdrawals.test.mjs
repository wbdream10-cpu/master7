import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';

// Synthetic local data only. The withdrawal service has no provider client.
delete process.env.PORTAL_POSTGRES_URL;delete process.env.RENDER;process.env.NODE_ENV='test';
const postgres=process.argv.includes('--postgres'),directory=mkdtempSync(join(tmpdir(),'master7-withdrawals-'));
process.env.PORTAL_DATABASE=join(directory,'withdrawals.sqlite');
if(postgres){process.env.PORTAL_TEST_POSTGRES='1';process.env.PORTAL_TEST_POSTGRES_PATH=join(directory,'postgres');}else delete process.env.PORTAL_TEST_POSTGRES;
globalThis.fetch=()=>{throw Error('Unexpected network access in withdrawal test');};

const {sql,withStorage}=await import('./runtime.mjs');
const {createWithdrawals,withdrawalWalletState}=await import('./withdrawals.mjs');
const createdAt='2026-10-23T00:00:00.000Z';let tick=0;
const now=()=>new Date(Date.parse('2026-10-23T08:00:00.000Z')+(tick++)*1000);
const enabled=createWithdrawals({env:{PORTAL_WITHDRAWALS_ENABLED:'true'},now,rateLimit:async()=>false});
const disabled=createWithdrawals({env:{},now,rateLimit:async()=>false});
const owner={userId:'owner',email:'owner@example.test',role:'owner'};
const boss={userId:'boss',email:'boss@example.test',role:'tenant_owner',tenantId:'alpha'};
const betaBoss={userId:'beta-boss',email:'beta-boss@example.test',role:'tenant_owner',tenantId:'beta'};
const finance={userId:'finance',email:'finance@example.test',role:'employee',tenantId:'alpha'};
const employee={userId:'employee',email:'employee@example.test',role:'employee',tenantId:'alpha'};
const alice={userId:'alice',email:'alice@example.test',role:'customer',tenantId:'alpha'};
const bob={userId:'bob',email:'bob@example.test',role:'customer',tenantId:'beta'};
const charlie={userId:'charlie',email:'charlie@example.test',role:'customer',tenantId:'alpha'};
const formula={userId:'formula',email:'formula@example.test',role:'customer',tenantId:'alpha'};
const responseBody=response=>response.json();
const count=table=>sql.prepare('SELECT count(*) AS count FROM '+table).get().then(row=>Number(row.count));
const submission=(requestKey,amount='1.00',extra={})=>({requestKey,amount,currency:'MYR',bankName:'Synthetic Bank',accountHolder:'SYNTHETIC MEMBER',accountNumber:'1234 5678',...extra});
const review=(action,requestKey,extra={})=>({action,requestKey,...extra});
const params=value=>new URLSearchParams(value);

async function credit(user,amountMinor,suffix){
 const id='credit-'+suffix;
 await sql.prepare("INSERT INTO portal_payment_orders(id,tenant_id,user_id,request_key,merchant_id,environment,amount_minor,currency,trade_no,settlement_status,review_required,created_at,verified_at,credited_at,provider) VALUES (?,?,?,?,?,'production',?,'MYR',?,'credited',0,?,?,?,'bank_transfer')").run(id,user.tenantId,user.userId,'credit-request-'+suffix,'manual_bank',amountMinor,'credit-reference-'+suffix,createdAt,createdAt,createdAt);
 await sql.prepare("INSERT INTO portal_wallet_journal(id,order_id,tenant_id,user_id,environment,currency,member_minor,clearing_minor,created_at) VALUES (?,?,?,?,'production','MYR',?,?,?)").run('journal-'+suffix,id,user.tenantId,user.userId,amountMinor,-amountMinor,createdAt);
}

await withStorage(async()=>{
 for(const tenant of ['alpha','beta'])await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run(tenant,tenant,createdAt);
 const users=[owner,boss,betaBoss,finance,employee,alice,bob,charlie,formula];
 for(const user of users)await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(user.userId,user.userId,user.email,'synthetic-hash',user.role==='owner'?'owner':'customer',1,'synthetic-recovery',createdAt);
 for(const user of [alice,charlie,formula])await sql.prepare('INSERT INTO members VALUES (?,?,?)').run(user.email,'alpha',createdAt);
 await sql.prepare('INSERT INTO members VALUES (?,?,?)').run(bob.email,'beta',createdAt);
 for(const [user,tenant,role] of [[boss,'alpha','tenant_owner'],[betaBoss,'beta','tenant_owner'],[finance,'alpha','employee'],[employee,'alpha','employee']])await sql.prepare('INSERT INTO portal_staff VALUES (?,?,?)').run(user.userId,tenant,role);
 await sql.prepare('INSERT INTO portal_finance_staff(user_id,tenant_id,granted_by,granted_at) VALUES (?,?,?,?)').run(finance.userId,'alpha',boss.userId,createdAt);
 await credit(alice,10000,'alice');await credit(bob,5000,'bob');await credit(charlie,3000,'charlie');await credit(formula,1000,'formula');
});

test('closed-by-default configuration rejects new requests without changing money',async()=>{
 const config=await responseBody(await disabled.configuration(alice));
 assert.deepEqual({enabled:config.enabled,balance:config.balanceMinor,held:config.heldMinor,available:config.availableMinor},{enabled:false,balance:'10000',held:'0',available:'10000'});
 const before=await count('portal_withdrawal_requests');
 assert.equal((await disabled.submit(alice,null,submission('closed_request_key_0001'))).status,409);
 assert.equal(await count('portal_withdrawal_requests'),before);assert.equal(await count('portal_wallet_holds'),0);
});

let reserved;
test('concurrent requests cannot reserve more than the posted balance',async()=>{
 const attempts=await Promise.all([
  enabled.submit(alice,null,submission('concurrent_request_0001','80.00')),
  enabled.submit(alice,null,submission('concurrent_request_0002','80.00')),
 ]);
 assert.deepEqual(attempts.map(item=>item.status).sort(),[201,409]);
 reserved=(await responseBody(attempts.find(item=>item.status===201))).withdrawal;
 assert.equal(reserved.amountMinor,'8000');
 const wallet=await withdrawalWalletState('alpha','alice');assert.deepEqual(wallet,{balanceMinor:'10000',heldMinor:'8000',availableMinor:'2000'});
 assert.equal(await count('portal_wallet_holds'),1);
});

test('member request idempotency is immutable and records remain tenant-scoped',async()=>{
 // Identify which concurrency key won without relying on scheduling.
 const row=await sql.prepare('SELECT request_key FROM portal_withdrawal_requests WHERE id=?').get(reserved.id);
 const duplicate=await responseBody(await enabled.submit(alice,null,submission(row.request_key,'80.00')));
 assert.equal(duplicate.duplicate,true);assert.equal(duplicate.withdrawal.id,reserved.id);
 assert.equal((await enabled.submit(alice,null,submission(row.request_key,'79.00'))).status,409);
 assert.equal((await enabled.submit(alice,'beta',submission('cross_tenant_request_01'))).status,403);
 const bobRequest=await responseBody(await enabled.submit(bob,null,submission('bob_withdrawal_request_1','10.00')));
 assert.equal((await responseBody(await enabled.list(alice))).withdrawals.some(item=>item.id===bobRequest.withdrawal.id),false);
 assert.equal((await responseBody(await enabled.list(betaBoss))).withdrawals.length,1);
 assert.equal((await enabled.review(betaBoss,null,reserved.id,review('reject','beta_review_request_01',{reason:'Wrong tenant'}))).status,404);
 assert.equal((await enabled.review(employee,null,reserved.id,review('reject','employee_review_req1',{reason:'No finance permission'}))).status,403);
});

test('finance queue is pending-first, filterable and cursor paginated without hiding old work',async()=>{
 for(let index=0;index<101;index++){
  const suffix=String(index).padStart(3,'0'),at=`2026-10-23T01:${String(Math.floor(index/60)).padStart(2,'0')}:${String(index%60).padStart(2,'0')}.000Z`;
  await sql.prepare(`INSERT INTO portal_withdrawal_requests(id,tenant_id,user_id,request_key,request_fingerprint,environment,amount_minor,currency,bank_name,account_holder,account_number,status,payout_reference,paid_at,created_at,updated_at)
   VALUES (?,?,? ,?,?, 'production',100,'MYR','Synthetic Bank','SYNTHETIC MEMBER','5555 0000','paid',?,?,?,?)`).run('beta-paid-'+suffix,'beta','bob','beta-paid-request-'+suffix,'fingerprint-'+suffix,'BETA-PAYOUT-'+suffix,at,at,at);
 }
 await sql.prepare(`INSERT INTO portal_withdrawal_requests(id,tenant_id,user_id,request_key,request_fingerprint,environment,amount_minor,currency,bank_name,account_holder,account_number,status,created_at,updated_at)
  VALUES ('beta-old-pending','beta','bob','beta-old-pending-request','old-pending-fingerprint','production',250,'MYR','Synthetic Bank','SYNTHETIC MEMBER','5555 0000','pending_review','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
 await sql.prepare(`INSERT INTO portal_withdrawal_requests(id,tenant_id,user_id,request_key,request_fingerprint,environment,amount_minor,currency,bank_name,account_holder,account_number,status,created_at,updated_at)
  VALUES ('beta-processing','beta','bob','beta-processing-request','processing-fingerprint','production',300,'MYR','Synthetic Bank','SYNTHETIC MEMBER','5555 0000','processing','2026-10-23T02:00:00.000Z','2026-10-23T02:00:00.000Z')`).run();

 const first=await responseBody(await enabled.list(owner,'beta',params({member:'bo'})));
 assert.equal(first.withdrawals.length,100);assert(first.nextCursor);assert.equal(first.filters.from,null);assert.equal(first.filters.to,null);
 assert.equal(first.summary.count,104);assert.equal(first.summary.statuses.pending_review.count,2);assert.equal(first.summary.statuses.processing.count,1);assert.equal(first.summary.statuses.paid.count,101);
 const processingIndex=first.withdrawals.findIndex(item=>item.status==='processing');assert(processingIndex>=2);assert(first.withdrawals.slice(0,processingIndex).every(item=>item.status==='pending_review'));
 assert(first.withdrawals.some(item=>item.id==='beta-old-pending'),'an old pending item must not be hidden by the default date range');
 const second=await responseBody(await enabled.list(owner,'beta',params({member:'bo',cursor:first.nextCursor})));
 assert.equal(second.summary.count,104);assert.equal(second.nextCursor,null);assert.equal(second.withdrawals.length,4);
 assert.equal(new Set([...first.withdrawals,...second.withdrawals].map(item=>item.id)).size,104);

 const paidFirst=await responseBody(await enabled.list(owner,'beta',params({status:'paid',member:'bob',from:'2026-10-23',to:'2026-10-23'})));
 assert.equal(paidFirst.summary.count,101);assert.equal(paidFirst.withdrawals.length,100);assert(paidFirst.nextCursor);assert(paidFirst.withdrawals.every(item=>item.status==='paid'));
 assert.equal((await enabled.list(owner,'beta',params({status:'processing',member:'bob',from:'2026-10-23',to:'2026-10-23',cursor:paidFirst.nextCursor}))).status,400,'cursor must be bound to filters');
 for(const value of [{from:'2026-10-23'},{from:'2026-02-30',to:'2026-03-01'},{from:'2026-01-01',to:'2026-12-31'},{status:'unknown'},{member:'bob%'},{cursor:'bad!'}])assert.equal((await enabled.list(owner,'beta',params(value))).status,400,JSON.stringify(value));
 const literalUnderscore=await responseBody(await enabled.list(owner,'beta',params({member:'_'})));assert.equal(literalUnderscore.summary.count,0,'underscore must be searched literally rather than as a LIKE wildcard');
 const ownFiltered=await responseBody(await enabled.list(alice,null,params({member:'bob'})));assert.equal(ownFiltered.withdrawals.length,0,'member search must not widen the member scope');

 const exported=await enabled.exportRecords(owner,'beta',params({status:'paid',member:'bob',from:'2026-10-23',to:'2026-10-23'}));assert.equal(exported.status,200);
 const csv=await exported.text();assert(csv.includes('beta-paid-000'));assert(!csv.includes('beta-old-pending'));
 assert.equal((await enabled.exportRecords(owner,'beta',params({cursor:first.nextCursor}))).status,400);
 const audit=(await sql.prepare("SELECT action FROM audit WHERE action LIKE '导出人工提现记录：%' ORDER BY created_at DESC,id DESC LIMIT 1").get()).action;
 assert.match(audit,/2026-10-23 至 2026-10-23 \/ paid \/ bob \/ 101 条/);
});

test('pending to processing to paid consumes one hold and posts exactly one debit',async()=>{
 const startData=review('start','start_review_request_0001');
 const started=await responseBody(await enabled.review(finance,null,reserved.id,startData));assert.equal(started.withdrawal.status,'processing');assert.equal(started.duplicate,false);
 assert.equal((await responseBody(await enabled.review(finance,null,reserved.id,startData))).duplicate,true);
 assert.equal((await enabled.review(boss,null,reserved.id,review('start','second_start_request_01'))).status,409);
 assert.deepEqual(await withdrawalWalletState('alpha','alice'),{balanceMinor:'10000',heldMinor:'8000',availableMinor:'2000'});
 const paidData=review('paid','paid_review_request_00001',{reference:'SYNTHETIC-PAYOUT-001'});
 const paid=await responseBody(await enabled.review(finance,null,reserved.id,paidData));assert.equal(paid.withdrawal.status,'paid');assert.equal(paid.withdrawal.reference,'SYNTHETIC-PAYOUT-001');
 assert.equal((await responseBody(await enabled.review(finance,null,reserved.id,paidData))).duplicate,true);
 assert.equal(await count('portal_wallet_withdrawal_journal'),1);
 const entry=await sql.prepare('SELECT * FROM portal_wallet_withdrawal_journal WHERE withdrawal_id=?').get(reserved.id);assert.equal(Number(entry.member_minor),-8000);assert.equal(Number(entry.clearing_minor),8000);
 assert.equal((await sql.prepare('SELECT state FROM portal_wallet_holds WHERE withdrawal_id=?').get(reserved.id)).state,'consumed');
 assert.deepEqual(await withdrawalWalletState('alpha','alice'),{balanceMinor:'2000',heldMinor:'0',availableMinor:'2000'});
});

let rejected,failed;
test('rejected and failed withdrawals release active holds without a debit',async()=>{
 rejected=(await responseBody(await enabled.submit(alice,null,submission('reject_submission_key01','10.00')))).withdrawal;
 assert.equal((await withdrawalWalletState('alpha','alice')).availableMinor,'1000');
 const rejectedResult=await responseBody(await enabled.review(boss,null,rejected.id,review('reject','reject_review_request01',{reason:'Bank account could not be verified'})));
 assert.equal(rejectedResult.withdrawal.status,'rejected');assert.equal((await withdrawalWalletState('alpha','alice')).availableMinor,'2000');
 failed=(await responseBody(await enabled.submit(alice,null,submission('failed_submission_key01','10.00')))).withdrawal;
 await enabled.review(boss,null,failed.id,review('start','failed_start_request_001'));
 const failedResult=await responseBody(await enabled.review(finance,null,failed.id,review('failed','failed_review_request01',{reason:'Manual bank transfer was not completed'})));
 assert.equal(failedResult.withdrawal.status,'failed');assert.equal((await withdrawalWalletState('alpha','alice')).availableMinor,'2000');
 assert.equal(Number((await sql.prepare('SELECT count(*) AS count FROM portal_wallet_withdrawal_journal WHERE withdrawal_id IN (?,?)').get(rejected.id,failed.id)).count),0);
 assert.deepEqual((await sql.prepare('SELECT state FROM portal_wallet_holds WHERE withdrawal_id IN (?,?) ORDER BY withdrawal_id').all(rejected.id,failed.id)).map(item=>item.state),['released','released']);
});

test('membership changes block processing or payment but still allow safe hold release',async()=>{
 const pending=(await responseBody(await enabled.submit(charlie,null,submission('disabled_member_pending1','5.00')))).withdrawal;
 await sql.prepare('UPDATE portal_users SET approved=0 WHERE id=?').run(charlie.userId);
 assert.equal((await enabled.review(boss,null,pending.id,review('start','disabled_start_review01'))).status,409);
 assert.equal((await enabled.review(boss,null,pending.id,review('reject','disabled_reject_review1',{reason:'Member account became unavailable'}))).status,200);
 await sql.prepare('UPDATE portal_users SET approved=1 WHERE id=?').run(charlie.userId);
 const processing=(await responseBody(await enabled.submit(charlie,null,submission('promoted_member_pending1','5.00')))).withdrawal;
 await enabled.review(boss,null,processing.id,review('start','promoted_start_review01'));
 await sql.prepare('INSERT INTO portal_staff VALUES (?,?,?)').run(charlie.userId,'alpha','employee');
 assert.equal((await enabled.review(boss,null,processing.id,review('paid','promoted_paid_review001',{reference:'PROMOTED-PAYOUT-001'}))).status,409);
 assert.equal((await enabled.review(boss,null,processing.id,review('failed','promoted_fail_review001',{reason:'Member role changed before payment'}))).status,200);
 assert.equal((await sql.prepare('SELECT state FROM portal_wallet_holds WHERE withdrawal_id=?').get(processing.id)).state,'released');
});

test('finance CSV neutralizes spreadsheet formulas and audit logs omit bank details',async()=>{
 const request=(await responseBody(await enabled.submit(formula,null,submission('formula_submission_key01','1.00',{bankName:'=BANK()',accountHolder:'+FORMULA NAME',accountNumber:'999999991'})))).withdrawal;
 await enabled.review(finance,null,request.id,review('start','formula_start_review001'));
 await enabled.review(finance,null,request.id,review('paid','formula_paid_review0001',{reference:'-FORMULA-REFERENCE'}));
 assert.equal((await enabled.exportRecords(formula)).status,403);
 const response=await enabled.exportRecords(owner,'alpha');assert.equal(response.status,200);const csv=await response.text();
 for(const escaped of ["'=BANK()","'+FORMULA NAME","'-FORMULA-REFERENCE"])assert(csv.includes(escaped));
 const audit=(await sql.prepare('SELECT action FROM audit ORDER BY created_at').all()).map(row=>row.action).join('\n');
 assert(!audit.includes('999999991'));assert(!audit.includes('FORMULA NAME'));assert(!audit.includes('FORMULA-REFERENCE'));
});

test('an active hold survives a process restart and still reduces available balance',async()=>{
 const persistent=(await responseBody(await enabled.submit(alice,null,submission('persistent_hold_request1','1.00')))).withdrawal;
 assert.equal((await withdrawalWalletState('alpha','alice')).availableMinor,'1900');
 await sql.close();
 const code=`
  import assert from 'node:assert/strict';
  import {sql} from './standalone/runtime.mjs';
  import {withdrawalWalletState} from './standalone/withdrawals.mjs';
  try{
   const hold=await sql.prepare('SELECT state FROM portal_wallet_holds WHERE withdrawal_id=?').get(${JSON.stringify(persistent.id)});
   assert.equal(hold.state,'active');
   assert.deepEqual(await withdrawalWalletState('alpha','alice'),{balanceMinor:'2000',heldMinor:'100',availableMinor:'1900'});
  }finally{await sql.close();}
 `;
 await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env},stdio:['ignore','ignore','pipe']});let error='';
  child.stderr.on('data',data=>error+=data);child.on('error',reject);child.on('close',status=>status?reject(Error(error)):resolve());
 });
});

test.after(async()=>{await sql.close();rmSync(directory,{recursive:true,force:true});});
