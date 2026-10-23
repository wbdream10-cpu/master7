import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

delete process.env.PORTAL_POSTGRES_URL;delete process.env.RENDER;process.env.NODE_ENV='test';
const postgres=process.argv.includes('--postgres'),directory=mkdtempSync(join(tmpdir(),'master7-finance-reconciliation-'));
process.env.PORTAL_DATABASE=join(directory,'finance.sqlite');
if(postgres){process.env.PORTAL_TEST_POSTGRES='1';process.env.PORTAL_TEST_POSTGRES_PATH=join(directory,'postgres');}else delete process.env.PORTAL_TEST_POSTGRES;
globalThis.fetch=()=>{throw Error('Unexpected network access in finance reconciliation test');};

const {sql,withStorage}=await import('./runtime.mjs');
const {createFinanceReconciliation}=await import('./finance-reconciliation.mjs');
const fixed=new Date('2026-10-23T04:00:00.000Z'),service=createFinanceReconciliation({now:()=>new Date(fixed)});
const owner={userId:'owner',email:'owner@example.test',role:'owner'};
const boss={userId:'boss',email:'boss@example.test',role:'tenant_owner',tenantId:'alpha'};
const betaBoss={userId:'beta-boss',email:'beta-boss@example.test',role:'tenant_owner',tenantId:'beta'};
const finance={userId:'finance',email:'finance@example.test',role:'employee',tenantId:'alpha'};
const employee={userId:'employee',email:'employee@example.test',role:'employee',tenantId:'alpha'};
const member={userId:'member',email:'member@example.test',role:'customer',tenantId:'alpha'};
const betaMember={userId:'beta-member',email:'beta-member@example.test',role:'customer',tenantId:'beta'};
const formula={userId:'formula',email:'formula@example.test',role:'customer',tenantId:'alpha'};
const body=response=>response.json();
const day=new URLSearchParams({tenant:'alpha',from:'2026-10-23',to:'2026-10-23'});

async function deposit({id,user=member,tenant='alpha',provider='vpay',amount=1000,at='2026-10-22T16:00:00.000Z',environment='production',status='credited',journalId='journal-'+id}){
 const merchant=provider==='bank_transfer'?'manual_bank':provider==='gspay_myr'?'gspay-synthetic':'3647';
 await sql.prepare(`INSERT INTO portal_payment_orders(id,tenant_id,user_id,request_key,merchant_id,environment,amount_minor,currency,trade_no,settlement_status,review_required,created_at,verified_at,credited_at,create_outcome,provider)
  VALUES (?,?,?,?,?,?,?,'MYR',?,?,0,?,?,?,'created',?)`).run(id,tenant,user.userId,'request-'+id,merchant,environment,amount,'trade-'+id,status,at,at,at,provider);
 await sql.prepare(`INSERT INTO portal_wallet_journal(id,order_id,tenant_id,user_id,environment,currency,member_minor,clearing_minor,created_at)
  VALUES (?,?,?,?,?,'MYR',?,?,?)`).run(journalId,id,tenant,user.userId,environment,amount,-amount,at);
}
async function withdrawal({id,user=member,tenant='alpha',amount=1500,at='2026-10-23T15:59:59.000Z',journalId='withdrawal-journal-'+id}){
 await sql.prepare(`INSERT INTO portal_withdrawal_requests(id,tenant_id,user_id,request_key,request_fingerprint,environment,amount_minor,currency,bank_name,account_holder,account_number,status,payout_reference,paid_at,created_at,updated_at)
  VALUES (?,?,?,?,?,'production',?,'MYR','Synthetic Bank','SYNTHETIC HOLDER','0000','paid',?,?,?,?)`).run(id,tenant,user.userId,'request-'+id,'f'.repeat(64),amount,'payout-'+id,at,at,at);
 await sql.prepare(`INSERT INTO portal_wallet_withdrawal_journal(id,withdrawal_id,tenant_id,user_id,environment,currency,member_minor,clearing_minor,created_at)
  VALUES (?,?,?,?,'production','MYR',?,?,?)`).run(journalId,id,tenant,user.userId,-amount,amount,at);
}

await withStorage(async()=>{
 for(const tenant of ['alpha','beta'])await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run(tenant,tenant,fixed.toISOString());
 for(const user of [owner,boss,betaBoss,finance,employee,member,betaMember,formula])await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(user.userId,user===formula?'=formula':user.userId,user.email,'synthetic-hash',user.role==='owner'?'owner':'customer',1,'synthetic-recovery',fixed.toISOString());
 for(const user of [member,formula])await sql.prepare('INSERT INTO members VALUES (?,?,?)').run(user.email,'alpha',fixed.toISOString());
 await sql.prepare('INSERT INTO members VALUES (?,?,?)').run(betaMember.email,'beta',fixed.toISOString());
 for(const [user,tenant,role] of [[boss,'alpha','tenant_owner'],[betaBoss,'beta','tenant_owner'],[finance,'alpha','employee'],[employee,'alpha','employee']])await sql.prepare('INSERT INTO portal_staff VALUES (?,?,?)').run(user.userId,tenant,role);
 await sql.prepare('INSERT INTO portal_finance_staff(user_id,tenant_id,granted_by,granted_at) VALUES (?,?,?,?)').run(finance.userId,'alpha',boss.userId,fixed.toISOString());
 await deposit({id:'vpay-in',amount:1000,provider:'vpay'});
 await deposit({id:'gspay-in',amount:2000,provider:'gspay_myr',at:'2026-10-23T01:00:00.000Z'});
 await deposit({id:'bank-in',amount:3000,provider:'bank_transfer',at:'2026-10-23T02:00:00.000Z'});
 await deposit({id:'formula-in',user:formula,amount:400,provider:'unknown',at:'2026-10-23T03:00:00.000Z',journalId:'=formula-journal'});
 await deposit({id:'outside-at-end',amount:500,provider:'vpay',at:'2026-10-23T16:00:00.000Z'});
 await deposit({id:'uat-excluded',amount:600,provider:'vpay',at:'2026-10-23T04:00:00.000Z',environment:'uat'});
 await deposit({id:'beta-excluded',user:betaMember,tenant:'beta',amount:700,provider:'vpay',at:'2026-10-23T05:00:00.000Z'});
 await withdrawal({id:'paid-in',amount:1500});
 await withdrawal({id:'paid-outside',amount:900,at:'2026-10-23T16:00:00.000Z'});
});

test('summary is finance-only, tenant-scoped and uses exact Asia/Kuching boundaries',async()=>{
 assert.equal((await service.getSummary(null,day)).status,401);
 assert.equal((await service.getSummary(member,day)).status,403);
 assert.equal((await service.getSummary(employee,day)).status,403);
 assert.equal((await service.getSummary(betaBoss,new URLSearchParams({tenant:'alpha',from:'2026-10-23',to:'2026-10-23'}))).status,403);
 const result=await body(await service.getSummary(finance,day));
 assert.equal(result.tenantId,'alpha');assert.equal(result.environment,'production');assert.equal(result.currency,'MYR');
 assert.deepEqual(result.range,{from:'2026-10-22T16:00:00.000Z',to:'2026-10-23T16:00:00.000Z',fromLocal:'2026-10-23',toLocal:'2026-10-23',timeZone:'Asia/Kuching'});
 assert.deepEqual(result.deposits,{count:4,amountMinor:'6400',channels:{vpay:{count:1,amountMinor:'1000'},gspay_myr:{count:1,amountMinor:'2000'},bank_transfer:{count:1,amountMinor:'3000'},unknown:{count:1,amountMinor:'400'}}});
 assert.deepEqual(result.withdrawals,{count:1,amountMinor:'1500'});assert.equal(result.netMovementMinor,'4900');
 assert.deepEqual(result.consistency,{depositLedgerConsistent:true,withdrawalLedgerConsistent:true,depositMismatches:0,withdrawalMismatches:0});
 assert.match(result.scope,/supplier_and_bank_statements_not_imported/);
 const beta=await body(await service.getSummary(owner,new URLSearchParams({tenant:'beta',from:'2026-10-23',to:'2026-10-23'})));
 assert.deepEqual(beta.deposits,{count:1,amountMinor:'700',channels:{vpay:{count:1,amountMinor:'700'},gspay_myr:{count:0,amountMinor:'0'},bank_transfer:{count:0,amountMinor:'0'},unknown:{count:0,amountMinor:'0'}}});
});

test('date validation rejects invalid and overlong windows',async()=>{
 assert.equal((await service.getSummary(boss,new URLSearchParams({tenant:'alpha',from:'2026-02-29',to:'2026-02-29'}))).status,400);
 assert.equal((await service.getSummary(boss,new URLSearchParams({tenant:'alpha',from:'2026-09-01',to:'2026-10-23'}))).status,400);
 assert.equal((await service.getSummary(boss,new URLSearchParams({tenant:'alpha',from:'2026-10-24',to:'2026-10-23'}))).status,400);
 assert.equal((await service.getSummary(boss,{})).status,400);
 const defaults=await body(await service.getSummary(boss,new URLSearchParams({tenant:'alpha'})));assert.equal(defaults.range.fromLocal,'2026-10-17');assert.equal(defaults.range.toLocal,'2026-10-23');
});

test('consistency flags identify a journal whose authoritative order no longer says credited',async()=>{
 await sql.prepare("UPDATE portal_payment_orders SET settlement_status='pending' WHERE id='vpay-in'").run();
 const result=await body(await service.getSummary(boss,day));assert.equal(result.consistency.depositLedgerConsistent,false);assert.equal(result.consistency.depositMismatches,1);
 await sql.prepare("UPDATE portal_payment_orders SET settlement_status='credited' WHERE id='vpay-in'").run();
});

test('CSV contains posted movements only, protects spreadsheet formulas and audits the export',async()=>{
 assert.equal((await service.exportRecords(member,day)).status,403);
 const response=await service.exportRecords(finance,day);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/master7-finance-reconciliation\.csv/);assert.equal(response.headers.get('cache-control'),'no-store');
 const csv=await response.text();assert.match(csv,/"deposit"/);assert.match(csv,/"withdrawal"/);assert.match(csv,/"'-1500"/);assert.match(csv,/"'=formula"/);assert.doesNotMatch(csv,/"=formula/);
 assert.doesNotMatch(csv,/Synthetic Bank|SYNTHETIC HOLDER|0000|payout-paid-in/);
 assert.equal((csv.match(/\r\n/g)||[]).length,5);
 const audit=await sql.prepare("SELECT tenant_id,actor,action FROM audit WHERE action LIKE '导出统一资金对账：%'").get();assert.equal(audit.tenant_id,'alpha');assert.equal(audit.actor,finance.email);assert.match(audit.action,/2026-10-23 至 2026-10-23 \/ 5 条/);
});

test('finance revocation and role drift take effect immediately',async()=>{
 await sql.prepare('DELETE FROM portal_finance_staff WHERE user_id=?').run(finance.userId);
 assert.equal((await service.getSummary(finance,day)).status,403);
 assert.equal((await service.exportRecords(finance,day)).status,403);
 const stale={...boss,tenantId:'beta'};assert.equal((await service.getSummary(stale,day)).status,403);
});

test.after(async()=>{await sql.close();rmSync(directory,{recursive:true,force:true});});
