import { cancel, isCancel, log, note, spinner, text } from "@clack/prompts";
import type { AppContext } from "./db-setup.ts";
import { formatearMoneda } from "./operacion1-service.ts";
import { trazarTransferenciaRegulatoria } from "./operacion4-service.ts";

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

export async function solicitarOperacion4(ctx: AppContext): Promise<void> {
  const transaccionId = await text({
    message: "Ingresá el ID de la transferencia a trazar",
    placeholder: "UUID / id de transacción",
    validate(value) {
      return (value ?? "").trim() === ""
        ? "Ingresá un ID de transacción."
        : undefined;
    },
  });

  if (esCancelado(transaccionId)) {
    cancel("OP-4 cancelada.");
    return;
  }

  const spinnerConsulta = spinner();
  spinnerConsulta.start("Trazando transferencia en MongoDB y Neo4j...");

  try {
    const trazabilidad = await trazarTransferenciaRegulatoria(
      ctx,
      transaccionId,
    );
    spinnerConsulta.stop("Trazabilidad finalizada.");

    if (trazabilidad == null) {
      note(
        "No se encontró una transferencia en MongoDB con ese ID.",
        "Transacción inexistente",
      );
      return;
    }

    const { transaccionOriginal, cuentaOrigen, cuentaDestino } = trazabilidad;

    note(
      [
        `ID: ${transaccionOriginal._id}`,
        `Fecha: ${formatearFecha(transaccionOriginal.fecha)}`,
        `Tipo: ${transaccionOriginal.tipo}`,
        `Canal: ${transaccionOriginal.canal}`,
        `Monto: ${formatearMoneda(transaccionOriginal.monto)}`,
        `Origen: ${cuentaOrigen?.numero ?? transaccionOriginal.cuentaOrigenId}`,
        `Destino: ${cuentaDestino?.numero ?? transaccionOriginal.cuentaDestinoId ?? "Sin destino"}`,
        `Descripción: ${transaccionOriginal.descripcion?.trim() || "Sin descripción"}`,
      ].join("\n"),
      "MongoDB · Detalle completo de la transacción original",
    );

    note(
      [
        `Cuentas involucradas: ${trazabilidad.cuentasInvolucradas.length}`,
        `Transacciones recuperadas desde MongoDB: ${trazabilidad.transaccionesInvolucradas.length}`,
        `Caminos detectados en Neo4j: ${trazabilidad.caminos.length}`,
        "Profundidad máxima: 5 saltos desde la transferencia original",
      ].join("\n"),
      "Resumen regulatorio",
    );

    if (trazabilidad.caminos.length === 0) {
      note(
        "MongoDB contiene la transferencia, pero Neo4j no tiene una arista TRANSFIRIO con ese ID o no hay recorrido posterior.",
        "Sin camino en grafo",
      );
      return;
    }

    note(
      trazabilidad.caminos
        .slice(0, 10)
        .map(
          (camino, index) =>
            `${index + 1}. ${camino.saltos} salto(s) · ${formatearMoneda(camino.montoTotal)}\nCuentas: ${camino.cuentas.join(" -> ")}\nTransacciones: ${camino.transacciones.join(" -> ")}`,
        )
        .join("\n\n"),
      "Neo4j · Recorrido de fondos hasta 5 saltos",
    );

    note(
      trazabilidad.transaccionesInvolucradas
        .map(
          (tx) =>
            `${formatearFecha(tx.fecha)} · ${tx._id} · ${tx.cuentaOrigenId} -> ${tx.cuentaDestinoId ?? "N/A"} · ${formatearMoneda(tx.monto)}`,
        )
        .join("\n"),
      "MongoDB · Transacciones involucradas en los caminos",
    );
  } catch (error) {
    spinnerConsulta.stop("Falló OP-4.");
    log.error(obtenerMensajeError(error));
  }
}
