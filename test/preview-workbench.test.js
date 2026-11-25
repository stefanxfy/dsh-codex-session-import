import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../client.js',import.meta.url),'utf8');
const flatten=n=>n&&typeof n==='object'?[n,...(n.children||[]).flat(Infinity).flatMap(flatten)]:[];
function fixture(){let plugin,Panel,createController;const React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:props||{},children}),useSyncExternalStore:(sub,get)=>get(),useEffect:()=>{}};const box={AbortController,setTimeout,clearTimeout,window:{__ModuleLoader__:{load:p=>{plugin=p;}}}};vm.runInNewContext(source.replace("if (typeof window === 'undefined'","globalThis.testing={createController}; if (typeof window === 'undefined'"),box);createController=box.testing.createController;plugin.factory(()=>React).apply({connection:{},effect:()=>{},slots:{inject:(name,fn)=>fn(),register:(config,component)=>{if(config.name==='main')Panel=component;}}});const calls=[];const c=createController(async(endpoint,payload)=>{calls.push({endpoint,payload});return {};});const render=()=>Panel({controller:c});return {c,calls,render};}
const cls=(nodes,name)=>nodes.find(n=>n.props.className?.split(' ').includes(name));
const button=(tree,label)=>flatten(tree).find(n=>n.type==='button'&&n.children.includes(label));
test('workbench has ordered direct panes with headers and bodies, and clear local empty state',()=>{const f=fixture(),tree=f.render(),nodes=flatten(tree),main=cls(nodes,'cri-main'),workbench=cls(nodes,'cri-workbench');assert.ok(main.children.includes(workbench));const panes=workbench.children.filter(n=>n?.type==='section');assert.deepEqual(panes.map(n=>n.props['aria-label']),['来源会话','逐会话预览','导入设置']);for(const pane of panes){assert.ok(cls(pane.children,'cri-pane-head'));assert.ok(cls(pane.children,'cri-pane-body'));}assert.ok(cls(nodes,'cri-title-line'));assert.ok(cls(nodes,'cri-version'));assert.ok(cls(nodes,'cri-empty-state'));assert.match(JSON.stringify(tree),/本地预览不会写入 DSH 会话/);f.c.dispose();});
test('legacy fee control is absent and LocalN guidance remains visible without requests',()=>{const f=fixture();f.c.get().previews.push({sessionId:'a',needsSummaryConfirmation:true});const tree=f.render(),fee=button(tree,'确认费用并生成摘要');assert.equal(fee,undefined);assert.equal(button(tree,'确认并开始导入').props.disabled,true);assert.equal(f.calls.length,0);const settings=flatten(tree).find(n=>n.props['aria-label']==='导入设置');assert.ok(settings);assert.match(JSON.stringify(settings),/仅导入最近N轮，更早历史不导入；导入过程中不请求模型/);assert.doesNotMatch(JSON.stringify(settings),/更早历史的处理方式|费用|生成摘要/);assert.equal(flatten(settings).some(n=>n.type==='input'&&n.props.type==='checkbox'),false);assert.equal(flatten(settings).filter(n=>n.type==='details').some(n=>JSON.stringify(n).includes('隐私与费用')),false);f.c.dispose();});
test('preview omits summary, turn bodies and timestamps while preserving statistics and source data',()=>{const f=fixture(),attack='<img src=x onerror=alert(1)>',preview={sessionId:'a',previewId:'preview-a',source:{title:attack},stats:{totalTurns:7,keptTurns:3,olderTurns:4,unknownStat:9},summary:'合成摘要保留',turnsPreview:[{time:1700000000000,user:'SYNTHETIC_PRIVATE_USER',items:[{kind:'assistant',text:'SYNTHETIC_PRIVATE_ASSISTANT',reasoning:'SYNTHETIC_PRIVATE_REASONING'},{kind:'unknown',output:'SYNTHETIC_PRIVATE_UNKNOWN'}],unknownTurn:'SYNTHETIC_PRIVATE_FIELD'}],adaptation:{samples:[{before:attack,after:'适配原文'}]}};f.c.get().previews.push(preview);const before=JSON.stringify(preview),tree=f.render(),nodes=flatten(tree),body=JSON.stringify(tree);assert.deepEqual(cls(nodes,'cri-preview-stats').children.map(n=>n.children[1].children[0]+' '+n.children[0].children[0]),['总轮数 7','保留轮数 3','早期轮数 4']);assert.equal(nodes.some(n=>n.children.includes('合成摘要保留')),false);assert.ok(nodes.some(n=>n.children.includes(attack)));assert.doesNotMatch(body,/SYNTHETIC_PRIVATE_|1700000000000|历史轮次|原始轮次 JSON/);assert.equal(cls(nodes,'cri-turn-preview'),undefined);assert.equal(JSON.stringify(preview),before);assert.equal(f.calls.length,0);assert.equal(button(tree,'核查原始历史（只读）'),undefined);assert.doesNotMatch(body,/核查原始历史/);assert.doesNotMatch(body,/innerHTML|dangerouslySetInnerHTML/);assert.equal(nodes.some(n=>n.type==='img'),false);assert.equal(cls(nodes,'cri-preview-card').type,'details');f.c.dispose();});
test('removed imported lists and manual DSH refresh never return; source scan remains one button',()=>{const f=fixture();let tree=f.render();assert.ok(button(tree,'刷新会话列表'));assert.equal(button(tree,'应用目录并扫描'),undefined);f.c.set('codexHome','/synthetic/home');tree=f.render();assert.ok(button(tree,'应用目录并扫描'));assert.equal(button(tree,'刷新会话列表'),undefined);assert.match(JSON.stringify(tree),/目录草稿待应用/);assert.doesNotMatch(JSON.stringify(tree),/曾导入|已导入列表|刷新 DSH|刷新DSH/);f.c.dispose();});
test('injected fee capability cannot restore controls and global failures stay visible',()=>{const f=fixture(),s=f.c.get();s.previews.push({sessionId:'a',needsSummaryConfirmation:true});s.phase='合成阶段';s.error='合成错误';s.directoryError='合成目录错误';let confirmed=0;f.c.canConfirmSummary=()=>true;f.c.confirmSummary=()=>{confirmed++;};const tree=f.render();assert.equal(confirmed,0);const fee=button(tree,'确认费用并生成摘要');assert.equal(fee,undefined);assert.equal(confirmed,0);const main=cls(flatten(tree),'cri-main');for(const text of ['合成阶段','合成错误','合成目录错误'])assert.ok(main.children.some(n=>n?.children?.includes(text)));f.c.dispose();});
test('source configuration collapses after successful scan but exceptions force it open, keeping scan and count outside',()=>{const f=fixture(),s=f.c.get();s.scanCompleted=true;s.sourceDiscovery={found:true,source:'environment'};const config=tree=>flatten(tree).find(n=>n.type==='details'&&n.children.some(c=>c?.type==='summary'&&String(c.children[0]).startsWith('来源目录 / 发现方式')));let tree=f.render();assert.equal(config(tree).props.open,false);assert.match(JSON.stringify(config(tree)),/CODEX_HOME/);assert.equal(flatten(config(tree)).some(n=>n.type==='button'),false);assert.equal(flatten(config(tree)).some(n=>n.props.className?.includes('cri-selected-count')),false);assert.ok(button(tree,'刷新会话列表'));for(const patch of [{sourceDirty:true},{sourceBlocked:true},{sourceDiscovery:{found:false}},{scanCompleted:false}]){Object.assign(s,{scanCompleted:true,sourceDirty:false,sourceBlocked:false,sourceDiscovery:{found:true,source:'environment'}},patch);tree=f.render();assert.equal(config(tree).props.open,true);}s.sourceDirty=true;tree=f.render();assert.equal(button(tree,'应用目录并扫描').props.disabled,false);f.c.dispose();});
test('capacity guidance stays collapsed by default and opens only with explicit configured limit',()=>{const f=fixture();const range=()=>flatten(f.render()).find(n=>n.type==='details'&&n.children.some(c=>c?.type==='summary'&&c.children.includes('导入范围与容量')));assert.equal(range().props.open,false);
  f.c.capacityValid=()=>false;
  f.c.get().selected=Array.from({length:101},(_,i)=>String(i));const warning=range();assert.equal(warning.props.open,true);f.c.capacityValid=()=>true;assert.equal(range().props.open,false);f.c.dispose();});

test('preview hides model usage and internal JSON while preserving readable stats and underlying data',()=>{
  const f=fixture();
  const preview={sessionId:'a',source:{title:'Synthetic'},needsSummaryConfirmation:true,stats:{totalTurns:2,keptTurns:2,olderTurns:0,rawInternal:'SYNTHETIC_STATS_RAW'},adaptation:{version:'readable-v2',samples:[{before:'SYNTHETIC_ADAPTATION_RAW'}]},modelUsage:{inputChars:1234,chunks:1,estimatedInputTokens:309,modelKey:'synthetic-model',debug:'SYNTHETIC_MODEL_RAW'}};
  f.c.get().previews.push(preview);const before=JSON.stringify(preview);
  const tree=f.render(),body=JSON.stringify(tree);
  assert.doesNotMatch(body,/统计与模型用量详情|适配统计与前后片段|SYNTHETIC_STATS_RAW|SYNTHETIC_ADAPTATION_RAW|SYNTHETIC_MODEL_RAW/);
  assert.match(body,/总轮数/);assert.ok(flatten(tree).some(n=>n.type==='strong'&&n.children.includes('2')));assert.doesNotMatch(body,/输入约 1234 字符|约 309 输入 tokens|synthetic-model/);
  assert.equal(button(tree,'确认费用并生成摘要'),undefined);assert.equal(JSON.stringify(preview),before);
  assert.equal(f.calls.length,0);f.c.dispose();
});

test('character-count context advisory is hidden but real capacity and source failures remain',()=>{
  const f=fixture(),s=f.c.get();
  const note=n=>'保留历史约 '+n+' 字符，可能超过模型上下文；请减少轮数或工具输出。DSH续聊可能压缩或超限，本插件不保证可直接续聊。';
  const warnings=[note(400000),note(750000),'PREVIEW_CAPACITY：预览容量不足，请减少批次','保留历史约 500 字符，来源校验失败，不能导入。'];
  s.previews.push({sessionId:'a',source:{title:'Synthetic'},stats:{totalTurns:30,keptTurns:30,olderTurns:0},warnings});
  s.error='SOURCE_CHANGED：来源已变化，请重新预览';
  const before=JSON.stringify(warnings),body=JSON.stringify(f.render());
  assert.doesNotMatch(body,/可能超过模型上下文|DSH续聊可能压缩|400000|750000/);
  assert.match(body,/PREVIEW_CAPACITY/);assert.match(body,/来源校验失败/);assert.match(body,/SOURCE_CHANGED/);
  assert.equal(JSON.stringify(warnings),before);assert.equal(f.calls.length,0);f.c.dispose();
});

test('processing explanations are hidden while operational warnings and raw records remain',()=>{
  const f=fixture();
  const known=[
  "Images are represented by explicit placeholders; original image data is not imported",
  "Encrypted content was not decrypted",
  "Unknown structured content retained as labeled historical JSON",
  "Mixed user metadata boundary ambiguous; original text retained as historical context, not current authorization",
  "Tool calls with missing results retained as labeled history",
  "Pre-user historical response/tool records retained with first source user as historical prefix; original ancestor user is unavailable",
  "Encrypted source content not decrypted; readable fields only are imported",
  "Inherited session metadata does not replace the source file header identity",
  "Fork/segment metadata: inherited records in this file are retained; ancestry is not fetched separately (not full history verification)",
  "Compacted replacement history ignored to avoid duplicated/reinterpreted user turns",
  "Historical system/developer/environment instructions filtered; not activated",
  "Encrypted reasoning not decrypted; only readable summaries imported",
  "Duplicate tool call IDs retained without guessing result ownership",
  "Tool calls without IDs retained as labeled history",
  "Unknown, extra, or ID-less tool results retained as labeled history, not dropped",
  "Historical tool outputs truncated with head/tail and omitted-character count",
  "Unsupported response items retained as explicitly labeled non-executable history",
  "Appended source data excluded from the fixed snapshot",
  "Mixed user metadata did not align; only balanced recognized context prefixes removed, user tail preserved",
  "Mixed user metadata did not align; original readable user text preserved",
  "Mixed historical metadata boundary ambiguous; all user content retained",
  "Unknown historical content provenance retained; runtime-looking text is not evidence of runtime origin",
  "Encrypted collaboration content not decrypted; readable content only is imported"
];
  const runtime='SUMMARY_CACHE_UNAVAILABLE: synthetic operational warning';
  const warnings=[...known,...known,runtime,runtime];
  const preview={sessionId:'a',previewId:'p',source:{title:'Synthetic'},stats:{totalTurns:1,keptTurns:1,olderTurns:0},warnings};
  f.c.get().previews.push(preview);
  f.c.get().detail={source:{title:'Synthetic'},stats:{},records:[],offset:0,total:0,nextOffset:null,warnings:[...known,runtime]};
  const before=JSON.stringify({preview,detail:f.c.get().detail});
  const rendered=JSON.stringify(f.render());
  for(const message of known)assert.equal(rendered.includes(message),false,message);
  assert.ok(rendered.includes(runtime));
  assert.equal(JSON.stringify({preview,detail:f.c.get().detail}),before);
  assert.equal(f.calls.length,0);f.c.dispose();
});
