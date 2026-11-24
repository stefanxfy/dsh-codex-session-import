import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {registerImportRoutes} from '../index.js';
const base='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai';
const source=await readFile(new URL('../client.js',import.meta.url),'utf8');
const box={AbortController,setTimeout,clearTimeout};
vm.runInNewContext(source.replace("if (typeof window === 'undefined'","globalThis.testing={createRequest}; if (typeof window === 'undefined'"),box);
let sdk;try{sdk={...await import(pathToFileURL(base+'/cordis/lib/index.js').href),...await import(pathToFileURL(base+'/dsh-client-connection/lib/index.js').href),...await import(pathToFileURL(base+'/dsh-client-connection/lib/client.node.js').href)};}catch(error){if(process.versions.electron)throw error;}
async function fixture(t){
 const ctx=new sdk.Context();let connection,calls=0,done,fail;const ready=new Promise((r,j)=>{done=r;fail=j;});
 // Actual Connection provider does not inject webServer; root/same-provider mocks hid the bug.
 ctx.plugin({name:'connection-provider-without-webServer',apply(p){connection=new sdk.HostConnectionService(p,[],{});}});
 const service={details:async()=>{calls++;return {detail:{records:[{index:0,text:'synthetic readonly detail',truncated:false}],offset:0,total:1,nextOffset:null}};},scan:async()=>{calls++;return {sessions:[{id:'source',title:'Synthetic'}],workspaces:[{cwd:'/source'}],targets:[{id:'target',title:'Synthetic target'}]};},resetPreviews:()=>({batchId:'batch'}),preview:async()=>({previewId:'preview'}),start:async()=>({id:'job'}),status:()=>({status:'completed'}),cancel:()=>({})};
 ctx.plugin({name:'import-routes',inject:['connection'],async apply(p){try{await registerImportRoutes(p.connection,service);done();}catch(error){fail(error);throw error;}}});
 let timer;try{await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('route registration did not finish')),2000);})]);}finally{clearTimeout(timer);}
 t.after(()=>ctx.fiber.dispose());
 // Occupied Gateway interceptor remains installed: exact routes must coexist with it.
 connection.rpc.intercept('/api',()=>true,async()=>({ok:true,value:'unrelated gateway'}));
 const shared=connection.createSharedFetchHandler('/api');const paths=[];
 const clientCtx=new sdk.Context();t.after(()=>clientCtx.fiber.dispose());
 sdk.installConnection(clientCtx,{interactions:'none',transport:{fetch:async(input,init)=>{const url=new URL(input,'http://in-memory.invalid/');paths.push(url.pathname);return shared.fetch(new Request(url,init),connection.browserPeer);}}});
 return {request:box.testing.createRequest(clientCtx.connection),shared,connection,paths,calls:()=>calls};
}
test('official client serializer and Host exact API route load nonempty source/target lists',{skip:!sdk},async t=>{
 const f=await fixture(t);const result=await f.request('sessions',{});assert.equal(result.sessions[0].id,'source');assert.equal(result.targets[0].id,'target');assert.deepEqual(f.paths,['/api/codex-recent-import/sessions']);assert.equal(f.calls(),1);
 const other=await f.shared.fetch(new Request('http://in-memory.invalid/api/other',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'other',method:'other',payload:{}})}),f.connection.browserPeer);assert.equal((await other.json()).result.value,'unrelated gateway');
});
test('official shared API rejects a non-owner before import handler runs',{skip:!sdk},async t=>{
 const f=await fixture(t);const response=await f.shared.fetch(new Request('http://in-memory.invalid/api/codex-recent-import/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'non-owner',method:'codex-recent-import/sessions',payload:{}})}),{principal:{kind:'agent'}});assert.equal(response.status,403);assert.equal(f.calls(),0);
});
test('malformed RPC envelope and aborted request cannot execute import operations',{skip:!sdk},async t=>{
 const f=await fixture(t);const response=await f.shared.fetch(new Request('http://in-memory.invalid/api/codex-recent-import/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'wrong',method:'codex-recent-import/jobs',payload:{}})}),f.connection.browserPeer);assert.equal(response.status,400);assert.equal(f.calls(),0);
 const abort=new AbortController();abort.abort();await assert.rejects(f.request('sessions',{},abort.signal));assert.equal(f.calls(),0);
});
test('official serializer roundtrips owner-only readonly details without bypassing authorization',{skip:!sdk},async t=>{
 const f=await fixture(t);const denied=await f.shared.fetch(new Request('http://in-memory.invalid/api/codex-recent-import/details',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'details-non-owner',method:'codex-recent-import/details',payload:{previewId:'synthetic'}})}),{principal:{kind:'agent'}});assert.equal(denied.status,403);assert.equal(f.calls(),0);const result=await f.request('details',{previewId:'synthetic'});assert.equal(result.detail.records[0].text,'synthetic readonly detail');assert.equal(f.calls(),1);
});
