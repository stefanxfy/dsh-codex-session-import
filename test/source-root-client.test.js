import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../client.js',import.meta.url),'utf8');
const box={AbortController,setTimeout,clearTimeout};
vm.runInNewContext(source.replace("if (typeof window === 'undefined'","globalThis.testing={createController}; if (typeof window === 'undefined'"),box);
const plain=value=>JSON.parse(JSON.stringify(value));
const capabilities={sourceRoot:true,presentations:['audit','readable'],adaptationVersion:'readable-v2',details:true};
const discovery={found:true,path:'/automatic/.codex',source:'environment'};
const scan={capabilities,sourceDiscovery:discovery,sessions:[{id:'a',title:'Source',cwd:'/project'}],workspaces:[{path:'/project',count:1}],targets:[{id:'target'}]};
function fixture(handlers={}) {
  const calls=[];
  const c=box.testing.createController(async(endpoint,payload,signal)=>{
    calls.push({endpoint,payload:plain(payload),signal});
    if(handlers[endpoint])return handlers[endpoint](payload,signal);
    if(endpoint==='sessions')return {...scan,sourceDiscovery:payload.codexHome ? {found:true,path:payload.codexHome,source:'manual'} : discovery};
    if(endpoint==='resetPreviews')return {batchId:'batch'};
    if(endpoint==='preview')return {previewId:'p'};
    if(endpoint==='details')return {detail:{records:[],offset:0,nextOffset:null}};
    throw Error('Unexpected endpoint: '+endpoint);
  });
  return {c,calls};
}
function panel(c) {
  let plugin;const registered=[];
  const React={createElement:(type,props,...children)=>({type,props:props||{},children}),Fragment:'fragment',useSyncExternalStore:(sub,get)=>get(),useEffect:()=>{}};
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load:p=>{plugin=p;}}},AbortController,setTimeout,clearTimeout});
  plugin.factory(()=>React).apply({connection:{},effect:()=>{},slots:{inject:(name,fn)=>fn(),register:(config,component)=>registered.push({config,component})}});
  return registered.find(r=>r.config.name==='main').component({controller:c});
}
const flatten=n=>n&&typeof n==='object'?[n,...(n.children||[]).flat(Infinity).flatMap(flatten)]:[];
const text=c=>flatten(panel(c)).flatMap(n=>n.children.filter(x=>typeof x==='string')).join(' ');
async function ready(f) {await f.c.scan();f.c.select('a');f.c.set('target','target');await f.c.preview();}

test('missing target shows linked field and footer guidance, then clears only on valid selection',async()=>{const f=fixture();await f.c.scan();const nodes=()=>flatten(panel(f.c));const field=()=>nodes().find(n=>n.type==='select'&&n.props['aria-describedby']==='cri-target-required');assert.equal(field().props['aria-invalid'],true);assert.match(text(f.c),/请先选择目标工作区/);assert.match(JSON.stringify(nodes().find(n=>n.type==='footer')),/请先选择目标工作区/);f.c.select('a');await f.c.preview();assert.equal(f.c.canStart(),false);assert.match(text(f.c),/选择后请重新预览/);f.c.set('target','target');assert.equal(f.c.get().previews.length,0);assert.doesNotMatch(text(f.c),/请先选择目标工作区/);assert.equal(nodes().some(n=>n.props.id==='cri-target-required'),false);await f.c.preview();assert.equal(f.c.canStart(),true);f.c.set('target','');assert.equal(f.c.canStart(),false);assert.match(text(f.c),/请先选择目标工作区/);assert.equal(f.calls.some(c=>c.endpoint==='jobs'),false);f.c.dispose();});

test('missing workspace options explain creation rather than offering an impossible selection',async()=>{const f=fixture({sessions:async()=>({...scan,targets:[],sourceDiscovery:discovery})});await f.c.scan();const nodes=flatten(panel(f.c));assert.ok(nodes.some(n=>n.props.id==='cri-target-required'&&n.children.includes('暂无目标工作区，请先在 DSH 中创建或打开工作区后刷新。')));assert.match(JSON.stringify(nodes.find(n=>n.type==='footer')),/暂无目标工作区/);assert.equal(f.c.canStart(),false);assert.equal(f.calls.some(c=>c.endpoint==='jobs'),false);f.c.dispose();});

test('single scan button refreshes current source or explicitly applies a pending directory',async()=>{const f=fixture();await f.c.scan();f.c.select('a');f.c.set('query','Source');f.c.set('source','/project');const buttons=()=>flatten(panel(f.c)).filter(n=>n.type==='button'&&n.children.some(x=>x==='刷新会话列表'||x==='应用目录并扫描'));assert.equal(buttons().length,1);assert.ok(buttons()[0].children.includes('刷新会话列表'));assert.doesNotMatch(text(f.c),/使用此目录重新扫描|刷新来源|包含已归档/);const pending=buttons()[0].props.onClick();assert.equal(buttons()[0].props.disabled,true);await pending;assert.equal(f.c.get().query,'Source');assert.equal(f.c.get().source,'/project');assert.deepEqual(plain(f.c.get().selected),['a']);f.c.set('codexHome','/new/.codex');assert.equal(buttons().length,1);assert.ok(buttons()[0].children.includes('应用目录并扫描'));await buttons()[0].props.onClick();assert.equal(f.calls.at(-1).payload.codexHome,'/new/.codex');assert.equal(f.c.get().query,'');assert.equal(f.c.get().source,'');assert.deepEqual(plain(f.c.get().selected),[]);assert.ok(buttons()[0].children.includes('刷新会话列表'));assert.equal(f.calls.some(x=>x.endpoint==='jobs'),false);f.c.dispose();});

test('first automatic scan omits codexHome and displays actual environment/default discovery',async()=>{
  for(const origin of ['environment','default']) {
    const f=fixture({sessions:async()=>({...scan,sourceDiscovery:{...discovery,source:origin}})});
    assert.equal(f.c.get().codexHome,'');await f.c.scan();
    assert.deepEqual(f.calls[0].payload,{includeArchived:false,includeSubagents:false});
    assert.deepEqual(plain(f.c.get().sourceDiscovery),{...discovery,source:origin});
    assert.equal(f.c.get().codexHome,'/automatic/.codex');assert.equal(f.c.get().activeCodexHome,'');assert.equal(f.c.get().sourceDirty,false);assert.ok(flatten(panel(f.c)).some(n=>n.type==='input'&&n.props.type==='text'&&n.props.value==='/automatic/.codex'));assert.ok(!text(f.c).includes('实际 CODEX_HOME：'));const status=flatten(panel(f.c)).find(n=>n.props.role==='status'&&n.children.some(c=>typeof c==='string'&&c.includes('发现方式：')));assert.equal(status.props.className,'cri-muted');
    assert.ok(text(f.c).includes(origin==='default'?'默认目录':'环境变量 CODEX_HOME'));
    assert.deepEqual(f.calls.map(x=>x.endpoint),['sessions']);f.c.dispose();
  }
});

test('prefilled automatic root refreshes without pinning manual selection and does not overwrite draft',async()=>{let n=0;const f=fixture({sessions:async()=>({...scan,sourceDiscovery:{found:true,path:'/automatic-'+(++n)+'/.codex',source:'default'}})});await f.c.scan();assert.equal(f.c.get().codexHome,'/automatic-1/.codex');await f.c.scan();assert.equal(f.calls.at(-1).payload.codexHome,undefined);assert.equal(f.c.get().codexHome,'/automatic-2/.codex');assert.equal(f.c.get().sourceDirty,false);f.c.set('codexHome','/unapplied');await f.c.scan();assert.equal(f.c.get().codexHome,'/unapplied');assert.equal(f.c.get().sourceDirty,true);assert.equal(f.calls.at(-1).payload.codexHome,undefined);assert.equal(f.calls.some(c=>c.endpoint==='jobs'),false);f.c.dispose();});

test('not found explains failure and exposes optional CODEX_HOME input and UNC as literal text',async()=>{
  const f=fixture({sessions:async()=>({...scan,sessions:[],sourceDiscovery:{found:false,path:'/missing',source:'default',message:'No directory exists'}})});
  await f.c.scan();const tree=panel(f.c),nodes=flatten(tree),rendered=text(f.c);
  assert.match(rendered,/未找到可读取的 Codex 来源目录/);assert.match(rendered,/No directory exists/);
  assert.ok(nodes.some(n=>n.type==='input'&&n.props.type==='text'&&n.props.value===''));
  assert.ok(rendered.includes(String.raw`\\wsl.localhost\Ubuntu\home\用户名\.codex`));
  assert.match(rendered,/不执行 WSL 启动命令/);assert.match(rendered,/DSH 在 WSL 内运行，请填 Linux 路径/);
  assert.match(rendered,/未作 Windows 实机验证/);assert.equal(f.c.canStart(),false);f.c.dispose();
});

test('manual root is trimmed only on explicit button and later refreshes keep applied root not draft',async()=>{
  const f=fixture({sessions:async p=>({...scan,sourceDiscovery:p.codexHome?{found:true,path:p.codexHome,source:'manual'}:discovery})});
  await f.c.scan();const before=f.calls.length;const root=String.raw`\\wsl.localhost\Ubuntu\home\用户名\.codex`;
  const input=flatten(panel(f.c)).find(n=>n.type==='input'&&n.props.type==='text');
  input.props.onChange({target:{value:'  '+root+'  '}});assert.equal(f.calls.length,before);
  const button=flatten(panel(f.c)).find(n=>n.type==='button'&&n.children.includes('应用目录并扫描'));
  await button.props.onClick();
  assert.deepEqual(f.calls.at(-1).payload,{includeArchived:false,includeSubagents:false,codexHome:root});
  assert.match(text(f.c),/手动指定/);
  f.c.set('codexHome','/draft');await f.c.scan();assert.equal(f.calls.at(-1).payload.codexHome,root);
  assert.equal(f.c.get().sourceDirty,true);f.c.dispose();
});

test('clearing manual selection sends empty codexHome to resume automatic discovery',async()=>{
  const f=fixture();await f.c.scan();f.c.set('codexHome','/manual');await f.c.rescanSource();
  f.c.set('codexHome','  ');await f.c.rescanSource();
  assert.equal(f.calls.at(-1).payload.codexHome,'');assert.equal(f.c.get().sourceDirty,false);
  await f.c.scan();assert.equal(f.calls.at(-1).payload.codexHome,'');f.c.dispose();
});

test('old backend allows empty automatic scan but rejects manual button with zero requests',async()=>{
  for(const sourceRoot of [undefined,false,'true']) {
    const f=fixture({sessions:async()=>({...scan,capabilities:{...capabilities,sourceRoot}})});
    await f.c.scan();assert.equal(f.c.get().sourceDiscovery,null);assert.match(text(f.c),/后台未支持来源选择/);
    assert.ok(!text(f.c).includes('实际 CODEX_HOME：'));assert.equal(f.c.get().codexHome,'');
    await f.c.scan();assert.equal(f.calls.length,2);
    for(const value of ['/manual','']){f.c.set('codexHome',value);const count=f.calls.length;await f.c.rescanSource();
      assert.equal(f.calls.length,count);assert.match(f.c.get().error,/重启DSH/);}
    f.c.dispose();
  }
});

test('editing root immediately invalidates preview/detail and switch clears source query selection',async()=>{
  const f=fixture();await ready(f);await f.c.inspectDetails({previewId:'p'});assert.equal(f.c.canStart(),true);
  f.c.set('source','/project');f.c.set('query','Source');await f.c.preview();
  const before=f.calls.length;f.c.set('codexHome','/new-root');
  assert.equal(f.c.get().previews.length,0);assert.equal(f.c.get().batchId,null);assert.equal(f.c.get().detail,null);
  assert.equal(f.c.get().detailRef,null);assert.equal(f.c.canStart(),false);
  await f.c.start();await f.c.preview();await f.c.confirmSummary();assert.equal(f.calls.length,before);
  await f.c.rescanSource();assert.equal(f.c.get().source,'');assert.equal(f.c.get().query,'');
  assert.deepEqual(plain(f.c.get().selected),[]);assert.equal(f.c.get().sourceDirty,false);f.c.dispose();
});

test('busy root scan prohibits editing or another scan and discards old pending detail',async()=>{
  let resolveScan,resolveDetail;let first=true;
  const f=fixture({sessions:async()=>{if(first){first=false;return scan;}return new Promise(r=>{resolveScan=r;});},details:()=>new Promise(r=>{resolveDetail=r;})});
  await f.c.scan();const details=f.c.inspectDetails({previewId:'p'});
  f.c.set('codexHome','/new');const pending=f.c.rescanSource();const count=f.calls.length;
  f.c.set('codexHome','/ignored');await f.c.rescanSource();await f.c.scan();
  assert.equal(f.calls.length,count);assert.equal(f.c.get().codexHome,'/new');
  assert.equal(f.calls.find(x=>x.endpoint==='details').signal.aborted,true);
  resolveDetail({detail:{records:[]}});await details;assert.equal(f.c.get().detail,null);
  resolveScan({...scan,sourceDiscovery:{found:true,path:'/new',source:'manual'}});await pending;assert.equal(f.c.get().busy,false);f.c.dispose();
});

test('automatic discovery changing actual directory also clears filters and selections',async()=>{
  let path='/first';const f=fixture({sessions:async()=>({...scan,sourceDiscovery:{...discovery,path}})});
  await f.c.scan();f.c.select('a');f.c.set('source','/project');f.c.set('query','Source');
  path='/second';await f.c.scan();assert.equal(f.c.get().source,'');assert.equal(f.c.get().query,'');
  assert.deepEqual(plain(f.c.get().selected),[]);f.c.dispose();
});

test('explicit source response downgrade is blocked even in audit and preserves applied root',async()=>{
  for(const requested of ['/B','']) {
    let response=scan;const f=fixture({sessions:async()=>response});
    await f.c.scan();response={...scan,sourceDiscovery:{found:true,path:'/A',source:'manual'}};
    f.c.set('codexHome','/A');await f.c.rescanSource();assert.equal(f.c.get().activeCodexHome,'/A');
    f.c.select('a');f.c.set('target','target');await f.c.preview();await f.c.inspectDetails({previewId:'p'});
    response={...scan,capabilities:{},sourceDiscovery:undefined};
    f.c.set('codexHome',requested);await f.c.rescanSource();
    assert.equal(f.c.get().activeCodexHome,'/A');assert.equal(f.c.get().sourceDirty,true);assert.equal(f.c.get().sourceBlocked,true);
    assert.equal(f.c.get().busy,false);assert.equal(f.c.get().detail,null);assert.equal(f.c.get().detailRef,null);
    for(const key of ['sessions','workspaces','selected','previews'])assert.deepEqual(plain(f.c.get()[key]),[]);
    assert.match(f.c.get().error,/重启DSH/);assert.match(f.c.get().error,/未确认切换来源/);assert.match(f.c.get().error,/未提交导入/);
    const before=f.calls.length;f.c.set('options',{presentation:'audit'});f.c.select('a');
    f.c.get().previews.push({previewId:'stale',sessionId:'a'});f.c.get().batchId='stale';
    assert.equal(f.c.canStart(),false);assert.equal(f.c.canConfirmSummary(),false);
    await f.c.preview();await f.c.confirmSummary();await f.c.start();
    f.c.set('codexHome','');await f.c.scan();assert.equal(f.calls.length,before);
    assert.equal(f.c.get().sourceBlocked,true);f.c.dispose();
  }
});

test('explicit source requires well-formed discovery and manual confirmation, including clear',async()=>{
  const invalid=[undefined,{}, {...discovery,found:'true'}, {...discovery,path:''}, {...discovery,path:'  '}, {...discovery,path:42}, {...discovery,source:'unknown'}, {...discovery,found:false},discovery];
  for(const bad of invalid) {
    let response=scan;const f=fixture({sessions:async()=>response});await f.c.scan();
    response={...scan,sourceDiscovery:bad};f.c.set('codexHome','/B');await f.c.rescanSource();
    assert.equal(f.c.get().sourceBlocked,true);assert.equal(f.c.get().sourceDirty,true);
    assert.equal(f.c.get().activeCodexHome,'');assert.deepEqual(plain(f.c.get().sessions),[]);
    assert.equal(f.c.canStart(),false);assert.match(f.c.get().error,/重启DSH/);f.c.dispose();
  }
  let response=scan;const f=fixture({sessions:async()=>response});await f.c.scan();
  response={...scan,sourceDiscovery:{found:true,path:'/still-manual',source:'manual'}};f.c.set('codexHome','');await f.c.rescanSource();
  assert.equal(f.c.get().sourceBlocked,true);
  response={...scan,sourceDiscovery:{found:false,path:'/missing',source:'default'}};await f.c.rescanSource();
  assert.equal(f.c.get().sourceBlocked,false);assert.equal(f.c.get().sourceDirty,false);assert.equal(f.c.canStart(),false);
  f.c.dispose();
});

test('INVALID_CODEX_HOME is readable, clears stale sources and never requests preview/models/jobs',async()=>{
  let first=true;const f=fixture({sessions:async()=>{if(first){first=false;return scan;}throw Object.assign(Error('Permission denied'),{code:'INVALID_CODEX_HOME'});}});
  await ready(f);f.c.set('codexHome','/inaccessible');await f.c.rescanSource();
  assert.match(f.c.get().error,/CODEX_HOME 目录无效或不可读取/);assert.match(f.c.get().error,/Permission denied/);
  assert.equal(f.c.get().busy,false);assert.deepEqual(plain(f.c.get().sessions),[]);assert.equal(f.c.get().previews.length,0);
  const count=f.calls.length;await f.c.preview();await f.c.confirmSummary();await f.c.start();
  assert.equal(f.calls.length,count);assert.equal(f.calls.some(x=>['models','jobs'].includes(x.endpoint)),false);f.c.dispose();
});
