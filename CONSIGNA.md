¡Acá tenés los dos documentos pasados a Markdown manteniendo el orden y la estructura original!

TRABAJO PRÁCTICO INTEGRADOR - 1.ª ENTREGA

TEMA 5: Sistema Bancario con Detección de Fraude

**INGENIERÍA DE DATOS II** **Tecnicatura / Licenciatura / Ingeniería en Informática**

| Atributo               | Detalle        |
| ---------------------- | -------------- |
| **Motores requeridos** | MongoDB, Neo4j |
| **Capa de integración** | Persistencia Poliglota (MongoDB + Neo4j) 2.a Entrega 
| **Unidades evaluadas** | I- Relacional vs NoSQL, II Modelos NoSQL, III Modelado NoSQL
| **Fecha de entrega** | Lunes 20 de abril de 2025
| **Modalidad** | Grupal (5 integrantes)
| **Defensa oral** | Luego de corregidas ambas entregas (fecha a confirmar)

1. Contexto y Descripción del Problema

Un banco digital con 1,2 millones de cuentas activas procesa en promedio 800.000 transacciones diarias. Su sistema actual, basado en una arquitectura relacional monolítica, presenta los siguientes problemas críticos:

- El procesamiento de transacciones en tiempo real genera picos de carga que el sistema relacional no puede absorber sin degradación del servicio.

- Los extractos de cuenta requieren reconstruir el estado desde cero consultando millones de registros de movimientos, lo que tarda entre 3 y 8 segundos por cliente.

- La detección de fraude actual es reactiva y basada en reglas simples. No puede detectar patrones de fraude que involucran múltiples cuentas intermediarias ('lavado en cadena').

- Las consultas regulatorias que exigen trazar el recorrido completo de una transferencia entre múltiples cuentas son imposibles de ejecutar en tiempo razonable.

El grupo deberá diseñar e implementar un sistema NoSQL que resuelva estos problemas utilizando MongoDB y Neo4j. Esta entrega cubre el modelado y las consultas de cada motor de forma independiente. Cada decisión de diseño debe estar justificada técnicamente en el informe.

2. Dominio del Sistema

2.1 Entidades principales

El sistema debe gestionar las siguientes entidades de negocio:

- **Cliente:** nombre, CUIT/CUIL, tipo (persona física / empresa), domicilio, fecha de alta, score crediticio.

- **Cuenta:** número, tipo (caja de ahorro / cuenta corriente / inversión), moneda, saldo actual, estado, cliente titular.

- **Transacción:** tipo (débito / crédito / transferencia / pago de servicio), monto, fecha y hora, cuenta origen, cuenta destino, descripción, canal (app / cajero / sucursal).

- **Tarjeta:** número (enmascarado), tipo (débito / crédito), cuenta asociada, límite, vencimiento, estado.

- **Alerta de fraude:** transacción sospechosa, tipo de alerta, nivel de riesgo (1-5), estado (pendiente / investigando / cerrada), fecha.

- **Beneficiario:** cliente que recibe transferencias frecuentes, alias o CBU, alias registrado.

  2.2 Relaciones clave

Las siguientes relaciones son centrales en el dominio y deben ser modeladas con cuidado:

- Un cliente puede tener múltiples cuentas y múltiples tarjetas asociadas.

- Una transacción conecta una cuenta origen con una cuenta destino (o con un servicio externo).

- Cadenas de transferencias conectan cuentas a través de múltiples intermediarios.

- Dos cuentas están relacionadas si comparten un beneficiario registrado o si transfieren frecuentemente entre sí.

- Un patrón de fraude se detecta cuando el grafo de transferencias forma estructuras específicas (estrella, cascada, círculo).

3. Requerimientos del Sistema

3.1 Requerimientos de datos (MongoDB)

El grupo deberá implementar en MongoDB el registro transaccional, los extractos de cuenta y la gestión de alertas. A continuación, se listan los requerimientos mínimos:

1. Diseñar el esquema de colecciones para: clientes, cuentas, transacciones, tarjetas y alertas fraude.

2. Justificar explícitamente en el informe las decisiones de embedding vs. referencia para cada relación relevante.

3. Implementar al menos 3 índices que mejoren el rendimiento de las consultas más frecuentes e indicar en el informe qué consulta optimiza cada índice.

4. Desarrollar y documentar las siguientes consultas funcionales:

- a) Obtener el extracto de cuenta de un cliente para un período dado: todas las transacciones ordenadas cronológicamente con saldo acumulado.

- b) Detectar transacciones de monto inusualmente alto para un cliente (más de 3 veces el promedio de sus últimas 30 transacciones).

- c) Listar todas las cuentas con saldo negativo y su última transacción de débito.

- d) Obtener el volumen total de transferencias por día de la semana y franja horaria para identificar patrones de uso.

- e) Listar las alertas de fraude pendientes de revisión, ordenadas por nivel de riesgo descendente.

5. Cargar un conjunto de datos de prueba coherente: minimo 500 clientes, 800 cuentas, 5.000 transacciones distribuidas en 30 días, 50 alertas de fraude.

3.2 Requerimientos de grafos (Neo4j)

Neo4j debe utilizarse para modelar la red de transferencias entre cuentas y detectar patrones de fraude por análisis de grafo. Requerimientos mínimos:

1. Diseñar el grafo de nodos y relaciones. Definir explícitamente: nodos, etiquetas, propiedades y tipos de relación con su dirección y semántica.

2. Implementar y documentar las siguientes consultas en Cypher:

- a) Dado un número de cuenta, trazar el recorrido completo de una transferencia a través de cuentas intermediarias (hasta 5 saltos).

- b) Detectar cuentas que reciben fondos de muchas cuentas distintas y los redistribuyen rápidamente (patrón 'smurfing').

- c) Encontrar grupos de cuentas que forman ciclos de transferencias (el dinero vuelve al origen: posible lavado).

- d) Identificar cuentas con comportamiento anómalo: reciben transferencias de cuentas sin historial previo entre sí.

- e) Dado un cliente marcado como sospechoso, obtener todas las cuentas conectadas en hasta 3 saltos de transferencia.

3. Justificar por qué estas consultas son más adecuadas en un modelo de grafos que en un modelo documental o relacional.

4. Cargar datos de prueba coherentes con los de MongoDB (al menos las mismas entidades principales compartidas entre ambos motores).

5. Informe Escrito

**Estructura Obligatoria**
El informe es parte central de la nota. Debe tener la siguiente estructura mínima:

- **Introducción:** descripción del problema, tecnologías elegidas y justificación inicial de por qué MongoDB y Neo4j para este dominio.

- **Modelo de datos en MongoDB:** diagrama de colecciones, decisiones de embedding vs. referencia justificadas, índices implementados y consulta que optimiza cada uno.

- **Modelo de datos en Neo4j:** diagrama del grafo (nodos, etiquetas, relaciones, propiedades), justificación del modelo y comparación con el modelo documental.

- **Comparación relacional vs. NoSQL:** para al menos 2 consultas, mostrar cómo se resolvería en SQL y cómo en el motor elegido. Analizar ventajas y limitaciones de cada enfoque.

- **Dificultades y decisiones de diseño:** qué problemas encontraron, qué alternativas evaluaron y por qué eligieron la solución final.

- **Conclusiones:** reflexión crítica sobre el uso de cada tecnología y qué ventajas aporta cada motor al dominio del problema.

- **Bibliografía:** obligatorio citar al menos Harrison (2015), Pivert (2018) y la documentación oficial de MongoDB y Neo4j.

---

TRABAJO PRÁCTICO INTEGRADOR - 2.ª ENTREGA

TEMA 5: Sistema Bancario con Detección de Fraude

**INGENIERÍA DE DATOS II** **Tecnicatura / Licenciatura / Ingeniería en Informática**

| Atributo                | Detalle        |
| ----------------------- | -------------- |
| **Motores-1.a Entrega** | MongoDB, Neo4j |
| **Motor adicional** | Redis
| **Capa poliglota** | MongoDB + Neo4j + Redis
| **Unidades evaluadas / Fecha de entrega** | V-Acceso desde aplicaciones Persistencia Poliglota / Lunes 1 de junio de 2026
| **Modalidad** | Grupal (5 integrantes) - extensión de la 1.a Entrega
| **Defensa oral** | Luego de corregidas ambas entregas (fecha a confirmar)


1. Introducción

Este documento extiende la 1.a Entrega. Esta segunda entrega no reemplaza el trabajo ya entregado en la primera instancia. Lo extiende. El grupo debe presentar este documento junto con el código adicional que implementa el tercer motor y la capa de persistencia poliglota. Todo lo desarrollado en la 1.a Entrega sigue vigente y forma parte del sistema completo que se defenderá oralmente.

La primera entrega estableció el núcleo: el registro transaccional y los extractos en MongoDB, y la red de transferencias para detección de fraude en Neo4j. Esta segunda entrega incorpora dos nuevos desafios:

- **Tercer motor - Redis:** incorporación de Redis para gestionar el estado de sesión bancaria, los límites de transacción en tiempo real, el bloqueo temporal de cuentas y las alertas activas de fraude que requieren respuesta inmediata.

- **Capa de persistencia poliglota:** implementación de una aplicación con interfaz mínima que integra los tres motores en operaciones de negocio cohesivas, decidiendo conscientemente qué datos consulta en cada motor y cómo ensambla la respuesta.

Cada decisión de diseño debe estar justificada en el informe escrito.

2. Tercer Motor: Redis

2.1 Justificación de incorporación

El dominio bancario tiene tres naturalezas de datos claramente diferenciadas:

- **Datos históricos y estructurados:** el historial transaccional, los extractos y los datos maestros de cuentas y clientes viven en MongoDB. Son datos que crecen continuamente y requieren consultas analíticas complejas.

- **Datos relacionales y de red:** la red de transferencias para detección de fraude vive en Neo4j. Su valor está en los patrones que emergen del grafo de conexiones entre cuentas.

- **Datos operativos en tiempo real:** el estado de sesión bancaria, los límites diarios de transacción consumidos, el bloqueo temporal de cuentas ante sospecha de fraude y las alertas activas son datos que cambian por evento, requieren latencia inferior a 10 ms y tienen carácter temporal. Redis, con TTL nativo y operaciones atómicas, es el motor adecuado para estos patrones de alta criticidad. Redis resuelve estos casos con operaciones atómicas (INCR, SETNX), TTL automático para sesiones y bloqueos, y estructuras optimizadas para contadores y colas de alertas.

**Error conceptual frecuente - Redis no es una base de datos secundaria** Redis no debe usarse como un simple caché de lo que ya está en MongoDB. En este sistema, Redis es la fuente de verdad para los datos operativos en tiempo real. MongoDB almacena el historial de lo que ya ocurrió. Redis gestiona lo que está ocurriendo ahora.

2.2 Modelado en Redis

**Estructuras de datos** El grupo debe modelar en Redis las estructuras para el estado operativo bancario en tiempo real:

| Estructura Redis | Caso de uso en el dominio                                                                                   | Justificación técnica                                                                                                                                                               
| ---------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HASH**         | Estado de sesión bancaria activa: cliente_id, canal, dispositivo, última operación, IP, timestamp de inicio | Acceso O(1) por campo. TTL automático invalida sesiones inactivas sin proceso de limpieza. | 
| **STRING (contador atómico)** | Limite diario de transferencias consumido por cuenta: monto acumulado hoy y número de operaciones | INCR y INCRBY son atómicos: evitan condiciones de carrera en transacciones concurrentes.  
| **STRING + TTL** | Bloqueo temporal de cuenta: cuenta_id → motivo del bloqueo, expira automáticamente si es bloqueo preventivo | SETNX garantiza que solo un proceso puede bloquear la cuenta al mismo tiempo.
| **SORTED SET** | Cola de alertas de fraude activas ordenadas por nivel de riesgo (score = riesgo x timestamp) | Permite al equipo de fraude atender siempre la alerta de mayor riesgo primero en O(log N).
| **STREAM** | Log de eventos de seguridad: intentos fallidos, bloqueos, alertas, desbloqueos, cambios de límite | Registro inmutable y ordenado de eventos de seguridad para auditoría y replay.


**Convención de nombres de clave (key naming)** Convención de nombres de clave: `entidad:identificador:atributo` Ejemplos:

- `sesion:CLI00123` → HASH con sesión activa del cliente CLI00123

- `limite:CTA00456:20250420` → STRING con monto acumulado hoy para la cuenta CTA00456

- `bloqueo:CTA00456` → STRING con motivo de bloqueo (si existe la clave, la cuenta está bloqueada)

- `alertas:fraude` → SORTED SET con alertas activas ordenadas por nivel de riesgo

- `seguridad:stream` → STREAM de eventos de seguridad del sistema

_Nota: el patrón 'si la clave existe = bloqueado' es un uso idiomático de Redis para flags temporales._

3. Requerimientos de Implementación

**Redis** El grupo deberá implementar y documentar las siguientes operaciones en Redis:

3.1 Gestión de sesión bancaria

1. Implementar el ciclo completo de sesión bancaria usando HASHes con TTL.

2. Implementar las siguientes operaciones:

- a) Iniciar sesión: crear el HASH con TTL de 15 minutos (sesión bancaria estándar).

- b) Renovar sesión en cada operación: actualizar el TTL sin reiniciar la sesión completa.

- c) Detectar sesión expirada: si la clave no existe, retornar error de sesión vencida.

- d) Cerrar sesión explícitamente: eliminar el HASH antes de que expire el TTL.

- e) Detectar sesión concurrente: alertar si el mismo cliente abre sesión desde dos dispositivos distintos.

  3.2 Control de límites transaccionales en tiempo real

3. Implementar el control de límites diarios de transferencia usando contadores atómicos en Redis. El límite reinicia automáticamente a medianoche (TTL calculado hasta fin del día).

4. Implementar las siguientes operaciones:

- a) Verificar si una transacción puede ejecutarse (monto acumulado + nueva operación ≤ límite diario).

- b) Registrar atómicamente el monto de una transacción aprobada.

- c) Consultar el límite disponible actual de una cuenta.

- d) Justificar en el informe por qué la atomicidad de INCR es crítica en este contexto.

3.3 Bloqueo temporal de cuentas y alertas de fraude

5. Implementar el mecanismo de bloqueo temporal de cuentas usando SETNX con TTL, y la cola de alertas usando SORTED SETS.

6. Implementar las siguientes operaciones:

- a) Bloquear una cuenta preventivamente con TTL (ej: 30 minutos) y motivo.

- b) Verificar si una cuenta está bloqueada antes de procesar cualquier transacción.

- c) Desbloquear manualmente una cuenta antes de que expire el TTL.

- d) Publicar una alerta de fraude en el SORTED SET con su nivel de riesgo.

- e) El equipo de fraude consume la alerta de mayor riesgo pendiente.

- f) Publicar el evento en el STREAM de seguridad.

4. Capa de Persistencia Poliglota

**¿Qué es la persistencia poliglota?** La persistencia poliglota es una decisión arquitectural: distintos motores de base de datos gestionan distintas partes del dominio según sus fortalezas. No es simplemente 'usar tres bases de datos'. Implica diseñar explícitamente qué datos viven en cada motor, cómo fluyen entre ellos, cómo se mantiene la coherencia y qué motor responde cada tipo de consulta. (Harrison, 2015, Cap. 1; Pivert, 2018, Cap. 2)

4.1 Responsabilidades por motor

El grupo debe documentar explícitamente qué responsabilidad tiene cada motor en el sistema:

| Motor       | Responsabilidad principal  | Datos que gestiona                                                                 |
| ----------- | -------------------------- | ---------------------------------------------------------------------------------- |
| **MongoDB** | Fuente de verdad histórica | Historial transaccional completo, extractos, datos maestros de cuentas y clientes. |

|
| **Neo4j** | Red de relaciones y grafos | Red de transferencias, detección de patrones de fraude, trazabilidad de fondos.

|
| **Redis** | Estado operativo en tiempo real | Sesiones activas, límites diarios en tiempo real, bloqueos temporales, alertas de fraude.

|

**Atención - coherencia entre motores** Cuando ocurre un evento de negocio relevante, deben actualizarse los motores que correspondan. El grupo debe documentar en el informe cómo gestiona esta coherencia y qué sucede si una de las escrituras falla (estrategia de manejo de errores parciales). Ejemplo: cuando se detecta una transacción sospechosa:

- **Redis:** bloquea preventivamente la cuenta (SETNX con TTL) y publica alerta en el SORTED SET.

- **Neo4j:** agrega la transacción al grafo para análisis de patrón de fraude.

- **MongoDB:** registra la transacción y el estado de alerta en el historial.

  4.2 Operaciones poliglotas requeridas

La aplicación debe implementar exactamente 5 operaciones que integren múltiples motores. Las operaciones marcadas con (\*) deben usar los tres motores simultáneamente en una sola respuesta.

| Operación de negocio                                                  | MongoDB                                                  | Neo4j                                                              | Redis                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| **OP-1 Validación y ejecución de una transferencia (\*) - 3 motores** | Registra la transacción en el historial de ambas cuentas | Agrega la arista de transferencia al grafo para análisis de fraude | Verifica sesión activa y límite diario; registra el monto; publica en el STREAM |

|
| **OP-2 Detección y gestión de fraude en tiempo real (\*) - 3 motores** | Recupera el historial de las cuentas involucradas para análisis | Detecta el patrón sospechoso (ciclo, smurfing, cascada) en el grafo. Cadena completa de transferencias posteriores hasta N saltos. Si es fraude confirmado, marca las cuentas involucradas en el grafo para análisis futuro | Bloquea las cuentas involucradas; publica alertas ordenadas por riesgo

|
| **OP-3 Consulta de extracto con estado de cuenta - 2 motores** | Historial completo de transacciones del período | | Límite disponible hoy, estado de bloqueo, sesión activa

|
| **OP-4 Trazabilidad regulatoria de una transferencia - 2 motores** | Detalles completos de la transacción origen: monto, fecha, canal, descripción | | |
| **OP-5 Cierre de alerta de fraude por el equipo de seguridad (\*) 3 motores** | Registra la resolución de la alerta con el dictamen del analista | | Elimina la alerta del SORTED SET; desbloquea las cuentas si corresponde; publica evento de cierre en STREAM

|

A continuación, se detalla el comportamiento esperado de cada operación:

**OP-1 Validación y ejecución de una transferencia (\*) 3 motores**
Cuando un cliente intenta realizar una transferencia, el sistema valida y ejecuta de forma coordinada:

- **Redis:** verifica que la sesión esté activa; verifica que la cuenta no esté bloqueada; verifica que el monto no supere el límite diario disponible (INCR atómico). publica el evento en el STREAM de seguridad.

- **Neo4j:** agrega la transferencia como arista al grafo para análisis de patrones en tiempo diferido.

- **MongoDB:** registra la transacción con todos sus atributos en el historial de ambas cuentas.

- El informe debe documentar el orden exacto y qué sucede si Redis aprueba la transacción, pero MongoDB falla al registrarla.

**OP-2 Detección y gestión de fraude en tiempo real (\*) 3 motores** El sistema detecta un patrón de fraude y actúa de forma coordinada:

- **Neo4j:** ejecuta la consulta de detección de patrón sospechoso (ciclos, smurfing).

- **Redis:** bloquea preventivamente las cuentas involucradas con TTL de 30 minutos; publica alertas en el SORTED SET ordenadas por nivel de riesgo. publica el evento en el STREAM de seguridad para auditoría.

- **MongoDB:** registra el evento de detección con el detalle del patrón encontrado.

- El informe debe justificar por qué el bloqueo se hace en Redis y no como flag en MongoDB.

**OP-3 Consulta de extracto con estado de cuenta - 2 motores** El cliente solicita su extracto del último mes con el estado actual de su cuenta:

- **MongoDB:** todas las transacciones del último mes ordenadas cronológicamente con saldo acumulado.

- **Redis:** límite diario disponible en este momento; si la cuenta tiene algún bloqueo activo y su motivo.

- El informe debe justificar por qué Neo4j no participa en esta operación.

**OP-4 Trazabilidad regulatoria de una transferencia - 2 motores**
Ante un requerimiento regulatorio, el sistema traza el camino completo de una transferencia:

- **MongoDB:** recupera los detalles completos de la transacción original.

- **Neo4j:** traza el recorrido de los fondos a través de todas las cuentas intermediarias en hasta 5 saltos.

- El informe debe explicar por qué esta operación no requiere Redis y qué limitación tiene el enfoque de grafos para trazabilidad a largo plazo.

**OP-5 Cierre de alerta de fraude por el equipo de seguridad (\*) 3 motores** El analista de seguridad resuelve una alerta de fraude y el sistema actualiza los tres motores:

- **Redis:** el analista consume la alerta del SORTED SET (ZPOPMAX); si la resolución es 'falso positivo', desbloquea las cuentas (DEL de las claves de bloqueo); publica el evento de cierre en el STREAM.

- **MongoDB:** registra el dictamen completo: fraude confirmado / falso positivo, analista, timestamp, acciones tomadas.

- **Neo4j:** si es fraude confirmado, agrega una etiqueta de 'cuenta comprometida' a los nodos involucrados.

- El informe debe documentar el orden de operaciones y qué pasa si el analista cierra la alerta como falso positivo, pero MongoDB falla al registrarlo.

5. Interfaz de la Aplicación

La capa poliglota debe implementarse como una aplicación con interfaz mínima que permita ejecutar las 5 operaciones sin necesidad de modificar el código fuente. El grupo puede elegir entre:

- **CLI (Command Line Interface):** la aplicación acepta comandos y argumentos por línea de comandos.

- **API REST:** la aplicación expone endpoints HTTP invocables desde un cliente o navegador.

- **Menú interactivo:** la aplicación presenta un menú numerado en la consola para seleccionar la operación y cargar parámetros.

**Requisitos mínimos de la interfaz** Independientemente de la modalidad elegida, la interfaz debe cumplir:

1. Las 5 operaciones poliglotas deben ser invocables sin modificar el código.

2. Las conexiones a los tres motores deben configurarse mediante variables de entorno o archivo de configuración (no hardcodeadas).

3. Los errores de conexión o de datos deben devolver mensajes descriptivos, no stack traces crudos.

4. EI README del repositorio debe incluir instrucciones claras para ejecutar la aplicación.

Justificar en el informe la modalidad elegida y por qué es adecuada para el caso de uso.

6. Informe Escrito

**Estructura Obligatoria** El informe de esta segunda entrega es un documento adicional al de la primera entrega. Debe cubrir únicamente los contenidos nuevos:

- **Introducción:** qué agrega esta entrega al sistema de la primera entrega y cómo se articula con lo ya entregado.

- **Justificación de Redis:** por qué Redis para este dominio, qué problema resuelve que MongoDB y Neo4j no pueden resolver, qué alternativas se descartaron.

- **Modelado en Redis:** estructuras de datos elegidas por caso de uso, convención de nombres de clave, justificación de cada decisión.

- **Diseño de la capa poliglota:** tabla de responsabilidades por motor, diagrama de flujo de datos para cada operación, decisiones de coherencia.

- **Operaciones poliglotas:** para cada una de las 5 operaciones: flujo de consultas, orden de motores, ensamblado de respuesta y estrategia ante fallos.

- **Coherencia entre motores:** qué sucede ante un fallo parcial en una escritura multi-motor. Qué garantías ofrece el sistema y cuáles no.

- **Comparación con arquitectura puramente relacional:** elegir una de las 5 operaciones y mostrar cómo se resolvería en SQL puro. Analizar diferencias en complejidad, rendimiento y mantenibilidad.

- **Conclusiones:** reflexión crítica sobre la arquitectura poliglota: qué ganó el sistema con este diseño y qué complejidad adicional introdujo.

- **Bibliografía:** incorporar la documentación oficial de Redis y la bibliografía complementaria correspondiente.

7. Bibliografía de Referencia

**Obligatoria - incorporada en esta entrega**

- Redis Ltd. (s/f). Redis Documentation. [https://redis.io/docs/](https://redis.io/docs/)

- Harrison, G. (2015). Next Generation Databases: NoSQL, NewSQL, and Big Data. Apress. (Cap. 1 Polyglot Persistence)

**Complementaria**

- Redis Ltd. (s/f). Redis Commands Reference. [https://redis.io/commands/](https://redis.io/commands/)

- Pivert, O. (Ed.). (2018). NoSQL Data Models: Trends and Challenges. ISTE.

**Documentación oficial toda la entrega**

- MongoDB, Inc. (s/f). MongoDB Documentation. [https://www.mongodb.com/docs/](https://www.mongodb.com/docs/)

- Neo4j, Inc. (s/f). Neo4j Documentation. [https://neo4j.com/docs/](https://neo4j.com/docs/)

- Redis Ltd. (s/f). Redis Documentation. [https://redis.io/docs/](https://redis.io/docs/)
