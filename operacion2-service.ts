import { config } from "./config.ts";
import type { AppContext } from "./db-setup.ts";
import type { AlertaFraude, Cuenta, Transaccion } from "./estructura-datos.ts";

export type FraudPatternType =
  | "ciclo"
  | "smurfing"
  | "cascada"
  | "lavado"
  | "destinatariosInusuales";

export type FraudPattern = {
  tipo: FraudPatternType;
  nivelRiesgo: 1 | 2 | 3 | 4 | 5;
  descripcion: string;
  cuentasInvolucradas: string[];
  transaccionesInvolucradas: string[];
};

export type FraudSearchResult = {
  tipoBuscado: FraudPatternType;
  historialMongo: Transaccion[];
  cadenasPosteriores: TransferChain[];
  patrones: FraudPattern[];
  cuentasInvolucradas: Cuenta[];
  alertas: AlertaFraude[];
  fraudeConfirmado: boolean;
};

export type FraudAnalysisResult = FraudSearchResult & {
  transaccion: Transaccion;
};

export type TransferChain = {
  cuentas: string[];
  transacciones: string[];
  montoTotal: number;
  saltos: number;
};

type CompensationState = {
  mongoAccountsBefore: Array<{ _id: string; estado: Cuenta["estado"] }>;
  mongoAlertsInserted: string[];
  neo4jMarked: boolean;
  redisBlocks: string[];
  redisAlertsPublished: string[];
};

const SECURITY_STREAM_KEY = "seguridad:stream";
const FRAUD_ALERTS_ZSET_KEY = "alertas:fraude";
const BLOCK_TTL_SECONDS = 24 * 60 * 60;
const SMURFING_MAX_MONTO = 50_000;
const SMURFING_MIN_TRANSFERENCIAS = 3;

const cuentasCollection = (ctx: AppContext) =>
  ctx.db.collection<Cuenta>("cuentas");
const transaccionesCollection = (ctx: AppContext) =>
  ctx.db.collection<Transaccion>("transacciones");
const alertasCollection = (ctx: AppContext) =>
  ctx.db.collection<AlertaFraude>("alertasFraude");

function obtenerMensajeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function obtenerUnicos(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

function limitarSaltos(maxHops: number): number {
  return Math.min(8, Math.max(1, Math.trunc(maxHops)));
}

async function obtenerTransferenciaOError(
  ctx: AppContext,
  transaccionId: string,
): Promise<Transaccion> {
  const transaccion = await transaccionesCollection(ctx).findOne({
    _id: transaccionId.trim(),
    tipo: "transferencia",
  });

  if (transaccion == null || transaccion.cuentaDestinoId == null) {
    throw new Error("La transferencia indicada no existe en MongoDB.");
  }

  return transaccion;
}

async function obtenerHistorialMongo(
  ctx: AppContext,
  cuentaIds: string[],
): Promise<Transaccion[]> {
  return await transaccionesCollection(ctx)
    .find(
      {
        tipo: "transferencia",
        $or: [
          { cuentaOrigenId: { $in: cuentaIds } },
          { cuentaDestinoId: { $in: cuentaIds } },
        ],
      },
      { sort: { fecha: -1 }, limit: 50 },
    )
    .toArray();
}

async function obtenerCadenasPosteriores(
  ctx: AppContext,
  transaccion: Transaccion,
  maxHops: number,
): Promise<TransferChain[]> {
  const hops = limitarSaltos(maxHops);
  const session = ctx.neo4j.session({ database: config.NEO_4J_DATABASE });

  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `
          MATCH path = (:Cuenta {id: $cuentaDestinoId})-[:TRANSFIRIO*1..${hops}]->(:Cuenta)
                    WITH path,
                         relationships(path) AS rels,
                         [node IN nodes(path) | node.id] AS cuentas
                    RETURN cuentas,
                           [rel IN rels | rel._id] AS transacciones,
                 reduce(total = 0.0, rel IN rels | total + coalesce(rel.monto, 0.0)) AS montoTotal,
                 length(path) AS saltos
          ORDER BY saltos DESC, montoTotal DESC
          LIMIT 25
        `,
        { cuentaDestinoId: transaccion.cuentaDestinoId },
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

function detectarCiclo(
  transaccion: Transaccion,
  chains: TransferChain[],
): FraudPattern[] {
  const origen = transaccion.cuentaOrigenId;
  return chains
    .filter((chain) => chain.cuentas.includes(origen))
    .map((chain) => ({
      tipo: "ciclo" as const,
      nivelRiesgo: 5 as const,
      descripcion: `La cadena posterior vuelve a la cuenta origen en ${chain.saltos} salto(s).`,
      cuentasInvolucradas: obtenerUnicos([origen, ...chain.cuentas]),
      transaccionesInvolucradas: obtenerUnicos([
        transaccion._id,
        ...chain.transacciones,
      ]),
    }));
}

function detectarCascada(
  transaccion: Transaccion,
  chains: TransferChain[],
  maxHops: number,
): FraudPattern[] {
  const longChains = chains.filter(
    (chain) => chain.saltos >= Math.min(3, limitarSaltos(maxHops)),
  );
  if (longChains.length === 0) return [];

  const accounts = obtenerUnicos(longChains.flatMap((chain) => chain.cuentas));
  const txs = obtenerUnicos([
    transaccion._id,
    ...longChains.flatMap((chain) => chain.transacciones),
  ]);

  return [
    {
      tipo: "cascada",
      nivelRiesgo: longChains.length >= 3 ? 5 : 4,
      descripcion: `Se detectaron ${longChains.length} cadena(s) posteriores extensas hasta ${maxHops} salto(s).`,
      cuentasInvolucradas: accounts,
      transaccionesInvolucradas: txs,
    },
  ];
}

function detectarSmurfing(
  transaccion: Transaccion,
  history: Transaccion[],
): FraudPattern[] {
  const destino = transaccion.cuentaDestinoId;
  if (destino == null) return [];

  const smallIncoming = history.filter(
    (tx) =>
      tx.cuentaDestinoId === destino &&
      tx.monto <= SMURFING_MAX_MONTO &&
      tx.fecha.getTime() >= Date.now() - 24 * 60 * 60 * 1000,
  );

  const origins = obtenerUnicos(smallIncoming.map((tx) => tx.cuentaOrigenId));
  if (
    smallIncoming.length < SMURFING_MIN_TRANSFERENCIAS ||
    origins.length < 2
  ) {
    return [];
  }

  return [
    {
      tipo: "smurfing",
      nivelRiesgo: smallIncoming.length >= 5 ? 5 : 4,
      descripcion: `${smallIncoming.length} transferencias pequeñas llegan a la misma cuenta desde ${origins.length} orígenes en 24 horas.`,
      cuentasInvolucradas: obtenerUnicos([destino, ...origins]),
      transaccionesInvolucradas: obtenerUnicos(
        smallIncoming.map((tx) => tx._id),
      ),
    },
  ];
}

function construirMotivoBloqueo(patrones: FraudPattern[]): string {
  const labels: Record<FraudPatternType, string> = {
    ciclo: "patrón de ciclos detectado",
    smurfing: "patrón de smurfing detectado",
    cascada: "patrón de cascada detectado",
    lavado: "posible lavado detectado",
    destinatariosInusuales: "destinatarios inusuales detectados",
  };

  const reasons = obtenerUnicos(patrones.map((patron) => labels[patron.tipo]));
  if (reasons.length === 0) return "patrón sospechoso detectado";
  return reasons.length === 1
    ? reasons[0]!
    : `Múltiples patrones detectados: ${reasons.join(", ")}`;
}

function construirAlertas(patrones: FraudPattern[]): AlertaFraude[] {
  return patrones
    .toSorted((a, b) => b.nivelRiesgo - a.nivelRiesgo)
    .map((patron) => ({
      _id: crypto.randomUUID(),
      idTransaccion: patron.transaccionesInvolucradas[0] ?? "sin_transaccion",
      tipo: patron.tipo,
      nivelRiesgo: patron.nivelRiesgo,
      estado: "pendiente",
      fecha: new Date(),
      cuentasInvolucradas: patron.cuentasInvolucradas,
    }));
}

async function marcarFraudeEnNeo4j(
  ctx: AppContext,
  patrones: FraudPattern[],
): Promise<void> {
  const cuentaIds = obtenerUnicos(
    patrones.flatMap((pattern) => pattern.cuentasInvolucradas),
  );
  const transaccionIds = obtenerUnicos(
    patrones.flatMap((pattern) => pattern.transaccionesInvolucradas),
  );
  const tipos = obtenerUnicos(patrones.map((pattern) => pattern.tipo));
  const maxRiesgo = Math.max(...patrones.map((pattern) => pattern.nivelRiesgo));
  const session = ctx.neo4j.session({ database: config.NEO_4J_DATABASE });

  try {
    await session.executeWrite((tx) =>
      tx.run(
        `
          MATCH (c:Cuenta)
          WHERE c.id IN $cuentaIds
          SET c.fraudeConfirmado = true,
              c.estado = 'bloqueada',
              c.riesgoFraude = $maxRiesgo,
              c.patronesFraude = $tipos,
              c.fechaMarcadoFraude = datetime()
          WITH count(c) AS _
          MATCH ()-[r:TRANSFIRIO]->()
          WHERE r._id IN $transaccionIds
          SET r.sospechosa = true,
              r.patronesFraude = $tipos,
              r.riesgoFraude = $maxRiesgo
        `,
        { cuentaIds, transaccionIds, tipos, maxRiesgo },
      ),
    );
  } finally {
    await session.close();
  }
}

async function desmarcarFraudeEnNeo4j(
  ctx: AppContext,
  patrones: FraudPattern[],
): Promise<void> {
  const cuentaIds = obtenerUnicos(
    patrones.flatMap((pattern) => pattern.cuentasInvolucradas),
  );
  const transaccionIds = obtenerUnicos(
    patrones.flatMap((pattern) => pattern.transaccionesInvolucradas),
  );
  const session = ctx.neo4j.session({ database: config.NEO_4J_DATABASE });

  try {
    await session.executeWrite((tx) =>
      tx.run(
        `
          MATCH (c:Cuenta)
          WHERE c.id IN $cuentaIds
          REMOVE c.fraudeConfirmado, c.riesgoFraude, c.patronesFraude, c.fechaMarcadoFraude
          WITH count(c) AS _
          MATCH ()-[r:TRANSFIRIO]->()
          WHERE r._id IN $transaccionIds
          REMOVE r.sospechosa, r.patronesFraude, r.riesgoFraude
        `,
        { cuentaIds, transaccionIds },
      ),
    );
  } finally {
    await session.close();
  }
}

async function compensar(
  ctx: AppContext,
  state: CompensationState,
  patrones: FraudPattern[],
): Promise<void> {
  const errors: string[] = [];

  for (const cuentaId of state.redisBlocks) {
    try {
      await ctx.redis.del(`bloqueo:${cuentaId}`);
    } catch (error) {
      errors.push(`Redis bloqueo ${cuentaId}: ${obtenerMensajeError(error)}`);
    }
  }

  if (state.mongoAlertsInserted.length > 0) {
    try {
      await alertasCollection(ctx).deleteMany({
        _id: { $in: state.mongoAlertsInserted },
      });
    } catch (error) {
      errors.push(`Mongo alertas: ${obtenerMensajeError(error)}`);
    }
  }

  for (const account of state.mongoAccountsBefore) {
    try {
      await cuentasCollection(ctx).updateOne(
        { _id: account._id },
        { $set: { estado: account.estado } },
      );
    } catch (error) {
      errors.push(`Mongo cuenta ${account._id}: ${obtenerMensajeError(error)}`);
    }
  }

  if (state.neo4jMarked) {
    try {
      await desmarcarFraudeEnNeo4j(ctx, patrones);
    } catch (error) {
      errors.push(`Neo4j: ${obtenerMensajeError(error)}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }
}

async function aplicarAccionesDeFraudeConfirmado(
  ctx: AppContext,
  patrones: FraudPattern[],
  alertas: AlertaFraude[],
): Promise<void> {
  const state: CompensationState = {
    mongoAccountsBefore: [],
    mongoAlertsInserted: [],
    neo4jMarked: false,
    redisBlocks: [],
    redisAlertsPublished: [],
  };
  const cuentaIds = obtenerUnicos(
    patrones.flatMap((pattern) => pattern.cuentasInvolucradas),
  );
  const blockReason = construirMotivoBloqueo(patrones);

  try {
    const accountsBefore = await cuentasCollection(ctx)
      .find({ _id: { $in: cuentaIds } }, { projection: { _id: 1, estado: 1 } })
      .toArray();
    state.mongoAccountsBefore = accountsBefore.map((account) => ({
      _id: account._id,
      estado: account.estado,
    }));

    await cuentasCollection(ctx).updateMany(
      { _id: { $in: cuentaIds } },
      { $set: { estado: "bloqueada" } },
    );

    await marcarFraudeEnNeo4j(ctx, patrones);
    state.neo4jMarked = true;

    for (const cuentaId of cuentaIds) {
      await ctx.redis.set(`bloqueo:${cuentaId}`, blockReason, {
        EX: BLOCK_TTL_SECONDS,
      });
      state.redisBlocks.push(cuentaId);
    }

    if (alertas.length > 0) {
      await alertasCollection(ctx).insertMany(alertas);
      state.mongoAlertsInserted = alertas.map((alerta) => alerta._id);
    }

    for (const alerta of alertas) {
      await ctx.redis.zAdd(FRAUD_ALERTS_ZSET_KEY, {
        score: alerta.nivelRiesgo,
        value: alerta._id,
      });

      await ctx.redis.xAdd(SECURITY_STREAM_KEY, "*", {
        evento: "alerta_fraude_confirmado",
        alertaId: alerta._id,
        transaccionId: alerta.idTransaccion,
        tipo: alerta.tipo,
        riesgo: String(alerta.nivelRiesgo),
        cuentas: cuentaIds.join(","),
        fecha: alerta.fecha.toISOString(),
      });
      state.redisAlertsPublished.push(alerta._id);
    }
  } catch (error) {
    try {
      await compensar(ctx, state, patrones);
    } catch (rollbackError) {
      throw new Error(
        [
          `Error principal OP-2: ${obtenerMensajeError(error)}`,
          `Error de compensación OP-2: ${obtenerMensajeError(rollbackError)}`,
        ].join("\n"),
      );
    }

    throw new Error(
      `OP-2 falló y se compensaron los cambios: ${obtenerMensajeError(error)}`,
    );
  }
}

async function buscarCiclos(
  ctx: AppContext,
  maxHops: number,
  patternType: "ciclo" | "lavado" = "ciclo",
): Promise<{ patrones: FraudPattern[]; chains: TransferChain[] }> {
  const hops = limitarSaltos(maxHops);
  const session = ctx.neo4j.session({ database: config.NEO_4J_DATABASE });

  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `
          MATCH path = (inicio:Cuenta)-[:TRANSFIRIO*2..${hops}]->(inicio)
                    WITH path,
                         relationships(path) AS rels,
                         [node IN nodes(path) | node.id] AS cuentas
                    RETURN cuentas,
                           [rel IN rels | rel._id] AS transacciones,
                 reduce(total = 0.0, rel IN rels | total + coalesce(rel.monto, 0.0)) AS montoTotal,
                 length(path) AS saltos
          ORDER BY saltos DESC, montoTotal DESC
          LIMIT 25
        `,
      ),
    );

    const chains = result.records.map((record) => ({
      cuentas: record.get("cuentas") as string[],
      transacciones: (record.get("transacciones") as string[]).filter(Boolean),
      montoTotal: Number(record.get("montoTotal")),
      saltos: Number(record.get("saltos")),
    }));

    return {
      chains,
      patrones: chains.map((chain) => ({
        tipo: patternType,
        nivelRiesgo: 5,
        descripcion: `${patternType === "lavado" ? "Posible lavado" : "Ciclo"} de transferencias detectado en ${chain.saltos} salto(s).`,
        cuentasInvolucradas: obtenerUnicos(chain.cuentas),
        transaccionesInvolucradas: obtenerUnicos(chain.transacciones),
      })),
    };
  } finally {
    await session.close();
  }
}

async function buscarCascadas(
  ctx: AppContext,
  maxHops: number,
): Promise<{ patrones: FraudPattern[]; chains: TransferChain[] }> {
  const hops = Math.max(3, limitarSaltos(maxHops));
  const session = ctx.neo4j.session({ database: config.NEO_4J_DATABASE });

  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `
          MATCH path = (:Cuenta)-[:TRANSFIRIO*3..${hops}]->(:Cuenta)
                    WITH path,
                         relationships(path) AS rels,
                         [node IN nodes(path) | node.id] AS cuentas
                    RETURN cuentas,
                           [rel IN rels | rel._id] AS transacciones,
                 reduce(total = 0.0, rel IN rels | total + coalesce(rel.monto, 0.0)) AS montoTotal,
                 length(path) AS saltos
          ORDER BY saltos DESC, montoTotal DESC
          LIMIT 25
        `,
      ),
    );

    const chains = result.records.map((record) => ({
      cuentas: record.get("cuentas") as string[],
      transacciones: (record.get("transacciones") as string[]).filter(Boolean),
      montoTotal: Number(record.get("montoTotal")),
      saltos: Number(record.get("saltos")),
    }));

    return {
      chains,
      patrones: chains.map((chain) => ({
        tipo: "cascada",
        nivelRiesgo: chain.saltos >= 4 ? 5 : 4,
        descripcion: `Cadena de transferencias posterior de ${chain.saltos} salto(s).`,
        cuentasInvolucradas: obtenerUnicos(chain.cuentas),
        transaccionesInvolucradas: obtenerUnicos(chain.transacciones),
      })),
    };
  } finally {
    await session.close();
  }
}

async function buscarSmurfing(
  ctx: AppContext,
): Promise<{ patrones: FraudPattern[]; history: Transaccion[] }> {
  const session = ctx.neo4j.session({ database: config.NEO_4J_DATABASE });

  try {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (entrada:Cuenta)-[r1:TRANSFIRIO]->(centro:Cuenta)-[r2:TRANSFIRIO]->(salida:Cuenta)
        WHERE r2.fecha <= r1.fecha + duration({hours: 24}) AND entrada <> salida
        WITH centro,
             collect(DISTINCT entrada.id) AS fuentesIds,
             collect(DISTINCT salida.id) AS destinosIds,
             COUNT(DISTINCT entrada) AS fuentes,
             COUNT(DISTINCT salida) AS destinos,
             SUM(r2.monto) AS totalRedistribuido,
             collect(DISTINCT r1._id) + collect(DISTINCT r2._id) AS transacciones
        WHERE fuentes >= 3 AND destinos >= 3
        RETURN centro.id AS centroId,
               centro.numero AS cuentaCentro,
               fuentesIds,
               destinosIds,
               fuentes,
               destinos,
               totalRedistribuido,
               transacciones
        ORDER BY totalRedistribuido DESC
        LIMIT 25
      `),
    );

    const patrones = result.records.map((record) => {
      const centroId = String(record.get("centroId"));
      const cuentaCentro = String(record.get("cuentaCentro"));
      const fuentes = Number(record.get("fuentes"));
      const destinos = Number(record.get("destinos"));
      const totalRedistribuido = Number(record.get("totalRedistribuido"));
      const fuentesIds = record.get("fuentesIds") as string[];
      const destinosIds = record.get("destinosIds") as string[];
      const transacciones = record.get("transacciones") as string[];

      return {
        tipo: "smurfing" as const,
        nivelRiesgo:
          fuentes >= 5 && destinos >= 5 ? (5 as const) : (4 as const),
        descripcion: `La cuenta ${cuentaCentro} recibe fondos de ${fuentes} fuente(s) y los redistribuye a ${destinos} destino(s) dentro de 24 horas. Total redistribuido: ${totalRedistribuido}.`,
        cuentasInvolucradas: obtenerUnicos([
          centroId,
          ...fuentesIds,
          ...destinosIds,
        ]),
        transaccionesInvolucradas: obtenerUnicos(transacciones),
      };
    });

    const txIds = obtenerUnicos(
      patrones.flatMap((pattern) => pattern.transaccionesInvolucradas),
    );
    const history =
      txIds.length === 0
        ? []
        : await transaccionesCollection(ctx)
            .find({ _id: { $in: txIds } })
            .toArray();

    return { patrones, history };
  } finally {
    await session.close();
  }
}

async function buscarDestinatariosInusuales(
  ctx: AppContext,
): Promise<{ patrones: FraudPattern[]; history: Transaccion[] }> {
  const session = ctx.neo4j.session({ database: config.NEO_4J_DATABASE });

  try {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (nueva:Cuenta)-[r:TRANSFIRIO]->(receptora:Cuenta)
        WHERE r.fecha >= datetime() - duration({days: 90})
        AND NOT EXISTS {
          MATCH (nueva)-[historica:TRANSFIRIO]->(receptora)
          WHERE historica.fecha < datetime() - duration({days: 90})
        }
        WITH receptora,
             collect(DISTINCT nueva.id) AS remitentesIds,
             collect(DISTINCT r._id) AS transacciones,
             COUNT(DISTINCT nueva) AS remitentesNuevos,
             SUM(r.monto) AS montoTotal
        WHERE remitentesNuevos >= 5
        RETURN receptora.id AS receptoraId,
               receptora.numero AS cuentaReceptora,
               remitentesIds,
               transacciones,
               remitentesNuevos,
               montoTotal
        ORDER BY remitentesNuevos DESC
        LIMIT 25
      `),
    );

    const patrones = result.records.map((record) => {
      const receptoraId = String(record.get("receptoraId"));
      const cuentaReceptora = String(record.get("cuentaReceptora"));
      const remitentesNuevos = Number(record.get("remitentesNuevos"));
      const montoTotal = Number(record.get("montoTotal"));
      const remitentesIds = record.get("remitentesIds") as string[];
      const transacciones = record.get("transacciones") as string[];

      return {
        tipo: "destinatariosInusuales" as const,
        nivelRiesgo: remitentesNuevos >= 10 ? (5 as const) : (4 as const),
        descripcion: `La cuenta ${cuentaReceptora} recibió transferencias de ${remitentesNuevos} remitente(s) nuevos en 90 días. Monto total: ${montoTotal}.`,
        cuentasInvolucradas: obtenerUnicos([receptoraId, ...remitentesIds]),
        transaccionesInvolucradas: obtenerUnicos(transacciones),
      };
    });

    const txIds = obtenerUnicos(
      patrones.flatMap((pattern) => pattern.transaccionesInvolucradas),
    );
    const history =
      txIds.length === 0
        ? []
        : await transaccionesCollection(ctx)
            .find({ _id: { $in: txIds } })
            .toArray();

    return { patrones, history };
  } finally {
    await session.close();
  }
}

export async function buscarFraudePorTipo(
  ctx: AppContext,
  input: { tipo: FraudPatternType; maxHops: number; confirmarFraude: boolean },
): Promise<FraudSearchResult> {
  let patrones: FraudPattern[] = [];
  let historialMongo: Transaccion[] = [];
  let cadenasPosteriores: TransferChain[] = [];

  if (input.tipo === "smurfing") {
    const result = await buscarSmurfing(ctx);
    patrones = result.patrones;
    historialMongo = result.history;
  } else if (input.tipo === "destinatariosInusuales") {
    const result = await buscarDestinatariosInusuales(ctx);
    patrones = result.patrones;
    historialMongo = result.history;
  } else if (input.tipo === "ciclo" || input.tipo === "lavado") {
    const result = await buscarCiclos(ctx, input.maxHops, input.tipo);
    patrones = result.patrones;
    cadenasPosteriores = result.chains;
  } else {
    const result = await buscarCascadas(ctx, input.maxHops);
    patrones = result.patrones;
    cadenasPosteriores = result.chains;
  }

  patrones = patrones.toSorted((a, b) => b.nivelRiesgo - a.nivelRiesgo);
  const alertas = construirAlertas(patrones);
  const cuentaIds = obtenerUnicos(
    patrones.flatMap((pattern) => pattern.cuentasInvolucradas),
  );
  const cuentasInvolucradas =
    cuentaIds.length === 0
      ? []
      : await cuentasCollection(ctx)
          .find({ _id: { $in: cuentaIds } }, { sort: { numero: 1 } })
          .toArray();

  if (input.confirmarFraude && patrones.length > 0) {
    await aplicarAccionesDeFraudeConfirmado(ctx, patrones, alertas);
  }

  return {
    tipoBuscado: input.tipo,
    historialMongo,
    cadenasPosteriores,
    patrones,
    cuentasInvolucradas,
    alertas,
    fraudeConfirmado: input.confirmarFraude && patrones.length > 0,
  };
}

export async function analizarYGestionarFraude(
  ctx: AppContext,
  input: { transaccionId: string; maxHops: number; confirmarFraude: boolean },
): Promise<FraudAnalysisResult> {
  const transaccion = await obtenerTransferenciaOError(
    ctx,
    input.transaccionId,
  );
  const baseAccounts = obtenerUnicos([
    transaccion.cuentaOrigenId,
    transaccion.cuentaDestinoId ?? "",
  ]);
  const historialMongo = await obtenerHistorialMongo(ctx, baseAccounts);
  const cadenasPosteriores = await obtenerCadenasPosteriores(
    ctx,
    transaccion,
    input.maxHops,
  );

  const patrones = [
    ...detectarCiclo(transaccion, cadenasPosteriores),
    ...detectarSmurfing(transaccion, historialMongo),
    ...detectarCascada(transaccion, cadenasPosteriores, input.maxHops),
  ].toSorted((a, b) => b.nivelRiesgo - a.nivelRiesgo);

  const alertas = construirAlertas(patrones);
  const cuentaIds = obtenerUnicos([
    ...baseAccounts,
    ...patrones.flatMap((pattern) => pattern.cuentasInvolucradas),
  ]);
  const cuentasInvolucradas = await cuentasCollection(ctx)
    .find({ _id: { $in: cuentaIds } }, { sort: { numero: 1 } })
    .toArray();

  if (input.confirmarFraude && patrones.length > 0) {
    await aplicarAccionesDeFraudeConfirmado(ctx, patrones, alertas);
  }

  return {
    transaccion,
    tipoBuscado: "ciclo",
    historialMongo,
    cadenasPosteriores,
    patrones,
    cuentasInvolucradas,
    alertas,
    fraudeConfirmado: input.confirmarFraude && patrones.length > 0,
  };
}
