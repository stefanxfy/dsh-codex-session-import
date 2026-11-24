import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildEvents } from '../src/events.js';
const makePrepared = () => ({source:{title:'Synthetic imported session'},warnings:[],turns:[{time:100,user:'first user',items:[{kind:'assistant',text:'thinking',reasoning:'readable summary',time:99},{kind:'tool',callId:'source-a',name:'read',arguments:'{"file":"synthetic"}',output:'historical result',time:150},{kind:'tool',callId:'source-a',name:'read',output:'additional output',unpaired:true},{kind:'tool',name:'no-id',output:'must retain',unpaired:true},{kind:'assistant',text:'finished'}]},{time:50,user:'second user',items:[]}]});
function make() { let counter=0; return buildEvents(makePrepared(),{id:'session-test',summary:'Older synthetic history',createId:()=> 'id-'+(++counter)}); }

test('new imported title keeps original name in both modes without adding or stripping suffix text',()=>{for(const presentation of ['readable','audit'])for(const title of ['合成中文会话标题','Source（适配版）']){const p=makePrepared();p.source.title=title;p.adaptation={presentation,version:'readable-v2'};const built=buildEvents(p);assert.equal(built.title,title);assert.equal(built.events.find(e=>e.type==='session/title').data.title,title);}});

test('one empty system head, ascending turns, contiguous seq and monotonic times',()=>{
  const {events,createdAt}=make();
  assert.equal(createdAt,100); assert.deepEqual(events.map(e=>e.seq),events.map((_,i)=>i));
  assert.ok(events.every((e,i)=>i===0||e.time>=events[i-1].time));
  assert.deepEqual(events.filter(e=>e.type==='turn/start').map(e=>e.data.turn),[1,2]);
  const system=events.filter(e=>e.type==='system/message'); assert.equal(system.length,1); assert.deepEqual(system[0].data.message.content,[]);
  const messages=events.flatMap(e=> e.data?.message ? [e.data.message] : e.type==='user/message' ? [e.data] : []);
  assert.equal(new Set(messages.map(m=>m.id)).size,messages.length);
  assert.equal(events.filter(e=>e.type==='turn/end').length,2);
});

test('summary is context before first real retained user, not fabricated assistant response',()=>{
  const {events}=make(); const users=events.filter(e=>e.type==='user/message');
  assert.equal(users.length,2); assert.match(users[0].data.content[0].text,/NOT new authorization/);
  assert.match(users[0].data.content[0].text,/Older synthetic history/);
  assert.match(users[0].data.content[0].text,/first user$/);
  assert.equal(users[1].data.content[0].text,'second user');
  assert.ok(events.filter(e=>e.type==='assistant/message').every(e=>Array.isArray(e.data.stream)));
  assert.ok(events.filter(e=>e.type==='assistant/message').every(e=>!JSON.stringify(e.data).includes('Older synthetic history')));
});

test('known tools use native historical pair; unpaired tools retained with explicit fallback warning',()=>{
  const {events,warnings}=make(); const calls=events.filter(e=>e.type==='tool/call'), results=events.filter(e=>e.type==='tool/result');
  assert.equal(calls.length,1); assert.equal(results.length,1);
  assert.equal(results[0].data.message.toolCallId,calls[0].data.callId);
  assert.deepEqual(results[0].sourceEventSeqs,[calls[0].seq]);
  assert.equal(calls[0].data.arguments,'{"file":"synthetic"}');
  assert.match(JSON.stringify(events),/additional output/); assert.match(JSON.stringify(events),/must retain/);
  assert.match(JSON.stringify(events),/TEXT FALLBACK/); assert.match(warnings.join(' '),/Unpaired/);
});

test('source title is a single log-only title event, never a fabricated user request',()=>{
  const prepared=makePrepared(); prepared.source.title='Edited source title';
  const {events,title}=buildEvents(prepared);
  const titles=events.filter(e=>e.type==='session/title');
  assert.equal(titles.length,1);
  assert.deepEqual(titles[0].data,{title:'Edited source title',messageSeqs:[],source:{kind:'user'}});
  assert.equal(title,'Edited source title'); assert.equal(titles[0].surfaceOp,undefined);
  assert.equal(events.filter(e=>e.type==='user/message').length,2);
  assert.ok(!events.filter(e=>e.type==='user/message').some(e=>JSON.stringify(e.data).includes('Edited source title')));
});

test('pure builder does not mutate prepared; duplicate generated IDs fail closed',()=>{
  const p=makePrepared(), before=structuredClone(p); buildEvents(p); assert.deepEqual(p,before);
  assert.throws(()=>buildEvents(p,{createId:()=> 'reused'}),/unique/);
  assert.throws(()=>buildEvents({turns:[]}),/without retained/);
});

test('installed v4 Session.create accepts mixed native tools and text history in memory', {skip:!process.versions.electron}, async()=>{
  // Electron provides ASAR support; no persistence, plugin apply, workspace attach or model is invoked.
  const require=createRequire('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js');
  const {Session,SessionId,SESSION_FORMAT_VERSION}=await import(require.resolve('@deepseek-ai/dsh-session'));
  assert.equal(SESSION_FORMAT_VERSION,4);
  const conversion=make(), id=SessionId('synthetic-official-memory-only');
  const session=Session.create(id,conversion.events,{version:4,id,createdAt:conversion.createdAt,cwd:'/synthetic/no-write',isSeeded:false});
  assert.ok(session);
  const {foldSessionTitle}=await import(require.resolve('@deepseek-ai/dsh-session-title'));
  const restoredTitle=foldSessionTitle(session.snapshotEvents());
  assert.equal(restoredTitle.title,conversion.title);
  assert.deepEqual(restoredTitle.source,{kind:'user'});
  const empty=buildEvents({source:{title:'minimal'},turns:[{time:0,user:'unanswered',items:[]}]});
  assert.ok(Session.create(SessionId('synthetic-minimal'),empty.events,{version:4,id:SessionId('synthetic-minimal'),createdAt:0,cwd:'/synthetic/no-write',isSeeded:false}));
});
