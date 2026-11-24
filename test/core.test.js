import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink, open } from 'node:fs/promises';
import { writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareSession, scanCodex } from '../src/core.js';
const timestamp = '2026-01-01T00:00:00Z';
const env = (type,payload) => ({timestamp,type,payload});
const msg = (role,value,kinds,turn_id) => env('response_item',{type:'message',role,content:typeof value === 'string' ? [{type:'input_text',text:value}] : value,...(kinds ? {internal_chat_message_metadata_passthrough:{content_item_kinds:kinds,turn_id}} : {})});
const user = value => msg('user',value,['user.text']);
const assistant = value => msg('assistant',value);
const raw = records => records.map(x=>JSON.stringify(x)).join('\n')+'\n';
async function fixture(t,records) {
  const home = await mkdtemp(join(tmpdir(),'codex-import-core-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const dir = join(home,'.codex','sessions'); await mkdir(dir,{recursive:true});
  const path = join(dir,'session.jsonl');
  const contents = raw([env('session_meta',{id:'synthetic',cwd:'/synthetic',thread_source:'user'}),...records]);
  await writeFile(path,contents); return {home,path,contents};
}

test('real user metadata wins over mixed context; mirrors and compaction do not duplicate turns',async t=>{
  const f=await fixture(t,[msg('user','# AGENTS.md instructions\nsecret'),msg('user','<environment_context>synthetic</environment_context>'),msg('user',[{type:'input_text',text:'context'},{type:'input_text',text:'first'},{type:'input_text',text:'second'}],['harness','user.text','user.text'],'a'),msg('user','third',['user.text'],'a'),env('event_msg',{type:'user_message',message:'first'}),assistant('answer'),env('compacted',{replacement_history:[user('duplicate')]}),user('last'),assistant('final')]);
  const p=await prepareSession({...f,keepTurns:1});
  assert.equal(p.stats.totalTurns,2); assert.equal(p.turns[0].user,'last');
  assert.match(p.olderChunks.join(''),/first\nsecond\nthird/);
  assert.doesNotMatch(p.olderChunks.join(''),/secret|duplicate|environment_context/);
  assert.match(p.warnings.join(' '),/Compacted/);
});

test('mixed nonaligned metadata strips only closed context and preserves the user tail',async t=>{
  const tail='Please implement the requested fix.';
  const f=await fixture(t,[user('first'),msg('user',[{type:'input_text',text:'<environment_context>old cwd</environment_context>\n'+tail}],['harness.environment','user.text']),user('last')]);
  const p=await prepareSession({...f,keepTurns:3});
  assert.equal(p.stats.totalTurns,3); assert.equal(p.turns[1].user,tail);
  assert.doesNotMatch(p.turns[1].user,/old cwd/);
});

test('mixed nonaligned ambiguous context retains original text with historical warning',async t=>{
  for(const original of ['<environment_context>unclosed old cwd\nPlease implement the requested fix.','# AGENTS.md instructions\nunknown boundary\nPlease implement the requested fix.']) {
    const f=await fixture(t,[user('first'),msg('user',[{type:'input_text',text:original}],['harness.environment','user.text']),user('last')]);
    const p=await prepareSession({...f,keepTurns:3});
    assert.equal(p.stats.totalTurns,3); assert.ok(p.turns[1].user.includes(original));
    assert.match(p.turns[1].user,/Historical.*ambiguous/i); assert.match(p.warnings.join(' '),/ambiguous.*retained/i);
  }
});

test('old chunks process all text beyond 1.2 million characters and remain bounded',async t=>{
  const f=await fixture(t,[user('old'),assistant('x'.repeat(1250000)+'TAIL-REQUIRED'),user('recent')]);
  const p=await prepareSession({...f,keepTurns:1});
  assert.ok(p.olderChunks.length>50); assert.ok(p.olderChunks.every(s=>s.length<=24000));
  assert.match(p.olderChunks.join(''),/TAIL-REQUIRED/); assert.ok(p.stats.olderChars>1250000);
  const truncated=await prepareSession({...f,keepTurns:1,historyMode:'truncate'});
  assert.deepEqual(truncated.olderChunks,[]); assert.equal(truncated.stats.olderTurns,1);
});

test('native pair plus multiple and ID-less results preserved; arguments are not sliced',async t=>{
  const args=JSON.stringify({long:'a'.repeat(9000)});
  const f=await fixture(t,[user('tools'),env('response_item',{type:'function_call',call_id:'c',name:'read',arguments:args}),env('response_item',{type:'function_call_output',call_id:'c',output:'H'.repeat(500)+'T'.repeat(500)}),env('response_item',{type:'function_call_output',call_id:'c',output:'second-result'}),env('response_item',{type:'function_call_output',name:'unknown',output:{items:['without-id','more']}}),env('response_item',{type:'custom_tool_call',call_id:'missing',name:'run',input:'literal'})]);
  const p=await prepareSession({...f,toolOutputChars:256}); const items=p.turns[0].items;
  assert.equal(items.length,4); assert.equal(items[0].arguments,args); assert.ok(items[0].output.length<=256); const omitted=Number(items[0].output.match(/(\d+) characters omitted/)[1]); assert.equal(omitted,1000-(items[0].output.match(/^H+/)[0].length+items[0].output.match(/T+$/)[0].length));
  assert.match(items[0].output,/^H/); assert.match(items[0].output,/T$/);
  assert.equal(items[1].output,'second-result'); assert.equal(items[1].unpaired,true);
  assert.match(items[2].output,/without-id/); assert.equal(items[2].unpaired,true); assert.equal(items[3].unpaired,true);
});

test('images and unknown content explicit; no remote image fetch',async t=>{
  const f=await fixture(t,[msg('user',[{type:'input_text',text:'look'},{type:'input_image',image_url:'https://invalid.example/image'}],['user.text','user.image']),env('response_item',{type:'new_kind',data:'retained'}),env('response_item',{type:'reasoning',summary:[{type:'summary_text',text:'readable'}],encrypted_content:'NEVER-COPY'})]);
  const p=await prepareSession(f);
  assert.match(p.turns[0].user,/Historical image omitted/); assert.match(p.warnings.join(' '),/Images/);
  assert.match(p.turns[0].items[0].text,/retained/); assert.equal(p.turns[0].items[1].reasoning,'readable'); assert.doesNotMatch(JSON.stringify(p),/NEVER-COPY/);
});

test('source prefix is fixed, appended data excluded and sha matches',async t=>{
  const f=await fixture(t,[user('one'),assistant('a')]); const bytes=Buffer.byteLength(f.contents);
  await appendFile(f.path,raw([user('appended')]));
  const p=await prepareSession({...f,sourceBytes:bytes});
  assert.equal(p.stats.totalTurns,1); assert.equal(p.source.bytes,bytes);
  assert.equal(p.source.sha256,createHash('sha256').update(f.contents).digest('hex'));
  assert.match(p.warnings.join(' '),/Appended/);
});

test('same-length prefix rewrite during parse fails closed',async t=>{
  const f=await fixture(t,[user('one'),assistant('a'.repeat(70000))]); let changed=false;
  await assert.rejects(prepareSession({...f,onProgress:({phase})=>{if(phase==='verifying'&&!changed){changed=true;writeFileSync(f.path,f.contents.replace('one','two'));}}}),/changed/);
});

test('concurrent append is allowed but fixed snapshot excludes it',async t=>{
  const f=await fixture(t,[user('before')]); let changed=false;
  const p=await prepareSession({...f,onProgress:({phase})=>{if(phase==='verifying'&&!changed){changed=true;appendFileSync(f.path,raw([user('after')]));}}});
  assert.equal(p.turns.length,1); assert.equal(p.turns[0].user,'before'); assert.match(p.warnings.join(' '),/Appended/);
});

test('limits, incomplete JSON, cancellation and escaped symlinks reject',async t=>{
  const f=await fixture(t,[user('one')]);
  await assert.rejects(prepareSession({...f,keepTurns:0}),/keepTurns/);
  await assert.rejects(prepareSession({...f,maxLineBytes:20}),/maxLineBytes/);
  await assert.rejects(prepareSession({...f,sourceBytes:Buffer.byteLength(f.contents)-3}),/incomplete/);
  await assert.rejects(prepareSession({...f,signal:AbortSignal.abort()}),{name:'AbortError'});
  const outside=join(f.home,'outside.jsonl'); await writeFile(outside,f.contents);
  const escape=join(f.home,'.codex','sessions','escape.jsonl'); await symlink(outside,escape);
  await assert.rejects(prepareSession({...f,path:escape}),/inside/);
});

test('fork warning never claims complete ancestor history',async t=>{
  const f=await fixture(t,[env('session_meta',{id:'fork',forked_from_id:'parent',history_mode:'paginated'}),user('segment')]);
  const p=await prepareSession(f); assert.match(p.warnings.join(' '),/not full history/); assert.equal(p.turns[0].user,'segment');
});

test('scan uses opaque IDs and filters archived/subagents, retaining workspace counts',async t=>{
  const f=await fixture(t,[user('title')]);
  const archive=join(f.home,'.codex','archived_sessions'); await mkdir(archive,{recursive:true});
  await writeFile(join(archive,'archived.jsonl'),raw([env('session_meta',{id:'arch',cwd:'/other',source:'cli'}),user('archived')]));
  await writeFile(join(f.home,'.codex','sessions','agent.jsonl'),raw([env('session_meta',{id:'agent',cwd:'/other',source:{subagent:{spawn:{}}}}),user('agent')]));
  await writeFile(join(f.home,'.codex','session_index.jsonl'),raw([{id:'synthetic',thread_name:'Edited title'}]));
  const normal=await scanCodex({home:f.home}); assert.equal(normal.sessions.length,1); assert.equal(normal.sessions[0].title,'Edited title'); assert.match(normal.sessions[0].id,/^[a-f0-9]{64}$/);
  const all=await scanCodex({home:f.home,includeArchived:true,includeSubagents:true}); assert.equal(all.sessions.length,3); assert.equal(all.workspaces.find(w=>w.path==='/other').count,2);
});

test('pre-user orphan results are retained and old chunks never split surrogate pairs',async t=>{
  const f=await fixture(t,[env('response_item',{type:'function_call_output',output:'prefix-result'}),user('old'),assistant('😀'.repeat(25000)),user('recent')]);
  const p=await prepareSession({...f,keepTurns:1});
  assert.match(p.olderChunks.join(''),/prefix-result/); assert.match(p.warnings.join(' '),/Pre-user/);
  for(const chunk of p.olderChunks) { assert.ok(!/[\uD800-\uDBFF]$/.test(chunk)); assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk)); }
});

test('source over 32MiB streams with a bounded recent ring',async t=>{
  const f=await fixture(t,[]), h=await open(f.path,'a');
  try { for(let i=0;i<36;i++) await h.write(raw([user('turn-'+i),assistant('z'.repeat(1024*1024))])); } finally { await h.close(); }
  const p=await prepareSession({...f,keepTurns:2,historyMode:'truncate'});
  assert.ok(p.source.bytes>32*1024*1024); assert.equal(p.stats.totalTurns,36); assert.equal(p.turns.length,2); assert.equal(p.turns[0].user,'turn-34');
});
