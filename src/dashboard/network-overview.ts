/**
 * ASTON NETWORK OPERATIONS CENTER — SECTION 01
 * Network Overview & Infrastructure Health
 * Read-only view. Uses existing /health and /v1/infra/status contracts.
 * "live" means the binding is present in the Worker environment; it does
 * not prove service health, validation, production traffic, or SLA.
 */
const HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const CSS = `
:root{color-scheme:dark;--bg:#050b14;--panel:#091725;--line:#17374b;--cyan:#46d9ff;--green:#48dfb1;--amber:#ffc36a;--red:#ff7182;--muted:#91aabd}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 50% -15%,#10334b 0,#050b14 58%);color:#e8f5fc;font:14px/1.5 Inter,ui-sans-serif,system-ui,Segoe UI,sans-serif}
header{padding:22px clamp(16px,4vw,48px);border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:18px;background:#06111deF;position:sticky;top:0;z-index:2}
.brand{display:flex;gap:14px;align-items:center}.mark{font-size:30px;font-weight:900;color:var(--cyan)}h1{font-size:16px;letter-spacing:.14em;margin:0}.sub{font-size:11px;color:var(--muted);margin-top:3px}
main{max-width:1440px;margin:auto;padding:26px clamp(16px,4vw,48px) 44px}.eyebrow{color:var(--cyan);font-size:10px;letter-spacing:.2em;text-transform:uppercase}.intro{display:flex;justify-content:space-between;align-items:end;gap:20px;margin:10px 0 22px}.intro h2{font-size:clamp(23px,3vw,34px);margin:5px 0}.intro p{color:var(--muted);margin:0;max-width:700px}.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
button{background:#0c2b3d;color:var(--cyan);border:1px solid #1a6681;padding:9px 13px;border-radius:6px;font:inherit;font-size:11px;letter-spacing:.08em;cursor:pointer}button:hover{background:#10405a}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:18px 0}.metric,.panel{background:linear-gradient(145deg,#0b1d2c,#07121e);border:1px solid var(--line);border-radius:9px}.metric{padding:16px;min-height:110px}.metric small{color:var(--muted);text-transform:uppercase;letter-spacing:.1em;font-size:10px}.metric strong{display:block;font-size:27px;margin-top:8px}.metric em{font-style:normal;color:var(--muted);font-size:10px}
.layout{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(280px,.8fr);gap:14px}.panel{padding:18px;margin-bottom:14px}.panelhead{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}.panel h3{font-size:12px;letter-spacing:.12em;margin:0}.tag{font-size:9px;letter-spacing:.08em;color:var(--cyan);border:1px solid #1a536a;border-radius:20px;padding:4px 8px}
.rows{display:grid;gap:8px}.resource{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px;border:1px solid #15364a;border-radius:7px;background:#071521}.resource strong{display:block;font-size:12px}.resource small{display:block;color:var(--muted);font-size:10px;margin-top:3px}.state{font-size:9px;letter-spacing:.08em;padding:4px 7px;border:1px solid #3b5362;border-radius:4px;white-space:nowrap;color:var(--muted)}.state.bound{color:var(--green);border-color:#18765e}.state.soft{color:var(--amber);border-color:#785522}.state.planned{color:#a9b7c2;border-color:#465461}.state.error{color:var(--red);border-color:#843c49}
.note{font-size:11px;color:var(--muted);border-left:2px solid #24708b;padding:9px 12px;background:#081a27;margin-top:12px}.healthrow{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid #153247;font-size:11px}.healthrow:last-child{border:0}.healthrow span:first-child{color:var(--muted)}.legend{display:flex;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:10px;margin:12px 0}.legend b{color:#e8f5fc;font-weight:600}
footer{padding:14px clamp(16px,4vw,48px);border-top:1px solid var(--line);color:var(--muted);font-size:10px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
@media(max-width:900px){.layout{grid-template-columns:1fr}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:560px){header{align-items:flex-start}.intro{align-items:flex-start;flex-direction:column}.grid{gap:8px}.metric{padding:12px;min-height:96px}.metric strong{font-size:22px}.resource{grid-template-columns:1fr;gap:8px}.state{justify-self:start}}
`;

const JS = `
const el=(id)=>document.getElementById(id);
const put=(id,v)=>{const n=el(id);if(n)n.textContent=String(v??"—")};
const esc=(v)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function get(path){const r=await fetch(path,{headers:{Accept:"application/json"},credentials:"same-origin",cache:"no-store"});if(!r.ok)throw new Error("HTTP "+r.status);return r.json()}
function renderInfra(d){
 const s=d.summary||{},items=Array.isArray(d.items)?d.items:[];
 put("live",s.live);put("soft",s.soft);put("planned",s.planned);put("total",s.total);
 el("resources").innerHTML=items.map(x=>{
  const phase=["live","soft","planned"].includes(x.phase)?x.phase:"planned";
  const label=phase==="live"?"BINDING PRESENT":phase==="soft"?"PARTIAL / OPTIONAL":"PLANNED";
  const bound=x.bound===true?"Binding detectado":x.bound===false?"Sin binding":"Binding no informado";
  return '<div class="resource"><div><strong>'+esc(x.cloudflare||x.id)+'</strong><small>'+esc(x.role||"Rol no declarado")+' · '+esc(bound)+(x.aston_route?" · "+esc(x.aston_route):"")+'</small></div><span class="state '+phase+'">'+label+'</span></div>';
 }).join("")||'<div class="resource">La API no devolvió recursos.</div>';
 put("infra-status","API respondió");put("infra-error","");
}
function renderHealth(d){
 put("service",d.service||"ASTON OS");put("version",d.version);put("profile",d.profile);
 put("health","OK");put("health-time",d.ts?new Date(d.ts).toLocaleString():"Timestamp no informado");
 const p=d.pillars||{};
 el("pillars").innerHTML=Object.entries(p).map(([k,v])=>'<div class="healthrow"><span>'+esc(k.replaceAll("_"," "))+'</span><b class="state '+(v===true?"bound":v===false?"planned":"")+'">'+(v===true?"PRESENTE":v===false?"AUSENTE":"SIN DATO")+'</b></div>').join("")||'<div class="note">La respuesta no incluye pilares.</div>';
}
async function refresh(){
 put("refresh","Consultando…");put("health","Consultando");put("infra-status","Consultando");
 const results=await Promise.allSettled([get("/health"),get("/v1/infra/status")]);
 if(results[0].status==="fulfilled"){const d=results[0].value;renderHealth(d)}else{put("health","NO DISPONIBLE");put("service","Sin respuesta");put("health-error",results[0].reason?.message||"Error")}
 if(results[1].status==="fulfilled"){renderInfra(results[1].value)}else{put("infra-status","NO DISPONIBLE");put("infra-error",results[1].reason?.message||"Error");el("resources").innerHTML='<div class="note">No se pudo consultar el inventario.</div>'}
 put("refresh", "ACTUALIZAR");put("updated",new Date().toLocaleString());
}
el("refresh").addEventListener("click",refresh);refresh();
`;

const HTML = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>ASTON NOC — Section 01</title><link rel="stylesheet" href="/network.css"></head>
<body>
<header><div class="brand"><div class="mark">A</div><div><h1>ASTON NETWORK OPERATIONS CENTER</h1><div class="sub">TRUST INFRASTRUCTURE · READ-ONLY OPERATIONS</div></div></div><div class="actions"><span class="tag">SECTION 01 / 08</span><button id="refresh" type="button">ACTUALIZAR</button></div></header>
<main>
<div class="eyebrow">01 — Network overview & infrastructure health</div>
<div class="intro"><div><h2>Infrastructure Overview</h2><p>Inventario de recursos y bindings declarados por ASTON OS. La presencia de un binding no implica validación funcional, disponibilidad externa ni operación en producción.</p></div></div>
<section class="grid">
<div class="metric"><small>Live · binding presente</small><strong id="live">—</strong><em>Declarado por el inventario</em></div>
<div class="metric"><small>Soft · parcial / opcional</small><strong id="soft">—</strong><em>No equivale a servicio validado</em></div>
<div class="metric"><small>Planned · planificado</small><strong id="planned">—</strong><em>Sin binding operativo declarado</em></div>
<div class="metric"><small>Inventario total</small><strong id="total">—</strong><em>Elementos devueltos por la API</em></div>
</section>
<div class="layout">
<div>
<section class="panel"><div class="panelhead"><h3>INFRASTRUCTURE RESOURCE INVENTORY</h3><span class="tag" id="infra-status">ESPERANDO API</span></div><div id="resources" class="rows"><div class="note">Consultando /v1/infra/status…</div></div><div class="legend"><span><b>LIVE</b> = binding presente</span><span><b>SOFT</b> = parcial u opcional</span><span><b>PLANNED</b> = planificado</span></div></section>
<section class="panel"><div class="panelhead"><h3>NETWORK TOPOLOGY STATUS</h3><span class="tag">EVIDENCE-BASED</span></div><div class="note">El contrato disponible expone un inventario de infraestructura, pero no publica relaciones de dependencia, nodos de red, enlaces, regiones, tráfico ni latencias. Por eso esta sección no dibuja conexiones ficticias. El mapa topológico quedará pendiente hasta disponer de una fuente verificable para esos datos.</div></section>
</div>
<aside>
<section class="panel"><div class="panelhead"><h3>WORKER HEALTH</h3><span class="tag" id="health">ESPERANDO API</span></div>
<div class="healthrow"><span>Servicio</span><b id="service">—</b></div><div class="healthrow"><span>Versión</span><b id="version">—</b></div><div class="healthrow"><span>Perfil</span><b id="profile">—</b></div><div class="healthrow"><span>Respuesta registrada</span><b id="health-time">—</b></div><div id="health-error" class="note"></div></section>
<section class="panel"><div class="panelhead"><h3>RUNTIME PILLARS</h3><span class="tag">/HEALTH</span></div><div id="pillars"><div class="note">Esperando respuesta…</div></div></section>
<section class="panel"><div class="panelhead"><h3>ASSURANCE LEVELS</h3></div>
<div class="healthrow"><span>IMPLEMENTED</span><b>Declarado en código</b></div><div class="healthrow"><span>VALIDATED</span><b>No inferido por binding</b></div><div class="healthrow"><span>PRODUCTION</span><b>No inferido por API</b></div>
<div class="note">Esta pantalla es de solo lectura. No ejecuta cambios, despliegues, migraciones ni acciones sobre recursos Cloudflare.</div></section>
</aside>
</div>
</main>
<footer><span>ASTON NOC · SECTION 01</span><span>Última actualización: <b id="updated">—</b></span><span id="refresh-state">Read-only · no mutations</span></footer>
<script src="/network.js" defer></script></body></html>`;

export function handleNetworkOverviewDashboard(path: string): Response | null {
  if (path === "/network") return new Response(HTML, { status: 200, headers: HEADERS });
  if (path === "/network.css") return new Response(CSS, { status: 200, headers: { ...HEADERS, "Content-Type": "text/css; charset=utf-8" } });
  if (path === "/network.js") return new Response(JS, { status: 200, headers: { ...HEADERS, "Content-Type": "text/javascript; charset=utf-8" } });
  return null;
}
