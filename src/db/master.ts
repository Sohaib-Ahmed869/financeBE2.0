import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../lib/logger';

mongoose.set('strictQuery', true);

let connecting: Promise<typeof mongoose> | null = null;

export async function connectMaster(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (connecting) return connecting;

  connecting = mongoose
    .connect(env.MASTER_MONGO_URI, {
      autoIndex: true,
      serverSelectionTimeoutMS: 10_000,
    })
    .then((m) => {
      logger.info({ uri: redactUri(env.MASTER_MONGO_URI) }, 'master.mongo.connected');
      return m;
    })
    .catch((err) => {
      logger.error({ err }, 'master.mongo.connect_failed');
      connecting = null;
      throw err;
    });

  return connecting;
}

export async function disconnectMaster(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  connecting = null;
  logger.info('master.mongo.disconnected');
}

function redactUri(uri: string): string {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:[redacted]@');
}
