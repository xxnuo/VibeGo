import assert from 'node:assert/strict';
import test from 'node:test';
import { outputLinks, MAX_OUTPUT_LINK_LENGTH, isWebOutputLink, mergeOutputLinks } from '../src/components/blockterm/output-links.ts';

test('explicit OSC destinations override automatic text links only where they overlap',()=>{
  const auto=[[{start:0,end:20,href:'https://visible.test'},{start:25,end:30,href:'https://next.test'}]];
  const explicit=[[{start:0,end:20,href:'https://actual.test'}]];
  assert.deepEqual(mergeOutputLinks(auto,explicit),[[explicit[0][0],auto[0][1]]]);
  for(const href of ['javascript:alert(1)','file:///etc/passwd','https://user@example.test','https://exa\nmple.test'])
    assert.equal(isWebOutputLink(href),false);
  assert.equal(isWebOutputLink('https://example.test/report'),true);
});

test('bounds automatic link attributes while preserving source text and later links',()=>{
  const prefix='https://example.test/';
  const limit=prefix+'a'.repeat(MAX_OUTPUT_LINK_LENGTH-prefix.length);
  assert.equal(outputLinks([limit])[0][0].href,limit);
  const over=limit+'a';
  const chunks=[over.slice(0,4000),over.slice(4000),'\nhttps://next.test/path'];
  const original=[...chunks];
  const rows=outputLinks(chunks);
  assert.deepEqual(rows.slice(0,2),[[],[]]);
  assert.equal(rows[2][0].href,'https://next.test/path');
  assert.deepEqual(chunks,original);
  const punctuation='].)!'.repeat(1000);
  assert.equal(outputLinks([prefix+punctuation])[0][0].href,prefix);
});

test('maps HTTP links across soft wraps without linking hard line breaks',()=>{
  const rows=outputLinks(['go https://exa','mple.com/a','\nhttps://other.test/path.']);
  assert.deepEqual(rows,[
    [{start:3,end:14,href:'https://example.com/a'}],
    [{start:0,end:10,href:'https://example.com/a'}],
    [{start:0,end:23,href:'https://other.test/path'}],
  ]);
});

test('keeps balanced URL parentheses and excludes unsafe or credentialed schemes',()=>{
  const text='(https://example.test/a_(b)).] javascript:alert(1) file:///etc/passwd https://user:pass@example.test x https://界.test/path';
  const links=outputLinks([text])[0];
  assert.deepEqual(links.map(link=>link.href),['https://example.test/a_(b)','https://界.test/path']);
  for(const link of links) assert.equal(text.slice(link.start,link.end),link.href);
  assert.deepEqual(outputLinks(['https:// https://@ https://user@example.test']),[[]]);
});
