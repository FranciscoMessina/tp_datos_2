import { type Db, MongoClient } from "mongodb";
import { config } from "../config.ts";

const Colecciones = {
  Transacciones: "transacciones",
  Clientes: "clientes",
  Cuentas: "cuentas",
  AlertasFraude: "alertas",
};

export async function inicializarConexionABaseDeDatos() {
  // Inicializamos la conexion a la base de datos
  try {
    const mongoClient = new MongoClient(config.MONGO_URI);

    await mongoClient.connect();

    return {
      db: mongoClient.db(config.MONGO_DB_NAME),
      client: mongoClient,
    };
  } catch (error) {
    console.error("No se logro conectar a la base de datos", error);
    process.exit();
  }
}

export async function crearColeccionesConValidacion(db: Db) {
  // Aca definimos validaciones para los documentos. Esto siempre tiene que ejecutarse antes de insertar cualquier documento.
  await db.createCollection(Colecciones.Transacciones, {
    validator: {
      // Queremos que cumpla todas las condiciones dentro del AND.
      $and: [
        // Definimos con JSONSchema, que campos son requeridos,
        // y los tipos de datos de los mismos.
        {
          $jsonSchema: {
            bsonType: "object",
            title: "Validacion de Transaccion",
            // No validamos cuentaOrigen ni cuentaDestino porque todavia no definimos
            // bien como la logica de negocio haria que se comporten, por ahora tratamos
            // como que siempre tiene que existir cuentaOrigen, pero no siempre cuentaDestino.
            // Pero lo dejamos abierto para modificacion a futuro.
            required: ["tipo", "monto", "canal", "fecha"],
            properties: {
              tipo: {
                // Tiene que ser un string, y uno de los valores en la lista enum
                bsonType: "string",
                enum: ["debito", "credito", "transferencia", "servicio"],
              },
              canal: {
                // Tiene que ser un string, y uno de los valores en la lista enum
                bsonType: "string",
                enum: ["app", "cajero", "sucursal"],
              },
              monto: {
                bsonType: "number",
              },
              fecha: {
                bsonType: "date",
              },
              descripcion: {
                bsonType: "string",
              },
            },
          },
        },
        // Queremos evitar que una transferencia se pueda realizar
        // con la misma cuenta origen y destino.
        {
          $expr: {
            $ne: ["$cuentaOrigenId", "$cuentaDestinoId"],
          },
        },
      ],
    },
  });

  await db.createCollection(Colecciones.Clientes, {
    validator: {
      $jsonSchema: {
        bsonType: "object",
        title: "Validacion de Cliente",
        required: [
          "nombre",
          "documento",
          "tipo",
          "fechaDeAlta",
          "scoreCrediticio",
          "domicilio",
        ],
        properties: {
          nombre: {
            bsonType: "string",
          },
          documento: {
            bsonType: "string",
          },
          tipo: {
            bsonType: "string",
            enum: ["personaFisica", "empresa"],
          },
          fechaDeAlta: {
            bsonType: "date",
          },
          scoreCrediticio: {
            bsonType: "number",
          },
          domicilio: {
            bsonType: "object",
            required: ["calle", "altura", "localidad", "provincia", "pais"],
            properties: {
              calle: {
                bsonType: "string",
              },
              altura: {
                bsonType: "number",
              },
              localidad: {
                bsonType: "string",
              },
              provincia: {
                bsonType: "string",
              },
              pais: {
                bsonType: "string",
              },
            },
          },
        },
      },
    },
  });

  await db.createCollection(Colecciones.Cuentas, {
    validator: {
      $jsonSchema: {
        bsonType: "object",
        title: "Validacion de Cuenta",
        required: [
          "numero",
          "tipo",
          "moneda",
          "saldoActual",
          "estado",
          "clienteTitularId",
        ],
        properties: {
          numero: {
            bsonType: "string",
          },
          tipo: {
            bsonType: "string",
            enum: ["cajaDeAhorro", "cuentaCorriente", "inversion"],
          },
          moneda: {
            bsonType: "string",
            enum: ["ARS"],
          },
          saldoActual: {
            bsonType: "number",
          },
          estado: {
            bsonType: "string",
            enum: ["activa", "bloqueada"],
          },
          clienteTitularId: {
            bsonType: "string",
          },
        },
      },
    },
  });

  await db.createCollection(Colecciones.AlertasFraude, {
    validator: {
      $jsonSchema: {
        bsonType: "object",
        title: "Validacion de Alerta de Fraude",
        required: ["idTransaccion", "tipo", "nivelRiesgo", "estado", "fecha"],
        properties: {
          idTransaccion: {
            bsonType: "string",
          },
          tipo: {
            bsonType: "string",
          },
          nivelRiesgo: {
            bsonType: "int",
            enum: [1, 2, 3, 4, 5],
          },
          estado: {
            bsonType: "string",
            enum: ["pendiente", "investigando", "cerrada"],
          },
          fecha: {
            bsonType: "date",
          },
        },
      },
    },
  });
}

// Punto 3.1.3
export async function crearIndices(db: Db) {
  await db.collection(Colecciones.Transacciones).createIndexes([
    // Un indice para las ID de cuentas en cada transaccion.
    // Sirve para cuando hacemos busquedas de transacciones por ID de cuenta.
    { key: { cuentaOrigen: 1, fechaYHora: 1 } },
    { key: { cuentaDestino: 1, fechaYHora: 1 } },
    // Indice en cuentaOrigen y tipo para el lookup de la ultima transaccion de debito
    // Ordenado por fecha descendente.
    { key: { cuentaOrigen: 1, tipo: 1, fechaYHora: -1 } },
    // Indice para analisis de volumen de transferencias,
    // El monto lo incluimos para que mongo pueda buscar toda
    // la informacion directamente de memoria sin tener que buscar el documento
    // en disco.
    { key: { tipo: 1, fechaYHora: 1, monto: 1 }, name: "Indice bla" },
  ]);

  // Indice para buscar cuentas con saldos negativos.
  await db.collection(Colecciones.Cuentas).createIndex({
    saldoActual: 1,
  });

  // Indice unico en numero de Cuenta (No podemos tener mas de una cuenta con el mismo numero.)
  await db.collection(Colecciones.Cuentas).createIndex(
    {
      numero: 1,
    },
    { unique: true },
  );

  // Indice para buscar alertas por tipo, ordenadas por riesgo descendiente
  await db.collection(Colecciones.AlertasFraude).createIndex({
    estado: 1,
    nivelRiesgo: -1,
  });
}
