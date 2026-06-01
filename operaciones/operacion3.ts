import { cancel, isCancel, log, note, select, spinner } from "@clack/prompts";
import type { AppContext } from "../db-setup.ts";
import { formatearMoneda } from "./operacion1-service.ts";
import {
  consultarExtractoCuenta,
  obtenerContextoClienteOperacion3,
} from "./operacion3-service.ts";
import { ensureSession, type SessionState } from "../session-service.ts";

function obtenerMensajeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function esCancelado<T>(value: T | symbol): value is symbol {
  return isCancel(value);
}

function formatearFecha(date: Date): string {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function describirContraparte(
  cuentaId: string,
  cuentaOrigenId: string,
  cuentaDestinoId?: string,
): string {
  if (cuentaDestinoId === cuentaId) {
    return `Origen: ${cuentaOrigenId}`;
  }

  if (cuentaOrigenId === cuentaId && cuentaDestinoId != null) {
    return `Destino: ${cuentaDestinoId}`;
  }

  return cuentaOrigenId === cuentaId ? "Egreso" : "Ingreso";
}

export async function solicitarOperacion3(
  ctx: AppContext,
  state: SessionState,
): Promise<void> {
  const session = await ensureSession(ctx, state);
  if (session == null) {
    note(
      "No hay una sesión cargada en memoria o la sesión expiró. Es necesario iniciar sesión para consultar el extracto.",
      "Sesión requerida",
    );
    return;
  }

  const contexto = await obtenerContextoClienteOperacion3(
    ctx,
    session.clienteId,
  );
  if (contexto == null) {
    log.error("El cliente de la sesión no existe en MongoDB.");
    return;
  }

  const { cliente, cuentas } = contexto;
  if (cuentas.length === 0) {
    note("El cliente no tiene cuentas asociadas.", "Sin cuentas");
    return;
  }

  const cuentaId = await select({
    message: "Seleccioná la cuenta a consultar",
    options: cuentas.map((cuenta) => ({
      value: cuenta._id,
      label: `${cuenta.numero} · ${cuenta.tipo} · ${formatearMoneda(cuenta.saldoActual)}`,
      hint: cuenta.estado,
    })),
  });

  if (esCancelado(cuentaId)) {
    cancel("OP-3 cancelada.");
    return;
  }

  const spinnerConsulta = spinner();
  spinnerConsulta.start("Consultando extracto en...");

  try {
    const extracto = await consultarExtractoCuenta(ctx, cuentaId);
    spinnerConsulta.stop("Consulta finalizada.");

    if (extracto == null) {
      log.error("No se pudo resolver la cuenta o su cliente titular.");
      return;
    }

    note(
      [
        `Cliente: ${cliente.nombre}`,
        `Cuenta: ${extracto.cuenta.numero} (${extracto.cuenta.tipo})`,
        `Período: ${formatearFecha(extracto.desde)} a ${formatearFecha(extracto.hasta)}`,
        `Saldo inicial del período: ${formatearMoneda(extracto.saldoInicialPeriodo)}`,
        `Saldo actual: ${formatearMoneda(extracto.cuenta.saldoActual)}`,
      ].join("\n"),
      "Extracto del último mes",
    );

    if (extracto.transacciones.length === 0) {
      note(
        "No se registraron transacciones para esta cuenta durante el último mes.",
        "Sin movimientos",
      );
    } else {
      note(
        extracto.transacciones
          .map(({ transaccion, impacto, saldoAcumulado }, index) => {
            const signo = impacto >= 0 ? "+" : "-";
            const descripcion =
              transaccion.descripcion?.trim() || "Sin descripción";
            const contraparte = describirContraparte(
              extracto.cuenta._id,
              transaccion.cuentaOrigenId,
              transaccion.cuentaDestinoId,
            );

            return [
              `${index + 1}. ${formatearFecha(transaccion.fecha)} · ${transaccion.tipo.toUpperCase()} · ${transaccion.canal}`,
              `${descripcion} · ${contraparte}`,
              `Movimiento: ${signo}${formatearMoneda(Math.abs(impacto))} · Saldo acumulado: ${formatearMoneda(saldoAcumulado)}`,
            ].join("\n");
          })
          .join("\n\n"),
        "Movimientos cronológicos con saldo acumulado",
      );
    }

    note(
      [
        `Límite diario total: ${formatearMoneda(extracto.estadoRedis.limiteConsumidoHoy + extracto.estadoRedis.limiteDisponibleAhora)}`,
        `Consumido hoy: ${formatearMoneda(extracto.estadoRedis.limiteConsumidoHoy)}`,
        `Disponible ahora: ${formatearMoneda(extracto.estadoRedis.limiteDisponibleAhora)}`,
        extracto.estadoRedis.bloqueoActivo
          ? `Bloqueo activo: Sí · Motivo: ${extracto.estadoRedis.motivoBloqueo}`
          : "Bloqueo activo: No",
      ].join("\n"),
      "Estado actual",
    );
  } catch (error) {
    spinnerConsulta.stop("Falló OP-3.");
    throw error;
  }
}
