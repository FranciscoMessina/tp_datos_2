import { config } from "./config.ts";
import type { AppContext } from "./db-setup.ts";
import type { Cliente, Cuenta, Transaccion } from "./estructura-datos.ts";
import {
  getBlockedReason,
  getClientById,
  updateSessionLastOperation,
  type SessionData,
} from "./session-service.ts";

type MongoTransferState = {
  origenDebitado: boolean;
  destinoAcreditado: boolean;
  transaccionInsertada: boolean;
};

type ExecutionState = {
  limiteReservado: boolean;
  mongo: MongoTransferState;
  neo4jCreado: boolean;
};

export type CuentaConBloqueo = {
  cuenta: Cuenta;
  bloqueo: string | null;
};

export type Operacion1ClienteContext = {
  cliente: Cliente;
  accountStatuses: CuentaConBloqueo[];
  cuentasHabilitadas: CuentaConBloqueo[];
};

type TransferValidationFailureCode =
  | "DESTINO_NO_ENCONTRADO"
  | "DESTINO_IGUAL_ORIGEN"
  | "DESTINO_INACTIVO"
  | "DESTINO_BLOQUEADO"
  | "SALDO_INSUFICIENTE"
  | "LIMITE_INSUFICIENTE";

export type TransferValidationResult =
  | {
      ok: true;
      cuentaDestino: Cuenta;
      limiteActual: number;
      disponibleAntes: number;
    }
  | {
      ok: false;
      code: TransferValidationFailureCode;
      cuentaDestino?: Cuenta;
      bloqueoDestino?: string;
      limiteActual?: number;
      disponibleAntes?: number;
    };

export type ExecuteTransferInput = {
  cliente: Cliente;
  session: SessionData;
  cuentaOrigen: Cuenta;
  cuentaDestino: Cuenta;
  monto: number;
  descripcion: string;
};

export type ExecuteTransferResult = {
  transaccionId: string;
  monto: number;
  saldoOrigenEsperado: number;
  montoAcumulado: number;
};

const SECURITY_STREAM_KEY = "seguridad:stream";
export const DEFAULT_TRANSFER_DESCRIPTION =
  "Transferencia realizada desde la CLI";

const moneyFormatter = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
});

const cuentasCollection = (ctx: AppContext) =>
  ctx.db.collection<Cuenta>("cuentas");
const transaccionesCollection = (ctx: AppContext) =>
  ctx.db.collection<Transaccion>("transacciones");

const limiteKey = (cuentaId: string, date = new Date()) =>
  `limite:${cuentaId}:${formatDateKey(date)}`;

export function formatearMoneda(value: number): string {
  return moneyFormatter.format(value);
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function secondsUntilEndOfDay(date = new Date()): number {
  const end = new Date(date);
  end.setHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((end.getTime() - date.getTime()) / 1000));
}

function obtenerMensajeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function publishSecurityEvent(
  ctx: AppContext,
  payload: Record<string, string>,
): Promise<void> {
  await ctx.redis.xAdd(SECURITY_STREAM_KEY, "*", payload);
}

async function reservarLimiteDiario(
  ctx: AppContext,
  cuentaId: string,
  monto: number,
): Promise<
  | { approved: true; acumulado: number }
  | { approved: false; acumuladoActual: number; disponible: number }
> {
  const key = limiteKey(cuentaId);
  const rawValue = await ctx.redis.incrByFloat(key, monto);
  const acumulado = Number(rawValue);

  if (Number.isNaN(acumulado)) {
    throw new Error(
      "Redis devolvió un valor inválido al reservar el límite diario.",
    );
  }

  const ttl = await ctx.redis.ttl(key);
  if (ttl < 0) {
    await ctx.redis.expire(key, secondsUntilEndOfDay());
  }

  if (acumulado > config.LIMITE_DIARIO) {
    await ctx.redis.incrByFloat(key, -monto);

    const acumuladoActual = acumulado - monto;
    return {
      approved: false,
      acumuladoActual,
      disponible: Math.max(0, config.LIMITE_DIARIO - acumuladoActual),
    };
  }

  return { approved: true, acumulado };
}

async function revertirLimiteDiario(
  ctx: AppContext,
  cuentaId: string,
  monto: number,
): Promise<void> {
  await ctx.redis.incrByFloat(limiteKey(cuentaId), -monto);
}

async function persistirTransferenciaEnMongo(
  ctx: AppContext,
  origen: Cuenta,
  destino: Cuenta,
  transaccion: Transaccion,
): Promise<MongoTransferState> {
  const state: MongoTransferState = {
    origenDebitado: false,
    destinoAcreditado: false,
    transaccionInsertada: false,
  };

  const cuentas = cuentasCollection(ctx);
  const transacciones = transaccionesCollection(ctx);

  const debitResult = await cuentas.updateOne(
    {
      _id: origen._id,
      estado: "activa",
      saldoActual: { $gte: transaccion.monto },
    },
    {
      $inc: {
        saldoActual: -transaccion.monto,
      },
    },
  );

  if (debitResult.modifiedCount !== 1) {
    throw new Error(
      "No se pudo debitar la cuenta de origen. Verificá saldo o estado actual.",
    );
  }
  state.origenDebitado = true;

  const creditResult = await cuentas.updateOne(
    {
      _id: destino._id,
      estado: "activa",
    },
    {
      $inc: {
        saldoActual: transaccion.monto,
      },
    },
  );

  if (creditResult.modifiedCount !== 1) {
    throw new Error("No se pudo acreditar la cuenta destino en MongoDB.");
  }
  state.destinoAcreditado = true;

  await transacciones.insertOne(transaccion);
  state.transaccionInsertada = true;

  return state;
}

async function revertirTransferenciaEnMongo(
  ctx: AppContext,
  origen: Cuenta,
  destino: Cuenta,
  transaccion: Transaccion,
  state: MongoTransferState,
): Promise<void> {
  const cuentas = cuentasCollection(ctx);
  const transacciones = transaccionesCollection(ctx);

  const rollbackErrors: string[] = [];

  if (state.transaccionInsertada) {
    try {
      await transacciones.deleteOne({ _id: transaccion._id });
    } catch (error) {
      rollbackErrors.push(`Mongo transacción: ${obtenerMensajeError(error)}`);
    }
  }

  if (state.destinoAcreditado) {
    try {
      await cuentas.updateOne(
        { _id: destino._id },
        {
          $inc: {
            saldoActual: -transaccion.monto,
          },
        },
      );
    } catch (error) {
      rollbackErrors.push(
        `Mongo cuenta destino: ${obtenerMensajeError(error)}`,
      );
    }
  }

  if (state.origenDebitado) {
    try {
      await cuentas.updateOne(
        { _id: origen._id },
        {
          $inc: {
            saldoActual: transaccion.monto,
          },
        },
      );
    } catch (error) {
      rollbackErrors.push(`Mongo cuenta origen: ${obtenerMensajeError(error)}`);
    }
  }

  if (rollbackErrors.length > 0) {
    throw new Error(rollbackErrors.join(" | "));
  }
}

async function crearTransferenciaEnNeo4j(
  ctx: AppContext,
  origen: Cuenta,
  destino: Cuenta,
  transaccion: Transaccion,
): Promise<void> {
  const session = ctx.neo4j.session({ database: config.NEO_4J_DATABASE });

  try {
    await session.executeWrite((tx) =>
      tx.run(
        `
          MERGE (origen:Cuenta {id: $origenId})
          SET origen.numero = $origenNumero,
              origen.tipo = $origenTipo,
              origen.moneda = $origenMoneda,
              origen.estado = $origenEstado
          MERGE (destino:Cuenta {id: $destinoId})
          SET destino.numero = $destinoNumero,
              destino.tipo = $destinoTipo,
              destino.moneda = $destinoMoneda,
              destino.estado = $destinoEstado
          CREATE (origen)-[:TRANSFIRIO {
            _id: $transaccionId,
            transaccionId: $transaccionId,
            monto: $monto,
            fecha: $fecha,
            canal: $canal,
            descripcion: $descripcion
          }]->(destino)
        `,
        {
          origenId: origen._id,
          origenNumero: origen.numero,
          origenTipo: origen.tipo,
          origenMoneda: origen.moneda,
          origenEstado: origen.estado,
          destinoId: destino._id,
          destinoNumero: destino.numero,
          destinoTipo: destino.tipo,
          destinoMoneda: destino.moneda,
          destinoEstado: destino.estado,
          transaccionId: transaccion._id,
          monto: transaccion.monto,
          fecha: transaccion.fecha.toISOString(),
          canal: transaccion.canal,
          descripcion: transaccion.descripcion ?? "",
        },
      ),
    );
  } finally {
    await session.close();
  }
}

async function revertirTransferenciaEnNeo4j(
  ctx: AppContext,
  transaccionId: string,
): Promise<void> {
  const session = ctx.neo4j.session({ database: config.NEO_4J_DATABASE });

  try {
    await session.executeWrite((tx) =>
      tx.run(
        `
          MATCH ()-[rel:TRANSFIRIO {_id: $transaccionId}]->()
          DELETE rel
        `,
        { transaccionId },
      ),
    );
  } finally {
    await session.close();
  }
}

async function revertirTransferencia(
  ctx: AppContext,
  origen: Cuenta,
  destino: Cuenta,
  transaccion: Transaccion,
  state: ExecutionState,
): Promise<void> {
  const rollbackErrors: string[] = [];

  if (state.neo4jCreado) {
    try {
      await revertirTransferenciaEnNeo4j(ctx, transaccion._id);
    } catch (error) {
      rollbackErrors.push(`Neo4j: ${obtenerMensajeError(error)}`);
    }
  }

  if (
    state.mongo.origenDebitado ||
    state.mongo.destinoAcreditado ||
    state.mongo.transaccionInsertada
  ) {
    try {
      await revertirTransferenciaEnMongo(
        ctx,
        origen,
        destino,
        transaccion,
        state.mongo,
      );
    } catch (error) {
      rollbackErrors.push(`MongoDB: ${obtenerMensajeError(error)}`);
    }
  }

  if (state.limiteReservado) {
    try {
      await revertirLimiteDiario(ctx, origen._id, transaccion.monto);
    } catch (error) {
      rollbackErrors.push(`Redis límite: ${obtenerMensajeError(error)}`);
    }
  }

  if (rollbackErrors.length > 0) {
    throw new Error(rollbackErrors.join(" | "));
  }
}

export async function obtenerContextoClienteOperacion1(
  ctx: AppContext,
  clienteId: string,
): Promise<Operacion1ClienteContext | null> {
  const cliente = await getClientById(ctx, clienteId);
  if (cliente == null) {
    return null;
  }

  const cuentasCliente = await cuentasCollection(ctx)
    .find({ clienteTitularId: cliente._id }, { sort: { numero: 1 } })
    .toArray();

  const estadosCuentas = await Promise.all(
    cuentasCliente.map(async (cuenta) => ({
      cuenta,
      bloqueo: await getBlockedReason(ctx, cuenta._id),
    })),
  );

  const cuentasHabilitadas = estadosCuentas.filter(
    ({ cuenta, bloqueo }) => cuenta.estado === "activa" && bloqueo == null,
  );

  return {
    cliente,
    accountStatuses: estadosCuentas,
    cuentasHabilitadas,
  };
}

export async function validarSolicitudTransferencia(
  ctx: AppContext,
  input: {
    cuentaOrigen: Cuenta;
    numeroCuentaDestino: string;
    monto: number;
  },
): Promise<TransferValidationResult> {
  const cuentaDestino = await cuentasCollection(ctx).findOne({
    numero: input.numeroCuentaDestino.trim(),
  });

  if (cuentaDestino == null) {
    return { ok: false, code: "DESTINO_NO_ENCONTRADO" };
  }

  if (cuentaDestino._id === input.cuentaOrigen._id) {
    return { ok: false, code: "DESTINO_IGUAL_ORIGEN", cuentaDestino };
  }

  if (cuentaDestino.estado !== "activa") {
    return { ok: false, code: "DESTINO_INACTIVO", cuentaDestino };
  }

  const bloqueoDestino = await getBlockedReason(ctx, cuentaDestino._id);
  if (bloqueoDestino != null) {
    return {
      ok: false,
      code: "DESTINO_BLOQUEADO",
      cuentaDestino,
      bloqueoDestino,
    };
  }

  if (input.cuentaOrigen.saldoActual < input.monto) {
    return { ok: false, code: "SALDO_INSUFICIENTE", cuentaDestino };
  }

  const limiteActual = Number(
    (await ctx.redis.get(limiteKey(input.cuentaOrigen._id))) ?? "0",
  );
  const disponibleAntes = Math.max(0, config.LIMITE_DIARIO - limiteActual);

  if (input.monto > disponibleAntes) {
    return {
      ok: false,
      code: "LIMITE_INSUFICIENTE",
      cuentaDestino,
      limiteActual,
      disponibleAntes,
    };
  }

  return {
    ok: true,
    cuentaDestino,
    limiteActual,
    disponibleAntes,
  };
}

export async function ejecutarTransferencia(
  ctx: AppContext,
  input: ExecuteTransferInput,
): Promise<ExecuteTransferResult> {
  const executionState: ExecutionState = {
    limiteReservado: false,
    mongo: {
      origenDebitado: false,
      destinoAcreditado: false,
      transaccionInsertada: false,
    },
    neo4jCreado: false,
  };

  const transaccion: Transaccion = {
    _id: crypto.randomUUID(),
    tipo: "transferencia",
    monto: input.monto,
    fecha: new Date(),
    cuentaOrigenId: input.cuentaOrigen._id,
    cuentaDestinoId: input.cuentaDestino._id,
    descripcion:
      input.descripcion.trim() === ""
        ? DEFAULT_TRANSFER_DESCRIPTION
        : input.descripcion.trim(),
    canal: input.session.canal,
  };

  try {
    const reserva = await reservarLimiteDiario(
      ctx,
      input.cuentaOrigen._id,
      input.monto,
    );

    if (!reserva.approved) {
      throw new Error(
        [
          "Límite diario excedido durante la ejecución.",
          `Monto acumulado hoy: ${formatearMoneda(reserva.acumuladoActual)}`,
          `Disponible restante: ${formatearMoneda(reserva.disponible)}`,
        ].join("\n"),
      );
    }

    executionState.limiteReservado = true;

    executionState.mongo = await persistirTransferenciaEnMongo(
      ctx,
      input.cuentaOrigen,
      input.cuentaDestino,
      transaccion,
    );

    await crearTransferenciaEnNeo4j(
      ctx,
      input.cuentaOrigen,
      input.cuentaDestino,
      transaccion,
    );
    executionState.neo4jCreado = true;

    await publishSecurityEvent(ctx, {
      evento: "transferencia_aprobada",
      clienteId: input.cliente._id,
      cuentaOrigenId: input.cuentaOrigen._id,
      cuentaOrigenNumero: input.cuentaOrigen.numero,
      cuentaDestinoId: input.cuentaDestino._id,
      cuentaDestinoNumero: input.cuentaDestino.numero,
      transaccionId: transaccion._id,
      monto: transaccion.monto.toFixed(2),
      canal: transaccion.canal,
      fecha: transaccion.fecha.toISOString(),
    });

    await updateSessionLastOperation(
      ctx,
      input.cliente._id,
      `transferencia:${transaccion._id}`,
    );

    return {
      transaccionId: transaccion._id,
      monto: input.monto,
      saldoOrigenEsperado: input.cuentaOrigen.saldoActual - input.monto,
      montoAcumulado: reserva.acumulado,
    };
  } catch (error) {
    try {
      await revertirTransferencia(
        ctx,
        input.cuentaOrigen,
        input.cuentaDestino,
        transaccion,
        executionState,
      );
      throw new Error(
        `La transferencia falló y se revirtió: ${obtenerMensajeError(error)}`,
      );
    } catch (rollbackError) {
      throw new Error(
        [
          `Error principal: ${obtenerMensajeError(error)}`,
          `Error de reversión: ${obtenerMensajeError(rollbackError)}`,
        ].join("\n"),
      );
    }
  }
}
