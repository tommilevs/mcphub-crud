import {originalResultWindows,precedingDiffHeader} from '../../src/services/originalResultWindows.js';
it('groups JSON array elements without splitting strings or rewriting numbers',()=>{
 const text='[{"n":9007199254740993,"message":"a,b"},{"n":2,"message":"c,d"},{"n":3}]';
 const windows=originalResultWindows(text,45);
 expect(windows.map(window=>window.text).join('')).toBe(text);
 expect(windows[0].text).toBe('[{"n":9007199254740993,"message":"a,b"},');
 expect(windows.every(window=>window.text.length<=45)).toBe(true);
});
it('respects diff hunk boundaries when an entire hunk fits',()=>{
 const text='diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n@@ -9 +9 @@\n-a\n+b\n';
 const windows=originalResultWindows(text,45);
 expect(windows.map(window=>window.text).join('')).toBe(text);
 expect(windows[1].text.startsWith('@@ -9')).toBe(true);
});
it('recognizes JSON after an explicitly identified metadata prefix',()=>{
 const prefix='server\ntool\n';const json='[{"a":"first"},{"a":"second"},{"a":"third"}]';
 const windows=originalResultWindows(prefix+json,32,prefix.length);
 expect(windows[0].text).toBe(prefix+'[{"a":"first"},');
 expect(windows.map(window=>window.text).join('')).toBe(prefix+json);
});
it('preserves malformed JSON, CRLF and Unicode when structural boundaries cannot fit',()=>{
 for(const text of ['{"broken": "abc', '\r\n😀abcdef\r\n\nlast\n']){
  const windows=originalResultWindows(text,5);
  expect(windows.map(window=>window.text).join('')).toBe(text);
  for(const window of windows){expect(window.text).toBe(text.slice(window.start,window.end));expect(Buffer.from(window.text).toString()).toBe(window.text);}
 }
});
it('uses the nearest original diff file header and refuses to invent one',()=>{
 const a='diff --git a/first b/first\n--- a/first\n+++ b/first\n';
 const b='diff --git a/second b/second\n--- a/second\n+++ b/second\n';
 const text=a+'@@ -1 +1 @@\n-a\n+b\n'+b+'@@ -2 +2 @@\n-x\n+y\n';
 const header=precedingDiffHeader(text,text.length);
 expect(header?.text).toBe(b);expect(text.slice(header!.start,header!.end)).toBe(b);
 expect(precedingDiffHeader('ordinary logs',10)).toBeNull();
});
