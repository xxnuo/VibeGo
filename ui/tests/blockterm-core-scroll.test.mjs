import assert from 'node:assert/strict';
import test from 'node:test';
import { isScrollNavigationKey, ScrollFollow } from '../src/components/blockterm/scroll-follow.ts';

test('scroll intent keys exclude IME and command shortcuts',()=>{
  const base={key:'PageUp',altKey:false,ctrlKey:false,metaKey:false,isComposing:false,keyCode:0};
  assert.equal(isScrollNavigationKey(base),true);
  for(const override of [{isComposing:true},{keyCode:229},{altKey:true},{metaKey:true},{ctrlKey:true},{key:'Enter'},{key:'ArrowLeft'}])
    assert.equal(isScrollNavigationKey({...base,...override}),false);
  for(const key of ['Home','End']) assert.equal(isScrollNavigationKey({...base,key,ctrlKey:true}),true);
  assert.equal(isScrollNavigationKey({...base,key:' ',shiftKey:true}),true);
});

test('layout retreat with growing extent is not user navigation',()=>{
  const state=new ScrollFollow();
  state.target(241382);
  state.applied(241382);
  state.observe(241361,241712,false);
  assert.equal(state.target(241712),241712);
  state.observe(241361,241712,true);
  assert.equal(state.target(241756),null);
});

test('output growth and repeated measurements preserve follow intent', () => {
  const state = new ScrollFollow();
  assert.equal(state.target(100),100);
  state.observe(100,500);
  assert.equal(state.target(500),500);
  state.observe(500,550);
  assert.equal(state.target(550),550);
});

test('reading history stays fixed until explicit resume or reaching the bottom', () => {
  const state = new ScrollFollow();
  state.target(1000);
  state.observe(900,1000);
  assert.equal(state.target(2000),null);
  state.observe(950,2000);
  assert.equal(state.target(3000),null);
  state.resume();
  assert.equal(state.target(3000),3000);
  state.observe(2000,3000);
  state.observe(3000,3000);
  assert.equal(state.target(4000),4000);
});

test('clamping after content collapse does not detach the viewport', () => {
  const state = new ScrollFollow();
  state.target(1000);
  state.observe(100,100);
  assert.equal(state.target(200),200);
  assert.equal(state.target(-100),0);
});

test('browser-clamped follow writes do not look like upward user navigation',()=>{
  const state=new ScrollFollow();
  assert.equal(state.target(1000),1000);
  state.applied(900);
  state.observe(900,1100);
  assert.equal(state.target(1100),1100);
  state.applied(1100);
  state.observe(1050,1100);
  assert.equal(state.target(1200),null);
});
