import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('returns the global filter error shape for unmapped routes', () => {
    return request(app.getHttpServer())
      .get('/does-not-exist')
      .expect(404)
      .expect((res) => {
        const body = res.body as {
          statusCode: number;
          path: string;
          timestamp: string;
        };
        expect(body.statusCode).toBe(404);
        expect(body.path).toBe('/does-not-exist');
        expect(body.timestamp).toEqual(expect.any(String));
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
