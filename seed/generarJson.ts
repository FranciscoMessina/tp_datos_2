import { fakerES as faker } from "@faker-js/faker";
import { writeFileSync } from "node:fs";
import type {
  AlertaFraude,
  Beneficiario,
  Cliente,
  Cuenta,
  Tarjeta,
  Transaccion,
} from "../estructura-datos";

function generarClientes(cantidad: number): Cliente[] {
  return Array.from({ length: cantidad }).map(() => ({
    _id: faker.string.uuid(),
    nombre: faker.person.fullName(),

    documento: `${faker.helpers.arrayElement(["20", "23", "27", "30"])}-${faker.string.numeric(8)}-${faker.string.numeric(1)}`,

    tipo: faker.helpers.arrayElement(["personaFisica", "empresa"]),

    domicilio: {
      altura: faker.number.int({ min: 100, max: 15000 }),
      calle: faker.location.street(),
      localidad: faker.location.city(),
      pais: "Argentina",
      provincia: "Buenos Aires",
    },

    fechaDeAlta: faker.date.past({ years: 5 }),
    sospechoso: faker.datatype.boolean(),
    scoreCrediticio: faker.number.int({ min: 300, max: 850 }),
  }));
}

function generarCuentas(cantidad: number, clientesIds: string[]): Cuenta[] {
  return Array.from({ length: cantidad }).map(() => ({
    _id: faker.string.uuid(),
    numero: "CTA-" + faker.string.numeric(10),
    tipo: faker.helpers.arrayElement([
      "cajaDeAhorro",
      "cuentaCorriente",
      "inversion",
    ]),
    moneda: faker.helpers.arrayElement(["ARS", "ARS", "ARS"]), // Mayoría en pesos
    saldoActual: faker.number.float({
      min: -10000,
      max: 5000000,
      fractionDigits: 2,
    }),
    estado: faker.helpers.arrayElement(["activa", "activa", "bloqueada"]),
    clienteTitularId: faker.helpers.arrayElement(clientesIds),
  }));
}

function generarTarjetas(cuentas: Cuenta[]): Tarjeta[] {
  return cuentas.map((cuenta) => ({
    _id: faker.string.uuid(),
    numeroEnmascarado: `****-****-****-${faker.string.numeric(4)}`,
    tipo: faker.helpers.arrayElement(["debito", "credito"]),
    limite: faker.number.int({ min: 50000, max: 2000000 }),
    fechaVencimiento: faker.date.future({ years: 4 }),
    estado: faker.helpers.arrayElement(["activa", "activa", "bloqueada"]),
    cuentaId: cuenta.numero,
  }));
}

const generarDescripcion = (tipo: string): string => {
  switch (tipo) {
    case "debito":
      return faker.helpers.arrayElement([
        `Compra en ${faker.company.name()}`,
        `Débito automático - ${faker.company.name()}`,
        `Pago en comercio - ${faker.location.city()}`,
      ]);
    case "credito":
      return faker.helpers.arrayElement([
        `Acreditación de haberes`,
        `Devolución de compra - ${faker.company.name()}`,
        `Depósito por ventanilla`,
        `Ingreso de fondos`,
      ]);
    case "transferencia":
      return faker.helpers.arrayElement([`Transferencia`]);
    case "servicio":
      return faker.helpers.arrayElement([
        `Pago de servicios - Edesur/Edenor`,
        `Pago de telefonía - Claro/Personal/Movistar`,
        `Pago de tarjeta de crédito`,
        `Impuestos AFIP`,
      ]);
    default:
      return "Movimiento de cuenta";
  }
};

function generarTransacciones(
  cantidad: number,
  idsDeCuentas: string[],
): Transaccion[] {
  return Array.from({ length: cantidad }).map(() => {
    const tipo = faker.helpers.arrayElement([
      "debito",
      "credito",
      "transferencia",
      "transferencia",
      "transferencia",
      "servicio",
    ]);
    const cuentaOrigenId = faker.helpers.arrayElement(idsDeCuentas);
    let cuentaDestinoId: string | undefined;

    if (tipo === "transferencia") {
      cuentaDestinoId = faker.helpers.arrayElement(
        idsDeCuentas.filter((n) => n !== cuentaOrigenId),
      );
    }

    return {
      _id: faker.string.uuid(),
      tipo,
      monto: faker.number.float({ min: 100, max: 1500000, fractionDigits: 2 }),
      // Distribuidas en los últimos 30 días
      fecha: faker.date.recent({ days: 60 }),
      cuentaOrigenId,
      cuentaDestinoId,
      descripcion: generarDescripcion(tipo),
      canal: faker.helpers.arrayElement(["app", "cajero", "sucursal"]),
    };
  });
}

function generarAlertas(
  cantidad: number,
  idsTransacciones: string[],
): AlertaFraude[] {
  return Array.from({ length: cantidad }).map(() => ({
    _id: faker.string.uuid(),
    idTransaccion: faker.helpers.arrayElement(idsTransacciones),
    tipo: faker.helpers.arrayElement([
      "smurfing",
      "lavado",
      "destinatariosInusuales",
      "ciclo",
    ]),
    nivelRiesgo: faker.helpers.arrayElement([1, 2, 3, 4, 5]),
    estado: faker.helpers.arrayElement([
      "pendiente",
      "investigando",
      "cerrada",
    ]),
    fecha: faker.date.recent({ days: 10 }),
  }));
}

function generarBeneficiarios(
  cantidad: number,
  idsClientes: string[],
): Beneficiario[] {
  return Array.from({ length: cantidad }).map(() => ({
    _id: faker.string.uuid(),
    nombre: faker.person.fullName(),
    alias:
      `${faker.word.noun()}.${faker.word.noun()}.${faker.word.noun()}`.toLowerCase(),
    cbu: parseInt(faker.string.numeric(22), 10),
    idCliente: faker.helpers.arrayElement(idsClientes),
  }));
}

function run() {
  console.log("Generando datos...");

  const clientes = generarClientes(500);
  const clientesIds = clientes.map((c) => c._id);

  const cuentas = generarCuentas(800, clientesIds);
  const cuentasNumeros = cuentas.map((c) => c._id);

  const tarjetas = generarTarjetas(cuentas);

  const transacciones = generarTransacciones(5000, cuentasNumeros);
  const transaccionesIds = transacciones.map((t) => t._id);

  const alertas = generarAlertas(50, transaccionesIds);
  const beneficiarios = generarBeneficiarios(300, clientesIds);

  const db = {
    clientes,
    cuentas,
    tarjetas,
    transacciones,
    alertas,
    beneficiarios,
  };

  writeFileSync("./seed/banco_data.json", JSON.stringify(db, null, 2));
  console.log("Datos generados exitosamente en banco_data.json");
}

run();
