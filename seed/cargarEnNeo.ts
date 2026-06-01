import neo4j, { Driver, int } from "neo4j-driver";
import { readFileSync } from "node:fs";
import { inicializarConexionNeo } from "./neo4j.ts";

// Definición de la estructura del JSON de entrada
interface DataSnapshot {
  clientes: any[];
  cuentas: any[];
  tarjetas: any[];
  transacciones: any[];
}

async function cargarDatosANeo4j() {
  const { driver, session } = await inicializarConexionNeo();

  try {
    console.log("Iniciando migración a Neo4j...");

    const rawData = readFileSync("./seed/banco_data.json", "utf-8");
    const data = JSON.parse(rawData);

    console.log("Limpiando base de datos existente...");
    await session.run(`MATCH (n) DETACH DELETE n`);

    // 1. Cargar Clientes
    const res1 = await session.run(
      `
      UNWIND $clientes AS c
      MERGE (cliente:Cliente {id: c._id})
      SET cliente.nombre = c.nombre,
          cliente.documento = c.documento,
          cliente.tipo = c.tipo,
          cliente.fechaDeAlta = datetime(c.fechaDeAlta),
          cliente.scoreCrediticio = c.scoreCrediticio,
          cliente.sospechoso = c.sospechoso
    `,
      { clientes: data.clientes },
    );

    // 2. Cargar Cuentas y crear relación TIENE_CUENTA
    await session.run(
      `
      UNWIND $cuentas AS c
      MERGE (cuenta:Cuenta {id: c._id})
      SET cuenta.numero = c.numero,
          cuenta.tipo = c.tipo,
          cuenta.moneda = c.moneda,
          cuenta.saldoActual = c.saldoActual,
          cuenta.estado = c.estado
      WITH cuenta, c
      MATCH (cliente:Cliente {id: c.clienteTitularId})
      MERGE (cliente)-[r:TIENE_CUENTA]->(cuenta)
    `,
      {
        cuentas: data.cuentas,
      },
    );

    // 3. Cargar Tarjetas y crear relaciones TIENE_TARJETA (con Cliente) y ASOCIADA_A (con Cuenta)
    await session.run(
      `
      UNWIND $tarjetas AS t
      MERGE (tarjeta:Tarjeta {id: t._id})
      SET tarjeta.numeroEnmascarado = t.numeroEnmascarado,
          tarjeta.tipo = t.tipo,
          tarjeta.limite = t.limite,
          tarjeta.fechaVencimiento = datetime(t.fechaVencimiento),
          tarjeta.estado = t.estado
      WITH tarjeta, t
      // Relación con el Cliente (asumiendo que el cliente se obtiene a través de la cuenta o está en el JSON)
      MATCH (cuenta:Cuenta {numero: t.cuentaId})
      MATCH (cliente:Cliente)-[:TIENE_CUENTA]->(cuenta)
      MERGE (cliente)-[:TIENE_TARJETA]->(tarjeta)
      MERGE (tarjeta)-[:ASOCIADA_A]->(cuenta)
    `,
      { tarjetas: data.tarjetas },
    );

    // 4. Cargar Transacciones como relación directa entre Cuentas
    await session.run(
      `
      UNWIND $transacciones AS tx
      MATCH (origen:Cuenta {id: tx.cuentaOrigenId})
      MATCH (destino:Cuenta {id: tx.cuentaDestinoId})
      MERGE (origen)-[r:TRANSFIRIO {_id: tx._id}]->(destino)
      SET r.monto = tx.monto,
          r.fecha = datetime(tx.fecha),
          r.canal = tx.canal,
          r.tipo = tx.tipo
    `,
      {
        transacciones: data.transacciones.filter(
          (tx: any) => tx.tipo === "transferencia",
        ),
      },
    );

    console.log("Migración finalizada exitosamente.");
  } catch (error) {
    console.error("Error en la carga:", error);
  } finally {
    await session.close();
    await driver.close();
  }
}

cargarDatosANeo4j();
