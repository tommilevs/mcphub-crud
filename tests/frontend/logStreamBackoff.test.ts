const mockToken=jest.fn(()=> 'test-token' as string|null);
const mockSkipAuth=jest.fn(async()=>false);
jest.mock('../../frontend/src/services/configService',()=>({shouldSkipAuth:()=>mockSkipAuth()}));
jest.mock('../../frontend/src/utils/fetchInterceptor', () => ({
  apiGet: jest.fn(),
  apiDelete: jest.fn(),
}));

jest.mock('../../frontend/src/utils/runtime', () => ({
  getApiUrl: (path: string) => `http://localhost:3000/api${path}`,
}));

jest.mock('../../frontend/src/utils/interceptors', () => ({
  getToken: () => mockToken(),
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }
}

describe('LogStreamManager reconnect backoff', () => {
  beforeEach(() => {
    jest.resetModules();
    mockToken.mockReturnValue('test-token');
    mockSkipAuth.mockReset().mockResolvedValue(false);
    jest.useFakeTimers();
    FakeEventSource.instances = [];
    (global as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  });

  afterEach(() => {
    jest.useRealTimers();
    delete (global as unknown as { EventSource?: unknown }).EventSource;
  });

  it('backs off exponentially when the stream never opens', async () => {
    const { logStreamManager } = await import('../../frontend/src/services/logService');
    const unsubscribe = logStreamManager.subscribe(() => {});

    expect(FakeEventSource.instances).toHaveLength(1);

    // First failure: reconnect after 1s.
    FakeEventSource.instances[0].onerror?.();
    jest.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    // Second failure: the delay must grow to 2s rather than staying at 1s.
    FakeEventSource.instances[1].onerror?.();
    jest.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    jest.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(3);

    unsubscribe();
  });

  it('resets the backoff only after the connection actually opens', async () => {
    const { logStreamManager } = await import('../../frontend/src/services/logService');
    const unsubscribe = logStreamManager.subscribe(() => {});

    // Burn one step of backoff.
    FakeEventSource.instances[0].onerror?.();
    jest.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);

    // This attempt genuinely opens, so the next failure starts from 1s again.
    FakeEventSource.instances[1].onopen?.();
    FakeEventSource.instances[1].onerror?.();
    jest.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(3);

    unsubscribe();
  });
  it('opens the stream without a token when dashboard authentication is disabled', async()=>{
    mockToken.mockReturnValue(null);mockSkipAuth.mockResolvedValue(true);
    const {logStreamManager}=await import('../../frontend/src/services/logService');
    const unsubscribe=logStreamManager.subscribe(()=>{});
    await Promise.resolve();await Promise.resolve();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe('http://localhost:3000/api/logs/stream');
    unsubscribe();
  });
  it('does not open an unauthenticated stream when a token is required', async()=>{
    mockToken.mockReturnValue(null);
    const {logStreamManager}=await import('../../frontend/src/services/logService');
    const unsubscribe=logStreamManager.subscribe(()=>{});
    await Promise.resolve();await Promise.resolve();
    expect(FakeEventSource.instances).toHaveLength(0);
    unsubscribe();
  });

  it('ignores authentication lookup after the final subscriber leaves', async()=>{
    let resolveAuth!:(value:boolean)=>void;
    mockToken.mockReturnValue(null);
    mockSkipAuth.mockReturnValue(new Promise<boolean>(resolve=>{resolveAuth=resolve;}));
    const {logStreamManager}=await import('../../frontend/src/services/logService');
    const unsubscribe=logStreamManager.subscribe(()=>{});
    unsubscribe();resolveAuth(true);
    await Promise.resolve();await Promise.resolve();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('keeps token authentication and encodes its query value without a config lookup', async()=>{
    mockToken.mockReturnValue('token&second=value');
    const {logStreamManager}=await import('../../frontend/src/services/logService');
    const unsubscribe=logStreamManager.subscribe(()=>{});
    expect(FakeEventSource.instances[0].url).toBe('http://localhost:3000/api/logs/stream?token=token%26second%3Dvalue');
    expect(mockSkipAuth).not.toHaveBeenCalled();
    unsubscribe();
  });

});
