import {sql} from './runtime.mjs';
import {hashPassword,passwordValid,secret,digest} from './security.mjs';
import {randomUUID} from 'node:crypto';
const [command,username,email]=process.argv.slice(2);
if(command==='backup'&&username){sql.prepare('VACUUM INTO ?').run(username);console.log('Database backup created.');process.exit(0)}
if(command!=='create-owner'||!username||!email){console.error('Usage: node standalone/admin.mjs create-owner USERNAME EMAIL < private-password-input');process.exit(1)}
if(sql.prepare("SELECT id FROM portal_users WHERE role='owner'").get())throw Error('Owner already exists; no owner will be overwritten.');
if(!/^[a-zA-Z0-9_-]{3,40}$/.test(username)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('Invalid username or email');
let password='';for await(const chunk of process.stdin){password+=chunk;if(password.length>1024)throw Error('Input too long')};password=password.replace(/\r?\n$/,'');if(!passwordValid(password))throw Error('Password must be at least 12 characters and at most 256 bytes.');
const recovery=secret();sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),username.toLowerCase(),email.toLowerCase(),await hashPassword(password),'owner',1,digest(recovery),new Date().toISOString());
console.log('Owner created. Keep this one-time recovery code private:\n'+recovery);
