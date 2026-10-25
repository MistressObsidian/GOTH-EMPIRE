import { randomUUID } from 'node:crypto';
import { openDatabase, quoteSchema } from '../database.mjs';

export async function createTestDatabase() {
  const schema = `goth_empire_test_${randomUUID().replaceAll('-', '')}`;
  const db = await openDatabase({ schema });
  return {
    db, options: { schema }, appOptions: { paymentEmailSender: null },
    async cleanup() {
      try {
        // Only the randomly named schema created for this test may be removed.
        if (!/^goth_empire_test_[a-f0-9]{32}$/.test(schema) || db.schema !== schema) throw new Error('Refusing to remove a non-test schema.');
        await db.query(`DROP SCHEMA ${quoteSchema(schema)} CASCADE`);
      } finally { await db.close(); }
    }
  };
}
