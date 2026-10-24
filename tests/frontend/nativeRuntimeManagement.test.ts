import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const source=ts.createSourceFile('panel.tsx',readFileSync('frontend/src/components/NativeRuntimeSecretsPanel.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const callback=(name:string,bindings:Record<string,unknown>)=>{
 let expression:ts.Expression|undefined;
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(source)===name)expression=node.initializer;ts.forEachChild(node,visit);};visit(source);
 if(!expression)throw Error(`Missing ${name}`);
 return runInNewContext(ts.transpileModule(`(${expression.getText(source)})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{Error,encodeURIComponent,...bindings});
};
it('restarts the selected row in its own agent rather than the machine service',async()=>{
 const apiPost=jest.fn().mockResolvedValue({success:true}),refreshStatus=jest.fn();
 const restart=callback('restart',{apiPost,refreshStatus,setBusy:jest.fn(),showToast:jest.fn()});
 const executionContext={kind:'interactive',sessionId:7,pipeName:'mcphub-user-fixture'};
 await restart('same',executionContext);
 expect(apiPost).toHaveBeenCalledWith('/native-runtime/processes/same/restart',{executionContext});
 expect(refreshStatus).toHaveBeenCalled();
});
it('requests merged status and exposes unavailable agents without dropping healthy processes',async()=>{
 const apiGet=jest.fn().mockResolvedValue({data:{processes:[{id:'healthy'}],gatewayHealthy:true,agents:[{executionContext:{kind:'interactive',sessionId:7},available:false}]}});
 const setRuntimeStatus=jest.fn(),setUnavailableAgents=jest.fn();
 const refresh=callback('refreshStatus',{apiGet,setRuntimeStatus,setUnavailableAgents,setConfigurationAvailable:jest.fn(),setGatewayHealthy:jest.fn(),setStatusError:jest.fn()});
 await refresh();
 expect(apiGet).toHaveBeenCalledWith('/native-runtime/status?includeInteractive=true');
 expect(setRuntimeStatus).toHaveBeenCalledWith([{id:'healthy'}]);
 expect(setUnavailableAgents).toHaveBeenCalledWith([{kind:'interactive',sessionId:7}]);
});
