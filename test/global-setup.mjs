import mongoose from 'mongoose';

/**
 * Picks a MongoDB for the e2e run and gives it a unique, throw-away database name:
 *  1. E2E_MONGO_URI if set (e.g. a CI service container),
 *  2. a local MongoDB on 127.0.0.1:27017 if one is running,
 *  3. otherwise an in-memory server (mongodb-memory-server; downloads a binary on first use).
 */
export default async function globalSetup() {
  let baseUri = process.env.E2E_MONGO_URI;

  if (!baseUri) {
    const client = new mongoose.mongo.MongoClient('mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 1500 });
    try {
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      baseUri = 'mongodb://127.0.0.1:27017';
    } catch {
      const { MongoMemoryServer } = await import('mongodb-memory-server');
      const server = await MongoMemoryServer.create();
      globalThis.__MONGO_MEMORY_SERVER__ = server;
      baseUri = server.getUri();
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  const dbName = `hcm_lite_e2e_${Date.now()}_${process.pid}`;
  const url = new URL(baseUri);
  url.pathname = `/${dbName}`;
  process.env.E2E_DATABASE_URL = url.toString();
  process.env.E2E_DB_NAME = dbName;
}
