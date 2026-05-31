type EnvSource = Record<string, string | undefined>;

const env: EnvSource =
  typeof Bun !== "undefined" && Bun.env ? Bun.env : process.env;

const required = (key: string): string => {
  const value = env[key];

  if (value == null || value === "") {
    throw new Error(`Missing environment variable: ${key}`);
  }

  return value;
};

const optional = (key: string): string => env[key] ?? "";

const toNumber = (value: string, key: string): number => {
  const parsed = Number(value.replaceAll("_", ""));

  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid numeric environment variable: ${key}`);
  }

  return parsed;
};

export const config = {
  MONGO_URI: required("MONGO_URI"),
  MONGO_DB_NAME: required("MONGO_DB_NAME"),

  NEO_4J_URI: required("NEO_4J_URI"),
  NEO_4J_USER: required("NEO_4J_USER"),
  NEO_4J_PASSWORD: required("NEO_4J_PASSWORD"),
  NEO_4J_DATABASE: required("NEO_4J_DATABASE"),

  REDIS_HOST: required("REDIS_HOST"),
  REDIS_PORT: toNumber(required("REDIS_PORT"), "REDIS_PORT"),
  REDIS_USER: required("REDIS_USER"),
  REDIS_PASSWORD: optional("REDIS_PASSWORD"),

  LIMITE_DIARIO: toNumber(required("LIMITE_DIARIO"), "LIMITE_DIARIO"),
} as const;

export type Config = typeof config;
