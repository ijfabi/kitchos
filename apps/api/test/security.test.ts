import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, login, PASSWORD, restaurantId, startHarness, type Harness } from './harness.ts';

describe('authentication, authorisation and tenant isolation', () => {
  let h: Harness;
  let central: string;
  let drive: string;
  let rival: string;

  beforeAll(async () => {
    h = await startHarness();
    central = await restaurantId(h, 'kitchos-central');
    drive = await restaurantId(h, 'kitchos-drive');
    rival = await restaurantId(h, 'rival-southbank');
  });
  afterAll(() => h.close());

  it('rejects bad credentials, missing tokens and forged tokens', async () => {
    const bad = await h.http
      .post('/v1/auth/login')
      .send({ email: 'manager@central.kitchos.test', password: 'wrong' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    const unknown = await h.http
      .post('/v1/auth/login')
      .send({ email: 'nobody@kitchos.test', password: PASSWORD });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe(bad.body.error.message); // no account enumeration

    expect((await h.http.get('/v1/me')).status).toBe(401);
    const forged =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4Iiwib3JnIjoieSIsInR5cCI6InN0YWZmIn0.c2lnbmF0dXJlLWZvcmdlZA';
    expect((await h.http.get('/v1/me').set(bearer(forged))).status).toBe(401);
  });

  it('describes only the restaurants a user is scoped to', async () => {
    const crew = await login(h, 'crew1@central.kitchos.test');
    const me = await h.http.get('/v1/me').set(bearer(crew)).expect(200);
    expect(me.body.restaurants.map((r: { slug: string }) => r.slug)).toEqual(['kitchos-central']);

    const area = await login(h, 'area.cbd@kitchos.test');
    const areaMe = await h.http.get('/v1/me').set(bearer(area)).expect(200);
    expect(areaMe.body.restaurants.map((r: { slug: string }) => r.slug).sort()).toEqual([
      'kitchos-central',
      'kitchos-express',
    ]);

    const admin = await login(h, 'admin@kitchos.test');
    const adminMe = await h.http.get('/v1/me').set(bearer(admin)).expect(200);
    expect(adminMe.body.restaurants).toHaveLength(3);
  });

  it('cross-tenant access is indistinguishable from a missing restaurant', async () => {
    const rivalManager = await login(h, 'manager@rival.test');
    const res = await h.http
      .get(`/v1/restaurants/${central}/kitchen/tasks`)
      .set(bearer(rivalManager));
    expect(res.status).toBe(404);
    const admin = await login(h, 'admin@kitchos.test');
    expect((await h.http.get(`/v1/restaurants/${rival}/orders`).set(bearer(admin))).status).toBe(
      404,
    );
    expect(
      (await h.http.get(`/v1/restaurants/${rival}/inventory/balances`).set(bearer(admin))).status,
    ).toBe(404);
  });

  it('cross-store access within a tenant follows role scopes', async () => {
    const expressCrew = await login(h, 'crew1@express.kitchos.test');
    expect(
      (await h.http.get(`/v1/restaurants/${central}/kitchen/tasks`).set(bearer(expressCrew)))
        .status,
    ).toBe(404);

    const area = await login(h, 'area.cbd@kitchos.test');
    expect((await h.http.get(`/v1/restaurants/${central}/orders`).set(bearer(area))).status).toBe(
      200,
    );
    expect((await h.http.get(`/v1/restaurants/${drive}/orders`).set(bearer(area))).status).toBe(
      404,
    ); // other region
  });

  it('enforces fine-grained permissions within a restaurant', async () => {
    const crew = await login(h, 'crew1@central.kitchos.test');
    expect(
      (await h.http.get(`/v1/restaurants/${central}/inventory/balances`).set(bearer(crew))).status,
    ).toBe(403);
    const supervisor = await login(h, 'supervisor@central.kitchos.test');
    const balances = await h.http
      .get(`/v1/restaurants/${central}/inventory/balances`)
      .set(bearer(supervisor));
    expect(balances.status).toBe(200);
    expect(balances.body.length).toBeGreaterThan(10);

    const auditor = await login(h, 'auditor@kitchos.test');
    const fakeTask = '00000000-0000-4000-8000-000000000000';
    const op = await h.http
      .post(`/v1/restaurants/${central}/kitchen/tasks/${fakeTask}/start`)
      .set(bearer(auditor))
      .send({});
    expect(op.status).toBe(403); // read-only role
  });

  it('validates path parameters and request bodies', async () => {
    const crew = await login(h, 'crew1@central.kitchos.test');
    expect(
      (await h.http.get('/v1/restaurants/not-a-uuid/kitchen/tasks').set(bearer(crew))).status,
    ).toBe(404);
    const noKey = await h.http
      .post('/v1/public/restaurants/kitchos-central/orders')
      .send({ fulfilmentType: 'takeaway', lines: [] });
    expect(noKey.status).toBe(400);
  });

  it('rate-limits repeated failed logins', async () => {
    const attempts = [];
    for (let i = 0; i < 11; i++) {
      attempts.push(
        (
          await h.http
            .post('/v1/auth/login')
            .send({ email: 'crew2@drive.kitchos.test', password: 'nope' })
        ).status,
      );
    }
    expect(attempts.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(attempts[10]).toBe(429);
  });
});
