import neo4j, { type Driver } from "neo4j-driver";
import { config } from "../config.ts";

export async function inicializarConexionNeo() {
  try {
    const driver: Driver = neo4j.driver(
      config.NEO_4J_URI,
      neo4j.auth.basic(config.NEO_4J_USER, config.NEO_4J_PASSWORD),
    );

    await driver.verifyConnectivity();

    const session = driver.session({ database: config.NEO_4J_DATABASE });

    return { driver, session };
  } catch (err) {
    console.log(err);
    throw err;
  }
}
