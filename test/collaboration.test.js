import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {prepareSession} from '../src/core.js';
import {createAdapter,ADAPTATION_VERSION} from '../src/adapt.js';
import {buildEvents} from '../src/events.js';
const record = payload => ({type:'response_item',timestamp:'2026-01-01T00:00:00Z',payload});
const user = text => record({type:'message',role:'user',content:[{type:'input_text',text}]});
const answer = text => record({type:'message',role:'assistant',content:[{type:'output_text',text}]});
const cipher = 'gAAAAAB' + 'x'.repeat(110) + '==';
const envelope = body => 'Message Type: MESSAGE\nTask name: /root\nSender: /root/synthetic_review\nPayload:\n' + body;
const agent = (content,extra={}) => record({type:'agent_message',sender:'/root/reviewer',recipient:'/root/internal-recipient',id:'internal-record-id',content,...extra});
const unreadable = () => agent(envelope(cipher));
const reasoning = text => record({type:'reasoning',summary:[{type:'summary_text',text}],encrypted_content:'NEVER-REASONING-CIPHER'});
async function fixture(t,records) {
  const home=await mkdtemp(join(tmpdir(),'collaboration-adapt-')); t.after(()=>rm(home,{recursive:true,force:true}));
  const dir=join(home,'.codex','sessions'); await mkdir(dir,{recursive:true}); const path=join(dir,'history.jsonl');
  const raw=[{type:'session_meta',payload:{id:'synthetic',title:'Collaboration'}},...records].map(JSON.stringify).join('\n')+'\n';
  await writeFile(path,raw); return {home,path,raw};
}
const bodyOf = p => p.turns.flatMap(t=>t.items.map(i=>i.text ?? '')).join('\n');
const blocksOf = p => buildEvents(p).events.filter(e=>e.type==='assistant/message').flatMap(e=>e.data.message.content);

test('explicit collaboration retains business text and agent name, internal structure only in details',async t=>{
  const prose='agent_message encrypted_content recipient are ordinary technical words';
  const f=await fixture(t,[user('question'),agent(prose,{metadata:{routing:'META-ONLY'}}),agent(undefined,{data:{originalnormaltext:'data.originalnormaltext business survives'}}),answer(prose)]);
  const p=await prepareSession({...f,presentation:'readable'}), body=bodyOf(p);
  assert.match(body,/子代理 reviewer/); assert.ok(body.includes(prose)); assert.match(body,/data.originalnormaltext business survives/);
  assert.doesNotMatch(JSON.stringify(p.turns),/internal-recipient|internal-record-id|META-ONLY/);
  assert.equal(p.turns[0].items[2].text,prose);
  const d=p.adaptation.details; assert.equal(d.length,2); assert.equal(d[0].kind,'collaboration'); assert.equal(d[0].name,'agent_message');
  assert.equal(d[0].sourceLine,3); assert.equal(d[1].sourceLine,4); assert.match(d[0].output,/internal-recipient|META-ONLY/);
  assert.equal(p.adaptation.stats.collaborationMessages,2); assert.equal(p.adaptation.stats.unreadableCollaborations,0);
  assert.equal(p.source.sha256,createHash('sha256').update(f.raw).digest('hex')); assert.equal(ADAPTATION_VERSION,'readable-v2');
});

test('business structures retain keys, scalar values, and literal unreadable marker text',async t=>{
  const values=[
    {id:'synthetic-1',value:42,enabled:false,originalnormaltext:'synthetic result'},
    {author:{name:'business author',id:'person-1'},name:'synthetic-record',id:'nested-id',values:[false,0,null,{id:'deep-id',author:'owner',name:'inner'}]},
    {id:'ORDER-123',status:'approved',count:7,ok:true},
    {type:'business_result',sender:'Warehouse',recipient:'Customer',amount:0},
    0,false,null,[],{}
  ];
  const f=await fixture(t,[user('question'),...values.map((value,index)=>index<2 ? agent(undefined,{data:value}) : agent(value)),agent('literal [加密内容不可读] should survive'),agent({type:'text',text:'typed literal [加密内容不可读] should survive'})]);
  const p=await prepareSession({...f,presentation:'readable'});
  for (let i=0;i<values.length;i++) assert.equal(p.turns[0].items[i].text.split('\n').slice(1).join('\n'),JSON.stringify(values[i]));
  assert.match(p.turns[0].items[9].text,/literal \[加密内容不可读\] should survive/);
  assert.match(p.turns[0].items[10].text,/typed literal \[加密内容不可读\] should survive/);
  assert.doesNotMatch(JSON.stringify(p.turns),/internal-record-id|internal-recipient/);
  assert.equal(p.adaptation.stats.unreadableCollaborations,0);
});

test('business JSON preserves mixed values but never encrypted nodes or fields',async t=>{
  const value={id:'ORDER-123',count:0,ok:false,empty:null,encrypted_content:'FIELD-SECRET',nested:[{type:'encrypted_text',text:'NODE-SECRET'},{author:'Warehouse',name:'Customer',id:'business-id'}]};
  const f=await fixture(t,[user('question'),agent(value)]);
  const p=await prepareSession({...f,presentation:'readable'}), text=p.turns[0].items[0].text;
  assert.ok(text.includes(JSON.stringify({id:'ORDER-123',count:0,ok:false,empty:null,nested:[{author:'Warehouse',name:'Customer',id:'business-id'}]})));
  assert.match(text,/部分协作正文加密，无法读取/); assert.doesNotMatch(JSON.stringify(p),/FIELD-SECRET|NODE-SECRET/);
});

test('confirmed envelope is stripped, pure and mixed encryption are explicit and never retained',async t=>{
  const f=await fixture(t,[user('question'),unreadable(),agent(envelope('业务结论：修复已验证。\n'+cipher)),agent([{type:'text',text:'明文摘要'},{type:'encrypted_text',text:'STRUCTURED-CIPHER'}]),agent(undefined,{data:{encrypted_content:'FIELD-CIPHER'}})]);
  const p=await prepareSession({...f,presentation:'readable'}), body=bodyOf(p);
  assert.match(body,/子代理 synthetic_review 发回一条协作消息，正文加密，无法读取/);
  assert.match(body,/业务结论：修复已验证/); assert.match(body,/部分协作正文加密，无法读取/); assert.match(body,/明文摘要/);
  assert.doesNotMatch(body,/Message Type:|Task name:|Sender:|Payload:/);
  assert.doesNotMatch(JSON.stringify(p),/gAAAAA|STRUCTURED-CIPHER|FIELD-CIPHER/);
  assert.match(p.adaptation.details[0].output,/Task name:|root/);
  assert.equal(p.adaptation.stats.unreadableCollaborations,4);
  assert.ok(blocksOf(p).every(b=>b.type==='text')); assert.equal(buildEvents(p).events.filter(e=>e.type==='tool/call'||e.type==='tool/result').length,0);
});

test('standard split text-envelope and encrypted-content carrier remains unreadable without JSON leakage',async t=>{
  const f=await fixture(t,[user('question'),record({type:'agent_message',author:'/root/synthetic_review',recipient:'/root',content:[{type:'input_text',text:envelope('')},{type:'encrypted_content',encrypted_content:'SPLIT-CIPHER'}],internal_chat_message_metadata_passthrough:{route:'DETAIL-ONLY'}}),agent('literal [加密内容不可读] and '+cipher)]);
  const p=await prepareSession({...f,presentation:'readable'});
  assert.equal(p.turns[0].items[0].text,'子代理 synthetic_review 发回一条协作消息，正文加密，无法读取');
  assert.doesNotMatch(bodyOf(p),/Message Type:|Task name:|input_text|DETAIL-ONLY/);
  assert.match(p.turns[0].items[1].text,/literal \[加密内容不可读\] and/);
  assert.match(p.turns[0].items[1].text,/部分协作正文加密，无法读取/);
  assert.doesNotMatch(JSON.stringify(p),/SPLIT-CIPHER|gAAAAA/);
});

test('only complete envelope stripped: ordinary messages and malformed collaboration text stay',async t=>{
  const literal=envelope('example business text');
  const malformed='Message Type: MESSAGE\nSender: /root/example\nPayload:\nkeep me';
  const f=await fixture(t,[user(literal),answer(literal),agent(malformed),agent('Please explain Message Type: MESSAGE and Payload: as plain text.'),record({type:'future_kind',data:{originalnormaltext:'ordinary unknown JSON'}})]);
  const p=await prepareSession({...f,presentation:'readable'});
  assert.equal(p.turns[0].user,literal); assert.equal(p.turns[0].items[0].text,literal);
  assert.ok(p.turns[0].items[1].text.includes(malformed)); assert.match(bodyOf(p),/Please explain Message Type/); assert.match(bodyOf(p),/ordinary unknown JSON/);
});

test('merge only same-sender adjacent unreadable records, never across answer, reasoning, tool or turn',async t=>{
  const f=await fixture(t,[user('one'),unreadable(),unreadable(),answer('normal boundary'),unreadable(),reasoning('readable boundary'),unreadable(),record({type:'function_call',call_id:'t',name:'read',arguments:'{}'}),record({type:'function_call_output',call_id:'t',output:'tool boundary'}),unreadable(),record({type:'reasoning',encrypted_content:'HIDDEN'}),unreadable(),agent(undefined,{sender:'other',encrypted_content:'OTHER'}),user('two'),unreadable()]);
  const p=await prepareSession({...f,presentation:'readable'}), notices=p.turns[0].items.filter(i=>i.collaboration);
  assert.equal(notices.length,6); assert.equal(notices[0].collaboration.count,2); assert.match(notices[0].text,/2 条/); assert.deepEqual(notices[0].sourceLines,[3,4]);
  assert.ok(notices.slice(1).every(i=>i.collaboration.count===1)); assert.equal(p.turns[1].items[0].collaboration.count,1);
  assert.equal(p.adaptation.stats.mergedCollaborationNotices,1); assert.equal(p.adaptation.details.filter(d=>d.kind==='collaboration').length,8);
  assert.deepEqual(p.adaptation.details.filter(d=>d.kind==='collaboration').map(d=>d.sourceLine),[3,4,6,8,11,13,14,16]);
});

test('a paired tool result between notifications remains a merge barrier',async t=>{
  const f=await fixture(t,[user('question'),record({type:'function_call',call_id:'c',name:'read',arguments:'{}'}),unreadable(),record({type:'function_call_output',call_id:'c',output:'paired result'}),unreadable()]);
  const p=await prepareSession({...f,presentation:'readable'});
  const notices=p.turns[0].items.filter(i=>i.collaboration);
  assert.equal(notices.length,2); assert.ok(notices.every(i=>i.collaboration.count===1));
  assert.equal(p.adaptation.stats.mergedCollaborationNotices,0); assert.equal(p.adaptation.details.length,3);
  assert.equal(p.adaptation.details[0].sourceLine,3); assert.equal(p.adaptation.details[0].outputSourceLine,5);
});

test('re-adapting is idempotent with original details, no repeated merging or reasoning loss',async t=>{
  const f=await fixture(t,[user('question'),unreadable(),unreadable(),reasoning('FULL SUMMARY'),record({type:'function_call_output',output:'orphan tool'})]);
  const p=await prepareSession({...f,presentation:'readable'}), adapter=createAdapter('readable',8000,()=>{}), before=JSON.stringify(p);
  const a=adapter.turn(p.turns[0]), b=adapter.turn(a.turn);
  assert.strictEqual(a.turn,p.turns[0]); assert.deepEqual(a,b); assert.deepEqual(a.details,p.adaptation.details);
  assert.equal(adapter.stats.mergedCollaborationNotices,0); assert.equal(adapter.stats.mergedToolRecords,0);
  const restored=JSON.parse(JSON.stringify(p)); assert.deepEqual(adapter.turn(restored.turns[0]).turn,restored.turns[0]);
  assert.deepEqual(restored.adaptation.details,p.adaptation.details); assert.deepEqual(blocksOf(restored),blocksOf(p));
  assert.equal(blocksOf(p).find(b=>b.type==='reasoning').text,'FULL SUMMARY'); assert.equal(JSON.stringify(p),before);
});

test('full readable reasoning survives natively without empty text or historical English label; audit unchanged',async t=>{
  const full='摘要😀\n'.repeat(2500)+'COMPLETE-TAIL';
  const f=await fixture(t,[user('question'),reasoning(full),record({type:'reasoning',encrypted_content:'ONLY-CIPHER'}),record({type:'reasoning',summary:[{type:'encrypted_text',text:'TYPED-CIPHER'}]}),answer('normal answer')]);
  const p=await prepareSession({...f,presentation:'readable',toolOutputChars:256}), blocks=blocksOf(p);
  assert.deepEqual(blocks,[{type:'reasoning',text:full},{type:'text',text:'normal answer'}]);
  assert.doesNotMatch(JSON.stringify(buildEvents(p)),/Historical readable reasoning summary|ONLY-CIPHER|TYPED-CIPHER|NEVER-REASONING-CIPHER/);
  const audit=await prepareSession(f); assert.equal(audit.turns[0].items[0].text,'[Historical readable reasoning summary; not decrypted chain of thought]');
  assert.equal(blocksOf(audit)[0].text,full); assert.match(JSON.stringify(buildEvents(audit)),/Historical readable reasoning summary/);
});

test('bounded Unicode-safe body and sanitized details, old archive adapted before summary input, retained ring only',async t=>{
  const large='业务😀'.repeat(1000);
  const f=await fixture(t,[user('old'),agent(large,{metadata:{nested:{encrypted_content:'DO-NOT-SAVE'}}}),unreadable(),user('latest'),agent(large)]);
  const p=await prepareSession({...f,presentation:'readable',keepTurns:1,toolOutputChars:256});
  assert.equal(p.adaptation.details.length,1); assert.equal(p.adaptation.details[0].turn,2);
  assert.ok(p.turns[0].items[0].text.length<=256); assert.match(p.turns[0].items[0].text,/超出预算/);
  const d=p.adaptation.details[0]; assert.ok(d.output.length+d.callId.length+d.arguments.length<=256); assert.equal(d.truncated,true);
  assert.ok(p.turns[0].items[0].text.isWellFormed()); assert.ok(d.output.isWellFormed());
  const archive=p.olderChunks.join(''); assert.match(archive,/子代理/); assert.doesNotMatch(archive,/agent_message|recipient|internal-record-id|gAAAAA|DO-NOT-SAVE/);
  assert.ok(p.olderChunks.every(c=>c.length<=24000)); assert.equal(p.stats.totalTurns,2); assert.equal(p.stats.keptTurns,1);
  assert.equal(p.adaptation.stats.truncatedCollaborations,2); assert.ok(p.adaptation.stats.truncatedDetails>=2);
  const truncated=await prepareSession({...f,presentation:'readable',keepTurns:1,historyMode:'truncate'}); assert.deepEqual(truncated.olderChunks,[]);
  await assert.rejects(prepareSession({...f,presentation:'readable',signal:AbortSignal.abort()}),{name:'AbortError'});
});

test('audit agent JSON format is compatible and encrypted fields still redacted',async t=>{
  const f=await fixture(t,[user('question'),agent('plain',{encrypted_content:'AUDIT-SECRET'})]);
  const p=await prepareSession(f), explicit=await prepareSession({...f,presentation:'audit'});
  assert.deepEqual(p,explicit); assert.match(bodyOf(p),/Historical source record/); assert.match(bodyOf(p),/agent_message|internal-record-id/);
  assert.doesNotMatch(JSON.stringify(p),/AUDIT-SECRET/); assert.deepEqual(p.adaptation.details,[]);
});
