/* =========================================================
   ARSLAN • FACTURAS & CONTABILIDAD (NUEVO)
   - Clientes + Tags
   - Facturas: fecha, numero, cliente, tag, importe, estado
   - Resúmenes: semanas, meses, periodos
   - Pendiente por cliente + global siempre visible
   - Mensaje WhatsApp al marcar cobrada
   - LocalStorage + Cloud Sync Firebase (anónimo)
========================================================= */

/* ---------------------------
   UTILIDADES
--------------------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const money = (n) => {
  const x = Number(n || 0);
  return x.toLocaleString("es-ES", { style:"currency", currency:"EUR" });
};

const uid = () => Math.random().toString(16).slice(2) + Date.now().toString(16);

function toISODate(d){
  // d: Date
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseISODate(s){
  // "YYYY-MM-DD"
  if(!s) return null;
  const [y,m,d] = s.split("-").map(Number);
  if(!y||!m||!d) return null;
  return new Date(y, m-1, d);
}

function clampDateRange(fromISO, toISO){
  const from = parseISODate(fromISO);
  const to = parseISODate(toISO);
  if(from && to && from > to){
    return { fromISO: toISO, toISO: fromISO };
  }
  return { fromISO, toISO };
}

function startOfWeek(date){
  // Semana ISO (lunes)
  const d = new Date(date);
  const day = (d.getDay()+6)%7; // lunes=0
  d.setDate(d.getDate() - day);
  d.setHours(0,0,0,0);
  return d;
}
function endOfWeek(date){
  const s = startOfWeek(date);
  const e = new Date(s);
  e.setDate(e.getDate()+6);
  e.setHours(23,59,59,999);
  return e;
}
function startOfMonth(date){
  const d = new Date(date.getFullYear(), date.getMonth(), 1);
  d.setHours(0,0,0,0);
  return d;
}
function endOfMonth(date){
  const d = new Date(date.getFullYear(), date.getMonth()+1, 0);
  d.setHours(23,59,59,999);
  return d;
}
function sameDay(a,b){
  return a && b && a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}

function safeText(s){ return String(s ?? "").trim(); }

function downloadJSON(obj, filename="backup_facturas.json"){
  const blob = new Blob([JSON.stringify(obj,null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function readFileAsText(file){
  return new Promise((resolve,reject)=>{
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result||""));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file);
  });
}

/* ---------------------------
   STORAGE
--------------------------- */
const K = {
  PIN_OK: "ARSLAN_PIN_OK_V2",
  DATA: "ARSLAN_FACTURAS_DATA_V2",
  CLOUD_LAST_PUSH: "ARSLAN_CLOUD_LAST_PUSH_V2",
};

const DEFAULT_DATA = {
  version: 2,
  clients: [
    // ejemplos iniciales (puedes borrar)
    { id: "cli_riviera", name: "RIVIERA", phone: "", tags: ["RIVIERA"], notes:"" },
    { id: "cli_braseros", name: "RESTAURACION HERMANOS MARIJUÁN (BRASEROS)", phone: "", tags: [
      "BRASEROS CENTRO","BRASEROS SEVERO","BRASEROS EDIFICIO","BRASEROS TOMILLARES"
    ], notes:"" },
  ],
  invoices: [
    // {id, dateISO, number, clientId, clientNameCache, tag, amount, status, notes, createdAt, updatedAt}
  ],
  settings: {
    currency: "EUR",
    whatsappTemplate:
`Hola {cliente},
Factura: {numero}
Fecha: {fecha}
Tag: {tag}
Importe: {importe}
Estado: COBRADA ✅

Gracias.`,
  },
  meta: {
    updatedAt: Date.now(),
  }
};

let DB = loadLocal();

/* ---------------------------
   CLOUD SYNC (FIREBASE)
--------------------------- */
const cloudStatus = $("#cloudStatus");
function setCloudStatus(type, text){
  if(!cloudStatus) return;
  cloudStatus.className = "cloud-pill " + type;
  cloudStatus.textContent = text;
}

let CLOUD_READY = false;
let CLOUD_UID = null;
let CLOUD_REF = null;
let CLOUD_LISTENING = false;
let CLOUD_LOCK = false; // evita loops al aplicar cambios remotos

function initCloud(){
  try{
    if(!window.__FIREBASE_CONFIG){
      setCloudStatus("bad","☁️ Nube: no configurada");
      return;
    }
    firebase.initializeApp(window.__FIREBASE_CONFIG);
    const auth = firebase.auth();
    const db = firebase.database();

    setCloudStatus("warn","☁️ Conectando…");

    auth.signInAnonymously().then(()=>{
      auth.onAuthStateChanged(user=>{
        if(!user){
          setCloudStatus("bad","☁️ Sin sesión");
          return;
        }
        CLOUD_UID = user.uid;
        CLOUD_READY = true;
        CLOUD_REF = db.ref("arslan_facturas_v2/" + CLOUD_UID);

        setCloudStatus("ok","☁️ Nube online");

        if(!CLOUD_LISTENING){
          CLOUD_LISTENING = true;
          CLOUD_REF.on("value", snap=>{
            const remote = snap.val();
            if(!remote) return;

            // Si remote es igual o más nuevo, aplicamos
            const remoteUpdated = Number(remote?.meta?.updatedAt || 0);
            const localUpdated = Number(DB?.meta?.updatedAt || 0);

            if(remoteUpdated > localUpdated){
              CLOUD_LOCK = true;
              DB = remote;
              saveLocal();
              renderAll();
              CLOUD_LOCK = false;
            }
          });
        }

        // Primer push si local más nuevo o nube vacía
        CLOUD_REF.get().then(snap=>{
          const remote = snap.val();
          if(!remote){
            pushCloud();
          }else{
            const remoteUpdated = Number(remote?.meta?.updatedAt || 0);
            const localUpdated = Number(DB?.meta?.updatedAt || 0);
            if(localUpdated > remoteUpdated){
              pushCloud();
            }
          }
        }).catch(()=>{ /* ignore */ });

      });
    }).catch(()=>{
      setCloudStatus("bad","☁️ Error login");
    });
  }catch(e){
    setCloudStatus("bad","☁️ Error nube");
  }
}

function pushCloud(){
  if(!CLOUD_READY || !CLOUD_REF) return;
  if(CLOUD_LOCK) return;
  try{
    const payload = DB;
    CLOUD_REF.set(payload);
    localStorage.setItem(K.CLOUD_LAST_PUSH, String(Date.now()));
  }catch(e){
    // ignore
  }
}

/* ---------------------------
   LOCAL LOAD/SAVE
--------------------------- */
function loadLocal(){
  const raw = localStorage.getItem(K.DATA);
  if(!raw){
    const d = structuredClone(DEFAULT_DATA);
    d.meta.updatedAt = Date.now();
    localStorage.setItem(K.DATA, JSON.stringify(d));
    return d;
  }
  try{
    const d = JSON.parse(raw);
    if(!d || typeof d !== "object") throw new Error("bad");
    if(!Array.isArray(d.clients)) d.clients = [];
    if(!Array.isArray(d.invoices)) d.invoices = [];
    if(!d.settings) d.settings = structuredClone(DEFAULT_DATA.settings);
    if(!d.meta) d.meta = { updatedAt: Date.now() };
    return d;
  }catch{
    const d = structuredClone(DEFAULT_DATA);
    d.meta.updatedAt = Date.now();
    localStorage.setItem(K.DATA, JSON.stringify(d));
    return d;
  }
}

function saveLocal(){
  DB.meta.updatedAt = Date.now();
  localStorage.setItem(K.DATA, JSON.stringify(DB));
  // nube
  pushCloud();
}

/* ---------------------------
   PIN GATE
--------------------------- */
const pinGate = $("#pinGate");
const app = $("#app");
const pinInput = $("#pinInput");
const pinBtn = $("#pinBtn");
const pinMsg = $("#pinMsg");
const btnLock = $("#btnLock");

// PIN protegido (simple). No se muestra en UI.
// Nota: Se deja así porque lo pides fijo.
const PIN_CODE = "7392";

function isPinOk(){
  return localStorage.getItem(K.PIN_OK) === "1";
}
function setPinOk(v){
  localStorage.setItem(K.PIN_OK, v ? "1" : "0");
}
function lock(){
  setPinOk(false);
  app.classList.add("hidden");
  pinGate.classList.remove("hidden");
  pinInput.value = "";
  pinMsg.textContent = "";
  pinInput.focus();
}

function unlock(){
  setPinOk(true);
  pinGate.classList.add("hidden");
  app.classList.remove("hidden");
  pinMsg.textContent = "";
}

function checkPin(){
  const v = safeText(pinInput.value);
  if(v === PIN_CODE){
    unlock();
    renderAll();
  }else{
    pinMsg.textContent = "PIN incorrecto";
  }
}

/* ---------------------------
   NAV / TABS
--------------------------- */
const tabs = {
  dashboard: $("#tab-dashboard"),
  invoices: $("#tab-invoices"),
  clients: $("#tab-clients"),
  reports: $("#tab-reports"),
};

function showTab(key){
  $$(".navItem").forEach(b=>b.classList.remove("active"));
  const btn = $(`.navItem[data-tab="${key}"]`);
  if(btn) btn.classList.add("active");
  Object.keys(tabs).forEach(k=>{
    tabs[k].classList.toggle("hidden", k!==key);
  });
}

/* ---------------------------
   MODAL
--------------------------- */
const modal = $("#modal");
const modalTitle = $("#modalTitle");
const modalBody = $("#modalBody");
const modalFooter = $("#modalFooter");
const modalClose = $("#modalClose");

function openModal(title, bodyNode, footerNode){
  modalTitle.textContent = title;
  modalBody.innerHTML = "";
  modalBody.appendChild(bodyNode);
  modalFooter.innerHTML = "";
  if(footerNode) modalFooter.appendChild(footerNode);
  modal.classList.remove("hidden");
}
function closeModal(){
  modal.classList.add("hidden");
}
modalClose?.addEventListener("click", closeModal);
modal?.addEventListener("click", (e)=>{
  if(e.target === modal) closeModal();
});

/* ---------------------------
   DATA HELPERS
--------------------------- */
function getClientById(id){
  return DB.clients.find(c=>c.id===id) || null;
}

function normalizeInvoice(inv){
  // cache client name to keep history even if renamed
  const c = getClientById(inv.clientId);
  inv.clientNameCache = c ? c.name : (inv.clientNameCache || "");
  inv.updatedAt = Date.now();
  return inv;
}

function getInvoicesFiltered(opts){
  const q = safeText(opts.q).toLowerCase();
  const clientId = opts.clientId || "all";
  const status = opts.status || "all";
  const fromISO = opts.fromISO || "";
  const toISO = opts.toISO || "";
  const range = clampDateRange(fromISO, toISO);

  const from = range.fromISO ? parseISODate(range.fromISO) : null;
  const to = range.toISO ? parseISODate(range.toISO) : null;

  return DB.invoices.filter(inv=>{
    const cName = (inv.clientNameCache || "").toLowerCase();
    const tag = (inv.tag || "").toLowerCase();
    const num = (inv.number || "").toLowerCase();

    if(q){
      const ok = (cName.includes(q) || tag.includes(q) || num.includes(q));
      if(!ok) return false;
    }
    if(clientId !== "all" && inv.clientId !== clientId) return false;
    if(status !== "all" && inv.status !== status) return false;

    if(from || to){
      const d = parseISODate(inv.dateISO);
      if(!d) return false;
      if(from && d < from) return false;
      if(to){
        const t2 = new Date(to);
        t2.setHours(23,59,59,999);
        if(d > t2) return false;
      }
    }
    return true;
  }).sort((a,b)=>{
    // por fecha desc, luego updated desc
    const da = parseISODate(a.dateISO)?.getTime() || 0;
    const db = parseISODate(b.dateISO)?.getTime() || 0;
    if(db!==da) return db-da;
    return (b.updatedAt||0)-(a.updatedAt||0);
  });
}

function sumByStatus(invoices){
  const out = { Pendiente:0, Girada:0, Cobrada:0, all:0 };
  for(const inv of invoices){
    const amt = Number(inv.amount||0);
    out.all += amt;
    if(inv.status==="Pendiente") out.Pendiente += amt;
    if(inv.status==="Girada") out.Girada += amt;
    if(inv.status==="Cobrada") out.Cobrada += amt;
  }
  return out;
}

function pendingByClient(search=""){
  const q = safeText(search).toLowerCase();
  const map = new Map(); // clientId -> {name,pending,count}
  for(const c of DB.clients){
    if(q && !c.name.toLowerCase().includes(q)) continue;
    map.set(c.id, { id:c.id, name:c.name, pending:0, count:0 });
  }
  for(const inv of DB.invoices){
    if(inv.status !== "Pendiente") continue;
    const row = map.get(inv.clientId);
    if(!row) continue;
    row.pending += Number(inv.amount||0);
    row.count += 1;
  }
  return Array.from(map.values())
    .filter(r=>r.pending>0 || q) // si hay búsqueda, mostramos aunque 0
    .sort((a,b)=>b.pending-a.pending);
}

/* ---------------------------
   PERIODS
--------------------------- */
function resolvePeriod(sel){
  const now = new Date();
  const todayISO = toISODate(now);
  let from=null, to=null;

  if(sel==="thisWeek"){
    from = startOfWeek(now);
    to = endOfWeek(now);
  }else if(sel==="lastWeek"){
    const s = startOfWeek(now);
    s.setDate(s.getDate()-7);
    from = s;
    to = endOfWeek(s);
  }else if(sel==="thisMonth"){
    from = startOfMonth(now);
    to = endOfMonth(now);
  }else if(sel==="lastMonth"){
    const d = new Date(now.getFullYear(), now.getMonth()-1, 1);
    from = startOfMonth(d);
    to = endOfMonth(d);
  }else if(sel==="year"){
    from = new Date(now.getFullYear(),0,1);
    from.setHours(0,0,0,0);
    to = new Date(now.getFullYear(),11,31);
    to.setHours(23,59,59,999);
  }else if(sel==="all"){
    from = null; to = null;
  }else{
    // custom se gestiona fuera
    from = null; to = null;
  }

  return {
    fromISO: from ? toISODate(from) : "",
    toISO: to ? toISODate(to) : (sel==="all" ? "" : todayISO),
  };
}

/* ---------------------------
   RENDER: SELECTS
--------------------------- */
function renderClientSelects(){
  const fill = (sel, includeAll=true) => {
    const el = $(sel);
    if(!el) return;
    el.innerHTML = "";
    if(includeAll){
      const o = document.createElement("option");
      o.value = "all";
      o.textContent = "Todos clientes";
      el.appendChild(o);
    }
    for(const c of DB.clients.slice().sort((a,b)=>a.name.localeCompare(b.name))){
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.name;
      el.appendChild(o);
    }
  };

  fill("#invClientFilter", true);
  fill("#repClient", true);

  // en reportes por cliente, el "all" es válido
}

/* ---------------------------
   RENDER: DASHBOARD
--------------------------- */
const kpiPendingGlobal = $("#kpiPendingGlobal");
const kpiPendingCount = $("#kpiPendingCount");
const kpiGiradaGlobal = $("#kpiGiradaGlobal");
const kpiPaidGlobal = $("#kpiPaidGlobal");
const pendingByClientList = $("#pendingByClientList");
const dashSearchClient = $("#dashSearchClient");
const dashPeriod = $("#dashPeriod");
const dashFrom = $("#dashFrom");
const dashTo = $("#dashTo");
const dashApply = $("#dashApply");
const dashSummary = $("#dashSummary");

function renderKPIs(){
  const all = DB.invoices;
  const sums = sumByStatus(all);
  const pendingCount = all.filter(i=>i.status==="Pendiente").length;

  kpiPendingGlobal.textContent = money(sums.Pendiente);
  kpiPendingCount.textContent = String(pendingCount);
  kpiGiradaGlobal.textContent = money(sums.Girada);
  kpiPaidGlobal.textContent = money(sums.Cobrada);
}

function renderPendingByClient(){
  const rows = pendingByClient(dashSearchClient?.value || "");
  pendingByClientList.innerHTML = "";

  if(rows.length===0){
    const div = document.createElement("div");
    div.className = "muted";
    div.textContent = "Sin pendientes por cliente.";
    pendingByClientList.appendChild(div);
    return;
  }

  for(const r of rows){
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div>
        <div class="name">${r.name}</div>
        <div class="sub">${r.count} factura(s) pendiente(s)</div>
      </div>
      <div class="badge bad">${money(r.pending)}</div>
    `;
    pendingByClientList.appendChild(el);
  }
}

function renderDashSummary(){
  // determina periodo actual
  const sel = dashPeriod.value;
  let fromISO="", toISO="";
  if(sel==="custom"){
    fromISO = dashFrom.value || "";
    toISO = dashTo.value || "";
  }else{
    const p = resolvePeriod(sel);
    fromISO = p.fromISO;
    toISO = p.toISO;
    // set inputs
    dashFrom.value = fromISO;
    dashTo.value = toISO;
  }

  const invs = getInvoicesFiltered({
    q:"",
    clientId:"all",
    status:"all",
    fromISO, toISO
  });

  const sums = sumByStatus(invs);

  dashSummary.innerHTML = "";
  const boxes = [
    {t:"Total € (periodo)", v: money(sums.all)},
    {t:"Pendiente €", v: money(sums.Pendiente)},
    {t:"Girada €", v: money(sums.Girada)},
    {t:"Cobrada €", v: money(sums.Cobrada)},
  ];
  for(const b of boxes){
    const div = document.createElement("div");
    div.className = "sumBox";
    div.innerHTML = `<div class="t">${b.t}</div><div class="v">${b.v}</div>`;
    dashSummary.appendChild(div);
  }
}

/* ---------------------------
   RENDER: INVOICES
--------------------------- */
const invTbody = $("#invTbody");
const invSearch = $("#invSearch");
const invClientFilter = $("#invClientFilter");
const invStatusFilter = $("#invStatusFilter");
const invFrom = $("#invFrom");
const invTo = $("#invTo");
const invClearFilters = $("#invClearFilters");
const btnNewInvoice = $("#btnNewInvoice");
const invCountInfo = $("#invCountInfo");
const invTotalInfo = $("#invTotalInfo");

function renderInvoices(){
  const list = getInvoicesFiltered({
    q: invSearch.value,
    clientId: invClientFilter.value,
    status: invStatusFilter.value,
    fromISO: invFrom.value,
    toISO: invTo.value,
  });

  invTbody.innerHTML = "";
  let total = 0;

  for(const inv of list){
    total += Number(inv.amount||0);
    const tr = document.createElement("tr");

    const badgeCls =
      inv.status==="Cobrada" ? "good" :
      inv.status==="Girada" ? "warn" : "bad";

    tr.innerHTML = `
      <td>${inv.dateISO || ""}</td>
      <td><span class="strong">${escapeHtml(inv.number||"")}</span></td>
      <td>${escapeHtml(inv.clientNameCache||"")}</td>
      <td>${escapeHtml(inv.tag||"")}</td>
      <td class="right">${money(inv.amount||0)}</td>
      <td><span class="badge ${badgeCls}">${inv.status}</span></td>
      <td>
        <button class="btn ghost" data-act="edit" data-id="${inv.id}">Editar</button>
        <button class="btn ghost" data-act="msg" data-id="${inv.id}">Mensaje</button>
        <button class="btn ghost danger" data-act="del" data-id="${inv.id}">Borrar</button>
      </td>
    `;
    invTbody.appendChild(tr);
  }

  invCountInfo.textContent = `${list.length} factura(s)`;
  invTotalInfo.textContent = `Total listado: ${money(total)}`;

  // acciones
  invTbody.querySelectorAll("button[data-act]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if(act==="edit") openInvoiceModal(id);
      if(act==="msg") openMessageModal(id);
      if(act==="del") deleteInvoice(id);
    });
  });
}

function deleteInvoice(id){
  const inv = DB.invoices.find(x=>x.id===id);
  if(!inv) return;

  const body = document.createElement("div");
  body.innerHTML = `
    <div class="muted">¿Seguro que quieres borrar esta factura?</div>
    <div style="margin-top:10px" class="item">
      <div>
        <div class="name">${escapeHtml(inv.number||"")}</div>
        <div class="sub">${escapeHtml(inv.clientNameCache||"")} · ${escapeHtml(inv.tag||"")}</div>
      </div>
      <div class="badge bad">${money(inv.amount||0)}</div>
    </div>
  `;

  const foot = document.createElement("div");
  foot.className = "row";
  const cancel = document.createElement("button");
  cancel.className = "btn ghost";
  cancel.textContent = "Cancelar";
  cancel.onclick = closeModal;

  const ok = document.createElement("button");
  ok.className = "btn danger";
  ok.textContent = "Borrar";
  ok.onclick = ()=>{
    DB.invoices = DB.invoices.filter(x=>x.id!==id);
    saveLocal();
    closeModal();
    renderAll();
  };

  foot.appendChild(cancel);
  foot.appendChild(ok);

  openModal("Borrar factura", body, foot);
}

/* ---------------------------
   INVOICE MODAL
--------------------------- */
function openInvoiceModal(editId=null){
  const isEdit = !!editId;
  const inv = isEdit ? DB.invoices.find(x=>x.id===editId) : null;

  const body = document.createElement("div");
  body.className = "formGrid";

  const date = mkInput("Fecha", "date", inv?.dateISO || toISODate(new Date()));
  const number = mkInput("Nº factura", "text", inv?.number || "");
  const client = mkSelect("Cliente", DB.clients.map(c=>({value:c.id,label:c.name})), inv?.clientId || (DB.clients[0]?.id || ""));
  const tag = mkSelect("Tag", getTagsForClient(client.value), inv?.tag || "");
  const amount = mkInput("Importe (€)", "number", inv?.amount ?? "");
  amount.input.step = "0.01";
  const status = mkSelect("Estado", [
    {value:"Pendiente",label:"Pendiente"},
    {value:"Girada",label:"Girada"},
    {value:"Cobrada",label:"Cobrada"},
  ], inv?.status || "Pendiente");
  const notes = mkTextArea("Observaciones", inv?.notes || "");
  notes.wrap.classList.add("full");

  body.append(
    date.wrap, number.wrap,
    client.wrap, tag.wrap,
    amount.wrap, status.wrap,
    notes.wrap
  );

  // al cambiar cliente, actualiza tags
  client.select.addEventListener("change", ()=>{
    const opts = getTagsForClient(client.value);
    tag.select.innerHTML = "";
    for(const o of opts){
      const el = document.createElement("option");
      el.value = o.value;
      el.textContent = o.label;
      tag.select.appendChild(el);
    }
    // si no hay tags
    if(opts.length===0){
      const el = document.createElement("option");
      el.value = "";
      el.textContent = "(sin tags)";
      tag.select.appendChild(el);
    }
  });

  const foot = document.createElement("div");
  foot.className = "row";

  const cancel = document.createElement("button");
  cancel.className = "btn ghost";
  cancel.textContent = "Cancelar";
  cancel.onclick = closeModal;

  const save = document.createElement("button");
  save.className = "btn";
  save.textContent = isEdit ? "Guardar" : "Crear";

  save.onclick = ()=>{
    const dateISO = safeText(date.input.value);
    const num = safeText(number.input.value);
    const clientId = client.select.value;
    const tagVal = safeText(tag.select.value);
    const amt = Number(amount.input.value || 0);
    const st = status.select.value;
    const nt = safeText(notes.textarea.value);

    if(!dateISO || !num || !clientId){
      alert("Completa fecha, nº factura y cliente.");
      return;
    }
    if(!(amt >= 0)){
      alert("Importe inválido.");
      return;
    }

    if(isEdit){
      inv.dateISO = dateISO;
      inv.number = num;
      inv.clientId = clientId;
      inv.tag = tagVal;
      inv.amount = amt;
      inv.status = st;
      inv.notes = nt;
      normalizeInvoice(inv);
    }else{
      const c = getClientById(clientId);
      const newInv = normalizeInvoice({
        id: "inv_" + uid(),
        dateISO,
        number: num,
        clientId,
        clientNameCache: c ? c.name : "",
        tag: tagVal,
        amount: amt,
        status: st,
        notes: nt,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      DB.invoices.push(newInv);
    }

    saveLocal();
    closeModal();
    renderAll();
  };

  foot.append(cancel, save);

  openModal(isEdit ? "Editar factura" : "Nueva factura", body, foot);
}

/* ---------------------------
   MESSAGE MODAL (WHATSAPP)
--------------------------- */
function openMessageModal(invId){
  const inv = DB.invoices.find(x=>x.id===invId);
  if(!inv) return;

  const c = getClientById(inv.clientId);
  const cliente = c?.name || inv.clientNameCache || "";
  const phone = safeText(c?.phone || "");

  const tpl = DB.settings.whatsappTemplate || "";
  const text = tpl
    .replaceAll("{cliente}", cliente)
    .replaceAll("{numero}", inv.number || "")
    .replaceAll("{fecha}", inv.dateISO || "")
    .replaceAll("{tag}", inv.tag || "")
    .replaceAll("{importe}", money(inv.amount||0));

  const body = document.createElement("div");
  body.className = "formGrid";

  const phoneField = mkInput("Teléfono (opcional)", "text", phone);
  const msgField = mkTextArea("Mensaje", text);
  msgField.wrap.classList.add("full");

  const hint = document.createElement("div");
  hint.className = "muted full";
  hint.style.gridColumn = "1 / -1";
  hint.textContent = "Puedes copiar el texto o abrir WhatsApp (si hay teléfono).";

  body.append(phoneField.wrap, msgField.wrap, hint);

  const foot = document.createElement("div");
  foot.className = "row";

  const copy = document.createElement("button");
  copy.className = "btn ghost";
  copy.textContent = "Copiar";
  copy.onclick = async ()=>{
    try{
      await navigator.clipboard.writeText(msgField.textarea.value);
      copy.textContent = "Copiado ✅";
      setTimeout(()=>copy.textContent="Copiar", 900);
    }catch{
      alert("No se pudo copiar. Selecciona y copia manualmente.");
    }
  };

  const wa = document.createElement("button");
  wa.className = "btn";
  wa.textContent = "Abrir WhatsApp";
  wa.onclick = ()=>{
    const ph = safeText(phoneField.input.value).replace(/\s+/g,"");
    const msg = encodeURIComponent(msgField.textarea.value);
    if(!ph){
      alert("Añade teléfono para abrir WhatsApp, o usa Copiar.");
      return;
    }
    const url = `https://wa.me/${encodeURIComponent(ph)}?text=${msg}`;
    window.open(url, "_blank");
  };

  const close = document.createElement("button");
  close.className = "btn ghost";
  close.textContent = "Cerrar";
  close.onclick = closeModal;

  foot.append(close, copy, wa);

  openModal("Mensaje de factura", body, foot);
}

/* ---------------------------
   CLIENTS UI
--------------------------- */
const btnNewClient = $("#btnNewClient");
const clientSearch = $("#clientSearch");
const clientList = $("#clientList");
const clientDetail = $("#clientDetail");

let selectedClientId = null;

function renderClients(){
  const q = safeText(clientSearch.value).toLowerCase();
  const list = DB.clients
    .filter(c=> !q || c.name.toLowerCase().includes(q))
    .slice()
    .sort((a,b)=>a.name.localeCompare(b.name));

  clientList.innerHTML = "";
  if(list.length===0){
    const div = document.createElement("div");
    div.className="muted";
    div.textContent = "Sin clientes.";
    clientList.appendChild(div);
    clientDetail.textContent = "Selecciona un cliente…";
    return;
  }

  for(const c of list){
    const pending = DB.invoices
      .filter(i=>i.clientId===c.id && i.status==="Pendiente")
      .reduce((s,i)=>s+Number(i.amount||0),0);

    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div>
        <div class="name">${escapeHtml(c.name)}</div>
        <div class="sub">${(c.tags||[]).length} tag(s)</div>
      </div>
      <div class="badge bad">${money(pending)}</div>
    `;
    el.addEventListener("click", ()=>{
      selectedClientId = c.id;
      renderClientDetail();
    });
    clientList.appendChild(el);
  }

  // si no hay seleccionado, selecciona primero
  if(!selectedClientId && list[0]) selectedClientId = list[0].id;
  renderClientDetail();
}

function renderClientDetail(){
  const c = getClientById(selectedClientId);
  if(!c){
    clientDetail.textContent = "Selecciona un cliente…";
    return;
  }

  const pendingInv = DB.invoices.filter(i=>i.clientId===c.id && i.status==="Pendiente");
  const giradaInv = DB.invoices.filter(i=>i.clientId===c.id && i.status==="Girada");
  const paidInv = DB.invoices.filter(i=>i.clientId===c.id && i.status==="Cobrada");

  const sums = {
    pending: pendingInv.reduce((s,i)=>s+Number(i.amount||0),0),
    girada: giradaInv.reduce((s,i)=>s+Number(i.amount||0),0),
    paid: paidInv.reduce((s,i)=>s+Number(i.amount||0),0),
  };

  const wrap = document.createElement("div");
  wrap.className = "reportOut";

  const top = document.createElement("div");
  top.className = "item";
  top.innerHTML = `
    <div>
      <div class="name">${escapeHtml(c.name)}</div>
      <div class="sub">${escapeHtml(c.notes||"")}</div>
    </div>
    <div class="row">
      <span class="badge bad">Pend: ${money(sums.pending)}</span>
      <span class="badge warn">Girada: ${money(sums.girada)}</span>
      <span class="badge good">Cobrada: ${money(sums.paid)}</span>
    </div>
  `;

  const tagsBox = document.createElement("div");
  tagsBox.className = "card";
  tagsBox.style.boxShadow = "none";
  tagsBox.style.background = "rgba(255,255,255,.03)";
  tagsBox.style.borderColor = "rgba(255,255,255,.08)";

  const tagsTitle = document.createElement("div");
  tagsTitle.className = "cardHeader";
  tagsTitle.innerHTML = `<h3 style="margin:0;font-size:14px">Tags</h3>`;
  tagsBox.appendChild(tagsTitle);

  const tagList = document.createElement("div");
  tagList.className = "list";
  const tags = Array.isArray(c.tags) ? c.tags : [];
  if(tags.length===0){
    const m = document.createElement("div");
    m.className="muted";
    m.textContent="(Sin tags)";
    tagList.appendChild(m);
  }else{
    for(const t of tags){
      const it = document.createElement("div");
      it.className = "item";
      it.innerHTML = `
        <div>
          <div class="name">${escapeHtml(t)}</div>
          <div class="sub">Usable en facturas</div>
        </div>
        <button class="btn ghost danger" data-tag="${escapeHtmlAttr(t)}">Eliminar</button>
      `;
      it.querySelector("button").addEventListener("click",(e)=>{
        e.stopPropagation();
        removeClientTag(c.id, t);
      });
      tagList.appendChild(it);
    }
  }
  tagsBox.appendChild(tagList);

  const actions = document.createElement("div");
  actions.className = "row wrap";

  const edit = document.createElement("button");
  edit.className = "btn ghost";
  edit.textContent = "Editar cliente";
  edit.onclick = ()=>openClientModal(c.id);

  const addTag = document.createElement("button");
  addTag.className = "btn";
  addTag.textContent = "+ Añadir tag";
  addTag.onclick = ()=>openAddTagModal(c.id);

  const del = document.createElement("button");
  del.className = "btn danger";
  del.textContent = "Borrar cliente";
  del.onclick = ()=>deleteClient(c.id);

  actions.append(edit, addTag, del);

  wrap.append(top, actions, tagsBox);
  clientDetail.innerHTML = "";
  clientDetail.appendChild(wrap);
}

function removeClientTag(clientId, tag){
  const c = getClientById(clientId);
  if(!c) return;
  c.tags = (c.tags||[]).filter(t=>t!==tag);
  saveLocal();
  renderAll();
}

function deleteClient(clientId){
  const c = getClientById(clientId);
  if(!c) return;

  const used = DB.invoices.some(i=>i.clientId===clientId);
  const body = document.createElement("div");
  body.innerHTML = `
    <div class="muted">
      ${used ? "Este cliente tiene facturas asociadas. Si lo borras, las facturas conservarán el nombre cacheado, pero perderán el enlace al cliente." : "¿Seguro que quieres borrar este cliente?"}
    </div>
    <div style="margin-top:10px" class="item">
      <div>
        <div class="name">${escapeHtml(c.name)}</div>
        <div class="sub">${(c.tags||[]).length} tag(s)</div>
      </div>
    </div>
  `;

  const foot = document.createElement("div");
  foot.className = "row";

  const cancel = document.createElement("button");
  cancel.className="btn ghost";
  cancel.textContent="Cancelar";
  cancel.onclick=closeModal;

  const ok = document.createElement("button");
  ok.className="btn danger";
  ok.textContent="Borrar";
  ok.onclick=()=>{
    DB.clients = DB.clients.filter(x=>x.id!==clientId);
    // no borramos facturas; quedan con cache
    // si algún inv tenía clientId, lo dejamos (pero el nombre seguirá visible)
    if(selectedClientId===clientId) selectedClientId = DB.clients[0]?.id || null;
    saveLocal();
    closeModal();
    renderAll();
  };

  foot.append(cancel, ok);
  openModal("Borrar cliente", body, foot);
}

/* ---------------------------
   CLIENT MODAL
--------------------------- */
function openClientModal(editId=null){
  const isEdit = !!editId;
  const c = isEdit ? getClientById(editId) : null;

  const body = document.createElement("div");
  body.className = "formGrid";

  const name = mkInput("Nombre cliente", "text", c?.name || "");
  const phone = mkInput("Teléfono (WhatsApp opcional)", "text", c?.phone || "");
  const notes = mkTextArea("Notas", c?.notes || "");
  notes.wrap.classList.add("full");

  body.append(name.wrap, phone.wrap, notes.wrap);

  const foot = document.createElement("div");
  foot.className = "row";

  const cancel = document.createElement("button");
  cancel.className="btn ghost";
  cancel.textContent="Cancelar";
  cancel.onclick=closeModal;

  const save = document.createElement("button");
  save.className="btn";
  save.textContent = isEdit ? "Guardar" : "Crear";

  save.onclick=()=>{
    const nm = safeText(name.input.value);
    const ph = safeText(phone.input.value);
    const nt = safeText(notes.textarea.value);

    if(!nm){
      alert("El nombre es obligatorio.");
      return;
    }

    if(isEdit){
      c.name = nm;
      c.phone = ph;
      c.notes = nt;

      // actualiza cache en facturas
      for(const inv of DB.invoices){
        if(inv.clientId===c.id){
          inv.clientNameCache = nm;
        }
      }
    }else{
      const newC = {
        id: "cli_" + uid(),
        name: nm,
        phone: ph,
        notes: nt,
        tags: [nm], // por defecto crea un tag igual al nombre
      };
      DB.clients.push(newC);
      selectedClientId = newC.id;
    }

    saveLocal();
    closeModal();
    renderAll();
  };

  foot.append(cancel, save);
  openModal(isEdit ? "Editar cliente" : "Nuevo cliente", body, foot);
}

function openAddTagModal(clientId){
  const c = getClientById(clientId);
  if(!c) return;

  const body = document.createElement("div");
  body.className = "formGrid";
  const t = mkInput("Nuevo tag", "text", "");
  t.wrap.classList.add("full");
  body.append(t.wrap);

  const foot = document.createElement("div");
  foot.className="row";
  const cancel = document.createElement("button");
  cancel.className="btn ghost";
  cancel.textContent="Cancelar";
  cancel.onclick=closeModal;

  const add = document.createElement("button");
  add.className="btn";
  add.textContent="Añadir";
  add.onclick=()=>{
    const tag = safeText(t.input.value);
    if(!tag) return;
    c.tags = Array.isArray(c.tags) ? c.tags : [];
    if(!c.tags.includes(tag)) c.tags.push(tag);
    saveLocal();
    closeModal();
    renderAll();
  };

  foot.append(cancel, add);
  openModal("Añadir tag", body, foot);
}

/* ---------------------------
   TAGS FOR CLIENT
--------------------------- */
function getTagsForClient(clientId){
  const c = getClientById(clientId);
  const tags = Array.isArray(c?.tags) ? c.tags : [];
  return tags.map(t=>({value:t, label:t}));
}

/* ---------------------------
   REPORTS
--------------------------- */
const repMode = $("#repMode");
const repFrom = $("#repFrom");
const repTo = $("#repTo");
const repClient = $("#repClient");
const repRun = $("#repRun");
const repOut = $("#repOut");

function runReports(){
  repOut.innerHTML = "";

  const mode = repMode.value;
  const clientId = repClient.value || "all";

  // rango
  let fromISO = repFrom.value || "";
  let toISO = repTo.value || "";
  ({fromISO, toISO} = clampDateRange(fromISO, toISO));

  // si no hay rango y mode no custom, ponemos defaults
  const now = new Date();
  if(!fromISO && !toISO){
    if(mode==="weekly"){
      fromISO = toISODate(startOfWeek(now));
      toISO = toISODate(endOfWeek(now));
    }else if(mode==="monthly"){
      fromISO = toISODate(startOfMonth(now));
      toISO = toISODate(endOfMonth(now));
    }
    repFrom.value = fromISO;
    repTo.value = toISO;
  }

  const invs = getInvoicesFiltered({
    q:"",
    clientId,
    status:"all",
    fromISO,
    toISO
  });

  if(invs.length===0){
    const m = document.createElement("div");
    m.className="muted";
    m.textContent="No hay facturas en ese periodo.";
    repOut.appendChild(m);
    return;
  }

  // agrupación
  if(mode==="weekly"){
    renderGroupedByWeek(invs);
  }else if(mode==="monthly"){
    renderGroupedByMonth(invs);
  }else{
    renderCustomSummary(invs, fromISO, toISO);
  }
}

function renderCustomSummary(invs, fromISO, toISO){
  const sums = sumByStatus(invs);
  const box = document.createElement("div");
  box.className="item";
  box.innerHTML = `
    <div>
      <div class="name">Resumen ${escapeHtml(fromISO||"")} → ${escapeHtml(toISO||"")}</div>
      <div class="sub">${invs.length} factura(s)</div>
    </div>
    <div class="row wrap">
      <span class="badge bad">Pend: ${money(sums.Pendiente)}</span>
      <span class="badge warn">Girada: ${money(sums.Girada)}</span>
      <span class="badge good">Cobrada: ${money(sums.Cobrada)}</span>
      <span class="badge">Total: ${money(sums.all)}</span>
    </div>
  `;
  repOut.appendChild(box);

  // Top pendientes por tag
  const tagMap = new Map();
  for(const inv of invs){
    if(inv.status!=="Pendiente") continue;
    const k = inv.tag || "(sin tag)";
    tagMap.set(k, (tagMap.get(k)||0) + Number(inv.amount||0));
  }
  const top = Array.from(tagMap.entries()).sort((a,b)=>b[1]-a[1]).slice(0,8);
  if(top.length){
    const tbox = document.createElement("div");
    tbox.className="card";
    tbox.style.boxShadow="none";
    tbox.style.background="rgba(255,255,255,.03)";
    tbox.style.borderColor="rgba(255,255,255,.08)";
    tbox.innerHTML = `<div class="cardHeader"><h3 style="margin:0;font-size:14px">Pendiente por tag (top)</h3></div>`;
    const list = document.createElement("div");
    list.className="list";
    for(const [tag,val] of top){
      const it = document.createElement("div");
      it.className="item";
      it.innerHTML = `<div><div class="name">${escapeHtml(tag)}</div></div><div class="badge bad">${money(val)}</div>`;
      list.appendChild(it);
    }
    tbox.appendChild(list);
    repOut.appendChild(tbox);
  }
}

function renderGroupedByWeek(invs){
  // key: yyyy-wXX (usamos lunes como inicio)
  const map = new Map();
  for(const inv of invs){
    const d = parseISODate(inv.dateISO);
    if(!d) continue;
    const s = startOfWeek(d);
    const e = endOfWeek(d);
    const key = `${toISODate(s)}__${toISODate(e)}`;
    if(!map.has(key)) map.set(key, []);
    map.get(key).push(inv);
  }
  const keys = Array.from(map.keys()).sort((a,b)=> b.localeCompare(a)); // desc
  for(const k of keys){
    const [sISO,eISO] = k.split("__");
    const list = map.get(k);
    const sums = sumByStatus(list);
    const box = document.createElement("div");
    box.className="item";
    box.innerHTML = `
      <div>
        <div class="name">Semana ${escapeHtml(sISO)} → ${escapeHtml(eISO)}</div>
        <div class="sub">${list.length} factura(s)</div>
      </div>
      <div class="row wrap">
        <span class="badge bad">Pend: ${money(sums.Pendiente)}</span>
        <span class="badge warn">Girada: ${money(sums.Girada)}</span>
        <span class="badge good">Cobrada: ${money(sums.Cobrada)}</span>
        <span class="badge">Total: ${money(sums.all)}</span>
      </div>
    `;
    repOut.appendChild(box);
  }
}

function renderGroupedByMonth(invs){
  const map = new Map(); // yyyy-mm
  for(const inv of invs){
    const d = parseISODate(inv.dateISO);
    if(!d) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    if(!map.has(key)) map.set(key, []);
    map.get(key).push(inv);
  }
  const keys = Array.from(map.keys()).sort((a,b)=> b.localeCompare(a));
  for(const k of keys){
    const list = map.get(k);
    const sums = sumByStatus(list);
    const box = document.createElement("div");
    box.className="item";
    box.innerHTML = `
      <div>
        <div class="name">Mes ${escapeHtml(k)}</div>
        <div class="sub">${list.length} factura(s)</div>
      </div>
      <div class="row wrap">
        <span class="badge bad">Pend: ${money(sums.Pendiente)}</span>
        <span class="badge warn">Girada: ${money(sums.Girada)}</span>
        <span class="badge good">Cobrada: ${money(sums.Cobrada)}</span>
        <span class="badge">Total: ${money(sums.all)}</span>
      </div>
    `;
    repOut.appendChild(box);
  }
}

/* ---------------------------
   EXPORT / IMPORT / RESET
--------------------------- */
const btnExport = $("#btnExport");
const fileImport = $("#fileImport");
const btnClearLocal = $("#btnClearLocal");

function doExport(){
  const payload = DB;
  const stamp = new Date();
  const fn = `facturas_backup_${toISODate(stamp)}.json`;
  downloadJSON(payload, fn);
}

async function doImport(file){
  const txt = await readFileAsText(file);
  const obj = JSON.parse(txt);

  if(!obj || typeof obj !== "object") throw new Error("Archivo inválido");
  if(!Array.isArray(obj.clients) || !Array.isArray(obj.invoices)) throw new Error("Estructura inválida");

  // aplica
  DB = obj;
  if(!DB.settings) DB.settings = structuredClone(DEFAULT_DATA.settings);
  if(!DB.meta) DB.meta = { updatedAt: Date.now() };
  saveLocal();
  renderAll();
}

function resetLocal(){
  const body = document.createElement("div");
  body.innerHTML = `<div class="muted">Esto borra el almacenamiento local y restaura datos iniciales. La nube (si está activa) puede volver a sincronizar datos luego.</div>`;
  const foot = document.createElement("div");
  foot.className="row";
  const cancel = document.createElement("button");
  cancel.className="btn ghost";
  cancel.textContent="Cancelar";
  cancel.onclick=closeModal;

  const ok = document.createElement("button");
  ok.className="btn danger";
  ok.textContent="Reset";
  ok.onclick=()=>{
    localStorage.removeItem(K.DATA);
    DB = loadLocal();
    closeModal();
    renderAll();
  };
  foot.append(cancel, ok);
  openModal("Reset local", body, foot);
}

/* ---------------------------
   DOM HELPERS (inputs)
--------------------------- */
function mkInput(label, type, value){
  const wrap = document.createElement("div");
  const l = document.createElement("div");
  l.className="muted";
  l.textContent=label;
  const input = document.createElement("input");
  input.className="input";
  input.type=type;
  input.value = value ?? "";
  wrap.append(l,input);
  return { wrap, input };
}

function mkSelect(label, options, value){
  const wrap = document.createElement("div");
  const l = document.createElement("div");
  l.className="muted";
  l.textContent=label;
  const select = document.createElement("select");
  select.className="input";
  for(const o of options){
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    select.appendChild(opt);
  }
  // fallback si no hay opciones
  if(options.length===0){
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(sin opciones)";
    select.appendChild(opt);
  }
  if(value !== undefined && value !== null){
    select.value = value;
    // si no existe, deja el primero
  }
  wrap.append(l,select);
  return { wrap, select, value: select.value };
}

function mkTextArea(label, value){
  const wrap = document.createElement("div");
  const l = document.createElement("div");
  l.className="muted";
  l.textContent=label;
  const textarea = document.createElement("textarea");
  textarea.className="input";
  textarea.value = value ?? "";
  wrap.append(l,textarea);
  return { wrap, textarea };
}

// escape básico
function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function escapeHtmlAttr(s){ return escapeHtml(s).replaceAll("\n"," "); }

/* ---------------------------
   MAIN RENDER
--------------------------- */
function renderAll(){
  renderClientSelects();
  renderKPIs();
  renderPendingByClient();
  renderDashSummary();
  renderInvoices();
  renderClients();
}

/* ---------------------------
   EVENTS
--------------------------- */
function bindEvents(){
  // PIN
  pinBtn?.addEventListener("click", checkPin);
  pinInput?.addEventListener("keydown",(e)=>{
    if(e.key==="Enter") checkPin();
  });

  btnLock?.addEventListener("click", lock);

  // NAV
  $$(".navItem[data-tab]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      showTab(btn.dataset.tab);
    });
  });

  // Dashboard
  dashSearchClient?.addEventListener("input", renderPendingByClient);
  dashApply?.addEventListener("click", renderDashSummary);
  dashPeriod?.addEventListener("change", ()=>{
    const isCustom = dashPeriod.value==="custom";
    dashFrom.disabled = !isCustom;
    dashTo.disabled = !isCustom;
    renderDashSummary();
  });

  // Invoices filters
  const rerInv = ()=>renderInvoices();
  invSearch?.addEventListener("input", rerInv);
  invClientFilter?.addEventListener("change", rerInv);
  invStatusFilter?.addEventListener("change", rerInv);
  invFrom?.addEventListener("change", rerInv);
  invTo?.addEventListener("change", rerInv);

  invClearFilters?.addEventListener("click", ()=>{
    invSearch.value = "";
    invClientFilter.value = "all";
    invStatusFilter.value = "all";
    invFrom.value = "";
    invTo.value = "";
    renderInvoices();
  });

  btnNewInvoice?.addEventListener("click", ()=>openInvoiceModal(null));

  // Clients
  btnNewClient?.addEventListener("click", ()=>openClientModal(null));
  clientSearch?.addEventListener("input", renderClients);

  // Reports
  repRun?.addEventListener("click", runReports);
  repMode?.addEventListener("change", ()=>{
    // ayuda de defaults
    const now = new Date();
    if(repMode.value==="weekly"){
      repFrom.value = toISODate(startOfWeek(now));
      repTo.value = toISODate(endOfWeek(now));
    }else if(repMode.value==="monthly"){
      repFrom.value = toISODate(startOfMonth(now));
      repTo.value = toISODate(endOfMonth(now));
    }
  });

  // Export / Import / Reset
  btnExport?.addEventListener("click", doExport);
  fileImport?.addEventListener("change", async ()=>{
    const f = fileImport.files?.[0];
    if(!f) return;
    try{
      await doImport(f);
      alert("Importado ✅");
    }catch(e){
      alert("Error importando: " + (e?.message || "archivo inválido"));
    }finally{
      fileImport.value = "";
    }
  });
  btnClearLocal?.addEventListener("click", resetLocal);
}

/* ---------------------------
   INIT
--------------------------- */
(function init(){
  bindEvents();

  // PIN state
  if(isPinOk()){
    unlock();
    renderAll();
  }else{
    lock();
  }

  // Default dates
  const now = new Date();
  dashFrom.value = toISODate(startOfWeek(now));
  dashTo.value = toISODate(endOfWeek(now));
  dashFrom.disabled = true;
  dashTo.disabled = true;

  repFrom.value = toISODate(startOfWeek(now));
  repTo.value = toISODate(endOfWeek(now));

  // Cloud
  initCloud();
})();

