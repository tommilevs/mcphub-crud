/// <reference types="jest" />

// Regression test for issue #922: a tool that returns a null (or other
// non-object JSON) payload as its text content must not crash the hub's
// tool-call path. The crash originated in checkAuthError, which parsed the
// text content and dereferenced `.code` on the result without checking that
// JSON.parse actually returned an object.

const mockCallTool = jest.fn();

const mockClient = {
  connect: jest.fn().mockResolvedValue(undefined),
  close: jest.fn(),
  getServerCapabilities: jest.fn(() => ({ tools: {} })),
  listTools: jest.fn().mockResolvedValue({ tools: [] }),
  callTool: mockCallTool,
};

jest.mock('@modelcontextprotocol/client', () => ({
  ...jest.requireActual('@modelcontextprotocol/client'),
  Client: jest.fn().mockImplementation(() => mockClient),
  SSEClientTransport: jest.fn(),
  StreamableHTTPClientTransport: jest.fn(),
}));

jest.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: jest.fn(),
}));

jest.mock('../../src/services/oauthService.js', () => ({
  initializeAllOAuthClients: jest.fn(),
}));

jest.mock('../../src/services/oauthClientRegistration.js', () => ({
  registerOAuthClient: jest.fn(),
}));

jest.mock('../../src/services/mcpOAuthProvider.js', () => ({
  createOAuthProvider: jest.fn(async () => undefined),
}));

jest.mock('../../src/services/groupService.js', () => ({
  getServersInGroup: jest.fn(),
  getServerConfigInGroup: jest.fn(),
}));

jest.mock('../../src/services/sseService.js', () => ({
  getGroup: jest.fn(() => ''),
}));

jest.mock('../../src/services/vectorSearchService.js', () => ({
  removeServerToolEmbeddings: jest.fn(),
  saveToolsAsVectorEmbeddings: jest.fn().mockResolvedValue(undefined),
}));

let currentUser: { username: string; isAdmin: boolean } | null = null;
jest.mock('../../src/services/services.js', () => ({
  getDataService: jest.fn(() => ({
    filterData: (data: any[]) => {
      if (!currentUser || currentUser.isAdmin) return data;
      return data.filter(
        (item) =>
          item.owner === currentUser?.username ||
          item.visibility === 'public' ||
          (item.visibility === 'group' && item.sharedWithUsers?.includes(currentUser?.username)),
      );
    },
  })),
}));

jest.mock('../../src/services/smartRoutingService.js', () => ({
  initSmartRoutingService: jest.fn(),
  getSmartRoutingTools: jest.fn(),
  handleSearchToolsRequest: jest.fn(),
  handleDescribeToolRequest: jest.fn(),
  isSmartRoutingGroup: jest.fn(() => false),
}));

const mockLogToolCall = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/activityLoggingService.js', () => ({
  getActivityLoggingService: jest.fn(() => ({
    logToolCall: mockLogToolCall,
  })),
}));

const mockCaptureAndAnnotate = jest.fn(async (result: any) => result);
jest.mock('../../src/services/toolResultHistoryCoordinator.js', () => ({
  getToolResultHistoryCoordinator: jest.fn(() => ({
    captureAndAnnotate: mockCaptureAndAnnotate,
  })),
}));

jest.mock('../../src/services/keepAliveService.js', () => ({
  setupClientKeepAlive: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/proxy.js', () => ({
  createFetchWithProxy: jest.fn(() => jest.fn()),
  getProxyConfigFromEnv: jest.fn(() => undefined),
}));

jest.mock('../../src/dao/index.js', () => ({
  getServerDao: jest.fn(() => ({
    findAll: jest.fn(async () => []),
    findById: jest.fn(async () => undefined),
  })),
  getSystemConfigDao: jest.fn(() => ({
    get: jest.fn(async () => ({})),
  })),
  getBuiltinPromptDao: jest.fn(() => ({
    findEnabled: jest.fn(async () => []),
    findByName: jest.fn(async () => undefined),
  })),
  getBuiltinResourceDao: jest.fn(() => ({
    findEnabled: jest.fn(async () => []),
  })),
}));

jest.mock('../../src/config/index.js', () => ({
  expandEnvVars: jest.fn((value: string) => value),
  replaceEnvVars: jest.fn((value: any) => value),
  getNameSeparator: jest.fn(() => '::'),
  default: {
    mcpHubName: 'test-hub',
    mcpHubVersion: '1.0.0',
    initTimeout: 60000,
  },
}));

import * as mcpService from '../../src/services/mcpService.js';

describe('handleCallToolRequest null / primitive tool result payloads (issue #922)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentUser = null;
  });

  const createServerInfo = (callToolImpl: jest.Mock) => ({
    name: 'null-server',
    status: 'connected',
    enabled: true,
    tools: [{ name: 'null-server::do_thing' }],
    client: { callTool: callToolImpl, close: jest.fn() },
    transport: {},
    options: {},
  });

  const callWithPayload = async (text: string, headers?: Record<string, string>) => {
    const callTool = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text }],
      isError: false,
    });
    const serverInfo = createServerInfo(callTool) as any;
    mcpService.setServerInfosForTest([serverInfo]);

    const result = await mcpService.handleCallToolRequest(
      {
        params: {
          name: 'call_tool',
          arguments: {
            toolName: 'null-server::do_thing',
            arguments: {},
          },
        },
      },
      {
        sessionId: 'session-1',
        server: 'null-server',
        headers,
      },
    );

    return { result, callTool };
  };

  it('passes through a null JSON payload without throwing', async () => {
    const { result, callTool } = await callWithPayload('null');

    expect(callTool).toHaveBeenCalledTimes(1);
    // Raw text content is returned unchanged.
    expect(result).toEqual({
      content: [{ type: 'text', text: 'null' }],
      isError: false,
    });
  });

  it('passes through a primitive number payload without throwing', async () => {
    const { result } = await callWithPayload('42');
    expect(result).toEqual({
      content: [{ type: 'text', text: '42' }],
      isError: false,
    });
  });

  it('captures the pre-compression result once and returns its namespaced result id', async () => {
    mockCaptureAndAnnotate.mockImplementationOnce(async (result: any) => ({
      ...result,
      _meta: { 'mcphub/result_id': 'result-1' },
    }));

    const { result } = await callWithPayload('history');

    expect(mockCaptureAndAnnotate).toHaveBeenCalledTimes(1);
    expect(mockCaptureAndAnnotate).toHaveBeenCalledWith(
      expect.objectContaining({ content: [{ type: 'text', text: 'history' }] }),
      expect.objectContaining({
        server: 'null-server',
        tool: 'do_thing',
        sessionId: 'session-1',
      }),
    );
    expect(result._meta).toEqual({ 'mcphub/result_id': 'result-1' });
  });

  it('propagates conversation and parent result headers into history metadata', async () => {
    const { result } = await callWithPayload('history', {
      'x-conversation-id': 'conversation-1',
      'x-mcphub-parent-result-id': 'parent-result-1',
    });

    expect(result.isError).toBe(false);
    expect(mockCaptureAndAnnotate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: 'conversation-1',
        parentResultId: 'parent-result-1',
      }),
    );
  });

  it('passes through a boolean payload without throwing', async () => {
    const { result } = await callWithPayload('true');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'true' }],
      isError: false,
    });
  });

  it('still surfaces a genuine { code: 401 } payload as an auth error', async () => {
    // A real auth-error object must keep triggering the 401 path — the null
    // guard must not swallow legitimate error objects.
    const callTool = jest.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ code: 401, message: 'Unauthorized' }),
        },
      ],
      isError: false,
    });
    const serverInfo = createServerInfo(callTool) as any;
    mcpService.setServerInfosForTest([serverInfo]);

    const result = await mcpService.handleCallToolRequest(
      {
        params: {
          name: 'call_tool',
          arguments: { toolName: 'null-server::do_thing', arguments: {} },
        },
      },
      { sessionId: 'session-1', server: 'null-server' },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('401');
  });

  it('rejects a guessed global tool call when its server is not visible to the user', async () => {
    currentUser = { username: 'alice', isAdmin: false };
    const callTool = jest.fn().mockResolvedValue({ content: [], isError: false });
    mcpService.setServerInfosForTest([
      {
        name: 'private-server',
        owner: 'bob',
        visibility: 'private',
        status: 'connected',
        enabled: true,
        error: null,
        tools: [{ name: 'private-server::secret' }],
        prompts: [],
        resources: [],
        client: { callTool },
        createTime: 0,
      } as any,
    ]);

    const result = await mcpService.handleCallToolRequest(
      { params: { name: 'private-server::secret', arguments: {} } },
      { sessionId: '' },
    );

    expect(callTool).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it('rejects a direct server route when its server is not visible to the user', async () => {
    currentUser = { username: 'alice', isAdmin: false };
    const callTool = jest.fn().mockResolvedValue({ content: [], isError: false });
    mcpService.setServerInfosForTest([
      {
        name: 'private-server',
        owner: 'bob',
        visibility: 'private',
        status: 'connected',
        enabled: true,
        error: null,
        tools: [{ name: 'private-server::secret' }],
        prompts: [],
        resources: [],
        client: { callTool },
        createTime: 0,
      } as any,
    ]);

    const result = await mcpService.handleCallToolRequest(
      {
        params: {
          name: 'call_tool',
          arguments: { toolName: 'private-server::secret', arguments: {} },
        },
      },
      { sessionId: 'session-1', server: 'private-server' },
    );

    expect(callTool).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it('rejects a direct prompt request when its server is not visible to the user', async () => {
    currentUser = { username: 'alice', isAdmin: false };
    const getPrompt = jest.fn().mockResolvedValue({ messages: [] });
    mcpService.setServerInfosForTest([
      {
        name: 'private-server',
        owner: 'bob',
        visibility: 'private',
        status: 'connected',
        enabled: true,
        error: null,
        tools: [],
        prompts: [{ name: 'private-server::secret-prompt' }],
        resources: [],
        client: { getPrompt },
        createTime: 0,
      } as any,
    ]);

    const result = await mcpService.handleGetPromptRequest(
      { params: { name: 'private-server::secret-prompt', arguments: {} } },
      { sessionId: 'session-1', server: 'private-server' },
    );

    expect(getPrompt).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it('allows a guessed global tool call when the server is explicitly shared', async () => {
    currentUser = { username: 'alice', isAdmin: false };
    const callTool = jest.fn().mockResolvedValue({ content: [], isError: false });
    mcpService.setServerInfosForTest([
      {
        name: 'shared-server',
        owner: 'bob',
        visibility: 'group',
        sharedWithUsers: ['alice'],
        status: 'connected',
        enabled: true,
        error: null,
        tools: [{ name: 'shared-server::allowed' }],
        prompts: [],
        resources: [],
        client: { callTool },
        createTime: 0,
      } as any,
    ]);

    const result = await mcpService.handleCallToolRequest(
      { params: { name: 'shared-server::allowed', arguments: {} } },
      { sessionId: '' },
    );

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
  });
});
