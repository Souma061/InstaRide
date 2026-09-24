import { Redis, RedisOptions } from "ioredis";
import "dotenv/config";
const REDIS_PORT = Number(process.env.REDIS_PORT) || 6379;
const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;

const redisOptions: RedisOptions = {
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  maxRetriesPerRequest: null, // Disable automatic retries
  lazyConnect: true, // Connect only when needed
  retryStrategy(times: number) {
    const delay = Math.min(times * 100, 2000);
    return delay;
  },
};

export const redis = new Redis(redisOptions);

redis.on("connect", () => {
  console.log(`[Redis] Connected to ${REDIS_HOST} : ${REDIS_PORT}`);
});

redis.on("error", (err) => {
  console.error(`[Redis] Error: ${err.message}`);
});

export async function connectRedis(): Promise<void> {
  if (redis.status === "wait") {
    await redis.connect();
  }
}
export async function disconnectRedis(): Promise<void> {
  if (redis.status === "ready" || redis.status === "connecting") {
    await redis.quit();
  }
}
