import { config } from "../config.ts";
import type { AppContext } from "../db-setup.ts";
import type { Cuenta, Transaccion } from "../estructura-datos.ts";

export type CaminoTransferencia = {
  cuentas: string[];
  transacciones: string[];
  montoTotal: number;
  saltos: number;
};

export type TrazabilidadTransferencia = {
  transaccionOriginal: Transaccion;
  cuentaOrigen: Cuenta | null;
  cuentaDestino: Cuenta | null;
  cuentasInvolucradas: Cuenta[];
  transaccionesInvolucradas: Transaccion[];
  caminos: CaminoTransferencia[];
};

const cuentasCollection = (ctx: AppContext) =>
  ctx.db.collection<Cuenta>("cuentas");
const transaccionesCollection = (ctx: AppContext) =>
  ctx.db.collection<Transaccion>("transacciones");

function obtenerUnicos<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function normalizarFechaTransaccion(transaccion: Transaccion): Transaccion {
  return {
    ...transaccion,
    fecha: new Date(transaccion.fecha),
  };
}

async function obtenerCaminosNeo4j(
  ctx: AppContext,
  transaccionId: string,
): Promise<CaminoTransferencia[]> {
  const session = ctx.neo4j.session({ database: config.NEO_4J_DATABASE });

  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `
          MATCH path = (:Cuenta)-[:TRANSFIRIO {_id: $transaccionId}]->(:Cuenta)-[:TRANSFIRIO*0..4]->(:Cuenta)
          WITH path,
               relationships(path) AS rels,
               [node IN nodes(path) | node.id] AS cuentas
          RETURN cuentas,
                 [rel IN rels | rel._id] AS transacciones,
                 reduce(total = 0.0, rel IN rels | total + coalesce(rel.monto, 0.0)) AS montoTotal,
                 length(path) AS saltos
          ORDER BY saltos DESC, montoTotal DESC
          LIMIT 50
        `,
        { transaccionId },
      ),
    );

    return result.records.map((record) => ({
      cuentas: record.get("cuentas") as string[],
      transacciones: (record.get("transacciones") as string[]).filter(Boolean),
      montoTotal: Number(record.get("montoTotal")),
      saltos: Number(record.get("saltos")),
    }));
  } finally {
    await session.close();
  }
}

export async function trazarTransferenciaRegulatoria(
  ctx: AppContext,
  transaccionId: string,
): Promise<TrazabilidadTransferencia | null> {
  const transaccionOriginal = await transaccionesCollection(ctx).findOne({
    _id: transaccionId.trim(),
    tipo: "transferencia",
  });

  if (transaccionOriginal == null) {
    return null;
  }

  const caminos = await obtenerCaminosNeo4j(ctx, transaccionOriginal._id);

  const cuentaIds = obtenerUnicos([
    transaccionOriginal.cuentaOrigenId,
    ...(transaccionOriginal.cuentaDestinoId == null
      ? []
      : [transaccionOriginal.cuentaDestinoId]),
    ...caminos.flatMap((camino) => camino.cuentas),
  ]);

  const transaccionIds = obtenerUnicos([
    transaccionOriginal._id,
    ...caminos.flatMap((camino) => camino.transacciones),
  ]);

  const [cuentasInvolucradas, transaccionesInvolucradas] = await Promise.all([
    cuentasCollection(ctx)
      .find({ _id: { $in: cuentaIds } }, { sort: { numero: 1 } })
      .toArray(),
    transaccionesCollection(ctx)
      .find({ _id: { $in: transaccionIds } }, { sort: { fecha: 1, _id: 1 } })
      .toArray(),
  ]);

  return {
    transaccionOriginal: normalizarFechaTransaccion(transaccionOriginal),
    cuentaOrigen:
      cuentasInvolucradas.find(
        (cuenta) => cuenta._id === transaccionOriginal.cuentaOrigenId,
      ) ?? null,
    cuentaDestino:
      cuentasInvolucradas.find(
        (cuenta) => cuenta._id === transaccionOriginal.cuentaDestinoId,
      ) ?? null,
    cuentasInvolucradas,
    transaccionesInvolucradas: transaccionesInvolucradas.map(
      normalizarFechaTransaccion,
    ),
    caminos,
  };
}
