/* =========================================================
   ARSLAN PRO • Facturas & Contabilidad (FULL)
   - Usuarios + PIN distinto por persona (ADMIN 7392)
   - Clientes + tags por cliente (Braseros Centro/Severo/Edificio/Tomillares)
   - Facturas: fecha, nº, importe, estado (Pendiente/Girada/Cobrada), tag, notas
   - Resúmenes por semanas/meses/totales y por periodos
   - PDF PRO: pendientes / giradas / cobradas (global y por cliente)
   - Charts avanzados: por tag + tendencia (3 estados)
   - Firebase Email/Password + Realtime Database (sync total)
   - Modo día por defecto / noche opcional
========================================================= */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------------------------
   Utils
--------------------------- */
const money = (n) => {
  const x = Number(n || 0);
  return x.toLocaleString("es-ES", { style:"currency", currency:"EUR" });
};

const uid = () => Math.random().toString(16).slice(2) + Date.now().toString(16);

function toISODate(d){
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseISODate(s){
  if(!s) return null;
  const [y,m,d] = s.split("-").map(Number);
  if(!y||!m||!d) return null;
  return new Date(y, m-1, d);
}

function startOfWeek(date){
  const d = new Date(date);
  const day = (d.getDay()+6)%7;
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

function clampDateRange(fromISO, toISO){
  const from = parseISODate(fromISO);
  const to = parseISODate(toISO);
  if(from && to && from > to){
    return { fromISO: toISO, toISO: fromISO };
  }
  return { fromISO, toISO };
}

function safeText(s){ return String(s ?? "").trim(); }

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

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
   SHA-256 (PIN)
--------------------------- */
async function sha256Hex(text){
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const arr = Array.from(new Uint8Array(buf));
  return arr.map(b=>b.toString(16).padStart(2,"0")).join("");
}

/* ---------------------------
   Storage Keys
--------------------------- */
const K = {
  SESSION_OK: "ARSLAN_SESSION_OK_FULL",
  SESSION_USER: "ARSLAN_SESSION_USER_FULL",
  USERS: "ARSLAN_USERS_FULL",
  THEME: "ARSLAN_THEME_FULL",
  DATA_PREFIX: "ARSLAN_FACTURAS_DATA_FULL__",
  CLOUD_EMAIL_LAST: "ARSLAN_CLOUD_EMAIL_LAST_FULL"
};

const DEFAULT_ADMIN_NAME = "ADMIN";
const DEFAULT_ADMIN_PIN = "7392";

/* ---------------------------
   Users internal
--------------------------- */
let USERS = [];
let ACTIVE_USER_ID = null;
let ACTIVE_USER_NAME = "";

/* ---------------------------
   Default Data
--------------------------- */
function makeDefaultData(){
  return {
    version: 1,
    clients: [
      { id: "cli_riviera", name: "RIVIERA", phone: "", tags: ["RIVIERA"], notes:"" },
      { id: "cli_braseros", name: "RESTAURACION HERMANOS MARIJUÁN (BRASEROS)", phone: "", tags: [
        "BRASEROS CENTRO","BRASEROS SEVERO","BRASEROS EDIFICIO","BRASEROS TOMILLARES"
      ], notes:"" },
    ],
    invoices: [],
    settings: {
      whatsappTemplatePaid:
`Hola {cliente},
✅ Confirmación de cobro
Factura: {numero}
Fecha: {fecha}
Tag: {tag}
Importe: {importe}

Gracias.`,
      whatsappTemplatePending:
`Hola {cliente},
Recordatorio:
Factura pendiente: {numero}
Fecha: {fecha}
Tag: {tag}
Importe: {importe}

Gracias.`,
    },
    meta: { updatedAt: Date.now() }
  };
}

/* ---------------------------
   Load/Save Users
--------------------------- */
function loadUsersRaw(){
  const raw = localStorage.getItem(K.USERS);
  if(!raw) return null;
  try{
    const u = JSON.parse(raw);
    if(!Array.isArray(u)) return null;
    return u;
  }catch{
    return null;
  }
}

function saveUsers(){
  localStorage.setItem(K.USERS, JSON.stringify(USERS));
}

async function ensureUsers(){
  const loaded = loadUsersRaw();
  if(loaded && loaded.length){
    USERS = loaded;
    return;
  }
  const adminHash = await sha256Hex(DEFAULT_ADMIN_PIN);
  USERS = [{
    id: "usr_admin",
    name: DEFAULT_ADMIN_NAME,
    pinHash: adminHash,
    createdAt: Date.now()
  }];
  saveUsers();
}

/* ---------------------------
   DB per user internal
--------------------------- */
let DB = null;

function keyForUserData(userId){
  return K.DATA_PREFIX + userId;
}

function loadLocalDB(userId){
  const raw = localStorage.getItem(keyForUserData(userId));
  if(!raw){
    const d = makeDefaultData();
    d.meta.updatedAt = Date.now();
    localStorage.setItem(keyForUserData(userId), JSON.stringify(d));
    return d;
  }
  try{
    const d = JSON.parse(raw);
    if(!d || typeof d !== "object") throw new Error("bad");
    if(!Array.isArray(d.clients)) d.clients = [];
    if(!Array.isArray(d.invoices)) d.invoices = [];
    if(!d.settings) d.settings = makeDefaultData().settings;
    if(!d.meta) d.meta = { updatedAt: Date.now() };
    return d;
  }catch{
    const d = makeDefaultData();
    d.meta.updatedAt = Date.now();
    localStorage.setItem(keyForUserData(userId), JSON.stringify(d));
    return d;
  }
}

function saveLocalDB(skipCloud=false){
  if(!ACTIVE_USER_ID) return;
  DB.meta.updatedAt = Date.now();
  localStorage.setItem(keyForUserData(ACTIVE_USER_ID), JSON.stringify(DB));
  if(!skipCloud) pushCloud();
}

/* =========================================================
   THEME (día por defecto)
========================================================= */
const btnTheme = $("#btnTheme");

function getTheme(){
  return localStorage.getItem(K.THEME) || "light";
}

function applyTheme(theme){
  const isLight = theme === "light";
  document.body.classList.toggle("light", isLight);
  if(btnTheme) btnTheme.textContent = isLight ? "☀️" : "🌙";
  localStorage.setItem(K.THEME, theme);
  setTimeout(()=>updateCharts(), 50);
}

function toggleTheme(){
  const t = getTheme();
  applyTheme(t === "light" ? "dark" : "light");
}

/* =========================================================
   CLOUD (Firebase Email/Password + Realtime DB)
========================================================= */
const cloudStatus = $("#cloudStatus");
const cloudEmail = $("#cloudEmail");
const cloudPass = $("#cloudPass");
const btnCloudLogin = $("#btnCloudLogin");
const btnCloudRegister = $("#btnCloudRegister");
const btnCloudLogout = $("#btnCloudLogout");
const cloudUidLabel = $("#cloudUidLabel");

function setCloudStatus(type, text){
  if(!cloudStatus) return;
  cloudStatus.className = "cloud-pill " + type;
  cloudStatus.textContent = text;
}

let FIREBASE_READY = false;
let CLOUD_READY = false;
let CLOUD_UID = null;
let CLOUD_REF = null;
let CLOUD_LOCK = false;

function getFirebase(){
  if(!window.__FIREBASE_CONFIG) return null;
  try{
    if(!firebase.apps || firebase.apps.length === 0){
      firebase.initializeApp(window.__FIREBASE_CONFIG);
    }
    return {
      auth: firebase.auth(),
      db: firebase.database()
    };
  }catch(e){
    console.error("Firebase init error:", e);
    return null;
  }
}

function buildCloudRef(db){
  return db.ref("arslan_facturas_full/" + CLOUD_UID + "/users/" + ACTIVE_USER_ID + "/data");
}

function attachCloudForActiveUser(db){
  if(!CLOUD_READY || !ACTIVE_USER_ID) return;

  CLOUD_REF = buildCloudRef(db);

  try{ CLOUD_REF.off(); }catch{}

  CLOUD_REF.on("value", snap=>{
    const remote = snap.val();
    if(!remote) return;

    const remoteUpdated = Number(remote?.meta?.updatedAt || 0);
    const localUpdated = Number(DB?.meta?.updatedAt || 0);

    if(remoteUpdated > localUpdated){
      CLOUD_LOCK = true;
      DB = remote;
      saveLocalDB(true);
      renderAll();
      CLOUD_LOCK = false;
    }
  });

  CLOUD_REF.get().then(snap=>{
    const remote = snap.val();
    if(!remote){
      pushCloud();
    }else{
      const remoteUpdated = Number(remote?.meta?.updatedAt || 0);
      const localUpdated = Number(DB?.meta?.updatedAt || 0);
      if(localUpdated > remoteUpdated){
        pushCloud();
      }else if(remoteUpdated > localUpdated){
        CLOUD_LOCK = true;
        DB = remote;
        saveLocalDB(true);
        renderAll();
        CLOUD_LOCK = false;
      }
    }
  }).catch((e)=>{
    console.error("Cloud get error:", e);
  });
}

function pushCloud(){
  if(!CLOUD_READY || !CLOUD_REF) return;
  if(CLOUD_LOCK) return;
  try{
    CLOUD_REF.set(DB);
  }catch(e){
    console.error("Cloud push error:", e);
  }
}

function initCloud(){
  const fb = getFirebase();
  if(!fb){
    setCloudStatus("bad","☁️ Nube: no configurada");
    FIREBASE_READY = false;
    CLOUD_READY = false;
    CLOUD_UID = null;
    if(cloudUidLabel) cloudUidLabel.textContent = "—";
    return;
  }

  FIREBASE_READY = true;
  setCloudStatus("warn","☁️ Nube: sin sesión");

  fb.auth.onAuthStateChanged(user=>{
    if(!user){
      CLOUD_READY = false;
      CLOUD_UID = null;
      CLOUD_REF = null;
      setCloudStatus("warn","☁️ Nube: sin sesión");
      if(cloudUidLabel) cloudUidLabel.textContent = "—";
      return;
    }

    CLOUD_UID = user.uid;
    CLOUD_READY = true;
    setCloudStatus("ok","☁️ Nube online");
    if(cloudUidLabel) cloudUidLabel.textContent = CLOUD_UID;

    if(ACTIVE_USER_ID && DB){
      attachCloudForActiveUser(fb.db);
      pushCloud();
    }
  });
}

async function cloudLogin(){
  const fb = getFirebase();
  if(!fb){
    alert("Falta configurar Firebase (window.__FIREBASE_CONFIG).");
    return;
  }
  const email = safeText(cloudEmail?.value || "");
  const pass = safeText(cloudPass?.value || "");
  if(!email || !pass){
    alert("Introduce email y password.");
    return;
  }
  setCloudStatus("warn","☁️ Entrando…");
  try{
    await fb.auth.signInWithEmailAndPassword(email, pass);
    localStorage.setItem(K.CLOUD_EMAIL_LAST, email);
    if(cloudPass) cloudPass.value = "";
  }catch(e){
    const code = e?.code || "sin-codigo";
    setCloudStatus("bad", `☁️ Error login: ${code}`);
    console.error("Firebase login error:", e);
    alert(`Error login:\n${code}\n${e?.message || ""}`);
  }
}

async function cloudRegister(){
  const fb = getFirebase();
  if(!fb){
    alert("Falta configurar Firebase (window.__FIREBASE_CONFIG).");
    return;
  }
  const email = safeText(cloudEmail?.value || "");
  const pass = safeText(cloudPass?.value || "");
  if(!email || !pass){
    alert("Introduce email y password.");
    return;
  }
  setCloudStatus("warn","☁️ Creando…");
  try{
    await fb.auth.createUserWithEmailAndPassword(email, pass);
    localStorage.setItem(K.CLOUD_EMAIL_LAST, email);
    if(cloudPass) cloudPass.value = "";
  }catch(e){
    const code = e?.code || "sin-codigo";
    setCloudStatus("bad", `☁️ Error registro: ${code}`);
    console.error("Firebase register error:", e);
    alert(`Error registro:\n${code}\n${e?.message || ""}`);
  }
}

async function cloudLogout(){
  const fb = getFirebase();
  if(!fb){
    alert("Firebase no configurado.");
    return;
  }
  setCloudStatus("warn","☁️ Saliendo…");
  try{
    await fb.auth.signOut();
  }catch(e){
    console.error("Logout error:", e);
    alert("Error logout: " + (e?.message || "desconocido"));
  }
}

/* =========================================================
   SESSION / PIN
========================================================= */
const pinGate = $("#pinGate");
const app = $("#app");
const userSelect = $("#userSelect");
const pinInput = $("#pinInput");
const pinBtn = $("#pinBtn");
const pinMsg = $("#pinMsg");
const btnLock = $("#btnLock");

const activeUserLabel = $("#activeUserLabel");
const activeUserLabel2 = $("#activeUserLabel2");

function isSessionOk(){ return localStorage.getItem(K.SESSION_OK) === "1"; }
function setSessionOk(v){ localStorage.setItem(K.SESSION_OK, v ? "1" : "0"); }

function getSessionUser(){ return localStorage.getItem(K.SESSION_USER) || ""; }
function setSessionUser(id){ localStorage.setItem(K.SESSION_USER, id || ""); }

function renderUserSelect(){
  if(!userSelect) return;
  userSelect.innerHTML = "";
  const list = USERS.slice().sort((a,b)=>a.name.localeCompare(b.name));
  for(const u of list){
    const o = document.createElement("option");
    o.value = u.id;
    o.textContent = u.name;
    userSelect.appendChild(o);
  }
  const remembered = getSessionUser();
  const exists = list.some(u=>u.id===remembered);
  userSelect.value = exists ? remembered : (list[0]?.id || "");
}

function lock(){
  setSessionOk(false);
  app.classList.add("hidden");
  pinGate.classList.remove("hidden");
  if(pinInput) pinInput.value = "";
  if(pinMsg) pinMsg.textContent = "";
  renderUserSelect();
  userSelect?.focus();
}

function unlock(){
  setSessionOk(true);
  pinGate.classList.add("hidden");
  app.classList.remove("hidden");
  if(pinMsg) pinMsg.textContent = "";
}

async function checkPin(){
  const uId = userSelect?.value || "";
  const u = USERS.find(x=>x.id===uId);
  if(!u){
    if(pinMsg) pinMsg.textContent = "Usuario inválido";
    return;
  }
  const entered = safeText(pinInput?.value || "");
  if(!entered){
    if(pinMsg) pinMsg.textContent = "Introduce el PIN";
    return;
  }

  const enteredHash = await sha256Hex(entered);
  if(enteredHash === u.pinHash){
    ACTIVE_USER_ID = u.id;
    ACTIVE_USER_NAME = u.name;

    setSessionUser(u.id);
    unlock();

    DB = loadLocalDB(ACTIVE_USER_ID);

    const fb = getFirebase();
    if(fb && fb.auth.currentUser){
      CLOUD_UID = fb.auth.currentUser.uid;
      CLOUD_READY = true;
      setCloudStatus("ok","☁️ Nube online");
      if(cloudUidLabel) cloudUidLabel.textContent = CLOUD_UID;
      attachCloudForActiveUser(fb.db);
      pushCloud();
    }else{
      if(FIREBASE_READY) setCloudStatus("warn","☁️ Nube: sin sesión");
    }

    renderAll();
  }else{
    if(pinMsg) pinMsg.textContent = "PIN incorrecto";
  }
}

/* =========================================================
   NAV / TABS
========================================================= */
const tabs = {
  dashboard: $("#tab-dashboard"),
  invoices: $("#tab-invoices"),
  clients: $("#tab-clients"),
  reports: $("#tab-reports"),
  users: $("#tab-users"),
};

function showTab(key){
  $$(".navItem").forEach(b=>b.classList.remove("active"));
  const btn = $(`.navItem[data-tab="${key}"]`);
  if(btn) btn.classList.add("active");
  Object.keys(tabs).forEach(k=>{
    tabs[k]?.classList.toggle("hidden", k!==key);
  });
  if(key==="reports"){
    setTimeout(()=>updateCharts(), 50);
  }
}

/* =========================================================
   MODAL
========================================================= */
const modal = $("#modal");
const modalTitle = $("#modalTitle");
const modalBody = $("#modalBody");
const modalFooter = $("#modalFooter");
const modalClose = $("#modalClose");

function openModal(title, bodyNode, footerNode){
  if(modalTitle) modalTitle.textContent = title;
  if(modalBody){
    modalBody.innerHTML = "";
    modalBody.appendChild(bodyNode);
  }
  if(modalFooter){
    modalFooter.innerHTML = "";
    if(footerNode) modalFooter.appendChild(footerNode);
  }
  modal?.classList.remove("hidden");
}

function closeModal(){ modal?.classList.add("hidden"); }

modalClose?.addEventListener("click", closeModal);
modal?.addEventListener("click", (e)=>{ if(e.target === modal) closeModal(); });

/* =========================================================
   DATA HELPERS
========================================================= */
function getClientById(id){
  return DB.clients.find(c=>c.id===id) || null;
}

function normalizeInvoice(inv){
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
    const da = parseISODate(a.dateISO)?.getTime() || 0;
    const db = parseISODate(b.dateISO)?.getTime() || 0;
    if(db!==da) return db-da;
    return (b.updatedAt||0)-(a.updatedAt||0);
  });
}

function sumByStatus(invoices){
  const out = { Pendiente:0, Girada:0, Cobrada:0, all:0, count:0 };
  for(const inv of invoices){
    const amt = Number(inv.amount||0);
    out.all += amt;
    out.count += 1;
    if(inv.status==="Pendiente") out.Pendiente += amt;
    if(inv.status==="Girada") out.Girada += amt;
    if(inv.status==="Cobrada") out.Cobrada += amt;
  }
  return out;
}

function pendingByClient(search=""){
  const q = safeText(search).toLowerCase();
  const map = new Map();
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
    .filter(r=>r.pending>0 || q)
    .sort((a,b)=>b.pending-a.pending);
}

/* =========================================================
   PERIODS
========================================================= */
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
    from = new Date(now.getFullYear(),0,1); from.setHours(0,0,0,0);
    to = new Date(now.getFullYear(),11,31); to.setHours(23,59,59,999);
  }else if(sel==="all"){
    from = null; to = null;
  }

  return {
    fromISO: from ? toISODate(from) : "",
    toISO: to ? toISODate(to) : (sel==="all" ? "" : todayISO),
  };
}

/* =========================================================
   UI HELPERS
========================================================= */
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
  if(options.length===0){
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(sin opciones)";
    select.appendChild(opt);
  }
  if(value !== undefined && value !== null) select.value = value;
  wrap.append(l,select);
  return { wrap, select };
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

/* =========================================================
   TAGS POR CLIENTE
========================================================= */
function getTagsForClient(clientId){
  const c = getClientById(clientId);
  const tags = Array.isArray(c?.tags) ? c.tags : [];
  return tags.map(t=>({value:t, label:t}));
}

function fillTagSelect(tagSelect, clientId, preferValue=""){
  const opts = getTagsForClient(clientId);
  tagSelect.innerHTML = "";

  if(opts.length===0){
    const el = document.createElement("option");
    el.value = "";
    el.textContent = "(sin tags)";
    tagSelect.appendChild(el);
    return;
  }

  for(const o of opts){
    const el = document.createElement("option");
    el.value = o.value;
    el.textContent = o.label;
    tagSelect.appendChild(el);
  }

  const exists = opts.some(o=>o.value === preferValue);
  tagSelect.value = exists ? preferValue : opts[0].value;
}

/* =========================================================
   DASHBOARD
========================================================= */
const kpiPendingGlobal = $("#kpiPendingGlobal");
const kpiIssuedGlobal = $("#kpiIssuedGlobal");
const kpiPaidGlobal = $("#kpiPaidGlobal");
const kpiCountGlobal = $("#kpiCountGlobal");

const pendingByClientList = $("#pendingByClientList");
const dashSearchClient = $("#dashSearchClient");

const dashPeriod = $("#dashPeriod");
const dashFrom = $("#dashFrom");
const dashTo = $("#dashTo");
const dashApply = $("#dashApply");
const dashSummary = $("#dashSummary");

const btnPDFPendingGlobalDash = $("#btnPDFPendingGlobalDash");
const btnPDFIssuedGlobalDash = $("#btnPDFIssuedGlobalDash");
const btnPDFPaidGlobalDash = $("#btnPDFPaidGlobalDash");

function renderKPIs(){
  const sums = sumByStatus(DB.invoices);
  if(kpiPendingGlobal) kpiPendingGlobal.textContent = money(sums.Pendiente);
  if(kpiIssuedGlobal) kpiIssuedGlobal.textContent = money(sums.Girada);
  if(kpiPaidGlobal) kpiPaidGlobal.textContent = money(sums.Cobrada);
  if(kpiCountGlobal) kpiCountGlobal.textContent = String(sums.count);
}

function renderPendingByClient(){
  if(!pendingByClientList) return;
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
        <div class="name">${escapeHtml(r.name)}</div>
        <div class="sub">${r.count} factura(s) pendiente(s)</div>
      </div>
      <div class="badge bad">${money(r.pending)}</div>
    `;
    pendingByClientList.appendChild(el);
  }
}

function renderDashSummary(){
  if(!dashSummary) return;
  const sel = dashPeriod?.value || "thisWeek";
  let fromISO="", toISO="";
  if(sel==="custom"){
    fromISO = dashFrom?.value || "";
    toISO = dashTo?.value || "";
  }else{
    const p = resolvePeriod(sel);
    fromISO = p.fromISO;
    toISO = p.toISO;
    if(dashFrom) dashFrom.value = fromISO;
    if(dashTo) dashTo.value = toISO;
  }

  const invs = getInvoicesFiltered({ q:"", clientId:"all", status:"all", fromISO, toISO });
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
    div.innerHTML = `<div class="t">${b.t}</div><div class="v">${escapeHtml(b.v)}</div>`;
    dashSummary.appendChild(div);
  }
}

/* =========================================================
   INVOICES TABLE
========================================================= */
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

function statusBadgeClass(st){
  if(st==="Cobrada") return "good";
  if(st==="Girada") return "warn";
  return "bad";
}

function nextStatus(st){
  if(st==="Pendiente") return "Girada";
  if(st==="Girada") return "Cobrada";
  return "Pendiente";
}

function renderInvoices(){
  if(!invTbody) return;

  const list = getInvoicesFiltered({
    q: invSearch?.value || "",
    clientId: invClientFilter?.value || "all",
    status: invStatusFilter?.value || "all",
    fromISO: invFrom?.value || "",
    toISO: invTo?.value || "",
  });

  invTbody.innerHTML = "";
  let total = 0;

  for(const inv of list){
    total += Number(inv.amount||0);
    const badgeCls = statusBadgeClass(inv.status);
    const btnLabel = `➡️ ${nextStatus(inv.status)}`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(inv.dateISO || "")}</td>
      <td><span class="strong">${escapeHtml(inv.number||"")}</span></td>
      <td>${escapeHtml(inv.clientNameCache||"")}</td>
      <td>${escapeHtml(inv.tag||"")}</td>
      <td class="right">${money(inv.amount||0)}</td>
      <td><span class="badge ${badgeCls}">${escapeHtml(inv.status||"")}</span></td>
      <td>
        <button class="btn" data-act="cycle" data-id="${inv.id}">${btnLabel}</button>
        <button class="btn ghost" data-act="edit" data-id="${inv.id}">Editar</button>
        <button class="btn ghost" data-act="msg" data-id="${inv.id}">Mensaje</button>
        <button class="btn ghost danger" data-act="del" data-id="${inv.id}">Borrar</button>
      </td>
    `;
    invTbody.appendChild(tr);
  }

  if(invCountInfo) invCountInfo.textContent = `${list.length} factura(s)`;
  if(invTotalInfo) invTotalInfo.textContent = `Total listado: ${money(total)}`;

  invTbody.querySelectorAll("button[data-act]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if(act==="cycle") cycleInvoiceStatus(id);
      if(act==="edit") openInvoiceModal(id);
      if(act==="msg") openMessageModal(id);
      if(act==="del") deleteInvoice(id);
    });
  });
}

function cycleInvoiceStatus(id){
  const inv = DB.invoices.find(x=>x.id===id);
  if(!inv) return;
  inv.status = nextStatus(inv.status);
  normalizeInvoice(inv);
  saveLocalDB();
  renderAll();
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
    saveLocalDB();
    closeModal();
    renderAll();
  };

  foot.appendChild(cancel);
  foot.appendChild(ok);
  openModal("Borrar factura", body, foot);
}

/* =========================================================
   SELECTS (clientes)
========================================================= */
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
}

/* =========================================================
   INVOICE MODAL (crear / editar)
========================================================= */
function openInvoiceModal(editId=null){
  const isEdit = !!editId;
  const inv = isEdit ? DB.invoices.find(x=>x.id===editId) : null;

  const body = document.createElement("div");
  body.className = "formGrid";

  const date = mkInput("Fecha", "date", inv?.dateISO || toISODate(new Date()));
  const number = mkInput("Nº factura", "text", inv?.number || "");
  const client = mkSelect(
    "Cliente",
    DB.clients.map(c=>({value:c.id,label:c.name})),
    inv?.clientId || (DB.clients[0]?.id || "")
  );

  const tagWrap = document.createElement("div");
  const tagLabel = document.createElement("div");
  tagLabel.className = "muted";
  tagLabel.textContent = "Tag";
  const tagSelect = document.createElement("select");
  tagSelect.className = "input";
  tagWrap.append(tagLabel, tagSelect);

  fillTagSelect(tagSelect, client.select.value, inv?.tag || "");

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
    client.wrap, tagWrap,
    amount.wrap, status.wrap,
    notes.wrap
  );

  client.select.addEventListener("change", ()=>{
    fillTagSelect(tagSelect, client.select.value, "");
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
    const tagVal = safeText(tagSelect.value);
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

    saveLocalDB();
    closeModal();
    renderAll();
  };

  foot.append(cancel, save);
  openModal(isEdit ? "Editar factura" : "Nueva factura", body, foot);
}

/* =========================================================
   WHATSAPP MESSAGE (pendiente / cobrada)
========================================================= */
function openMessageModal(invId){
  const inv = DB.invoices.find(x=>x.id===invId);
  if(!inv) return;

  const c = getClientById(inv.clientId);
  const cliente = c?.name || inv.clientNameCache || "";
  const phone = safeText(c?.phone || "");

  const tpl = (inv.status === "Cobrada")
    ? (DB.settings.whatsappTemplatePaid || "")
    : (DB.settings.whatsappTemplatePending || "");

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

/* =========================================================
   CLIENTS UI
========================================================= */
const btnNewClient = $("#btnNewClient");
const clientSearch = $("#clientSearch");
const clientList = $("#clientList");
const clientDetail = $("#clientDetail");
let selectedClientId = null;

function renderClients(){
  const q = safeText(clientSearch?.value || "").toLowerCase();
  const list = DB.clients
    .filter(c=> !q || c.name.toLowerCase().includes(q))
    .slice()
    .sort((a,b)=>a.name.localeCompare(b.name));

  if(clientList) clientList.innerHTML = "";
  if(list.length===0){
    if(clientList) clientList.innerHTML = `<div class="muted">Sin clientes.</div>`;
    if(clientDetail) clientDetail.textContent = "Selecciona un cliente…";
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
    clientList?.appendChild(el);
  }

  if(!selectedClientId && list[0]) selectedClientId = list[0].id;
  renderClientDetail();
}

function renderClientDetail(){
  const c = getClientById(selectedClientId);
  if(!c){
    if(clientDetail) clientDetail.textContent = "Selecciona un cliente…";
    return;
  }

  const invs = DB.invoices.filter(i=>i.clientId===c.id);
  const sums = sumByStatus(invs);

  const wrap = document.createElement("div");
  wrap.className = "reportOut";

  const top = document.createElement("div");
  top.className = "item";
  top.innerHTML = `
    <div>
      <div class="name">${escapeHtml(c.name)}</div>
      <div class="sub">${escapeHtml(c.notes||"")}</div>
    </div>
    <div class="row wrap">
      <span class="badge bad">Pend: ${money(sums.Pendiente)}</span>
      <span class="badge warn">Girada: ${money(sums.Girada)}</span>
      <span class="badge good">Cobrada: ${money(sums.Cobrada)}</span>
    </div>
  `;

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

  const pdfPend = document.createElement("button");
  pdfPend.className = "btn ghost";
  pdfPend.textContent = "📄 PDF Pendientes";
  pdfPend.onclick = ()=>generateStatusPDF("Pendiente", "client", c.id);

  const pdfIssued = document.createElement("button");
  pdfIssued.className = "btn ghost";
  pdfIssued.textContent = "📄 PDF Giradas";
  pdfIssued.onclick = ()=>generateStatusPDF("Girada", "client", c.id);

  const pdfPaid = document.createElement("button");
  pdfPaid.className = "btn ghost";
  pdfPaid.textContent = "📄 PDF Cobradas";
  pdfPaid.onclick = ()=>generateStatusPDF("Cobrada", "client", c.id);

  actions.append(edit, addTag, pdfPend, pdfIssued, pdfPaid);

  const tip = document.createElement("div");
  tip.className = "muted";
  tip.textContent = "Gráficos avanzados: ve a Reportes, selecciona cliente y periodo.";

  wrap.append(top, actions, tip);
  if(clientDetail){
    clientDetail.innerHTML = "";
    clientDetail.appendChild(wrap);
  }
}

function openClientModal(editId=null){
  const isEdit = !!editId;
  const c = isEdit ? getClientById(editId) : null;

  const body = document.createElement("div");
  body.className = "formGrid";

  const name = mkInput("Nombre cliente", "text", c?.name || "");
  const phone = mkInput("Teléfono (WhatsApp)", "text", c?.phone || "");
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
      for(const inv of DB.invoices){
        if(inv.clientId===c.id) inv.clientNameCache = nm;
      }
    }else{
      const newC = { id:"cli_"+uid(), name:nm, phone:ph, notes:nt, tags:[nm] };
      DB.clients.push(newC);
      selectedClientId = newC.id;
    }

    saveLocalDB();
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
    saveLocalDB();
    closeModal();
    renderAll();
  };

  foot.append(cancel, add);
  openModal("Añadir tag", body, foot);
}

/* =========================================================
   REPORTS
========================================================= */
const repMode = $("#repMode");
const repFrom = $("#repFrom");
const repTo = $("#repTo");
const repClient = $("#repClient");
const repRun = $("#repRun");
const repOut = $("#repOut");

const btnPDFPendingGlobal = $("#btnPDFPendingGlobal");
const btnPDFPendingClient = $("#btnPDFPendingClient");
const btnPDFIssuedGlobal = $("#btnPDFIssuedGlobal");
const btnPDFIssuedClient = $("#btnPDFIssuedClient");
const btnPDFPaidGlobal = $("#btnPDFPaidGlobal");
const btnPDFPaidClient = $("#btnPDFPaidClient");

function runReports(){
  if(repOut) repOut.innerHTML = "";

  const mode = repMode?.value || "weekly";
  const clientId = repClient?.value || "all";

  let fromISO = repFrom?.value || "";
  let toISO = repTo?.value || "";
  ({fromISO, toISO} = clampDateRange(fromISO, toISO));

  const now = new Date();
  if(!fromISO && !toISO){
    if(mode==="weekly"){
      fromISO = toISODate(startOfWeek(now));
      toISO = toISODate(endOfWeek(now));
    }else if(mode==="monthly"){
      fromISO = toISODate(startOfMonth(now));
      toISO = toISODate(endOfMonth(now));
    }
    if(repFrom) repFrom.value = fromISO;
    if(repTo) repTo.value = toISO;
  }

  const invs = getInvoicesFiltered({ q:"", clientId, status:"all", fromISO, toISO });
  if(invs.length===0){
    if(repOut) repOut.innerHTML = `<div class="muted">No hay facturas en ese periodo.</div>`;
    updateCharts();
    return;
  }

  const sums = sumByStatus(invs);

  const box = document.createElement("div");
  box.className="item";
  box.innerHTML = `
    <div>
      <div class="name">Resumen ${escapeHtml(fromISO||"")} → ${escapeHtml(toISO||"")}</div>
      <div class="sub">${invs.length} factura(s) · Cliente: ${escapeHtml(clientId==="all" ? "Todos" : (getClientById(clientId)?.name||""))}</div>
    </div>
    <div class="row wrap">
      <span class="badge bad">Pend: ${money(sums.Pendiente)}</span>
      <span class="badge warn">Girada: ${money(sums.Girada)}</span>
      <span class="badge good">Cobrada: ${money(sums.Cobrada)}</span>
      <span class="badge">Total: ${money(sums.all)}</span>
    </div>
  `;
  repOut?.appendChild(box);

  updateCharts();
}

/* =========================================================
   PDF (jsPDF + AutoTable)
========================================================= */
function ensurePDFLibs(){
  const hasUMD = !!window.jspdf;
  const hasJsPDF = hasUMD && typeof window.jspdf.jsPDF === "function";
  const jsPDF = hasJsPDF ? window.jspdf.jsPDF : null;

  let autoTableOk = false;
  try{
    if(hasJsPDF){
      const test = new jsPDF({ unit:"pt", format:"a4" });
      autoTableOk = typeof test.autoTable === "function";
    }
  }catch(e){
    autoTableOk = false;
  }

  return { jsPDF, autoTableOk };
}

function showPDFError(title, err){
  const body = document.createElement("div");
  body.innerHTML = `
    <div class="muted">No se pudo generar el PDF.</div>
    <div style="margin-top:10px" class="item">
      <div>
        <div class="name">${escapeHtml(title)}</div>
        <div class="sub">${escapeHtml(String(err?.message || err || "Error desconocido"))}</div>
      </div>
      <div class="badge bad">PDF</div>
    </div>
  `;

  const foot = document.createElement("div");
  foot.className = "row";
  const ok = document.createElement("button");
  ok.className = "btn";
  ok.textContent = "Cerrar";
  ok.onclick = closeModal;
  foot.appendChild(ok);

  openModal("Error PDF", body, foot);
}

function generateStatusPDF(statusWanted, scope="global", clientId=null){
  const libs = ensurePDFLibs();
  if(!libs.jsPDF){
    showPDFError("Librería jsPDF no encontrada", "Falta window.jspdf.jsPDF (CDN no cargado).");
    return;
  }
  if(!libs.autoTableOk){
    showPDFError("AutoTable no disponible", "Falta plugin AutoTable o no se cargó correctamente.");
    return;
  }

  try{
    const doc = new libs.jsPDF({ orientation:"portrait", unit:"pt", format:"a4" });
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 40;

    const now = new Date();
    const created = `${toISODate(now)} ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;

    let list = DB.invoices.filter(i=>i.status === statusWanted);
    let title = `${statusWanted} (Global)`;

    if(scope==="client"){
      const c = getClientById(clientId);
      title = `${statusWanted} · ${c?.name || "Cliente"}`;
      list = list.filter(i=>i.clientId===clientId);
    }

    list = list.slice().sort((a,b)=>{
      const da = parseISODate(a.dateISO)?.getTime() || 0;
      const db = parseISODate(b.dateISO)?.getTime() || 0;
      return da - db;
    });

    doc.setFont("helvetica","bold");
    doc.setFontSize(16);
    doc.text("ARSLAN PRO • Reporte", margin, 52);

    doc.setFontSize(13);
    doc.text(title, margin, 74);

    doc.setFont("helvetica","normal");
    doc.setFontSize(10);
    doc.text(`Generado: ${created}`, margin, 92);

    const total = list.reduce((s,i)=>s+Number(i.amount||0),0);
    doc.setFont("helvetica","bold");
    doc.setFontSize(12);
    doc.text(`Total ${statusWanted.toLowerCase()}: ${money(total)}`, margin, 118);

    if(list.length===0){
      doc.setFont("helvetica","normal");
      doc.setFontSize(11);
      doc.text(`No hay facturas en estado: ${statusWanted}.`, margin, 150);
      doc.save(`${statusWanted.toLowerCase()}_${scope==="client" ? "cliente" : "global"}_${toISODate(now)}.pdf`);
      return;
    }

    const headFill = [30, 42, 58];

    if(scope==="global"){
      const groups = new Map();
      for(const inv of list){
        const name = inv.clientNameCache || "(Sin cliente)";
        if(!groups.has(name)) groups.set(name, []);
        groups.get(name).push(inv);
      }
      const clientNames = Array.from(groups.keys()).sort((a,b)=>a.localeCompare(b));

      let y = 140;

      for(const name of clientNames){
        const invs = groups.get(name);
        const sub = invs.reduce((s,i)=>s+Number(i.amount||0),0);

        doc.setFont("helvetica","bold");
        doc.setFontSize(12);
        doc.text(`${name} — Subtotal: ${money(sub)}`, margin, y);
        y += 10;

        const rows = invs.map(i=>[
          i.dateISO || "",
          i.number || "",
          i.tag || "",
          (Number(i.amount||0)).toLocaleString("es-ES", {minimumFractionDigits:2, maximumFractionDigits:2})
        ]);

        doc.autoTable({
          startY: y + 10,
          head: [["Fecha","Nº factura","Tag","Importe"]],
          body: rows,
          styles: { font:"helvetica", fontSize:10, cellPadding:6 },
          headStyles: { fillColor: headFill },
          theme: "grid",
          margin: { left: margin, right: margin },
          columnStyles: { 3: { halign:"right" } }
        });

        y = doc.lastAutoTable.finalY + 18;

        if(y > 760){
          doc.addPage();
          y = 60;
        }
      }

      doc.setFont("helvetica","bold");
      doc.setFontSize(13);
      doc.text(`TOTAL GLOBAL ${statusWanted.toUpperCase()}: ${money(total)}`, margin, Math.min(780, y));

    }else{
      const rows = list.map(i=>[
        i.dateISO || "",
        i.number || "",
        i.tag || "",
        (Number(i.amount||0)).toLocaleString("es-ES", {minimumFractionDigits:2, maximumFractionDigits:2})
      ]);

      doc.autoTable({
        startY: 140,
        head: [["Fecha","Nº factura","Tag","Importe"]],
        body: rows,
        styles: { font:"helvetica", fontSize:10, cellPadding:6 },
        headStyles: { fillColor: headFill },
        theme: "grid",
        margin: { left: margin, right: margin },
        columnStyles: { 3: { halign:"right" } }
      });

      const y = doc.lastAutoTable.finalY + 22;
      doc.setFont("helvetica","bold");
      doc.setFontSize(13);
      doc.text(`TOTAL ${statusWanted.toUpperCase()}: ${money(total)}`, margin, Math.min(780, y));
    }

    const pageCount = doc.internal.getNumberOfPages();
    for(let p=1; p<=pageCount; p++){
      doc.setPage(p);
      doc.setFont("helvetica","normal");
      doc.setFontSize(9);
      doc.text(`Página ${p} / ${pageCount}`, pageW - margin, 820, { align:"right" });
    }

    doc.save(`${statusWanted.toLowerCase()}_${scope==="client" ? "cliente" : "global"}_${toISODate(now)}.pdf`);

  }catch(err){
    showPDFError("Generación PDF", err);
  }
}

/* =========================================================
   CHARTS (Chart.js)
========================================================= */
let chartByTag = null;
let chartTrend = null;

const chartByTagCanvas = $("#chartByTag");
const chartTrendCanvas = $("#chartTrend");

function ensureCharts(){
  if(!window.Chart) return;

  if(chartByTagCanvas && !chartByTag){
    chartByTag = new Chart(chartByTagCanvas, {
      type: "bar",
      data: { labels: [], datasets: [{ label: "Importe (€)", data: [] }] },
      options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:true}} }
    });
  }

  if(chartTrendCanvas && !chartTrend){
    chartTrend = new Chart(chartTrendCanvas, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          { label: "Pendiente (€)", data: [], tension: 0.25 },
          { label: "Girada (€)", data: [], tension: 0.25 },
          { label: "Cobrada (€)", data: [], tension: 0.25 },
        ]
      },
      options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:true}} }
    });
  }
}

function getReportRange(){
  let fromISO = repFrom?.value || "";
  let toISO = repTo?.value || "";
  ({fromISO, toISO} = clampDateRange(fromISO, toISO));
  return { fromISO, toISO };
}

function bucketLabel(date, mode){
  if(mode==="monthly"){
    const y = date.getFullYear();
    const m = String(date.getMonth()+1).padStart(2,"0");
    return `${y}-${m}`;
  }
  const s = startOfWeek(date);
  return `W ${toISODate(s)}`;
}

function buildTrendBuckets(invs, mode){
  const mapPend = new Map();
  const mapIss = new Map();
  const mapPaid = new Map();

  for(const inv of invs){
    const d = parseISODate(inv.dateISO);
    if(!d) continue;
    const key = bucketLabel(d, mode);
    const amt = Number(inv.amount||0);

    if(inv.status==="Pendiente") mapPend.set(key, (mapPend.get(key)||0) + amt);
    else if(inv.status==="Girada") mapIss.set(key, (mapIss.get(key)||0) + amt);
    else if(inv.status==="Cobrada") mapPaid.set(key, (mapPaid.get(key)||0) + amt);
  }

  const keys = new Set([...mapPend.keys(), ...mapIss.keys(), ...mapPaid.keys()]);
  const arr = Array.from(keys);

  const sortBy = (k)=>{
    if(mode==="monthly"){
      const [y,m] = k.replace("W ","").split("-").map(Number);
      return new Date(y, (m||1)-1, 1).getTime();
    }
    const iso = k.replace("W ","");
    return parseISODate(iso)?.getTime() || 0;
  };

  arr.sort((a,b)=>sortBy(a)-sortBy(b));

  return {
    labels: arr,
    pend: arr.map(k=>mapPend.get(k)||0),
    iss: arr.map(k=>mapIss.get(k)||0),
    paid: arr.map(k=>mapPaid.get(k)||0),
  };
}

function buildByTag(invs){
  const map = new Map();
  for(const inv of invs){
    const tag = safeText(inv.tag || "(Sin tag)");
    const amt = Number(inv.amount||0);
    map.set(tag, (map.get(tag)||0) + amt);
  }
  const rows = Array.from(map.entries()).map(([tag,amt])=>({tag, amt}));
  rows.sort((a,b)=>b.amt-a.amt);
  return { labels: rows.map(r=>r.tag), data: rows.map(r=>r.amt) };
}

function updateCharts(){
  if(!DB) return;
  ensureCharts();
  if(!chartByTag || !chartTrend) return;

  const { fromISO, toISO } = getReportRange();
  const clientId = repClient?.value || "all";
  const mode = repMode?.value || "weekly";

  const invs = getInvoicesFiltered({ q:"", clientId, status:"all", fromISO, toISO });

  const byTag = buildByTag(invs);
  chartByTag.data.labels = byTag.labels;
  chartByTag.data.datasets[0].data = byTag.data;
  chartByTag.update();

  const tr = buildTrendBuckets(invs, mode==="monthly" ? "monthly" : "weekly");
  chartTrend.data.labels = tr.labels;
  chartTrend.data.datasets[0].data = tr.pend;
  chartTrend.data.datasets[1].data = tr.iss;
  chartTrend.data.datasets[2].data = tr.paid;
  chartTrend.update();
}

/* =========================================================
   USERS TAB
========================================================= */
const btnNewUser = $("#btnNewUser");
const usersList = $("#usersList");

function renderUsersTab(){
  if(!usersList) return;
  usersList.innerHTML = "";
  const list = USERS.slice().sort((a,b)=>a.name.localeCompare(b.name));

  for(const u of list){
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div>
        <div class="name">${escapeHtml(u.name)}</div>
        <div class="sub">ID: ${escapeHtml(u.id)}</div>
      </div>
      <div class="row wrap">
        <button class="btn ghost" data-act="pin" data-id="${u.id}">Cambiar PIN</button>
        <button class="btn ghost danger" data-act="del" data-id="${u.id}">Borrar</button>
      </div>
    `;
    usersList.appendChild(el);
  }

  usersList.querySelectorAll("button[data-act]").forEach(b=>{
    b.addEventListener("click", ()=>{
      const act = b.dataset.act;
      const id = b.dataset.id;
      if(act==="pin") openChangePinModal(id);
      if(act==="del") openDeleteUserModal(id);
    });
  });

  const lastEmail = localStorage.getItem(K.CLOUD_EMAIL_LAST) || "";
  if(cloudEmail && !cloudEmail.value && lastEmail) cloudEmail.value = lastEmail;
}

function openNewUserModal(){
  const body = document.createElement("div");
  body.className = "formGrid";

  const name = mkInput("Nombre usuario", "text", "");
  const pin = mkInput("PIN (numérico)", "password", "");
  pin.input.inputMode = "numeric";

  name.wrap.classList.add("full");
  pin.wrap.classList.add("full");

  body.append(name.wrap, pin.wrap);

  const foot = document.createElement("div");
  foot.className = "row";

  const cancel = document.createElement("button");
  cancel.className="btn ghost";
  cancel.textContent="Cancelar";
  cancel.onclick=closeModal;

  const create = document.createElement("button");
  create.className="btn";
  create.textContent="Crear";

  create.onclick = async ()=>{
    const nm = safeText(name.input.value);
    const p = safeText(pin.input.value);
    if(!nm || !p){
      alert("Nombre y PIN son obligatorios.");
      return;
    }
    if(USERS.some(u=>u.name.toLowerCase()===nm.toLowerCase())){
      alert("Ya existe un usuario con ese nombre.");
      return;
    }

    const hash = await sha256Hex(p);
    const newU = { id:"usr_"+uid(), name:nm, pinHash: hash, createdAt: Date.now() };
    USERS.push(newU);
    saveUsers();
    closeModal();
    renderUsersTab();
    renderUserSelect();
  };

  foot.append(cancel, create);
  openModal("Nuevo usuario", body, foot);
}

function openChangePinModal(userId){
  const u = USERS.find(x=>x.id===userId);
  if(!u) return;

  const body = document.createElement("div");
  body.className = "formGrid";

  const pin = mkInput("Nuevo PIN", "password", "");
  pin.wrap.classList.add("full");
  pin.input.inputMode = "numeric";

  body.append(pin.wrap);

  const foot = document.createElement("div");
  foot.className="row";

  const cancel = document.createElement("button");
  cancel.className="btn ghost";
  cancel.textContent="Cancelar";
  cancel.onclick=closeModal;

  const save = document.createElement("button");
  save.className="btn";
  save.textContent="Guardar";

  save.onclick = async ()=>{
    const p = safeText(pin.input.value);
    if(!p){ alert("Introduce el nuevo PIN."); return; }
    u.pinHash = await sha256Hex(p);
    saveUsers();
    closeModal();
    renderUsersTab();
    renderUserSelect();
  };

  foot.append(cancel, save);
  openModal(`Cambiar PIN — ${u.name}`, body, foot);
}

function openDeleteUserModal(userId){
  const u = USERS.find(x=>x.id===userId);
  if(!u) return;

  if(u.id==="usr_admin"){
    alert("No se puede borrar ADMIN.");
    return;
  }

  const body = document.createElement("div");
  body.innerHTML = `
    <div class="muted">¿Borrar usuario <b>${escapeHtml(u.name)}</b>?</div>
    <div class="muted" style="margin-top:8px">
      El usuario desaparece del login interno. Los datos quedan en el navegador y en Firebase.
    </div>
  `;

  const foot = document.createElement("div");
  foot.className="row";

  const cancel = document.createElement("button");
  cancel.className="btn ghost";
  cancel.textContent="Cancelar";
  cancel.onclick=closeModal;

  const del = document.createElement("button");
  del.className="btn danger";
  del.textContent="Borrar";

  del.onclick=()=>{
    USERS = USERS.filter(x=>x.id!==userId);
    saveUsers();
    closeModal();
    renderUsersTab();
    renderUserSelect();
  };

  foot.append(cancel, del);
  openModal("Borrar usuario", body, foot);
}

/* =========================================================
   EXPORT / IMPORT / RESET
========================================================= */
const btnExport = $("#btnExport");
const fileImport = $("#fileImport");
const btnClearLocal = $("#btnClearLocal");

async function doImport(file){
  const txt = await readFileAsText(file);
  const obj = JSON.parse(txt);
  if(!obj || typeof obj !== "object") throw new Error("Archivo inválido");
  if(!Array.isArray(obj.clients) || !Array.isArray(obj.invoices)) throw new Error("Estructura inválida");

  DB = obj;
  if(!DB.settings) DB.settings = makeDefaultData().settings;
  if(!DB.meta) DB.meta = { updatedAt: Date.now() };

  saveLocalDB();
  renderAll();
}

function resetLocal(){
  const body = document.createElement("div");
  body.innerHTML = `<div class="muted">Esto borra el almacenamiento local <b>del usuario activo</b> y restaura datos iniciales. Si la nube está conectada, luego sincroniza.</div>`;

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
    if(!ACTIVE_USER_ID) return;
    localStorage.removeItem(keyForUserData(ACTIVE_USER_ID));
    DB = loadLocalDB(ACTIVE_USER_ID);
    closeModal();
    renderAll();
    pushCloud();
  };

  foot.append(cancel, ok);
  openModal("Reset local (usuario activo)", body, foot);
}

/* =========================================================
   MAIN RENDER
========================================================= */
function renderAll(){
  if(activeUserLabel) activeUserLabel.textContent = ACTIVE_USER_NAME || "";
  if(activeUserLabel2) activeUserLabel2.textContent = ACTIVE_USER_NAME || "";

  renderClientSelects();
  renderKPIs();
  renderPendingByClient();
  renderDashSummary();
  renderInvoices();
  renderClients();
  renderUsersTab();
  updateCharts();

  pushCloud();
}

/* =========================================================
   EVENTS
========================================================= */
function bindEvents(){
  $("#btnTheme")?.addEventListener("click", toggleTheme);

  pinBtn?.addEventListener("click", checkPin);
  pinInput?.addEventListener("keydown",(e)=>{ if(e.key==="Enter") checkPin(); });
  btnLock?.addEventListener("click", lock);

  $$(".navItem[data-tab]").forEach(btn=>{
    btn.addEventListener("click", ()=>showTab(btn.dataset.tab));
  });

  $("#btnOpenCloudAccount")?.addEventListener("click", ()=>{
    showTab("users");
    setTimeout(()=>cloudEmail?.focus(), 60);
  });
  $("#btnCloudQuick")?.addEventListener("click", ()=>{
    showTab("users");
    setTimeout(()=>cloudEmail?.focus(), 60);
  });

  dashSearchClient?.addEventListener("input", renderPendingByClient);
  dashApply?.addEventListener("click", renderDashSummary);
  dashPeriod?.addEventListener("change", ()=>{
    const isCustom = dashPeriod.value==="custom";
    if(dashFrom) dashFrom.disabled = !isCustom;
    if(dashTo) dashTo.disabled = !isCustom;
    renderDashSummary();
  });

  btnPDFPendingGlobalDash?.addEventListener("click", ()=>generateStatusPDF("Pendiente", "global"));
  btnPDFIssuedGlobalDash?.addEventListener("click", ()=>generateStatusPDF("Girada", "global"));
  btnPDFPaidGlobalDash?.addEventListener("click", ()=>generateStatusPDF("Cobrada", "global"));

  const rerInv = ()=>renderInvoices();
  invSearch?.addEventListener("input", rerInv);
  invClientFilter?.addEventListener("change", rerInv);
  invStatusFilter?.addEventListener("change", rerInv);
  invFrom?.addEventListener("change", rerInv);
  invTo?.addEventListener("change", rerInv);

  invClearFilters?.addEventListener("click", ()=>{
    if(invSearch) invSearch.value = "";
    if(invClientFilter) invClientFilter.value = "all";
    if(invStatusFilter) invStatusFilter.value = "all";
    if(invFrom) invFrom.value = "";
    if(invTo) invTo.value = "";
    renderInvoices();
  });

  btnNewInvoice?.addEventListener("click", ()=>openInvoiceModal(null));

  btnNewClient?.addEventListener("click", ()=>openClientModal(null));
  clientSearch?.addEventListener("input", renderClients);

  repRun?.addEventListener("click", runReports);
  repMode?.addEventListener("change", ()=>{
    const now = new Date();
    if(repMode.value==="weekly"){
      if(repFrom) repFrom.value = toISODate(startOfWeek(now));
      if(repTo) repTo.value = toISODate(endOfWeek(now));
    }else if(repMode.value==="monthly"){
      if(repFrom) repFrom.value = toISODate(startOfMonth(now));
      if(repTo) repTo.value = toISODate(endOfMonth(now));
    }
    updateCharts();
  });
  repFrom?.addEventListener("change", updateCharts);
  repTo?.addEventListener("change", updateCharts);
  repClient?.addEventListener("change", updateCharts);

  btnPDFPendingGlobal?.addEventListener("click", ()=>generateStatusPDF("Pendiente", "global"));
  btnPDFPendingClient?.addEventListener("click", ()=>{
    const id = repClient?.value || "all";
    if(!id || id==="all"){ alert("Selecciona un cliente."); return; }
    generateStatusPDF("Pendiente", "client", id);
  });

  btnPDFIssuedGlobal?.addEventListener("click", ()=>generateStatusPDF("Girada", "global"));
  btnPDFIssuedClient?.addEventListener("click", ()=>{
    const id = repClient?.value || "all";
    if(!id || id==="all"){ alert("Selecciona un cliente."); return; }
    generateStatusPDF("Girada", "client", id);
  });

  btnPDFPaidGlobal?.addEventListener("click", ()=>generateStatusPDF("Cobrada", "global"));
  btnPDFPaidClient?.addEventListener("click", ()=>{
    const id = repClient?.value || "all";
    if(!id || id==="all"){ alert("Selecciona un cliente."); return; }
    generateStatusPDF("Cobrada", "client", id);
  });

  btnNewUser?.addEventListener("click", openNewUserModal);

  btnExport?.addEventListener("click", ()=>{
    const stamp = new Date();
    downloadJSON(DB, `facturas_${ACTIVE_USER_NAME || "usuario"}_${toISODate(stamp)}.json`);
  });

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

  btnCloudLogin?.addEventListener("click", cloudLogin);
  btnCloudRegister?.addEventListener("click", cloudRegister);
  btnCloudLogout?.addEventListener("click", cloudLogout);
}

/* =========================================================
   INIT
========================================================= */
(async function init(){
  applyTheme(getTheme());
  await ensureUsers();
  renderUserSelect();
  bindEvents();

  const now = new Date();
  if(repFrom) repFrom.value = toISODate(startOfWeek(now));
  if(repTo) repTo.value = toISODate(endOfWeek(now));

  if(dashFrom && dashTo){
    dashFrom.value = toISODate(startOfWeek(now));
    dashTo.value = toISODate(endOfWeek(now));
    dashFrom.disabled = true;
    dashTo.disabled = true;
  }

  initCloud();

  const rememberedUser = getSessionUser();
  const hasUser = USERS.some(u=>u.id===rememberedUser);

  if(isSessionOk() && hasUser){
    ACTIVE_USER_ID = rememberedUser;
    ACTIVE_USER_NAME = USERS.find(u=>u.id===rememberedUser)?.name || "";
    DB = loadLocalDB(ACTIVE_USER_ID);
    unlock();
    renderAll();

    const fb = getFirebase();
    if(fb && fb.auth.currentUser){
      CLOUD_UID = fb.auth.currentUser.uid;
      CLOUD_READY = true;
      setCloudStatus("ok","☁️ Nube online");
      if(cloudUidLabel) cloudUidLabel.textContent = CLOUD_UID;
      attachCloudForActiveUser(fb.db);
      pushCloud();
    }
  }else{
    lock();
  }

  const lastEmail = localStorage.getItem(K.CLOUD_EMAIL_LAST) || "";
  if(cloudEmail && !cloudEmail.value && lastEmail) cloudEmail.value = lastEmail;
})();
