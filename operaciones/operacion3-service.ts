import { config } from "../config.ts";
import type { AppContext } from "../db-setup.ts";
import type { Cliente, Cuenta, Transaccion } from "../estructura-datos.ts";
import { getBlockedReason, getClientById } from "../session-service.ts";

export type TransaccionConSaldo = {
  transaccion: Transaccion;
  impacto: number;
  saldoAcumulado: number;
};

export type CuentaEstadoRedis = {
  limiteConsumidoHoy: number;
  limiteDisponibleAhora: number;
  bloqueoActivo: boolean;
  motivoBloqueo: string | null;
};

export type ExtractoCuenta = {
  cliente: Cliente;
  cuenta: Cuenta;
  desde: Date;
  hasta: Date;
  saldoInicialPeriodo: number;
  transacciones: TransaccionConSaldo[];
  estadoRedis: CuentaEstadoRedis;
};

export type Operacion3ClienteContext = {
  cliente: Cliente;
  cuentas: Cuenta[];
};

const cuentasCollection = (ctx: AppContext) =>
  ctx.db.collection<Cuenta>("cuentas");
const transaccionesCollection = (ctx: AppContext) =>
  ctx.db.collection<Transaccion>("transacciones");

const limiteKey = (cuentaId: string, date = new Date()) =>
  `limite:${cuentaId}:${formatDateKey(date)}`;

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function obtenerInicioUltimoMes(hasta: Date): Date {
  const desde = new Date(hasta);
  desde.setMonth(desde.getMonth() - 1);
  return desde;
}

function calcularImpacto(transaccion: Transaccion, cuentaId: string): number {
  if (transaccion.cuentaDestinoId === cuentaId) {
    return transaccion.monto;
  }

  if (transaccion.cuentaOrigenId === cuentaId) {
    return -transaccion.monto;
  }

  return 0;
}

async function obtenerEstadoRedisCuenta(
  ctx: AppContext,
  cuentaId: string,
): Promise<CuentaEstadoRedis> {
  const [limiteRaw, motivoBloqueo] = await Promise.all([
    ctx.redis.get(limiteKey(cuentaId)),
    getBlockedReason(ctx, cuentaId),
  ]);

  const limiteConsumidoHoy = Number(limiteRaw ?? "0");
  const limiteConsumidoSeguro = Number.isNaN(limiteConsumidoHoy)
    ? 0
    : limiteConsumidoHoy;

  return {
    limiteConsumidoHoy: limiteConsumidoSeguro,
    limiteDisponibleAhora: Math.max(
      0,
      config.LIMITE_DIARIO - limiteConsumidoSeguro,
    ),
    bloqueoActivo: motivoBloqueo != null,
    motivoBloqueo,
  };
}

export async function obtenerContextoClienteOperacion3(
  ctx: AppContext,
  clienteId: string,
): Promise<Operacion3ClienteContext | null> {
  const cliente = await getClientById(ctx, clienteId);
  if (cliente == null) {
    return null;
  }

  const cuentas = await cuentasCollection(ctx)
    .find({ clienteTitularId: cliente._id }, { sort: { numero: 1 } })
    .toArray();

  return { cliente, cuentas };
}

export async function consultarExtractoCuenta(
  ctx: AppContext,
  cuentaId: string,
  hasta = new Date(),
): Promise<ExtractoCuenta | null> {
  const cuenta = await cuentasCollection(ctx).findOne({ _id: cuentaId });
  if (cuenta == null) {
    return null;
  }

  const cliente = await getClientById(ctx, cuenta.clienteTitularId);
  if (cliente == null) {
    return null;
  }

  const desde = obtenerInicioUltimoMes(hasta);
  const transacciones = await transaccionesCollection(ctx)
    .find(
      {
        fecha: { $gte: desde, $lte: hasta },
        $or: [{ cuentaOrigenId: cuentaId }, { cuentaDestinoId: cuentaId }],
      },
      { sort: { fecha: 1, _id: 1 } },
    )
    .toArray();

  const impactoPeriodo = transacciones.reduce(
    (total, transaccion) => total + calcularImpacto(transaccion, cuentaId),
    0,
  );
  let saldoAcumulado = cuenta.saldoActual - impactoPeriodo;

  const transaccionesConSaldo = transacciones.map((transaccion) => {
    const impacto = calcularImpacto(transaccion, cuentaId);
    saldoAcumulado += impacto;

    return {
      transaccion,
      impacto,
      saldoAcumulado,
    };
  });

  return {
    cliente,
    cuenta,
    desde,
    hasta,
    saldoInicialPeriodo: cuenta.saldoActual - impactoPeriodo,
    transacciones: transaccionesConSaldo,
    estadoRedis: await obtenerEstadoRedisCuenta(ctx, cuentaId),
  };
}
