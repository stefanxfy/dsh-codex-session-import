import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { createService } from './src/host.js';
export const name = 'codex-recent-import';
// Explicit Host service dependencies; shared API routes are registered below.
export const inject = ['connection','webServer','workspaceRegistry','sessionPersistence','llm','agentDefaultModel'];
export async function loadSessionModule(installDir = process.env.DSH_INSTALL_DIR) {
  const require = createRequire(import.meta.url);
  const paths = installDir ? [installDir,dirname(installDir)] : undefined;
  const resolved = require.resolve('@deepseek-ai/dsh-session',paths ? {paths} : undefined);
  return import(pathToFileURL(resolved).href);
}
export function createModelAdapter(ctx) {
  let pinned;
  const identity = route => JSON.stringify([route.provider,route.model,route.reasoningEffort ?? null]);
  return {
    modelKey() { pinned = ctx.agentDefaultModel.currentSelection(); return identity(pinned); },
    async generate(prompt,{signal}) {
      if (!pinned || identity(ctx.agentDefaultModel.currentSelection()) !== identity(pinned)) throw Object.assign(new Error('Model route changed; preview again'),{code:'ESTIMATE_CHANGED'});
      let text='', finished=false;
      for await (const chunk of ctx.llm.stream({...pinned,messages:[{role:'user',content:[{type:'text',text:prompt}]}],maxTokens:2400,signal})) {
        signal?.throwIfAborted();
        if (finished) throw new Error('Configured model emitted data after completion');
        if (chunk.type === 'text-delta') text += chunk.text;
        if (chunk.type === 'finish') {
          if (chunk.reason?.kind !== 'stop') throw new Error('Configured model did not complete summary normally');
          finished=true;
        }
        if (text.length > 8000) throw new Error('Summary output exceeded budget');
      }
      signal?.throwIfAborted();
      if (!finished) throw new Error('Configured model stream ended without completion');
      return text;
    }
  };
}
export function createRpcHandler(service) {
  const operation=createOperationHandler(service);
  return async (endpoint,payload,signal,peer) => {
    if (peer?.principal?.kind !== 'owner') return {ok:false,error:{code:'FORBIDDEN',message:'Owner access required',details:{status:403}}};
    return operation(endpoint,payload,signal);
  };
}
function createOperationHandler(service) {
  return async (endpoint,payload,signal) => {
    try {
      signal?.throwIfAborted();
      const request = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      let value;
      if (endpoint === 'sessions') value=await service.scan({...request,signal});
      else if (endpoint === 'resetPreviews') value=service.resetPreviews();
      else if (endpoint === 'preview') value=await service.preview({...request,signal});
      else if (endpoint === 'details') value=await service.details({...request,signal});
      else if (endpoint === 'jobs') value=await service.start(request);
      else if (endpoint === 'status') value=service.status(request.id);
      else if (endpoint === 'cancel') value=service.cancel(request.id);
      else return {ok:false,error:{code:'NOT_FOUND',message:'Unknown import endpoint',details:{status:400}}};
      return {ok:true,value:{ok:true,...value}};
    } catch(error) {
      const code = typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'IMPORT_FAILED';
      return {ok:false,error:{code,message:code === 'IMPORT_FAILED' ? 'Import operation failed; no history is logged' : error.message,details:{status:code === 'IMPORT_FAILED' ? 500 : 400}}};
    }
  };
}
// Connection owns /api authentication and rejects non-owner peers before exact routes.
// Exact routes avoid rpc.handle's webServer lookup in Connection's definition context.
export async function registerImportRoutes(connection,service) {
  const operation=createOperationHandler(service), releases=[];
  try {
    for (const endpoint of ['sessions','resetPreviews','preview','jobs','status','cancel','details']) {
      const method='codex-recent-import/'+endpoint;
      releases.push(connection.fetch.register({path:'/api/'+method,methods:['POST'],requestBody:'buffered',fetch:async request=>{
        if(request.method!=='POST') return new Response('method not allowed',{status:405});
        if(request.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase()!=='application/json') return new Response('application/json required',{status:415});
        let message;try{message=await request.json();}catch{return new Response('invalid JSON',{status:400});}
        if(!message || message.type!=='client-request' || typeof message.rpcId!=='string' || !message.rpcId || message.rpcId.length>256 || message.method!==method) return new Response('invalid RPC envelope',{status:400});
        const result=await operation(endpoint,message.payload,request.signal);
        return Response.json({type:'server-response',rpcId:message.rpcId,result});
      }}));
    }
  } catch(error) {for(const release of releases.reverse()) await release();throw error;}
  return async()=>{for(const release of releases.reverse())await release();};
}
export async function apply(ctx,config = {}) {
  const session=await loadSessionModule();
  if (session.SESSION_FORMAT_VERSION !== 4) throw new Error('This importer requires DSH session format v4');
  const adapter=createModelAdapter(ctx);
  const service=createService({workspaceRegistry:ctx.workspaceRegistry,persistence:ctx.sessionPersistence,Session:session.Session,SessionId:session.SessionId,version:session.SESSION_FORMAT_VERSION,projectionCache:ctx.get?.('sessionProjectionCache'),...adapter,cacheRoot:config.cacheRoot ?? join(homedir(),'.dsh','codex-recent-import')},config);
  const off=await registerImportRoutes(ctx.connection,service);
  ctx.on('dispose',async()=>{await off();await service.dispose();});
}
export default {name,inject,apply};
