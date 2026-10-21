import { randomBytes,scrypt as scryptCallback,timingSafeEqual,createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { sql } from './runtime.mjs';
const scrypt=promisify(scryptCallback);
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const secret=()=>randomBytes(32).toString('base64url');
export function passwordValid(value){return typeof value==='string'&&value.length>=12&&Buffer.byteLength(value)<=256}
export async function hashPassword(value){const salt=randomBytes(16).toString('hex');const hash=await scrypt(value,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});return salt+':'+hash.toString('hex')}
export async function verifyPassword(value,stored){if(!passwordValid(value))return false;const [salt,key]=stored.split(':');const actual=await scrypt(value,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});const expected=Buffer.from(key,'hex');return expected.length===actual.length&&timingSafeEqual(expected,actual)}
export async function limited(bucket,max=10){
 const now=Date.now();await sql.prepare('DELETE FROM portal_rate_limits WHERE expires_at<?').run(now);
 const row=await sql.prepare('INSERT INTO portal_rate_limits VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=portal_rate_limits.attempts+1 RETURNING attempts').get(bucket,now+900000);
 return row.attempts>max;
}
export async function sessionUser(cookie){const token=cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('portal_session='))?.slice(15);if(!token)return null;const row=(await sql.prepare('SELECT u.*,p.tenant_id,p.role AS staff_role FROM portal_users u JOIN portal_sessions s ON s.user_id=u.id LEFT JOIN portal_staff p ON p.user_id=u.id WHERE s.token_hash=? AND s.expires_at>? AND u.approved=1').get(digest(token),Date.now()));return row?{userId:row.id,displayName:row.username,email:row.email,role:row.role==='owner'?'owner':row.staff_role||'customer',tenantId:row.tenant_id||null}:null}
export async function newSession(id){(await sql.prepare('DELETE FROM portal_sessions WHERE expires_at<?').run(Date.now()));const token=secret();(await sql.prepare('INSERT INTO portal_sessions VALUES (?,?,?)').run(digest(token),id,Date.now()+8*3600000));return token}
