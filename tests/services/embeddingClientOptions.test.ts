import http from 'node:http';
import OpenAI from 'openai';
import { embeddingClientOptions } from '../../src/utils/embeddingClientOptions.js';

test('a local embedding endpoint receives no Authorization header when no key is configured', async () => {
  let authorization: string | undefined;
  const server = http.createServer((req, res) => {
    authorization = req.headers.authorization;
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({object:'list',data:[{object:'embedding',index:0,embedding:[0.6,0.8]}],model:'local',usage:{prompt_tokens:1,total_tokens:1}}));
  });
  await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve));
  try {
    const port = (server.address() as {port:number}).port;
    const client = new OpenAI(embeddingClientOptions({apiKey:'',baseURL:`http://127.0.0.1:${port}/v1`}));
    const result = await client.embeddings.create({input:'fixture',model:'local',encoding_format:'float'});
    expect(result.data[0].embedding).toEqual([0.6,0.8]);
    expect(authorization).toBeUndefined();
  } finally { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('configured API keys keep the normal SDK authentication behavior', () => {
  expect(embeddingClientOptions({apiKey:'sk-fixture',baseURL:'https://example.invalid/v1'})).toEqual({apiKey:'sk-fixture',baseURL:'https://example.invalid/v1'});
});
