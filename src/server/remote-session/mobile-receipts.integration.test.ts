import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {createRemoteReceiptOwner} from './receipts';
import {remoteSessionRequestSchema} from '../../shared/remoteSession';
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})))});
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'mobile-ledger-'));dirs.push(dir);return {dir,owner:createRemoteReceiptOwner('desktop',dir)}}
const mobile=()=>({kind:'mobile.start' as const,version:1 as const,agentId:'agent',operationId:randomUUID(),text:'原文',assetIds:[randomUUID()],modelId:'allowed-model'});
it('preserves legacy digest/JSON while mobile uses the same operation namespace and protocol fence',async()=>{
 const {dir,owner}=await fixture();const legacy={kind:'start' as const,agentId:'agent',operationId:randomUUID(),text:'legacy text'};
 await owner.begin(legacy,null);await owner.finish(legacy,'accepted','session');
 const legacyFile=join(dir,(await readdir(dir)).find(name=>name.endsWith('.json'))!);const saved=JSON.parse(await readFile(legacyFile,'utf8'));
 expect(saved.digest).toBe(createHash('sha256').update(JSON.stringify(remoteSessionRequestSchema.parse(legacy))).digest('hex'));
 expect(saved.receipt).toEqual({kind:'receipt',agentId:'agent',operationId:legacy.operationId,sessionId:'session',status:'accepted',code:null});
 expect(Object.keys(saved).sort()).toEqual(['version','digest','receipt','ownerPid','ownerToken','updatedAt'].sort());
 await expect(owner.beginMobile({...mobile(),operationId:legacy.operationId},null)).rejects.toMatchObject({code:'REMOTE_OPERATION_CONFLICT'});
 await expect(owner.readMobile('agent',legacy.operationId)).rejects.toMatchObject({code:'REMOTE_OPERATION_PROTOCOL_MISMATCH'});
 const request=mobile();await owner.beginMobile(request,null);
 await expect(owner.begin({...legacy,operationId:request.operationId},null)).rejects.toMatchObject({code:'REMOTE_OPERATION_CONFLICT'});
 await expect(owner.read('agent',request.operationId)).rejects.toMatchObject({code:'REMOTE_OPERATION_PROTOCOL_MISMATCH'});
 for(const changed of [{...request,text:'changed'},{...request,assetIds:[randomUUID()]},{...request,modelId:'other'}])await expect(owner.beginMobile(changed,null)).rejects.toMatchObject({code:'REMOTE_OPERATION_CONFLICT'});
 expect(await owner.readMobile('agent',request.operationId)).toMatchObject({kind:'mobile.receipt',version:1,status:'processing'});
});
it('adopts one mobile intent and immutable file manifest once, then survives an orphan without replay',async()=>{
 const {dir,owner}=await fixture(),request=mobile(),observation='a'.repeat(64),manifest='b'.repeat(64);
 await owner.beginMobile(request,null);await owner.prepareMobileAdmission(request,'session',{observation,model:'allowed-model'});
 expect(await owner.mobileAdmission(request,'session')).toEqual({observation,model:'allowed-model'});
 expect(await owner.readMobileIntent(request,manifest)).toMatchObject({status:'processing'});
 const adopted=await Promise.all([owner.adoptPrepared(request,'session',manifest),owner.adoptPrepared(request,'session',manifest)]);expect(adopted.sort()).toEqual([false,true]);
 await expect(owner.readMobileIntent(request,'c'.repeat(64))).rejects.toMatchObject({code:'REMOTE_OPERATION_CONFLICT'});
 const file=join(dir,(await readdir(dir)).find(name=>name.endsWith('.json'))!);const entry=JSON.parse(await readFile(file,'utf8'));entry.ownerPid=2147483647;await writeFile(file,JSON.stringify(entry),{mode:0o600});
 expect(await owner.readMobile('agent',request.operationId)).toMatchObject({status:'unconfirmed'});
 expect(await owner.beginMobile(request,null)).toMatchObject({fresh:false,receipt:{status:'unconfirmed'}});
 expect(await owner.adoptPrepared(request,'session',manifest)).toBe(false);
 expect(await readFile(file,'utf8')).not.toContain(request.text);
});
