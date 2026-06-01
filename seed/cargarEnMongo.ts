import type {
  AlertaFraude,
  Cliente,
  Tarjeta,
  Transaccion,
} from "../estructura-datos";
import {
  crearColeccionesConValidacion,
  crearIndices,
  inicializarConexionABaseDeDatos,
} from "./mongodb.ts";
import { readFileSync } from "node:fs";

async function cargarDatos() {
  const { db, client } = await inicializarConexionABaseDeDatos();
  try {
    // Opcional: Limpiar la base de datos antes de cargar para evitar duplicados
    // si corrés el script varias veces.
    console.log("Limpiando base de datos anterior...");
    await db.dropDatabase();

    await crearColeccionesConValidacion(db);

    await crearIndices(db);

    // Leer y parsear el archivo JSON
    console.log("Leyendo archivo banco_data.json...");
    const rawData = readFileSync("./seed/banco_data.json", "utf-8");
    const data = JSON.parse(rawData);

    // 1. Cargar Clientes
    if (data.clientes && data.clientes.length > 0) {
      const clientes = data.clientes.map((c: Cliente) => ({
        ...c,
        fechaDeAlta: new Date(c.fechaDeAlta), // Reconversión a Date
      }));
      const result = await db.collection("clientes").insertMany(clientes);
      console.log(`📁 ${result.insertedCount} clientes insertados.`);
    }

    // 2. Cargar Cuentas
    if (data.cuentas && data.cuentas.length > 0) {
      const result = await db.collection("cuentas").insertMany(data.cuentas);
      console.log(`📁 ${result.insertedCount} cuentas insertadas.`);
    }

    // 3. Cargar Tarjetas
    if (data.tarjetas && data.tarjetas.length > 0) {
      const tarjetas = data.tarjetas.map((t: Tarjeta) => ({
        ...t,
        fechaVencimiento: new Date(t.fechaVencimiento), // Reconversión a Date
      }));
      const result = await db.collection("tarjetas").insertMany(tarjetas);
      console.log(`📁 ${result.insertedCount} tarjetas insertadas.`);
    }

    // 4. Cargar Transacciones
    if (data.transacciones && data.transacciones.length > 0) {
      const transacciones = data.transacciones.map((t: Transaccion) => ({
        ...t,
        fecha: new Date(t.fecha), // Reconversión a Date
      }));
      const result = await db
        .collection("transacciones")
        .insertMany(transacciones);
      console.log(`📁 ${result.insertedCount} transacciones insertadas.`);
    }

    // 5. Cargar Alertas de Fraude
    if (data.alertas && data.alertas.length > 0) {
      const alertas = data.alertas.map((a: AlertaFraude) => ({
        ...a,
        fecha: new Date(a.fecha), // Reconversión a Date
      }));
      const result = await db.collection("alertas").insertMany(alertas);
      console.log(`📁 ${result.insertedCount} alertas de fraude insertadas.`);
    }

    // 6. Cargar Beneficiarios
    if (data.beneficiarios && data.beneficiarios.length > 0) {
      const result = await db
        .collection("beneficiarios")
        .insertMany(data.beneficiarios);
      console.log(`📁 ${result.insertedCount} beneficiarios insertados.`);
    }

    console.log("🚀 ¡Carga de datos en MongoDB completada con éxito!");
  } catch (error) {
    console.error("❌ Error durante la carga de datos:", error);
  } finally {
    // Asegurar que la conexión se cierre al terminar
    await client.close();
    console.log("Conexión cerrada.");
  }
}

cargarDatos();
