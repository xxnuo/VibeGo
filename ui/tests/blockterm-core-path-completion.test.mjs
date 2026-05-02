import assert from 'node:assert/strict';
import test from 'node:test';
import {pathCompletionContext,pathCandidates,applyPathCandidate,explicitCompletionEdit} from '../src/components/blockterm/path-completion.ts';

test('explicit local paths use cwd and directories precede files',()=>{
  const context=pathCompletionContext('cat ./d',7,'/tmp/work','/bin/bash');
  assert.equal(context.directory,'/tmp/work/./');
  const items=pathCandidates(context,[{name:'data file',isDir:false},{name:'docs',isDir:true},{name:'.hidden',isDir:false},{name:'data\nfile',isDir:false}]);
  assert.deepEqual(items.map(item=>item.label),['docs/','data file']);
  assert.deepEqual(applyPathCandidate(context,items[0]),{draft:'cat ./docs/',cursor:11});
  assert.equal(applyPathCandidate(context,items[1]).draft,'cat ./data\\ file ');
});
test('quoted paths reuse existing shell edits and preserve trailing arguments',()=>{
  const text='cat "./da" --flag';
  const context=pathCompletionContext(text,9,'/tmp','zsh');
  assert.ok(context);
  const item=pathCandidates(context,[{name:'data file',isDir:false}])[0];
  assert.equal(applyPathCandidate(context,item).draft,'cat "./data file" --flag');
});
test('native shell retains unsupported or semantic completion contexts',()=>{
  for(const [text,shell] of [['echo $HOME/f','bash'],['git st','bash'],['./script','bash'],['cat ./f','pwsh'],['cat ~/f','bash'],['cd /other; cat ./f','bash']])
    assert.equal(pathCompletionContext(text,text.length,'/tmp',shell),null);
});
test('explicit Tab inserts one candidate or a complete Unicode common prefix',()=>{
  const context=pathCompletionContext('cat ./f',7,'/tmp','bash');
  const candidates=names=>pathCandidates(context,names.map(name=>({name,isDir:false})));
  assert.equal(explicitCompletionEdit(context,candidates(['file.txt'])).draft,'cat ./file.txt ');
  assert.equal(explicitCompletionEdit(context,candidates(['file.txt','file.log'])).draft,'cat ./file.');
  assert.equal(explicitCompletionEdit(context,candidates(['f😀','f😁'])),null);
  assert.equal(explicitCompletionEdit(context,Array.from({length:200},()=>candidates(['file'])[0])),null);
});
