import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,stat,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import {createService,normalizeOptions} from '../src/host.js';
import {PROMPT_VERSION} from '../src/summary.js';

const sha='a'.repeat(64);
// Deliberately independent of host identityOptions: audit must retain the old key shape.
function keyFor(options={},target='target',hash=sha,version='readable-v2',prompt= PROMPT_VERSION){
  const {presentation,...legacy}=normalizeOptions(options);
  const identity=presentation==='readable'?{...legacy,presentation,conversionVersion:version}:legacy;
  return createHash('sha256').update(JSON.stringify([hash,target,identity,prompt])).digest('hex');
}
async function fixture(t,initial){
  const cacheRoot=await mkdtemp(join(tmpdir(),'minimal-dedupe-'));
  assert.ok(cacheRoot.startsWith(join(tmpdir(),'minimal-dedupe-')));
  const manifestPath=join(cacheRoot,'manifest.json');
  if(initial)await writeFile(manifestPath,JSON.stringify(initial,null,2)+'\n');
  let writes=0,models=0,prepares=0,hash=sha,attachments=0;
  const sourcePath='/synthetic/private-source.jsonl',title='PRIVATE_SOURCE_TITLE',cwd='/synthetic/private-project';
  const deps={cacheRoot,
    discoverCodexRoot:async()=>({found:true,path:'/synthetic/codex',source:'default'}),
    scanCodex:async()=>({sessions:[{id:'source',path:sourcePath,title,cwd}],workspaces:[]}),
    prepareSession:async()=>{prepares++;return {source:{id:'source',path:sourcePath,title,cwd,sha256:hash,bytes:10},turns:[{user:'question',time:1,items:[{kind:'assistant',text:'answer'}]}],olderChunks:[],stats:{keptTurns:1,olderTurns:0},warnings:[]};},
    buildEvents:()=>({title,createdAt:1,events:[]}),Session:{create(){}},
    workspaceRegistry:{list:()=>[{id:'target',path:'/target'},{id:'other',path:'/other'}],get:id=>['target','other'].includes(id)?{path:'/'+id,attachSession:async()=>{attachments++;}}:undefined},
    persistence:{create:async()=>{writes++;return {append:async()=>{},flush:async()=>{},close:async()=>{}};}},
    generate:async()=>{models++;assert.fail('No model calls allowed');}
  };
  let service=createService(deps);
  t.after(async()=>{await service.dispose();assert.ok(cacheRoot.startsWith(join(tmpdir(),'minimal-dedupe-')));await rm(cacheRoot,{recursive:true,force:true});});
  return {cacheRoot,manifestPath,get service(){return service;},restart:async()=>{await service.dispose();service=createService(deps);},hash:value=>{hash=value;},counts:()=>({writes,models,prepares,attachments})};
}
async function preview(f,options={historyMode:'truncate'}){await f.service.scan();return f.service.preview({sessionId:'source',options});}
async function importOne(f,p,targetWorkspaceId='target'){
  const job=await f.service.start({previewIds:[p.previewId],targetWorkspaceId});
  for(let n=0;n<2000;n++){const current=f.service.status(job.id);if(current.status==='completed')return current.items[0];await tick();}
  assert.fail('Synthetic import job did not settle');
}
async function diskState(f){const s=await stat(f.manifestPath,{bigint:true});return {raw:await readFile(f.manifestPath,'utf8'),ino:s.ino,mtimeNs:s.mtimeNs,ctimeNs:s.ctimeNs,files:await readdir(f.cacheRoot)};}
function fullEntry(id='old-full',options={historyMode:'truncate'}){return {id,sourceId:'source',title:'LEGACY_PRIVATE_TITLE',target:'target',options:normalizeOptions(options),conversionVersion:'audit-v1',sourceSnapshot:{path:'/synthetic/legacy-source',codexHome:'/synthetic/legacy-root',bytes:10,sha256:sha},extraLegacyField:{retained:true}};}

test('new disk values contain only id; restart skips same SHA/target/options with the same id and no writes',async t=>{
  const f=await fixture(t),options={historyMode:'truncate'};
  const p=await preview(f,options),first=await importOne(f,p);
  assert.equal(first.status,'completed');assert.equal(f.counts().writes,1);assert.equal(f.counts().attachments,1);
  const before=await diskState(f),manifest=JSON.parse(before.raw);
  assert.deepEqual(manifest,{[keyFor(options)]:{id:first.importedId}});
  assert.deepEqual(Object.keys(Object.values(manifest)[0]),['id']);
  assert.doesNotMatch(before.raw,/private-source|PRIVATE_SOURCE_TITLE|private-project|sourceId|sourceSnapshot|conversionVersion|options|target|keepTurns|historyMode|toolOutputChars/);
  assert.equal(Number((await stat(f.manifestPath)).mode)&0o777,0o600);
  await f.restart();const scan=await f.service.scan();
  assert.equal(Object.hasOwn(scan,'imports'),false);assert.equal(Object.hasOwn(scan.sessions[0],'imported'),false);
  const p2=await f.service.preview({sessionId:'source',options}),second=await importOne(f,p2);
  assert.equal(second.status,'skipped');assert.equal(second.importedId,first.importedId);
  const counts=f.counts();
  await assert.rejects(f.service.details({importedId:first.importedId}),{code:'SOURCE_UNAVAILABLE',message:'仅保存去重标识，没有导入后来源快照；请在导入前预览核查'});
  assert.deepEqual(f.counts(),counts);assert.equal(counts.models,0);assert.equal(counts.writes,1);assert.equal(counts.attachments,1);
  assert.deepEqual(await diskState(f),before);
});

for(const presentation of ['audit','readable'])for(const format of ['full','string'])test('legacy '+presentation+' '+format+' record keeps its key/value and skips without rewriting',async t=>{
  const options={historyMode:'truncate',presentation},key=keyFor(options),entry=format==='full'?fullEntry('old-copy',options):'old-copy';
  const f=await fixture(t,{[key]:entry}),before=await diskState(f);
  for(let n=0;n<2;n++){
    const scan=await f.service.scan();assert.equal(Object.hasOwn(scan,'imports'),false);assert.equal(Object.hasOwn(scan.sessions[0],'imported'),false);assert.doesNotMatch(JSON.stringify(scan),/LEGACY_PRIVATE_TITLE|legacy-source|legacy-root|extraLegacyField/);
    const p=await f.service.preview({sessionId:'source',options}),item=await importOne(f,p);
    assert.equal(item.status,'skipped');assert.equal(item.importedId,'old-copy');assert.equal(f.counts().writes,0);assert.equal(f.counts().models,0);assert.deepEqual(await diskState(f),before);
    await f.restart();
  }
});

test('target, audit/readable mode, parameters and source SHA remain isolated',async t=>{
  const f=await fixture(t),cases=[
    {options:{historyMode:'truncate'},target:'target'},
    {options:{historyMode:'truncate'},target:'other'},
    {options:{historyMode:'truncate',presentation:'readable'},target:'target'},
    {options:{historyMode:'truncate',keepTurns:2},target:'target'},
    {options:{historyMode:'truncate',toolOutputChars:256},target:'target'},
    {options:{historyMode:'truncate'},target:'target',hash:'b'.repeat(64)}
  ];
  const expected={},ids=new Set();
  for(const c of cases){f.hash(c.hash??sha);const p=await preview(f,c.options),item=await importOne(f,p,c.target);assert.equal(item.status,'completed');assert.equal(ids.has(item.importedId),false);ids.add(item.importedId);expected[keyFor(c.options,c.target,c.hash??sha)]={id:item.importedId};const again=await importOne(f,p,c.target);assert.equal(again.status,'skipped');assert.equal(again.importedId,item.importedId);}
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath,'utf8')),expected);assert.equal(f.counts().writes,cases.length);assert.equal(f.counts().models,0);
});

test('readable-v1 and older prompt keys do not suppress current readable-v2; old records survive added entries',async t=>{
  const options={historyMode:'truncate',presentation:'readable'},old=fullEntry('old-v1',options);old.conversionVersion='readable-v1';
  const initial={[keyFor(options,'target',sha,'readable-v1')]:old,[keyFor(options,'target',sha,'readable-v2','previous-prompt') ]:'old-prompt'};
  const f=await fixture(t,initial),p=await preview(f,options);
  assert.equal(p.adaptation.version,'readable-v2');
  const item=await importOne(f,p);assert.equal(item.status,'completed');assert.notEqual(item.importedId,'old-v1');assert.notEqual(item.importedId,'old-prompt');
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath,'utf8')),{...initial,[keyFor(options)]:{id:item.importedId}});
  await f.restart();const repeated=await importOne(f,await preview(f,options));assert.equal(repeated.status,'skipped');assert.equal(repeated.importedId,item.importedId);assert.equal(f.counts().writes,1);
});
// Historical summary identities must be built as historical data, never normalized as a new request.
for(const presentation of ['audit','readable'])for(const format of ['full','string'])test('legacy summary '+presentation+' '+format+' stays isolated and unchanged while truncate imports',async t=>{
  const oldOptions={keepTurns:30,historyMode:'summary',toolOutputChars:8000,presentation};
  const {presentation:mode,...legacy}=oldOptions;
  const identity=mode==='readable'?{...legacy,presentation:mode,conversionVersion:'readable-v2'}:legacy;
  const oldKey=createHash('sha256').update(JSON.stringify([sha,'target',identity,PROMPT_VERSION])).digest('hex');
  const oldEntry=format==='string'?'old-summary':{...fullEntry('old-summary',{presentation}),options:oldOptions,conversionVersion:presentation==='readable'?'readable-v2':'audit-v1'};
  const f=await fixture(t,{[oldKey]:oldEntry});
  const before=await diskState(f);
  if(format==='full'){
    const counts=f.counts();
    const detail=await f.service.details({importedId:'old-summary'});
    assert.equal(detail.detail.source.sha256,sha);
    assert.equal(f.counts().prepares,counts.prepares+1);
    assert.equal(f.counts().writes,0);
    assert.equal(f.counts().models,0);
    assert.deepEqual(await diskState(f),before);
  }
  const options={historyMode:'truncate',presentation},p=await preview(f,options),item=await importOne(f,p);
  assert.equal(item.status,'completed');assert.notEqual(item.importedId,'old-summary');
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath,'utf8')),{[oldKey]:oldEntry,[keyFor(options)]:{id:item.importedId}});
  await f.restart();assert.equal((await importOne(f,await preview(f,options))).status,'skipped');
  assert.equal(f.counts().models,0);assert.equal(f.counts().writes,1);
});
