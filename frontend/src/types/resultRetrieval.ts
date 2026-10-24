export interface ResultRetrievalRule {mode?:'passthrough'|'fragments';minTokens?:number;maxOutputTokens?:number;}
export interface ResultRetrievalConfig extends ResultRetrievalRule {policies?:Record<string,ResultRetrievalRule>;}
