import { execFileSync } from 'child_process';
import path from 'path';

const script=path.resolve(__dirname,'../../scripts/evaluate-smart-routing.js');
const tool=(serverName:string,toolName:string)=>({serverName,toolName});
const relevant=tool('maps','route');
const other=tool('mail','send');
const row={id:'route-cold',phase:'cold',evidence:'synthetic',relevant:[relevant],
  baseline:{tools:[other,relevant],latencyMs:20,outputTokens:100},
  mcpZero:{tools:[relevant,other],latencyMs:25,outputTokens:90}};
function run(input:unknown){
  return JSON.parse(execFileSync(process.execPath,[script],{input:JSON.stringify(input),encoding:'utf8',stdio:['pipe','pipe','pipe']}));
}
describe('offline Smart Routing evaluation',()=>{
  it('computes paired ranking metrics and only reports supplied measurements',()=>{
    const result=run({version:1,k:2,cases:[row]});
    expect(result.phases.cold.baseline).toMatchObject({cases:1,precision:0.5,recall:1,mrr:0.5,latencyMs:{mean:20,samples:1},outputTokens:{mean:100,samples:1}});
    expect(result.phases.cold.baseline.ndcg).toBeCloseTo(1/Math.log2(3));
    expect(result.phases.cold.mcpZero).toMatchObject({mrr:1,ndcg:1,outputTokens:{mean:90,samples:1}});
    expect(result.evidence).toEqual({synthetic:1,recorded:0,live:0});
    expect(result.phases.warm).toBeUndefined();
  });
  it('does not invent missing timings or token counts and separates warm samples',()=>{
    const result=run({version:1,k:2,cases:[{...row,phase:'warm',baseline:{tools:[relevant]},mcpZero:{tools:[]}}]});
    expect(result.phases.warm.baseline).toMatchObject({precision:0.5,recall:1,latencyMs:{mean:null,samples:0},outputTokens:{mean:null,samples:0}});
    expect(result.phases.warm.mcpZero).toMatchObject({precision:0,recall:0,mrr:0,ndcg:0});
  });
  it('reports abstention separately instead of assigning recall to unanswerable queries',()=>{
    const result=run({version:1,k:2,cases:[{...row,relevant:[],baseline:{tools:[]},mcpZero:{tools:[other]}}]});
    expect(result.phases.cold.baseline).toMatchObject({recall:null,mrr:null,ndcg:null,abstentionAccuracy:1,unanswerableCases:1});
    expect(result.phases.cold.mcpZero.abstentionAccuracy).toBe(0);
  });
  it('uses the requested cutoff and nearest-rank percentiles across paired cases',()=>{
    const result=run({version:1,k:1,cases:[
      {...row,id:'first',baseline:{tools:[other,relevant],latencyMs:10}},
      {...row,id:'second',baseline:{tools:[relevant],latencyMs:100}},
    ]});
    expect(result.phases.cold.baseline).toMatchObject({cases:2,precision:0.5,recall:0.5,mrr:0.5,ndcg:0.5,latencyMs:{samples:2,mean:55,p50:10,p95:100}});
  });
  it.each([
    [{...row,baseline:{tools:[relevant,relevant]}},'duplicate tool identity'],
    [{...row,mcpZero:undefined},'missing paired observation'],
    [{...row,phase:'unknown'},'invalid phase'],
    [{...row,baseline:{tools:[other],latencyMs:-1}},'invalid latencyMs'],
    [{...row,relevant:[{serverName:'maps'}]},'invalid tool identity'],
  ])('rejects malformed observations with a specific reason', (bad,reason)=>{
    let failure:any;
    try{run({version:1,k:2,cases:[bad]});}catch(error){failure=error;}
    expect(failure?.status).toBe(1);
    expect(failure?.stderr).toContain(reason);
  });
});
