import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import vm from 'node:vm';
import {createService} from '../src/host.js';
const client=await readFile(new URL('../client.js',import.meta.url),'utf8');
const box={AbortController,setTimeout,clearTimeout};
vm.runInNewContext(client.replace("if (typeof window === 'undefined'","globalThis.testing={createController,createRequest}; if (typeof window === 'undefined'"),box);
async function setup(t){
 const home=await mkdtemp(join(tmpdir(),'dsh-codex-integration-')); assert.ok(home.startsWith(join(tmpdir(),'dsh-codex-integration-')));
 t.after(()=>rm(home,{recursive:true,force:true}));const root=join(home,'.codex','sessions');await mkdir(root,{recursive:true});
 const records=[{type:'session_meta',payload:{id:'synthetic-integration',cwd:'/synthetic/source',title:'Synthetic only'}}];
 for(let n=1;n<=4;n++){records.push({type:'response_item',timestamp:'2026-01-01T00:00:00Z',payload:{type:'message',role:'user',content:[{type:'input_text',text:'user '+n}]}});records.push({type:'response_item',payload:{type:'function_call',call_id:'call-'+n,name:'bash',arguments:'{"command":"DO_NOT_EXECUTE_HISTORICAL_TEXT"}'}});records.push({type:'response_item',payload:{type:'function_call_output',call_id:'call-'+n,output:'historical output '+n}});records.push({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'answer '+n}]}});}
 await writeFile(join(root,'fixture.jsonl'),records.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const writes=[],attached=[];let models=0;const workspace={id:'target',title:'Target',path:home,attachSession:async id=>{attached.push(id);}};
 const deps={home,env:{},cacheRoot:join(home,'private-cache'),workspaceRegistry:{list:()=>[workspace],get:id=>id==='target'?workspace:undefined},Session:{create:(id,events,header)=>{assert.equal(header.version,4);assert.equal(header.cwd,home);assert.equal(events.filter(e=>e.type==='turn/start').length,2);}},version:4,modelKey:'synthetic/fake',generate:async()=>{models++;return 'Offline fake summary; no actual model.';},persistence:{create:async header=>{const stored={header,events:null,flushed:false,closed:false};writes.push(stored);return {append:async events=>{stored.events=events;},flush:async()=>{stored.flushed=true;},close:async()=>{stored.closed=true;}};}}};
 const service=createService(deps);t.after(()=>service.dispose());return {service,writes,attached,models:()=>models};
}
async function settle(service,id){for(let n=0;n<100;n++){const j=service.status(id);if(j.status==='completed'||j.status==='cancelled')return j;await tick();}assert.fail('Synthetic job did not settle');}
test('real parser → host summary consent → client RPC → cold write, without live tools',async t=>{
 const f=await setup(t);const routes={resetPreviews:()=>f.service.resetPreviews(),sessions:p=>f.service.scan(p),preview:p=>f.service.preview(p),jobs:p=>f.service.start(p),status:p=>f.service.status(p.id),cancel:p=>f.service.cancel(p.id)};
 const request=box.testing.createRequest({rpc:{call:async(channel,endpoint,payload,signal)=>{assert.equal(channel,'/api');assert.ok(endpoint.startsWith('codex-recent-import/'));return {ok:true,value:await routes[endpoint.slice('codex-recent-import/'.length)]({...payload,signal})};}}});
 const c=box.testing.createController(request,{setTimeout:()=>1,clearTimeout:()=>{}});t.after(()=>c.dispose());
 await c.scan();c.open();assert.equal(c.get().sessions.length,1);assert.equal(f.models(),0);c.select(c.get().sessions[0].id);c.set('target','target');c.set('options',{keepTurns:2,presentation:'audit'});await c.preview();assert.equal(f.models(),0);assert.equal(f.writes.length,0);assert.equal(c.canStart(),false);assert.equal(c.get().previews[0].needsSummaryConfirmation,true);assert.equal(c.get().previews[0].stats.olderTurns,2);
 await c.confirmSummary();assert.equal(f.models(),1);assert.equal(c.canStart(),true);assert.equal(f.writes.length,0);await c.start();await settle(f.service,c.get().job.id);await c.refreshProgress();assert.equal(c.get().busy,false);assert.equal(c.get().job.items[0].status,'completed');assert.equal(f.writes.length,1);assert.equal(f.attached.length,1);assert.equal(f.writes[0].flushed,true);assert.equal(f.writes[0].closed,true);assert.match(JSON.stringify(f.writes[0].events),/DO_NOT_EXECUTE_HISTORICAL_TEXT/);assert.match(JSON.stringify(f.writes[0].events),/Offline fake summary/);assert.equal(f.writes[0].events.filter(e=>e.type==='tool\/call').length,2);
});
test('truncate real parser uses zero model calls and duplicate final preview is skipped',async t=>{
 const f=await setup(t);const scan=await f.service.scan();const p=await f.service.preview({sessionId:scan.sessions[0].id,options:{keepTurns:2,historyMode:'truncate'}});assert.ok(p.previewId);assert.equal(p.stats.keptTurns,2);assert.equal(p.summary,'');assert.equal(f.models(),0);const one=await f.service.start({previewIds:[p.previewId],targetWorkspaceId:'target'});assert.equal((await settle(f.service,one.id)).items[0].status,'completed');const two=await f.service.start({previewIds:[p.previewId],targetWorkspaceId:'target'});assert.equal((await settle(f.service,two.id)).items[0].status,'skipped');assert.equal(f.writes.length,1);assert.equal(f.models(),0);
});
