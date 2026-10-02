/* ============================================================
   Café Zócalo — motor de simulación
   Entidades: Tarea, Mesa, Cliente, Pedido(Item), Cuenta
   Algoritmos:
     1) Gate secuencial (fase de preparación)
     2) Asignación de mesa por mejor ajuste (best-fit / bin packing)
     3) Cola FIFO de preparación en barra (un barista, suma de subtareas)
     4) Ciclo de vida del cliente orquestado por temporizadores
   ============================================================ */

/* ---------- Datos base ---------- */

const TAREAS = [
  { id: "insumos", titulo: "Comprar insumos", detalle: "Granos de café, leche, repostería, descartables", icono: "fa-boxes-stacked" },
  { id: "espacio", titulo: "Armar el espacio", detalle: "Calibrar cafeteras, limpiar barra, acomodar mesas y sillas", icono: "fa-broom" },
  { id: "menu", titulo: "Armar menú", detalle: "Definir bebidas, alimentos, combos y carta de precios", icono: "fa-book-open" },
  { id: "propaganda", titulo: "Propaganda", detalle: "Publicidad en redes sociales y cartelería exterior", icono: "fa-bullhorn" },
];

const TIEMPOS_SUBTAREA = { moler: 3, espresso: 6, leche: 5, calentar: 8 };

const MENU = [
  { nombre: "Espresso", precio: 1800, subtareas: ["moler", "espresso"] },
  { nombre: "Cortado", precio: 2100, subtareas: ["moler", "espresso", "leche"] },
  { nombre: "Latte", precio: 2600, subtareas: ["moler", "espresso", "leche"] },
  { nombre: "Medialuna", precio: 900, subtareas: ["calentar"] },
  { nombre: "Tostado", precio: 2400, subtareas: ["calentar"] },
  { nombre: "Combo desayuno", precio: 3200, subtareas: ["moler", "espresso", "leche", "calentar"] },
];

MENU.forEach((item) => {
  item.tiempoPrep = item.subtareas.reduce((suma, t) => suma + TIEMPOS_SUBTAREA[t], 0);
});

const CAPACIDADES_MESAS = [2, 2, 4, 4, 6, 2, 4, 8];

/* ---------- Estado global ---------- */

const estado = {
  tareas: TAREAS.map((t) => ({ ...t, hecha: false })),
  mesas: CAPACIDADES_MESAS.map((cap, i) => ({
    id: i + 1,
    capacidad: cap,
    estado: "libre", // libre | ocupada | cuenta | limpieza
    clienteId: null,
    grupo: null,
    cuentaTotal: 0,
  })),
  colaClientes: [],
  colaPedidos: [],
  contadorClientes: 0,
  contadorPedidos: 0,
  horaSimMin: 8 * 60,
  abierto: false,
  metrics: { clientesAtendidos: 0, ventas: 0 },
};

/* ---------- Utilidades ---------- */

function formatHora(minTotal) {
  const h = Math.floor(minTotal / 60) % 24;
  const m = minTotal % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function log(mensaje) {
  const consola = document.getElementById("logConsola");
  const linea = document.createElement("div");
  linea.className = "logLinea";
  linea.innerHTML = `<span>[${formatHora(estado.horaSimMin)}]</span> ${mensaje}`;
  consola.appendChild(linea);
  while (consola.children.length > 80) consola.removeChild(consola.firstChild);
}

function elegirAleatorio(arr, n) {
  const copia = [...arr];
  const resultado = [];
  for (let i = 0; i < n && copia.length; i++) {
    const idx = Math.floor(Math.random() * copia.length);
    resultado.push(copia.splice(idx, 1)[0]);
  }
  return resultado;
}

/* ============================================================
   FASE 1 — Preparación (gate secuencial)
   ============================================================ */

function tareaDesbloqueada(index) {
  return index === 0 || estado.tareas[index - 1].hecha;
}

function renderTareas() {
  const cont = document.getElementById("listaTareas");
  cont.innerHTML = "";
  estado.tareas.forEach((tarea, index) => {
    const desbloqueada = tareaDesbloqueada(index);
    const div = document.createElement("div");
    div.className = "tarea";
    div.dataset.hecha = tarea.hecha;
    div.dataset.bloqueada = !desbloqueada && !tarea.hecha;
    div.innerHTML = `
      <div class="tareaCabecera">
        <span class="tareaIcono"><i class="fa-solid ${tarea.hecha ? "fa-check" : tarea.icono}"></i></span>
        <span class="tareaTitulo">${tarea.titulo}</span>
      </div>
      <p class="tareaDetalle">${tarea.detalle}</p>
      <button class="botonTarea" data-id="${tarea.id}" ${tarea.hecha || !desbloqueada ? "disabled" : ""}>
        ${tarea.hecha ? "Completada" : "Hacer"}
      </button>
    `;
    cont.appendChild(div);
  });

  cont.querySelectorAll(".botonTarea").forEach((btn) => {
    btn.addEventListener("click", () => completarTarea(btn.dataset.id));
  });

  const botonAbrir = document.getElementById("botonAbrirLocal");
  botonAbrir.disabled = !estado.tareas.every((t) => t.hecha);
}

function completarTarea(id) {
  const index = estado.tareas.findIndex((t) => t.id === id);
  if (index === -1 || !tareaDesbloqueada(index)) return;
  estado.tareas[index].hecha = true;
  log(`Tarea completada: <strong>${estado.tareas[index].titulo}</strong>`);
  renderTareas();
}

function abrirLocal() {
  if (!estado.tareas.every((t) => t.hecha)) return;
  estado.abierto = true;
  document.getElementById("seccionPreparacion").classList.add("oculto");
  document.getElementById("seccionOperacion").classList.remove("oculto");
  const letrero = document.getElementById("letreroEstado");
  letrero.dataset.estado = "abierto";
  document.getElementById("letreroTexto").textContent = "ABIERTO";
  log("<strong>Local abierto.</strong> Comienza la operación.");
  renderSalon();
  motorTick.start();
  motorLlegadas.start();
}

/* ============================================================
   FASE 2 — Salón y algoritmo best-fit de asignación de mesas
   ============================================================ */

function renderSalon() {
  const grid = document.getElementById("salonGrid");
  grid.innerHTML = "";
  estado.mesas.forEach((mesa) => {
    const div = document.createElement("div");
    div.className = "mesa";
    div.dataset.estado = mesa.estado;
    div.dataset.resaltada = mesa.resaltada ? "true" : "false";
    const iconoPorEstado = {
      libre: "fa-chair",
      ocupada: "fa-mug-hot",
      cuenta: "fa-receipt",
      limpieza: "fa-broom",
    };
    div.innerHTML = `
      <span class="mesaIcono"><i class="fa-solid ${iconoPorEstado[mesa.estado]}"></i></span>
      <span class="mesaCap">${mesa.capacidad}p</span>
      <span class="mesaNum">Mesa ${mesa.id}</span>
    `;
    grid.appendChild(div);
    mesa.resaltada = false;
  });
}

function renderColaClientes() {
  const lista = document.getElementById("colaClientesLista");
  lista.innerHTML = "";
  if (estado.colaClientes.length === 0) {
    lista.innerHTML = `<li class="colaVacia">Sin clientes esperando</li>`;
    return;
  }
  estado.colaClientes.forEach((cliente) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>Grupo de ${cliente.grupo}</span><span>desde ${formatHora(cliente.llegada)}</span>`;
    lista.appendChild(li);
  });
}

function renderMetricas() {
  document.getElementById("metricaClientes").textContent = estado.metrics.clientesAtendidos;
  document.getElementById("metricaVentas").textContent = `$${estado.metrics.ventas.toLocaleString("es-AR")}`;
  document.getElementById("metricaEspera").textContent = estado.colaClientes.length;
}

/** Algoritmo de mejor ajuste: entre las mesas libres con capacidad
 *  suficiente, elige la de menor capacidad (minimiza desperdicio). */
function asignarMesaBestFit(cliente) {
  const candidatas = estado.mesas
    .filter((m) => m.estado === "libre" && m.capacidad >= cliente.grupo)
    .sort((a, b) => a.capacidad - b.capacidad);

  if (candidatas.length === 0) return false;

  const mesa = candidatas[0];
  mesa.estado = "ocupada";
  mesa.clienteId = cliente.id;
  mesa.grupo = cliente.grupo;
  mesa.resaltada = true;
  log(`Mesa ${mesa.id} (cap. ${mesa.capacidad}) asignada por best-fit a grupo de ${cliente.grupo}`);
  renderSalon();
  renderMetricas();

  setTimeout(() => tomarPedido(mesa.id), 1300 + Math.random() * 900);
  return true;
}

function nuevoCliente() {
  if (!estado.abierto) return;
  const grupo = 1 + Math.floor(Math.random() * Math.random() * 6); // sesgado a grupos chicos
  const cliente = { id: estado.contadorClientes++, grupo: Math.max(1, grupo), llegada: estado.horaSimMin };
  log(`Llega un cliente — grupo de ${cliente.grupo}`);

  const asignado = asignarMesaBestFit(cliente);
  if (!asignado) {
    estado.colaClientes.push(cliente);
    log(`No hay mesa disponible para el grupo de ${cliente.grupo}. Pasa a la cola de espera.`);
  }
  renderColaClientes();
  renderMetricas();
}

function revisarColaClientes() {
  for (let i = 0; i < estado.colaClientes.length; i++) {
    if (asignarMesaBestFit(estado.colaClientes[i])) {
      estado.colaClientes.splice(i, 1);
      renderColaClientes();
      return;
    }
  }
}

/* ============================================================
   FASE 3 — Toma y realización de pedidos (cola FIFO de barra)
   ============================================================ */

function tomarPedido(mesaId) {
  const mesa = estado.mesas.find((m) => m.id === mesaId);
  if (!mesa || mesa.estado !== "ocupada") return;

  const items = elegirAleatorio(MENU, 1 + Math.floor(Math.random() * Math.min(3, mesa.grupo)));
  const tiempoTotal = items.reduce((s, it) => s + it.tiempoPrep, 0);
  mesa.cuentaTotal = items.reduce((s, it) => s + it.precio, 0);

  const pedido = {
    id: estado.contadorPedidos++,
    mesaId,
    items,
    tiempoTotal,
    tiempoRestante: tiempoTotal,
    estado: "en cola",
  };
  estado.colaPedidos.push(pedido);
  log(`Mesa ${mesaId} pide: ${items.map((i) => i.nombre).join(", ")} <span>(${tiempoTotal}s de preparación)</span>`);
  renderBarra();
}

function renderBarra() {
  const cinta = document.getElementById("cintaBarra");
  cinta.innerHTML = "";
  if (estado.colaPedidos.length === 0) {
    cinta.innerHTML = `<div class="cintaVacia">La barra está tranquila</div>`;
    return;
  }
  estado.colaPedidos.forEach((pedido, index) => {
    const pct = Math.max(0, Math.round(((pedido.tiempoTotal - pedido.tiempoRestante) / pedido.tiempoTotal) * 100));
    const div = document.createElement("div");
    div.className = "pedidoTarjeta";
    div.innerHTML = `
      <div class="pedidoTarjetaTop">
        <span>Mesa ${pedido.mesaId} — ${pedido.items.map((i) => i.nombre).join(" + ")}</span>
        <span>${index === 0 ? "preparando" : "en cola"} · ${pedido.tiempoRestante}s</span>
      </div>
      <div class="pedidoBarra"><div class="pedidoBarraRelleno" style="width:${index === 0 ? pct : 0}%"></div></div>
    `;
    cinta.appendChild(div);
  });
}

function entregarPedido(pedido) {
  estado.colaPedidos.shift();
  const mesa = estado.mesas.find((m) => m.id === pedido.mesaId);
  log(`Pedido de mesa ${pedido.mesaId} listo y entregado`);
  renderBarra();
  if (mesa) setTimeout(() => pedirCuentaYCobrar(mesa.id), 2200 + Math.random() * 1300);
}

/* ============================================================
   FASE 4 — Cuenta, cobro y limpieza
   ============================================================ */

function pedirCuentaYCobrar(mesaId) {
  const mesa = estado.mesas.find((m) => m.id === mesaId);
  if (!mesa || mesa.estado !== "ocupada") return;
  mesa.estado = "cuenta";
  log(`Mesa ${mesaId}: se entrega la cuenta — $${mesa.cuentaTotal.toLocaleString("es-AR")}`);
  renderSalon();

  setTimeout(() => {
    estado.metrics.ventas += mesa.cuentaTotal;
    estado.metrics.clientesAtendidos += 1;
    log(`Mesa ${mesaId}: cobrado $${mesa.cuentaTotal.toLocaleString("es-AR")}. El cliente se retira.`);
    mesa.estado = "limpieza";
    renderSalon();
    renderMetricas();

    setTimeout(() => {
      mesa.estado = "libre";
      mesa.clienteId = null;
      mesa.grupo = null;
      mesa.cuentaTotal = 0;
      log(`Mesa ${mesaId} limpia y libre`);
      renderSalon();
      revisarColaClientes();
    }, 1100);
  }, 1000 + Math.random() * 700);
}

/* ============================================================
   Motor de tiempo — cola FIFO de la barra + reloj de simulación
   ============================================================ */

const motorTick = {
  intervalId: null,
  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      estado.horaSimMin += 1;
      document.getElementById("relojValor").textContent = formatHora(estado.horaSimMin);

      if (estado.colaPedidos.length > 0) {
        const activo = estado.colaPedidos[0];
        activo.estado = "preparando";
        activo.tiempoRestante -= 1;
        if (activo.tiempoRestante <= 0) {
          entregarPedido(activo);
        } else {
          renderBarra();
        }
      }
    }, 850);
  },
};

const motorLlegadas = {
  timeoutId: null,
  start() {
    const programarSiguiente = () => {
      this.timeoutId = setTimeout(() => {
        nuevoCliente();
        programarSiguiente();
      }, 3800 + Math.random() * 4200);
    };
    programarSiguiente();
  },
};

/* ---------- Inicialización ---------- */

document.getElementById("botonAbrirLocal").addEventListener("click", abrirLocal);
document.getElementById("botonNuevoCliente").addEventListener("click", nuevoCliente);

renderTareas();
renderSalon();
renderColaClientes();
renderBarra();
renderMetricas();
log("Sistema listo. Completá las tareas de preparación para abrir el local.");
