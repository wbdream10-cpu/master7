import { env } from 'cloudflare:workers';
export function isOwner(email:string){const owner=(env as unknown as Record<string,string>).PORTAL_OWNER_EMAIL;return !!owner && email.toLowerCase()===owner.toLowerCase();}
