export const INSTALL_UI = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <meta name="theme-color" content="#10131a" />
  <title>T3 Research</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:#0b0d12; color:#f3f5f7; }
    * { box-sizing:border-box } body { margin:0; min-height:100vh; background:radial-gradient(circle at 80% 0,#18354a 0,transparent 32rem),#0b0d12; }
    main { width:min(1120px,calc(100% - 28px)); margin:auto; padding:32px 0 72px; }
    header { display:flex; justify-content:space-between; align-items:flex-end; gap:18px; margin-bottom:24px; }
    h1,h2,h3,p { margin-top:0 } h1 { font-size:clamp(2rem,6vw,4.2rem); letter-spacing:-.06em; margin-bottom:8px; }
    h2 { font-size:1rem; text-transform:uppercase; letter-spacing:.12em; color:#92a1b3; }
    .lede { color:#aeb8c5; max-width:680px; line-height:1.55; }
    .badge { border:1px solid #2a4658; background:#102332; color:#8bd5ff; padding:7px 11px; border-radius:999px; white-space:nowrap; }
    .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
    .card { border:1px solid #252b36; background:rgba(18,22,30,.9); border-radius:18px; padding:18px; box-shadow:0 18px 50px #0005; }
    .wide { grid-column:1/-1 } label { display:grid; gap:6px; color:#9ca8b8; font-size:.82rem; }
    input,select,textarea,button { font:inherit; border-radius:10px; border:1px solid #303846; }
    input,select,textarea { width:100%; padding:10px 11px; background:#0d1118; color:#f4f6f8; }
    textarea { min-height:100px; resize:vertical; } button { cursor:pointer; padding:9px 12px; background:#1f6c96; color:white; font-weight:650; }
    button.secondary { background:#1a202a } button.danger { background:#792e39 } button:disabled { opacity:.5; cursor:wait }
    .fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
    .actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
    .list { display:grid; gap:9px; } .row { border:1px solid #282f3b; border-radius:12px; padding:12px; display:flex; justify-content:space-between; align-items:center; gap:12px; }
    .row strong { display:block } .muted,.status { color:#96a2b1; font-size:.82rem; } .ok { color:#6de0a7 } .bad { color:#ff8792 }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:420px; overflow:auto; background:#080a0e; padding:14px; border-radius:12px; color:#cbd4df; }
    #notice { position:fixed; right:16px; bottom:16px; max-width:min(420px,calc(100% - 32px)); padding:12px 14px; background:#222b38; border:1px solid #3c4b5f; border-radius:12px; display:none; }
    @media(max-width:760px){ .grid,.fields { grid-template-columns:1fr } .wide { grid-column:auto } header { align-items:flex-start; flex-direction:column } }
  </style>
</head>
<body>
<main>
  <header><div><h1>T3 Research</h1><p class="lede">One durable research context. Swap local models and coding agents without losing the plan, evidence, citations, or decisions.</p></div><span id="health" class="badge">Connecting…</span></header>
  <div class="grid">
    <section class="card"><h2>Installation</h2><p class="muted">Configure an agent, then test it from this machine.</p>
      <form id="provider-form"><div class="fields">
        <label>Name<input name="name" required placeholder="Local Gemma" /></label>
        <label>Driver<select name="driver"><option>ollama</option><option>codex</option><option>claude</option><option>agy</option><option>junie</option><option>mock</option></select></label>
        <label>Model<input name="model" placeholder="gemma4-12b-sys:latest" /></label>
        <label>Endpoint<input name="endpoint" placeholder="http://127.0.0.1:11434" /></label>
        <label>Command<input name="command" placeholder="codex" /></label>
      </div><div class="actions"><button type="submit">Save provider</button><button class="secondary" type="button" id="refresh">Refresh status</button></div></form>
    </section>
    <section class="card"><h2>Agents</h2><div id="providers" class="list"><span class="muted">Loading…</span></div></section>
    <section class="card wide"><h2>Shared memory</h2><div class="grid">
      <form id="memory-form"><div class="fields">
        <label>Name<input name="name" required placeholder="Team Meko" /></label>
        <label>Kind<select name="kind"><option>memo</option><option>meko</option><option>sqlite</option></select></label>
        <label style="grid-column:1/-1">URL<input name="url" placeholder="http://host.docker.internal:8099" /></label>
      </div><div class="actions"><button type="submit">Save memory connector</button></div><p class="muted">Meko authorization stays in <code>T3RESEARCH_MEKO_AUTHORIZATION</code>; it is never saved by this UI.</p></form>
      <div id="memory-connectors" class="list"><span class="muted">Loading…</span></div>
    </div></section>
    <section class="card wide"><h2>New research run</h2><form id="run-form"><div class="fields">
      <label>Title<input name="title" required placeholder="Competitive landscape" /></label>
      <label>Coordinator<select name="providerId" id="provider-select"></select></label>
      <label>Depth<select name="depth"><option>quick</option><option selected>deep</option><option>max</option></select></label>
    </div><label style="margin-top:10px">Research question<textarea name="question" required placeholder="What should we investigate?"></textarea></label><div class="actions"><button type="submit">Create and plan</button></div></form></section>
    <section class="card wide"><h2>Runs</h2><div id="runs" class="list"><span class="muted">No runs yet.</span></div></section>
    <section class="card wide" id="detail-card" hidden><h2>Run detail</h2><div id="run-actions" class="actions"></div><div id="messages" class="list" style="margin-top:14px"></div><form id="chat-form" class="actions"><input name="text" required placeholder="Continue this run with the active agent…" style="flex:1;min-width:220px" /><button type="submit">Send</button></form><pre id="detail"></pre></section>
  </div>
</main><div id="notice"></div>
<script type="module">
  const q = (s) => document.querySelector(s);
  let selectedRun = null;
  async function api(path, init) {
    const response = await fetch(path, { headers:{'content-type':'application/json'}, ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || ('HTTP ' + response.status));
    return body;
  }
  function notice(message, bad=false) { const el=q('#notice'); el.textContent=message; el.className=bad?'bad':'ok'; el.style.display='block'; setTimeout(()=>el.style.display='none',5000); }
  async function loadHealth(){ try { const h=await api('/health'); q('#health').textContent=h.status+' · '+h.version; q('#health').classList.add('ok'); } catch(e){ q('#health').textContent='Offline'; q('#health').classList.add('bad'); } }
  async function loadProviders(){
    const providers=await api('/api/providers'); const list=q('#providers'); const select=q('#provider-select'); list.replaceChildren(); select.replaceChildren();
    for(const p of providers){
      const row=document.createElement('div'); row.className='row'; const info=document.createElement('div'); const title=document.createElement('strong'); title.textContent=p.name; const meta=document.createElement('span'); meta.className='muted'; meta.textContent=p.driver+(p.model?' · '+p.model:''); info.append(title,meta);
      const button=document.createElement('button'); button.className='secondary'; button.textContent='Test'; button.onclick=async()=>{ button.disabled=true; button.textContent='Testing…'; try{const h=await api('/api/providers/'+encodeURIComponent(p.id)+'/probe',{method:'POST'}); notice(p.name+': '+h.message,!h.ok); button.textContent=h.ok?'Ready':'Failed'; button.className=h.ok?'secondary ok':'secondary bad';}catch(e){notice(e.message,true);button.textContent='Failed'}finally{button.disabled=false}}; row.append(info,button); list.append(row);
      if(p.enabled){const option=document.createElement('option');option.value=p.id;option.textContent=p.name;select.append(option)}
    }
    const preferred=providers.find((p)=>p.enabled&&p.driver==='ollama')??providers.find((p)=>p.enabled&&p.driver==='mock');if(preferred)select.value=preferred.id;
  }
  async function loadMemory(){const connectors=await api('/api/memory-connectors');const list=q('#memory-connectors');list.replaceChildren();for(const c of connectors){const row=document.createElement('div');row.className='row';const info=document.createElement('div');const title=document.createElement('strong');title.textContent=c.name;const meta=document.createElement('span');meta.className='muted';meta.textContent=c.kind+(c.enabled?' · enabled':' · disabled');info.append(title,meta);const b=document.createElement('button');b.className='secondary';b.textContent='Test';b.onclick=async()=>{b.disabled=true;try{const h=await api('/api/memory-connectors/'+encodeURIComponent(c.id)+'/probe',{method:'POST'});notice(c.name+': '+h.message,!h.ok);b.textContent=h.ok?'Ready':'Failed'}catch(e){notice(e.message,true);b.textContent='Failed'}finally{b.disabled=false}};row.append(info,b);list.append(row)}}
  async function loadRuns(){ const runs=await api('/api/runs'); const list=q('#runs'); list.replaceChildren(); if(!runs.length){list.textContent='No runs yet.';list.className='list muted';return} list.className='list'; for(const run of runs){const row=document.createElement('button');row.className='row secondary';row.style.textAlign='left';const info=document.createElement('span');const title=document.createElement('strong');title.textContent=run.title;const meta=document.createElement('span');meta.className='muted';meta.textContent=run.status+' · '+run.depth;info.append(title,meta);row.append(info);row.onclick=()=>showRun(run.id);list.append(row)} }
  async function showRun(id){ selectedRun=id; const data=await api('/api/runs/'+encodeURIComponent(id)); q('#detail-card').hidden=false;q('#detail').textContent=JSON.stringify(data,null,2);const messages=q('#messages');messages.replaceChildren();for(const m of data.messages||[]){const row=document.createElement('div');row.className='row';const text=document.createElement('div');const role=document.createElement('strong');role.textContent=m.role+(m.providerId?' · '+m.providerId:'');const content=document.createElement('span');content.className='muted';content.textContent=m.text;text.append(role,content);row.append(text);messages.append(row)}const actions=q('#run-actions');actions.replaceChildren();const run=data.run;
    if(run.status==='awaiting_approval'||run.status==='failed'){const b=document.createElement('button');b.textContent='Approve and execute';b.onclick=async()=>{await api('/api/runs/'+id+'/execute',{method:'POST'});notice('Research started');await refresh()};actions.append(b)}
    if(['planning','researching','synthesizing','auditing'].includes(run.status)){const b=document.createElement('button');b.className='danger';b.textContent='Cancel';b.onclick=async()=>{await api('/api/runs/'+id+'/cancel',{method:'POST'});await refresh()};actions.append(b)}
    const s=document.createElement('select');for(const p of await api('/api/providers')){if(p.enabled){const o=document.createElement('option');o.value=p.id;o.textContent='Handoff to '+p.name;s.append(o)}}const hb=document.createElement('button');hb.className='secondary';hb.textContent='Handoff';hb.onclick=async()=>{await api('/api/runs/'+id+'/handoff',{method:'POST',body:JSON.stringify({providerId:s.value})});notice('Shared context handed off');await refresh()};actions.append(s,hb);
  }
  async function refresh(){await Promise.all([loadHealth(),loadProviders(),loadMemory(),loadRuns()]);if(selectedRun)await showRun(selectedRun)}
  q('#provider-form').onsubmit=async(e)=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.id=v.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');v.enabled=true;try{await api('/api/providers',{method:'POST',body:JSON.stringify(v)});notice('Provider saved');e.currentTarget.reset();await loadProviders()}catch(err){notice(err.message,true)}};
  q('#memory-form').onsubmit=async(e)=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.id=v.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');v.enabled=true;try{await api('/api/memory-connectors',{method:'POST',body:JSON.stringify(v)});notice('Memory connector saved');e.currentTarget.reset();await loadMemory()}catch(err){notice(err.message,true)}};
  q('#run-form').onsubmit=async(e)=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;const v=Object.fromEntries(new FormData(e.currentTarget));try{const run=await api('/api/runs',{method:'POST',body:JSON.stringify(v)});notice('Plan ready for review');selectedRun=run.id;await refresh()}catch(err){notice(err.message,true)}finally{button.disabled=false}};
  q('#chat-form').onsubmit=async(e)=>{e.preventDefault();if(!selectedRun)return;const input=e.currentTarget.elements.text;const text=input.value.trim();if(!text)return;const button=e.currentTarget.querySelector('button');button.disabled=true;try{await api('/api/runs/'+selectedRun+'/chat',{method:'POST',body:JSON.stringify({text})});input.value='';await showRun(selectedRun)}catch(err){notice(err.message,true)}finally{button.disabled=false}};
  q('#refresh').onclick=refresh; refresh(); setInterval(()=>{loadRuns();if(selectedRun)showRun(selectedRun)},2000);
</script>
</body></html>`;
