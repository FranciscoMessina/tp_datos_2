import { type Db, MongoClient } from "mongodb";
import neo4j, { type Driver } from "neo4j-driver";
import { createClient, type RedisClientType } from "redis";
import { config } from "./config.ts";

export type AppContext = {
  mongo: MongoClient;
  db: Db;
  neo4j: Driver;
  redis: RedisClientType;
};

export const createContext = async (): Promise<AppContext> => {
  const mongo = new MongoClient(config.MONGO_URI);
  await mongo.connect();

  const driver = neo4j.driver(
    config.NEO_4J_URI,
    neo4j.auth.basic(config.NEO_4J_USER, config.NEO_4J_PASSWORD),
  );
  await driver.verifyConnectivity();

  const redis = createClient({
    username: config.REDIS_USER,
    password: config.REDIS_PASSWORD || undefined,
    socket: {
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
    },
  }) as RedisClientType;
  await redis.connect();

  return {
    mongo,
    db: mongo.db(config.MONGO_DB_NAME),
    neo4j: driver,
    redis,
  };
};

export const closeContext = async (ctx: AppContext): Promise<void> => {
  await Promise.allSettled([
    ctx.mongo.close(),
    ctx.neo4j.close(),
    ctx.redis.destroy(),
  ]);
};
