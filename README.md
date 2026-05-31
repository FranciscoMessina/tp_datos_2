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

- Inicio y cierre de sesión bancaria en Redis.
- OP-1 Validación y ejecución de transferencia usando Redis, MongoDB y Neo4j.
- OP-2 Detección y gestión de fraude usando los tres motores.
- OP-3 Consulta de extracto con estado usando MongoDB y Redis.
- OP-4 Trazabilidad regulatoria usando MongoDB y Neo4j.
- OP-5 Cierre de alerta de fraude usando Redis, MongoDB y Neo4j, consumiendo automáticamente la alerta de mayor riesgo con `ZPOPMAX`.

## Verificación

```bash
bun run typecheck
```
