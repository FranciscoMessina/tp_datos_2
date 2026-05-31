import type { RedisClientType } from "redis";

const SESSION_TTL_SECONDS = 15 * 60;
const BLOCK_TTL_SECONDS = 30 * 60;
const ALERTAS_ACTIVAS_KEY = "fraude:alertas:activas";
const SEGURIDAD_STREAM_KEY = "seguridad:eventos";

type RedisClient = RedisClientType;

type CanalSesion = "app" | "web" | "cajero" | "sucursal";

type UltimaOperacion =
  | "login"
  | "transferencia"
  | "consulta"
  | "renovacion"
  | "logout";

export interface SesionBancariaInput {
  clienteId: string;
  canal: CanalSesion;
  dispositivo: string;
  ip: string;
}

export interface SesionBancaria extends SesionBancariaInput {
  inicio: string;
  ultimaOperacion: UltimaOperacion;
  renovadaEn: string;
}

export interface EstadoSesion {
  expirada: boolean;
  sesion?: SesionBancaria;
}

export interface ResultadoInicioSesion {
  key: string;
  concurrente: boolean;
  sesion: SesionBancaria;
}

export interface EstadoLimiteDiario {
  cuentaId: string;
  fecha: string;
  montoAcumulado: number;
  operaciones: number;
  limiteDiario: number;
  disponible: number;
  ttlSegundos: number;
}

export interface VerificacionLimite {
  permitido: boolean;
  montoAcumulado: number;
  disponible: number;
}

export interface ResultadoRegistroLimite extends VerificacionLimite {
  operaciones: number;
}

export interface BloqueoCuenta {
  cuentaId: string;
  motivo: string;
  creadoEn: string;
}

export interface AlertaFraude {
  alertaId: string;
  cuentaId: string;
  tipo: string;
  nivelRiesgo: number;
  detalle: string;
  cuentasInvolucradas?: string[];
  creadaEn: string;
}

const sesionKey = (clienteId: string): string => `sesion:cliente:${clienteId}`;

const bloqueoKey = (cuentaId: string): string => `bloqueo:cuenta:${cuentaId}`;

const fechaOperativaKey = (now: Date): string => {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}${month}${day}`;
};

const montoDiarioKey = (cuentaId: string, now: Date): string =>
  `limite:cuenta:${cuentaId}:monto:${fechaOperativaKey(now)}`;

const operacionesDiariasKey = (cuentaId: string, now: Date): string =>
  `limite:cuenta:${cuentaId}:operaciones:${fechaOperativaKey(now)}`;

const segundosHastaMedianoche = (now = new Date()): number => {
  const medianoche = new Date(now);
  medianoche.setHours(24, 0, 0, 0);

  return Math.max(1, Math.floor((medianoche.getTime() - now.getTime()) / 1000));
};

const asRedisString = (value: unknown): string | null => {
  return typeof value === "string" ? value : null;
};

const toNumber = (value: unknown): number => {
  if (typeof value !== "string" || value === "") {
    return 0;
  }

  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const existeHash = (hash: Record<string, string>): boolean =>
  Object.keys(hash).length > 0;

const asSesionBancaria = (
  hash: Record<string, string>,
): SesionBancaria | undefined => {
  if (!existeHash(hash)) {
    return undefined;
  }

  const clienteId = hash.clienteId;
  const canal = hash.canal;
  const dispositivo = hash.dispositivo;
  const ip = hash.ip;
  const inicio = hash.inicio;
  const ultimaOperacion = hash.ultimaOperacion;
  const renovadaEn = hash.renovadaEn;

  if (
    !clienteId ||
    !canal ||
    !dispositivo ||
    !ip ||
    !inicio ||
    !ultimaOperacion ||
    !renovadaEn
  ) {
    return undefined;
  }

  return {
    clienteId,
    canal: canal as CanalSesion,
    dispositivo,
    ip,
    inicio,
    ultimaOperacion: ultimaOperacion as UltimaOperacion,
    renovadaEn,
  };
};

const scoreAlerta = (nivelRiesgo: number, timestampMs = Date.now()): number =>
  nivelRiesgo * 10_000_000_000_000 + timestampMs;

export async function publicarEventoSeguridad(
  redis: RedisClient,
  evento: string,
  payload: Record<string, string | number>,
): Promise<string> {
  const fields: Record<string, string> = {
    evento,
    timestamp: new Date().toISOString(),
  };

  for (const [key, value] of Object.entries(payload)) {
    fields[key] = String(value);
  }

  return redis.xAdd(SEGURIDAD_STREAM_KEY, "*", fields);
}

// -----------------------------------------------------------------------------
// 3.1 Gestión de sesión bancaria
// 1. Ciclo completo de sesión bancaria usando HASH + TTL.
// -----------------------------------------------------------------------------

// 3.1.2.e Detectar sesión concurrente.
export async function detectarSesionConcurrente(
  redis: RedisClient,
  clienteId: string,
  dispositivoActual: string,
): Promise<boolean> {
  const sesionActual = await redis.hGetAll(sesionKey(clienteId));

  if (!existeHash(sesionActual)) {
    return false;
  }

  return sesionActual.dispositivo !== dispositivoActual;
}

// 3.1.2.a Iniciar sesión: crear el HASH con TTL de 15 minutos.
export async function iniciarSesionBancaria(
  redis: RedisClient,
  input: SesionBancariaInput,
): Promise<ResultadoInicioSesion> {
  const concurrente = await detectarSesionConcurrente(
    redis,
    input.clienteId,
    input.dispositivo,
  );

  const now = new Date().toISOString();
  const key = sesionKey(input.clienteId);
  const sesion: SesionBancaria = {
    ...input,
    inicio: now,
    ultimaOperacion: "login",
    renovadaEn: now,
  };

  await redis.hSet(key, {
    clienteId: sesion.clienteId,
    canal: sesion.canal,
    dispositivo: sesion.dispositivo,
    ip: sesion.ip,
    inicio: sesion.inicio,
    ultimaOperacion: sesion.ultimaOperacion,
    renovadaEn: sesion.renovadaEn,
  });
  await redis.expire(key, SESSION_TTL_SECONDS);

  if (concurrente) {
    await publicarEventoSeguridad(redis, "sesion_concurrente", {
      clienteId: input.clienteId,
      dispositivo: input.dispositivo,
      ip: input.ip,
      ttlSegundos: SESSION_TTL_SECONDS,
    });
  }

  return {
    key,
    concurrente,
    sesion,
  };
}

// 3.1.2.b Renovar sesión en cada operación sin reiniciar la sesión completa.
export async function renovarSesionBancaria(
  redis: RedisClient,
  clienteId: string,
  ultimaOperacion: UltimaOperacion = "renovacion",
): Promise<SesionBancaria> {
  const key = sesionKey(clienteId);
  const sesionActual = await redis.hGetAll(key);

  if (!existeHash(sesionActual)) {
    throw new Error("Sesión vencida");
  }

  await redis.hSet(key, {
    ultimaOperacion,
    renovadaEn: new Date().toISOString(),
  });
  await redis.expire(key, SESSION_TTL_SECONDS);

  const sesionRenovada = await redis.hGetAll(key);
  const sesion = asSesionBancaria(sesionRenovada);

  if (!sesion) {
    throw new Error("No se pudo renovar la sesión");
  }

  return sesion;
}

// 3.1.2.c Detectar sesión expirada: si la clave no existe, error.
export async function validarSesionActiva(
  redis: RedisClient,
  clienteId: string,
): Promise<SesionBancaria> {
  const sesion = await redis.hGetAll(sesionKey(clienteId));
  const estado = asSesionBancaria(sesion);

  if (!estado) {
    throw new Error("Sesión vencida");
  }

  return estado;
}

export async function consultarEstadoSesion(
  redis: RedisClient,
  clienteId: string,
): Promise<EstadoSesion> {
  const sesion = await redis.hGetAll(sesionKey(clienteId));
  const estado = asSesionBancaria(sesion);

  if (!estado) {
    return { expirada: true };
  }

  return {
    expirada: false,
    sesion: estado,
  };
}

// 3.1.2.d Cerrar sesión explícitamente.
export async function cerrarSesionBancaria(
  redis: RedisClient,
  clienteId: string,
): Promise<boolean> {
  const eliminadas = await redis.del(sesionKey(clienteId));

  return eliminadas > 0;
}

// -----------------------------------------------------------------------------
// 3.2 Control de límites transaccionales en tiempo real
// 3. Uso de contadores atómicos con reinicio automático a medianoche.
// -----------------------------------------------------------------------------

// 3.2.4.a Verificar si una transacción puede ejecutarse.
export async function puedeEjecutarTransferencia(
  redis: RedisClient,
  cuentaId: string,
  nuevoMonto: number,
  limiteDiario: number,
  now = new Date(),
): Promise<VerificacionLimite> {
  const actual = toNumber(await redis.get(montoDiarioKey(cuentaId, now)));
  const disponible = Math.max(0, limiteDiario - actual);

  return {
    permitido: actual + nuevoMonto <= limiteDiario,
    montoAcumulado: actual,
    disponible,
  };
}

// 3.2.4.b Registrar atómicamente el monto de una transacción aprobada.
export async function registrarTransferenciaAprobada(
  redis: RedisClient,
  cuentaId: string,
  monto: number,
  now = new Date(),
): Promise<ResultadoRegistroLimite> {
  const ttl = segundosHastaMedianoche(now);
  const keyMonto = montoDiarioKey(cuentaId, now);
  const keyOperaciones = operacionesDiariasKey(cuentaId, now);

  const raw = (await redis.eval(
    `
      local montoKey = KEYS[1]
      local operacionesKey = KEYS[2]
      local incremento = tonumber(ARGV[1])
      local ttl = tonumber(ARGV[2])

      local montoActual = redis.call('INCRBYFLOAT', montoKey, incremento)
      local operacionesActuales = redis.call('INCR', operacionesKey)

      if redis.call('TTL', montoKey) < 0 then
        redis.call('EXPIRE', montoKey, ttl)
      end

      if redis.call('TTL', operacionesKey) < 0 then
        redis.call('EXPIRE', operacionesKey, ttl)
      end

      return { tostring(montoActual), tostring(operacionesActuales) }
    `,
    {
      keys: [keyMonto, keyOperaciones],
      arguments: [String(monto), String(ttl)],
    },
  )) as [string, string];

  const montoAcumulado = toNumber(raw[0]);
  const operaciones = toNumber(raw[1]);

  return {
    permitido: true,
    montoAcumulado,
    disponible: 0,
    operaciones,
  };
}

// 3.2.4.c Consultar el límite disponible actual de una cuenta.
export async function consultarLimiteDisponibleActual(
  redis: RedisClient,
  cuentaId: string,
  limiteDiario: number,
  now = new Date(),
): Promise<EstadoLimiteDiario> {
  const [montoRaw, operacionesRaw, ttlRaw] = await Promise.all([
    redis.get(montoDiarioKey(cuentaId, now)),
    redis.get(operacionesDiariasKey(cuentaId, now)),
    redis.ttl(montoDiarioKey(cuentaId, now)),
  ]);

  const montoAcumulado = toNumber(montoRaw);
  const operaciones = toNumber(operacionesRaw);

  return {
    cuentaId,
    fecha: fechaOperativaKey(now),
    montoAcumulado,
    operaciones,
    limiteDiario,
    disponible: Math.max(0, limiteDiario - montoAcumulado),
    ttlSegundos: ttlRaw > 0 ? ttlRaw : segundosHastaMedianoche(now),
  };
}

// Implementación recomendada para producción: verificar y registrar en una sola
// operación atómica. Evita condiciones de carrera entre la validación y el INCR.
export async function verificarYRegistrarTransferencia(
  redis: RedisClient,
  cuentaId: string,
  monto: number,
  limiteDiario: number,
  now = new Date(),
): Promise<ResultadoRegistroLimite> {
  const ttl = segundosHastaMedianoche(now);
  const keyMonto = montoDiarioKey(cuentaId, now);
  const keyOperaciones = operacionesDiariasKey(cuentaId, now);

  const raw = (await redis.eval(
    `
      local montoKey = KEYS[1]
      local operacionesKey = KEYS[2]
      local limiteDiario = tonumber(ARGV[1])
      local incremento = tonumber(ARGV[2])
      local ttl = tonumber(ARGV[3])

      local acumulado = tonumber(redis.call('GET', montoKey) or '0')
      local disponible = limiteDiario - acumulado

      if (acumulado + incremento) > limiteDiario then
        local operacionesActuales = tonumber(redis.call('GET', operacionesKey) or '0')
        return { '0', tostring(acumulado), tostring(disponible), tostring(operacionesActuales) }
      end

      local nuevoMonto = redis.call('INCRBYFLOAT', montoKey, incremento)
      local nuevasOperaciones = redis.call('INCR', operacionesKey)

      if redis.call('TTL', montoKey) < 0 then
        redis.call('EXPIRE', montoKey, ttl)
      end

      if redis.call('TTL', operacionesKey) < 0 then
        redis.call('EXPIRE', operacionesKey, ttl)
      end

      local disponibleRestante = limiteDiario - tonumber(nuevoMonto)
      return { '1', tostring(nuevoMonto), tostring(disponibleRestante), tostring(nuevasOperaciones) }
    `,
    {
      keys: [keyMonto, keyOperaciones],
      arguments: [String(limiteDiario), String(monto), String(ttl)],
    },
  )) as [string, string, string, string];

  return {
    permitido: raw[0] === "1",
    montoAcumulado: toNumber(raw[1]),
    disponible: Math.max(0, toNumber(raw[2])),
    operaciones: toNumber(raw[3]),
  };
}

/*
3.2.4.d Justificación para el informe:
La atomicidad de INCR / INCRBYFLOAT es crítica porque dos transferencias
concurrentes sobre la misma cuenta no pueden leer el mismo acumulado y luego
pisarse entre sí. Si la actualización no fuera atómica, ambas operaciones podrían
aprobarse usando un saldo consumido desactualizado y el cliente superaría el
límite diario real. Redis resuelve esto con operaciones atómicas sobre una única
clave y, cuando hace falta combinar validación + registro, con un script Lua en
una sola ejecución indivisible.
*/

// -----------------------------------------------------------------------------
// 3.3 Bloqueo temporal de cuentas y alertas de fraude
// 5. SET NX + TTL para bloqueos y SORTED SET para cola de alertas.
// -----------------------------------------------------------------------------

// 3.3.6.a Bloquear una cuenta preventivamente con TTL y motivo.
export async function bloquearCuentaPreventivamente(
  redis: RedisClient,
  cuentaId: string,
  motivo: string,
  ttlSegundos = BLOCK_TTL_SECONDS,
): Promise<boolean> {
  const bloqueo: BloqueoCuenta = {
    cuentaId,
    motivo,
    creadoEn: new Date().toISOString(),
  };

  const resultado = await redis.set(
    bloqueoKey(cuentaId),
    JSON.stringify(bloqueo),
    {
      expiration: {
        type: "EX",
        value: ttlSegundos,
      },
      condition: "NX",
    },
  );

  if (resultado === "OK") {
    await publicarEventoSeguridad(redis, "cuenta_bloqueada", {
      cuentaId,
      motivo,
      ttlSegundos,
    });
  }

  return resultado === "OK";
}

// 3.3.6.b Verificar si una cuenta está bloqueada.
export async function verificarCuentaBloqueada(
  redis: RedisClient,
  cuentaId: string,
): Promise<BloqueoCuenta | null> {
  const raw = asRedisString(await redis.get(bloqueoKey(cuentaId)));

  if (!raw) {
    return null;
  }

  return JSON.parse(raw) as BloqueoCuenta;
}

// 3.3.6.c Desbloquear manualmente una cuenta antes del TTL.
export async function desbloquearCuentaManual(
  redis: RedisClient,
  cuentaId: string,
): Promise<boolean> {
  const eliminadas = await redis.del(bloqueoKey(cuentaId));

  if (eliminadas > 0) {
    await publicarEventoSeguridad(redis, "cuenta_desbloqueada", {
      cuentaId,
    });
  }

  return eliminadas > 0;
}

// 3.3.6.d Publicar una alerta de fraude en el SORTED SET.
export async function publicarAlertaFraude(
  redis: RedisClient,
  alerta: Omit<AlertaFraude, "creadaEn">,
): Promise<AlertaFraude> {
  const payload: AlertaFraude = {
    ...alerta,
    creadaEn: new Date().toISOString(),
  };

  await redis.zAdd(ALERTAS_ACTIVAS_KEY, {
    score: scoreAlerta(payload.nivelRiesgo),
    value: JSON.stringify(payload),
  });

  await publicarEventoSeguridad(redis, "alerta_fraude_publicada", {
    alertaId: payload.alertaId,
    cuentaId: payload.cuentaId,
    tipo: payload.tipo,
    nivelRiesgo: payload.nivelRiesgo,
    cuentasInvolucradas:
      payload.cuentasInvolucradas?.join(",") ?? payload.cuentaId,
  });

  return payload;
}

// 3.3.6.e Consumir la alerta de mayor riesgo pendiente.
export async function consumirAlertaDeMayorRiesgoPendiente(
  redis: RedisClient,
): Promise<AlertaFraude | null> {
  const alertaConsumida = await redis.zPopMax(ALERTAS_ACTIVAS_KEY);

  if (!alertaConsumida) {
    return null;
  }

  const alerta = JSON.parse(alertaConsumida.value) as AlertaFraude;

  await publicarEventoSeguridad(redis, "alerta_fraude_consumida", {
    alertaId: alerta.alertaId,
    cuentaId: alerta.cuentaId,
    nivelRiesgo: alerta.nivelRiesgo,
    cuentasInvolucradas:
      alerta.cuentasInvolucradas?.join(",") ?? alerta.cuentaId,
  });

  return alerta;
}

export async function reencolarAlertaFraude(
  redis: RedisClient,
  alerta: AlertaFraude,
): Promise<void> {
  const timestampMs = Number.isNaN(Date.parse(alerta.creadaEn))
    ? Date.now()
    : Date.parse(alerta.creadaEn);

  await redis.zAdd(ALERTAS_ACTIVAS_KEY, {
    score: scoreAlerta(alerta.nivelRiesgo, timestampMs),
    value: JSON.stringify(alerta),
  });

  await publicarEventoSeguridad(redis, "alerta_fraude_reencolada", {
    alertaId: alerta.alertaId,
    cuentaId: alerta.cuentaId,
    nivelRiesgo: alerta.nivelRiesgo,
    cuentasInvolucradas:
      alerta.cuentasInvolucradas?.join(",") ?? alerta.cuentaId,
  });
}

// 3.3.6.f Publicar el evento en el STREAM de seguridad.
export async function registrarEventoSeguridad(
  redis: RedisClient,
  evento: string,
  payload: Record<string, string | number>,
): Promise<string> {
  return publicarEventoSeguridad(redis, evento, payload);
}
