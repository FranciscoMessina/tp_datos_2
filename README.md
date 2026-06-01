# datos_tp

CLI para la capa de persistencia poliglota del TP: MongoDB + Neo4j + Redis.

## Instalación

```bash
bun install
```

## Configuración

Copiar `.env.example` a `.env` y completar las conexiones:

- `MONGO_URI`
- `MONGO_DB_NAME`
- `NEO_4J_URI`
- `NEO_4J_USER`
- `NEO_4J_PASSWORD`
- `NEO_4J_DATABASE`
- `REDIS_HOST`
- `REDIS_PORT`
- `REDIS_USER`
- `REDIS_PASSWORD`
- `LIMITE_DIARIO`

## Ejecución

```bash
bun run start
```

La CLI permite ejecutar sin modificar código:

- Inicio y cierre de sesión bancaria en Redis usando `HASH` con TTL.
- OP-1 Validación y ejecución de transferencia usando Redis, MongoDB y Neo4j.
- OP-2 Detección y gestión de fraude con patrones en Neo4j, alertas en MongoDB y bloqueos en Redis.
- OP-3 Extracto del último mes y estado actual de cuenta.
- OP-4 Trazabilidad regulatoria: detalle completo de la transacción original en MongoDB y recorrido de fondos en Neo4j hasta 5 saltos.
- OP-5 Cierre de alerta de fraude: consume la alerta prioritaria desde Redis (`ZPOPMAX`), registra el dictamen en MongoDB, desbloquea cuentas si fue falso positivo o etiqueta cuentas comprometidas en Neo4j si se confirmó fraude, y publica el cierre en `seguridad:stream`.
- Reversión compensatoria si la escritura falla en alguno de los motores luego de haber persistido datos parciales en otro.

## Flujo implementado en OP-1

1. Verifica que exista una sesión activa para el cliente en Redis y que la CLI tenga esa sesión cargada en memoria.
2. Lista las cuentas del cliente, indicando cuáles están bloqueadas en Redis y el motivo del bloqueo.
3. Permite seleccionar solo cuentas habilitadas.
4. Solicita cuenta destino y monto.
5. Valida el saldo disponible en MongoDB y el límite diario en Redis.
6. Registra la transferencia en MongoDB, agrega la arista en Neo4j y publica el evento en `seguridad:stream`.
7. Si alguno de los pasos posteriores falla, revierte los cambios previamente realizados.

## Verificación

```bash
bun run typecheck
```
