import mongoose from 'mongoose';

/** Drops the throw-away e2e database and stops the in-memory server if one was started. */
export default async function globalTeardown() {
  const uri = process.env.E2E_DATABASE_URL;
  if (uri && process.env.E2E_DB_NAME?.startsWith('hcm_lite_e2e_')) {
    const client = new mongoose.mongo.MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
    try {
      await client.connect();
      await client.db(process.env.E2E_DB_NAME).dropDatabase();
    } catch {
      // nothing to clean up
    } finally {
      await client.close().catch(() => undefined);
    }
  }
  await globalThis.__MONGO_MEMORY_SERVER__?.stop();
}
