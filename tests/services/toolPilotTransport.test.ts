import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { adviseWithToolPilot } from '../../src/services/toolPilot.js';

test('uses a real OpenAI-compatible HTTP endpoint for metadata-only internal advice', async () => {
  let received: any;
  let requestPath: string | undefined;
  const server = createServer(async (req, res) => {
    requestPath = req.url;
    let body = '';
    for await (const chunk of req) body += chunk;
    received = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'local-test', object: 'chat.completion', created: 0, model: 'internal-test',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Inspect the saved failure before choosing another diagnostic.' }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await adviseWithToolPilot({ trigger: 'repeated_identical_failure', resultIds: ['a','b','c'], recommendation: 'Review' },
      { server: 'demo', tool: 'inspect' }, { enabled: true, model: 'internal-test', apiKey: 'local-fixture',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` });
    expect(requestPath).toBe('/v1/chat/completions');
    expect(result).toMatchObject({ role: 'internal_toolpilot', evidence: 'metadata_only', reportedModel: 'internal-test' });
    expect(received.model).toBe('internal-test');
    expect(received.tools).toBeUndefined();
    expect(JSON.parse(received.messages[1].content)).toEqual({ trigger: 'repeated_identical_failure', failures: 3, server: 'demo', tool: 'inspect' });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
