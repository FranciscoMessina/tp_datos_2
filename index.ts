import {
  cancel,
  intro,
  isCancel,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { ObjectId } from "mongodb";
import { config } from "./config.ts";
import { closeContext, createContext, type AppContext } from "./db-setup.ts";
import {
  bloquearCuentaPreventivamente,
  cerrarSesionBancaria,
  consultarLimiteDisponibleActual,
  consumirAlertaDeMayorRiesgoPendiente,
  desbloquearCuentaManual,
  iniciarSesionBancaria,
  publicarAlertaFraude,
  reencolarAlertaFraude,
  registrarEventoSeguridad,
  type AlertaFraude,
  type SesionBancaria,
  validarSesionActiva,
  verificarCuentaBloqueada,
  verificarYRegistrarTransferencia,
} from "./queries/redis_db.ts";

type TransferInput = {
  clienteId: string;
  cuentaOrigen: string;
  cuentaDestino: string;
  monto: number;
  canal: "app" | "cajero" | "sucursal";
  descripcion: string;
};

const requiredText = async (
  message: string,
  placeholder?: string,
): Promise<string> => {
  const value = await text({
    message,
    placeholder,
    validate: (input) =>
      !input || input.trim() === "" ? "Este campo es obligatorio" : undefined,
  });

  if (isCancel(value)) {
    cancel("Operación cancelada");
    process.exit(0);
  }

  return value.trim();
};

const requiredNumber = async (
  message: string,
  placeholder?: string,
): Promise<number> => {
  const value = await requiredText(message, placeholder);
  const parsed = Number(value.replaceAll("_", ""));

  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error("El valor debe ser un número mayor a cero");
  }

  return parsed;
};

const op1Transfer = async (ctx: AppContext, input: TransferInput) => {
  await validarSesionActiva(ctx.redis, input.clienteId);

  const bloqueo = await verificarCuentaBloqueada(ctx.redis, input.cuentaOrigen);
  if (bloqueo) {
    throw new Error(`La cuenta está bloqueada: ${bloqueo.motivo}`);
  }

  const limite = await verificarYRegistrarTransferencia(
    ctx.redis,
    input.cuentaOrigen,
    input.monto,
    config.LIMITE_DIARIO,
  );

  if (!limite.permitido) {
    throw new Error(
      `Límite diario insuficiente. Disponible: ${limite.disponible}`,
    );
  }

  const transaccion = {
    tipo: "transferencia",
    monto: input.monto,
    fecha: new Date(),
    fechaYHora: new Date(),
    cuentaOrigen: input.cuentaOrigen,
    cuentaDestino: input.cuentaDestino,
    descripcion: input.descripcion,
    canal: input.canal,
    estado: "aprobada",
  };

  const inserted = await ctx.db
    .collection("transacciones")
    .insertOne(transaccion);

  const session = ctx.neo4j.session({ database: config.NEO_4J_DATABASE });
  try {
    await session.executeWrite((tx) =>
      tx.run(
        `
        MERGE (origen:Cuenta {numero: $cuentaOrigen})
        MERGE (destino:Cuenta {numero: $cuentaDestino})
        CREATE (origen)-[:TRANSFIRIO {
          id: $id,
          monto: $monto,
          fecha: datetime($fecha),
          canal: $canal,
          descripcion: $descripcion
        }]->(destino)
        `,
        {
          id: inserted.insertedId.toString(),
          cuentaOrigen: input.cuentaOrigen,
          cuentaDestino: input.cuentaDestino,
          monto: input.monto,
          fecha: transaccion.fecha.toISOString(),
          canal: input.canal,
          descripcion: input.descripcion,
        },
      ),
    );
  } finally {
    await session.close();
  }

  await registrarEventoSeguridad(ctx.redis, "transferencia_ejecutada", {
    clienteId: input.clienteId,
    cuentaOrigen: input.cuentaOrigen,
    cuentaDestino: input.cuentaDestino,
    monto: input.monto,
    transaccionId: inserted.insertedId.toString(),
  });

  return {
    transaccionId: inserted.insertedId.toString(),
    limiteDisponible: limite.disponible,
  };
};

const op2FraudDetection = async (
  ctx: AppContext,
  cuentaId: string,
  patron: string,
  riesgo: number,
) => {
  const session = ctx.neo4j.session({ database: config.NEO_4J_DATABASE });
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `
        MATCH path = (origen:Cuenta {numero: $cuentaId})-[:TRANSFIRIO*1..5]->(destino:Cuenta)
        RETURN [n IN nodes(path) | n.numero] AS recorrido, length(path) AS saltos
        ORDER BY saltos DESC
        LIMIT 5
        `,
        { cuentaId },
      ),
    );

    const cuentas = new Set<string>([cuentaId]);
    const recorridos = result.records.map((record) => {
      const recorrido = record.get("recorrido") as string[];
      recorrido.forEach((cuenta) => {
        cuentas.add(String(cuenta));
      });
      return recorrido;
    });

    for (const cuenta of cuentas) {
      await bloquearCuentaPreventivamente(
        ctx.redis,
        cuenta,
        `Patrón sospechoso: ${patron}`,
      );
    }

    const alertaId = new ObjectId().toString();
    await publicarAlertaFraude(ctx.redis, {
      alertaId,
      cuentaId,
      tipo: patron,
      nivelRiesgo: riesgo,
      detalle: `Cuentas involucradas: ${Array.from(cuentas).join(", ")}`,
      cuentasInvolucradas: Array.from(cuentas),
    });

    await ctx.db.collection("alertas").insertOne({
      alertaId,
      tipo: patron,
      nivelRiesgo: riesgo,
      estado: "pendiente",
      fecha: new Date(),
      cuentaId,
      cuentasInvolucradas: Array.from(cuentas),
      recorridos,
    });

    return { alertaId, cuentasBloqueadas: Array.from(cuentas), recorridos };
  } finally {
    await session.close();
  }
};

const op3StatementStatus = async (
  ctx: AppContext,
  clienteId: string,
  cuentaId: string,
  desde: Date,
  hasta: Date,
) => {
  const transacciones = await ctx.db
    .collection("transacciones")
    .find({
      $or: [{ cuentaOrigen: cuentaId }, { cuentaDestino: cuentaId }],
      $and: [{ fecha: { $gte: desde } }, { fecha: { $lte: hasta } }],
    })
    .sort({ fecha: 1, fechaYHora: 1 })
    .toArray();

  let saldoAcumulado = 0;
  const extracto = transacciones.map((tx) => {
    const monto = Number(tx.monto ?? 0);
    saldoAcumulado += tx.cuentaDestino === cuentaId ? monto : -monto;
    return { ...tx, saldoAcumulado };
  });

  const [limite, bloqueo] = await Promise.all([
    consultarLimiteDisponibleActual(ctx.redis, cuentaId, config.LIMITE_DIARIO),
    verificarCuentaBloqueada(ctx.redis, cuentaId),
  ]);

  let sesionActiva = true;
  try {
    await validarSesionActiva(ctx.redis, clienteId);
  } catch {
    sesionActiva = false;
  }

  return { movimientos: extracto.length, limite, bloqueo, sesionActiva };
};

const op4Traceability = async (ctx: AppContext, transaccionId: string) => {
  const transaccion = await ctx.db
    .collection("transacciones")
    .findOne({ _id: new ObjectId(transaccionId) });
  if (!transaccion) {
    throw new Error("No existe una transacción con ese ID en MongoDB");
  }

  const session = ctx.neo4j.session({ database: config.NEO_4J_DATABASE });
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `
        MATCH (origen:Cuenta {numero: $cuentaDestino})
        MATCH path = (origen)-[:TRANSFIRIO*0..5]->(destino:Cuenta)
        RETURN [n IN nodes(path) | n.numero] AS recorrido, length(path) AS saltos
        ORDER BY saltos DESC
        LIMIT 10
        `,
        { cuentaDestino: String(transaccion.cuentaDestino) },
      ),
    );

    return {
      transaccion: {
        id: transaccionId,
        monto: transaccion.monto,
        fecha: transaccion.fecha,
        canal: transaccion.canal,
        descripcion: transaccion.descripcion,
      },
      recorridos: result.records.map((record) => ({
        recorrido: record.get("recorrido"),
        saltos: record.get("saltos").toNumber?.() ?? record.get("saltos"),
      })),
    };
  } finally {
    await session.close();
  }
};

const getAlertClosureContext = async (
  ctx: AppContext,
  alerta: AlertaFraude,
) => {
  const alertaPersistida = await ctx.db.collection("alertas").findOne({
    alertaId: alerta.alertaId,
  });

  const cuentasAfectadas = Array.from(
    new Set([
      ...(Array.isArray(alerta.cuentasInvolucradas)
        ? alerta.cuentasInvolucradas
        : []),
      ...(Array.isArray(alertaPersistida?.cuentasInvolucradas)
        ? alertaPersistida.cuentasInvolucradas.map((cuenta) => String(cuenta))
        : []),
      alerta.cuentaId,
    ]),
  );

  return {
    alertaPersistida,
    cuentasAfectadas,
  };
};

const op5CloseAlert = async (
  ctx: AppContext,
  alerta: AlertaFraude,
  resolucion: "fraude_confirmado" | "falso_positivo",
  analista: string,
  cuentasAfectadas: string[],
) => {
  if (resolucion === "falso_positivo") {
    for (const cuenta of cuentasAfectadas) {
      await desbloquearCuentaManual(ctx.redis, cuenta);
    }
  }

  await ctx.db.collection("alertas").updateOne(
    { alertaId: alerta.alertaId },
    {
      $set: {
        estado: "cerrada",
        resolucion,
        analista,
        fechaCierre: new Date(),
        cuentasInvolucradas: cuentasAfectadas,
        accionesTomadas:
          resolucion === "falso_positivo"
            ? "desbloqueo_manual"
            : "marcar_comprometidas",
      },
      $setOnInsert: {
        alertaId: alerta.alertaId,
        tipo: alerta.tipo,
        nivelRiesgo: alerta.nivelRiesgo,
        fecha: new Date(alerta.creadaEn),
      },
    },
    { upsert: true },
  );

  if (resolucion === "fraude_confirmado") {
    const session = ctx.neo4j.session({ database: config.NEO_4J_DATABASE });
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `
          UNWIND $cuentas AS numero
          MATCH (c:Cuenta {numero: numero})
          SET c:CuentaComprometida, c.comprometida = true, c.fechaMarcadoComprometida = datetime()
          `,
          { cuentas: cuentasAfectadas },
        ),
      );
    } finally {
      await session.close();
    }
  }

  await registrarEventoSeguridad(ctx.redis, "alerta_fraude_cerrada", {
    alertaId: alerta.alertaId,
    resolucion,
    analista,
    cuentasInvolucradas: cuentasAfectadas.join(","),
  });

  return { alertaId: alerta.alertaId, resolucion, cuentasAfectadas };
};

const showResult = (title: string, result: unknown): void => {
  note(JSON.stringify(result, null, 2), title);
};

const runWithSpinner = async <T>(
  message: string,
  action: () => Promise<T>,
): Promise<T> => {
  const s = spinner();
  s.start(message);
  try {
    const result = await action();
    s.stop("Operación completada");
    return result;
  } catch (error) {
    s.stop("Operación fallida");
    throw error;
  }
};

type CliState = {
  session: SesionBancaria | null;
};

type MenuOption =
  | "login"
  | "logout"
  | "op1"
  | "op2"
  | "op3"
  | "op4"
  | "op5"
  | "exit";

const requireCliSession = async (
  ctx: AppContext,
  state: CliState,
): Promise<SesionBancaria> => {
  if (!state.session) {
    throw new Error("Debés iniciar sesión antes de ejecutar esta operación");
  }

  try {
    const sesion = await validarSesionActiva(
      ctx.redis,
      state.session.clienteId,
    );
    state.session = sesion;
    return sesion;
  } catch {
    state.session = null;
    throw new Error("Sesión vencida");
  }
};

const getMenuOptions = (state: CliState) => [
  {
    value: "login",
    label: "Iniciar sesión",
    hint: "Algunas operaciones requieren que se inicie sesion como un cliente del banco",
  },
  ...(state.session
    ? [
        {
          value: "logout",
          label: `Cerrar sesión (${state.session.clienteId})`,
        },
      ]
    : []),
  { value: "op1", label: "OP-1 Transferencia" },
  { value: "op2", label: "OP-2 Detectar fraude" },
  { value: "op3", label: "OP-3 Extracto + estado" },
  { value: "op4", label: "OP-4 Trazabilidad" },
  { value: "op5", label: "OP-5 Cerrar alerta" },
  { value: "exit", label: "Salir" },
];

const handleLoginOption = async (
  ctx: AppContext,
  state: CliState,
): Promise<void> => {
  const clienteId = await requiredText("Cliente ID", "CLI00123");
  const canal = (await select({
    message: "Canal",
    options: ["app", "web", "cajero", "sucursal"].map((value) => ({
      value,
      label: value,
    })),
  })) as "app" | "web" | "cajero" | "sucursal";
  const dispositivo = await requiredText("Dispositivo", "iphone-15");
  const ip = await requiredText("IP", "127.0.0.1");
  const result = await runWithSpinner("Creando sesión", () =>
    iniciarSesionBancaria(ctx.redis, {
      clienteId,
      canal,
      dispositivo,
      ip,
    }),
  );

  state.session = result.sesion;
  showResult("Sesión", result);
};

const handleLogoutOption = async (
  ctx: AppContext,
  state: CliState,
): Promise<void> => {
  const sesion = await requireCliSession(ctx, state);
  const result = await runWithSpinner("Cerrando sesión", () =>
    cerrarSesionBancaria(ctx.redis, sesion.clienteId),
  );

  state.session = null;
  showResult("Logout", {
    clienteId: sesion.clienteId,
    cerrada: result,
    removidaDeMemoria: true,
  });
};

const handleOp1Option = async (
  ctx: AppContext,
  state: CliState,
): Promise<void> => {
  const sesion = await requireCliSession(ctx, state);
  const cuentaOrigen = await requiredText("Cuenta origen", "CTA00456");
  const cuentaDestino = await requiredText("Cuenta destino", "CTA00999");
  const monto = await requiredNumber("Monto", "10000");
  const canal = (await select({
    message: "Canal",
    options: ["app", "cajero", "sucursal"].map((value) => ({
      value,
      label: value,
    })),
  })) as "app" | "cajero" | "sucursal";
  const descripcion = await requiredText("Descripción", "Transferencia demo");

  const result = await runWithSpinner("Ejecutando transferencia", () =>
    op1Transfer(ctx, {
      clienteId: sesion.clienteId,
      cuentaOrigen,
      cuentaDestino,
      monto,
      canal,
      descripcion,
    }),
  );

  showResult("OP-1", result);
};

const handleOp2Option = async (ctx: AppContext): Promise<void> => {
  const cuentaId = await requiredText("Cuenta sospechosa", "CTA00456");
  const patron = await requiredText("Patrón", "ciclo");
  const riesgo = await requiredNumber("Nivel de riesgo 1-5", "5");
  const result = await runWithSpinner("Detectando y gestionando fraude", () =>
    op2FraudDetection(ctx, cuentaId, patron, Math.min(5, Math.max(1, riesgo))),
  );

  showResult("OP-2", result);
};

const handleOp3Option = async (
  ctx: AppContext,
  state: CliState,
): Promise<void> => {
  const sesion = await requireCliSession(ctx, state);
  const cuentaId = await requiredText("Cuenta", "CTA00456");
  const desde = new Date(await requiredText("Desde YYYY-MM-DD", "2026-05-01"));
  const hasta = new Date(await requiredText("Hasta YYYY-MM-DD", "2026-05-30"));
  const result = await runWithSpinner("Consultando extracto", () =>
    op3StatementStatus(ctx, sesion.clienteId, cuentaId, desde, hasta),
  );

  showResult("OP-3", result);
};

const handleOp4Option = async (ctx: AppContext): Promise<void> => {
  const transaccionId = await requiredText("ID de transacción MongoDB");
  const result = await runWithSpinner("Trazando transferencia", () =>
    op4Traceability(ctx, transaccionId),
  );

  showResult("OP-4", result);
};

const handleOp5Option = async (ctx: AppContext): Promise<void> => {
  const alerta = await runWithSpinner(
    "Buscando la alerta de mayor riesgo desde Redis",
    () => consumirAlertaDeMayorRiesgoPendiente(ctx.redis),
  );

  if (!alerta) {
    throw new Error("No hay alertas pendientes en Redis");
  }

  const { alertaPersistida, cuentasAfectadas } = await getAlertClosureContext(
    ctx,
    alerta,
  );

  showResult("Alerta consumida", {
    alertaId: alerta.alertaId,
    tipo: alerta.tipo,
    nivelRiesgo: alerta.nivelRiesgo,
    cuentaId: alerta.cuentaId,
    detalle: alerta.detalle,
    creadaEn: alerta.creadaEn,
    cuentasAfectadas,
    recorridos: alertaPersistida?.recorridos ?? [],
  });

  const resolucion = await select({
    message: "¿Cómo querés resolver esta alerta?",
    options: [
      { value: "fraude_confirmado", label: "Confirmar fraude" },
      { value: "falso_positivo", label: "Marcar como falso positivo" },
    ],
  });

  if (isCancel(resolucion)) {
    await runWithSpinner("Reencolando alerta consumida", () =>
      reencolarAlertaFraude(ctx.redis, alerta),
    );
    note("La alerta se devolvió al sorted set sin cambios.", "OP-5");
    return;
  }

  const analista = await text({
    message: "Analista",
    placeholder: "Juancito",
    validate: (input) =>
      !input || input.trim() === "" ? "Este campo es obligatorio" : undefined,
  });

  if (isCancel(analista)) {
    await runWithSpinner("Reencolando alerta consumida", () =>
      reencolarAlertaFraude(ctx.redis, alerta),
    );
    note("La alerta se devolvió al sorted set sin cambios.", "OP-5");
    return;
  }

  const result = await runWithSpinner("Cerrando alerta consumida", () =>
    op5CloseAlert(ctx, alerta, resolucion, analista.trim(), cuentasAfectadas),
  );

  showResult("OP-5", result);
};

const handleMenuSelection = async (
  ctx: AppContext,
  state: CliState,
  option: Exclude<MenuOption, "exit">,
): Promise<void> => {
  switch (option) {
    case "login":
      await handleLoginOption(ctx, state);
      return;
    case "logout":
      await handleLogoutOption(ctx, state);
      return;
    case "op1":
      await handleOp1Option(ctx, state);
      return;
    case "op2":
      await handleOp2Option(ctx);
      return;
    case "op3":
      await handleOp3Option(ctx, state);
      return;
    case "op4":
      await handleOp4Option(ctx);
      return;
    case "op5":
      await handleOp5Option(ctx);
      return;
  }
};

const handleCliError = (error: unknown): void => {
  const message = error instanceof Error ? error.message : "Error desconocido";

  if (message === "Sesión vencida") {
    note(
      "La sesión venció y se removió de la memoria de la CLI. Iniciá sesión nuevamente.",
      "Error",
    );
    return;
  }

  note(message, "Error");
};

const runCli = async (): Promise<void> => {
  intro("IDD 2 - TP - Sistema Bancario");
  const ctx = await runWithSpinner(
    "Conectando a MongoDB, Neo4j y Redis",
    createContext,
  );
  const state: CliState = { session: null };

  try {
    while (true) {
      const option = (await select({
        message: "Elegí una operación",
        options: getMenuOptions(state),
      })) as MenuOption;

      if (isCancel(option) || option === "exit") {
        break;
      }

      try {
        await handleMenuSelection(ctx, state, option);
      } catch (error) {
        handleCliError(error);
      }
    }
  } finally {
    await closeContext(ctx);
    outro("CLI finalizada");
  }
};

runCli().catch((error) => {
  const message = error instanceof Error ? error.message : "Error desconocido";
  cancel(message);
  process.exit(1);
});
