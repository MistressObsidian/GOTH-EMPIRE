import { createWorker } from '../../cloudflare/handler.mjs';

// No network database or email transport is used by this runtime fixture.
const worker = createWorker({
  async connectDatabase({ connectionString: mode }) {
    let closed = false;
    const user = {
      id: mode, name: `Runtime ${mode}`, email: `${mode}@example.test`,
      role: mode === 'admin' ? 'admin' : 'member', tier: mode === 'pending' ? 'observer' : 'supporter',
      membership_until: '2099-01-01T00:00:00Z', selected_plan: 'supporter', adult_confirmed: true,
      salt: 'cloudflare-test-salt',
      hash: 'e08db301f31b3c6a96e77055a5eb469e0cc1c6decae0f7f86159ea1ea6fce864191cd41eed25f076bb4b1327457bf3f950e2a8d9949b84b60f374aabd7f73779'
    };
    const db = {
      tables: { users: 'runtime_users', sessions: 'runtime_sessions' },
      async query(sql) {
        if (closed) throw new Error('A request reused a closed database.');
        await new Promise(resolve => setTimeout(resolve, mode === 'admin' ? 3 : 1));
        if (mode === 'outage') throw Object.assign(new Error('Unavailable'), { code: '08006' });
        if (/SELECT u\.\*|SELECT \* FROM runtime_users/.test(sql)) return { rows: [user], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      async transaction(action) { return action(db); },
      async close() { closed = true; }
    };
    return db;
  }
});

export default {
  fetch(request, env, ctx) {
    // Wrangler's HTTP preview rewrites HTTPS Origin headers to HTTP.
    // Restore only this fixture's canonical origin; other origins still fail.
    if (request.headers.get('origin') === 'http://goth.example.test') {
      request = new Request(request);
      request.headers.set('Origin', 'https://goth.example.test');
    }
    return worker.fetch(request, {
      ...env, APP_ORIGIN: 'https://goth.example.test',
      DATABASE_URL_POOLED: new URL(request.url).searchParams.get('fixture') || 'paid',
      RESEND_API_KEY: '', PAYMENT_EMAIL_FROM: ''
    }, ctx);
  }
};
