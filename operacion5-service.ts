import { config } from "./config.ts";
import type { AppContext } from "./db-setup.ts";
import type { AlertaFraude, Transaccion } from "./estructura-datos.ts";

export type DictamenFraude = "confirmado" | "falso_positivo";

export type CierreAlertaFraudeInput = {
  dictamen: DictamenFraude;
  analista: string;
  accionesTomadas: string;
};

export type AlertaFraudePendiente = {
  alerta: AlertaFraude;
  cuentasInvolucradas: string[];
};

export type CierreAlertaFraudeResult = {
  alerta: AlertaFraude;
  cuentasInvolucradas: string[];
  cuentasDesbloqueadas: string[];
  etiquetaNeo4jAplicada: boolean;
  streamEventId: string;
};

const SECURITY_STREAM_KEY = "seguridad:stream";
const FRAUD_ALERTS_ZSET_KEY = "alertas:fraude";

const alertasCollection = (ctx: AppContext) =>
  ctx.db.collection<AlertaFraude>("alertas");
const transaccionesCollection = (ctx: AppContext) =>
  ctx.db.collection<Transaccion>("transacciones");

function obtenerUnicos<T>(values: T[]): T[] {
  return [...new Set(values)];
}

async function consumirAlertaPendienteRedis(
  ctx: AppContext,
): Promise<string | null> {
  const redis = ctx.redis as typeof ctx.redis & {
    zPopMax: (
      key: string,
    ) => Promise<
      | { value?: string; score?: number }
      | { value?: string; score?: number }[]
      | string
      | null
    >;
  };

  const popped = await redis.zPopMax(FRAUD_ALERTS_ZSET_KEY);

  if (popped == null) {
    return null;
  }

  if (typeof popped === "string") {
    return popped;
  }

  if (Array.isArray(popped)) {
    return popped[0]?.value ?? null;
  }

  return popped.value ?? null;
}

async function obtenerCuentasInvolucradas(
  ctx: AppContext,
  alerta: AlertaFraude,
): Promise<string[]> {
  if (
    alerta.cuentasInvolucradas != null &&
    alerta.cuentasInvolucradas.length > 0
  ) {
    return obtenerUnicos(alerta.cuentasInvolucradas);
  }

  const transaccion = await transaccionesCollection(ctx).findOne({
    _id: alerta.idTransaccion,
  });

  if (transaccion == null) {
    return [];
  }

  return obtenerUnicos([
    transaccion.cuentaOrigenId,
    ...(transaccion.cuentaDestinoId == null
      ? []
      : [transaccion.cuentaDestinoId]),
  ]);
}

async function etiquetarCuentasComprometidasNeo4j(
  ctx: AppContext,
  cuentaIds: string[],
): Promise<void> {
  if (cuentaIds.length === 0) {
    return;
  }

  const session = ctx.neo4j.session({ database: config.NEO_4J_DATABASE });

  try {
    await session.executeWrite((tx) =>
      tx.run(
        `
          MATCH (c:Cuenta)
          WHERE c.id IN $cuentaIds
          SET c:CuentaComprometida,
              c.cuentaComprometida = true,
              c.fechaCuentaComprometida = datetime()
        `,
        { cuentaIds },
      ),
    );
  } finally {
    await session.close();
  }
}

async function desbloquearCuentasRedis(
  ctx: AppContext,
  cuentaIds: string[],
): Promise<string[]> {
  const desbloqueadas: string[] = [];

  for (const cuentaId of cuentaIds) {
    const deleted = await ctx.redis.del(`bloqueo:${cuentaId}`);
    if (deleted > 0) {
      desbloqueadas.push(cuentaId);
    }
  }

  return desbloqueadas;
}

export async function consumirProximaAlertaFraude(
  ctx: AppContext,
): Promise<AlertaFraudePendiente | null> {
  const alertaId = await consumirAlertaPendienteRedis(ctx);

  if (alertaId == null) {
    return null;
  }

  const alerta = await alertasCollection(ctx).findOne({ _id: alertaId });

  if (alerta == null) {
    throw new Error(
      `Redis devolvió la alerta ${alertaId}, pero no existe en MongoDB.`,
    );
  }

  return {
    alerta,
    cuentasInvolucradas: await obtenerCuentasInvolucradas(ctx, alerta),
  };
}

export async function reencolarAlertaFraudePendiente(
  ctx: AppContext,
  alertaPendiente: AlertaFraudePendiente,
): Promise<void> {
  await ctx.redis.zAdd(FRAUD_ALERTS_ZSET_KEY, {
    score: alertaPendiente.alerta.nivelRiesgo,
    value: alertaPendiente.alerta._id,
  });
}

export async function cerrarAlertaFraude(
  ctx: AppContext,
  alertaPendiente: AlertaFraudePendiente,
  input: CierreAlertaFraudeInput,
): Promise<CierreAlertaFraudeResult> {
  const fechaCierre = new Date();
  const { alerta, cuentasInvolucradas } = alertaPendiente;

  const cuentasDesbloqueadas =
    input.dictamen === "falso_positivo"
      ? await desbloquearCuentasRedis(ctx, cuentasInvolucradas)
      : [];

  const updateResult = await alertasCollection(ctx).updateOne(
    { _id: alerta._id },
    {
      $set: {
        estado: "cerrada",
        cuentasInvolucradas,
        resolucion: {
          fecha: fechaCierre,
          estado: input.dictamen,
          accionesTomadas: input.accionesTomadas.trim(),
          analista: input.analista.trim(),
        },
      },
    },
  );

  if (updateResult.modifiedCount !== 1) {
    throw new Error("No se pudo registrar el dictamen en MongoDB.");
  }

  const etiquetaNeo4jAplicada = input.dictamen === "confirmado";
  if (etiquetaNeo4jAplicada) {
    await etiquetarCuentasComprometidasNeo4j(ctx, cuentasInvolucradas);
  }

  const streamEventId = await ctx.redis.xAdd(SECURITY_STREAM_KEY, "*", {
    evento: "alerta_fraude_cerrada",
    alertaId: alerta._id,
    transaccionId: alerta.idTransaccion,
    dictamen: input.dictamen,
    analista: input.analista.trim(),
    accionesTomadas: input.accionesTomadas.trim(),
    cuentas: cuentasInvolucradas.join(","),
    cuentasDesbloqueadas: cuentasDesbloqueadas.join(","),
    fecha: fechaCierre.toISOString(),
  });

  return {
    alerta: {
      ...alerta,
      estado: "cerrada",
      cuentasInvolucradas,
      resolucion: {
        fecha: fechaCierre,
        estado: input.dictamen,
        accionesTomadas: input.accionesTomadas.trim(),
        analista: input.analista.trim(),
      },
    },
    cuentasInvolucradas,
    cuentasDesbloqueadas,
    etiquetaNeo4jAplicada,
    streamEventId,
  };
}
