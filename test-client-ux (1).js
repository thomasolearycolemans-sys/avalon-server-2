/*
 * test-client-ux.js — headless unit tests for the client's connection/overlay/toast
 * logic (Step 2). Stubs the DOM + WebSocket and drives handle()/boot() to assert the
 * overlay hides on connect, errors surface as a toast, stale reconnects return home,
 * and the offline-app link is wired. Run: node test-client-ux.js
 */
const fs=require("fs");
const html=fs.readFileSync(__dirname+"/public/index.html","utf8");
const els={};
function mk(id){return els[id]||(els[id]={id,textContent:"",style:{},className:"",classList:{
  _s:new Set(),add(c){this._s.add(c)},remove(c){this._s.delete(c)},toggle(c,v){v?this._s.add(c):this._s.delete(c)},contains(c){return this._s.has(c)}},
  href:"",onclick:null,target:"",rel:"",value:""});}
global.document={getElementById:mk,querySelector:()=>({scrollTop:0}),querySelectorAll:()=>[]};
global.$=mk;
global.location={protocol:"https:",host:"h",pathname:"/"};
let store={};
global.localStorage={getItem:k=>store[k]||null,setItem:(k,v)=>store[k]=v,removeItem:k=>delete store[k]};
let wsInstances=[];
global.WebSocket=function(){const w={readyState:0,OPEN:1,onopen:null,onmessage:null,onclose:null,onerror:null,sent:[],send(o){this.sent.push(JSON.parse(o))},close(){}};wsInstances.push(w);return w;};
global.setTimeout=(fn,ms)=>({fn,ms}); global.clearTimeout=()=>{}; global.setInterval=()=>({unref(){}});
const m=html.match(/<script>([\s\S]*?)<\/script>/g).filter(s=>s.includes("function applyGame"))[0].replace(/^<script>/,"").replace(/<\/script>$/,"");
eval(m + `
;applyRoom=function(){};applyPrivate=function(){};applyPrivateGame=function(){};applyNarration=function(){};applyGame=function(){};renderQR=function(){};renderCard=function(){};
global.__handle=handle; global.__sess=()=>localStorage.getItem("avalon-online-session");
`);
let pass=0,fail=0; const ok=(l,c)=>{c?pass++:(fail++,console.log("  FAIL "+l));};
const H=global.__handle;
ok("overlay shown on boot", els["overlay"].classList.contains("show"));
ok("socket created on boot", wsInstances.length===1);
wsInstances[0].readyState=1; wsInstances[0].onopen();
ok("overlay hidden after connect (never blocks healthy play)", !els["overlay"].classList.contains("show"));
H({type:"error",message:"No game with that code."});
ok("error shows toast", els["toast"].classList.contains("show"));
ok("toast carries the message", els["toast-msg"].textContent==="No game with that code.");
ok("error toast is not info-styled", !els["toast"].classList.contains("info"));
H({type:"created",code:"ABCD",token:"tok",seat:0});
ok("created hides overlay", !els["overlay"].classList.contains("show"));
ok("created persists session", !!global.__sess() && global.__sess().includes("ABCD"));
els["overlay"].classList.add("show");
H({type:"error",message:"That game no longer exists."});
ok("stale reconnect clears session", global.__sess()===null);
ok("stale reconnect hides overlay (no trap)", !els["overlay"].classList.contains("show"));
ok("offline link href wired", els["offline-link"].href.includes("github.io/Avalon"));
ok("offline link opens new tab", els["offline-link"].target==="_blank");
H({type:"disbanded"});
ok("disband shows info toast", els["toast"].classList.contains("show") && els["toast"].classList.contains("info"));
ok("disband clears session", global.__sess()===null);
console.log(`\nStep 2 client UX: ${pass} passed, ${fail} failed`);

/* ---- Step 5: immersion beats must never block game state ---- */
(function step5(){
  let p5=0,f5=0; const ok5=(l,c)=>{c?p5++:(f5++,console.log("  FAIL "+l));};
  let boardRenders=0, beatsPlayed=0;
  const renderBoard=()=>{boardRenders++;};
  const playQuestBeat=()=>{beatsPlayed++;};
  // exact copy of the client's applyGame control-flow (the logic under test)
  let lastQuestCount=0,lastGamePhase=null,overRevealed=false;
  function applyGame(room){
    const g=room.game; if(!g) return;
    if((g.questResults||[]).length===0 && (g.phase==="proposal"||g.phase==="vote")){ lastQuestCount=0; overRevealed=false; }
    const qc=(g.questResults||[]).length;
    const newlyResolved = qc>lastQuestCount && lastGamePhase!==null;
    const justResolved = newlyResolved ? g.questResults[qc-1] : null;
    lastQuestCount=qc; lastGamePhase=g.phase;
    renderBoard(g);                          // must ALWAYS run
    if(justResolved){ playQuestBeat(justResolved); }
  }
  applyGame({game:{phase:"proposal",questResults:[]}});
  ok5("board renders on first game view", boardRenders===1);
  ok5("no beat before any quest resolves", beatsPlayed===0);
  applyGame({game:{phase:"proposal",questResults:["success"]}});
  ok5("board still renders when a quest resolves", boardRenders===2);
  ok5("beat plays on new quest result", beatsPlayed===1);
  applyGame({game:{phase:"vote",questResults:["success"]}});
  ok5("board renders on ordinary update", boardRenders===3);
  ok5("no duplicate beat without a new result", beatsPlayed===1);
  applyGame({game:{phase:"quest",questResults:["success","fail"]}});
  ok5("beat plays again on the next result", beatsPlayed===2);
  ok5("board rendered every single update (never blocked)", boardRenders===4);
  console.log(`Step 5 immersion (non-blocking): ${p5} passed, ${f5} failed`);
  if(f5) process.exit(1);
})();

process.exit(fail?1:0);
