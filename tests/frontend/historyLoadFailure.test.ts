import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const source=ts.createSourceFile('page.tsx',readFileSync('frontend/src/pages/ToolResultsPage.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let callback:ts.Expression|undefined;
function visit(node:ts.Node){if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='load'&&node.initializer&&ts.isCallExpression(node.initializer)&&node.initializer.getText(source).includes('getToolResults('))callback=node.initializer.arguments[0];ts.forEachChild(node,visit);}
visit(source);if(!callback)throw Error('History loader callback not found');
const compiled=ts.transpileModule('('+callback.getText(source)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
it('finishes loading and exposes an error when history retrieval rejects',async()=>{
 const setLoading=jest.fn(),setError=jest.fn();
 const load=runInNewContext(compiled,{Promise,Error,page:1,filter:{},historyRequestRef:{current:0},t:(key:string)=>key,setLoading,setError,setItems:jest.fn(),setStats:jest.fn(),setPagination:jest.fn(),setRetrievalDiagnostics:jest.fn(),getToolResults:async()=>{throw Error('offline');},getToolResultStats:async()=>({success:true,data:{}})});
 await expect(load()).resolves.toBeUndefined();
 expect(setLoading).toHaveBeenLastCalledWith(false);
 expect(setError).toHaveBeenLastCalledWith('offline');
});

it('ignores an older page response after a newer load has completed',async()=>{
 let first!:(value:unknown)=>void,second!:(value:unknown)=>void;
 const requests=[new Promise(resolve=>{first=resolve;}),new Promise(resolve=>{second=resolve;})];
 const setItems=jest.fn(),setLoading=jest.fn();
 const load=runInNewContext(compiled,{Promise,Error,page:1,filter:{},historyRequestRef:{current:0},t:(key:string)=>key,setLoading,setError:jest.fn(),setItems,setStats:jest.fn(),setPagination:jest.fn(),setRetrievalDiagnostics:jest.fn(),getToolResults:()=>requests.shift(),getToolResultStats:async()=>({success:true,data:{}})});
 const old=load(),current=load();
 second({success:true,data:[{resultId:'current'}]});await current;
 first({success:true,data:[{resultId:'old'}]});await old;
 expect(setItems).toHaveBeenCalledTimes(1);
 expect(setItems).toHaveBeenCalledWith([{resultId:'current'}]);
 expect(setLoading.mock.calls).toEqual([[true],[true],[false]]);
});
