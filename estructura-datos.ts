export interface Cliente {
  _id: string; // Mongo genera una automaticamente, pero para poder tener la misma en referencia para neo4j vamos a poner una nosotros.
  // Nombre del cliente
  nombre: string;
  // CUIT, CUIL o DNI
  documento: string;
  // Tipo de entidad del dueño de la cuenta
  tipo: "personaFisica" | "empresa";
  // Direccion de la empresa o persona.
  domicilio: {
    calle: string;
    altura: number;
    localidad: string;
    provincia: string;
    pais: string;
  };
  // Fecha de creacion de la cuenta.
  fechaDeAlta: Date;
  // Puntaje crediticio.
  scoreCrediticio: number;
}

export interface Cuenta {
  _id: string; // Mongo genera una automaticamente, pero para poder tener la misma en referencia para neo4j vamos a poner una nosotros.
  // Numero de cuenta;
  numero: string;
  // Tipo:
  tipo: "cajaDeAhorro" | "cuentaCorriente" | "inversion";
  // Moneda de la cuenta
  moneda: "ARS";
  // Saldo actual
  saldoActual: number;

  clienteTitularId: string;
  // Estado?
  estado: "activa" | "bloqueada" | "cerrada";

  // Aca podriamos tener las tarjetas como documentos internos del cliente/o cuenta
}

export interface Transaccion {
  _id: string; // Mongo genera una automaticamente, pero para poder tener la misma en referencia para neo4j vamos a poner una nosotros.
  tipo: "debito" | "credito" | "transferencia" | "servicio";
  monto: number;
  fecha: Date;
  cuentaOrigenId: string;
  // Opcional si no es una transferencia? .
  cuentaDestinoId?: string;
  descripcion?: string;

  canal: "app" | "cajero" | "sucursal";
}

// Tenemos la opcion de tener Tarjeta como una coleccion separada o de directamente tenerlas
// dentro de la cuenta como documentos embebidos. (Como cada cuenta suele tener pocas tarjetas, tranquilamente podemos tenerlas como embebidas.)
export interface Tarjeta {
  _id: string; // Mongo genera una automaticamente, pero para poder tener la misma en referencia para neo4j vamos a poner una nosotros.

  numeroEnmascarado: string;

  tipo: "debito" | "credito";

  limite: number;

  fechaVencimiento: Date;

  estado: "activa" | "bloqueada" | "vencida" | "cancelada";

  // Referencia a la cuenta que corresponde a esta tarjeta.
  cuentaId: string;
}

export interface AlertaFraude {
  _id: string; // Mongo genera una automaticamente, pero para poder tener la misma en referencia para neo4j vamos a poner una nosotros.
  // id de la transferencia asociada a la alaerta
  idTransaccion: string;

  tipo: "smurfing" | "ciclo" | "cascada" | "destinatariosInusuales" | "lavado";

  nivelRiesgo: 1 | 2 | 3 | 4 | 5;

  estado: "pendiente" | "investigando" | "cerrada";

  // Fecha del reporte
  fecha: Date;

  cuentasInvolucradas?: string[];

  resolucion?: {
    fecha: Date;
    estado: "confirmado" | "falso_positivo";
    accionesTomadas: string;
    analista: string;
  };
}

// Asumiendo que es un contacto para transferir.
export interface Beneficiario {
  _id: string; // Mongo genera una automaticamente, pero para poder tener la misma en referencia para neo4j vamos a poner una nosotros.
  nombre: string;

  alias: string;

  cbu: number;

  idCliente: string;
}

// Sesion en REDIS
export interface Sesion {
  clienteId: string;
  canal: "app" | "cajero" | "sucursal";
  dispositivo: string;
  ip: string;
  ultimaOperacion: string;
  inicio: Date;
}
