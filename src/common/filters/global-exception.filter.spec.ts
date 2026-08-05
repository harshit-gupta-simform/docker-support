import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { GlobalExceptionFilter } from './global-exception.filter';

function createHost(request: Partial<Request>, response: Partial<Response>) {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let errorMock: jest.Mock;
  let statusMock: jest.Mock;
  let jsonMock: jest.Mock;
  let response: Partial<Response>;
  let request: Partial<Request>;

  beforeEach(() => {
    errorMock = jest.fn();
    const logger = {
      setContext: jest.fn(),
      error: errorMock,
    } as unknown as PinoLogger;
    filter = new GlobalExceptionFilter(logger);

    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    response = { status: statusMock };
    request = { url: '/some-path' };
  });

  it('maps an HttpException to its own status and response body', () => {
    const exception = new HttpException('Forbidden', HttpStatus.FORBIDDEN);

    filter.catch(exception, createHost(request, response));

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.FORBIDDEN,
        path: '/some-path',
        message: 'Forbidden',
      }),
    );
  });

  it('maps an unknown error to a 500 with a generic message', () => {
    const exception = new Error('boom');

    filter.catch(exception, createHost(request, response));

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        path: '/some-path',
        message: 'Internal server error',
      }),
    );
  });

  it('logs every exception before responding', () => {
    filter.catch(new Error('boom'), createHost(request, response));

    expect(errorMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/some-path' }),
      'Unhandled exception',
    );
  });
});

describe('GlobalExceptionFilter (DI resolution)', () => {
  it('is resolved by the Nest DI container when registered via APP_FILTER', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        {
          provide: PinoLogger,
          useValue: { setContext: jest.fn(), error: jest.fn() },
        },
        GlobalExceptionFilter,
        {
          provide: APP_FILTER,
          useClass: GlobalExceptionFilter,
        },
      ],
    }).compile();

    const filter = moduleRef.get(GlobalExceptionFilter);

    expect(filter).toBeInstanceOf(GlobalExceptionFilter);
  });
});
