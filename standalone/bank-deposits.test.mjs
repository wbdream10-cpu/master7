import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';

const postgres=process.argv.includes('--postgres'),dir=mkdtempSync(join(tmpdir(),'master7-bank-deposits-'));
delete process.env.PORTAL_POSTGRES_URL;delete process.env.RENDER;
process.env.NODE_ENV='test';
if(postgres){process.env.PORTAL_TEST_POSTGRES='1';process.env.PORTAL_TEST_POSTGRES_PATH=join(dir,'pglite');}
else{delete process.env.PORTAL_TEST_POSTGRES;process.env.PORTAL_DATABASE=join(dir,'portal.sqlite');}

const {sql,withStorage}=await import('./runtime.mjs');
const {createBankDeposits,readBankReceiptBody,MAX_BANK_RECEIPT_BYTES,BankReceiptUploadError}=await import('./bank-deposits.mjs');
const {newSession,sessionUser}=await import('./security.mjs');
const {getWallet,getPaymentRecords}=await import('./wallet.mjs');
const fixed=new Date('2026-10-23T04:00:00.000Z'),createdAt=fixed.toISOString();
const vpayEnv={PORTAL_VPAY_ORDERS_ENABLED:'true',PORTAL_VPAY_SETTLEMENT_ENABLED:'true',PORTAL_VPAY_ENVIRONMENT:'production',PORTAL_VPAY_TRADER_ID:'3647',PORTAL_VPAY_TRADE_CODES:'["2"]',PUBLIC_ORIGIN:'https://portal.example.test',PORTAL_VPAY_RETURN_URL:'https://portal.example.test/payment-return',PORTAL_VPAY_CALLBACK_TOKEN:'synthetic-callback-token-at-least-32-bytes',PORTAL_VPAY_QUERY_TOKEN:'synthetic-query-token-at-least-32-bytes',PORTAL_VPAY_ORDER_TOKEN:'synthetic-order-token-at-least-32-bytes'};
const bank=createBankDeposits({now:()=>new Date(fixed),rateLimit:async()=>false,env:vpayEnv});
const owner={userId:'owner',email:'owner@example.test',role:'owner',tenantId:null};
const boss={userId:'boss',email:'boss@example.test',role:'tenant_owner',tenantId:'alpha'};
const betaBoss={userId:'beta-boss',email:'beta-boss@example.test',role:'tenant_owner',tenantId:'beta'};
const finance={userId:'finance',email:'finance@example.test',role:'employee',tenantId:'alpha'};
const employee={userId:'employee',email:'employee@example.test',role:'employee',tenantId:'alpha'};
const alice={userId:'alice',email:'alice@example.test',role:'customer',tenantId:null};
const amy={userId:'amy',email:'amy@example.test',role:'customer',tenantId:null};
const bob={userId:'bob',email:'bob@example.test',role:'customer',tenantId:null};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const jpeg=readFileSync(new URL('../public/brand/master7-logo.jpg',import.meta.url));
// Real 1x1 WebP fixture generated without depending on a user-facing brand asset.
const webp=Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vuUAAA=','base64');
let bankConfigUpdatedAt=createdAt;
const submission=(overrides={})=>({amount:'123.45',currency:'MYR',payerName:'ALICE SYNTHETIC',transferReference:'SYNTHETIC-REF-001',transferredAt:'2026-10-23T03:00:00.000Z',bankConfigUpdatedAt,requestKey:'bank_request_key_0001',...overrides});
const body=response=>response.json();

await withStorage(async()=>{
 for(const [id,name] of [['main','Main'],['alpha','Alpha'],['beta','Beta']])await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING').run(id,name,createdAt);
 for(const [id,email,role] of [['owner',owner.email,'owner'],['boss',boss.email,'customer'],['beta-boss',betaBoss.email,'customer'],['finance',finance.email,'customer'],['employee',employee.email,'customer'],['alice',alice.email,'customer'],['amy',amy.email,'customer'],['bob',bob.email,'customer']]){
  await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(id,id,email,'synthetic-hash',role,1,'synthetic-recovery',createdAt);
 }
 for(const [email,tenant] of [[boss.email,'alpha'],[betaBoss.email,'beta'],[finance.email,'alpha'],[employee.email,'alpha'],[alice.email,'alpha'],[amy.email,'alpha'],[bob.email,'beta']])await sql.prepare('INSERT INTO members VALUES (?,?,?)').run(email,tenant,createdAt);
 for(const [id,tenant,role] of [['boss','alpha','tenant_owner'],['beta-boss','beta','tenant_owner'],['finance','alpha','employee'],['employee','alpha','employee']])await sql.prepare('INSERT INTO portal_staff VALUES (?,?,?)').run(id,tenant,role);
});

test('bank account configuration is disabled by default, tenant-scoped and owner-managed',async()=>{
 const empty=await body(await bank.getConfiguration(alice));assert.equal(empty.enabled,false);assert.equal(empty.bankAccount,null);
 assert.equal((await bank.saveConfiguration(alice,null,{bankName:'Synthetic Bank',accountHolder:'Synthetic Holder',accountNumber:'1234 5678',enabled:true})).status,403);
 assert.equal((await bank.saveConfiguration(betaBoss,'alpha',{bankName:'Synthetic Bank',accountHolder:'Synthetic Holder',accountNumber:'1234 5678',enabled:true})).status,403);
 const saved=await bank.saveConfiguration(owner,'alpha',{bankName:'Synthetic Bank',accountHolder:'MASTER7 SYNTHETIC',accountNumber:'1234 5678 9000',enabled:true});assert.equal(saved.status,200);
 const member=await body(await bank.getConfiguration(alice));assert.equal(member.enabled,true);assert.deepEqual(member.bankAccount,{bankName:'Synthetic Bank',accountHolder:'MASTER7 SYNTHETIC',accountNumber:'1234 5678 9000',updatedAt:createdAt});assert.equal(member.canConfigure,false);
 assert.equal(JSON.stringify(member).includes('password'),false);assert.equal(JSON.stringify(member).includes('otp'),false);
 assert.equal((await bank.saveConfiguration(owner,'alpha',{bankName:'Synthetic Bank',accountHolder:'Synthetic Holder',accountNumber:'----',enabled:true})).status,400);
});

let first,financeCookie,receiptSha256;
test('member submission is idempotent, snapshots the recipient and rejects duplicate bank references',async()=>{
 assert.equal((await bank.submit(null,null,submission())).status,401);
 assert.equal((await bank.submit(owner,'alpha',submission())).status,403);
 assert.equal((await bank.submit(alice,'beta',submission())).status,403);
 const created=await bank.submit(alice,null,submission());assert.equal(created.status,201);first=(await body(created)).deposit;
 assert.equal(first.status,'awaiting_review');assert.equal(first.receipt.present,false);assert.equal(first.recipient.accountNumber,'1234 5678 9000');
 const duplicate=await body(await bank.submit(alice,null,submission()));assert.equal(duplicate.duplicate,true);assert.equal(duplicate.deposit.id,first.id);
 assert.equal((await bank.submit(alice,null,submission({amount:'123.46'}))).status,409);
 assert.equal((await bank.submit(amy,null,submission({requestKey:'bank_request_key_amy01'}))).status,409);
 assert.equal((await bank.submit(alice,null,submission({transferReference:'----',requestKey:'bank_request_bad_ref'}))).status,400);
 await bank.saveConfiguration(owner,'alpha',{bankName:'New Synthetic Bank',accountHolder:'NEW SYNTHETIC HOLDER',accountNumber:'9999 0000',enabled:true});
 bankConfigUpdatedAt='2026-10-23T04:00:01.000Z';await sql.prepare('UPDATE portal_bank_accounts SET updated_at=? WHERE tenant_id=?').run(bankConfigUpdatedAt,'alpha');
 assert.equal((await bank.submit(alice,null,submission({bankConfigUpdatedAt:createdAt,transferReference:'SYNTHETIC-STALE-REF',requestKey:'bank_request_stale01'}))).status,409);
 const rows=await body(await bank.list(alice));assert.equal(rows.deposits[0].recipient.bankName,'Synthetic Bank');assert.equal(rows.deposits[0].recipient.accountNumber,'1234 5678 9000');
});

test('receipt reader enforces a separate 2 MiB streaming cap',async()=>{
 const tooLarge=Readable.from([Buffer.alloc(MAX_BANK_RECEIPT_BYTES),Buffer.from([0])]);tooLarge.headers={};
 await assert.rejects(readBankReceiptBody(tooLarge),error=>error instanceof BankReceiptUploadError&&error.status===413);
 const declared=Readable.from([png]);declared.headers={'content-length':String(MAX_BANK_RECEIPT_BYTES+1)};
 await assert.rejects(readBankReceiptBody(declared),error=>error instanceof BankReceiptUploadError&&error.code==='BANK_RECEIPT_TOO_LARGE');
 const valid=Readable.from([png.subarray(0,8),png.subarray(8)]);valid.headers={'content-length':String(png.length)};assert.deepEqual(await readBankReceiptBody(valid),png);
});

test('private receipt upload checks type, magic, dimensions, owner and tenant',async()=>{
 await sql.prepare(`INSERT INTO portal_payment_orders(id,tenant_id,user_id,request_key,merchant_id,environment,amount_minor,currency,trade_no,settlement_status,review_required,created_at,verified_at,credited_at,create_outcome,trade_code,provider)
  VALUES ('receipt-invariant-order','alpha','alice','receipt_invariant_key','manual_bank','production',12345,'MYR','receipt-invariant-order','credited',0,?,?,?,'created','bank_transfer','bank_transfer')`).run(createdAt,createdAt,createdAt);
 await assert.rejects(sql.prepare(`UPDATE portal_bank_deposits SET status='approved',review_request_key='schema_receipt_review',review_fingerprint=?,review_decision='approve',reviewed_by='boss',reviewed_at=?,wallet_order_id='receipt-invariant-order' WHERE id=?`).run('0'.repeat(64),createdAt,first.id));
 assert.equal((await sql.prepare('SELECT status FROM portal_bank_deposits WHERE id=?').get(first.id)).status,'awaiting_review');await sql.prepare('DELETE FROM portal_payment_orders WHERE id=?').run('receipt-invariant-order');
 assert.equal((await bank.review(boss,null,first.id,{decision:'approve',bankVerified:true,receiptSha256:'0'.repeat(64),reviewKey:'review_key_no_receipt'})).status,409);
 assert.equal((await bank.uploadReceipt(boss,null,first.id,png,'image/png')).status,403);
 assert.equal((await bank.uploadReceipt(bob,null,first.id,png,'image/png')).status,404);
 assert.equal((await bank.uploadReceipt(alice,null,first.id,Buffer.from('<svg><script/></svg>'),'image/svg+xml')).status,415);
 assert.equal((await bank.uploadReceipt(alice,null,first.id,png,'image/jpeg')).status,415);
 const hugeDimensions=Buffer.alloc(45);Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(hugeDimensions);hugeDimensions.writeUInt32BE(13,8);hugeDimensions.write('IHDR',12,'ascii');hugeDimensions.writeUInt32BE(6000,16);hugeDimensions.writeUInt32BE(5000,20);hugeDimensions.writeUInt32BE(0,hugeDimensions.length-12);hugeDimensions.write('IEND',hugeDimensions.length-8,'ascii');
 assert.equal((await bank.uploadReceipt(alice,null,first.id,hugeDimensions,'image/png')).status,415);
 const corruptPng=Buffer.from(png);corruptPng[50]^=1;assert.equal((await bank.uploadReceipt(alice,null,first.id,corruptPng,'image/png')).status,415);
 const fakeJpeg=Buffer.from([0xff,0xd8,0xff,0xc0,0,8,8,0,1,0,1,1,0,0,0,0,0,0,0xff,0xd9]);assert.equal((await bank.uploadReceipt(alice,null,first.id,fakeJpeg,'image/jpeg')).status,415);
 const fakeWebp=Buffer.alloc(30);fakeWebp.write('RIFF',0);fakeWebp.writeUInt32LE(22,4);fakeWebp.write('WEBPVP8X',8);fakeWebp.writeUInt32LE(10,16);assert.equal((await bank.uploadReceipt(alice,null,first.id,fakeWebp,'image/webp')).status,415);
 assert.equal((await bank.uploadReceipt(alice,null,first.id,jpeg,'image/jpeg')).status,200);assert.equal((await bank.readReceipt(alice,null,first.id)).headers.get('content-type'),'image/jpeg');
 assert.equal((await bank.uploadReceipt(alice,null,first.id,webp,'image/webp')).status,200);assert.equal((await bank.readReceipt(alice,null,first.id)).headers.get('content-type'),'image/webp');
 const uploaded=await body(await bank.uploadReceipt(alice,null,first.id,png,'image/png'));assert.equal(uploaded.receipt.present,true);assert.equal(uploaded.receipt.size,png.length);assert.match(uploaded.receipt.sha256,/^[a-f0-9]{64}$/);
 receiptSha256=uploaded.receipt.sha256;
 const duplicate=await body(await bank.uploadReceipt(alice,null,first.id,png,'image/png'));assert.equal(duplicate.duplicate,true);
 const own=await bank.readReceipt(alice,null,first.id);assert.equal(own.status,200);assert.equal(own.headers.get('content-type'),'image/png');assert.equal(own.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await own.arrayBuffer()),png);
 await sql.prepare('UPDATE portal_bank_deposits SET receipt_sha256=? WHERE id=?').run('0'.repeat(64),first.id);assert.equal((await bank.readReceipt(alice,null,first.id)).status,503);await sql.prepare('UPDATE portal_bank_deposits SET receipt_sha256=? WHERE id=?').run(receiptSha256,first.id);
 assert.equal((await bank.readReceipt(amy,null,first.id)).status,404);assert.equal((await bank.readReceipt(employee,null,first.id)).status,403);
 const rows=await body(await bank.list(alice));const serialized=JSON.stringify(rows);assert.equal(serialized.includes('receipt_bytes'),false);assert.equal(serialized.includes('data:image'),false);assert.equal(rows.deposits[0].receipt.present,true);
});

test('finance permission is explicit, tenant-scoped and cannot configure banking',async()=>{
 const initial=await body(await bank.listFinanceStaff(boss));assert.deepEqual(initial.employees.map(item=>[item.userId,item.finance]),[['employee',false],['finance',false]]);
 assert.equal((await bank.setFinanceAccess(employee,null,{userId:'finance',enabled:true})).status,403);
 assert.equal((await bank.setFinanceAccess(betaBoss,null,{userId:'finance',enabled:true})).status,409);
 assert.equal((await bank.setFinanceAccess(boss,null,{userId:'alice',enabled:true})).status,409);
 assert.equal((await bank.setFinanceAccess(boss,null,{userId:'finance',enabled:true})).status,200);
 financeCookie='portal_session='+await withStorage(()=>newSession('finance'));
 assert.equal((await withStorage(()=>sessionUser(financeCookie))).finance,true);
 const roster=await body(await bank.listFinanceStaff(boss));assert.equal(roster.employees.find(item=>item.userId==='finance').finance,true);
 assert.equal((await bank.list(finance)).status,200);assert.equal((await bank.readReceipt(finance,null,first.id)).status,200);
 const config=await body(await bank.getConfiguration(finance));assert.equal(config.canReview,true);assert.equal(config.canConfigure,false);
 assert.equal((await bank.saveConfiguration(finance,null,{bankName:'No',accountHolder:'No Access',accountNumber:'123456',enabled:true})).status,403);
 assert.equal((await bank.list(employee)).status,403);assert.equal((await bank.review(employee,null,first.id,{decision:'approve',bankVerified:true,reviewKey:'ordinary_employee_review'})).status,403);
});

test('record lists and metrics never materialize private receipt BLOB columns',async()=>{
 const prepare=sql.prepare,observed=[];
 try{
  sql.prepare=function(source){
   const statement=prepare(source);
   if(typeof source!=='string'||!/^\s*SELECT\b/i.test(source)||!(/\bFROM\s+portal_bank_deposits\b/i.test(source)||/\bFROM\s+portal_private\.portal_bank_deposits\b/i.test(source)))return statement;
   const inspect=value=>{for(const row of Array.isArray(value)?value:[value])if(row){assert.equal(Object.hasOwn(row,'receipt_bytes'),false,`private receipt BLOB selected by: ${source}`);}observed.push(source);return value;};
   return new Proxy(statement,{get(target,property,receiver){const value=Reflect.get(target,property,receiver);return ['get','all'].includes(property)&&typeof value==='function'?async(...args)=>inspect(await value.apply(target,args)):value;}});
  };
  const memberRows=await body(await bank.list(alice)),financeRows=await body(await bank.list(finance)),metrics=await body(await bank.getTodayMetrics(finance));
  assert.equal(memberRows.deposits[0].receipt.present,true);assert.equal(financeRows.deposits[0].receipt.present,true);assert.equal(metrics.tenantId,'alpha');
 }finally{sql.prepare=prepare;}
 assert(observed.length>=4);assert(observed.every(source=>!/^\s*SELECT\s+(?:d\.)?\*/i.test(source)));
});

test('finance approval requires explicit bank verification and credits the wallet exactly once',async()=>{
 const changedReceipt=await body(await bank.uploadReceipt(alice,null,first.id,webp,'image/webp'));assert.notEqual(changedReceipt.receipt.sha256,receiptSha256);
 assert.equal((await bank.review(finance,null,first.id,{decision:'approve',bankVerified:true,receiptSha256,reviewKey:'finance_review_old_receipt'})).status,409);receiptSha256=changedReceipt.receipt.sha256;
 assert.equal((await bank.review(finance,null,first.id,{decision:'approve',bankVerified:false,receiptSha256,reviewKey:'finance_review_key_0001'})).status,400);
 const approved=await body(await bank.review(finance,null,first.id,{decision:'approve',bankVerified:true,receiptSha256,reason:'Verified synthetic bank statement',reviewKey:'finance_review_key_0001'}));
 assert.equal(approved.deposit.status,'approved');assert.equal(approved.deposit.walletOrderId,first.id);assert.equal(approved.duplicate,false);
 const again=await body(await bank.review(finance,null,first.id,{decision:'approve',bankVerified:true,receiptSha256,reason:'Verified synthetic bank statement',reviewKey:'finance_review_key_0001'}));assert.equal(again.duplicate,true);
 assert.equal((await bank.review(finance,null,first.id,{decision:'approve',bankVerified:true,receiptSha256,reviewKey:'finance_review_key_0002'})).status,409);
 assert.equal((await bank.uploadReceipt(alice,null,first.id,png,'image/png')).status,409);
 const journal=await sql.prepare('SELECT * FROM portal_wallet_journal WHERE order_id=?').all(first.id);assert.equal(journal.length,1);assert.equal(Number(journal[0].member_minor),12345);
 const order=await sql.prepare('SELECT * FROM portal_payment_orders WHERE id=?').get(first.id);assert.equal(order.merchant_id,'manual_bank');assert.equal(order.settlement_status,'credited');assert.equal(order.environment,'production');
 const wallet=await body(await getWallet(alice,'alpha','production'));assert.equal(wallet.balanceMinor,'12345');
 const params=new URLSearchParams({tenant:'alpha',environment:'production',from:'2026-10-23',to:'2026-10-23'}),records=await body(await getPaymentRecords(boss,params));
 assert.equal(records.records.find(row=>row.id===first.id).provider,'bank_transfer');
});

test('a member promoted to staff cannot receive approval credit from an earlier bank deposit',async()=>{
 const promoted={userId:'promoted',email:'promoted@example.test',role:'customer',tenantId:null};
 await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(promoted.userId,promoted.userId,promoted.email,'synthetic-hash','customer',1,'synthetic-recovery',createdAt);
 await sql.prepare('INSERT INTO members VALUES (?,?,?)').run(promoted.email,'alpha',createdAt);
 const deposit=(await body(await bank.submit(promoted,null,submission({amount:'1.23',payerName:'PROMOTED SYNTHETIC',transferReference:'SYNTHETIC-PROMOTION-001',requestKey:'bank_request_promoted_01'})))).deposit;
 const receipt=(await body(await bank.uploadReceipt(promoted,null,deposit.id,png,'image/png'))).receipt;
 await sql.prepare('INSERT INTO portal_staff VALUES (?,?,?)').run(promoted.userId,'alpha','employee');
 const before=Number((await sql.prepare('SELECT count(*) AS count FROM portal_wallet_journal WHERE order_id=?').get(deposit.id)).count);
 assert.equal((await bank.review(boss,null,deposit.id,{decision:'approve',bankVerified:true,receiptSha256:receipt.sha256,reviewKey:'promoted_employee_review_01'})).status,409);
 await sql.prepare("UPDATE portal_staff SET role='tenant_owner' WHERE user_id=?").run(promoted.userId);
 assert.equal((await bank.review(boss,null,deposit.id,{decision:'approve',bankVerified:true,receiptSha256:receipt.sha256,reviewKey:'promoted_owner_review_0001'})).status,409);
 assert.equal(Number((await sql.prepare('SELECT count(*) AS count FROM portal_wallet_journal WHERE order_id=?').get(deposit.id)).count),before);
 assert.equal((await sql.prepare('SELECT status FROM portal_bank_deposits WHERE id=?').get(deposit.id)).status,'awaiting_review');
 assert.equal(await sql.prepare('SELECT id FROM portal_payment_orders WHERE id=?').get(deposit.id),undefined);
 await sql.prepare('DELETE FROM portal_bank_deposits WHERE id=?').run(deposit.id);
});

let rejected,pending;
test('rejection is final, idempotent and never credits the wallet',async()=>{
 rejected=(await body(await bank.submit(alice,null,submission({amount:'2.00',transferReference:'SYNTHETIC-REF-002',requestKey:'bank_request_key_0002'})))).deposit;
 assert.equal((await bank.review(finance,null,rejected.id,{decision:'reject',bankVerified:false,reason:'Synthetic collision',reviewKey:'finance_review_key_0001'})).status,409);
 const response=await body(await bank.review(boss,null,rejected.id,{decision:'reject',bankVerified:false,reason:'No matching receipt or bank entry',reviewKey:'boss_reject_key_000001'}));assert.equal(response.deposit.status,'rejected');
 const retry=await body(await bank.review(boss,null,rejected.id,{decision:'reject',bankVerified:false,reason:'No matching receipt or bank entry',reviewKey:'boss_reject_key_000001'}));assert.equal(retry.duplicate,true);
 assert.equal((await sql.prepare('SELECT count(*) AS count FROM portal_wallet_journal WHERE order_id=?').get(rejected.id)).count,0);
 pending=(await body(await bank.submit(amy,null,submission({amount:'3.00',payerName:'AMY SYNTHETIC',transferReference:'SYNTHETIC-REF-003',requestKey:'bank_request_key_amy03'})))).deposit;
});

test('today metrics are Asia/Kuching tenant-scoped, channel-separated and truthful about disabled flows',async()=>{
 await withStorage(async()=>{
  await sql.prepare(`INSERT INTO portal_payment_orders(id,tenant_id,user_id,request_key,merchant_id,environment,amount_minor,currency,trade_no,settlement_status,review_required,created_at,verified_at,credited_at,create_outcome,trade_code,provider)
   VALUES ('synthetic-vpay-order','alpha','alice','synthetic_vpay_key','3647','production',500,'MYR','synthetic-vpay-trade','credited',0,?,?,?,'created','2','vpay')`).run(createdAt,createdAt,createdAt);
  await sql.prepare(`INSERT INTO portal_wallet_journal(id,order_id,tenant_id,user_id,environment,currency,member_minor,clearing_minor,created_at)
   VALUES ('synthetic-vpay-journal','synthetic-vpay-order','alpha','alice','production','MYR',500,-500,?)`).run(createdAt);
  for(const [id,amount,paidAt] of [['metric-withdrawal-in-day',700,'2026-10-22T16:00:00.000Z'],['metric-withdrawal-next-day',900,'2026-10-23T16:00:00.000Z']]){
   await sql.prepare(`INSERT INTO portal_withdrawal_requests(id,tenant_id,user_id,request_key,request_fingerprint,environment,amount_minor,currency,bank_name,account_holder,account_number,status,payout_reference,paid_at,created_at,updated_at)
    VALUES (?,'alpha','alice',?,?,'production',?,'MYR','Synthetic Bank','SYNTHETIC MEMBER','0000','paid',?,?,?,?)`).run(id,id+'-request','f'.repeat(64),amount,id+'-reference',paidAt,paidAt,paidAt);
   await sql.prepare(`INSERT INTO portal_wallet_holds(withdrawal_id,tenant_id,user_id,environment,currency,amount_minor,state,created_at,updated_at,consumed_at)
    VALUES (?,'alpha','alice','production','MYR',?,'consumed',?,?,?)`).run(id,amount,paidAt,paidAt,paidAt);
   await sql.prepare(`INSERT INTO portal_wallet_withdrawal_journal(id,withdrawal_id,tenant_id,user_id,environment,currency,member_minor,clearing_minor,created_at)
    VALUES (?,?, 'alpha','alice','production','MYR',?,?,?)`).run(id+'-journal',id,-amount,amount,paidAt);
  }
 });
 assert.equal((await bank.getTodayMetrics(employee)).status,403);
 const metrics=await body(await bank.getTodayMetrics(finance));assert.equal(metrics.date,'2026-10-23');assert.equal(metrics.timeZone,'Asia/Kuching');
 assert.deepEqual(metrics.withdrawals,{enabled:false,count:1,amountMinor:'700'});assert.deepEqual(metrics.deposits.channels.gspay_myr,{enabled:false,count:0,amountMinor:'0',submitted:{count:0,amountMinor:'0'},credited:{count:0,amountMinor:'0'}});
 const openMetrics=await body(await createBankDeposits({now:()=>new Date(fixed),rateLimit:async()=>false,env:{...vpayEnv,PORTAL_WITHDRAWALS_ENABLED:'true'}}).getTodayMetrics(finance));
 assert.deepEqual(openMetrics.withdrawals,{enabled:true,count:1,amountMinor:'700'}),'the new-request switch must not hide paid history, and the MYT end boundary is exclusive';
 assert.equal(metrics.deposits.channels.vpay.submitted.count,1);assert.equal(metrics.deposits.channels.vpay.submitted.amountMinor,'500');assert.equal(metrics.deposits.channels.vpay.credited.amountMinor,'500');
 assert.equal(metrics.deposits.channels.vpay.enabled,true);const incomplete=await body(await createBankDeposits({now:()=>new Date(fixed),rateLimit:async()=>false,env:{PORTAL_VPAY_ORDERS_ENABLED:'true',PORTAL_VPAY_SETTLEMENT_ENABLED:'true',PORTAL_VPAY_ENVIRONMENT:'production'}}).getTodayMetrics(finance));assert.equal(incomplete.deposits.channels.vpay.enabled,false);
 assert.equal(metrics.deposits.channels.bank_transfer.submitted.count,3);assert.equal(metrics.deposits.channels.bank_transfer.submitted.amountMinor,'12845');assert.equal(metrics.deposits.channels.bank_transfer.credited.amountMinor,'12345');
 assert.equal(metrics.deposits.submitted.count,4);assert.equal(metrics.deposits.submitted.amountMinor,'13345');assert.equal(metrics.deposits.credited.amountMinor,'12845');
 assert.deepEqual(metrics.bankPendingReview,{count:1,amountMinor:'300'});assert.equal(metrics.newRegistrations,2);
});

test('revoking finance access takes effect immediately and all grants/reviews are audited',async()=>{
 assert.equal((await bank.setFinanceAccess(boss,null,{userId:'finance',enabled:false})).status,200);
 assert.equal((await withStorage(()=>sessionUser(financeCookie))).finance,false);
 assert.equal((await bank.list(finance)).status,403);assert.equal((await bank.getTodayMetrics(finance)).status,403);
 const actions=await sql.prepare("SELECT action FROM audit WHERE action LIKE '%财务%' OR action LIKE '%银行%' ORDER BY created_at").all();const joined=actions.map(row=>row.action).join('\n');
 assert.match(joined,/授予财务审核权限/);assert.match(joined,/撤销财务审核权限/);assert.match(joined,/核对银行到账并单次入账/);
});

test.after(async()=>{await sql.close();rmSync(dir,{recursive:true,force:true});});
