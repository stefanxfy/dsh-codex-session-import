import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../client.js',import.meta.url),'utf8');
test('manual native-directory refresh button is absent in normal, loading and failure states',async()=>{let release,fail=false;const f=fixture({hooks:{refreshDirectory:async()=>{if(fail)throw Error('synthetic offline');await new Promise(resolve=>{release=resolve;});}}});const check=()=>assert.equal(flatten(panel(f.c)).filter(n=>n.type==='button').some(n=>n.children.some(text=>typeof text==='string'&&/刷新 DSH 会话列表|重试刷新会话列表/.test(text))),false);await f.c.scan();check();const pending=f.c.refreshDirectory();assert.equal(f.c.get().directoryBusy,true);check();release();await pending;fail=true;await f.c.refreshDirectory();assert.match(f.c.get().directoryError,/重新打开导入页面/);check();assert.equal(f.calls.some(call=>call.endpoint==='jobs'),false);f.c.dispose();});
const box={AbortController,setTimeout,clearTimeout};
vm.runInNewContext(source.replace("if (typeof window === 'undefined'","globalThis.make=createController; if (typeof window === 'undefined'"),box);
const plain=value=>JSON.parse(JSON.stringify(value));
const capabilities={presentations:['audit','readable'],adaptationVersion:'readable-v2',details:true};
const targets=[{id:'A',title:'工作区甲',path:'/synthetic/workspace-A'},{id:'B',title:'工作区乙',path:'/synthetic/workspace-B'}];
function fixture({scan={},status='completed',hooks={}}={}) {
  const calls=[],snapshots=[];
  const c=box.make(async(endpoint,payload)=>{
    calls.push({endpoint,payload:plain(payload)});
    if(endpoint==='sessions')return {capabilities,targets,sessions:[{id:'source',title:'Source'}],...scan};
    if(endpoint==='resetPreviews')return {batchId:'b'};
    if(endpoint==='preview')return {previewId:'p',source:{title:'Source'}};
    if(endpoint==='jobs')return {id:'job',status:'queued'};
    if(endpoint==='status')return {id:'job',status,items:[{sessionId:'source',status,importedId:'native-session'}]};
    return {};
  },undefined,hooks);
  c.subscribe(()=>snapshots.push(plain(c.get())));
  return {c,calls,snapshots};
}
function panel(c) {
  let plugin;const registered=[];
  const React={createElement:(type,props,...children)=>({type,props:props||{},children}),Fragment:'fragment',useSyncExternalStore:(sub,get)=>get(),useEffect:()=>{}};
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load:p=>{plugin=p;}}},AbortController,setTimeout,clearTimeout});
  plugin.factory(()=>React).apply({connection:{},effect:()=>{},slots:{inject:(name,fn)=>fn(),register:(config,component)=>registered.push({config,component})}});
  return registered.find(r=>r.config.name==='main').component({controller:c});
}
const flatten=n=>n&&typeof n==='object'?[n,...(n.children||[]).flat(Infinity).flatMap(flatten)]:[];
const json=c=>JSON.stringify(panel(c));
function noHistory(f) {
  for(const state of [f.c.get(),...f.snapshots]) {
    assert.equal(Object.hasOwn(state,'imports'),false);
    assert.equal(Object.hasOwn(state,'inspectedImport'),false);
    for(const key of ['sourceTitles','targetWorkspaceTitle','targetWorkspacePath'])assert.equal(Object.hasOwn(state.job || {},key),false);
  }
  assert.equal(flatten(panel(f.c)).some(n=>n.props['aria-label']==='已导入会话列表'),false);
  assert.doesNotMatch(json(f.c),/已导入会话 ·|暂无导入记录|曾导入|选择已导入记录|查看已导入历史详情/);
}
async function ready(f) {
  await f.c.scan();f.c.open();await f.c.refreshDirectory();
  f.c.select('source');f.c.set('target','A');await f.c.preview();
}

test('old backend history is neither rendered nor recorded across scans',async()=>{
  const f=fixture({scan:{imports:[{id:'legacy',title:'<script>legacy-history-only</script>',targetWorkspaceId:'A',targetWorkspacePath:'/synthetic/legacy-only'}]}});
  noHistory(f);await f.c.scan();noHistory(f);await f.c.scan();noHistory(f);
  assert.doesNotMatch(JSON.stringify(f.c.get()),/legacy-history-only|legacy-only/);
  assert.doesNotMatch(json(f.c),/legacy-history-only|legacy-only/);
  assert.deepEqual(f.calls.map(call=>call.endpoint),['sessions','sessions']);f.c.dispose();
});

test('scan does not even read legacy imports and works with new backend omitting history',async()=>{
  let reads=0;
  const c=box.make(async()=>({capabilities,targets,sessions:[],get imports(){reads++;throw Error('history must not be consumed');}}));
  await c.scan();assert.equal(reads,0);assert.equal(c.get().error,'');assert.equal(Object.hasOwn(c.get(),'imports'),false);c.dispose();
  const f=fixture();await f.c.scan();noHistory(f);assert.equal(f.c.get().sessions.length,1);f.c.dispose();
});

test('legacy imported marker is ignored without hiding or renaming same-title source conversations',async()=>{
  const title='同名真实用户对话';
  const f=fixture({scan:{sessions:[{id:'old-source',title,imported:true},{id:'new-source',title,imported:false}]}});
  await f.c.scan();noHistory(f);
  assert.deepEqual(plain(f.c.visible()).map(row=>[row.id,row.title]),[['old-source',title],['new-source',title]]);
  assert.equal(f.c.get().sessions.some(row=>Object.hasOwn(row,'imported')),false);
  const rows=flatten(panel(f.c)).filter(n=>n.type==='input'&&n.props.type==='checkbox');
  assert.equal(rows.length,2);rows[0].props.onChange();rows[1].props.onChange();
  assert.deepEqual(plain(f.c.get().selected),['old-source','new-source']);
  assert.equal(f.calls.some(call=>call.endpoint==='jobs'),false);f.c.dispose();
});

for(const status of ['completed','skipped'])test(status+' job keeps batch progress and refreshes native directory, never creates history',async()=>{
  const refreshed=[];const f=fixture({status,hooks:{refreshDirectory:async ids=>refreshed.push(plain(ids))}});
  await ready(f);refreshed.length=0;await f.c.start();noHistory(f);
  assert.equal(f.c.get().job.status,status);assert.equal(f.c.get().busy,false);
  assert.deepEqual(refreshed,[['native-session']]);
  const progress=flatten(panel(f.c)).find(n=>n.props['aria-label']==='导入进度');
  assert.ok(progress);assert.ok(JSON.stringify(progress).includes('批次进度 · 1/1'));
  assert.match(JSON.stringify(progress),status==='completed'?/已完成/:/重复，已跳过/);
  assert.equal(f.calls.filter(call=>call.endpoint==='sessions').length,1);
  assert.deepEqual(f.calls.find(call=>call.endpoint==='jobs').payload,{previewIds:['p'],targetWorkspaceId:'A'});
  await f.c.refreshProgress();assert.equal(refreshed.length,1);noHistory(f);
  f.c.set('target','B');assert.equal(f.c.get().target,'B');noHistory(f);
  assert.equal(Object.hasOwn(f.c.get().job,'targetWorkspaceId'),false);
  await f.c.scan();noHistory(f);
  assert.equal(f.calls.filter(call=>call.endpoint==='jobs').length,1);f.c.dispose();
});

test('directory success banner stays hidden and refresh failure remains visible without history',async()=>{
  let fail=false;const f=fixture({hooks:{refreshDirectory:async()=>{if(fail)throw Error('synthetic offline');}}});
  await f.c.scan();await f.c.refreshDirectory();assert.match(f.c.get().directoryStatus,/已请求更新/);
  assert.doesNotMatch(json(f.c),/已请求更新 DSH 原生会话目录|请查看目标工作区/);noHistory(f);
  fail=true;await f.c.refreshDirectory();assert.match(json(f.c),/目录刷新失败/);noHistory(f);
  assert.equal(f.calls.some(call=>call.endpoint==='jobs'||call.endpoint==='details'),false);f.c.dispose();
});
