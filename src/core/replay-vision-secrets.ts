import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto'
import {one,run} from './db.ts'

function master():Buffer|undefined{const raw=process.env.REPLAY_VISION_MASTER_KEY||'';if(!/^[0-9a-f]{64}$/i.test(raw))return;return Buffer.from(raw,'hex')}
export function browserKeyAllowed():boolean{return !!master()}
export function providerKeyConfigured():boolean{return !!process.env.ANTHROPIC_API_KEY||!!one('SELECT 1 FROM rv_secret WHERE name=?','anthropic')}
export function storeProviderKey(key:string,by:string):void{
 const secret=master();if(!secret)throw new Error('Replay Vision master key is not configured.')
 if(!/^sk-ant-[A-Za-z0-9_-]{20,200}$/.test(key))throw new Error('Invalid provider key format.')
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,iv),data=Buffer.concat([cipher.update(key,'utf8'),cipher.final()]),packed=Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64url')
 run(`INSERT INTO rv_secret(name,ciphertext,updated_by,updated_at) VALUES('anthropic',?,?,?) ON CONFLICT(name) DO UPDATE SET ciphertext=excluded.ciphertext,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,packed,by,new Date().toISOString())
}
export function readProviderKey():string|undefined{
 if(process.env.ANTHROPIC_API_KEY)return process.env.ANTHROPIC_API_KEY
 const secret=master(),row=one<{ciphertext:string}>('SELECT ciphertext FROM rv_secret WHERE name=?','anthropic');if(!secret||!row)return
 try{const packed=Buffer.from(row.ciphertext,'base64url'),iv=packed.subarray(0,12),tag=packed.subarray(12,28),data=packed.subarray(28);const decipher=createDecipheriv('aes-256-gcm',secret,iv);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8')}catch{return}
}
