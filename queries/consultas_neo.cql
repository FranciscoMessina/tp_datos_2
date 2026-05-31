// Constraints de unicidad para las entidades
CREATE CONSTRAINT cliente_cuit IF NOT EXISTS
FOR (c:Cliente)
REQUIRE c.cuit IS UNIQUE;

CREATE CONSTRAINT cuenta_numero IF NOT EXISTS
FOR (c:Cuenta)
REQUIRE c.numero IS UNIQUE;

CREATE CONSTRAINT transaccion_rel_transferencia_id IF NOT EXISTS
FOR ()-[t:TRANSFIRIO]-()
REQUIRE t.id IS UNIQUE;

CREATE CONSTRAINT tarjeta_numero IF NOT EXISTS
FOR (t:Tarjeta)
REQUIRE t.numero IS UNIQUE;

// Creacion de indices para las busquedas
CREATE INDEX idx_transaccion_rel_transferencia_fecha IF NOT EXISTS
FOR ()-[t:TRANSFIRIO]-()
ON (t.fecha);

CREATE INDEX idx_cliente_sospechoso IF NOT EXISTS
FOR (c:Cliente)
ON (c.sospechoso);

// 7 a) Dado un número de cuenta, trazar el recorrido completo de una transferencia a través de cuentas intermediarias (hasta 5 saltos).

MATCH
  path =
    (origen:Cuenta {numero: 4235029839})-[:TRANSFIRIO*1..5]->(destino:Cuenta)
RETURN
  [nodo IN nodes(path) | nodo.numero] AS recorrido,
  [rel IN relationships(path) | rel.monto] AS montos,
  [rel IN relationships(path) | rel.fecha] AS fechas,
  length(path) AS saltos
ORDER BY saltos;

// 7 b) Detectar cuentas que reciben fondos de muchas cuentas distintas y los redistribuyen rápidamente (patrón 'smurfing').

MATCH
  (entrada:Cuenta)-[r1:TRANSFIRIO]->
  (centro:Cuenta)-[r2:TRANSFIRIO]->
  (salida:Cuenta)
WHERE r2.fecha <= r1.fecha + duration({hours: 24}) AND entrada <> salida
WITH
  centro,
  COUNT(DISTINCT entrada) AS fuentes,
  COUNT(DISTINCT salida) AS destinos,
  SUM(r2.monto) AS total_redistribuido
WHERE fuentes >= 3 AND destinos >= 3
RETURN centro.numero AS cuenta_centro;

// 7 c) Encontrar grupos de cuentas que forman ciclos (el dinero vuelve al origen: posible lavado)

MATCH path = (origen:Cuenta)-[:TRANSFIRIO*2..10]->(origen)
WITH origen, [nodo IN nodes(path) | nodo.numero] AS ciclo, length(path) AS largo
RETURN DISTINCT origen.numero AS cuenta_inicial, ciclo, largo
ORDER BY largo;

// 7 d) Identificar cuentas con comportamiento anómalo: reciben transferencias de cuentas sin historial previo entre sí.

MATCH (nueva:Cuenta)-[r:TRANSFIRIO]->(receptora:Cuenta)
WHERE
  r.fecha >= datetime() - duration({days: 90}) AND
  NOT EXISTS {
    MATCH (nueva)-[:TRANSFIRIO]->(receptora)
    WHERE r.fecha < datetime() - duration({days: 90})
  }
WITH
  receptora,
  COUNT(DISTINCT nueva) AS remitentes_nuevos,
  SUM(r.monto) AS monto_total
WHERE remitentes_nuevos >= 5
RETURN receptora.numero AS cuenta_receptora, remitentes_nuevos, monto_total
ORDER BY remitentes_nuevos DESC;

// 7 e) Dado un cliente marcado como sospechoso, obtener todas las cuentas conectadas en hasta 3 saltos de transferencia

MATCH (cliente:Cliente {sospechoso: true})-[:TIENE_CUENTA]->(sospechosa:Cuenta)
MATCH path = (sospechosa)-[:TRANSFIRIO*1..3]-(conectada:Cuenta)
WHERE sospechosa <> conectada
RETURN
  cliente.nombre AS cliente_sospechoso,
  sospechosa.numero AS cuenta_sospechosa,
  [nodo IN nodes(path) | nodo.numero] AS recorrido,
  length(path) AS saltos
ORDER BY saltos;