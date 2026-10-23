import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

delete process.env.PORTAL_POSTGRES_URL;
delete process.env.RENDER;
process.env.NODE_ENV='test';
const postgresTest=process.argv.includes('--postgres');
if(postgresTest)process.env.PORTAL_TEST_POSTGRES='1';else delete process.env.PORTAL_TEST_POSTGRES;
const dir=mkdtempSync(join(tmpdir(),'portal-owner-bootstrap-'));
process.env.PORTAL_DATABASE=join(dir,'portal.sqlite');
if(postgresTest)process.env.PORTAL_TEST_POSTGRES_PATH=join(dir,'pgdata');
process.env.PUBLIC_ORIGIN='http://127.0.0.1:8080';

const bootstrapToken='test-only-owner-bootstrap-token-4f19a79b3b3f4c0d';
const password='Owner-test-password-7823';
process.env.PORTAL_OWNER_BOOTSTRAP_ENABLED='true';
process.env.PORTAL_OWNER_BOOTSTRAP_USERNAME='master7hq';
process.env.PORTAL_OWNER_BOOTSTRAP_EMAIL='owner@example.test';
process.env.PORTAL_OWNER_BOOTSTRAP_TOKEN_SHA256=createHash('sha256').update(bootstrapToken).digest('hex');
process.env.PORTAL_OWNER_BOOTSTRAP_EXPIRES_AT=new Date(Date.now()+3600000).toISOString();

const {server}=await import('./server.mjs');
const {sql}=await import('./runtime.mjs');
const {digest}=await import('./security.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const request=(path,options={})=>fetch(base+path,{redirect:'manual',...options});
const form=(data,{origin=process.env.PUBLIC_ORIGIN}={})=>request('/owner-setup',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data)});
const login=(username,value)=>request('/auth/login',{method:'POST',headers:{origin:process.env.PUBLIC_ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username,password:value})});

try{
 process.env.PORTAL_OWNER_BOOTSTRAP_ENABLED='false';
 assert.equal((await request('/owner-setup')).status,404);
 process.env.PORTAL_OWNER_BOOTSTRAP_ENABLED='true';
 process.env.PORTAL_OWNER_BOOTSTRAP_EXPIRES_AT=new Date(Date.now()-1000).toISOString();
 assert.equal((await request('/owner-setup')).status,410);
 process.env.PORTAL_OWNER_BOOTSTRAP_EXPIRES_AT=new Date(Date.now()+3600000).toISOString();

 const setup=await request('/owner-setup'),setupHtml=await setup.text();
 assert.equal(setup.status,200);
 assert(setupHtml.includes('name="bootstrapToken"'));
 assert(setupHtml.includes('name="confirmPassword"'));
 assert(!setupHtml.includes(bootstrapToken));
 assert(!setupHtml.includes('owner@example.test'));
 assert(setupHtml.includes('ow•••@example.test'));

 const reservedUsername=await request('/auth/register',{method:'POST',headers:{origin:process.env.PUBLIC_ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'master7hq',email:'attacker@example.test',password:'Attacker-test-password-5510'})});
 assert.equal(reservedUsername.status,409);
 const reservedEmail=await request('/auth/register',{method:'POST',headers:{origin:process.env.PUBLIC_ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'attacker',email:'owner@example.test',password:'Attacker-test-password-5510'})});
 assert.equal(reservedEmail.status,409);
 assert.equal((await sql.prepare('SELECT count(*) AS count FROM portal_users').get()).count,0);

 const occupiedId=randomUUID();await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(occupiedId,'master7hq','existing@example.test','test-password-hash','customer',0,'test-recovery-hash',new Date().toISOString());
 assert.equal((await request('/owner-setup')).status,409);
 assert.equal((await form({bootstrapToken,password,confirmPassword:password})).status,409);
 await sql.prepare('DELETE FROM portal_users WHERE id=?').run(occupiedId);

 assert.equal((await form({bootstrapToken,password,confirmPassword:password},{origin:'https://evil.example.test'})).status,403);
 assert.equal((await request('/owner-setup',{method:'POST',headers:{origin:process.env.PUBLIC_ORIGIN,'content-type':'application/json'},body:'{}'})).status,415);
 let rejected=await form({bootstrapToken:'wrong-token-with-at-least-thirty-two-bytes',password,confirmPassword:password});
 assert.equal(rejected.status,400);assert(!(await rejected.text()).includes(bootstrapToken));
 rejected=await form({bootstrapToken,password:'short',confirmPassword:'different'});
 assert.equal(rejected.status,400);assert.equal((await sql.prepare("SELECT count(*) AS count FROM portal_users WHERE role='owner'").get()).count,0);

 const attempts=await Promise.all([
  form({bootstrapToken,password,confirmPassword:password}),
  form({bootstrapToken,password,confirmPassword:password}),
 ]);
 assert.deepEqual(attempts.map(response=>response.status).sort((a,b)=>a-b),[200,410]);
 const success=attempts.find(response=>response.status===200),successHtml=await success.text();
 assert.equal(success.headers.get('set-cookie'),null);
 const recovery=successHtml.match(/<code class="recovery">([^<]+)/)?.[1];
 assert(recovery);assert(!successHtml.includes(bootstrapToken));assert(!successHtml.includes(password));

 const owner=await sql.prepare("SELECT * FROM portal_users WHERE role='owner'").get();
 assert.equal(owner.username,'master7hq');assert.equal(owner.email,'owner@example.test');assert.equal(owner.approved,1);
 assert.notEqual(owner.password_hash,password);assert.equal(owner.recovery_hash,digest(recovery));
 assert.equal((await sql.prepare("SELECT count(*) AS count FROM portal_users WHERE role='owner'").get()).count,1);
 assert.equal((await sql.prepare("SELECT count(*) AS count FROM audit WHERE action='安全建立首位总部管理员'").get()).count,1);
 await assert.rejects(sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),'second-owner','second@example.test','hash','owner',1,'hash',new Date().toISOString()));
 assert.equal((await request('/owner-setup')).status,410);
 assert.equal((await form({bootstrapToken,password,confirmPassword:password})).status,410);
 assert.equal((await login('master7hq',password)).status,303);

 const resetPassword='Changed-owner-password-9901';
 const reset=await request('/auth/reset',{method:'POST',headers:{origin:process.env.PUBLIC_ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'master7hq',recovery,password:resetPassword})});
 assert.equal(reset.status,200);const nextRecovery=(await reset.text()).match(/<code class="recovery">([^<]+)/)?.[1];assert(nextRecovery);assert.notEqual(nextRecovery,recovery);
 assert.equal((await request('/auth/reset',{method:'POST',headers:{origin:process.env.PUBLIC_ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'master7hq',recovery,password:'Another-owner-password-1010'})})).status,400);
 assert.equal((await login('master7hq',password)).status,401);assert.equal((await login('master7hq',resetPassword)).status,303);

 const memberPassword='Member-test-password-3301';
 const register=await request('/auth/register',{method:'POST',headers:{origin:process.env.PUBLIC_ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'member',email:'member@example.test',password:memberPassword})});
 assert.equal(register.status,200);const member=await sql.prepare("SELECT role,approved FROM portal_users WHERE username='member'").get();assert.equal(member.role,'customer');assert.equal(member.approved,0);
 console.log('PASS ['+(postgresTest?'PostgreSQL/PGlite':'SQLite')+']: one-time owner bootstrap, origin and token checks, concurrent single-owner enforcement, hashed secrets, login and recovery rotation.');
}finally{
 await new Promise(resolve=>server.close(resolve));
 await sql.close();
 rmSync(dir,{recursive:true,force:true});
}
