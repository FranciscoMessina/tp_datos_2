# datos_tp

CLI bancaria para una capa de persistencia políglota con **MongoDB**, **Neo4j** y **Redis**.

El proyecto implementa una interfaz de línea de comandos en **Bun + TypeScript** para simular operaciones de un sistema bancario con foco en:

- registro histórico de datos en **MongoDB**,
- análisis de relaciones y trazabilidad en **Neo4j**,
- estado operativo en tiempo real en **Redis**.

## Objetivo del proyecto

Este repositorio corresponde a un trabajo práctico integrador de **Ingeniería de Datos II** sobre un **sistema bancario con detección de fraude**.

La solución usa persistencia políglota para repartir responsabilidades entre motores según sus fortalezas:

- **MongoDB**: clientes, cuentas, transacciones, tarjetas, alertas y consultas históricas.
- **Neo4j**: red de transferencias entre cuentas, detección de patrones y trazabilidad de fondos.
- **Redis**: sesiones activas, límites diarios, bloqueos temporales y cola de alertas de fraude.

## Tecnologías

- **Bun**
- **TypeScript**
- **MongoDB**
- **Neo4j**
- **Redis**
- **Docker Compose** para levantar los motores localmente

## Funcionalidades implementadas

La aplicación expone un menú interactivo con estas operaciones:

### Sesión bancaria

- inicio de sesión de cliente en Redis usando `HASH` con TTL,
- renovación de sesión al operar,
- cierre de sesión explícito,
- búsqueda de clientes desde MongoDB.

### OP-1 · Validación y ejecución de transferencia

Integra los **3 motores**:

- valida que exista una sesión activa,
- lista las cuentas del cliente y descarta cuentas bloqueadas,
- verifica saldo en MongoDB,
- controla el límite diario con Redis,
- registra la transacción en MongoDB,
- crea la relación de transferencia en Neo4j,
- publica el evento en `seguridad:stream`,
- aplica compensación si falla una escritura parcial.

### OP-2 · Detección y gestión de fraude

Integra **MongoDB + Neo4j + Redis** para detección, pero solo aplica acciones temporales en Redis:

- recupera historial reciente desde MongoDB,
- analiza patrones en Neo4j,
- detecta escenarios como ciclos, cascadas, smurfing y lavado,
- aplica bloqueo temporal de cuentas en Redis,
- encola alertas en Redis para revisión posterior,
- publica eventos en `seguridad:stream`,
- no modifica MongoDB ni Neo4j en esta etapa.

### OP-3 · Extracto y estado de cuenta

Integra **MongoDB + Redis**:

- obtiene el extracto del último mes,
- calcula saldo acumulado por transacción,
- informa límite consumido/disponible,
- informa si la cuenta está bloqueada y el motivo.

### OP-4 · Trazabilidad regulatoria

Integra **MongoDB + Neo4j**:

- muestra el detalle de una transferencia original,
- reconstruye caminos posteriores de fondos,
- recorre transferencias de hasta 5 saltos.

### OP-5 · Cierre de alerta de fraude

Integra los **3 motores**:

- consume la alerta prioritaria desde Redis con `ZPOPMAX`,
- registra el dictamen del analista en MongoDB,
- si el fraude se confirma, recién ahí bloquea persistente en MongoDB y etiqueta cuentas comprometidas en Neo4j,
- si fue falso positivo, elimina los bloqueos temporales de Redis,
- publica el cierre en `seguridad:stream`.


## Requisitos

Antes de correr el proyecto necesitás:

- **Bun** instalado (https://bun.sh/)
- **Docker** y **Docker Compose**

## Instalación

Desde la raíz del proyecto:

```bash
bun install
```

## Levantar las bases de datos

Duplicar `.env.example` a `.env` y configurar las variables de entorno.

El repositorio incluye `docker-compose.yml` con los 3 motores.

Ejecutá:

```bash
docker compose up -d
```

Esto levanta:

- **Redis** en `localhost:6379`
- **MongoDB** en `localhost:27018`
- **Neo4j** en:
  - interfaz web: `http://localhost:7474`
  - Bolt: `bolt://localhost:7687`

### Credenciales por defecto del `docker-compose.yml`

#### MongoDB

- usuario: `admin`
- contraseña: `admin123`
- base por defecto: `datos_tp`

#### Neo4j

- usuario: `neo4j`
- contraseña: `password123`
- base por defecto: `neo4j`

#### Redis

- contraseña: `redispass`
- usuario ACL recomendado para este proyecto: `default`

## Configuración de entorno

La aplicación exige estas variables de entorno:

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

> `LIMITE_DIARIO` define el tope diario por cuenta para transferencias. Ajustalo según el escenario que quieras probar.

## Carga de datos de prueba

La carpeta `seed/` incluye scripts para:

1. cargar esos datos en MongoDB,
2. cargar el grafo en Neo4j.


### Paso 1 · Cargar MongoDB

```bash
bun run seed/cargarEnMongo.ts
```

Este script:

- elimina la base anterior,
- crea colecciones con validaciones,
- crea índices,
- inserta clientes, cuentas, tarjetas, transacciones, alertas y beneficiarios.

### Paso 2 · Cargar Neo4j

```bash
bun run seed/cargarEnNeo.ts
```

Este script:

- limpia el grafo existente,
- crea nodos de clientes, cuentas y tarjetas,
- crea relaciones de titularidad,
- crea relaciones `TRANSFIRIO` entre cuentas para las transferencias.

## Ejecutar la aplicación

Con los motores levantados, variables de entorno cargadas y datos sembrados:

```bash
bun run start
```

Esto abre la CLI interactiva definida en `index.ts`.

## Flujo recomendado para probar el proyecto

1. Instalar dependencias con `bun install`
2. Levantar servicios con `docker compose up -d`
3. Configurar variables de entorno en `.env`
4. Cargar MongoDB con `bun run seed/cargarEnMongo.ts`
5. Cargar Neo4j con `bun run seed/cargarEnNeo.ts`
6. Ejecutar la CLI con `bun run start`
7. Iniciar sesión con un cliente existente y probar las operaciones (Solo la operacion 1 y la 4 necesitan de una sesion iniciada)


## Archivos útiles para revisar

- `README.md`: documentación del proyecto
- `CONSIGNA.md`: consigna completa del trabajo práctico
