import {
  cancel,
  confirm,
  isCancel,
  log,
  note,
  select,
  spinner,
  text,
} from "@clack/prompts";
import type { AppContext } from "./db-setup.ts";
import { formatearMoneda } from "./operacion1-service.ts";
import {
  buscarFraudePorTipo,
  type FraudPatternType,
} from "./operacion2-service.ts";

function obtenerMensajeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function esCancelado<T>(value: T | symbol): value is symbol {
  return isCancel(value);
}

export async function solicitarOperacion2(ctx: AppContext): Promise<void> {
  const tipoFraude = await select({
    message: "¿Qué tipo de fraude querés detectar?",
    options: [
      {
        value: "ciclo",
        label: "Ciclo",
        hint: "Transferencias que vuelven a una cuenta anterior",
      },
      {
        value: "smurfing",
        label: "Smurfing",
        hint: "Muchas transferencias pequeñas hacia una misma cuenta",
      },
      {
        value: "lavado",
        label: "Lavado",
        hint: "Ciclos de transferencias donde el dinero vuelve al origen",
      },
      {
        value: "destinatariosInusuales",
        label: "Destinatarios inusuales",
        hint: "Cuenta receptora con muchos remitentes nuevos en 90 días",
      },
      {
        value: "cascada",
        label: "Cascada",
        hint: "Cadena larga de transferencias posteriores",
      },
    ],
  });

  if (esCancelado(tipoFraude)) {
    cancel("OP-2 cancelada.");
    return;
  }

  let maxHops = 4;
  if (tipoFraude !== "smurfing" && tipoFraude !== "destinatariosInusuales") {
    const maxHopsRaw = await text({
      message: "Cantidad máxima de saltos a recorrer en Neo4j",
      placeholder: "4",
      defaultValue: "4",
      validate(value) {
        const parsed = Number((value ?? "").trim());
        if (!Number.isInteger(parsed) || parsed < 2 || parsed > 8) {
          return "Ingresá un entero entre 2 y 8.";
        }
        return undefined;
      },
    });

    if (esCancelado(maxHopsRaw)) {
      cancel("OP-2 cancelada.");
      return;
    }

    maxHops = Number(maxHopsRaw);
  }

  const confirmarFraude = await confirm({
    message:
      "Si se encuentran casos, ¿confirmar fraude y bloquear/marcar las cuentas involucradas?",
    initialValue: false,
  });

  if (esCancelado(confirmarFraude)) {
    cancel("OP-2 cancelada.");
    return;
  }

  const spinnerBusqueda = spinner();
  spinnerBusqueda.start(`Buscando patrón ${tipoFraude}...`);

  try {
    const resultado = await buscarFraudePorTipo(ctx, {
      tipo: tipoFraude as FraudPatternType,
      maxHops,
      confirmarFraude,
    });

    spinnerBusqueda.stop("Búsqueda finalizada.");

    note(
      [
        `Tipo buscado: ${resultado.tipoBuscado}`,
        `Casos detectados: ${resultado.patrones.length}`,
        `Cuentas involucradas: ${resultado.cuentasInvolucradas.length}`,
        `Transferencias MongoDB recuperadas: ${resultado.historialMongo.length}`,
        `Cadenas Neo4j recuperadas: ${resultado.cadenasPosteriores.length}`,
      ].join("\n"),
      "Resumen de búsqueda",
    );

    if (resultado.patrones.length === 0) {
      note(
        `No se detectaron casos compatibles con ${resultado.tipoBuscado}.`,
        "Sin fraude detectado",
      );
      return;
    }

    note(
      resultado.patrones
        .slice(0, 10)
        .map(
          (pattern, index) =>
            `${index + 1}. ${pattern.tipo.toUpperCase()} · Riesgo ${pattern.nivelRiesgo}/5\n${pattern.descripcion}\nCuentas: ${pattern.cuentasInvolucradas.join(", ")}\nTransacciones: ${pattern.transaccionesInvolucradas.join(", ")}`,
        )
        .join("\n\n"),
      "Casos sospechosos encontrados",
    );

    if (resultado.cadenasPosteriores.length > 0) {
      note(
        resultado.cadenasPosteriores
          .slice(0, 5)
          .map(
            (chain, index) =>
              `${index + 1}. ${chain.saltos} salto(s) · ${formatearMoneda(chain.montoTotal)} · ${chain.cuentas.join(" -> ")}`,
          )
          .join("\n"),
        "Primeras cadenas detectadas",
      );
    }

    note(
      resultado.alertas
        .map(
          (alerta) =>
            `${alerta.tipo.toUpperCase()} · Riesgo ${alerta.nivelRiesgo}/5 · ${alerta._id}`,
        )
        .join("\n"),
      "Alertas ordenadas por riesgo",
    );

    if (resultado.fraudeConfirmado) {
      log.success(
        "Fraude confirmado: cuentas bloqueadas en MongoDB/Redis, grafo marcado en Neo4j y alertas publicadas en seguridad:stream.",
      );
    } else {
      log.warn(
        "Se encontraron casos sospechosos, pero no se confirmó fraude ni se aplicaron bloqueos.",
      );
    }
  } catch (error) {
    spinnerBusqueda.stop("Falló OP-2.");
    log.error(obtenerMensajeError(error));
  }
}
