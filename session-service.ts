import type { AppContext } from "./db-setup.ts";
import type { Cliente } from "./estructura-datos.ts";

export type SessionState = {
  clienteId: string | null;
};

export type SessionData = {
  clienteId: string;
  canal: "app" | "cajero" | "sucursal";
  dispositivo: string;
  ip: string;
  ultimaOperacion: string;
  inicio: string;
};

const SESSION_TTL_SECONDS = 15 * 60;

const clientesCollection = (ctx: AppContext) =>
  ctx.db.collection<Cliente>("clientes");

const sessionKey = (clienteId: string) => `sesion:${clienteId}`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function saveSessionInRedis(
  ctx: AppContext,
  data: SessionData,
): Promise<void> {
  await ctx.redis.hSet(sessionKey(data.clienteId), {
    clienteId: data.clienteId,
    canal: data.canal,
    dispositivo: data.dispositivo,
    ip: data.ip,
    ultimaOperacion: data.ultimaOperacion,
    inicio: data.inicio,
  });
  await ctx.redis.expire(sessionKey(data.clienteId), SESSION_TTL_SECONDS);
}

export async function readActiveSession(
  ctx: AppContext,
  clienteId: string,
): Promise<SessionData | null> {
  const session = await ctx.redis.hGetAll(sessionKey(clienteId));

  if (Object.keys(session).length === 0) {
    return null;
  }

  const canal = session.canal;
  if (canal !== "app" && canal !== "cajero" && canal !== "sucursal") {
    return null;
  }

  const clienteIdValue = session.clienteId;
  const dispositivoValue = session.dispositivo;
  const ipValue = session.ip;
  const ultimaOperacionValue = session.ultimaOperacion;
  const inicioValue = session.inicio;

  if (
    clienteIdValue == null ||
    dispositivoValue == null ||
    ipValue == null ||
    ultimaOperacionValue == null ||
    inicioValue == null
  ) {
    return null;
  }

  return {
    clienteId: clienteIdValue,
    canal,
    dispositivo: dispositivoValue,
    ip: ipValue,
    ultimaOperacion: ultimaOperacionValue,
    inicio: inicioValue,
  };
}

export async function searchClientes(
  ctx: AppContext,
  searchTerm: string,
): Promise<Cliente[]> {
  const normalizedSearchTerm = searchTerm.trim();
  const searchRegex = new RegExp(escapeRegExp(normalizedSearchTerm), "i");

  return await clientesCollection(ctx)
    .find(
      {
        $or: [
          { _id: { $regex: searchRegex } },
          { nombre: { $regex: searchRegex } },
          { documento: { $regex: searchRegex } },
        ],
      },
      { sort: { nombre: 1 } },
    )
    .toArray();
}

export async function getClientById(
  ctx: AppContext,
  clienteId: string,
): Promise<Cliente | null> {
  return await clientesCollection(ctx).findOne({ _id: clienteId });
}

export async function loginCliente(
  ctx: AppContext,
  clienteId: string,
): Promise<{ cliente: Cliente | null; existingSession: SessionData | null }> {
  const existingSession = await readActiveSession(ctx, clienteId);
  const cliente = await getClientById(ctx, clienteId);

  if (cliente == null) {
    return { cliente: null, existingSession };
  }

  const session: SessionData = {
    clienteId,
    canal: "app",
    dispositivo: "compu-cli",
    ip: "127.0.0.1",
    ultimaOperacion: "login",
    inicio: new Date().toISOString(),
  };

  await saveSessionInRedis(ctx, session);

  return { cliente, existingSession };
}

export async function logoutCliente(
  ctx: AppContext,
  clienteId: string,
): Promise<void> {
  await ctx.redis.del(sessionKey(clienteId));
}

export async function ensureSession(
  ctx: AppContext,
  state: SessionState,
): Promise<SessionData | null> {
  if (state.clienteId == null) {
    return null;
  }

  const session = await readActiveSession(ctx, state.clienteId);
  if (session == null) {
    state.clienteId = null;
    return null;
  }

  return session;
}

export async function getActiveClientLabel(
  ctx: AppContext,
  state: SessionState,
): Promise<string | null> {
  const session = await ensureSession(ctx, state);
  if (session == null) {
    return null;
  }

  const cliente = await getClientById(ctx, session.clienteId);
  return cliente?.nombre ?? session.clienteId;
}

export async function getBlockedReason(
  ctx: AppContext,
  cuentaId: string,
): Promise<string | null> {
  return await ctx.redis.get(`bloqueo:${cuentaId}`);
}

export async function updateSessionLastOperation(
  ctx: AppContext,
  clienteId: string,
  ultimaOperacion: string,
): Promise<void> {
  await ctx.redis.hSet(sessionKey(clienteId), {
    ultimaOperacion,
  });
  await ctx.redis.expire(sessionKey(clienteId), SESSION_TTL_SECONDS);
}
