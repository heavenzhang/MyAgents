/** Native-token-only admission into the original Desktop Session owner.
 * Lease paths are Rust-owned metadata, never fields in RemoteMobileRequest. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { workspacePathsEqual } from '../../shared/workspacePath';
import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
import { remoteMobileRequestSchema, remoteMobileResultSchema, type RemoteMobileRequest, type RemoteMobileResult } from '../../shared/remoteMobile';
import { remoteArtifactDescriptorSchema, REMOTE_ASSET_MAX_BYTES } from '../../shared/remoteAssets';
import { USER_IMAGE_ATTACHMENT_MAX_BYTES, isImageMimeType } from '../../shared/fileTypes';
import type { AgentConfig } from '../../shared/types/agent';
import type { RuntimeSource, RuntimeType } from '../../shared/types/runtime';
import type { SessionMetadata } from '../types/session';
import type { ImagePayload } from '../runtimes/types';
import { getAttachmentPath, getSessionMetadata, updateSessionMetadata, saveSessionMetadata, publishSessionForHandoff, claimPreparedSessionForTurnAdmission } from '../SessionStore';
import { getSessionEngine, runProcessUpdateAdmission } from '../session-engine';
import { handleAgentShow } from '../admin-api';
import { handleImModelRoute, imSnapshotObservation, type ImModelOption } from '../routes/im-model-selection';
import { suggestNextPrompt } from '../session-prompt-suggestion';
import { snapshotForOwnedSession } from '../utils/session-snapshot';
import { buildSessionSnapshotPatchUpdates } from '../utils/session-snapshot-patch';
import { createMaterializedSessionMetadata } from '../utils/session-materialization';
import { resolveWorkspaceConfig } from '../utils/admin-config';
import { isManagedCodexProviderReady } from '../utils/managed-codex-readiness';
import { desktopRemoteReceipts as receipts, resolveDesktopRemoteTarget as target } from './desktop';
import { RemoteSessionError } from './receipts';
import { buildRemoteSnapshot } from './projection';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const assetSchema = remoteArtifactDescriptorSchema.omit({artifactId:true}).extend({assetId:z.string().regex(uuid),sourcePath:z.string().min(1).max(4096)}).strict();
const envelope = z.object({request:remoteMobileRequestSchema,generation:z.string().min(1).max(256),preparedSessionId:z.string().regex(uuid).optional(),assets:z.array(assetSchema).max(8).optional()}).strict();
type Asset = z.infer<typeof assetSchema>;
type Mutation = Extract<RemoteMobileRequest,{kind:'mobile.start'|'mobile.send'}>;
const jobs = new Set<Promise<void>>();
function fail(code:string):never {throw new RemoteSessionError(code)}
function failure(error:unknown) {const code=error instanceof RemoteSessionError?error.code:'REMOTE_MOBILE_OPERATION_UNCONFIRMED';return {success:false as const,code,data:{kind:'mobile.error' as const,version:1 as const,code}}}
function receiptResult(data:RemoteMobileResult) {return {success:true as const,data:remoteMobileResultSchema.parse(data)}}
function generationCurrent(generation:string) {if(generation!==process.env.MYAGENTS_SIDECAR_GENERATION)fail('REMOTE_SESSION_OWNER_CHANGED')}

/** Reuse the product model menu; only the currently frozen execution authority
 * is eligible. Remote selection cannot switch providers, runtimes or permissions. */
async function models(agentId:string,metadata?:SessionMetadata) {
  const shown=await handleAgentShow({agentId});if(!shown.success)fail('REMOTE_AGENT_UNAVAILABLE');
  const defaults=(shown.data as {effectiveDefaults:{runtime:RuntimeType;runtimeSource?:RuntimeSource;providerId?:string}}).effectiveDefaults;
  const runtime=metadata?.runtime??defaults.runtime;
  const source=metadata?.runtimeSource??defaults.runtimeSource;
  const provider=metadata?.providerId??(metadata?undefined:defaults.providerId);
  const url=new URL('http://internal/api/im/model-options');url.searchParams.set('agentId',agentId);if(metadata)url.searchParams.set('sessionId',metadata.id);
  const response=await handleImModelRoute('/api/im/model-options',new Request(url));
  const body=await response?.json() as {success?:boolean;options?:ImModelOption[]}|undefined;
  if(!response?.ok||!body?.success||!Array.isArray(body.options))fail('REMOTE_MOBILE_MODELS_UNAVAILABLE');
  const native=(runtime==='codex'||runtime==='claude-code')&&source!=='managed-provider';
  const options=body.options.filter(option=>!option.requiresNewSession&&(native
    ? option.selection.kind==='external-cli'&&option.selection.runtime===runtime&&option.selection.runtimeSource===(source??'system-cli')
    : option.selection.kind==='product-provider'&&!!provider&&option.selection.providerId===provider));
  const items=options.map(option=>({id:option.selection.model,label:option.name})).filter(item=>item.id.length>0&&item.id.length<=256&&item.label.length>0&&item.label.length<=256&&!/[\p{Cc}]/u.test(item.id+item.label));
  if(new Set(items.map(item=>item.id)).size!==items.length||items.length>30)fail('REMOTE_MOBILE_MODELS_UNAVAILABLE');
  return {items,defaults};
}
async function selectedModel(request:Mutation,metadata?:SessionMetadata) {
  if(request.modelId===undefined)return metadata?.model??null;
  const catalog=await models(request.agentId,metadata);
  if(!catalog.items.some(item=>item.id===request.modelId))fail('REMOTE_MOBILE_MODEL_UNAVAILABLE');
  return request.modelId;
}

/** Global preparation never reads or copies files and never dispatches a turn. */
export async function prepareDesktopRemoteMobileSession(value:unknown) {
  try {return await runProcessUpdateAdmission(async()=>{
    const {request}=z.object({request:remoteMobileRequestSchema}).strict().parse(value);
    if(request.kind!=='mobile.start'&&request.kind!=='mobile.send')fail('REMOTE_MOBILE_MUTATION_REQUIRED');
    const session=request.kind==='mobile.send'?request.sessionId:undefined;
    const {identity,config}=await target(request.agentId,session);
    const begun=await receipts.beginMobile(request,session??null);
    if(!begun.fresh)return {success:true as const,data:{receipt:begun.receipt}};
    let sessionId=session??null;
    try {
      let metadata=session?getSessionMetadata(session)!:undefined;
      if(metadata&&!metadata.configSnapshotAt){
        const observation=imSnapshotObservation(metadata);
        const snapshotAgent=structuredClone(identity.agent) as AgentConfig;
        // A partial legacy record cannot borrow a different provider's new
        // defaults. Its authority must be resolved on the target before retry.
        if(metadata.providerId!==undefined&&metadata.providerId!==snapshotAgent.providerId)fail('REMOTE_MOBILE_SESSION_NOT_FROZEN');
        if(metadata.model!==undefined){
          if((metadata.runtime==='codex'||metadata.runtime==='claude-code')&&metadata.runtimeSource!=='managed-provider')snapshotAgent.runtimeConfig={...snapshotAgent.runtimeConfig,model:metadata.model};
          else snapshotAgent.model=metadata.model;
        }
        const baseline=snapshotForOwnedSession(snapshotAgent,{runtimeOverride:metadata.runtime,runtimeSourceOverride:metadata.runtimeSource,managedCodexProviderReady:isManagedCodexProviderReady(config)});
        const updates=buildSessionSnapshotPatchUpdates({existing:metadata,baseSnapshot:baseline,payload:{model:metadata.model??baseline.model??null},nowIso:new Date().toISOString()});
        metadata=await updateSessionMetadata(metadata.id,{...updates,runtimeSource:metadata.runtimeSource??baseline.runtimeSource,runtimeBinding:metadata.runtimeBinding??baseline.runtimeBinding,runtimeBindingCompatibility:metadata.runtimeBindingCompatibility??baseline.runtimeBindingCompatibility},current=>!current.configSnapshotAt&&imSnapshotObservation(current)===observation)??undefined;
        if(!metadata)fail('REMOTE_SESSION_OWNER_CHANGED');
      }
      const model=await selectedModel(request,metadata);
      if(request.kind==='mobile.start') {
        const shown=await handleAgentShow({agentId:request.agentId});if(!shown.success)fail('REMOTE_AGENT_UNAVAILABLE');
        const defaults=(shown.data as {effectiveDefaults:{runtime:RuntimeType;runtimeSource?:RuntimeSource}}).effectiveDefaults;
        if(defaults.runtimeSource==='managed-provider'&&!isManagedCodexProviderReady(config))fail('REMOTE_RUNTIME_NOT_READY');
        const agent=structuredClone(identity.agent) as AgentConfig;
        if(request.modelId!==undefined){if((defaults.runtime==='codex'||defaults.runtime==='claude-code')&&defaults.runtimeSource!=='managed-provider')agent.runtimeConfig={...agent.runtimeConfig,model:request.modelId};else agent.model=request.modelId;}
        sessionId=randomUUID();
        metadata=createMaterializedSessionMetadata({agentDir:identity.workspacePath,sessionId,scenario:'desktop',agent,runtimeOverride:defaults.runtime,runtimeSourceOverride:defaults.runtimeSource,managedCodexProviderReady:isManagedCodexProviderReady(config),title:request.text.trim().slice(0,40)||'New Chat'});
        metadata.materializationState='prepared';metadata.materializationSourceSessionId=request.operationId;
        await saveSessionMetadata(metadata);
        if(metadata.transcriptFormat===2&&!(await publishSessionForHandoff(sessionId)))fail('REMOTE_BIRTH_PUBLICATION_FAILED');
      }
      if(!metadata||!sessionId)fail('REMOTE_SESSION_NOT_FOUND');
      await receipts.prepareMobileAdmission(request,sessionId,{observation:imSnapshotObservation(metadata),model:request.modelId!==undefined?model:metadata.model??null});
      return {success:true as const,data:{agentId:request.agentId,sessionId,workspacePath:identity.workspacePath}};
    } catch(error) {await receipts.finishMobile(request,'rejected',sessionId,failure(error).data.code);throw error}
  })} catch(error){return failure(error)}
}

async function checkedDirectory(directory:string,privateMode=false) {
  const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||(privateMode&&process.platform!=='win32'&&(stat.mode&0o077)))fail('REMOTE_MOBILE_ASSET_PATH_UNSAFE');
  if(await realpath(directory)!==directory)fail('REMOTE_MOBILE_ASSET_PATH_UNSAFE');
}
async function readAsset(asset:Asset,retain=true):Promise<Buffer> {
  const root=path.join(homedir(),APP_DATA_DIR_NAME,'remote-assets-v1');
  const relative=path.relative(root,asset.sourcePath),parts=relative.split(path.sep);
  if(asset.sourcePath!==path.join(root,...parts)||parts.length!==3||!/^[a-f0-9]{64}$/.test(parts[0])||!uuid.test(parts[1])||parts[2]!=='data')fail('REMOTE_MOBILE_ASSET_PATH_UNSAFE');
  await checkedDirectory(root,true);await checkedDirectory(path.join(root,parts[0]),true);await checkedDirectory(path.join(root,parts[0],parts[1]),true);
  const before=await lstat(asset.sourcePath);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size!==asset.sizeBytes||(process.platform!=='win32'&&(before.mode&0o077)))fail('REMOTE_MOBILE_ASSET_INVALID');
  const fd=await open(asset.sourcePath,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try {
    const stat=await fd.stat();if(!stat.isFile()||stat.ino!==before.ino||stat.dev!==before.dev||stat.size!==asset.sizeBytes)fail('REMOTE_MOBILE_ASSET_INVALID');
    const bytes=retain?Buffer.alloc(asset.sizeBytes):undefined;
    const block=Buffer.alloc(65536),header=Buffer.alloc(Math.min(16,asset.sizeBytes));
    const hash=createHash('sha256');let offset=0;
    const text=asset.mimeType.startsWith('text/')?new TextDecoder('utf-8',{fatal:true}):undefined;
    try {
      while(offset<asset.sizeBytes){
        const read=await fd.read(block,0,Math.min(block.length,asset.sizeBytes-offset),offset);if(!read.bytesRead)break;
        const chunk=block.subarray(0,read.bytesRead);
        if(offset<header.length)chunk.copy(header,offset,0,Math.min(chunk.length,header.length-offset));
        if(text){if(chunk.includes(0))fail('REMOTE_MOBILE_ASSET_MIME_MISMATCH');try{text.decode(chunk,{stream:true})}catch{fail('REMOTE_MOBILE_ASSET_MIME_MISMATCH')}}
        hash.update(chunk);if(bytes)chunk.copy(bytes,offset);offset+=chunk.length;
      }
      if(text){try{text.decode()}catch{fail('REMOTE_MOBILE_ASSET_MIME_MISMATCH')}}
      const trailing=await fd.read(block,0,1,offset);
      const after=await fd.stat();if(offset!==asset.sizeBytes||trailing.bytesRead||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||await realpath(asset.sourcePath)!==asset.sourcePath)fail('REMOTE_MOBILE_ASSET_CHANGED');
      if(hash.digest('hex')!==asset.sha256)fail('REMOTE_MOBILE_ASSET_HASH_MISMATCH');
      validateMime(asset.mimeType,header);return bytes??Buffer.alloc(0);
    } finally {block.fill(0)}
  } finally {await fd.close()}
}
function validateMime(mime:string,bytes:Buffer) {
  const detected=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':/^GIF8[79]a/.test(bytes.subarray(0,6).toString('ascii'))?'image/gif':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':undefined;
  if(mime.startsWith('image/')&&(!isImageMimeType(mime)||detected!==(mime==='image/jpg'?'image/jpeg':mime)))fail('REMOTE_MOBILE_ASSET_MIME_MISMATCH');
  if(detected&&!mime.startsWith('image/'))fail('REMOTE_MOBILE_ASSET_MIME_MISMATCH');
  if(mime==='application/pdf'&&bytes.subarray(0,5).toString()!=='%PDF-')fail('REMOTE_MOBILE_ASSET_MIME_MISMATCH');
}
async function controlledChild(root:string,segments:string[]) {
  await checkedDirectory(root);
  let current=root;
  for(const segment of segments){current=path.join(current,segment);try{await mkdir(current,{mode:0o700})}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}await checkedDirectory(current);}
  return current;
}
async function storeBytes(directory:string,name:string,data:Buffer) {
  const file=path.join(directory,name);const fd=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
  try {await fd.writeFile(data);await fd.sync()}finally{await fd.close()}
  const parent=await open(directory,constants.O_RDONLY);try{if(process.platform!=='win32')await parent.sync()}finally{await parent.close()}
}
function checkAssets(request:Mutation,assets:Asset[]) {
  if(assets.length!==request.assetIds.length||assets.some((asset,i)=>asset.assetId!==request.assetIds[i])||new Set(assets.map(asset=>asset.assetId)).size!==assets.length)fail('REMOTE_MOBILE_ASSET_BINDING_MISMATCH');
  if(assets.some(asset=>asset.sizeBytes>REMOTE_ASSET_MAX_BYTES||asset.mimeType.startsWith('image/')&&asset.sizeBytes>USER_IMAGE_ATTACHMENT_MAX_BYTES))fail('REMOTE_MOBILE_ASSET_SIZE_LIMIT');
}
async function copyAssets(request:Mutation,sessionId:string,workspace:string,assets:Asset[]) {
  // Verify every lease completely before creating any product attachment.
  for(const asset of assets)await readAsset(asset,false);
  const images:ImagePayload[]=[];const refs:string[]=[];
  for(let i=0;i<assets.length;i++){
    const asset=assets[i],data=await readAsset(asset);
    if(isImageMimeType(asset.mimeType)){
      const root=getAttachmentPath('');await mkdir(root,{recursive:true,mode:0o700});
      const directory=await controlledChild(root,[sessionId]);const extension=asset.mimeType==='image/jpeg'||asset.mimeType==='image/jpg'?'jpeg':asset.mimeType.slice(6);
      const filename=`${request.operationId}-${asset.assetId}.${extension}`;await storeBytes(directory,filename,data);
      images.push({kind:'attachment_ref',id:asset.assetId,name:asset.name,mimeType:asset.mimeType,sizeBytes:asset.sizeBytes,relativePath:`${sessionId}/${filename}`});
    }else{
      const root=await realpath(workspace);const directory=await controlledChild(root,['myagents_files','remote-mobile',sessionId,request.operationId]);
      const extension=path.extname(asset.name).slice(1).toLowerCase();const filename=asset.assetId+(/^[a-z0-9]{1,12}$/.test(extension)?`.${extension}`:'');await storeBytes(directory,filename,data);
      refs.push(`@myagents_files/remote-mobile/${sessionId}/${request.operationId}/${filename}`);
    }
  }
  return {images:images.length?images:undefined,text:[request.text,...refs].filter(Boolean).join('\n')};
}

async function perform(request:Mutation,sessionId:string,generation:string,assets:Asset[],observation:string,model:string|null) {
  let handedOff=false;
  try {await runProcessUpdateAdmission(async()=>{
    generationCurrent(generation);const {identity}=await target(request.agentId,sessionId,request.kind==='mobile.start'?request.operationId:undefined);
    const engine=getSessionEngine(),ctx=engine.getCurrentSessionContext(),metadata=getSessionMetadata(sessionId)!;
    if(ctx.sessionId!==sessionId||(!ctx.workspacePath||!workspacePathsEqual(ctx.workspacePath,identity.workspacePath))||imSnapshotObservation(metadata)!==observation)fail('REMOTE_SESSION_OWNER_CHANGED');
    const config=resolveWorkspaceConfig(identity.workspacePath,metadata);
    if(config.mcpServers){const changed=await engine.updateMcpServers(config.mcpServers);if(!changed.success)fail('REMOTE_RUNTIME_CONFIGURATION_FAILED')}
    const payload=await copyAssets(request,sessionId,identity.workspacePath,assets);
    const beforeDispatch=async()=>{
      generationCurrent(generation);await target(request.agentId,sessionId,request.kind==='mobile.start'?request.operationId:undefined);
      if(imSnapshotObservation(getSessionMetadata(sessionId)!)!==observation)return {accepted:false as const,error:'REMOTE_SESSION_OWNER_CHANGED'};
      if(request.kind==='mobile.start'){const claim=await claimPreparedSessionForTurnAdmission(sessionId,request.operationId,{title:metadata.title,lastMessagePreview:request.text.slice(0,200)});if(claim.status!=='claimed'&&claim.status!=='already-committed')return {accepted:false as const,error:'REMOTE_PREPARED_ADMISSION_FAILED'};}
      return {accepted:true as const};
    };
    handedOff=true;
    const admitted=await engine.sendDesktopMessage({...payload,clientRequestId:request.operationId,sessionId,workspacePath:identity.workspacePath,scenario:{type:'desktop'},turnBoundaryOnly:true,model:model??config.model,permissionMode:config.permissionMode,providerRoute:config.providerRoute&&config.providerRoute.kind!=='unknown-legacy'&&model?{...config.providerRoute,model}:config.providerRoute,providerEnv:config.providerEnv,reasoningEffort:config.reasoningEffort,beforeDispatch});
    if(!admitted.success||admitted.error)fail('REMOTE_SESSION_ADMISSION_REJECTED');
    if(request.kind==='mobile.send'&&admitted.queued&&admitted.queueId)void admitted.dispatchAcceptance?.catch(()=>{});
    else{const acceptance=await admitted.dispatchAcceptance;if(acceptance&&!acceptance.accepted)fail('REMOTE_SESSION_ADMISSION_REJECTED')}
    await receipts.finishMobile(request,'accepted',sessionId);
  })}catch(error){await receipts.finishMobile(request,handedOff&&!(error instanceof RemoteSessionError)?'unconfirmed':'rejected',sessionId,failure(error).data.code).catch(()=>{})}
}

export async function handleDesktopRemoteMobileSession(value:unknown,role:'global'|'session'|'standalone') {
  try {return await runProcessUpdateAdmission(async()=>{
    const {request,generation,preparedSessionId,assets=[]}=envelope.parse(value);generationCurrent(generation);
    const sessionId=request.kind==='mobile.start'?preparedSessionId:'sessionId' in request?request.sessionId:undefined;
    const {identity}=await target(request.agentId,sessionId,request.kind==='mobile.start'?request.operationId:undefined);
    if(request.kind!=='mobile.start'&&request.kind!=='mobile.send'&&(assets.length||preparedSessionId!==undefined))fail('REMOTE_MOBILE_ENVELOPE_INVALID');
    if(request.kind==='mobile.capabilities')return receiptResult({kind:'mobile.capabilities',version:1,agentId:request.agentId,attachments:true,modelSelection:true,nextSuggestions:true,maxAssets:8});
    if(request.kind==='mobile.models')return receiptResult({kind:'mobile.models',version:1,agentId:request.agentId,items:(await models(request.agentId)).items});
    if(request.kind==='mobile.receipt'){const receipt=await receipts.readMobile(request.agentId,request.operationId);if(receipt.status==='not-found')fail('REMOTE_OPERATION_NOT_FOUND');return receiptResult(receipt)}
    if(request.kind==='mobile.suggestions'){
      if(role==='global')fail('REMOTE_SESSION_OWNER_REQUIRED');
      const snapshot=await buildRemoteSnapshot(request.agentId,request.sessionId,generation,30);
      if(snapshot.revision!==request.revision)fail('REMOTE_MOBILE_REVISION_CHANGED');
      const anchor=snapshot.messages.at(-1);if(!anchor||anchor.role!=='assistant')fail('REMOTE_MOBILE_SUGGESTIONS_UNAVAILABLE');
      const suggestion=await suggestNextPrompt(getSessionEngine(),{sessionId:request.sessionId,anchorMessageId:anchor.id});
      if((await buildRemoteSnapshot(request.agentId,request.sessionId,generation,30)).revision!==request.revision)fail('REMOTE_MOBILE_REVISION_CHANGED');
      if(suggestion.availability!=='supported'||suggestion.suggestion&&suggestion.suggestion.length>512)fail('REMOTE_MOBILE_SUGGESTIONS_UNAVAILABLE');
      return receiptResult({kind:'mobile.suggestions',version:1,agentId:request.agentId,sessionId:request.sessionId,revision:request.revision,suggestions:suggestion.suggestion?[suggestion.suggestion]:[]});
    }
    if(role==='global'||!sessionId)fail('REMOTE_SESSION_OWNER_REQUIRED');
    if(request.kind==='mobile.send'&&preparedSessionId&&preparedSessionId!==sessionId)fail('REMOTE_SESSION_OWNER_CHANGED');
    const ctx=getSessionEngine().getCurrentSessionContext();if(ctx.sessionId!==sessionId||(!ctx.workspacePath||!workspacePathsEqual(ctx.workspacePath,identity.workspacePath)))fail('REMOTE_SESSION_OWNER_CHANGED');
    checkAssets(request,assets);
    const manifest=createHash('sha256').update(JSON.stringify(assets.map(({sourcePath:_,...asset})=>asset))).digest('hex');
    const prior=await receipts.readMobileIntent(request,manifest);
    if(prior.sessionId!==sessionId)fail('REMOTE_OPERATION_CONFLICT');
    if(prior.status==='accepted'||prior.status==='rejected'||prior.status==='unconfirmed')return receiptResult(prior);
    const admission=await receipts.mobileAdmission(request,sessionId);
    if(imSnapshotObservation(getSessionMetadata(sessionId)!)!==admission.observation)fail('REMOTE_SESSION_OWNER_CHANGED');
    // The birth's same-authority model was already frozen. Existing sends also
    // revalidate the chosen ID against this Session's current frozen authority.
    if(request.kind==='mobile.send'&&request.modelId!==undefined&&await selectedModel(request,getSessionMetadata(sessionId)!)!==admission.model)fail('REMOTE_MOBILE_MODEL_UNAVAILABLE');
    if(request.modelId===undefined&&admission.model!==(getSessionMetadata(sessionId)!.model??null))fail('REMOTE_SESSION_OWNER_CHANGED');
    const fresh=await receipts.adoptPrepared(request,sessionId,manifest);
    if(fresh){const job=perform(request,sessionId,generation,assets,admission.observation,admission.model).finally(()=>jobs.delete(job));jobs.add(job)}
    return receiptResult(await receipts.readMobile(request.agentId,request.operationId));
  })}catch(error){return failure(error)}
}
