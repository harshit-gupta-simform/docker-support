import { registerProcessCrashHandlers } from './register-process-crash-handlers';

describe('registerProcessCrashHandlers', () => {
  let onSpy: jest.SpiedFunction<typeof process.on>;
  let exitSpy: jest.SpiedFunction<typeof process.exit>;
  let logger: { error: jest.Mock };

  beforeEach(() => {
    onSpy = jest.spyOn(process, 'on').mockImplementation(() => process);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    logger = { error: jest.fn() };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function getHandler(event: string): (...args: unknown[]) => void {
    const call = onSpy.mock.calls.find(([name]) => name === event);
    if (!call) {
      throw new Error(`No handler registered for ${event}`);
    }
    return call[1] as (...args: unknown[]) => void;
  }

  it('registers handlers for unhandledRejection and uncaughtException', () => {
    registerProcessCrashHandlers(logger as never);

    expect(onSpy).toHaveBeenCalledWith(
      'unhandledRejection',
      expect.any(Function),
    );
    expect(onSpy).toHaveBeenCalledWith(
      'uncaughtException',
      expect.any(Function),
    );
  });

  it('logs and exits 1 on an unhandled rejection', () => {
    registerProcessCrashHandlers(logger as never);

    getHandler('unhandledRejection')(new Error('boom'));

    expect(logger.error).toHaveBeenCalledWith(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() is typed `any` by @types/jest
      expect.objectContaining({ err: expect.any(Error) }),
      'Unhandled promise rejection',
      'Bootstrap',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('logs and exits 1 on an uncaught exception', () => {
    registerProcessCrashHandlers(logger as never);

    getHandler('uncaughtException')(new Error('boom'));

    expect(logger.error).toHaveBeenCalledWith(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() is typed `any` by @types/jest
      expect.objectContaining({ err: expect.any(Error) }),
      'Uncaught exception',
      'Bootstrap',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
