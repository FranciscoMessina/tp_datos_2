import {
  cancel,
  isCancel,
  log,
  note,
  select,
  spinner,
  text,
} from "@clack/prompts";
import type { AppContext } from "./db-setup.ts";
import {
  DEFAULT_TRANSFER_DESCRIPTION,
  ejecutarTransferencia,
  formatearMoneda,
  obtenerContextoClienteOperacion1,
  validarSolicitudTransferencia,
} from "./operacion1-service.ts";
import { ensureSession, type SessionState } from "./session-service.ts";

function obtenerMensajeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function esCancelado<T>(value: T | symbol): value is symbol {
  return isCancel(value);
}

export async function solicitarOperacion1(
  ctx: AppContext,
  state: SessionState,
): Promise<void> {
  const session = await ensureSession(ctx, state);
  if (session == null) {
    note(
      "No hay una sesión cargada en memoria o la sesión expiró. Es necesario iniciar sesión para proceder.",
      "Sesión requerida",
    );
    return;
  }

  const contextoOperacion = await obtenerContextoClienteOperacion1(
    ctx,
    session.clienteId,
  );

  if (contextoOperacion == null) {
    log.error("El cliente de la sesión no existe en MongoDB.");
    return;
  }

  const { cliente, accountStatuses, cuentasHabilitadas } = contextoOperacion;

  if (accountStatuses.length === 0) {
    note("El cliente no tiene cuentas disponibles en MongoDB.", "Sin cuentas");
    return;
  }

  const resumenCuentas = accountStatuses
    .map(({ cuenta, bloqueo }) => {
      const estadoMongo = cuenta.estado === "activa" ? "Activa" : cuenta.estado;
      const bloqueoTexto = bloqueo
        ? ` | Bloqueada Temporalmente: ${bloqueo}`
        : "";
      return `${cuenta.numero} · ${cuenta.tipo} · Saldo ${formatearMoneda(cuenta.saldoActual)} ${estadoMongo}${bloqueoTexto}`;
    })
    .join("\n");

  note(resumenCuentas, `Cuentas de ${cliente.nombre}`);

  if (cuentasHabilitadas.length === 0) {
    note(
      "Todas las cuentas del cliente están bloqueadas o no activas. No es posible avanzar con la transferencia.",
      "Sin cuentas habilitadas",
    );
    return;
  }

  const cuentaOrigenId = await select({
    message: "Seleccioná la cuenta origen",
    options: cuentasHabilitadas.map(({ cuenta }) => ({
      value: cuenta._id,
      label: `${cuenta.numero} · ${formatearMoneda(cuenta.saldoActual)}`,
      hint: cuenta.tipo,
    })),
  });

  if (esCancelado(cuentaOrigenId)) {
    cancel("Transferencia cancelada.");
    return;
  }

  const cuentaOrigen = cuentasHabilitadas.find(
    ({ cuenta }) => cuenta._id === cuentaOrigenId,
  )?.cuenta;

  if (cuentaOrigen == null) {
    log.error("No se pudo resolver la cuenta origen seleccionada.");
    return;
  }

  const numeroCuentaDestino = await text({
    message: "Ingresá el número de cuenta destino",
    placeholder: "______",
    validate(value) {
      return (value ?? "").trim() === ""
        ? "El número de cuenta destino es obligatorio."
        : undefined;
    },
  });

  if (esCancelado(numeroCuentaDestino)) {
    cancel("Transferencia cancelada.");
    return;
  }

  const montoRaw = await text({
    message: "Monto a transferir",
    placeholder: "1000",
    validate(value) {
      const sanitized = (value ?? "").trim().replace(",", ".");
      const parsed = Number(sanitized);

      if (sanitized === "") {
        return "El monto es obligatorio.";
      }

      if (Number.isNaN(parsed) || parsed <= 0) {
        return "Ingresá un monto numérico mayor a cero.";
      }

      return undefined;
    },
  });

  if (esCancelado(montoRaw)) {
    cancel("Transferencia cancelada.");
    return;
  }

  const monto = Number(montoRaw.trim().replace(",", "."));
  const validacion = await validarSolicitudTransferencia(ctx, {
    cuentaOrigen,
    numeroCuentaDestino,
    monto,
  });

  if (!validacion.ok) {
    switch (validacion.code) {
      case "DESTINO_NO_ENCONTRADO":
        log.error("La cuenta destino no existe en MongoDB.");
        return;
      case "DESTINO_IGUAL_ORIGEN":
        log.error(
          "La cuenta destino no puede ser la misma que la cuenta origen.",
        );
        return;
      case "DESTINO_INACTIVO":
        log.error("La cuenta destino no está activa.");
        return;
      case "DESTINO_BLOQUEADO":
        note(
          `La cuenta destino está bloqueada en Redis: ${validacion.bloqueoDestino}`,
          "Cuenta destino bloqueada",
        );
        return;
      case "SALDO_INSUFICIENTE":
        note(
          [
            `Saldo disponible: ${formatearMoneda(cuentaOrigen.saldoActual)}`,
            `Monto solicitado: ${formatearMoneda(monto)}`,
          ].join("\n"),
          "Saldo insuficiente",
        );
        return;
      case "LIMITE_INSUFICIENTE":
        note(
          [
            `Consumido hoy: ${formatearMoneda(validacion.limiteActual ?? 0)}`,
            `Disponible hoy: ${formatearMoneda(validacion.disponibleAntes ?? 0)}`,
          ].join("\n"),
          "Límite diario insuficiente",
        );
        return;
    }
  }

  const descripcion = await text({
    message: "Descripción de la transferencia",
    placeholder: DEFAULT_TRANSFER_DESCRIPTION,
    defaultValue: DEFAULT_TRANSFER_DESCRIPTION,
  });

  if (esCancelado(descripcion)) {
    cancel("Transferencia cancelada.");
    return;
  }

  note(
    [
      `Cliente: ${cliente.nombre}`,
      `Origen: ${cuentaOrigen.numero}`,
      `Destino: ${validacion.cuentaDestino.numero}`,
      `Monto: ${formatearMoneda(monto)}`,
      `Disponible antes de operar: ${formatearMoneda(validacion.disponibleAntes)}`,
    ].join("\n"),
    "Resumen previo",
  );

  const spinnerTransferencia = spinner();
  spinnerTransferencia.start("Ejecutando transferencia...");

  try {
    const resultado = await ejecutarTransferencia(ctx, {
      cliente,
      session,
      cuentaOrigen,
      cuentaDestino: validacion.cuentaDestino,
      monto,
      descripcion,
    });

    spinnerTransferencia.stop("Transferencia completada.");
    note(
      [
        `ID transacción: ${resultado.transaccionId}`,
        `Monto transferido: ${formatearMoneda(resultado.monto)}`,
        `Nuevo saldo origen: ${formatearMoneda(resultado.saldoOrigenEsperado)}`,
        `Monto acumulado hoy: ${formatearMoneda(resultado.montoAcumulado)}`,
      ].join("\n"),
      "Operación exitosa",
    );
  } catch (error) {
    spinnerTransferencia.stop("Falló la transferencia.");
    log.error(obtenerMensajeError(error));
  }
}
