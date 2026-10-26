#!/usr/bin/env node
// Offline acceptance package: no dependencies, installation scripts or real credentials.
const { createInterface } = require('node:readline');
const fs = require('node:fs');
process.on('uncaughtException', error => {
  fs.writeFileSync('fixture-error.txt', error.stack || error.message);
  process.exit(1);
});
fs.appendFileSync('fixture-events.txt', 'started\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync('fixture-events.txt', `${request.method || 'response'}\n`);
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case 'initialize':
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'acquisition-fixture', version: '1.0.0' } }; break;
    case 'ping': result = {}; break;
    case 'tools/list': result = { tools: ['fixture_probe', 'check_environment'].map(name =>
      ({ name, inputSchema: { type: 'object', properties: {} } })) }; break;
    case 'tools/call':
      if (request.params.name === 'fixture_probe') fs.appendFileSync('probe-calls.txt', 'probe\n');
      result = { content: [{ type: 'text', text: JSON.stringify({
        credentialPresent: process.env.FIXTURE_KEY === 'synthetic-acquisition-only',
      }) }] }; break;
    default: process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      error: { code: -32601, message: 'Method not found' } }) + '\n'); return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
