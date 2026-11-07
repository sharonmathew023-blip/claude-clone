(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const KEY = "openclaude_workspace_v2";
  const DEFAULTS = {
    theme: "dark", provider: "ollama", baseUrl: "http://localhost:11434",
    model: "llama3.2", systemPrompt: "You are a helpful, clear, and thoughtful AI assistant. Be honest about uncertainty and explain technical topics simply.",
    activeId: null, threads: []
  };
  let state = loadState();
  let apiKeyMemory = "";
  let busy = false;
  let activeArtifact = {title:"Artifact preview", code:""};
  let artifactMode = "preview";
  let toastTimer;

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "null");
      return saved && typeof saved === "object" ? {...DEFAULTS, ...saved, threads:Array.isArray(saved.threads)?saved.threads:[]} : {...DEFAULTS};
    } catch { return {...DEFAULTS}; }
  }
  function persist() {
    // API keys are deliberately never included in persistent state.
    const safe = {...state};
    delete safe.apiKey;
    localStorage.setItem(KEY, JSON.stringify(safe));
  }
  function id() { return "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
  function currentThread() { return state.threads.find(t => t.id === state.activeId) || null; }
  function titleFrom(text) { const clean = text.replace(/\s+/g," ").trim(); return clean.length > 38 ? clean.slice(0,38).trim()+"…" : clean || "New conversation"; }
  function escapeHTML(s) { return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
  function toast(msg) { $("toast").textContent=msg; $("toast").classList.add("show"); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$("toast").classList.remove("show"),2400); }
  function setTheme(theme) { state.theme=theme; document.documentElement.dataset.theme=theme; $("themeName").textContent=theme==="dark"?"Dark":"Light"; persist(); }
  function createThread() {
    const t={id:id(),title:"New conversation",starred:false,createdAt:Date.now(),messages:[]};
    state.threads.unshift(t); state.activeId=t.id; persist(); renderAll(); closeMobileSidebar(); $("promptInput").focus();
  }
  function ensureThread() { if(!currentThread()) createThread(); }
  function deleteThread(threadId) {
    state.threads=state.threads.filter(t=>t.id!==threadId);
    if(state.activeId===threadId) state.activeId=state.threads[0]?.id||null;
    persist(); renderAll();
  }
  function renderThreads() {
    const q=$("searchInput").value.toLowerCase().trim(), list=$("threadList");
    list.innerHTML="";
    const filtered=state.threads.filter(t=>t.title.toLowerCase().includes(q)||t.messages.some(m=>m.content.toLowerCase().includes(q)));
    if(!filtered.length){list.innerHTML=`<div class="empty-search">${q?"No matching conversations.":"Your conversations will appear here."}</div>`;return;}
    filtered.forEach(t=>{
      const row=document.createElement("div"); row.className="thread-item"+(t.id===state.activeId?" active":"");
      const title=document.createElement("span");title.className="thread-title";title.textContent=t.title;title.title=t.title;
      row.append(title);
      if(t.starred){const star=document.createElement("span");star.className="thread-star";star.textContent="★";row.append(star);}
      const del=document.createElement("button");del.className="thread-delete";del.textContent="×";del.title="Delete conversation";del.setAttribute("aria-label","Delete "+t.title);
      del.addEventListener("click",e=>{e.stopPropagation();deleteThread(t.id);});row.append(del);
      row.addEventListener("click",()=>{state.activeId=t.id;persist();renderAll();closeMobileSidebar();});list.append(row);
    });
  }
  function renderMarkdown(raw) {
    // Small dependency-free Markdown renderer. All raw HTML is escaped first.
    const blocks=[]; let text=String(raw).replace(/\r\n/g,"\n");
    text=text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g,(_,lang,code)=>{const n=blocks.push({lang:lang||"code",code})-1;return `\n@@CODE${n}@@\n`;});
    let html=escapeHTML(text);
    html=html.replace(/^### (.+)$/gm,"<h3>$1</h3>").replace(/^## (.+)$/gm,"<h2>$1</h2>").replace(/^# (.+)$/gm,"<h1>$1</h1>");
    html=html.replace(/^> (.+)$/gm,"<blockquote>$1</blockquote>");
    html=html.replace(/`([^`\n]+)`/g,"<code>$1</code>");
    html=html.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/\*(.+?)\*/g,"<em>$1</em>");
    html=html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    html=html.replace(/^(?:-|\*) (.+)$/gm,"<li>$1</li>");
    html=html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g,m=>"<ul>"+m+"</ul>");
    html=html.split(/\n{2,}/).map(part=>{part=part.trim();if(!part)return "";if(/^<(h[1-3]|ul|blockquote|pre)/.test(part)||/^@@CODE\d+@@$/.test(part))return part;return "<p>"+part.replace(/\n/g,"<br>")+"</p>";}).join("");
    html=html.replace(/@@CODE(\d+)@@/g,(_,i)=>{const b=blocks[Number(i)];return `<div class="code-wrap"><div class="code-head"><span>${escapeHTML(b.lang)}</span><button type="button" data-copy-code="${Number(i)}">Copy code</button></div><pre><code>${escapeHTML(b.code)}</code></pre></div>`;});
    return {html,blocks};
  }
  function renderMessages() {
    const container=$("chatContainer"), thread=currentThread();
    container.innerHTML="";
    if(!thread||!thread.messages.length){
      container.innerHTML=`<div class="welcome"><div class="welcome-mark">✳</div><h1>A quieter space<br>for <em>big ideas.</em></h1><p>Think, write, build, and explore. Connect a local model in Settings to start a private AI conversation.</p><div class="starter-grid">
        <button class="starter" data-prompt="Explain a complex idea in simple terms."><strong>◌ Learn something</strong><span>Break down a difficult topic into clear steps.</span></button>
        <button class="starter" data-prompt="Help me plan a small project from idea to launch."><strong>⌘ Plan a project</strong><span>Turn a rough idea into an actionable plan.</span></button>
        <button class="starter" data-prompt="Write a clean, accessible HTML page for a personal portfolio."><strong>⌁ Build with code</strong><span>Generate a useful starting point for a web project.</span></button>
        <button class="starter" data-prompt="Give me five creative ideas for a short video."><strong>✳ Find inspiration</strong><span>Explore fresh angles and creative directions.</span></button>
      </div></div>`;
      container.querySelectorAll("[data-prompt]").forEach(b=>b.addEventListener("click",()=>{ $("promptInput").value=b.dataset.prompt; autoResize(); $("promptInput").focus(); }));
      return;
    }
    thread.messages.forEach((m,index)=>{
      const row=document.createElement("article");row.className="message "+(m.role==="user"?"user":"assistant");
      const meta=document.createElement("div");meta.className="message-meta";meta.textContent=m.role==="user"?"YOU":"OPENCLAUDE";
      const body=document.createElement("div");body.className="message-body";
      const rendered=renderMarkdown(m.content);body.innerHTML=rendered.html;
      row.append(meta,body);
      if(m.role==="assistant"){
        body.querySelectorAll("[data-copy-code]").forEach(btn=>btn.addEventListener("click",()=>{const code=rendered.blocks[Number(btn.dataset.copyCode)]?.code||"";copyText(code);}));
        const artifactCode=extractArtifact(m.content);
        if(artifactCode){
          const open=document.createElement("button");open.className="artifact-inline";open.innerHTML="▣ <span>Open HTML artifact preview</span> ↗";
          open.addEventListener("click",()=>showArtifact(artifactCode,"Generated artifact"));row.append(open);
        }
        const actions=document.createElement("div");actions.className="message-actions";
        const copy=document.createElement("button");copy.textContent="Copy response";copy.onclick=()=>copyText(m.content);
        actions.append(copy);row.append(actions);
      }
      container.append(row);
    });
    if(busy){const typing=document.createElement("div");typing.className="typing";typing.textContent="OpenClaude is thinking";container.append(typing);}
    $("chatScroll").scrollTop=$("chatScroll").scrollHeight;
  }
  function renderAll(){renderThreads();renderMessages();$("activeTitle").textContent=currentThread()?.title||"New conversation";updateProviderUI();}
  function updateProviderUI(){
    const local=state.provider==="ollama", demo=state.provider==="demo";
    const name=demo?"Demo mode":local?"Ollama":"API provider";
    $("engineName").textContent=name;$("engineSub").textContent=demo?"No model connected":state.model;
    $("engineDot").classList.toggle("online",!demo);$("connectionDot").classList.toggle("online",!demo);
    $("connectionText").textContent=demo?"Demo mode":local?"Local provider":"API provider";
    $("modelChip").innerHTML=`${escapeHTML(state.model||"Choose model")} <span>⌄</span>`;
  }
  function extractArtifact(content){
    const match=content.match(/```(?:html)?\s*\n([\s\S]*?)```/i);
    if(!match)return null;
    const code=match[1].trim();
    return /<(html|!doctype|body|div|main|section|canvas|svg)\b/i.test(code)?code:null;
  }
  function showArtifact(code,title){
    activeArtifact={code,title};$("artifactTitle").textContent=title;$("artifactCode").textContent=code;
    $("artifactFrame").srcdoc=code; $("artifactPane").classList.add("open");setArtifactMode("preview");
  }
  function setArtifactMode(mode){artifactMode=mode;$("previewTab").classList.toggle("active",mode==="preview");$("codeTab").classList.toggle("active",mode==="code");$("artifactFrame").style.display=mode==="preview"?"block":"none";$("artifactCode").style.display=mode==="code"?"block":"none";}
  function autoResize(){const el=$("promptInput");el.style.height="auto";el.style.height=Math.min(el.scrollHeight,160)+"px";}
  function addMessage(role,content){ensureThread();const t=currentThread();t.messages.push({role,content,at:Date.now()});if(role==="user"&&t.messages.filter(m=>m.role==="user").length===1)t.title=titleFrom(content);persist();}
  function getEndpoint(){
    const base=state.baseUrl.replace(/\/+$/,"");
    return state.provider==="ollama"?base+"/api/chat":base.endsWith("/chat/completions")?base:base+"/chat/completions";
  }
  async function sendToModel(messages,onChunk){
    if(state.provider==="demo")throw new Error("Demo mode does not connect to an AI model. Choose Ollama or an OpenAI-compatible API in Settings.");
    const endpoint=getEndpoint(), headers={"Content-Type":"application/json"};
    if(state.provider==="openai"&&apiKeyMemory)headers.Authorization="Bearer "+apiKeyMemory;
    const payload=state.provider==="ollama"
      ?{model:state.model,messages,stream:true}
      :{model:state.model,messages,stream:true};
    let response;
    try{response=await fetch(endpoint,{method:"POST",headers,body:JSON.stringify(payload)});}
    catch(e){throw new Error("Could not reach the model server. Check that it is running and that browser access (CORS) is enabled. "+e.message);}
    if(!response.ok){let detail="";try{detail=await response.text();}catch{}throw new Error(`Provider returned HTTP ${response.status}. ${detail.slice(0,350)}`);}
    if(!response.body)throw new Error("This browser does not support streamed responses.");
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer="",full="";
    while(true){
      const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});
      const lines=buffer.split(/\r?\n/);buffer=lines.pop()||"";
      for(const line of lines){
        const trimmed=line.trim();if(!trimmed||trimmed.startsWith(":")||trimmed==="data: [DONE]")continue;
        const data=trimmed.startsWith("data:")?trimmed.slice(5).trim():trimmed;
        try{
          const obj=JSON.parse(data);
          const chunk=state.provider==="ollama"?(obj.message?.content||""):(obj.choices?.[0]?.delta?.content||"");
          if(chunk){full+=chunk;onChunk(full);}
          if(obj.error)throw new Error(obj.error);
        }catch(err){if(err instanceof SyntaxError)continue;throw err;}
      }
    }
    return full;
  }
  async function sendMessage(){
    const input=$("promptInput"),prompt=input.value.trim();if(!prompt||busy)return;
    ensureThread();input.value="";autoResize();addMessage("user",prompt);busy=true;$("sendBtn").disabled=true;renderAll();$("typingStatus").textContent="Generating";
    const history=currentThread().messages.filter(m=>m.role==="user"||m.role==="assistant").slice(-24).map(m=>({role:m.role,content:m.content}));
    const messages=[{role:"system",content:state.systemPrompt},...history];
    try{
      let live="";
      const result=await sendToModel(messages,partial=>{live=partial;const t=currentThread();const last=t.messages[t.messages.length-1];if(last?.role==="assistant")last.content=partial;else t.messages.push({role:"assistant",content:partial,at:Date.now()});renderMessages();});
      const t=currentThread();if(!result.trim())throw new Error("The model returned an empty response.");const last=t.messages[t.messages.length-1];if(last?.role==="assistant")last.content=result;else t.messages.push({role:"assistant",content:result,at:Date.now()});persist();
    }catch(err){addMessage("assistant","**Connection error**\n\n"+err.message+"\n\nOpen **Settings** to check your provider, URL, model name, and CORS configuration.");}
    finally{busy=false;$("sendBtn").disabled=false;$("typingStatus").textContent="";renderAll();input.focus();}
  }
  async function testConnection(){
    const result=$("testResult");result.textContent="Testing…";
    try{
      const base=$("baseUrl").value.trim().replace(/\/+$/,""),provider=$("providerSelect").value,model=$("modelName").value.trim();
      if(provider==="demo"){result.textContent="Demo mode needs no connection.";return;}
      if(!base||!model)throw new Error("Enter a base URL and model name.");
      const headers={};if(provider==="openai"&&apiKeyMemory)headers.Authorization="Bearer "+apiKeyMemory;
      let url=provider==="ollama"?base+"/api/tags":base+"/models";
      const r=await fetch(url,{headers});if(!r.ok)throw new Error("HTTP "+r.status);
      const data=await r.json();result.textContent="Connection reached successfully.";
      toast("Provider is reachable");
    }catch(e){result.textContent=e.message; }
  }
  function openSettings(){
    $("providerSelect").value=state.provider;$("baseUrl").value=state.baseUrl;$("modelName").value=state.model;
    $("systemPrompt").value=state.systemPrompt;$("apiKey").value=apiKeyMemory;$("testResult").textContent="";
    updateUrlHelp();$("settingsModal").classList.add("open");
  }
  function updateUrlHelp(){
    const p=$("providerSelect").value;
    $("urlHelp").textContent=p==="ollama"?"Ollama server root, usually http://localhost:11434.":p==="openai"?"API root, for example https://api.example.com/v1.":"Demo mode does not use a server.";
    $("baseUrl").disabled=p==="demo";$("modelName").disabled=p==="demo";$("apiKey").disabled=p!=="openai";
  }
  function saveSettings(){
    state.provider=$("providerSelect").value;state.baseUrl=$("baseUrl").value.trim()||"http://localhost:11434";
    state.model=$("modelName").value.trim()||"llama3.2";state.systemPrompt=$("systemPrompt").value.trim()||DEFAULTS.systemPrompt;
    apiKeyMemory=$("apiKey").value;persist();$("settingsModal").classList.remove("open");renderAll();toast("Settings saved");
  }
  function copyText(text){if(navigator.clipboard?.writeText)navigator.clipboard.writeText(text).then(()=>toast("Copied to clipboard")).catch(()=>fallbackCopy(text));else fallbackCopy(text);}
  function fallbackCopy(text){const ta=document.createElement("textarea");ta.value=text;document.body.append(ta);ta.select();document.execCommand("copy");ta.remove();toast("Copied to clipboard");}
  function exportData(){
    const blob=new Blob([JSON.stringify({...state,exportedAt:new Date().toISOString()},null,2)],{type:"application/json"});
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="openclaude-conversations.json";a.click();URL.revokeObjectURL(a.href);
  }
  function downloadArtifact(){
    if(!activeArtifact.code)return toast("No artifact to download");
    const blob=new Blob([activeArtifact.code],{type:"text/html"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="openclaude-artifact.html";a.click();URL.revokeObjectURL(a.href);
  }
  function closeMobileSidebar(){$("sidebar").classList.remove("open");$("mobileScrim").classList.remove("show");}
  function openMobileSidebar(){$("sidebar").classList.add("open");$("mobileScrim").classList.add("show");}

  $("newChat").onclick=createThread;$("sendBtn").onclick=sendMessage;
  $("promptInput").addEventListener("input",autoResize);
  $("promptInput").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage();}});
  $("searchInput").addEventListener("input",renderThreads);$("clearSearch").onclick=()=>{$("searchInput").value="";renderThreads();};
  $("settingsOpen").onclick=openSettings;$("settingsClose").onclick=()=>$("settingsModal").classList.remove("open");
  $("settingsModal").addEventListener("click",e=>{if(e.target===$("settingsModal"))$("settingsModal").classList.remove("open");});
  $("saveSettings").onclick=saveSettings;$("providerSelect").onchange=updateUrlHelp;$("testConnection").onclick=testConnection;
  $("themeToggle").onclick=()=>setTheme(state.theme==="dark"?"light":"dark");
  $("openSidebar").onclick=openMobileSidebar;$("closeSidebar").onclick=closeMobileSidebar;$("mobileScrim").onclick=closeMobileSidebar;
  $("modelChip").onclick=openSettings;
  $("previewTab").onclick=()=>setArtifactMode("preview");$("codeTab").onclick=()=>setArtifactMode("code");
  $("closeArtifact").onclick=()=>$("artifactPane").classList.remove("open");$("downloadArtifact").onclick=downloadArtifact;
  $("exportData").onclick=exportData;
  $("clearAll").onclick=()=>{if(confirm("Delete every saved conversation from this browser? This cannot be undone.")){state.threads=[];state.activeId=null;persist();renderAll();toast("Conversations deleted");}};
  document.addEventListener("keydown",e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){e.preventDefault();createThread();}if(e.key==="Escape"){$("settingsModal").classList.remove("open");closeMobileSidebar();$("artifactPane").classList.remove("open");}});
  if(!state.threads.length){const t={id:id(),title:"Welcome to OpenClaude",starred:true,createdAt:Date.now(),messages:[]};state.threads.push(t);state.activeId=t.id;persist();}
  setTheme(state.theme);renderAll();
})();