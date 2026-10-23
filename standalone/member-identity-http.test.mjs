import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

delete process.env.PORTAL_POSTGRES_URL;
delete process.env.RENDER;
process.env.NODE_ENV='test';
process.env.PORTAL_OWNER_BOOTSTRAP_ENABLED='false';
process.env.PUBLIC_ORIGIN='http://127.0.0.1:8080';
const postgres=process.argv.includes('--postgres'),dir=mkdtempSync(join(tmpdir(),'master7-member-identity-'));
process.env.PORTAL_DATABASE=join(dir,'portal.sqlite');
if(postgres){process.env.PORTAL_TEST_POSTGRES='1';process.env.PORTAL_TEST_POSTGRES_PATH=join(dir,'postgres');}else delete process.env.PORTAL_TEST_POSTGRES;

const {server}=await import('./server.mjs');
const {sql}=await import('./runtime.mjs');
const {hashPassword,newSession,sessionUser}=await import('./security.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port,origin=process.env.PUBLIC_ORIGIN;
const request=(path,options={})=>fetch(base+path,{redirect:'manual',...options});
const post=(path,data,cookie='')=>request(path,{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded',...(cookie?{cookie}:{})},body:new URLSearchParams(data)});
const login=(username,password)=>post('/auth/login',{username,password});
const cookieOf=response=>response.headers.get('set-cookie')?.split(';')[0]||'';
const now=new Date().toISOString(),ownerPassword='Owner-identity-test-7834',memberPassword='Member-identity-test-9362';

test('approval creates an explicit membership and sessions enforce its current tenant binding',async()=>{
 await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run('owner','owner','owner@example.test',await hashPassword(ownerPassword),'owner',1,'synthetic-recovery-hash',now);
 const ownerToken=await newSession('owner');assert(ownerToken);
 const ownerCookie='portal_session='+ownerToken;

 const registered=await post('/auth/register',{username:'member',email:'member@example.test',password:memberPassword});
 assert.equal(registered.status,200);
 const member=await sql.prepare("SELECT * FROM portal_users WHERE username='member'").get();
 assert.equal(member.approved,0);assert.equal(await sql.prepare('SELECT tenant_id FROM members WHERE email=?').get(member.email),undefined);
 assert.equal((await login('member',memberPassword)).status,401);

 const approved=await post('/accounts/approve',{id:member.id},ownerCookie);assert.equal(approved.status,303);
 assert.equal((await sql.prepare('SELECT tenant_id FROM members WHERE email=?').get(member.email)).tenant_id,'main');
 const signedIn=await login('member',memberPassword);assert.equal(signedIn.status,303);
 const memberCookie=cookieOf(signedIn);assert(memberCookie);
 const identity=await sessionUser(memberCookie);assert.equal(identity.role,'customer');assert.equal(identity.tenantId,'main');

 const suspended=await post('/accounts/suspend',{id:member.id},ownerCookie);assert.equal(suspended.status,303);
 assert.equal((await sql.prepare('SELECT tenant_id FROM members WHERE email=?').get(member.email)).tenant_id,'main');
 assert.equal(await sessionUser(memberCookie),null);

 assert.equal((await post('/accounts/approve',{id:member.id},ownerCookie)).status,303);
 const secondLogin=await login('member',memberPassword),secondCookie=cookieOf(secondLogin);assert.equal(secondLogin.status,303);assert(secondCookie);
 await sql.prepare('DELETE FROM members WHERE email=?').run(member.email);
 assert.equal(await sessionUser(secondCookie),null);
 await sql.prepare('DELETE FROM portal_sessions WHERE user_id=?').run(member.id);
 assert.equal((await login('member',memberPassword)).status,401);
 assert.equal(Number((await sql.prepare('SELECT count(*) AS count FROM portal_sessions WHERE user_id=?').get(member.id)).count),0);
});

test('an approved customer without a membership cannot create a usable session',async()=>{
 await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run('orphan','orphan','orphan@example.test',await hashPassword('Orphan-identity-test-4491'),'customer',1,'synthetic-recovery-hash',now);
 assert.equal((await login('orphan','Orphan-identity-test-4491')).status,401);
 assert.equal(await newSession('orphan'),null);
 assert.equal(Number((await sql.prepare('SELECT count(*) AS count FROM portal_sessions WHERE user_id=?').get('orphan')).count),0);
});

test.after(async()=>{
 await new Promise(resolve=>server.close(resolve));
 await sql.close();
 rmSync(dir,{recursive:true,force:true});
});
