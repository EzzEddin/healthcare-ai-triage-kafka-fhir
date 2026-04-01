import Redis from "ioredis";
import { config } from "./config";

export const redisClient = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: 3,
  retryStrategy(times: number) {
    const delay = Math.min(times * 200, 2000);
    return delay;
  },
});

redisClient.on("connect", () => console.log("✅ Redis connected"));
redisClient.on("error", (err) => console.error("Redis error:", err));

// Pub/Sub channel for real-time updates (separate connection required by Redis)
export const redisSub = new Redis({
  host: config.redis.host,
  port: config.redis.port,
});

export async function publishToChannel(
  channel: string,
  message: Record<string, unknown>
): Promise<void> {
  await redisClient.publish(channel, JSON.stringify(message));
}
