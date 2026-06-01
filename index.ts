import {
  cancel,
  intro,
  isCancel,
  log,
  note,
  outro,
  select,
  text,
} from "@clack/prompts";
import { closeContext, createContext, type AppContext } from "./db-setup.ts";
import { solicitarOperacion1 } from "./operaciones/operacion1.ts";
import { solicitarOperacion2 } from "./operaciones/operacion2.ts";
import { solicitarOperacion3 } from "./operaciones/operacion3.ts";
import { solicitarOperacion4 } from "./operaciones/operacion4.ts";
import { solicitarOperacion5 } from "./operaciones/operacion5.ts";
import {
  getActiveClientLabel,
  loginCliente,
  logoutCliente,
  searchClientes,
  type SessionState,
} from "./session-service.ts";

function obtenerMensajeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fueCancelado<T>(value: T | symbol): value is symbol {
  return isCancel(value);
}

async function pedirLogin(ctx: AppContext, state: SessionState): Promise<void> {
  const searchTerm = await text({
    message: "Buscá un cliente por ID, nombre o documento",
    placeholder: "CLI00123 / Juan Pérez / 30111222",
    validate(value) {
      return (value ?? "").trim() === ""
        ? "Ingresá un término de búsqueda."
        : undefined;
    },
  });

  if (fueCancelado(searchTerm)) {
    cancel("Inicio de sesión cancelado.");
    return;
  }

  const clientes = await searchClientes(ctx, searchTerm);
  if (clientes.length === 0) {
    note(
      `No se encontraron clientes que coincidan con "${searchTerm.trim()}".`,
      "Sin resultados",
    );
    return;
  }

  const selectedClientId = await select({
    message: `Seleccioná el cliente que va a iniciar sesión (${clientes.length} resultado${clientes.length === 1 ? "" : "s"})`,
    options: clientes.map((cliente) => ({
      value: cliente._id,
      label: `${cliente.nombre} (${cliente.documento})`,
      hint: cliente.tipo,
    })),
  });

  if (fueCancelado(selectedClientId)) {
    cancel("Inicio de sesión cancelado.");
    return;
  }

  const { cliente, existingSession } = await loginCliente(
    ctx,
    selectedClientId,
  );
  if (cliente == null) {
    log.error("El cliente seleccionado ya no existe en MongoDB.");
    return;
  }

  if (existingSession != null) {
    note(
      [
        "Ya existía una sesión activa en Redis para este cliente.",
        `Dispositivo previo: ${existingSession.dispositivo}`,
        `IP previa: ${existingSession.ip}`,
        "Se renovará la sesión con los datos ingresados.",
      ].join("\n"),
      "Sesión existente",
    );
  }

  state.clienteId = selectedClientId;
  log.success(`Sesión iniciada para ${cliente.nombre} y cargada en Redis.`);
}

async function pedirLogout(
  ctx: AppContext,
  state: SessionState,
): Promise<void> {
  if (state.clienteId == null) {
    note("No hay una sesión en memoria para cerrar.", "Cerrar sesión");
    return;
  }

  await logoutCliente(ctx, state.clienteId);
  state.clienteId = null;
  log.success("Sesión cerrada en Redis y removida de la memoria de la CLI.");
}

async function ejecutarAccionMenu(
  ctx: AppContext,
  state: SessionState,
  action: string,
): Promise<void> {
  switch (action) {
    case "login":
      await pedirLogin(ctx, state);
      break;
    case "op1":
      await solicitarOperacion1(ctx, state);
      break;
    case "op2":
      await solicitarOperacion2(ctx);
      break;
    case "op3":
      await solicitarOperacion3(ctx, state);
      break;
    case "op4":
      await solicitarOperacion4(ctx);
      break;
    case "op5":
      await solicitarOperacion5(ctx);
      break;
    case "logout":
      await pedirLogout(ctx, state);
      break;
    default:
      log.warn("Opción no reconocida.");
      break;
  }
}

async function ejecutarMenu(ctx: AppContext): Promise<void> {
  const state: SessionState = { clienteId: null };

  while (true) {
    const activeClientName = await getActiveClientLabel(ctx, state);

    const action = await select({
      message:
        activeClientName == null
          ? "Seleccioná una acción"
          : `Seleccioná una acción · Sesión activa: ${activeClientName}`,
      options: [
        activeClientName == null
          ? { value: "login", label: "Iniciar sesión" }
          : { value: "logout", label: `Cerrar sesión (${activeClientName})` },
        { value: "op1", label: "OP-1 · Validar y ejecutar transferencia" },
        { value: "op2", label: "OP-2 · Detección y gestión de fraude" },
        { value: "op3", label: "OP-3 · Extracto y estado de cuenta" },
        { value: "op4", label: "OP-4 · Trazabilidad regulatoria" },
        { value: "op5", label: "OP-5 · Cierre de alerta de fraude" },
        { value: "exit", label: "Salir" },
      ],
    });

    if (fueCancelado(action) || action === "exit") {
      break;
    }

    try {
      await ejecutarAccionMenu(ctx, state, action);
    } catch (error) {
      throw new Error(
        `La CLI se cerró por un error al ejecutar ${action}: ${obtenerMensajeError(error)}`,
      );
    }
  }
}

async function principal(): Promise<void> {
  intro("Iniciando CLI sistema bancario");
  let ctx: AppContext | null = null;
  try {
    ctx = await createContext();
    if (!ctx) {
      throw new Error(
        "No se pudo crear el contexto de la CLI. Revisa las conexiones a las bases de datos.",
      );
    }
    await ejecutarMenu(ctx);
    outro("CLI finalizada.");
  } catch (error) {
    log.error(obtenerMensajeError(error));
    cancel("La CLI se cerró por un error fatal.");
    process.exit(1);
  } finally {
    if (!ctx) {
      throw new Error(
        "No se pudo crear el contexto de la CLI. Revisa las conexiones a las bases de datos.",
      );
    }
    await closeContext(ctx);
  }
}

await principal().catch((error) => {
  log.error(obtenerMensajeError(error));
  cancel("La CLI se cerró por un error fatal.");
  process.exitCode = 1;
});
