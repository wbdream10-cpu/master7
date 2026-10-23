import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

delete process.env.PORTAL_POSTGRES_URL;delete process.env.PORTAL_TEST_POSTGRES;delete process.env.RENDER;
process.env.NODE_ENV='test';
const directory=mkdtempSync(join(tmpdir(),'master7-withdrawals-http-'));
process.env.PORTAL_DATABASE=join(directory,'withdrawals.sqlite');
process.env.PUBLIC_ORIGIN='https://portal.example.test';
process.env.PORTAL_ALLOWED_ORIGINS='https://master7.vip,https://master7.best';
process.env.PORTAL_WITHDRAWALS_ENABLED='true';

const nativeFetch=globalThis.fetch;
const {sql,withStorage}=await import('./runtime.mjs');
const {newSession}=await import('./security.mjs');
const {server}=await import('./server.mjs');
const createdAt=new Date(Date.now()-60_000).toISOString();
const todayMYT=new Date(Date.now()+8*3600000).toISOString().slice(0,10);

await withStorage(async()=>{
 for(const id of ['alpha','beta'])await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run(id,id,createdAt);
 const users=[
  ['member','member@example.test','customer'],['other','other@example.test','customer'],['owner','owner@example.test','owner'],
  ['boss','boss@example.test','customer'],['beta-boss','beta-boss@example.test','customer'],['finance','finance@example.test','customer'],['employee','employee@example.test','customer'],
 ];
 for(const [id,email,role] of users)await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(id,id,email,'synthetic-hash',role,1,'synthetic-recovery',createdAt);
 await sql.prepare('INSERT INTO members VALUES (?,?,?)').run('member@example.test','alpha',createdAt);
 await sql.prepare('INSERT INTO members VALUES (?,?,?)').run('other@example.test','beta',createdAt);
 for(const [id,tenant,role] of [['boss','alpha','tenant_owner'],['beta-boss','beta','tenant_owner'],['finance','alpha','employee'],['employee','alpha','employee']])await sql.prepare('INSERT INTO portal_staff VALUES (?,?,?)').run(id,tenant,role);
 await sql.prepare('INSERT INTO portal_finance_staff(user_id,tenant_id,granted_by,granted_at) VALUES (?,?,?,?)').run('finance','alpha','boss',createdAt);
 await sql.prepare("INSERT INTO portal_payment_orders(id,tenant_id,user_id,request_key,merchant_id,environment,amount_minor,currency,trade_no,settlement_status,review_required,created_at,verified_at,credited_at,provider) VALUES ('http-credit','alpha','member','http_credit_request','manual_bank','production',10000,'MYR','http-credit-reference','credited',0,?,?,?,'bank_transfer')").run(createdAt,createdAt,createdAt);
 await sql.prepare("INSERT INTO portal_wallet_journal(id,order_id,tenant_id,user_id,environment,currency,member_minor,clearing_minor,created_at) VALUES ('http-journal','http-credit','alpha','member','production','MYR',10000,-10000,?)").run(createdAt);
});

const cookies={};
for(const id of ['member','other','owner','boss','beta-boss','finance','employee'])cookies[id]='portal_session='+await newSession(id);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
globalThis.fetch=(input,options)=>{
 const url=String(input);if(!url.startsWith(base))throw Error('Unexpected external network access in withdrawal HTTP test');
 return nativeFetch(input,options);
};
const call=(path,options={})=>fetch(base+path,{redirect:'manual',...options});
const headers=(cookie,origin=process.env.PUBLIC_ORIGIN)=>({Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-Portal-Request':'1'});
const submit={requestKey:'http_withdraw_request_01',amount:'60.00',currency:'MYR',bankName:'Synthetic Bank',accountHolder:'SYNTHETIC MEMBER',accountNumber:'1234 5678'};

try{
 for(const path of ['/api/v1/withdrawals/config','/api/v1/withdrawals','/api/v1/withdrawals/export'])assert.equal((await call(path)).status,401,path);
 assert.equal((await call('/api/v1/withdrawals/missing/review')).status,405);
 assert.equal((await call('/api/v1/withdrawals',{method:'PUT',headers:{Cookie:cookies.member}})).status,405);
 assert.equal((await call('/api/v1/withdrawals/config',{method:'POST',headers:headers(cookies.member),body:'{}'})).status,405);
 assert.equal((await call('/api/v1/withdrawals',{method:'POST',headers:headers(cookies.member,'https://attacker.example.test'),body:JSON.stringify(submit)})).status,403);
 assert.equal((await call('/api/v1/withdrawals',{method:'POST',headers:{...headers(cookies.member),'X-Portal-Request':''},body:JSON.stringify(submit)})).status,415);
 assert.equal((await call('/api/v1/withdrawals',{method:'POST',headers:headers(cookies.member),body:'not-json'})).status,400);
 assert.equal((await call('/api/v1/withdrawals?tenant=beta',{method:'POST',headers:headers(cookies.member),body:JSON.stringify(submit)})).status,403);
 assert.equal((await call('/api/v1/withdrawals',{method:'POST',headers:headers(cookies.owner),body:JSON.stringify(submit)})).status,403);

 const before=await (await call('/api/v1/withdrawals/config',{headers:{Cookie:cookies.member}})).json();
 assert.deepEqual({enabled:before.enabled,balance:before.balanceMinor,posted:before.postedBalanceMinor,held:before.heldMinor,available:before.availableMinor},{enabled:true,balance:'10000',posted:'10000',held:'0',available:'10000'});
 const createdResponse=await call('/api/v1/withdrawals',{method:'POST',headers:headers(cookies.member,'https://master7.vip'),body:JSON.stringify(submit)});
 assert.equal(createdResponse.status,201);const created=(await createdResponse.json()).withdrawal;assert.equal(created.amountMinor,'6000');assert.equal(created.status,'pending_review');
 const duplicate=await (await call('/api/v1/withdrawals',{method:'POST',headers:headers(cookies.member),body:JSON.stringify(submit)})).json();assert.equal(duplicate.duplicate,true);assert.equal(duplicate.withdrawal.id,created.id);

 const walletHeld=await (await call('/api/v1/wallet?environment=production',{headers:{Cookie:cookies.member}})).json();
 assert.deepEqual({balance:walletHeld.balanceMinor,posted:walletHeld.postedBalanceMinor,held:walletHeld.heldMinor,available:walletHeld.availableMinor},{balance:'10000',posted:'10000',held:'6000',available:'4000'});
 const memberList=await (await call('/api/v1/withdrawals',{headers:{Cookie:cookies.member}})).json();assert.equal(memberList.withdrawals.length,1);assert.equal(memberList.withdrawals[0].id,created.id);assert.equal(memberList.nextCursor,null);assert.equal(memberList.filters.from,null);assert.equal(memberList.summary.statuses.pending_review.count,1);
 assert.equal((await call('/api/v1/withdrawals',{headers:{Cookie:cookies.other}})).status,200);
 assert.equal((await (await call('/api/v1/withdrawals',{headers:{Cookie:cookies.other}})).json()).withdrawals.length,0);
 assert.equal((await call('/api/v1/withdrawals',{headers:{Cookie:cookies.employee}})).status,403);
 const filtered=await (await call('/api/v1/withdrawals?status=pending_review&member=member&from='+todayMYT+'&to='+todayMYT,{headers:{Cookie:cookies.finance}})).json();assert.equal(filtered.summary.count,1);assert.equal(filtered.withdrawals[0].id,created.id);assert.deepEqual({status:filtered.filters.status,member:filtered.filters.member,from:filtered.filters.from,to:filtered.filters.to},{status:'pending_review',member:'member',from:todayMYT,to:todayMYT});
 for(const suffix of ['status=unknown','from='+todayMYT,'member=member%25','cursor=bad!'])assert.equal((await call('/api/v1/withdrawals?'+suffix,{headers:{Cookie:cookies.finance}})).status,400,suffix);
 assert.equal((await call('/api/v1/withdrawals/'+created.id+'/review',{method:'POST',headers:headers(cookies.employee),body:JSON.stringify({action:'reject',requestKey:'employee_review_request1',reason:'Not allowed'})})).status,403);
 assert.equal((await call('/api/v1/withdrawals/'+created.id+'/review?tenant=beta',{method:'POST',headers:headers(cookies['beta-boss']),body:JSON.stringify({action:'reject',requestKey:'beta_review_request_001',reason:'Wrong tenant'})})).status,404);

 const start=await call('/api/v1/withdrawals/'+created.id+'/review',{method:'POST',headers:headers(cookies.finance),body:JSON.stringify({action:'start',requestKey:'http_start_review_0001'})});assert.equal(start.status,200);assert.equal((await start.json()).withdrawal.status,'processing');
 const paid=await call('/api/v1/withdrawals/'+created.id+'/review',{method:'POST',headers:headers(cookies.boss,'https://master7.best'),body:JSON.stringify({action:'paid',requestKey:'http_paid_review_00001',reference:'HTTP-PAYOUT-001'})});assert.equal(paid.status,200);assert.equal((await paid.json()).withdrawal.status,'paid');
 const walletPaid=await (await call('/api/v1/wallet?environment=production',{headers:{Cookie:cookies.member}})).json();
 assert.deepEqual({balance:walletPaid.balanceMinor,posted:walletPaid.postedBalanceMinor,held:walletPaid.heldMinor,available:walletPaid.availableMinor},{balance:'4000',posted:'4000',held:'0',available:'4000'});
 const metrics=await (await call('/api/v1/finance-metrics',{headers:{Cookie:cookies.finance}})).json();assert.deepEqual(metrics.withdrawals,{enabled:true,count:1,amountMinor:'6000'});
 assert.equal((await call('/api/v1/withdrawals/export',{headers:{Cookie:cookies.member}})).status,403);
 const exported=await call('/api/v1/withdrawals/export?tenant=alpha&status=paid&member=member&from='+todayMYT+'&to='+todayMYT,{headers:{Cookie:cookies.owner}});assert.equal(exported.status,200);assert.match(exported.headers.get('content-disposition'),/master7-withdrawals\.csv/);const csv=await exported.text();assert(csv.includes(created.id));assert(csv.includes('HTTP-PAYOUT-001'));
 console.log('PASS: local withdrawal HTTP routes enforce authentication, same-origin mutation, tenant and finance permissions, atomic holds, single posted debit, wallet fields, MYT paid metrics and audited CSV. Synthetic data only; no bank or provider requests.');
}finally{
 globalThis.fetch=nativeFetch;await new Promise(resolve=>server.close(resolve));await sql.close();rmSync(directory,{recursive:true,force:true});
}
