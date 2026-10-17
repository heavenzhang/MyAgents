import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, open, lstat, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
import { isRemoteMutation, remoteSessionRequestSchema, remoteSessionResultSchema, type RemoteSessionRequest, type RemoteSessionResult } from '../../shared/remoteSession';
import { remoteMobileRequestSchema, remoteMobileResultSchema, type RemoteMobileRequest, type RemoteMobileResult } from '../../shared/remoteMobile';
import { withFileLock } from '../utils/file-lock';

type Receipt = Extract<RemoteSessionResult, {kind:'receipt'}>;
type MobileReceipt = Extract<RemoteMobileResult, {kind:'mobile.receipt'}>;
type AnyReceipt = Receipt | MobileReceipt;
type MutationRequest = RemoteSessionRequest | RemoteMobileRequest;
export type PreparedMobileAdmission = { observation: string; model: string | null };
type Entry = { version: 1; digest: string; receipt: AnyReceipt; admission?: PreparedMobileAdmission; assetsDigest?: string; ownerPid: number; ownerToken: string; updatedAt: number; preparedUntil?: number; adopted?: boolean };
const PROCESS_OWNER = randomUUID();
export class RemoteSessionError extends Error {
  constructor(readonly code: string) { super(code); }
}
/** Processing is durable before side effects. A restart yields unconfirmed,
 * never another execution attempt. No request body or credential is stored. */
export function createRemoteReceiptOwner(scope: string, directory = join(homedir(), APP_DATA_DIR_NAME, 'remote-session-receipts'), capacity = 10_000) {
  const active = new Set<string>();
  let heartbeat: NodeJS.Timeout | undefined;
  let touching=false;
  const scopeHash = createHash('sha256').update(scope).digest('hex');
  const file = (agentId: string, operationId: string) => join(directory, createHash('sha256').update(`${scopeHash}\0${agentId}\0${operationId}`).digest('hex') + '.json');
  async function prepare() {
    await mkdir(directory, {recursive:true,mode:0o700});
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new RemoteSessionError('REMOTE_RECEIPT_STORAGE_UNSAFE');
  }
  async function load(path: string): Promise<Entry | null> {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 4096) throw new RemoteSessionError('REMOTE_RECEIPT_STORAGE_UNSAFE');
      const parsed: unknown = JSON.parse(await readFile(path,'utf8'));
      if (!parsed || typeof parsed !== 'object') throw new RemoteSessionError('REMOTE_RECEIPT_INVALID');
      const entry = parsed as Entry;
      if (entry.version !== 1 || !/^[a-f0-9]{64}$/.test(entry.digest) || !validReceipt(entry.receipt) || entry.assetsDigest!==undefined&&!/^[a-f0-9]{64}$/.test(entry.assetsDigest) || entry.admission!==undefined&&!validAdmission(entry.admission)) throw new RemoteSessionError('REMOTE_RECEIPT_INVALID');
      return entry;
    } catch(error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async function write(path: string, entry: Entry) {
    const tmp = `${path}.${randomUUID()}.tmp`;
    try{
      const fd = await open(tmp,'wx',0o600);
      try { await fd.writeFile(JSON.stringify(entry)); await fd.sync(); } finally { await fd.close(); }
      await rename(tmp,path);
      const parent = await open(directory,'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }finally{
      // Only this attempt's random temporary is cleanup-owned. Never delete a
      // durable receipt or another process's candidate after a failed write.
      await unlink(tmp).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new RemoteSessionError('REMOTE_RECEIPT_CLEANUP_FAILED')});
    }
  }
  function keepAlive(path:string){
    active.add(path);
    if(heartbeat)return;
    heartbeat=setInterval(()=>{
      if(touching)return;
      touching=true;
      void (async()=>{
        for(const path of active){
          try{await withFileLock({lockPath:path+'.lock'},async()=>{
            const entry=await load(path);
            if(!entry||entry.receipt.status!=='processing'||entry.ownerToken!==PROCESS_OWNER||entry.ownerPid!==process.pid){active.delete(path);return}
            await write(path,{...entry,updatedAt:Date.now()});
          })}catch{/* A stale lease is unconfirmed. It never authorizes replay. */}
        }
        if(!active.size&&heartbeat){clearInterval(heartbeat);heartbeat=undefined}
      })().finally(()=>{touching=false});
    },3000);
    heartbeat.unref();
  }
  function identity(raw: MutationRequest) {
    const mobile=raw.kind.startsWith('mobile.');
    const request = mobile ? remoteMobileRequestSchema.parse(raw) : remoteSessionRequestSchema.parse(raw);
    if (!(mobile ? request.kind==='mobile.start'||request.kind==='mobile.send' : isRemoteMutation(request as RemoteSessionRequest)) || !('operationId' in request)) throw new RemoteSessionError('REMOTE_OPERATION_REQUIRED');
    return {request,operationId:request.operationId,path:file(request.agentId,request.operationId),digest:createHash('sha256').update(JSON.stringify(request)).digest('hex')};
  }
  function project(entry: Entry): AnyReceipt {
    let alive=false;
    if(Number.isSafeInteger(entry.ownerPid)&&entry.ownerPid>0){try{process.kill(entry.ownerPid,0);alive=true}catch{ /* Owner died; never resend. */ }}
    const preparingExpired=entry.preparedUntil!==undefined&&entry.preparedUntil<Date.now();
    const locallyOrphaned=entry.ownerPid===process.pid&&!active.has(file(entry.receipt.agentId,entry.receipt.operationId));
    // A reused PID is not proof that the original admission job remains alive.
    // Only its incarnation token can refresh this finite observation lease.
    const staleLease=!Number.isFinite(entry.updatedAt)||Date.now()-entry.updatedAt>12_000;
    return entry.receipt.status === 'processing' && (!alive||preparingExpired||locallyOrphaned||staleLease)
      ? {...entry.receipt,status:'unconfirmed',code:'REMOTE_ADMISSION_UNCONFIRMED'} : {...entry.receipt};
  }
  async function begin(raw: MutationRequest, sessionId: string | null): Promise<{fresh:boolean;receipt:AnyReceipt}> {
      const {request,operationId,path,digest} = identity(raw);await prepare();
      return withFileLock({lockPath:path+'.lock'},async()=>{
        const existing = await load(path);
        if(existing){if(existing.digest!==digest)throw new RemoteSessionError('REMOTE_OPERATION_CONFLICT');return {fresh:false,receipt:project(existing)}}
        const receipt:AnyReceipt=raw.kind.startsWith('mobile.') ? {kind:'mobile.receipt',version:1,agentId:request.agentId,operationId,sessionId,status:'processing',code:null} : {kind:'receipt',agentId:request.agentId,operationId,sessionId,status:'processing',code:null};
        // Never age out an unknown operation: deleting its identity permits a
        // duplicate execution. A finite ledger refuses new work when full.
        await withFileLock({lockPath:join(directory,'capacity.lock')},async()=>{
          const entries=await readdir(directory);
          if(entries.filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).length>=capacity)throw new RemoteSessionError('REMOTE_RECEIPT_CAPACITY');
          await write(path,{version:1,digest,receipt,ownerPid:process.pid,ownerToken:PROCESS_OWNER,updatedAt:Date.now()});
        });
        keepAlive(path);return {fresh:true,receipt};
      });
  }
  async function read(agentId:string, operationId:string,mobile=false):Promise<AnyReceipt>{
      remoteSessionRequestSchema.parse({kind:'receipt',agentId,operationId});await prepare();
      const path=file(agentId,operationId),entry=await load(path);
      if(entry&&entry.receipt.status!=='processing')active.delete(path);
      if(entry && (entry.receipt.kind==='mobile.receipt')!==mobile)throw new RemoteSessionError('REMOTE_OPERATION_PROTOCOL_MISMATCH');
      return entry?project(entry):mobile?{kind:'mobile.receipt',version:1,agentId,operationId,sessionId:null,status:'not-found',code:null}:{kind:'receipt',agentId,operationId,sessionId:null,status:'not-found',code:null};
  }
  async function adoptPrepared(raw:MutationRequest,sessionId:string,assetsDigest?:string):Promise<boolean>{
      const {path,digest}=identity(raw);await prepare();
      return withFileLock({lockPath:path+'.lock'},async()=>{
        const entry=await load(path);
        if(!entry||entry.digest!==digest||entry.receipt.sessionId!==sessionId)throw new RemoteSessionError('REMOTE_OPERATION_CONFLICT');
        if(entry.assetsDigest!==undefined&&entry.assetsDigest!==assetsDigest)throw new RemoteSessionError('REMOTE_OPERATION_CONFLICT');
        if(entry.adopted)return false;
        if(project(entry).status!=='processing')throw new RemoteSessionError('REMOTE_ADMISSION_UNCONFIRMED');
        await write(path,{...entry,adopted:true,...(assetsDigest!==undefined?{assetsDigest}:{}),ownerPid:process.pid,ownerToken:PROCESS_OWNER,updatedAt:Date.now(),preparedUntil:undefined});keepAlive(path);return true;
      });
  }
  async function finish(raw:MutationRequest,status:Receipt['status'],sessionId:string|null,code:string|null=null):Promise<AnyReceipt>{
      const {path,digest}=identity(raw);await prepare();
      return withFileLock({lockPath:path+'.lock'},async()=>{
        const entry=await load(path);if(!entry||entry.digest!==digest)throw new RemoteSessionError('REMOTE_OPERATION_CONFLICT');
        const receipt=(entry.receipt.kind==='mobile.receipt'?remoteMobileResultSchema:remoteSessionResultSchema).parse({...entry.receipt,status,sessionId,code}) as AnyReceipt;
        await write(path,{...entry,receipt,ownerPid:process.pid,ownerToken:PROCESS_OWNER,updatedAt:Date.now(),...(scope==='desktop'&&raw.kind==='start'&&!entry.adopted&&status==='processing'?{preparedUntil:Date.now()+60_000}:{})});if(status!=='processing')active.delete(path);return receipt;
      });
  }
  return {
    begin:(raw:RemoteSessionRequest,sessionId:string|null)=>begin(raw,sessionId) as Promise<{fresh:boolean;receipt:Receipt}>,
    beginMobile:(raw:RemoteMobileRequest,sessionId:string|null)=>begin(raw,sessionId) as Promise<{fresh:boolean;receipt:MobileReceipt}>,
    read:(agentId:string,operationId:string)=>read(agentId,operationId) as Promise<Receipt>,
    readMobile:(agentId:string,operationId:string)=>read(agentId,operationId,true) as Promise<MobileReceipt>,
    adoptPrepared,
    finish:(raw:RemoteSessionRequest,status:Receipt['status'],sessionId:string|null,code:string|null=null)=>finish(raw,status,sessionId,code) as Promise<Receipt>,
    finishMobile:(raw:RemoteMobileRequest,status:Receipt['status'],sessionId:string|null,code:string|null=null)=>finish(raw,status,sessionId,code) as Promise<MobileReceipt>,
    async readMobileIntent(raw:RemoteMobileRequest,assetsDigest:string):Promise<MobileReceipt>{
      const {path,digest}=identity(raw);await prepare();const entry=await load(path);
      if(!entry||entry.digest!==digest||entry.receipt.kind!=='mobile.receipt'||entry.assetsDigest!==undefined&&entry.assetsDigest!==assetsDigest)throw new RemoteSessionError('REMOTE_OPERATION_CONFLICT');
      return project(entry) as MobileReceipt;
    },
    async prepareMobileAdmission(raw:RemoteMobileRequest,sessionId:string,admission:PreparedMobileAdmission){
      const {path,digest}=identity(raw);await prepare();
      if(!validAdmission(admission))throw new RemoteSessionError('REMOTE_RECEIPT_INVALID');
      return withFileLock({lockPath:path+'.lock'},async()=>{
        const entry=await load(path);
        if(!entry||entry.digest!==digest||entry.receipt.kind!=='mobile.receipt'||entry.adopted||entry.receipt.status!=='processing')throw new RemoteSessionError('REMOTE_OPERATION_CONFLICT');
        const receipt={...entry.receipt,sessionId};
        await write(path,{...entry,receipt,admission,preparedUntil:Date.now()+60_000,updatedAt:Date.now()});keepAlive(path);
      });
    },
    async mobileAdmission(raw:RemoteMobileRequest,sessionId:string):Promise<PreparedMobileAdmission>{
      const {path,digest}=identity(raw);await prepare();const entry=await load(path);
      if(!entry||entry.digest!==digest||entry.receipt.kind!=='mobile.receipt'||entry.receipt.sessionId!==sessionId||!entry.admission)throw new RemoteSessionError('REMOTE_OPERATION_CONFLICT');
      return {...entry.admission};
    },
  };
}
function validReceipt(value:unknown):boolean {
  if(!value||typeof value!=='object')return false;
  return (value as {kind?:unknown}).kind==='mobile.receipt'
    ? remoteMobileResultSchema.safeParse(value).success
    : remoteSessionResultSchema.safeParse(value).success && (value as {kind?:unknown}).kind==='receipt';
}

function validAdmission(value:PreparedMobileAdmission):boolean {
  return !!value&&typeof value==='object'&&Object.keys(value).sort().join(',')==='model,observation'&&/^[a-f0-9]{64}$/.test(value.observation)&&(value.model===null||typeof value.model==='string'&&value.model.length>0&&value.model.length<=256&&!/[\p{Cc}]/u.test(value.model));
}
