// ════════════════════════════════════════════════════════════
// SAMITEX PLANTA — app.js
// ════════════════════════════════════════════════════════════

// ─── CONFIG ─────────────────────────────────────────────────
const SUPA_URL = 'https://mzvucelrdkzomyaepirh.supabase.co';
const SUPA_KEY = 'sb_publishable_OHxWYKu13BrSs2X-Yc9Agw_yxJ-HnnV';
const sb = supabase.createClient(SUPA_URL, SUPA_KEY);

const DIAS_RECORDATORIO_PIN = 30;

// ─── SUBAREAS ───────────────────────────────────────────────
const SUBAREAS = {
  almacen_telas:      { label: 'Almacén Telas',      estados: ['ENTREGADO','FALTA NOTA DE ENTREGA','HABILITANDO'] },
  corte_planta:       { label: 'Corte Planta',        estados: ['EN PROCESO','ENTREGADO'] },
  calidad_corte:      { label: 'Calidad Corte',       estados: ['APROBADO','RECHAZADO'] },
  corte_complem:      { label: 'Corte Complem.',      estados: ['ENTREGADO A CALIDAD','ENTREGADO A PCP','FALTA RIBETE','FALTA PRETINA','FALTA RIBETE Y PRETINA'] },
  calidad_complem:    { label: 'Calidad Complem.',    estados: ['APROBADO','RECHAZADO'] },
  almacen_avios_cost: { label: 'Almacén Avíos Cost.', estados: ['ENTREGADO','FALTA NOTA DE ENTREGA','HABILITANDO'] },
  calidad_avios_cost: { label: 'Calidad Avíos Cost.', estados: ['APROBADO','FALTANTE'] },
  entrega_pl_tll:     { label: 'Entrega PL/TLL',      estados: ['ENTR. PLANTA','ENTR. TALLER'],
                        requiere: { subarea: 'calidad_corte', estado: 'APROBADO' } },
  almacen_avios_acab: { label: 'Almacén Avíos Acab.', estados: ['ENTREGADO','FALTA NOTA DE ENTREGA','HABILITANDO'] },
  calidad_avios_acab: { label: 'Calidad Avíos Acab.', estados: ['APROBADO','RECHAZADO'] },
};

// Área padre → subareas que puede editar
const AREA_SUBAREAS = {
  almacen: ['almacen_telas','almacen_avios_cost','almacen_avios_acab'],
  corte:   ['corte_planta','corte_complem','entrega_pl_tll'],
  calidad: ['calidad_corte','calidad_complem','calidad_avios_cost','calidad_avios_acab'],
};

// Encabezados del Excel → campo en BD
const EXCEL_HEADERS = {
  'CORTE':          'corte',
  'T_PRENDA':       'tipo_prenda',
  'CANAL':          'canal',
  'N° REQ./ PED.':  'nro_req',
  'APT TARGET':     'apt_target',
  'MODELO':         'modelo',
  'ARTICULO':       'articulo',
  'COLOR':          'color',
  'OF':             'of',
  'TOTAL':          'corte_proyectado',
  'FECHA':          'fecha_programada',
};

// ─── STATE ──────────────────────────────────────────────────
let session       = null;   // { id, nombre, area, ... }
let ordenes       = [];
let eventos       = [];
let ordenDetalle  = null;
let estadoSelMap  = {};     // { subarea: estadoSeleccionado }
let fotoB64Map    = {};     // { subarea: base64 }
let filterEnc     = 'todas';
let filterSeg     = 'todas';
let filterIng     = 'todas';
let filterHist    = 'todas';
let filterUsers   = 'todos';
let editingOrdenId = null;
let pinForzado    = false;
let confirmCb     = null;

// ─── THEME ──────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('smx_theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(saved);
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('smx_theme', t);
}
function toggleTheme() {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}
initTheme();

// ─── LOGIN: usuario como texto libre (sin dropdown) ─────────
// No se precarga ninguna lista; el usuario escribe su nombre.

// ─── LOGIN / LOGOUT ─────────────────────────────────────────
async function doLogin() {
  const nombre = document.getElementById('loginUser').value.trim();
  const pin    = document.getElementById('loginPin').value;
  if (!nombre) { toast('Selecciona tu usuario', 'warn'); return; }
  if (!pin)    { toast('Ingresa tu PIN', 'warn'); return; }

  const btn = document.getElementById('btnLogin');
  btn.innerHTML = '<span class="spinner"></span>'; btn.disabled = true;

  const { data, error } = await sb.rpc('login_usuario', { p_nombre: nombre, p_pin: pin });
  btn.innerHTML = 'Entrar'; btn.disabled = false;

  if (error) { toast('Error de conexión', 'err'); return; }
  if (!data.ok) { toast(data.error, 'err'); return; }

  session = data;
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appShell').classList.add('visible');
  document.getElementById('topbarUser').textContent = `${session.nombre} · ${cap(session.area)}`;
  document.getElementById('loginPin').value = '';

  buildTabs();
  await syncFromServer();

  // PIN forzado (primer ingreso o reseteo)
  if (session.debe_cambiar_pin) {
    openPinModal(true);
  } else {
    // Recordatorio mensual
    const dias = (Date.now() - new Date(session.pin_actualizado_en).getTime()) / 86400000;
    if (dias >= DIAS_RECORDATORIO_PIN) {
      toast(`Tu PIN tiene ${Math.floor(dias)} días — te recomendamos cambiarlo 🔑`, 'warn');
    }
  }
}

function doLogout() {
  session = null; ordenes = []; eventos = [];
  estadoSelMap = {}; fotoB64Map = {};
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('appShell').classList.remove('visible');
  document.getElementById('loginUser').value = '';
}

// ─── TABS POR ROL ───────────────────────────────────────────
function buildTabs() {
  const bar = document.getElementById('tabsBar');
  bar.innerHTML = '';
  let tabs;

  if (session.area === 'ingenieria') {
    tabs = [
      { screen: 'scIngOrdenes', label: 'Órdenes',     cb: renderIngOrdenes },
      { screen: 'scIngSeg',     label: 'Seguimiento', cb: renderSeg },
      { screen: 'scIngHist',    label: 'Historial',   cb: renderHist },
      { screen: 'scIngUsers',   label: 'Usuarios',    cb: renderUsers },
    ];
  } else if (session.area === 'gerencia') {
    tabs = [
      { screen: 'scGerencia', label: 'Panel',     cb: renderGerencia },
      { screen: 'scIngHist',  label: 'Historial', cb: renderHist },
    ];
  } else {
    tabs = [{ screen: 'scOrdenes', label: 'Mis órdenes', cb: renderOrdenes }];
  }

  tabs.forEach((t, i) => {
    const el = document.createElement('div');
    el.className = 'tab' + (i === 0 ? ' active' : '');
    el.textContent = t.label;
    el.onclick = () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      el.classList.add('active');
      showScreen(t.screen);
      t.cb();
    };
    bar.appendChild(el);
  });

  showScreen(tabs[0].screen);
  tabs[0].cb();
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

// ─── FILTER CHIPS ───────────────────────────────────────────
function setFilter(val, el, groupId) {
  document.querySelectorAll(`#${groupId} .chip`).forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  if (groupId === 'chipsOrdenes')    { filterEnc   = val; renderOrdenes(); }
  if (groupId === 'chipsSeg')        { filterSeg   = val; renderSeg(); }
  if (groupId === 'chipsIngOrdenes') { filterIng   = val; renderIngOrdenes(); }
  if (groupId === 'chipsHist')       { filterHist  = val; renderHist(); }
  if (groupId === 'chipsUsers')      { filterUsers = val; renderUsers(); }
}

// ─── HELPERS DE ESTADO ──────────────────────────────────────
function estadoActual(orden, subarea) {
  const evs = eventos
    .filter(e => e.orden_id === orden.id && e.subarea === subarea)
    .sort((a,b) => new Date(b.creado_en) - new Date(a.creado_en));
  return evs[0] || null; // devuelve el evento completo (estado + fecha)
}

function isFinal(estado) {
  if (!estado) return false;
  return estado === 'APROBADO' || estado === 'ENTREGADO'
    || estado === 'ENTR. PLANTA' || estado === 'ENTR. TALLER'
    || estado === 'ENTREGADO A CALIDAD' || estado === 'ENTREGADO A PCP';
}

function calcProgress(orden) {
  const keys = Object.keys(SUBAREAS);
  const done = keys.filter(k => isFinal(estadoActual(orden,k)?.estado)).length;
  return Math.round((done / keys.length) * 100);
}

function matchesSearch(o, term) {
  if (!term) return true;
  const t = term.toLowerCase().trim();
  return [o.of, o.color, o.nro_req, o.articulo].some(v => v && String(v).toLowerCase().includes(t));
}

function tieneAlerta(orden) {
  return Object.keys(SUBAREAS).some(k => {
    const est = estadoActual(orden,k)?.estado;
    return est && (est.includes('RECHAZADO') || est.includes('FALTA') || est === 'FALTANTE');
  });
}

function estaBloqueada(orden) {
  return Object.entries(SUBAREAS).some(([k,sub]) => {
    if (!sub.requiere) return false;
    const reqOK = estadoActual(orden, sub.requiere.subarea)?.estado === sub.requiere.estado;
    return !reqOK && !estadoActual(orden,k);
  });
}

function badgeForEstado(est) {
  if (!est) return 'badge-gray';
  if (est === 'APROBADO' || est.startsWith('ENTREGADO') || est.startsWith('ENTR.')) return 'badge-green';
  if (est === 'RECHAZADO' || est === 'FALTANTE') return 'badge-red';
  if (est.startsWith('FALTA')) return 'badge-yellow';
  return 'badge-blue';
}

function selClass(est) {
  if (!est) return '';
  if (est === 'APROBADO') return 'sel-aprobado';
  if (est === 'RECHAZADO' || est === 'FALTANTE') return 'sel-rechazado';
  if (est.startsWith('FALTA')) return 'sel-falta';
  if (est.startsWith('ENTREGADO') || est.startsWith('ENTR.')) return 'sel-entregado';
  return 'sel-default';
}

function misSubareas() {
  return AREA_SUBAREAS[session.area] || [];
}

// ─── RENDER: ENCARGADO — LISTA ──────────────────────────────
function renderOrdenes() {
  const el = document.getElementById('listOrdenes');
  const subs = misSubareas();
  const term = document.getElementById('searchEnc')?.value || '';
  let lista = ordenes.filter(o => !o.archivado && matchesSearch(o, term));

  const estadoDeMisSubs = o => subs.map(s => estadoActual(o,s)?.estado).filter(Boolean);

  if (filterEnc === 'pendiente')  lista = lista.filter(o => estadoDeMisSubs(o).length === 0);
  if (filterEnc === 'en_proceso') lista = lista.filter(o => { const e = estadoDeMisSubs(o); return e.length > 0 && !subs.every(s => isFinal(estadoActual(o,s)?.estado)); });
  if (filterEnc === 'completado') lista = lista.filter(o => subs.every(s => isFinal(estadoActual(o,s)?.estado)));

  if (!lista.length) {
    el.innerHTML = emptyHTML('📋','Sin órdenes','No hay órdenes en este filtro');
    return;
  }

  el.innerHTML = lista.map(o => {
    const pct = calcProgress(o);
    const badges = subs.map(s => {
      const ev = estadoActual(o,s);
      if (!ev) return '';
      return `<span class="badge ${badgeForEstado(ev.estado)}" style="margin:2px 2px 0 0;">${SUBAREAS[s].label}: ${ev.estado}</span>`;
    }).filter(Boolean).join('');
    return `<div class="card card-clickable" onclick="abrirDetalle('${o.id}')">
      <div class="card-head">
        <div style="min-width:0;">
          <div class="card-of">${o.of}</div>
          <div class="card-meta">${o.articulo||'—'} · ${o.color} · ${o.corte_proyectado||'—'} uds · Req. ${o.nro_req}</div>
        </div>
        <div class="card-arrow">›</div>
      </div>
      <div style="margin-top:6px;display:flex;flex-wrap:wrap;">${badges || '<span class="badge badge-gray">SIN REGISTRO</span>'}</div>
      <div class="prog-wrap">
        <div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div>
        <div class="prog-label">${pct}% del flujo completado</div>
      </div>
    </div>`;
  }).join('');
}

// ─── RENDER: ENCARGADO — DETALLE MULTI-SUBÁREA ──────────────
function abrirDetalle(id) {
  ordenDetalle = ordenes.find(o => o.id === id);
  if (!ordenDetalle) return;
  estadoSelMap = {}; fotoB64Map = {};
  document.getElementById('detOf').textContent  = ordenDetalle.of;
  document.getElementById('detSub').textContent =
    `${ordenDetalle.articulo||'—'} · ${ordenDetalle.color} · ${ordenDetalle.corte_proyectado||'—'} uds · Req. ${ordenDetalle.nro_req}`;
  renderDetalleBody();
  showScreen('scDetalle');
}

function backToList() {
  estadoSelMap = {}; fotoB64Map = {};
  showScreen('scOrdenes');
  renderOrdenes();
}

function renderDetalleBody() {
  const o = ordenDetalle;
  const subs = misSubareas();

  let html = subs.map(key => {
    const sub = SUBAREAS[key];
    const req = sub.requiere;
    const bloqueado = req && estadoActual(o, req.subarea)?.estado !== req.estado;
    const evActual  = estadoActual(o, key);
    const sel = estadoSelMap[key];

    let inner = `<div class="subarea-group">
      <div class="subarea-group-head">
        <div class="subarea-group-name">${sub.label}</div>
        <span class="estado-actual-pill">${evActual ? evActual.estado : bloqueado ? '🔒' : '—'}</span>
      </div>`;

    if (evActual) {
      inner += `<div class="sub-ts" style="margin-bottom:8px;">Último cambio: ${fmtTS(evActual.creado_en)} · ${evActual.usuario}</div>`;
    }

    if (bloqueado) {
      inner += `<div class="lock-notice">⚠ Requiere ${SUBAREAS[req.subarea].label} = ${req.estado}</div>`;
    } else {
      inner += `<div class="estado-grid">
        ${sub.estados.map(e => {
          let cls = sel === e ? selClass(e) : '';
          if (!sel && evActual?.estado === e) cls += ' is-current';
          return `<button class="btn-estado ${cls}" onclick="selEstado('${key}','${e.replace(/'/g,"\\'")}')">${e}</button>`;
        }).join('')}
      </div>`;

      if (key === 'corte_planta' && sel === 'ENTREGADO') {
        const actual = o.corte_real ?? o.corte_proyectado ?? '';
        inner += `<div class="field" style="margin-top:12px;">
          <label>Corte Real (unidades cortadas)</label>
          <input type="number" id="corteRealInput" placeholder="Proyectado: ${o.corte_proyectado ?? '—'}" value="${actual}">
        </div>`;
      }

      inner += `<div class="foto-area">
        <button class="btn-foto" onclick="tomarFoto('${key}')">📷 Foto (opcional)</button>
        <div id="fotoPrev_${key}">${fotoB64Map[key] ? `<div class="foto-thumb-wrap"><img src="${fotoB64Map[key]}" class="foto-thumb"><button class="foto-delete" onclick="eliminarFoto('${key}')" title="Quitar foto">✕</button></div>` : ''}</div>
      </div>
      <button class="btn btn-accent btn-full" style="margin-top:10px;" onclick="guardarEstado('${key}')" ${!sel?'disabled':''}>✓ Guardar ${sub.label}</button>`;
    }

    inner += '</div>';
    return inner;
  }).join('');

  document.getElementById('detBody').innerHTML = html;
}

function selEstado(subarea, estado) {
  estadoSelMap[subarea] = estado;
  renderDetalleBody();
}

function eliminarFoto(subarea) {
  delete fotoB64Map[subarea];
  renderDetalleBody();
}

function tomarFoto(subarea) {
  const inp = document.getElementById('fotoInput');
  inp.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      fotoB64Map[subarea] = ev.target.result;
      renderDetalleBody();
      inp.value = '';
    };
    reader.readAsDataURL(file);
  };
  inp.click();
}

async function guardarEstado(subarea) {
  const estado = estadoSelMap[subarea];
  if (!estado) { toast('Selecciona un estado', 'warn'); return; }

  // Corte Real: solo aplica en corte_planta al pasar a ENTREGADO
  let corteReal = null;
  if (subarea === 'corte_planta' && estado === 'ENTREGADO') {
    const input = document.getElementById('corteRealInput');
    const val = input ? parseInt(input.value) : NaN;
    if (isNaN(val) || val < 0) { toast('Ingresa el Corte Real (unidades cortadas)', 'warn'); return; }
    corteReal = val;
  }

  setSyncBar('syncing');
  let foto_url = null;

  // Subir foto primero si hay
  if (fotoB64Map[subarea]) {
    try {
      const blob = await fetch(fotoB64Map[subarea]).then(r => r.blob());
      const path = `eventos/${ordenDetalle.of}_${subarea}_${Date.now()}.jpg`;
      const { error: upErr } = await sb.storage.from('fotos-planta')
        .upload(path, blob, { contentType: 'image/jpeg', upsert: true });
      if (!upErr) foto_url = path;
    } catch { /* foto es opcional, seguimos */ }
    delete fotoB64Map[subarea];
  }

  const { error } = await sb.from('eventos').insert({
    orden_id: ordenDetalle.id,
    subarea,
    estado,
    usuario: session.nombre,
    foto_url,
  });

  if (error) {
    setSyncBar('error');
    toast('Error al guardar — revisa tu conexión', 'err');
    return;
  }

  if (corteReal !== null) {
    await sb.from('ordenes').update({ corte_real: corteReal }).eq('id', ordenDetalle.id);
    await sb.from('eventos').insert({
      orden_id: ordenDetalle.id,
      subarea: 'corte_planta',
      estado: `CORTE REAL REGISTRADO: ${corteReal} uds`,
      usuario: session.nombre,
    });
  }

  delete estadoSelMap[subarea];
  setSyncBar('');
  toast(`${SUBAREAS[subarea].label} → ${estado} ✓`, 'ok');
  await syncFromServer();
  renderDetalleBody();
}

// ─── INGENIERÍA: CREAR ORDEN MANUAL ─────────────────────────
async function crearOrden() {
  const g = id => document.getElementById(id).value.trim();
  const of = g('nOF'), nro_req = g('nReq'), color = g('nColor');
  if (!of || !nro_req || !color) { toast('OF, N° Req. y Color son obligatorios', 'warn'); return; }

  const datos = {
    of, nro_req, color,
    articulo: g('nArticulo') || null,
    modelo: g('nModelo') || null,
    tipo_prenda: g('nTipo') || null,
    canal: g('nCanal') || null,
    corte: g('nCorte') || null,
    apt_target: g('nApt') || null,
    corte_proyectado: parseInt(g('nTotal')) || null,
    fecha_programada: g('nFecha') || null,
    archivado: false,
  };

  if (editingOrdenId) {
    const { error } = await sb.from('ordenes').update(datos).eq('id', editingOrdenId);
    if (error) { toast('Error al guardar: ' + error.message, 'err'); return; }
    toast(`Orden ${of} actualizada`, 'ok');
    cancelarEdicion();
  } else {
    const res = await upsertOrden(datos);
    if (!res.ok) { toast('Error: ' + res.error, 'err'); return; }
    toast(`Orden ${of} guardada`, 'ok');
    ['nOF','nReq','nColor','nArticulo','nModelo','nTipo','nCanal','nCorte','nApt','nTotal','nFecha']
      .forEach(id => document.getElementById(id).value = '');
  }

  await syncFromServer();
  renderIngOrdenes();
}

async function upsertOrden(nueva) {
  // Detectar cambio de fecha ANTES del upsert
  const existente = ordenes.find(o =>
    o.of === nueva.of && o.color === nueva.color && o.nro_req === nueva.nro_req);
  const fechaCambio = existente && nueva.fecha_programada &&
    existente.fecha_programada !== nueva.fecha_programada;

  const { data, error } = await sb.from('ordenes')
    .upsert(nueva, { onConflict: 'of,color,nro_req' })
    .select().single();

  if (error) return { ok: false, error: error.message };

  if (fechaCambio) {
    await sb.from('eventos').insert({
      orden_id: data.id,
      subarea: 'ingenieria',
      estado: `FECHA MODIFICADA: ${existente.fecha_programada} → ${nueva.fecha_programada}`,
      usuario: session.nombre,
    });
  }
  return { ok: true, data, fechaCambio };
}

// ─── INGENIERÍA: IMPORTAR EXCEL ─────────────────────────────
document.getElementById('excelInput')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  let wb;
  try {
    const buf = await file.arrayBuffer();
    wb = XLSX.read(buf, { cellDates: true });
  } catch {
    openImportModal('Error', '<div class="modal-error-item">No se pudo leer el archivo. Verifica que sea un Excel válido (.xlsx, .xls, .csv)</div>');
    return;
  }

  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  if (rows.length < 2) {
    openImportModal('Error', '<div class="modal-error-item">El archivo no tiene filas de datos</div>');
    return;
  }

  // Mapear encabezados (normalizado: mayúsculas, espacios colapsados)
  const norm = s => String(s).toUpperCase().replace(/\s+/g,' ').trim();
  const headerRow = rows[0].map(norm);
  const colMap = {}; // índice de columna → campo BD
  const found = [];
  Object.entries(EXCEL_HEADERS).forEach(([excelH, field]) => {
    const idx = headerRow.findIndex(h => h === norm(excelH));
    if (idx >= 0) { colMap[idx] = field; found.push(excelH); }
  });

  const faltantes = ['OF','COLOR','N° REQ./ PED.'].filter(h => !found.includes(h));
  if (faltantes.length) {
    openImportModal('Encabezados faltantes',
      faltantes.map(h => `<div class="modal-error-item">Falta la columna obligatoria: <strong>${h}</strong></div>`).join('') +
      `<div class="import-sub" style="text-align:left;margin-top:8px;">Encabezados detectados: ${headerRow.filter(Boolean).join(', ')}</div>`);
    return;
  }

  // Validar y construir filas
  const errores = [];
  const validas = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.every(c => String(c).trim() === '')) continue; // fila vacía

    const obj = { archivado: false };
    Object.entries(colMap).forEach(([idx, field]) => {
      obj[field] = String(row[idx] ?? '').trim() || null;
    });

    const nFila = i + 1;
    if (!obj.of)      { errores.push(`Fila ${nFila}: falta OF`); continue; }
    if (!obj.color)   { errores.push(`Fila ${nFila}: falta COLOR`); continue; }
    if (!obj.nro_req) { errores.push(`Fila ${nFila}: falta N° REQ./ PED.`); continue; }

    if (obj.total != null) {
      const n = parseInt(String(obj.total).replace(/[,.\s]/g,''));
      if (isNaN(n)) { errores.push(`Fila ${nFila}: Total "${obj.total}" no es un número`); continue; }
      obj.total = n;
    }

    if (obj.fecha_programada) {
      const parsed = parseFecha(obj.fecha_programada);
      if (!parsed) { errores.push(`Fila ${nFila}: FECHA "${obj.fecha_programada}" no tiene formato válido (dd/mm/yyyy)`); continue; }
      obj.fecha_programada = parsed;
    }

    validas.push(obj);
  }

  if (!validas.length) {
    openImportModal('Sin filas válidas',
      errores.map(e => `<div class="modal-error-item">${e}</div>`).join(''));
    return;
  }

  // Upsert una por una para detectar cambios de fecha
  setSyncBar('syncing');
  let insertadas = 0, actualizadas = 0, cambiosFecha = 0;
  const erroresBD = [];

  for (const v of validas) {
    const existia = ordenes.some(o => o.of === v.of && o.color === v.color && o.nro_req === v.nro_req);
    const res = await upsertOrden(v);
    if (!res.ok) { erroresBD.push(`OF ${v.of} (${v.color}): ${res.error}`); continue; }
    if (existia) actualizadas++; else insertadas++;
    if (res.fechaCambio) cambiosFecha++;
  }

  await syncFromServer();
  setSyncBar('');
  renderIngOrdenes();

  let body = `<div class="import-sub" style="text-align:left;">
    ✅ <strong>${insertadas}</strong> órdenes nuevas<br>
    🔄 <strong>${actualizadas}</strong> órdenes actualizadas<br>
    ${cambiosFecha ? `📅 <strong>${cambiosFecha}</strong> cambios de fecha registrados como alerta<br>` : ''}
  </div>`;
  if (errores.length)   body += '<div class="sec-title" style="margin-top:12px;">Filas omitidas</div>' + errores.map(e => `<div class="modal-error-item">${e}</div>`).join('');
  if (erroresBD.length) body += '<div class="sec-title" style="margin-top:12px;">Errores de guardado</div>' + erroresBD.map(e => `<div class="modal-error-item">${e}</div>`).join('');

  openImportModal('Resultado de importación', body);
});

function parseFecha(s) {
  s = String(s).trim();
  // dd/mm/yyyy o d/m/yyyy
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  // yyyy-mm-dd (ya válido)
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // Date object serializado por SheetJS
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0,10);
  }
  return null;
}

// ─── INGENIERÍA: LISTA ÓRDENES ──────────────────────────────
function renderIngOrdenes() {
  const el = document.getElementById('listIngOrdenes');
  const term = document.getElementById('searchIng')?.value || '';
  let lista = ordenes.filter(o => !o.archivado && matchesSearch(o, term));

  if (filterIng === 'pendiente')  lista = lista.filter(o => calcProgress(o) === 0);
  if (filterIng === 'en_proceso') lista = lista.filter(o => { const p = calcProgress(o); return p > 0 && p < 100; });
  if (filterIng === 'completado') lista = lista.filter(o => calcProgress(o) === 100);

  if (!lista.length) { el.innerHTML = emptyHTML('📦','Sin órdenes','Crea una o importa un Excel'); return; }

  el.innerHTML = lista.map(o => {
    const pct = calcProgress(o);
    return `<div class="card card-clickable" onclick="abrirIngDetalle('${o.id}')">
      <div class="card-head">
        <div style="min-width:0;">
          <div class="card-of">${o.of}</div>
          <div class="card-meta">${o.articulo||'—'} · ${o.color} · ${o.corte_proyectado||'—'} uds · Req. ${o.nro_req} · ${o.fecha_programada||'—'}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
          <span class="badge ${pct===100?'badge-green':pct>0?'badge-blue':'badge-gray'}">${pct}%</span>
          <div style="display:flex;gap:4px;">
            <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();editarOrden('${o.id}')">Editar</button>
            <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();archivarOrden('${o.id}','${o.of}')">Archivar</button>
          </div>
        </div>
      </div>
      <div class="prog-wrap">
        <div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div>
      </div>
    </div>`;
  }).join('');
}

function editarOrden(id) {
  const o = ordenes.find(x => x.id === id);
  if (!o) return;
  editingOrdenId = id;
  document.getElementById('nOF').value = o.of;
  document.getElementById('nReq').value = o.nro_req;
  document.getElementById('nColor').value = o.color;
  document.getElementById('nArticulo').value = o.articulo || '';
  document.getElementById('nModelo').value = o.modelo || '';
  document.getElementById('nTipo').value = o.tipo_prenda || '';
  document.getElementById('nCanal').value = o.canal || '';
  document.getElementById('nCorte').value = o.corte || '';
  document.getElementById('nApt').value = o.apt_target || '';
  document.getElementById('nTotal').value = o.corte_proyectado || '';
  document.getElementById('nFecha').value = o.fecha_programada || '';
  document.getElementById('btnCrearOrden').textContent = `✓ Guardar cambios — ${o.of}`;
  document.getElementById('btnCancelarEdicion').style.display = 'block';
  document.querySelector('#scIngOrdenes .card').scrollIntoView({ behavior: 'smooth' });
  toast('Editando orden — modifica los campos y guarda', 'warn');
}

function cancelarEdicion() {
  editingOrdenId = null;
  ['nOF','nReq','nColor','nArticulo','nModelo','nTipo','nCanal','nCorte','nApt','nTotal','nFecha']
    .forEach(id => document.getElementById(id).value = '');
  document.getElementById('btnCrearOrden').textContent = '＋ Crear orden';
  document.getElementById('btnCancelarEdicion').style.display = 'none';
}

function archivarOrden(id, of) {
  openConfirm(`Archivar orden ${of}`, 'La orden dejará de aparecer en las listas, pero su historial se conserva. ¿Continuar?', async () => {
    const { error } = await sb.from('ordenes').update({ archivado: true }).eq('id', id);
    if (error) { toast('Error al archivar', 'err'); return; }
    toast(`Orden ${of} archivada`, 'ok');
    await syncFromServer();
    renderIngOrdenes();
  });
}

// ─── DETALLE (ing = editable / gerencia = solo lectura) ─────
let ingDetalleReturn = 'scIngSeg';
let ingOrdenDetalle  = null;
let adminEstadoSelMap = {};
let adminFotoB64Map   = {};

function abrirIngDetalle(id, returnScreen) {
  ingDetalleReturn = returnScreen || (session.area === 'gerencia' ? 'scGerencia' : 'scIngSeg');
  const o = ordenes.find(x => x.id === id);
  if (!o) return;
  document.getElementById('ingDetOf').textContent  = o.of;
  document.getElementById('ingDetSub').textContent =
    `${o.articulo||'—'} · ${o.color} · Req. ${o.nro_req} · ${o.corte_proyectado||'—'} uds · ${o.fecha_programada||'—'}`;

  if (session.area === 'ingenieria') {
    ingOrdenDetalle = o;
    adminEstadoSelMap = {};
    adminFotoB64Map = {};
    renderIngDetalleBody();
  } else {
    // Gerencia: solo lectura
    const body = Object.entries(SUBAREAS).map(([key, sub]) => {
      const ev   = estadoActual(o, key);
      const est  = ev?.estado;
      const req  = sub.requiere;
      const bloq = req && estadoActual(o, req.subarea)?.estado !== req.estado;
      const cls  = isFinal(est) ? 'done'
                 : est && (est.includes('RECHAZADO')||est.includes('FALTA')) ? 'rejected'
                 : est ? 'progress'
                 : bloq ? 'locked' : '';
      return `<div class="sub-card ${cls}">
        <div class="sub-name">${sub.label}</div>
        <div class="sub-state">${bloq && !est ? '🔒 Bloqueado' : (est || '— Sin estado')}</div>
        ${key === 'corte_planta' && o.corte_real != null ? `<div class="sub-ts">✂️ Corte Real: ${o.corte_real} uds (Proyectado: ${o.corte_proyectado ?? '—'})</div>` : ''}
        ${ev ? `<div class="sub-ts">📅 ${fmtTS(ev.creado_en)} · ${ev.usuario}</div>` : ''}
      </div>`;
    }).join('');
    document.getElementById('ingDetBody').innerHTML = body;
  }

  showScreen('scIngDetalle');
}

// Ingeniería puede editar el estado de CUALQUIER subárea desde aquí.
// El estado actual siempre se resalta en verde para dejar claro qué
// se está sobrescribiendo.
function renderIngDetalleBody() {
  const o = ingOrdenDetalle;
  const html = Object.entries(SUBAREAS).map(([key, sub]) => {
    const req  = sub.requiere;
    const evActual = estadoActual(o, key);
    const sel = adminEstadoSelMap[key];

    let inner = `<div class="subarea-group">
      <div class="subarea-group-head">
        <div class="subarea-group-name">${sub.label}</div>
        <span class="estado-actual-pill">${evActual ? evActual.estado : '—'}</span>
      </div>`;

    if (evActual) {
      inner += `<div class="sub-ts" style="margin-bottom:8px;">Último cambio: ${fmtTS(evActual.creado_en)} · ${evActual.usuario}</div>`;
    }
    if (key === 'corte_planta' && o.corte_real != null) {
      inner += `<div class="sub-ts" style="margin-bottom:8px;">✂️ Corte Real: ${o.corte_real} uds (Proyectado: ${o.corte_proyectado ?? '—'})</div>`;
    }
    if (req) {
      const reqOK = estadoActual(o, req.subarea)?.estado === req.estado;
      if (!reqOK) inner += `<div class="lock-notice">ℹ Normalmente requiere ${SUBAREAS[req.subarea].label} = ${req.estado} — como Ingeniería, puedes forzar el cambio igual.</div>`;
    }

    inner += `<div class="estado-grid">
      ${sub.estados.map(e => {
        let cls = sel === e ? selClass(e) : '';
        if (!sel && evActual?.estado === e) cls += ' is-current';
        return `<button class="btn-estado ${cls}" onclick="selEstadoAdmin('${key}','${e.replace(/'/g,"\\'")}')">${e}</button>`;
      }).join('')}
    </div>`;

    if (key === 'corte_planta' && sel === 'ENTREGADO') {
      const actual = o.corte_real ?? o.corte_proyectado ?? '';
      inner += `<div class="field" style="margin-top:12px;">
        <label>Corte Real (unidades cortadas)</label>
        <input type="number" id="corteRealInputAdmin" placeholder="Proyectado: ${o.corte_proyectado ?? '—'}" value="${actual}">
      </div>`;
    }

    inner += `<div class="foto-area">
      <button class="btn-foto" onclick="tomarFotoAdmin('${key}')">📷 Foto (opcional)</button>
      <div id="fotoPrevAdmin_${key}">${adminFotoB64Map[key] ? `<div class="foto-thumb-wrap"><img src="${adminFotoB64Map[key]}" class="foto-thumb"><button class="foto-delete" onclick="eliminarFotoAdmin('${key}')" title="Quitar foto">✕</button></div>` : ''}</div>
    </div>
    <button class="btn btn-accent btn-full" style="margin-top:10px;" onclick="guardarEstadoAdmin('${key}')" ${!sel?'disabled':''}>✓ Guardar ${sub.label}</button>
    </div>`;

    return inner;
  }).join('');

  document.getElementById('ingDetBody').innerHTML = html;
}

function selEstadoAdmin(subarea, estado) {
  adminEstadoSelMap[subarea] = estado;
  renderIngDetalleBody();
}

function tomarFotoAdmin(subarea) {
  const inp = document.getElementById('fotoInput');
  inp.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      adminFotoB64Map[subarea] = ev.target.result;
      renderIngDetalleBody();
      inp.value = '';
    };
    reader.readAsDataURL(file);
  };
  inp.click();
}

function eliminarFotoAdmin(subarea) {
  delete adminFotoB64Map[subarea];
  renderIngDetalleBody();
}

async function guardarEstadoAdmin(subarea) {
  const estado = adminEstadoSelMap[subarea];
  if (!estado) { toast('Selecciona un estado', 'warn'); return; }

  let corteReal = null;
  if (subarea === 'corte_planta' && estado === 'ENTREGADO') {
    const input = document.getElementById('corteRealInputAdmin');
    const val = input ? parseInt(input.value) : NaN;
    if (isNaN(val) || val < 0) { toast('Ingresa el Corte Real (unidades cortadas)', 'warn'); return; }
    corteReal = val;
  }

  setSyncBar('syncing');
  let foto_url = null;
  if (adminFotoB64Map[subarea]) {
    try {
      const blob = await fetch(adminFotoB64Map[subarea]).then(r => r.blob());
      const path = `eventos/${ingOrdenDetalle.of}_${subarea}_${Date.now()}.jpg`;
      const { error: upErr } = await sb.storage.from('fotos-planta').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
      if (!upErr) foto_url = path;
    } catch { /* opcional */ }
    delete adminFotoB64Map[subarea];
  }

  const { error } = await sb.from('eventos').insert({
    orden_id: ingOrdenDetalle.id, subarea, estado,
    usuario: `${session.nombre} (admin)`, foto_url,
  });
  if (error) { setSyncBar('error'); toast('Error al guardar', 'err'); return; }

  if (corteReal !== null) {
    await sb.from('ordenes').update({ corte_real: corteReal }).eq('id', ingOrdenDetalle.id);
    await sb.from('eventos').insert({
      orden_id: ingOrdenDetalle.id, subarea: 'corte_planta',
      estado: `CORTE REAL REGISTRADO: ${corteReal} uds`,
      usuario: `${session.nombre} (admin)`,
    });
  }

  delete adminEstadoSelMap[subarea];
  setSyncBar('');
  toast(`${SUBAREAS[subarea].label} → ${estado} ✓`, 'ok');
  await syncFromServer();
  ingOrdenDetalle = ordenes.find(x => x.id === ingOrdenDetalle.id);
  renderIngDetalleBody();
}

function backIngDetalle() {
  showScreen(ingDetalleReturn);
  if (ingDetalleReturn === 'scGerencia') renderGerencia();
  else renderSeg();
}

// ─── SEGUIMIENTO ────────────────────────────────────────────
function renderSeg() {
  const el = document.getElementById('listSeg');
  const term = document.getElementById('searchSeg')?.value || '';
  let lista = ordenes.filter(o => !o.archivado && matchesSearch(o, term));

  if (filterSeg === 'alerta')    lista = lista.filter(tieneAlerta);
  if (filterSeg === 'bloqueado') lista = lista.filter(estaBloqueada);
  if (filterSeg === 'completo')  lista = lista.filter(o => calcProgress(o) === 100);

  if (!lista.length) { el.innerHTML = emptyHTML('✅','Sin resultados',''); return; }

  el.innerHTML = lista.map(o => segCardHTML(o)).join('');
}

function segCardHTML(o) {
  const pct = calcProgress(o);
  const badges = Object.entries(SUBAREAS).map(([key]) => {
    const ev = estadoActual(o, key);
    if (!ev) return '';
    return `<span class="badge ${badgeForEstado(ev.estado)}" style="margin:2px;">${ev.estado}</span>`;
  }).filter(Boolean).join('');

  return `<div class="card card-clickable" onclick="abrirIngDetalle('${o.id}')">
    <div class="card-head">
      <div style="min-width:0;">
        <div class="card-of">${o.of}</div>
        <div class="card-meta">${o.color} · ${o.articulo||'—'} · ${o.corte_proyectado||'—'} uds · ${o.fecha_programada||'—'}</div>
      </div>
      <span class="badge ${pct===100?'badge-green':pct>0?'badge-blue':'badge-gray'}">${pct}%</span>
    </div>
    <div style="margin:8px 0;display:flex;flex-wrap:wrap;">${badges||'<span style="font-size:12px;color:var(--text-faint)">Sin actividad</span>'}</div>
    <div class="prog-wrap"><div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div></div>
  </div>`;
}

// ─── HISTORIAL ──────────────────────────────────────────────
function renderHist() {
  const el = document.getElementById('listHist');
  let lista = [...eventos].sort((a,b) => new Date(b.creado_en)-new Date(a.creado_en));

  if (filterHist !== 'todas') {
    const grupo = filterHist === 'ingenieria' ? ['ingenieria'] : (AREA_SUBAREAS[filterHist] || []);
    lista = lista.filter(ev => grupo.includes(ev.subarea));
  }
  lista = lista.slice(0, 200);

  if (!lista.length) { el.innerHTML = emptyHTML('📜','Sin eventos',''); return; }
  el.innerHTML = lista.map(ev => {
    const o = ordenes.find(x => x.id === ev.orden_id);
    return `<div class="hist-item">
      <div class="hist-dot"></div>
      <div>
        <div class="hist-main">${o?.of||'—'} · ${SUBAREAS[ev.subarea]?.label||cap(ev.subarea)} → ${ev.estado}</div>
        <div class="hist-meta">📅 ${fmtTS(ev.creado_en)} · 👤 ${ev.usuario}</div>
      </div>
    </div>`;
  }).join('');
}

// ─── GERENCIA: DASHBOARD ────────────────────────────────────
function renderGerencia() {
  const activas    = ordenes.filter(o => !o.archivado);
  const alertas    = activas.filter(tieneAlerta);
  const bloqueadas = activas.filter(estaBloqueada);
  const completas  = activas.filter(o => calcProgress(o) === 100);
  const term       = document.getElementById('searchGer')?.value || '';
  const filtradas  = activas.filter(o => matchesSearch(o, term));

  document.getElementById('kpiGrid').innerHTML = `
    <div class="kpi"><div class="kpi-num">${activas.length}</div><div class="kpi-label">Órdenes activas</div></div>
    <div class="kpi"><div class="kpi-num good">${completas.length}</div><div class="kpi-label">Completadas</div></div>
    <div class="kpi"><div class="kpi-num warn">${bloqueadas.length}</div><div class="kpi-label">Bloqueadas</div></div>
    <div class="kpi"><div class="kpi-num bad">${alertas.length}</div><div class="kpi-label">En alerta</div></div>`;

  document.getElementById('gerAlertas').innerHTML    = alertas.length    ? alertas.map(segCardHTML).join('')    : emptyHTML('✅','Sin alertas','');
  document.getElementById('gerBloqueadas').innerHTML = bloqueadas.length ? bloqueadas.map(segCardHTML).join('') : emptyHTML('🔓','Nada bloqueado','');
  document.getElementById('gerTodas').innerHTML      = filtradas.length  ? filtradas.map(segCardHTML).join('')  : emptyHTML('📦','Sin resultados','');
}

// ─── USUARIOS (admin) ───────────────────────────────────────
async function crearUsuario() {
  const nombre = document.getElementById('uNombre').value.trim();
  const area   = document.getElementById('uArea').value;
  if (!nombre) { toast('Ingresa el nombre', 'warn'); return; }

  const { data, error } = await sb.rpc('crear_usuario', { p_nombre: nombre, p_area: area });
  if (error) { toast('Error de conexión', 'err'); return; }
  if (!data.ok) { toast(data.error, 'err'); return; }

  document.getElementById('uNombre').value = '';
  toast(`Usuario ${nombre} creado — PIN inicial: 1111`, 'ok');
  renderUsers();
}

async function renderUsers() {
  const el = document.getElementById('listUsers');
  const { data, error } = await sb.from('usuarios_admin').select('*').order('area').order('nombre');
  if (error || !data) { el.innerHTML = emptyHTML('⚠','Error cargando usuarios',''); return; }

  let lista = data;
  if (filterUsers === 'activos')       lista = lista.filter(u => u.activo);
  if (filterUsers === 'inactivos')     lista = lista.filter(u => !u.activo);
  if (filterUsers === 'pin_pendiente') lista = lista.filter(u => u.debe_cambiar_pin);

  if (!lista.length) { el.innerHTML = emptyHTML('👤','Sin resultados',''); return; }

  el.innerHTML = lista.map(u => `
    <div class="user-row" style="${!u.activo?'opacity:.5;':''}">
      <div class="user-info">
        <div class="user-name">${u.nombre} ${u.debe_cambiar_pin?'<span class="badge badge-yellow">PIN pendiente</span>':''}</div>
        <div class="user-area">${cap(u.area)} · PIN actualizado ${fmtFecha(u.pin_actualizado_en)}</div>
      </div>
      <div class="user-actions">
        <button class="btn btn-sm btn-ghost" onclick="resetPin('${u.id}','${u.nombre}')">Reset PIN</button>
        <button class="btn btn-sm ${u.activo?'btn-danger':'btn-primary'}" onclick="toggleUser('${u.id}',${!u.activo},'${u.nombre}')">${u.activo?'Desactivar':'Activar'}</button>
      </div>
    </div>`).join('');
}

function resetPin(id, nombre) {
  openConfirm(`Resetear PIN de ${nombre}`, 'El PIN volverá a 1111 y el usuario deberá cambiarlo en su próximo ingreso. ¿Continuar?', async () => {
    const { data, error } = await sb.rpc('resetear_pin', { p_id: id });
    if (error || !data.ok) { toast('Error al resetear', 'err'); return; }
    toast(`PIN de ${nombre} reseteado a 1111`, 'ok');
    renderUsers();
  });
}

function toggleUser(id, activo, nombre) {
  const accion = activo ? 'activar' : 'desactivar';
  openConfirm(`${cap(accion)} a ${nombre}`, `¿Seguro que deseas ${accion} este usuario?`, async () => {
    const { data, error } = await sb.rpc('toggle_usuario', { p_id: id, p_activo: activo });
    if (error || !data.ok) { toast('Error', 'err'); return; }
    toast(`Usuario ${nombre} ${activo?'activado':'desactivado'}`, 'ok');
    renderUsers();
  });
}

// ─── MODAL: CAMBIO DE PIN ───────────────────────────────────
function openPinModal(forzado) {
  pinForzado = forzado;
  document.getElementById('pinModalTitle').textContent = forzado ? 'Debes cambiar tu PIN' : 'Cambiar PIN';
  document.getElementById('pinModalMsg').innerHTML = forzado
    ? 'Es tu primer ingreso (o tu PIN fue reseteado). Por seguridad debes definir un PIN propio antes de continuar. Tu PIN actual es <strong>1111</strong>.'
    : 'Ingresa tu PIN actual y el nuevo.';
  document.getElementById('pinModalCancel').style.display = forzado ? 'none' : 'block';
  document.getElementById('pinActual').value = forzado ? '1111' : '';
  document.getElementById('pinNuevo').value = '';
  document.getElementById('pinNuevo2').value = '';
  document.getElementById('pinModal').classList.add('open');
}

function closePinModal() {
  if (pinForzado) return; // no se puede cerrar si es forzado
  document.getElementById('pinModal').classList.remove('open');
}

async function submitPinChange() {
  const actual = document.getElementById('pinActual').value;
  const nuevo  = document.getElementById('pinNuevo').value;
  const nuevo2 = document.getElementById('pinNuevo2').value;

  if (!/^[0-9]{1,6}$/.test(nuevo)) { toast('El PIN debe ser solo números, 1 a 6 dígitos', 'warn'); return; }
  if (nuevo !== nuevo2) { toast('Los PIN nuevos no coinciden', 'warn'); return; }
  if (nuevo === '1111') { toast('No puedes usar 1111 como PIN propio', 'warn'); return; }

  const { data, error } = await sb.rpc('cambiar_pin', {
    p_id: session.id, p_pin_actual: actual, p_pin_nuevo: nuevo });

  if (error) { toast('Error de conexión', 'err'); return; }
  if (!data.ok) { toast(data.error, 'err'); return; }

  pinForzado = false;
  session.debe_cambiar_pin = false;
  document.getElementById('pinModal').classList.remove('open');
  toast('PIN actualizado ✓', 'ok');
}

// ─── MODALES GENÉRICOS ──────────────────────────────────────
function openImportModal(title, bodyHTML) {
  document.getElementById('importModalTitle').textContent = title;
  document.getElementById('importModalBody').innerHTML = bodyHTML;
  document.getElementById('importModal').classList.add('open');
}
function closeImportModal() {
  document.getElementById('importModal').classList.remove('open');
}

function openConfirm(title, msg, cb) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMsg').textContent = msg;
  confirmCb = cb;
  document.getElementById('confirmModal').classList.add('open');
}
function closeConfirm(accepted) {
  document.getElementById('confirmModal').classList.remove('open');
  if (accepted && confirmCb) confirmCb();
  confirmCb = null;
}

// ─── SYNC ───────────────────────────────────────────────────
async function syncFromServer() {
  setSyncBar('syncing');
  try {
    const [{ data: ords, error: e1 }, { data: evs, error: e2 }] = await Promise.all([
      sb.from('ordenes').select('*').order('creado_en', { ascending: false }),
      sb.from('eventos').select('*').order('creado_en', { ascending: false }).limit(1000),
    ]);
    if (e1 || e2) throw new Error();
    ordenes = ords || [];
    eventos = evs || [];
    setSyncBar('');
  } catch {
    setSyncBar('error');
  }
}

// Refresco automático cada 60s (para ver cambios de otros usuarios)
setInterval(async () => {
  if (!session) return;
  await syncFromServer();
  // Re-render de la pantalla visible
  const active = document.querySelector('.screen.active')?.id;
  const renders = {
    scOrdenes: renderOrdenes, scIngOrdenes: renderIngOrdenes,
    scIngSeg: renderSeg, scIngHist: renderHist,
    scGerencia: renderGerencia,
  };
  renders[active]?.();
}, 60000);

// ─── UTILS ──────────────────────────────────────────────────
function fmtTS(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('es-PE',{day:'2-digit',month:'short',year:'numeric'}) + ' · ' +
         d.toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function fmtFecha(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('es-PE',{day:'2-digit',month:'short'});
}
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function emptyHTML(icon, text, sub) {
  return `<div class="empty"><div class="empty-icon">${icon}</div><div class="empty-text">${text}</div>${sub?`<div class="empty-sub">${sub}</div>`:''}</div>`;
}
function toast(msg, type='') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' '+type : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}
function setSyncBar(state) {
  const bar = document.getElementById('syncBar');
  bar.className = 'syncbar' + (state ? ' '+state : '');
  const msgs = { pending:'● Cambios pendientes', syncing:'⟳ Sincronizando...', error:'⚠ Sin conexión' };
  bar.textContent = msgs[state] || '';
}

// Enter para login
document.getElementById('loginPin')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});