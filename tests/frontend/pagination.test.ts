import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const source=readFileSync(join(process.cwd(),'frontend/src/components/ui/Pagination.tsx'),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
const loaded={exports:{}};
runInNewContext(compiled,{module:loaded,exports:loaded.exports,require:(id:string)=>id==='react-i18next'?{useTranslation:()=>({t:(key:string)=>key})}:require(id)});
const Pagination=(loaded.exports as {default:React.ComponentType<any>}).default;
it('disables every page control while loading, including numbered buttons',()=>{
 const html=renderToStaticMarkup(React.createElement(Pagination,{currentPage:3,totalPages:8,disabled:true,onPageChange:()=>{}}));
 const buttons=html.match(/<button\b[^>]*>/g)||[];
 expect(buttons.length).toBeGreaterThan(3);
 expect(buttons.every(button=>button.includes('disabled=""'))).toBe(true);
});
