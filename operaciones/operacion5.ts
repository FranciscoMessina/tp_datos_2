import {
  cancel,
  isCancel,
  log,
  note,
  select,
  spinner,
  text,
} from "@clack/prompts";
import type { AppContext } from "../db-setup.ts";
import {
  cerrarAlertaFraude,
  consumirProximaAlertaFraude,
  reencolarAlertaFraudePendiente,
  type AlertaFraudePendiente,
  type DictamenFraude,
} from "./operacion5-service.ts";

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
  }).format(new Date(date));
}

async function cancelarYReencolar(
  ctx: AppContext,
  alertaPendiente: AlertaFraudePendiente,
  mensaje: string,
): Promise<void> {
  try {
    await reencolarAlertaFraudePendiente(ctx, alertaPendiente);
    cancel(`${mensaje} La alerta fue reencolada en Redis.`);
  } catch (error) {
    cancel(`${mensaje} No se pudo reencolar la alerta en Redis.`);
    log.error(obtenerMensajeError(error));
  }
}

export async function solicitarOperacion5(ctx: AppContext): Promise<void> {
  const spinnerConsumo = spinner();
  spinnerConsumo.start("Consumiendo alerta prioritaria de Redis (ZPOPMAX)...");

  let alertaPendiente: AlertaFraudePendiente | null;

  try {
    alertaPendiente = await consumirProximaAlertaFraude(ctx);
    spinnerConsumo.stop("Alerta consumida.");
  } catch (error) {
    spinnerConsumo.stop("Falló el consumo de la alerta.");
    log.error(obtenerMensajeError(error));
    return;
  }

  if (alertaPendiente == null) {
    note(
      "No hay alertas pendientes en el SORTED SET alertas:fraude.",
      "Sin alertas pendientes",
    );
    return;
  }

  note(
    [
      `Alerta: ${alertaPendiente.alerta._id}`,
      `Transacción asociada: ${alertaPendiente.alerta.idTransaccion}`,
      `Tipo: ${alertaPendiente.alerta.tipo}`,
      `Nivel de riesgo: ${alertaPendiente.alerta.nivelRiesgo}/5`,
      `Estado actual: ${alertaPendiente.alerta.estado}`,
      `Fecha de alerta: ${formatearFecha(alertaPendiente.alerta.fecha)}`,
      `Cuentas involucradas: ${alertaPendiente.cuentasInvolucradas.join(", ") || "Sin cuentas"}`,
    ].join("\n"),
    "Alerta de fraude para analizar",
  );

  const analista = await text({
    message: "Analista de seguridad que cierra la alerta",
    placeholder: "Nombre o legajo",
    validate(value) {
      return (value ?? "").trim() === "" ? "Ingresá el analista." : undefined;
    },
  });

  if (esCancelado(analista)) {
    await cancelarYReencolar(ctx, alertaPendiente, "OP-5 cancelada.");
    return;
  }

  const dictamen = await select({
    message: "Dictamen para esta alerta",
    options: [
      {
        value: "confirmado",
        label: "Fraude confirmado",
        hint: "Aplica las marcas persistentes en MongoDB y Neo4j; el bloqueo temporal en Redis permanece vigente",
      },
      {
        value: "falso_positivo",
        label: "Falso positivo",
        hint: "Elimina los bloqueos de Redis de las cuentas involucradas",
      },
    ],
  });

  if (esCancelado(dictamen)) {
    await cancelarYReencolar(ctx, alertaPendiente, "OP-5 cancelada.");
    return;
  }

  const accionesTomadas = await text({
    message: "Acciones tomadas",
    placeholder: "Ej: Se contactó al cliente y se normalizó la cuenta",
    validate(value) {
      return (value ?? "").trim() === ""
        ? "Ingresá las acciones tomadas."
        : undefined;
    },
  });

  if (esCancelado(accionesTomadas)) {
    await cancelarYReencolar(ctx, alertaPendiente, "OP-5 cancelada.");
    return;
  }

  const spinnerCierre = spinner();
  spinnerCierre.start(
    "Registrando el cierre y aplicando acciones definitivas si corresponde...",
  );

  try {
    const resultado = await cerrarAlertaFraude(ctx, alertaPendiente, {
      analista,
      dictamen: dictamen as DictamenFraude,
      accionesTomadas,
    });

    spinnerCierre.stop("Cierre finalizado.");

    note(
      [
        `Alerta: ${resultado.alerta._id}`,
        `Transacción: ${resultado.alerta.idTransaccion}`,
        `Tipo: ${resultado.alerta.tipo}`,
        `Riesgo: ${resultado.alerta.nivelRiesgo}/5`,
        `Dictamen: ${resultado.alerta.resolucion?.estado}`,
        `Analista: ${resultado.alerta.resolucion?.analista}`,
        `Acciones tomadas: ${resultado.alerta.resolucion?.accionesTomadas}`,
        `Cuentas involucradas: ${resultado.cuentasInvolucradas.join(", ") || "Sin cuentas"}`,
        `Evento Redis Stream: ${resultado.streamEventId}`,
      ].join("\n"),
      "MongoDB · Dictamen registrado",
    );

    if (resultado.alerta.resolucion?.estado === "falso_positivo") {
      log.success(
        `Redis · Bloqueos eliminados: ${resultado.cuentasDesbloqueadas.join(", ") || "ninguno vigente"}`,
      );
    } else if (resultado.etiquetaNeo4jAplicada) {
      log.success(
        "Confirmación aplicada: MongoDB dejó las cuentas bloqueadas y Neo4j etiquetó las cuentas comprometidas.",
      );
    }
  } catch (error) {
    spinnerCierre.stop("Falló OP-5.");

    try {
      await reencolarAlertaFraudePendiente(ctx, alertaPendiente);
      log.warn("La alerta fue reencolada en Redis para no perderla.");
    } catch (requeueError) {
      throw new Error(
        [
          obtenerMensajeError(error),
          `No se pudo reencolar la alerta consumida: ${obtenerMensajeError(requeueError)}`,
        ].join("\n"),
      );
    }

    throw error;
  }
}
