import test from 'node:test';
import assert from 'node:assert/strict';
import {inject} from '../index.js';

test('host declares webServer required transitively by Connection.rpc.handle registration',()=>{
  for(const service of ['connection','webServer','workspaceRegistry','sessionPersistence']) {
    assert.ok(inject.includes(service),'Missing host dependency: '+service);
  }
  assert.equal(inject.includes('llm'),false);
  assert.equal(inject.includes('agentDefaultModel'),false);
});
