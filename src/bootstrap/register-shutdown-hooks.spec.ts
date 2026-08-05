import { registerGracefulShutdown } from './register-shutdown-hooks';

describe('registerGracefulShutdown', () => {
  let onSpy: jest.SpiedFunction<typeof process.on>;
  let exitSpy: jest.SpiedFunction<typeof process.exit>;
  let logger: { log: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    onSpy = jest.spyOn(process, 'on').mockImplementation(() => process);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    logger = { log: jest.fn(), error: jest.fn() };
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function getHandler(signal: string): () => void {
    const call = onSpy.mock.calls.find(([sig]) => sig === signal);
    if (!call) {
      throw new Error(`No handler registered for ${signal}`);
    }
    return call[1] as () => void;
  }

  it('registers handlers for SIGTERM and SIGINT', () => {
    registerGracefulShutdown(logger as never, 10000);

    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  it('force-exits 1 if the process has not exited within the deadline', () => {
    registerGracefulShutdown(logger as never, 10000);

    getHandler('SIGTERM')();
    jest.advanceTimersByTime(10000);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('ignores a second signal received while already shutting down', () => {
    registerGracefulShutdown(logger as never, 10000);

    getHandler('SIGTERM')();
    getHandler('SIGINT')();

    expect(logger.log).toHaveBeenCalledTimes(1);
  });
});
