import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

delete process.env.PORTAL_POSTGRES_URL;delete process.env.PORTAL_TEST_POSTGRES;delete process.env.RENDER;
process.env.NODE_ENV='test';
const directory=mkdtempSync(join(tmpdir(),'master7-finance-reconciliation-http-'));
process.env.PORTAL_DATABASE=join(directory,'finance.sqlite');
process.env.PUBLIC_ORIGIN='https://portal.example.test';

const nativeFetch=globalThis.fetch;
const {sql,withStorage}=await import('./runtime.mjs');
const {newSession}=await import('./security.mjs');
const {server}=await import('./server.mjs');
const postedAt=new Date(Date.now()-60_000).toISOString();
const localParts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuching',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
const localPart=type=>localParts.find(item=>item.type===type)?.value;
const localDate=`${localPart('year')}-${localPart('month')}-${localPart('day')}`;

await withStorage(async()=>{
 await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run('alpha','Alpha',postedAt);
 for(const [id,email,role] of [['member','member@example.test','customer'],['owner','owner@example.test','owner'],['boss','boss@example.test','customer'],['outsider','outsider@example.test','customer']])
  await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(id,id,email,'synthetic-hash',role,1,'synthetic-recovery',postedAt);
 await sql.prepare('INSERT INTO members VALUES (?,?,?)').run('member@example.test','alpha',postedAt);
 await sql.prepare('INSERT INTO members VALUES (?,?,?)').run('outsider@example.test','main',postedAt);
 await sql.prepare('INSERT INTO portal_staff VALUES (?,?,?)').run('boss','alpha','tenant_owner');
 for(const [id,provider,amount] of [['vpay-order','vpay',12000],['bank-order','bank_transfer',3000]]){
  await sql.prepare(`INSERT INTO portal_payment_orders(id,tenant_id,user_id,request_key,merchant_id,environment,amount_minor,currency,trade_no,settlement_status,review_required,created_at,verified_at,credited_at,provider)
   VALUES (?,?,?,?,?,'production',?,'MYR',?,'credited',0,?,?,?,?)`).run(id,'alpha','member','request-'+id,'merchant-'+id,amount,'trade-'+id,postedAt,postedAt,postedAt,provider);
  await sql.prepare(`INSERT INTO portal_wallet_journal(id,order_id,tenant_id,user_id,environment,currency,member_minor,clearing_minor,created_at)
   VALUES (?,?,?,?,'production','MYR',?,?,?)`).run('journal-'+id,id,'alpha','member',amount,-amount,postedAt);
 }
 await sql.prepare(`INSERT INTO portal_withdrawal_requests(id,tenant_id,user_id,request_key,request_fingerprint,environment,amount_minor,currency,bank_name,account_holder,account_number,status,payout_reference,paid_at,created_at,updated_at)
  VALUES ('withdrawal-1','alpha','member','withdraw-request','fingerprint','production',4000,'MYR','Synthetic Bank','Synthetic Member','9999','paid','PAYOUT-1',?,?,?)`).run(postedAt,postedAt,postedAt);
 await sql.prepare(`INSERT INTO portal_wallet_withdrawal_journal(id,withdrawal_id,tenant_id,user_id,environment,currency,member_minor,clearing_minor,created_at)
  VALUES ('withdrawal-journal-1','withdrawal-1','alpha','member','production','MYR',-4000,4000,?)`).run(postedAt);
});

const cookies={};
for(const id of ['member','owner','boss','outsider'])cookies[id]='portal_session='+await newSession(id);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
globalThis.fetch=(input,options)=>{if(!String(input).startsWith(base))throw Error('Unexpected external request');return nativeFetch(input,options);};
const call=(path,options={})=>fetch(base+path,{redirect:'manual',...options});
const query=`?tenant=alpha&from=${localDate}&to=${localDate}`;

try{
 assert.equal((await call('/api/v1/finance-reconciliation'+query)).status,401);
 assert.equal((await call('/api/v1/finance-reconciliation'+query,{headers:{Cookie:cookies.member}})).status,403);
 assert.equal((await call('/api/v1/finance-reconciliation'+query,{headers:{Cookie:cookies.outsider}})).status,403);
 assert.equal((await call('/api/v1/finance-reconciliation'+query,{method:'POST',headers:{Cookie:cookies.owner}})).status,405);
 const response=await call('/api/v1/finance-reconciliation'+query,{headers:{Cookie:cookies.boss}});
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 const result=await response.json();
 assert.deepEqual({tenantId:result.tenantId,deposits:result.deposits.amountMinor,withdrawals:result.withdrawals.amountMinor,net:result.netMovementMinor},{tenantId:'alpha',deposits:'15000',withdrawals:'4000',net:'11000'});
 assert.deepEqual(result.deposits.channels.vpay,{count:1,amountMinor:'12000'});
 assert.deepEqual(result.deposits.channels.bank_transfer,{count:1,amountMinor:'3000'});
 assert.equal(result.consistency.depositLedgerConsistent,true);assert.equal(result.consistency.withdrawalLedgerConsistent,true);
 const exported=await call('/api/v1/finance-reconciliation/export'+query,{headers:{Cookie:cookies.owner}});
 assert.equal(exported.status,200);assert.match(exported.headers.get('content-disposition'),/master7-finance-reconciliation\.csv/);
 const csv=await exported.text();assert(csv.includes('vpay-order'));assert(csv.includes('withdrawal-1'));assert(!csv.includes('Synthetic Bank'));assert(!csv.includes('9999'));
 assert.equal((await call('/api/v1/finance-reconciliation?tenant=alpha&from=2026-01-01&to=2026-02-15',{headers:{Cookie:cookies.owner}})).status,400);
 console.log('PASS: finance reconciliation HTTP routes enforce authentication, finance scope, MYT range validation, exact posted totals, tenant selection and redacted audited CSV. Synthetic data only.');
}finally{
 globalThis.fetch=nativeFetch;await new Promise(resolve=>server.close(resolve));await sql.close();rmSync(directory,{recursive:true,force:true});
}
