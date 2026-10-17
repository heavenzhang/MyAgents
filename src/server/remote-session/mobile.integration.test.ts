import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({home:'',owner:undefined as unknown,metadata:new Map<string,Record<string,unknown>>(),registry:vi.fn(),config:vi.fn(),shown:vi.fn(),menu:vi.fn(),send:vi.fn(),ctx:vi.fn(),mcp:vi.fn(),claim:vi.fn(),suggest:vi.fn(),snapshot:vi.fn(),save:vi.fn(),ready:vi.fn(),materialize:vi.fn()}));
vi.mock('node:os',async original=>({...await original<typeof import('node:os')>(),homedir:()=>f.home}));
vi.mock('./desktop',()=>({resolveDesktopRemoteTarget:f.registry,desktopRemoteReceipts:new Proxy({}, {get:(_,key)=> (...args:unknown[])=>(f.owner as Record<string,(...args:unknown[])=>unknown>)[key as string](...args)})}));
vi.mock('../SessionStore',()=>({getSessionMetadata:(id:string)=>f.metadata.get(id),updateSessionMetadata:async(id:string,updates:Record<string,unknown>,guard:(current:Record<string,unknown>)=>boolean)=>{const current=f.metadata.get(id)!;if(!guard(current))return null;const updated={...current,...updates};f.metadata.set(id,updated);return updated},saveSessionMetadata:f.save,publishSessionForHandoff:async()=>true,claimPreparedSessionForTurnAdmission:f.claim,getAttachmentPath:(relative:string)=>join(f.home,'.myagents','attachments',relative)}));
vi.mock('../session-engine',()=>({runProcessUpdateAdmission:async(op:()=>unknown)=>op(),getSessionEngine:()=>({getCurrentSessionContext:f.ctx,sendDesktopMessage:f.send,updateMcpServers:f.mcp})}));
vi.mock('../admin-api',()=>({handleAgentShow:f.shown}));
vi.mock('../routes/im-model-selection',()=>({handleImModelRoute:f.menu,imSnapshotObservation:(meta:Record<string,unknown>)=>createHash('sha256').update(JSON.stringify([meta.configSnapshotAt,meta.runtime,meta.runtimeSource,meta.providerId,meta.model,meta.permissionMode])).digest('hex')}));
vi.mock('../session-prompt-suggestion',()=>({suggestNextPrompt:f.suggest}));
vi.mock('../utils/admin-config',()=>({resolveWorkspaceConfig:f.config}));
vi.mock('../utils/session-snapshot',()=>({snapshotForOwnedSession:()=>({runtime:'builtin',providerId:'alpha',model:'one',permissionMode:'plan',providerRoute:{kind:'provider',providerId:'alpha',model:'one'},configSnapshotAt:'baseline'})}));
vi.mock('../utils/session-materialization',()=>({createMaterializedSessionMetadata:f.materialize}));
vi.mock('../utils/managed-codex-readiness',()=>({isManagedCodexProviderReady:f.ready}));
vi.mock('./projection',()=>({buildRemoteSnapshot:f.snapshot}));
import {createRemoteReceiptOwner} from './receipts';
import {handleDesktopRemoteMobileSession as handle,prepareDesktopRemoteMobileSession as prepare} from './mobile';
let workspace:string;
const session=()=>({id:'session',agentDir:workspace,title:'Session',runtime:'builtin',providerId:'alpha',model:'one',permissionMode:'plan',configSnapshotAt:'frozen',transcriptFormat:2});
const request=(kind:'mobile.start'|'mobile.send'='mobile.send'):{kind:'mobile.start'|'mobile.send';version:1;agentId:string;operationId:string;text:string;assetIds:string[];sessionId?:string;modelId?:string}=>({kind,version:1 as const,agentId:'agent',operationId:randomUUID(),text:'中'.repeat(9000),assetIds:[] as string[],...(kind==='mobile.send'?{sessionId:'session'}:{})});
beforeEach(async()=>{
 vi.clearAllMocks();f.metadata.clear();f.home=await realpath(await mkdtemp(join(tmpdir(),'mobile-admission-')));workspace=join(f.home,'workspace');await mkdir(workspace,{mode:0o700});
 f.owner=createRemoteReceiptOwner('desktop',join(f.home,'receipts'));vi.stubEnv('MYAGENTS_SIDECAR_GENERATION','gen');
 f.metadata.set('session',session());f.registry.mockImplementation(async(_agent:string,id?:string,operation?:string)=>{const meta=id?f.metadata.get(id):undefined;if(id&&(!meta||meta.materializationState==='prepared'&&meta.materializationSourceSessionId!==operation))throw Object.assign(new Error('hidden'),{code:'REMOTE_SESSION_NOT_FOUND'});return {identity:{workspacePath:workspace,agent:{id:'agent',enabled:true,runtime:'builtin',model:'one',providerId:'alpha',permissionMode:'plan'}},config:{}}});
 f.shown.mockResolvedValue({success:true,data:{effectiveDefaults:{runtime:'builtin',providerId:'alpha',model:'one'}}});
 f.menu.mockImplementation(async()=>new Response(JSON.stringify({success:true,options:[...['one','two'].map(model=>({selection:{kind:'product-provider',providerId:'alpha',model},name:model,requiresNewSession:false})),{selection:{kind:'product-provider',providerId:'beta',model:'foreign'},name:'foreign',requiresNewSession:false}]}),{headers:{'content-type':'application/json'}}));
 f.materialize.mockImplementation(input=>({...session(),id:input.sessionId,model:input.agent.model}));f.save.mockImplementation(async meta=>{f.metadata.set(meta.id,meta)});
 f.config.mockReturnValue({model:'one',permissionMode:'plan',providerRoute:{kind:'provider',providerId:'alpha',model:'one'},providerEnv:{ANTHROPIC_AUTH_TOKEN:'synthetic-only'},mcpServers:[]});f.mcp.mockResolvedValue({success:true});
 f.ctx.mockReturnValue({sessionId:'session',workspacePath:workspace});f.send.mockResolvedValue({success:true,dispatchAcceptance:Promise.resolve({accepted:true})});f.claim.mockResolvedValue({status:'claimed'});f.ready.mockReturnValue(true);
 f.snapshot.mockResolvedValue({revision:'r1',messages:[{id:'assistant',role:'assistant'}]});f.suggest.mockResolvedValue({availability:'supported',suggestion:'继续检查'});
});
afterEach(async()=>{vi.unstubAllEnvs();await rm(f.home,{recursive:true,force:true})});
async function prepared(req:ReturnType<typeof request>){const result=await prepare({request:req});expect(result).toMatchObject({success:true});return (result as {data:{sessionId:string}}).data.sessionId}
async function status(req:ReturnType<typeof request>){return (f.owner as ReturnType<typeof createRemoteReceiptOwner>).readMobile(req.agentId,req.operationId)}
async function settled(req:ReturnType<typeof request>,expected='accepted'){await vi.waitFor(async()=>expect(await status(req)).toMatchObject({status:expected}))}
async function asset(bytes=Buffer.from('file bytes'),mimeType='text/plain'){
 const assetId=randomUUID(),root=join(f.home,'.myagents','remote-assets-v1'),scope='a'.repeat(64),upload=randomUUID();await mkdir(join(root,scope,upload),{recursive:true,mode:0o700});
 const sourcePath=join(root,scope,upload,'data');await writeFile(sourcePath,bytes,{mode:0o600});return {assetId,sourcePath,name:'附件.txt',mimeType,sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}
it('prepares hidden frozen birth, admits original 16000-bound text once and fences changed payload',async()=>{
 const req=request('mobile.start');req.modelId='two';const id=await prepared(req);expect(f.send).not.toHaveBeenCalled();expect(f.metadata.get(id)).toMatchObject({materializationState:'prepared',materializationSourceSessionId:req.operationId,model:'two',permissionMode:'plan'});
 f.ctx.mockReturnValue({sessionId:id,workspacePath:workspace});await handle({request:req,generation:'gen',preparedSessionId:id},'session');await settled(req);
 expect(f.send).toHaveBeenCalledTimes(1);expect(f.send).toHaveBeenCalledWith(expect.objectContaining({text:req.text,model:'two',clientRequestId:req.operationId,permissionMode:'plan'}));
 const guard=f.send.mock.calls[0][0].beforeDispatch;expect(await guard()).toEqual({accepted:true});expect(f.claim).toHaveBeenCalledWith(id,req.operationId,expect.anything());
 expect(await handle({request:req,generation:'gen',preparedSessionId:id},'session')).toMatchObject({data:{status:'accepted'}});expect(f.send).toHaveBeenCalledTimes(1);
 expect(await handle({request:{...req,text:'changed'},generation:'gen',preparedSessionId:id},'session')).toMatchObject({data:{kind:'mobile.error',code:'REMOTE_OPERATION_CONFLICT'}});
});
it('imports real verified files and images into original product paths without staging path text',async()=>{
 const doc=await asset(),image=await asset(Buffer.from([137,80,78,71,13,10,26,10,0]),'image/png');const req=request();req.text='';req.assetIds=[doc.assetId,image.assetId];await prepared(req);
 await handle({request:req,generation:'gen',assets:[doc,image]},'session');await settled(req);
 const sent=f.send.mock.calls[0][0];expect(sent.text).toMatch(/^@myagents_files\/remote-mobile\/session\//);expect(sent.text).not.toContain(f.home);expect(sent.text).not.toContain('remote-assets-v1');
 expect(await readFile(join(workspace,sent.text.slice(1)))).toEqual(Buffer.from('file bytes'));
 expect(sent.images).toEqual([expect.objectContaining({kind:'attachment_ref',id:image.assetId,name:image.name,sizeBytes:9})]);expect(await readFile(join(f.home,'.myagents','attachments',sent.images[0].relativePath))).toEqual(Buffer.from([137,80,78,71,13,10,26,10,0]));
 expect(await handle({request:req,generation:'gen',assets:[{...doc,sha256:'b'.repeat(64)},image]},'session')).toMatchObject({data:{code:'REMOTE_OPERATION_CONFLICT'}});expect(f.send).toHaveBeenCalledTimes(1);
});
it.each(['hash','size','mime','path','symlink','parent-symlink','order'] as const)('rejects %s before original dispatch',async failure=>{
 const file=await asset(),req=request();req.assetIds=[file.assetId];await prepared(req);
 if(failure==='hash')file.sha256='b'.repeat(64);
 if(failure==='size')file.sizeBytes++;
 if(failure==='mime')file.mimeType='image/png';
 if(failure==='path')file.sourcePath=join(f.home,'outside');
 if(failure==='symlink'){await rm(file.sourcePath);const other=join(f.home,'other');await writeFile(other,'file bytes');await symlink(other,file.sourcePath)}
 if(failure==='parent-symlink'){const parent=join(file.sourcePath,'..'),other=join(f.home,'redirect');await rm(parent,{recursive:true});await mkdir(other);await writeFile(join(other,'data'),'file bytes',{mode:0o600});await symlink(other,parent)}
 if(failure==='order')file.assetId=randomUUID();
 await handle({request:req,generation:'gen',assets:[file]},'session');
 if(failure!=='order')await settled(req,'rejected');expect(f.send).not.toHaveBeenCalled();
});
it('keeps unknown after possible dispatch and never dispatches a duplicate or global/generation bypass',async()=>{
 const req=request();await prepared(req);f.send.mockRejectedValue(new Error('transport ambiguous'));
 await handle({request:req,generation:'gen'},'session');await settled(req,'unconfirmed');
 expect(await handle({request:req,generation:'gen'},'session')).toMatchObject({data:{status:'unconfirmed'}});
 expect(await prepare({request:req})).toMatchObject({data:{receipt:{status:'unconfirmed'}}});expect(f.send).toHaveBeenCalledTimes(1);
 expect(await handle({request:req,generation:'old'},'session')).toMatchObject({data:{code:'REMOTE_SESSION_OWNER_CHANGED'}});
 expect(await handle({request:req,generation:'gen'},'global')).toMatchObject({data:{code:'REMOTE_SESSION_OWNER_REQUIRED'}});
});
it('uses same-authority menus and rejects Agent default/provider drift for an existing frozen Session',async()=>{
 const models=await handle({request:{kind:'mobile.models',version:1,agentId:'agent'},generation:'gen'},'global');expect(models).toMatchObject({data:{items:[{id:'one'},{id:'two'}]}});
 const req=request();req.modelId='foreign';expect(await prepare({request:req})).toMatchObject({data:{code:'REMOTE_MOBILE_MODEL_UNAVAILABLE'}});expect(f.send).not.toHaveBeenCalled();
 const good=request();good.modelId='two';await prepared(good);f.metadata.get('session')!.providerId='beta';
 expect(await handle({request:good,generation:'gen'},'session')).toMatchObject({data:{code:'REMOTE_SESSION_OWNER_CHANGED'}});expect(f.send).not.toHaveBeenCalled();
});
it('checks matching snapshot revisions before and after the original suggestion service',async()=>{
 const req={kind:'mobile.suggestions',version:1,agentId:'agent',sessionId:'session',revision:'r1'};
 expect(await handle({request:req,generation:'gen'},'session')).toMatchObject({data:{kind:'mobile.suggestions',revision:'r1',suggestions:['继续检查']}});expect(f.suggest).toHaveBeenCalledTimes(1);
 expect(await handle({request:{...req,revision:'old'},generation:'gen'},'session')).toMatchObject({data:{code:'REMOTE_MOBILE_REVISION_CHANGED'}});expect(f.suggest).toHaveBeenCalledTimes(1);
 f.snapshot.mockResolvedValueOnce({revision:'r1',messages:[{id:'a',role:'assistant'}]}).mockResolvedValueOnce({revision:'r2'});
 expect(await handle({request:req,generation:'gen'},'session')).toMatchObject({data:{code:'REMOTE_MOBILE_REVISION_CHANGED'}});
});

it('freezes legacy complete authority after durable begin and returns typed not-found instead of a nullable query receipt',async()=>{
 const metadata=f.metadata.get('session')!;delete metadata.configSnapshotAt;delete metadata.model;
 const req=request();await prepared(req);
 expect(f.metadata.get('session')).toMatchObject({configSnapshotAt:expect.any(String),model:'one',permissionMode:'plan',providerId:'alpha'});
 await handle({request:req,generation:'gen'},'session');await settled(req);
 expect(await handle({request:{kind:'mobile.receipt',version:1,agentId:'agent',operationId:randomUUID()},generation:'gen'},'global')).toMatchObject({success:false,code:'REMOTE_OPERATION_NOT_FOUND',data:{kind:'mobile.error'}});
});

it('rejects ambiguous legacy provider drift and oversized image metadata before copying or dispatch',async()=>{
 const meta=f.metadata.get('session')!;delete meta.configSnapshotAt;meta.providerId='previous-provider';
 expect(await prepare({request:request()})).toMatchObject({success:false,code:'REMOTE_MOBILE_SESSION_NOT_FROZEN'});expect(f.send).not.toHaveBeenCalled();
 f.metadata.set('session',session());const file=await asset();file.mimeType='image/png';file.sizeBytes=10*1024*1024+1;
 const req=request();req.assetIds=[file.assetId];await prepared(req);
 expect(await handle({request:req,generation:'gen',assets:[file]},'session')).toMatchObject({success:false,code:'REMOTE_MOBILE_ASSET_SIZE_LIMIT'});expect(f.send).not.toHaveBeenCalled();
});
it('only one concurrent adoption dispatches and a definitive engine refusal creates a terminal receipt',async()=>{
 const req=request();await prepared(req);f.send.mockResolvedValue({success:false,error:'refused'});
 await Promise.all([handle({request:req,generation:'gen'},'session'),handle({request:req,generation:'gen'},'session')]);await settled(req,'rejected');expect(f.send).toHaveBeenCalledTimes(1);
 expect(await handle({request:req,generation:'gen'},'session')).toMatchObject({data:{status:'rejected'}});expect(f.send).toHaveBeenCalledTimes(1);
});

it('streams UTF-8 verification across a 64KiB boundary and preserves the exact imported bytes',async()=>{
 const bytes=Buffer.concat([Buffer.alloc(65535,0x61),Buffer.from('中尾')]);
 const file=await asset(bytes),req=request();req.text='';req.assetIds=[file.assetId];await prepared(req);
 await handle({request:req,generation:'gen',assets:[file]},'session');await settled(req);
 const reference=f.send.mock.calls[0][0].text as string;
 expect(await readFile(join(workspace,reference.slice(1)))).toEqual(bytes);
});
it.each(['invalid-utf8','nul'] as const)('rejects %s beyond the first block before copying any product file',async invalid=>{
 const first=await asset(Buffer.from('valid first asset'));
 const bytes=Buffer.concat([Buffer.alloc(65535,0x61),invalid==='nul'?Buffer.from([0]):Buffer.from([0xe4,0x80])]);
 const second=await asset(bytes),req=request();req.assetIds=[first.assetId,second.assetId];await prepared(req);
 await handle({request:req,generation:'gen',assets:[first,second]},'session');await settled(req,'rejected');
 expect(f.send).not.toHaveBeenCalled();
 await expect(readFile(join(workspace,'myagents_files','remote-mobile','session',req.operationId,first.assetId+'.txt'))).rejects.toMatchObject({code:'ENOENT'});
});
