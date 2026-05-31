// @ts-nocheck
import type { Db } from "mongodb";

// Esto solo esta aca para que no moleste con errores de tipos el editor de codigo. Estas consultas son para copia al mongosh y ejecutarlas de ahi.
const db = null as unknown as Db;
// Creación de colecciones con validacion.
//

db.createCollection("transacciones", {
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
          $ne: ["$cuentaOrigen", "$cuentaDestino"],
        },
      },
    ],
  },
});

db.createCollection("clientes", {
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

db.createCollection("cuentas", {
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
        "idCliente",
      ],
      properties: {
        numero: {
          bsonType: "number",
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
        idCliente: {
          bsonType: "string",
        },
      },
    },
  },
});

db.createCollection("alertas", {
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

// Fin de creación de colecciones con validacion.

// Inicio de creacion de indices.

db.transacciones.createIndexes([
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

db.cuentas.createIndex({
  saldoActual: 1,
});

db.collection("cuentas").createIndex(
  {
    numero: 1,
  },
  { unique: true },
);

db.collection("alertas").createIndex({
  estado: 1,
  nivelRiesgo: -1,
});

// Fin de creacion de indices.

// Inicio Consulta 4a Extracto de cuenta
db.transacciones.aggregate([
  {
    $match: {
      $or: [
        {
          cuentaOrigen: 4235029839,
        },
        {
          cuentaDestino: 4235029839,
        },
      ],
      fecha: {
        $lte: new Date("Fri, 17 Apr 2026 03:00:00 GMT"),
      },
    },
  },
  {
    $addFields: {
      impactoSaldo: {
        $expr: {
          $cond: {
            if: {
              $eq: ["$cuentaOrigen", 4235029839],
            },
            then: {
              $multiply: ["$monto", -1],
            },
            else: "$monto",
          },
        },
      },
    },
  },
  {
    $setWindowFields: {
      sortBy: {
        fecha: 1,
      },
      output: {
        saldoAcumulado: {
          $sum: "$impactoSaldo",
          window: {
            documents: ["unbounded", "current"],
          },
        },
      },
    },
  },
  {
    $match: {
      fecha: {
        $gte: new Date("Tue, 03 Feb 2026 03:00:00 GMT"),
      },
    },
  },
  {
    $sort: {
      fecha: 1,
    },
  },
]);

// Fin consulta 4a.

// Inicio Consulta 4b transacciones inusualmente altas de un cliente

db.cuentas.aggregate([
  {
    $match: {
      idCliente: "be9dc40d-ecf0-486a-86d1-80b8d43b9758",
    },
  },
  {
    $lookup: {
      from: "transacciones",
      localField: "numero",
      foreignField: "cuentaOrigen",
      as: "historialTransacciones",
    },
  },
  {
    $group: {
      _id: "$idCliente",
      transaccionesDeTodasLasCuentas: {
        $push: "$historialTransacciones",
      },
    },
  },
  {
    $project: {
      transaccionesCombinadas: {
        $reduce: {
          input: "$transaccionesDeTodasLasCuentas",
          initialValue: [],
          in: {
            $concatArrays: ["$$value", "$$this"],
          },
        },
      },
    },
  },
  {
    $project: {
      promedioHistorico: {
        $avg: {
          $slice: [
            {
              $map: {
                input: "$transaccionesCombinadas",
                in: "$$t.monto",
                as: "t",
              },
            },
            30,
          ],
        },
      },
      transacciones: "$transaccionesCombinadas",
    },
  },
  {
    $unwind: {
      path: "$transacciones",
    },
  },
  {
    $project: {
      _id: "$transacciones._id",
      monto: "$transacciones.monto",
      cuentaOrigen: "$transacciones.cuentaOrigen",
      fecha: "$transacciones.fecha",
      promedioHistorico: "$promedioHistorico",
      limitePermitido: {
        $multiply: ["$promedioHistorico", 3],
      },
    },
  },
  {
    $match: {
      $expr: {
        $gt: ["$monto", "$limitePermitido"],
      },
    },
  },
]);

// Fin consulta 4b.

// Inicio Consulta 4c cuentas con saldo negativo

db.cuentas.aggregate([
  {
    $match: {
      saldoActual: {
        $lt: 0,
      },
    },
  },
  {
    $lookup: {
      from: "transacciones",
      let: {
        numeroCuenta: "$numero",
      },
      pipeline: [
        {
          $match: {
            $expr: {
              $eq: ["$cuentaOrigen", "$$numeroCuenta"],
            },
            tipo: "debito",
          },
        },
        {
          $sort: {
            fecha: -1,
          },
        },
        {
          $limit: 1,
        },
      ],
      as: "ultimaTransaccion",
    },
  },
]);

// Fin consulta 4c.

// Inicio Consulta 4d volumen de transferencias por dia y hora

db.transacciones.aggregate([
  {
    $match: {
      tipo: "transferencia",
    },
  },
  {
    $group: {
      _id: {
        dia: {
          $dayOfWeek: "$fecha",
        },
        hora: {
          $hour: "$fecha",
        },
      },
      volumenTotal: {
        $sum: "$monto",
      },
      cantidad: {
        $sum: 1,
      },
    },
  },
  {
    $sort: {
      "_id.dia": 1,
      "_id.hora": 1,
    },
  },
  {
    $project: {
      _id: 0,
      dia: {
        $switch: {
          branches: [
            {
              case: {
                $eq: ["$_id.dia", 1],
              },
              then: "Domingo",
            },
            {
              case: {
                $eq: ["$_id.dia", 2],
              },
              then: "Lunes",
            },
            {
              case: {
                $eq: ["$_id.dia", 3],
              },
              then: "Martes",
            },
            {
              case: {
                $eq: ["$_id.dia", 4],
              },
              then: "Miércoles",
            },
            {
              case: {
                $eq: ["$_id.dia", 5],
              },
              then: "Jueves",
            },
            {
              case: {
                $eq: ["$_id.dia", 6],
              },
              then: "Viernes",
            },
            {
              case: {
                $eq: ["$_id.dia", 7],
              },
              then: "Sábado",
            },
          ],
          default: "Desconocido",
        },
      },
      hora: {
        $concat: [
          {
            $cond: {
              if: {
                $lt: ["$_id.hora", 10],
              },
              then: {
                $concat: [
                  "0",
                  {
                    $toString: "$_id.hora",
                  },
                ],
              },
              else: {
                $toString: "$_id.hora",
              },
            },
          },
          ":00 a ",
          {
            $cond: {
              if: {
                $lt: [
                  {
                    $add: ["$_id.hora", 1],
                  },
                  10,
                ],
              },
              then: {
                $concat: [
                  "0",
                  {
                    $toString: {
                      $add: ["$_id.hora", 1],
                    },
                  },
                ],
              },
              else: {
                $toString: {
                  $add: ["$_id.hora", 1],
                },
              },
            },
          },
          ":00",
        ],
      },
      volumenTotal: 1,
      cantidad: 1,
    },
  },
]);

// Fin consulta 4d.

// Inicio Consulta 4e alertas pendientes ordenadas por riesgo descendiente
db.alertas
  .find({
    estado: "pendiente",
  })
  .sort({
    nivelRiesgo: -1,
  });

// Fin Consulta 4e
