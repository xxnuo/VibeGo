import assert from 'node:assert/strict';
import test from 'node:test';
import { navigateBlock, blockNavigationKey } from '../src/components/blockterm/block-navigation.ts';

test('block navigation follows visible order and clamps at both ends',()=>{
  const ids=['c','a','b'];
  assert.equal(navigateBlock(ids,null,'previous'),'b');
  assert.equal(navigateBlock(ids,'b','previous'),'a');
  assert.equal(navigateBlock(ids,'a','next'),'b');
  assert.equal(navigateBlock(ids,'b','next'),'b');
  assert.equal(navigateBlock(ids,'b','first'),'c');
  assert.equal(navigateBlock(ids,'c','last'),'b');
  assert.equal(navigateBlock([],null,'next'),null);
  assert.equal(navigateBlock(['c'],'removed','previous'),'c');
});

test('navigation does not hijack plain, modified or IME arrow keys',()=>{
  const key={key:'ArrowUp',altKey:true,ctrlKey:false,metaKey:false,shiftKey:false,isComposing:false};
  assert.equal(blockNavigationKey(key),'previous');
  for(const flag of ['ctrlKey','metaKey','shiftKey','isComposing']) assert.equal(blockNavigationKey({...key,[flag]:true}),null);
  assert.equal(blockNavigationKey({...key,altKey:false}),null);
  assert.equal(blockNavigationKey({...key,altKey:false},true),'previous');
  assert.equal(blockNavigationKey({...key,key:'ArrowDown',altKey:false},true),'next');
  for(const flag of ['ctrlKey','metaKey','shiftKey','isComposing']) assert.equal(blockNavigationKey({...key,altKey:false,[flag]:true},true),null);
});
