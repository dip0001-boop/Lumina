
'use strict';
(() => {
const $ = id => document.getElementById(id);
const enc=new TextEncoder(),dec=new TextDecoder();
const LIMIT_STORAGE=8_000_000_000, RAM_TARGET=425_000_000;
const EFFORT={rapid:{max:384,temp:0.8,top:14,rounds:1},standard:{max:1536,temp:0.72,top:20,rounds:2},deep:{max:3072,temp:0.63,top:18,rounds:3},maximum:{max:6144,temp:0.58,top:16,rounds:4}};
const TOOL_INFO=[['list_files','List actual workspace filenames'],['read_file','Read an existing file'],['write_file','Save the supplied text as a workspace file'],['search_workspace','Search text across workspace files'],['runtime_smoke_test','Load the page in a sandbox and observe uncaught errors'],['validate_html','Check document metadata, IDs, alt attributes and classic-script syntax'],['validate_js','Parse classic JavaScript syntax; not a behavioral test or module compiler'],['validate_json','Parse JSON files'],['preview_project','Render workspace HTML in a sandbox'],['export_zip','Start a browser download of the actual project files'],['import_files','Choose files through the browser picker'],['calculate','Evaluate an explicit arithmetic expression'],['fetch_url','Read a public HTTP(S) URL if CORS allows it']];
let auditing=false,evaluating=false,generating=false,trainingObjective='all',validationObjective='all';
let db=null,view='work',model=null,training=false,cancelTraining=false,working=false,cancelWork=false,activeFile='',fileCache=new Map(),chatMessages=[],datasets=[],totalDatasetBytes=0,lossEMA=NaN,saveTimer=0,importing=false,trainPaused=false,validateLoss=NaN,bestValidation=Infinity,bestAt=0,validationHistory=[],trainHistory=[],gradNorm=NaN,valPool=[],holdoutAccuracy=NaN,chatCancelled=false,selectedTool=null;
function sleep(t=0){return new Promise(r=>setTimeout(r,t));}
function stamp(){return new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});}
function fmt(n){if(n>=1e9)return (n/1e9).toFixed(2)+' GB';if(n>=1e6)return (n/1e6).toFixed(2)+' MB';if(n>=1e3)return (n/1e3).toFixed(1)+' KB';return n+' B'}
function log(s,kind='info'){const p=$('workLog');if(p.textContent==='No tools executed yet.')p.textContent='';const line=document.createElement('div');line.style.color=kind==='fail'?'#ff91a5':kind==='ok'?'#80dab6':'#a8bad6';line.textContent='['+stamp()+'] '+s;p.append(line);p.scrollTop=p.scrollHeight;}
function alertUser(s){window.alert(s)}
function requestDB(){return new Promise((resolve,reject)=>{const q=indexedDB.open('vantage_c1_local_v1',1);q.onupgradeneeded=()=>{const d=q.result;d.createObjectStore('files',{keyPath:'name'});d.createObjectStore('dataset',{keyPath:'id'});d.createObjectStore('meta',{keyPath:'key'})};q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});}
function tx(store,mode,op){return new Promise((resolve,reject)=>{const t=db.transaction(store,mode);let result;const req=op(t.objectStore(store));req.onsuccess=()=>{result=req.result};t.oncomplete=()=>resolve(result);t.onerror=()=>reject(t.error||Error('Storage operation failed'));t.onabort=()=>reject(t.error||Error('Storage transaction aborted'));})}
const volatileStores={files:new Map(),dataset:new Map(),meta:new Map()};const get=(s,k)=>db?tx(s,'readonly',o=>o.get(k)):Promise.resolve(volatileStores[s].get(k));const put=(s,v)=>db?tx(s,'readwrite',o=>o.put(v)):Promise.resolve(volatileStores[s].set(s==='files'?v.name:s==='dataset'?v.id:v.key,v));const remove=(s,k)=>db?tx(s,'readwrite',o=>o.delete(k)):Promise.resolve(volatileStores[s].delete(k));const getAll=s=>db?tx(s,'readonly',o=>o.getAll()):Promise.resolve([...volatileStores[s].values()]);

function setView(v){view=v;document.querySelectorAll('[data-view]').forEach(n=>n.classList.toggle('active',n.dataset.view===v));document.querySelectorAll('[id^="view-"]').forEach(n=>n.classList.toggle('hidden',n.id!=='view-'+v));$('pageTitle').innerHTML=({chat:'Chat',work:'Code',train:'Training',tools:'Tool library',about:'Settings',intelligence:'Intelligence Architecture',plans:'Plans & usage',memory:'Project memory'}[v])+' <span class="muted" style="font-size:12px">/ LUMINA 2.0</span>';if(v==='train')renderModel();if(v==='about')refreshStats();if(v==='work')renderFiles();}
function appendChat(role,txt){$('chatWelcome')?.remove();chatMessages.push({role,txt});const row=document.createElement('div');row.className='bubble';const av=document.createElement('div');av.className='avatar '+(role==='You'?'user':'');av.textContent=role==='You'?'Y':'V';const b=document.createElement('div');b.className='message';const meta=document.createElement('div');meta.className='messageMeta';meta.textContent=role+' · '+stamp();const text=document.createElement('div');text.className='messageText';text.textContent=txt;b.append(meta,text);row.append(av,b);$('chatStream').append(row);$('chatStream').scrollTop=$('chatStream').scrollHeight;return text;}
function setBusy(b){$('sendChat').disabled=b;$('sendChat').textContent=b?'Working…':'Send ↗';$('stopChat').classList.toggle('hidden',!b);}
async function sendChat(){
 const message=$('chatInput').value.trim();if(!message||generating||working)return;
 if(!planReady||planChanging){toast('Workspace is still opening.');return;}
 if(training||importing||evaluating||auditing){toast('Finish the active training or data operation first.');return;}
 if(!model||(model.steps-(model.auxSteps||0))<1){appendChat('LUMINA 2.0','Train or import byte-generation weights first. Controller training alone does not train the byte output head. No weekly message used.');return;}
 $('chatInput').value='';const prior=planId==='free'?'':chatMessages.slice(-6).map(m=>(m.role==='You'?'User: ':'Assistant: ')+m.txt).join('\n');appendChat('You',message);const out=appendChat('LUMINA 2.0','');setBusy(true);generating=true;chatCancelled=false;cancelWork=false;
 try{await deliverTask(message,out,()=>chatCancelled,prior);if(out.dataset.status==='error')$('chatInput').value=message;chatMessages[chatMessages.length-1].txt=out.dataset.response||'';if(planId==='free')chatMessages=[];else if(chatMessages.length>12)chatMessages=chatMessages.slice(-12);}
 catch(e){renderResponse(out,'Could not finish this response: '+e.message);}finally{generating=false;setBusy(false);renderPlan();}
}
class LegacyContextNet {
 constructor(){
  this.D=160;this.H=768;this.C=96;this.V=256;this.steps=0;
  this.sizes={E:this.V*this.D,R:this.C*this.D,W1:this.D*2*this.H,b1:this.H,W2:this.H*this.V,b2:this.V,P:this.C,G:this.D};
  this.keys=Object.keys(this.sizes);this.w={};this.m={};this.v={};this.g={};
  for(const [k,n] of Object.entries(this.sizes)){
   this.w[k]=new Float32Array(n);this.m[k]=new Float32Array(n);this.v[k]=new Float32Array(n);this.g[k]=new Float32Array(n);
   if(k==='G')this.w.G.fill(2.2); // Initially preserve ~90% of the previous last-byte path.
   if(k==='E'||k==='R'||k==='W1'||k==='W2'){
    const scale=k==='E'?.07:k==='R'?.015:k==='W2'?Math.sqrt(2/(this.H+this.V)):Math.sqrt(2/(2*this.D+this.H));
    for(let i=0;i<n;i++)this.w[k][i]=(Math.random()*2-1)*scale;
   }
  }
 }
 forward(tokens){
  const {D,H,C,V,w}=this,seq=tokens.slice(-C);if(!seq.length)seq.push(32);
  const n=seq.length,last=seq[n-1],qOff=last*D,scale=1/Math.sqrt(D);
  const scores=new Float32Array(n),a=new Float32Array(n),ctx=new Float32Array(D),local=new Float32Array(D),gate=new Float32Array(D),x=new Float32Array(D*2),h=new Float32Array(H),p=new Float32Array(V);
  let max=-Infinity;
  for(let t=0;t<n;t++){
   const distance=n-1-t,off=seq[t]*D,roff=distance*D;
   let score=w.P[distance];
   for(let d=0;d<D;d++)score+=w.E[qOff+d]*(w.E[off+d]+w.R[roff+d])*scale;
   scores[t]=score;if(score>max)max=score;
  }
  let den=0;for(let t=0;t<n;t++){const z=Math.exp(scores[t]-max);a[t]=z;den+=z;}
  for(let t=0;t<n;t++){
   a[t]/=den;const off=seq[t]*D,roff=(n-1-t)*D;
   for(let d=0;d<D;d++)ctx[d]+=a[t]*(w.E[off+d]+w.R[roff+d]);
  }
  const localStart=Math.max(0,n-8);let localDen=0;
  for(let t=n-1;t>=localStart;t--){const weight=1/(n-t),off=seq[t]*D;localDen+=weight;for(let d=0;d<D;d++)local[d]+=weight*w.E[off+d];}
  for(let d=0;d<D;d++){local[d]/=localDen;gate[d]=1/(1+Math.exp(-w.G[d]));x[d]=gate[d]*w.E[qOff+d]+(1-gate[d])*local[d];x[D+d]=ctx[d];}
  for(let j=0;j<H;j++){
   let z=w.b1[j];for(let i=0;i<D*2;i++)z+=x[i]*w.W1[i*H+j];h[j]=Math.tanh(z);
  }
  let maxLogit=-Infinity;
  for(let k=0;k<V;k++){
   let z=w.b2[k];for(let j=0;j<H;j++)z+=h[j]*w.W2[j*V+k];p[k]=z;if(z>maxLogit)maxLogit=z;
  }
  let sum=0;for(let k=0;k<V;k++){p[k]=Math.exp(p[k]-maxLogit);sum+=p[k];}
  for(let k=0;k<V;k++)p[k]/=sum;
  return {seq,n,last,a,x,h,p,local,gate,localDen,localStart};
 }
 zeroGrad(){for(const arr of Object.values(this.g))arr.fill(0);}
 accumulateGrad(tokens,target){
  const {D,H,V,w,g}=this,{seq,n,last,a,x,h,p,local,gate,localDen,localStart}=this.forward(tokens);
  const dz=new Float32Array(p);dz[target]-=1;
  const dhz=new Float32Array(H),dx=new Float32Array(D*2),scale=1/Math.sqrt(D);
  for(let k=0;k<V;k++)g.b2[k]+=dz[k];
  for(let j=0;j<H;j++){
   let sum=0,base=j*V;
   for(let k=0;k<V;k++){g.W2[base+k]+=h[j]*dz[k];sum+=w.W2[base+k]*dz[k];}
   dhz[j]=sum*(1-h[j]*h[j]);g.b1[j]+=dhz[j];
  }
  for(let i=0;i<D*2;i++){
   let sum=0,base=i*H;
   for(let j=0;j<H;j++){g.W1[base+j]+=x[i]*dhz[j];sum+=w.W1[base+j]*dhz[j];}
   dx[i]=sum;
  }
  const qoff=last*D,da=new Float32Array(n);let mean=0;
  for(let t=0;t<n;t++){
   const off=seq[t]*D,roff=(n-1-t)*D;let sum=0;
   for(let d=0;d<D;d++)sum+=dx[D+d]*(w.E[off+d]+w.R[roff+d]);
   da[t]=sum;mean+=a[t]*sum;
  }
  for(let d=0;d<D;d++){
   const s=gate[d],direct=w.E[qoff+d];
   g.G[d]+=dx[d]*(direct-local[d])*s*(1-s);
   g.E[qoff+d]+=dx[d]*s;
  }
  for(let t=n-1;t>=localStart;t--){const weight=1/(n-t)/localDen,off=seq[t]*D;for(let d=0;d<D;d++)g.E[off+d]+=dx[d]*(1-gate[d])*weight;}
  for(let t=0;t<n;t++){
   const distance=n-1-t,roff=distance*D,off=seq[t]*D,ds=a[t]*(da[t]-mean);
   g.P[distance]+=ds;
   for(let d=0;d<D;d++){
    const query=w.E[qoff+d],key=w.E[off+d]+w.R[roff+d];
    const valGrad=a[t]*dx[D+d]+ds*query*scale;
    g.E[off+d]+=valGrad;g.R[roff+d]+=valGrad;
    g.E[qoff+d]+=ds*key*scale;
   }
  }
  return -Math.log(Math.max(1e-12,p[target]));
 }
 applyGrad(lr,batchSize=1,clipLimit=2,decay=.0001){
  if(!(batchSize>0)||!(lr>0))throw Error('Invalid optimiser settings');
  let sq=0;for(const arr of Object.values(this.g))for(let i=0;i<arr.length;i++){const z=arr[i]/batchSize;sq+=z*z;}
  const norm=Math.sqrt(sq);if(!Number.isFinite(norm))throw Error('Nonfinite gradient. Restore best checkpoint and lower learning rate.');
  const mult=Math.min(1,clipLimit/(norm||1))/batchSize;
  this.steps++;const b1=1-Math.pow(.9,this.steps),b2=1-Math.pow(.999,this.steps);
  for(const k of this.keys){
   const weights=this.w[k],grad=this.g[k],m=this.m[k],v=this.v[k],wd=['E','R','W1','W2'].includes(k)?decay:0;
   for(let i=0;i<weights.length;i++){
    const z=grad[i]*mult;m[i]=.9*m[i]+.1*z;v[i]=.999*v[i]+.001*z*z;
    weights[i]-=lr*((m[i]/b1)/(Math.sqrt(v[i]/b2)+1e-8)+wd*weights[i]);
   }
  }
  this.lastGradNorm=norm;return norm;
 }
 trainOne(tokens,target,lr){this.zeroGrad();const loss=this.accumulateGrad(tokens,target);this.applyGrad(lr);return loss;}
 evaluate(tokens,target){return -Math.log(Math.max(1e-12,this.forward(tokens).p[target]));}
 choose(tokens,temp,top,recent=[],nucleus=.92){
  const {p}=this.forward(tokens),tail=recent.length?recent:tokens;
  // Restrict byte sampling to valid UTF-8 sequences; never penalize common bytes such as spaces.
  let needed=0,lo=128,hi=191;
  for(let i=tail.length-1,count=0;i>=0&&count<4;i--,count++){
   const b=tail[i];if(b>=128&&b<=191)continue;
   const width=b>=240&&b<=244?4:b>=224&&b<=239?3:b>=194&&b<=223?2:1;
   needed=Math.max(0,width-1-count);
   if(needed&&count===0){if(b===224)lo=160;if(b===237)hi=159;if(b===240)lo=144;if(b===244)hi=143;}break;
  }
  const ids=Array.from({length:256},(_,i)=>i).filter(i=>needed?i>=lo&&i<=hi:i===9||i===10||i===13||(i>=32&&i<=126)||(i>=194&&i<=244));
  ids.sort((a,b)=>p[b]-p[a]);if(temp<=0)return ids[0];
  const candidates=ids.slice(0,Math.max(1,top||ids.length)),maxLog=Math.log(Math.max(p[candidates[0]],1e-30));
  const weights=candidates.map(id=>Math.exp((Math.log(Math.max(p[id],1e-30))-maxLog)/temp));
  const total=weights.reduce((a,b)=>a+b,0);let sum=0,count=0;
  for(;count<weights.length;count++){sum+=weights[count];if(sum/total>=nucleus){count++;break;}}
  let r=Math.random()*sum;for(let z=0;z<count;z++){r-=weights[z];if(r<=0)return candidates[z];}return candidates[0];
 }

 parameterCount(){return Object.values(this.sizes).reduce((a,b)=>a+b,0);}
 pack(){
  const HEADER=64,bytes=this.parameterCount()*12,buf=new ArrayBuffer(HEADER+bytes),dv=new DataView(buf),out=new Uint8Array(buf);
  dv.setUint32(0,0x334D554C,true); // 'LUM3', version 3
  dv.setUint32(4,3,true);dv.setUint32(8,this.steps,true);dv.setUint32(12,this.D,true);
  dv.setUint32(16,this.H,true);dv.setUint32(20,this.C,true);dv.setUint32(24,this.V,true);
  dv.setUint32(28,this.parameterCount(),true);dv.setUint32(32,this.keys.length,true);
  let offset=HEADER;
  for(const kind of ['w','m','v'])for(const k of this.keys){const arr=this[kind][k];out.set(new Uint8Array(arr.buffer,arr.byteOffset,arr.byteLength),offset);offset+=arr.byteLength;}
  let hash=2166136261;for(let i=HEADER;i<out.length;i++){hash^=out[i];hash=Math.imul(hash,16777619);}
  dv.setUint32(36,hash>>>0,true);
  return buf;
 }
 load(input){
  if(typeof input==='string')return this.loadLegacy(JSON.parse(input));
  if(input&&typeof input==='object'&&!(input instanceof ArrayBuffer)&&!ArrayBuffer.isView(input))return this.loadLegacy(input);
  const buffer=input instanceof ArrayBuffer?input:input?.buffer?.slice(input.byteOffset,input.byteOffset+input.byteLength);
  if(!(buffer instanceof ArrayBuffer))throw Error('Invalid LUMINA weight format');
  const HEADER=64;if(buffer.byteLength<HEADER)throw Error('Checkpoint header missing');
  const dv=new DataView(buffer),bytes=new Uint8Array(buffer),version=dv.getUint32(4,true);
  const v2=dv.getUint32(0,true)===0x324D554C&&version===2,v3=dv.getUint32(0,true)===0x334D554C&&version===3;
  if(!v2&&!v3)throw Error('Not a supported LUMINA 2.0 weight file');
  const keys=v2?this.keys.filter(k=>k!=='G'):this.keys;
  const count=keys.reduce((sum,k)=>sum+this.sizes[k],0),needed=HEADER+count*12;
  if(buffer.byteLength!==needed)throw Error('Checkpoint size incorrect');
  if(dv.getUint32(12,true)!==this.D||dv.getUint32(16,true)!==this.H||dv.getUint32(20,true)!==this.C||dv.getUint32(24,true)!==this.V||dv.getUint32(28,true)!==count||dv.getUint32(32,true)!==keys.length)throw Error('Incompatible model dimensions');
  let hash=2166136261;for(let i=HEADER;i<bytes.length;i++){hash^=bytes[i];hash=Math.imul(hash,16777619);}
  if((hash>>>0)!==dv.getUint32(36,true))throw Error('Corrupt checkpoint checksum');
  let offset=HEADER;
  // Verify every field before accepting the checkpoint.
  for(const kind of ['w','m','v'])for(const k of keys){
   const size=this.sizes[k],values=new Float32Array(buffer,offset,size);
   for(let j=0;j<size;j++)if(!Number.isFinite(values[j]))throw Error('Checkpoint contains invalid values');
   offset+=size*4;
  }
  offset=HEADER;for(const kind of ['w','m','v'])for(const k of keys){const size=this.sizes[k];this[kind][k].set(new Float32Array(buffer,offset,size));offset+=size*4;}
  this.steps=dv.getUint32(8,true);return v2?'v2-upgraded':'native';
 }
 loadLegacy(o){
  if(o?.signature!=='VANTAGE_C1_CONTEXTNET_V1')throw Error('Unrecognised weight signature');
  const old={E:256*32,W1:64*64,b1:64,W2:64*256,b2:256,P:48};
  for(const kind of ['w','m','v'])for(const [k,n] of Object.entries(old)){
   const src=o?.[kind]?.[k];if(!Array.isArray(src)||src.length!==n)throw Error('Corrupt old weight field '+kind+'.'+k);
   for(let i=0;i<src.length;i++)if(!Number.isFinite(src[i]))throw Error('Nonfinite legacy weights');
  }
  // Transfer learned submatrices. Fresh larger dimensions remain random; this is not equivalent to a native 1.12M checkpoint.
  for(const kind of ['w','m','v']){
   for(let token=0;token<256;token++)for(let d=0;d<32;d++)this[kind].E[token*this.D+d]=o[kind].E[token*32+d];
   for(let i=0;i<64;i++)for(let j=0;j<64;j++)this[kind].W1[(i<32?i:this.D+i-32)*this.H+j]=o[kind].W1[i*64+j];
   for(let j=0;j<64;j++)for(let k=0;k<256;k++)this[kind].W2[j*256+k]=o[kind].W2[j*256+k];
   for(let i=0;i<64;i++)this[kind].b1[i]=o[kind].b1[i];
   for(let i=0;i<256;i++)this[kind].b2[i]=o[kind].b2[i];
   for(let i=0;i<48;i++)this[kind].P[i]=o[kind].P[i];
  }
  // Adam moments from the old architecture do not describe the expanded network; start new optimizer steps.
  for(const arr of Object.values(this.m))arr.fill(0);
  for(const arr of Object.values(this.v))arr.fill(0);
  this.steps=0;return 'legacy-transfer';
 }
}

// LUMINA NEXUS: bounded single-query attention, block recurrent BPTT and shared refinement.
// Attention is O(C*D*heads), never a C-by-C transformer attention matrix.
class ContextNet {
 constructor(config={}){
  this.D=config.D||160;this.H=config.H||1536;this.C=512;this.V=256;this.heads=config.heads||4;this.passes=config.passes||2;this.trainC=96;this.steps=0;this.auxSteps=0;this.age=0;this.inferenceState=null;this.flags={attention:true,memory:true,hierarchy:true,iterate:true,capsules:true};
  const D=this.D,H=this.H,C=this.C,V=this.V;
  this.sizes={E:V*D,R:C*D,W1:2*D*H,b1:H,W2:H*V,b2:V,P:C,G:D,AQ:4*D,AK:4*D,AV:4*D,AO:4*D,HP:4*C,Zx:D,Zh:D,Zb:D,Cx:D,Ch:D,Cb:D,HC:14*D,HB:3*D,WM:D*D,IM:D*D,Ib:D,NG:D,CAP:D*D,Cb2:D,OP:D*65,Ob:65,CT:65*65,SP:8*65,AP:3*D*8,Ab:24,TH:D*15,Tb:15};
  this.keys=Object.keys(this.sizes);this.ticks=Object.fromEntries(this.keys.map(k=>[k,0]));this.activeKeys=new Set();this.w={};this.m={};this.v={};this.g={};
  let state=(config.seed??((Math.random()*4294967296)>>>0))>>>0;const rnd=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  for(const [k,n] of Object.entries(this.sizes)){
   this.w[k]=new Float32Array(n);this.m[k]=new Float32Array(n);this.v[k]=new Float32Array(n);this.g[k]=new Float32Array(n);
   let scale=0;
   if(k==='E')scale=.09;else if(k==='R')scale=.015;else if(k==='W1')scale=Math.sqrt(3/(2*D));else if(k==='W2')scale=Math.sqrt(3/H);else if(['WM','IM','CAP'].includes(k))scale=Math.sqrt(1/D);else if(['OP','AP','TH'].includes(k))scale=Math.sqrt(1/D)*.3;else if(k==='HC')scale=.12;
   if(scale)for(let i=0;i<n;i++)this.w[k][i]=(rnd()*2-1)*scale;
  }
  this.w.G.fill(2.2);for(const k of ['AQ','AK','AV','AO'])for(let i=0;i<this.w[k].length;i++)this.w[k][i]=.85+rnd()*.3;
  this.w.NG.fill(1);this.w.Zx.fill(.4);this.w.Zh.fill(.2);this.w.Zb.fill(1.4);this.w.Cx.fill(.7);this.w.Ch.fill(.3);
  const f=n=>new Float32Array(n),B=Math.ceil(C/16);this.b={seq:[],a:f(4*C),att:f(D),local:f(D),gate:f(D),m:f((B+1)*D),u:f(B*D),z:f(B*D),c:f(B*D),hc:f(B*3*D),z0:f(D),cap:f(D),combined:f(D),x:f(2*D),h:f(H),p:f(V),ref:[],initial:f(D)};
  for(let p=0;p<4;p++)this.b.ref.push({input:f(D),norm:f(D),y:f(D),out:f(D),inv:0});
 }
 _rms(input,out){let s=0;for(let i=0;i<this.D;i++)s+=input[i]*input[i];const inv=1/Math.sqrt(s/this.D+1e-5);for(let i=0;i<this.D;i++)out[i]=input[i]*inv*this.w.NG[i];return inv;}
 _rmsBack(input,dy,inv){const D=this.D,dx=new Float32Array(D);let dot=0;for(let d=0;d<D;d++){this.g.NG[d]+=dy[d]*input[d]*inv;dot+=dy[d]*this.w.NG[d]*input[d];}for(let d=0;d<D;d++)dx[d]=dy[d]*this.w.NG[d]*inv-input[d]*inv*inv*inv*dot/D;return dx;}
 forward(tokens,options={}){
  const {D,H,C,V,w,b}=this;const seq=b.seq;seq.length=0;for(let i=Math.max(0,tokens.length-C);i<tokens.length;i++){const t=tokens[i];if(!Number.isInteger(t)||t<0||t>255)throw Error('Input contains a non-byte token');seq.push(t);}if(!seq.length)seq.push(32);
  const n=seq.length,last=seq[n-1],qo=last*D,K=options.heads||this.heads,scale=1/Math.sqrt(D),a=b.a;for(const key of ['att','local','m','u','z','c','hc','z0','cap','combined','x','h','p'])b[key].fill(0);
  const flags={...this.flags,...options.flags};b.flags=flags;b.K=K;b.n=n;b.last=last;
  let localDen=0;const localStart=Math.max(0,n-8);for(let t=n-1;t>=localStart;t--){const v=1/(n-t),off=seq[t]*D;localDen+=v;for(let d=0;d<D;d++)b.local[d]+=v*w.E[off+d];}
  for(let d=0;d<D;d++){b.local[d]/=localDen;b.gate[d]=1/(1+Math.exp(-w.G[d]));b.x[d]=b.gate[d]*w.E[qo+d]+(1-b.gate[d])*b.local[d];}
  b.localDen=localDen;b.localStart=localStart;
  if(flags.attention){
   for(let h=0;h<K;h++){
    let max=-Infinity;const ha=h*C,hd=h*D;
    for(let t=0;t<n;t++){const distance=n-1-t,off=seq[t]*D,ro=distance*D;let s=w.P[distance]+w.HP[ha+distance];for(let d=0;d<D;d++)s+=w.E[qo+d]*w.AQ[hd+d]*(w.E[off+d]+w.R[ro+d])*w.AK[hd+d]*scale;a[ha+t]=s;if(s>max)max=s;}
    let den=0;for(let t=0;t<n;t++){a[ha+t]=Math.exp(a[ha+t]-max);den+=a[ha+t];}
    for(let t=0;t<n;t++){a[ha+t]/=den;const off=seq[t]*D,ro=(n-1-t)*D;for(let d=0;d<D;d++)b.att[d]+=a[ha+t]*(w.E[off+d]+w.R[ro+d])*w.AV[hd+d]*w.AO[hd+d]/K;}
   }
  }
  const blocks=Math.ceil(n/16);b.blocks=blocks;const initial=options.state;b.initial.fill(0);if(initial&&initial.length===D)b.initial.set(initial);b.m.set(b.initial,0);
  for(let j=0;j<blocks;j++){
   const start=j*16,end=Math.min(n,start+16),o=j*D,next=(j+1)*D;
   for(let t=start;t<end;t++)for(let d=0;d<D;d++)b.u[o+d]+=w.E[seq[t]*D+d]/(end-start);
   if(flags.hierarchy){let ki=0;for(let s=0;s<3;s++){const width=[2,4,8][s],count=Math.min(width,end-start);for(let d=0;d<D;d++){let v=w.HB[s*D+d];for(let k=0;k<count;k++)v+=w.HC[(ki+k)*D+d]*w.E[seq[end-1-k]*D+d];const hv=Math.tanh(v);b.hc[(j*3+s)*D+d]=hv;b.u[o+d]+=hv/3;}ki+=width;}}
   if(flags.memory){for(let d=0;d<D;d++){const u=b.u[o+d],prev=b.m[o+d],z=1/(1+Math.exp(-(w.Zx[d]*u+w.Zh[d]*prev+w.Zb[d]))),c=Math.tanh(w.Cx[d]*u+w.Ch[d]*prev+w.Cb[d]);b.z[o+d]=z;b.c[o+d]=c;b.m[next+d]=z*prev+(1-z)*c;}}
  }
  for(let d=0;d<D;d++){
   let v=b.att[d];if(flags.memory)for(let i=0;i<D;i++)v+=.5*b.m[blocks*D+i]*w.WM[i*D+d];if(flags.hierarchy)v+=.25*b.u[(blocks-1)*D+d];b.z0[d]=v;
  }
  const passes=flags.iterate?Math.max(1,Math.min(4,options.passes||this.passes)):0;b.passes=passes;let z=b.z0;
  for(let cycle=0;cycle<passes;cycle++){const r=b.ref[cycle];r.input.set(z);r.inv=this._rms(r.input,r.norm);for(let d=0;d<D;d++){let v=w.Ib[d];for(let i=0;i<D;i++)v+=r.norm[i]*w.IM[i*D+d];r.y[d]=Math.tanh(v);r.out[d]=r.input[d]+.25*r.y[d];}z=r.out;}
  b.refined=z;
  if(flags.capsules)for(let d=0;d<D;d++){let v=w.Cb2[d];for(let i=0;i<D;i++)v+=z[i]*w.CAP[i*D+d];b.cap[d]=Math.tanh(v);}
  for(let d=0;d<D;d++)b.combined[d]=z[d]+(flags.capsules?.25*b.cap[d]:0);
  const normOut=b.x.subarray(D);b.finalInv=this._rms(b.combined,normOut);
  if(options.featureOnly)return {feature:b.cap,memory:b.m.subarray(blocks*D,(blocks+1)*D),x:b.x};
  for(let j=0;j<H;j++){let v=w.b1[j];for(let i=0;i<2*D;i++)v+=b.x[i]*w.W1[i*H+j];b.h[j]=Math.tanh(v);}
  let max=-Infinity;for(let k=0;k<V;k++){let v=w.b2[k];for(let j=0;j<H;j++)v+=b.h[j]*w.W2[j*V+k];b.p[k]=v;if(v>max)max=v;}let den=0;for(let k=0;k<V;k++){b.p[k]=Math.exp(b.p[k]-max);den+=b.p[k];}for(let k=0;k<V;k++)b.p[k]/=den;
  return {p:b.p,feature:b.cap,memory:b.m.subarray(blocks*D,(blocks+1)*D),x:b.x};
 }
 zeroGrad(){for(const k of this.keys)this.g[k].fill(0);this.activeKeys.clear();}
 _back(dlocal,dcontext,dcap){
  const {D,C,w,g,b}=this,{seq,n,K,flags}=b,qo=b.last*D;
  let dz=this._rmsBack(b.combined,dcontext,b.finalInv);const cp=new Float32Array(D);for(let d=0;d<D;d++)cp[d]=dcap[d]+(flags.capsules?.25*dz[d]:0);
  if(flags.capsules)for(let d=0;d<D;d++){const v=cp[d]*(1-b.cap[d]*b.cap[d]);g.Cb2[d]+=v;for(let i=0;i<D;i++){g.CAP[i*D+d]+=b.refined[i]*v;dz[i]+=w.CAP[i*D+d]*v;}}
  for(let cycle=b.passes-1;cycle>=0;cycle--){const r=b.ref[cycle],dn=new Float32Array(D);for(let d=0;d<D;d++){const v=.25*dz[d]*(1-r.y[d]*r.y[d]);g.Ib[d]+=v;for(let i=0;i<D;i++){g.IM[i*D+d]+=r.norm[i]*v;dn[i]+=w.IM[i*D+d]*v;}}const dr=this._rmsBack(r.input,dn,r.inv);for(let d=0;d<D;d++)dz[d]+=dr[d];}
  const dm=new Float32Array(D),du=new Float32Array(b.blocks*D);
  if(flags.memory)for(let i=0;i<D;i++)for(let d=0;d<D;d++){g.WM[i*D+d]+=.5*b.m[b.blocks*D+i]*dz[d];dm[i]+=.5*w.WM[i*D+d]*dz[d];}
  if(flags.hierarchy)for(let d=0;d<D;d++)du[(b.blocks-1)*D+d]+=.25*dz[d];
  for(let j=b.blocks-1;j>=0;j--){const start=j*16,end=Math.min(n,start+16),o=j*D;
   if(flags.memory)for(let d=0;d<D;d++){const prev=b.m[o+d],z=b.z[o+d],c=b.c[o+d],dzz=dm[d]*(prev-c)*z*(1-z),dcc=dm[d]*(1-z)*(1-c*c);g.Zx[d]+=dzz*b.u[o+d];g.Zh[d]+=dzz*prev;g.Zb[d]+=dzz;g.Cx[d]+=dcc*b.u[o+d];g.Ch[d]+=dcc*prev;g.Cb[d]+=dcc;du[o+d]+=dzz*w.Zx[d]+dcc*w.Cx[d];dm[d]=dm[d]*z+dzz*w.Zh[d]+dcc*w.Ch[d];}
   for(let t=start;t<end;t++)for(let d=0;d<D;d++)g.E[seq[t]*D+d]+=du[o+d]/(end-start);
   if(flags.hierarchy){let ki=0;for(let s=0;s<3;s++){const width=[2,4,8][s],count=Math.min(width,end-start);for(let d=0;d<D;d++){const h=b.hc[(j*3+s)*D+d],v=du[o+d]/3*(1-h*h);g.HB[s*D+d]+=v;for(let k=0;k<count;k++){const ei=seq[end-1-k]*D+d,wi=(ki+k)*D+d;g.HC[wi]+=v*w.E[ei];g.E[ei]+=v*w.HC[wi];}}ki+=width;}}
  }
  if(flags.attention){const scale=1/Math.sqrt(D);for(let h=0;h<K;h++){const hd=h*D,ha=h*C,da=new Float32Array(n);let mean=0;for(let t=0;t<n;t++){const off=seq[t]*D,ro=(n-1-t)*D;let v=0;for(let d=0;d<D;d++)v+=dz[d]*(w.E[off+d]+w.R[ro+d])*w.AV[hd+d]*w.AO[hd+d]/K;da[t]=v;mean+=b.a[ha+t]*v;}
   for(let t=0;t<n;t++){const distance=n-1-t,ro=distance*D,off=seq[t]*D,at=b.a[ha+t],ds=at*(da[t]-mean);g.P[distance]+=ds;g.HP[ha+distance]+=ds;
    for(let d=0;d<D;d++){const query=w.E[qo+d],key=w.E[off+d]+w.R[ro+d],idx=hd+d,vg=at*dz[d]/K;g.AV[idx]+=vg*key*w.AO[idx];g.AO[idx]+=vg*key*w.AV[idx];const dv=vg*w.AV[idx]*w.AO[idx]+ds*query*w.AQ[idx]*w.AK[idx]*scale;g.E[off+d]+=dv;g.R[ro+d]+=dv;g.E[qo+d]+=ds*w.AQ[idx]*key*w.AK[idx]*scale;g.AQ[idx]+=ds*query*key*w.AK[idx]*scale;g.AK[idx]+=ds*query*w.AQ[idx]*key*scale;}
   }
  }}
  for(let d=0;d<D;d++){const z=b.gate[d];g.G[d]+=dlocal[d]*(w.E[qo+d]-b.local[d])*z*(1-z);g.E[qo+d]+=dlocal[d]*z;}
  for(let t=n-1;t>=b.localStart;t--){const weight=1/(n-t)/b.localDen;for(let d=0;d<D;d++)g.E[seq[t]*D+d]+=dlocal[d]*(1-b.gate[d])*weight;}
 }
 accumulateGrad(tokens,target){
  const {D,H,V,w,g}=this;for(const k of this.keys)if(!['OP','Ob','CT','SP','AP','Ab','TH','Tb'].includes(k))this.activeKeys.add(k);if(!Number.isInteger(target)||target<0||target>=V)throw Error('Invalid byte target');const f=this.forward(tokens),p=f.p,loss=-Math.log(Math.max(1e-30,p[target])),dz=new Float32Array(p);dz[target]-=1;const dh=new Float32Array(H),dx=new Float32Array(2*D);
  for(let k=0;k<V;k++)g.b2[k]+=dz[k];for(let j=0;j<H;j++){let s=0;for(let k=0;k<V;k++){g.W2[j*V+k]+=f.x.length?this.b.h[j]*dz[k]:0;s+=w.W2[j*V+k]*dz[k];}dh[j]=s*(1-this.b.h[j]*this.b.h[j]);g.b1[j]+=dh[j];}
  for(let i=0;i<2*D;i++){let s=0;for(let j=0;j<H;j++){g.W1[i*H+j]+=f.x[i]*dh[j];s+=w.W1[i*H+j]*dh[j];}dx[i]=s;}
  this._back(dx.subarray(0,D),dx.subarray(D),new Float32Array(D));return loss;
 }
 _softmax(logits,allowed=null){let max=-Infinity;for(let i=0;i<logits.length;i++)if(!allowed||allowed.includes(i))max=Math.max(max,logits[i]);const out=new Float32Array(logits.length);let den=0;for(let i=0;i<logits.length;i++)if(!allowed||allowed.includes(i)){out[i]=Math.exp(logits[i]-max);den+=out[i];}if(!den)throw Error('No compatible controller operations');for(let i=0;i<out.length;i++)out[i]/=den;return out;}
 controller(feature,prev=64,step=0,allowed=null){const {D,w}=this,logits=new Float32Array(65);for(let k=0;k<65;k++){let v=w.Ob[k]+w.CT[prev*65+k]+w.SP[Math.min(7,step)*65+k];for(let d=0;d<D;d++)v+=feature[d]*w.OP[d*65+k];logits[k]=v;}return this._softmax(logits,allowed);}
 pointers(feature,slot=0,count=8){const {D,w}=this,out=new Float32Array(count);for(let k=0;k<count;k++){let v=w.Ab[slot*8+k];for(let d=0;d<D;d++)v+=feature[d]*w.AP[(slot*D+d)*8+k];out[k]=v;}return this._softmax(out);}
 toolProbs(feature){const {D,w}=this,out=new Float32Array(15);for(let k=0;k<15;k++){let v=w.Tb[k];for(let d=0;d<D;d++)v+=feature[d]*w.TH[d*15+k];out[k]=v;}return this._softmax(out);}
 accumulateAux(tokens,{op=null,prev=64,step=0,args=[],tool=null}={}){
  const {D,w,g}=this;if(op===null&&tool===null&&!args.some(x=>x!==null&&x!==undefined))throw Error('No auxiliary labels supplied');for(const k of this.keys)if(!['W1','b1','W2','b2','G','OP','Ob','CT','SP','AP','Ab','TH','Tb'].includes(k))this.activeKeys.add(k);if(op!==null)for(const k of ['OP','Ob','CT','SP'])this.activeKeys.add(k);if(args.some(x=>x!==null&&x!==undefined))for(const k of ['AP','Ab'])this.activeKeys.add(k);if(tool!==null)for(const k of ['TH','Tb'])this.activeKeys.add(k);const feature=this.forward(tokens,{featureOnly:true}).feature,dc=new Float32Array(D);let loss=0,terms=0;
  const output=(p,target,key,bias,width,base=0)=>{if(!Number.isInteger(target)||target<0||target>=p.length)throw Error('Auxiliary target outside head');loss-=Math.log(Math.max(1e-30,p[target]));terms++;for(let k=0;k<p.length;k++){const v=p[k]-(k===target?1:0);g[bias][base+k]+=v;for(let d=0;d<D;d++){const ix=d*width+k;g[key][ix]+=feature[d]*v;dc[d]+=w[key][ix]*v;}}};
  if(op!==null){const p=this.controller(feature,prev,step);output(p,op,'OP','Ob',65);for(let k=0;k<65;k++){const v=p[k]-(k===op?1:0);g.CT[prev*65+k]+=v;g.SP[Math.min(7,step)*65+k]+=v;}}
  for(let slot=0;slot<Math.min(3,args.length);slot++){const target=args[slot];if(target===null||target===undefined)continue;const p=this.pointers(feature,slot,8);loss-=Math.log(Math.max(1e-30,p[target]));terms++;for(let k=0;k<8;k++){const v=p[k]-(k===target?1:0);g.Ab[slot*8+k]+=v;for(let d=0;d<D;d++){const ix=(slot*D+d)*8+k;g.AP[ix]+=feature[d]*v;dc[d]+=w.AP[ix]*v;}}}
  if(tool!==null)output(this.toolProbs(feature),tool,'TH','Tb',15);
  this._back(new Float32Array(D),new Float32Array(D),dc);return {loss,terms};
 }
 applyGrad(lr,batchSize=1,clipLimit=2,decay=.0001){
  if(!(batchSize>0)||!(lr>0)||!Number.isFinite(lr))throw Error('Invalid optimizer settings');if(!this.activeKeys.size)throw Error('No training objective accumulated');let sq=0;for(const k of this.activeKeys)for(let i=0;i<this.g[k].length;i++){const z=this.g[k][i]/batchSize;sq+=z*z;}const norm=Math.sqrt(sq);if(!Number.isFinite(norm))throw Error('Nonfinite gradient; optimizer update rejected');
  const mult=Math.min(1,clipLimit/(norm||1))/batchSize,age=this.age+1;
  // Entire update is preflighted; a rejected numerical update cannot damage a valid checkpoint.
  for(const k of this.activeKeys){const tick=this.ticks[k]+1,bc1=1-Math.pow(.9,tick),bc2=1-Math.pow(.999,tick),wd=['E','R','W1','W2','WM','IM','CAP','OP','AP','TH'].includes(k)?decay:0,weights=this.w[k],gg=this.g[k],mm=this.m[k],vv=this.v[k];for(let i=0;i<weights.length;i++){const z=gg[i]*mult,m=.9*mm[i]+.1*z,v=.999*vv[i]+.001*z*z,next=weights[i]-lr*(m/bc1/(Math.sqrt(v/bc2)+1e-8)+wd*weights[i]);if(!Number.isFinite(next)||!Number.isFinite(v)||v<0)throw Error('Unsafe optimizer update rejected');}}
  for(const k of this.activeKeys){const tick=this.ticks[k]+1,bc1=1-Math.pow(.9,tick),bc2=1-Math.pow(.999,tick),wd=['E','R','W1','W2','WM','IM','CAP','OP','AP','TH'].includes(k)?decay:0,weights=this.w[k],gg=this.g[k],mm=this.m[k],vv=this.v[k];for(let i=0;i<weights.length;i++){const z=gg[i]*mult;mm[i]=.9*mm[i]+.1*z;vv[i]=.999*vv[i]+.001*z*z;weights[i]-=lr*(mm[i]/bc1/(Math.sqrt(vv[i]/bc2)+1e-8)+wd*weights[i]);}}
  for(const k of this.activeKeys)this.ticks[k]++;this.age=age;this.steps++;this.lastGradNorm=norm;return norm;
 }
 evaluate(tokens,target){return -Math.log(Math.max(1e-30,this.forward(tokens).p[target]));}
 trainOne(tokens,target,lr){this.zeroGrad();const loss=this.accumulateGrad(tokens,target);this.applyGrad(lr);return loss;}
 choose(tokens,temp,top,recent=[],nucleus=.92){
  const p=this.forward(tokens,{state:this.inferenceState}).p,tail=recent.length?recent:tokens;let needed=0,lo=128,hi=191;
  for(let i=tail.length-1,count=0;i>=0&&count<4;i--,count++){const b=tail[i];if(b>=128&&b<=191)continue;const width=b>=240&&b<=244?4:b>=224&&b<=239?3:b>=194&&b<=223?2:1;needed=Math.max(0,width-1-count);if(needed&&count===0){if(b===224)lo=160;if(b===237)hi=159;if(b===240)lo=144;if(b===244)hi=143;}break;}
  const ids=Array.from({length:256},(_,i)=>i).filter(i=>needed?i>=lo&&i<=hi:i===9||i===10||i===13||(i>=32&&i<=126)||(i>=194&&i<=244));ids.sort((a,b)=>p[b]-p[a]);if(temp<=0)return ids[0];const chosen=ids.slice(0,Math.max(1,top||ids.length)),weights=chosen.map(i=>Math.exp((Math.log(Math.max(p[i],1e-30))-Math.log(Math.max(p[chosen[0]],1e-30)))/temp)),total=weights.reduce((a,b)=>a+b,0);let sum=0,count=0;for(;count<weights.length;count++){sum+=weights[count];if(sum/total>=nucleus){count++;break;}}let r=Math.random()*sum;for(let i=0;i<count;i++){r-=weights[i];if(r<=0)return chosen[i];}return chosen[0];
 }
 parameterCount(){return Object.values(this.sizes).reduce((a,b)=>a+b,0);}
 pack(){
  const meta={signature:'LUMINA_NEXUS_2',version:4,D:this.D,H:this.H,C:512,V:256,heads:this.heads,passes:this.passes,trainC:this.trainC,steps:this.steps,age:this.age,auxSteps:this.auxSteps,ticks:this.ticks,keys:this.keys,sizes:this.sizes},head=new TextEncoder().encode(JSON.stringify(meta)),start=(32+head.length+3)&~3,total=start+this.parameterCount()*12,buffer=new ArrayBuffer(total),out=new Uint8Array(buffer),dv=new DataView(buffer);dv.setUint32(0,0x34554d4c,true);dv.setUint32(4,4,true);dv.setUint32(8,head.length,true);dv.setUint32(12,start,true);dv.setUint32(16,total,true);out.set(head,32);let at=start;for(const kind of ['w','m','v'])for(const k of this.keys){const arr=this[kind][k];for(let i=0;i<arr.length;i++)if(!Number.isFinite(arr[i])||(kind==='v'&&arr[i]<0))throw Error('Cannot save nonfinite/corrupt model state');out.set(new Uint8Array(arr.buffer,arr.byteOffset,arr.byteLength),at);at+=arr.byteLength;}let hash=2166136261;for(let i=32;i<out.length;i++){hash^=out[i];hash=Math.imul(hash,16777619);}dv.setUint32(20,hash>>>0,true);return buffer;
 }
 load(input){
  if(typeof input==='string'||input&&typeof input==='object'&&!(input instanceof ArrayBuffer)&&!ArrayBuffer.isView(input))return this.migrateLegacy(input);
  const buffer=input instanceof ArrayBuffer?input:input?.buffer?.slice(input.byteOffset,input.byteOffset+input.byteLength);if(!(buffer instanceof ArrayBuffer)||buffer.byteLength<32)throw Error('Checkpoint header missing');const dv=new DataView(buffer);if(dv.getUint32(0,true)!==0x34554d4c)return this.migrateLegacy(buffer);
  if(dv.getUint32(4,true)!==4||dv.getUint32(16,true)!==buffer.byteLength)throw Error('Unsupported or incomplete checkpoint');const bytes=new Uint8Array(buffer),hlen=dv.getUint32(8,true),start=dv.getUint32(12,true);if(hlen>100000||start!==((32+hlen+3)&~3)||start>buffer.byteLength)throw Error('Invalid checkpoint metadata');let hash=2166136261;for(let i=32;i<bytes.length;i++){hash^=bytes[i];hash=Math.imul(hash,16777619);}if((hash>>>0)!==dv.getUint32(20,true))throw Error('Corrupt checkpoint checksum');const m=JSON.parse(new TextDecoder().decode(bytes.subarray(32,32+hlen)));
  if(m.signature!=='LUMINA_NEXUS_2'||m.D!==this.D||m.H!==this.H||m.C!==512||JSON.stringify(m.sizes)!==JSON.stringify(this.sizes)||JSON.stringify(m.keys)!==JSON.stringify(this.keys)||buffer.byteLength!==start+this.parameterCount()*12)throw Error('Incompatible checkpoint architecture');for(const key of ['steps','age','auxSteps'])if(!Number.isSafeInteger(m[key])||m[key]<0)throw Error('Invalid optimizer counters');if(![2,4].includes(m.heads)||![1,2,3,4].includes(m.passes)||![96,256,512].includes(m.trainC))throw Error('Invalid architecture options');
  for(const k of this.keys)if(!Number.isSafeInteger(m.ticks?.[k])||m.ticks[k]<0||m.ticks[k]>m.steps)throw Error('Invalid optimizer age for '+k);
  let at=start;for(const kind of ['w','m','v'])for(const k of this.keys){const arr=new Float32Array(buffer,at,this.sizes[k]);for(let i=0;i<arr.length;i++)if(!Number.isFinite(arr[i])||(kind==='v'&&arr[i]<0))throw Error('Checkpoint contains invalid '+kind+' values');at+=arr.byteLength;}
  at=start;for(const kind of ['w','m','v'])for(const k of this.keys){this[kind][k].set(new Float32Array(buffer,at,this.sizes[k]));at+=this.sizes[k]*4;}for(const key of ['steps','age','auxSteps','heads','passes','trainC'])this[key]=m[key];this.ticks={...m.ticks};this.inferenceState=null;return 'native-nexus';
 }
 migrateLegacy(input){
  if(typeof LegacyContextNet!=='function')throw Error('Legacy loader unavailable');const old=new LegacyContextNet();old.load(input);if(this.D!==160)throw Error('Legacy migration requires standard dimensions');
  // Transfer matrices by row stride. New modules have no equivalent; their optimizer starts at zero.
  for(const k of ['E','P','G','b2'])this.w[k].set(old.w[k]);for(let i=0;i<old.w.R.length;i++)this.w.R[i]=old.w.R[i];for(let i=0;i<2*this.D;i++)for(let j=0;j<old.H;j++)this.w.W1[i*this.H+j]=old.w.W1[i*old.H+j];for(let j=0;j<old.H;j++){this.w.b1[j]=old.w.b1[j];for(let k=0;k<256;k++)this.w.W2[j*256+k]=old.w.W2[j*256+k];}
  for(const kind of ['m','v'])for(const k of this.keys)this[kind][k].fill(0);this.steps=0;this.age=0;for(const k of this.keys)this.ticks[k]=0;this.migratedUpdates=old.steps;return 'legacy-transfer-nexus';
 }
}

// Deterministic cells are a typed instruction set, not natural-language answers.
const CELL_LIBRARY=[];
function defineCell(id,inputs,output,fn){CELL_LIBRARY.push(Object.freeze({id,index:CELL_LIBRARY.length,inputs,output,fn,version:1}));}
defineCell('identity',['any'],'any',a=>a);
defineCell('add',['number','number'],'number',(a,b)=>a+b);
defineCell('subtract',['number','number'],'number',(a,b)=>a-b);
defineCell('multiply',['number','number'],'number',(a,b)=>a*b);
defineCell('divide',['number','number'],'number',(a,b)=>{if(b===0)throw Error('Division by zero');return a/b;});
defineCell('modulo',['number','number'],'number',(a,b)=>{if(b===0)throw Error('Modulo by zero');return a%b;});
defineCell('minimum',['number','number'],'number',(a,b)=>Math.min(a,b));
defineCell('maximum',['number','number'],'number',(a,b)=>Math.max(a,b));
defineCell('power',['number','number'],'number',(a,b)=>{if(Math.abs(b)>64)throw Error('Exponent exceeds 64');return a**b;});
defineCell('absolute',['number'],'number',a=>Math.abs(a));
defineCell('negate',['number'],'number',a=>-a);
defineCell('round',['number'],'number',a=>Math.round(a));
defineCell('floor',['number'],'number',a=>Math.floor(a));
defineCell('ceiling',['number'],'number',a=>Math.ceil(a));
defineCell('square_root',['number'],'number',a=>{if(a<0)throw Error('Negative square root');return Math.sqrt(a);});
defineCell('clamp',['number','number','number'],'number',(a,b,c)=>{if(b>c)throw Error('Inverted bounds');return Math.max(b,Math.min(c,a));});
defineCell('less_than',['number','number'],'boolean',(a,b)=>a<b);
defineCell('at_most',['number','number'],'boolean',(a,b)=>a<=b);
defineCell('equal',['any','any'],'boolean',(a,b)=>JSON.stringify(a)===JSON.stringify(b));
defineCell('not',['boolean'],'boolean',a=>!a);
defineCell('and',['boolean','boolean'],'boolean',(a,b)=>a&&b);
defineCell('or',['boolean','boolean'],'boolean',(a,b)=>a||b);
defineCell('select',['boolean','any','any'],'any',(a,b,c)=>a?b:c);
defineCell('number_text',['number'],'string',a=>String(a));
defineCell('parse_number',['string'],'number',a=>{if(!a.trim())throw Error('Empty number');const n=Number(a);if(!Number.isFinite(n))throw Error('Invalid number');return n;});
defineCell('concatenate',['string','string'],'string',(a,b)=>a+b);
defineCell('uppercase',['string'],'string',a=>a.toUpperCase());
defineCell('lowercase',['string'],'string',a=>a.toLowerCase());
defineCell('trim',['string'],'string',a=>a.trim());
defineCell('text_length',['string'],'number',a=>a.length);
defineCell('contains',['string','string'],'boolean',(a,b)=>a.includes(b));
defineCell('starts_with',['string','string'],'boolean',(a,b)=>a.startsWith(b));
defineCell('ends_with',['string','string'],'boolean',(a,b)=>a.endsWith(b));
defineCell('replace_text',['string','string','string'],'string',(a,b,c)=>{if(b==='')throw Error('Empty match');return a.split(b).join(c);});
defineCell('slice_text',['string','number','number'],'string',(a,b,c)=>a.slice(Math.trunc(b),Math.trunc(c)));
defineCell('split_text',['string','string'],'array',(a,b)=>a.split(b));
defineCell('join_text',['array','string'],'string',(a,b)=>a.join(b));
defineCell('reverse_text',['string'],'string',a=>Array.from(a).reverse().join(''));
defineCell('text_at',['string','number'],'string',(a,b)=>Array.from(a).at(Math.trunc(b))??'');
defineCell('repeat_text',['string','number'],'string',(a,b)=>{const n=Math.trunc(b);if(n<0||n>1000||a.length*n>100000)throw Error('Repetition budget exceeded');return a.repeat(n);});
defineCell('array_length',['array'],'number',a=>a.length);
defineCell('array_at',['array','number'],'any',(a,b)=>a.at(Math.trunc(b))??null);
defineCell('append',['array','any'],'array',(a,b)=>a.concat([b]));
defineCell('concat_arrays',['array','array'],'array',(a,b)=>a.concat(b));
defineCell('reverse_array',['array'],'array',a=>a.slice().reverse());
defineCell('sort_numbers',['array'],'array',a=>{if(!a.every(x=>typeof x==='number'&&Number.isFinite(x)))throw Error('Numeric array required');return a.slice().sort((x,y)=>x-y);});
defineCell('sum',['array'],'number',a=>{if(!a.every(x=>typeof x==='number'&&Number.isFinite(x)))throw Error('Numeric array required');return a.reduce((x,y)=>x+y,0);});
defineCell('mean',['array'],'number',a=>{if(!a.length||!a.every(x=>typeof x==='number'&&Number.isFinite(x)))throw Error('Nonempty numeric array required');return a.reduce((x,y)=>x+y,0)/a.length;});
defineCell('array_minimum',['array'],'number',a=>{if(!a.length||!a.every(x=>typeof x==='number'&&Number.isFinite(x)))throw Error('Nonempty numeric array required');return Math.min(...a);});
defineCell('array_maximum',['array'],'number',a=>{if(!a.length||!a.every(x=>typeof x==='number'&&Number.isFinite(x)))throw Error('Nonempty numeric array required');return Math.max(...a);});
defineCell('unique',['array'],'array',a=>{const seen=new Set();return a.filter(x=>{const k=JSON.stringify(x);if(seen.has(k))return false;seen.add(k);return true;});});
defineCell('map_add',['array','number'],'array',(a,b)=>{if(!a.every(x=>typeof x==='number'))throw Error('Numeric array required');return a.map(x=>x+b);});
defineCell('filter_greater',['array','number'],'array',(a,b)=>{if(!a.every(x=>typeof x==='number'))throw Error('Numeric array required');return a.filter(x=>x>b);});
defineCell('get_property',['object','string'],'any',(a,b)=>Object.hasOwn(a,b)?a[b]:null);
defineCell('set_property',['object','string','any'],'object',(a,b,c)=>({...a,[b]:c}));
defineCell('keys',['object'],'array',a=>Object.keys(a));
defineCell('values',['object'],'array',a=>Object.values(a));
defineCell('has_property',['object','string'],'boolean',(a,b)=>Object.hasOwn(a,b));
defineCell('parse_json',['string'],'any',a=>JSON.parse(a));
defineCell('to_json',['any'],'string',a=>JSON.stringify(a));
defineCell('range',['number','number'],'array',(a,b)=>{a=Math.trunc(a);b=Math.trunc(b);if(b<a||b-a>1000)throw Error('Range budget exceeded');return Array.from({length:b-a},(_,i)=>a+i);});
defineCell('pair',['any','any'],'array',(a,b)=>[a,b]);
defineCell('request_tool',['string','object'],'object',(a,b)=>({name:a,arguments:b}));
defineCell('is_null',['any'],'boolean',a=>a===null);
const CELL_MAP=new Map(CELL_LIBRARY.map(c=>[c.id,c]));
const NEURAL_TOOLS=['list_files','read_file','write_file','search_workspace','runtime_smoke_test','validate_html','validate_js','validate_json','preview_project','export_zip','import_files','calculate','fetch_url','run_javascript','none'];
const IR_TYPES=['number','string','boolean','array','object','null','any'];
function valueType(x){return x===null?'null':Array.isArray(x)?'array':typeof x;}
function typeFits(from,to){return to==='any'||from===to;}
function boundedValue(x,depth=0){
 if(depth>12)throw Error('Value nesting budget exceeded');const t=x===null?'null':Array.isArray(x)?'array':typeof x;
 if(t==='number'){if(!Number.isFinite(x)||Math.abs(x)>1e15)throw Error('Nonfinite or excessively large number');}
 else if(t==='string'){if(x.length>100000)throw Error('Text budget exceeded');}
 else if(t==='array'){if(x.length>4096)throw Error('Array budget exceeded');for(const v of x)boundedValue(v,depth+1);}
 else if(t==='object'){if(Object.keys(x).length>256)throw Error('Object budget exceeded');for(const [k,v] of Object.entries(x)){if(['__proto__','prototype','constructor'].includes(k))throw Error('Reserved property');boundedValue(v,depth+1);}}
 else if(t!=='null'&&t!=='boolean')throw Error('JSON values only');return x;
}
function stableJSON(x){if(Array.isArray(x))return '['+x.map(stableJSON).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stableJSON(x[k])).join(',')+'}';return JSON.stringify(x);}
function sameValue(a,b){return typeof a==='number'&&typeof b==='number'?Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(b)):stableJSON(a)===stableJSON(b);}
function stableHash(value){const s=typeof value==='string'?value:stableJSON(value);let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}h^=h>>>16;h=Math.imul(h,0x85ebca6b);h^=h>>>13;h=Math.imul(h,0xc2b2ae35);h^=h>>>16;return (h>>>0).toString(16);}
function cloneJSON(x){return JSON.parse(JSON.stringify(x));}
function cosine(a,b){let dot=0,x=0,y=0;for(let i=0;i<Math.min(a.length,b.length);i++){dot+=a[i]*b[i];x+=a[i]*a[i];y+=b[i]*b[i];}return dot/Math.sqrt(x*y||1);}
function refKey(r){return stableJSON(r);}
function inputRefs(schema){return Object.entries(schema.inputs).map(([input,type])=>({r:{input},type}));}
function availableRefs(schema,nodes,types){return inputRefs(schema).concat(nodes.slice().reverse().map(n=>({r:{ref:n.id},type:types[n.id]})),(schema.constants||[]).map(value=>({r:{const:value},type:valueType(value)}))).slice(0,8);}
function normalizeSchema(schema){if(!schema||typeof schema!=='object'||!schema.inputs||Array.isArray(schema.inputs))throw Error('Schema needs an inputs object');const names=Object.keys(schema.inputs);if(names.length>4||names.some(k=>!/^\w{1,32}$/.test(k)||['__proto__','constructor','prototype'].includes(k))||Object.values(schema.inputs).some(t=>!IR_TYPES.includes(t)))throw Error('Use at most four named, typed inputs');const constants=schema.constants||[];if(!Array.isArray(constants)||constants.length>4)throw Error('Use at most four literal constants');constants.forEach(x=>boundedValue(x));if(!IR_TYPES.includes(schema.output||'any'))throw Error('Invalid output type');return {inputs:{...schema.inputs},output:schema.output||'any',constants:cloneJSON(constants)};}
class OutcomeNet {
 constructor(saved){this.N=80;this.O=6;this.w=new Float32Array(this.N*this.O);this.steps=0;this.opCounts=Array(64).fill(0);if(saved){if(saved.w?.length!==this.w.length||saved.w.some(x=>!Number.isFinite(x)))throw Error('Invalid consequence predictor');this.w.set(saved.w);if(!Number.isSafeInteger(saved.steps)||saved.steps<0)throw Error('Invalid consequence optimizer counter');this.steps=saved.steps;this.opCounts=saved.opCounts?.length===64?saved.opCounts.map(x=>Math.max(0,Number(x)||0)):this.opCounts;}}
 features(op,args){const x=new Float32Array(80);x[0]=1;if(op>=0&&op<64)x[1+op]=1;for(let i=0;i<Math.min(3,args.length);i++){const a=args[i],t=valueType(a);x[65+i]=t==='number'?Math.tanh(a/100):0;x[68+i]=t==='string'||t==='array'?Math.tanh(a.length/100):t==='object'?Math.tanh(Object.keys(a).length/100):0;x[71+i]=t==='boolean'?(a?1:-1):0;x[74+i]=t==='number'?1:0;}x[77]=args.length/3;x[78]=args.some(a=>a!==null&&typeof a==='object'&&!Array.isArray(a))?1:0;x[79]=args.filter(a=>a===null).length/3;return x;}
 target(value){const t=valueType(value);return Float32Array.from([t==='number'?Math.tanh(value/100):0,t==='array'||t==='string'?Math.tanh(value.length/100):0,t==='boolean'?(value?1:-1):0,t==='number'?1:0,t==='string'?1:0,t==='array'?1:0]);}
 predict(op,args){const x=this.features(op,args),p=new Float32Array(6);for(let o=0;o<6;o++)for(let i=0;i<80;i++)p[o]+=x[i]*this.w[i*6+o];return p;}
 train(trace,lr=.025){const x=this.features(trace.opIndex,trace.args),p=this.predict(trace.opIndex,trace.args),y=this.target(trace.result);let mse=0;for(let o=0;o<6;o++){const e=Math.max(-3,Math.min(3,p[o]-y[o]));mse+=e*e;for(let i=0;i<80;i++)this.w[i*6+o]-=lr*e*x[i]/6;}this.steps++;this.opCounts[trace.opIndex]++;return mse/6;}
 evaluate(traces){if(!traces.length)return null;let mse=0;for(const t of traces){const p=this.predict(t.opIndex,t.args),y=this.target(t.result);for(let o=0;o<6;o++)mse+=(p[o]-y[o])**2;}return {mse:mse/(traces.length*6),count:traces.length};}
 json(){return {w:Array.from(this.w),steps:this.steps,opCounts:this.opCounts};}
}
class NexusEngine {
 constructor(net,saved=null){
  this.net=net;this.dataBudgetBytes=32_000_000;this.busy=false;this.cancel=false;this.lastResult=null;this.limits={examples:1200,organisms:96,traces:1200,counterexamples:256,spine:128,goals:32,branches:128};
  this.state={version:2,examples:[],organisms:[],bonds:{},cellStats:{},goals:[],spine:[],continuity:{},capsules:[],traces:[],counterexamples:[],evaluations:[],evolution:[],consolidations:[],metrics:{constructions:0,verified:0,failed:0,controllerUpdates:0,abstractions:0,transferAttempts:0,transferPass:0},session:{chat:'chat-'+Date.now(),work:'work-'+Date.now()}};
  if(saved)this.restore(saved);else this.outcome=new OutcomeNet();
 }
 snapshot(){return {...cloneJSON(this.state),outcome:this.outcome.json()};}
 restore(raw){
  if(!raw||raw.version!==2)throw Error('Unsupported intelligence archive');if(JSON.stringify(raw).length>48_000_000)throw Error('Intelligence archive exceeds 48 MB data budget');const candidate=cloneJSON(raw);for(const key of ['examples','organisms','goals','spine','capsules','traces','counterexamples','evaluations','evolution','consolidations'])if(!Array.isArray(candidate[key])||candidate[key].length>5000)throw Error('Invalid intelligence collection '+key);for(const key of ['bonds','cellStats','continuity','metrics','session'])if(!candidate[key]||typeof candidate[key]!=='object'||Array.isArray(candidate[key]))throw Error('Invalid intelligence field '+key);
  const before=this.state;this.state=candidate;try{for(const o of this.state.organisms){o.schema=normalizeSchema(o.schema);this.validate(o.program,o.schema,new Set([o.id]));}for(const e of this.state.examples)this.normalizeExample(e);for(const v of Object.values(candidate.continuity))if(!Array.isArray(v.value)||v.value.length!==this.net.D||v.value.some(x=>!Number.isFinite(x)))throw Error('Invalid recurrent continuity');this.outcome=new OutcomeNet(raw.outcome);delete this.state.outcome;}catch(e){this.state=before;throw e;}
 }
 cellInfo(op){if(CELL_MAP.has(op))return CELL_MAP.get(op);if(op.startsWith('skill:')){const skill=this.state.organisms.find(o=>o.id===op.slice(6)&&o.verified&&!o.retired);if(!skill)throw Error('Verified skill missing: '+op);return {id:op,inputs:Object.values(skill.schema.inputs),output:skill.schema.output,skill,index:64};}throw Error('Unknown Logic Cell '+op);}
 validate(program,schema,ancestors=new Set()){
  schema=normalizeSchema(schema);if(!program||program.version!==1||!Array.isArray(program.nodes)||program.nodes.length>24||!program.output)throw Error('Expected typed IR version 1, nodes and output (maximum 24 nodes)');const types={},ids=new Set();
  const refType=r=>{if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length!==1)throw Error('Reference needs exactly one of input, ref or const');if(Object.hasOwn(r,'input')){if(!Object.hasOwn(schema.inputs,r.input))throw Error('Input missing: '+r.input);return schema.inputs[r.input];}if(Object.hasOwn(r,'ref')){if(!Object.hasOwn(types,r.ref))throw Error('Dependency must precede its use: '+r.ref);return types[r.ref];}if(Object.hasOwn(r,'const')){boundedValue(r.const);return valueType(r.const);}throw Error('Invalid IR reference');};
  for(const node of program.nodes){if(!node||!/^n\d{1,3}$/.test(node.id)||ids.has(node.id))throw Error('Unique node IDs n0, n1… required');ids.add(node.id);const cell=this.cellInfo(node.op);if(!Array.isArray(node.args)||node.args.length!==cell.inputs.length)throw Error('Wrong argument count for '+node.op);const ts=node.args.map(refType);if(!ts.every((t,i)=>typeFits(t,cell.inputs[i])))throw Error('Type mismatch in '+node.id+' / '+node.op);if(cell.skill){if(ancestors.has(cell.skill.id)||ancestors.size>6)throw Error('Cyclic or deeply nested skill');this.validate(cell.skill.program,cell.skill.schema,new Set([...ancestors,cell.skill.id]));}types[node.id]=cell.output==='any'&&node.op==='identity'?ts[0]:cell.output==='any'&&node.op==='select'&&ts[1]===ts[2]?ts[1]:cell.output;}
  const output=refType(program.output);if(!typeFits(output,schema.output))throw Error('Output type '+output+' does not satisfy '+schema.output);return {types,output,schema};
 }
 run(program,input,schema,trace=[],budget={steps:0},depth=0){
  if(depth>6)throw Error('Skill nesting budget exceeded');this.validate(program,schema);boundedValue(input);for(const [name,type] of Object.entries(schema.inputs))if(!Object.hasOwn(input,name)||!typeFits(valueType(input[name]),type))throw Error('Invalid input '+name+'; expected '+type);const values=Object.create(null),resolve=r=>Object.hasOwn(r,'input')?input[r.input]:Object.hasOwn(r,'ref')?values[r.ref]:r.const;
  for(const node of program.nodes){if(++budget.steps>256)throw Error('Execution step budget exceeded');const cell=this.cellInfo(node.op),args=node.args.map(resolve);args.forEach((v,i)=>{boundedValue(v);if(!typeFits(valueType(v),cell.inputs[i]))throw Error('Runtime argument type mismatch');});const start=performance.now();let result;try{if(cell.skill){const child={};Object.keys(cell.skill.schema.inputs).forEach((k,i)=>child[k]=args[i]);result=this.run(cell.skill.program,child,cell.skill.schema,trace,budget,depth+1);}else result=cell.fn(...args);boundedValue(result);}catch(e){if(!cell.skill&&trace.length<256)trace.push({op:cell.id,opIndex:cell.index,node:node.id,depth,args:cloneJSON(args),error:e.message,ms:performance.now()-start});throw e;}values[node.id]=result;if(!cell.skill&&trace.length<256)trace.push({op:cell.id,opIndex:cell.index,node:node.id,depth,args:cloneJSON(args),result:cloneJSON(result),ms:performance.now()-start});}
  const output=resolve(program.output);boundedValue(output);if(!typeFits(valueType(output),schema.output))throw Error('Runtime output type mismatch');return cloneJSON(output);
 }
 compile(program,schema){
  this.validate(program,schema);const specs=new Map(),skills=new Map();let count=0;const ref=r=>Object.hasOwn(r,'input')?'input['+JSON.stringify(r.input)+']':Object.hasOwn(r,'ref')?r.ref:JSON.stringify(r.const);
  const body=(p,s,depth=0)=>{if(depth>6)throw Error('Skill nesting budget exceeded');let code='';for(const [name,type] of Object.entries(s.inputs))code+='if(!Object.hasOwn(input,'+JSON.stringify(name)+')||!fits(type(input['+JSON.stringify(name)+']),'+JSON.stringify(type)+'))throw Error("Input type mismatch");\n';for(const node of p.nodes){const cell=this.cellInfo(node.op);let name;if(cell.skill){name='skill_'+cell.skill.id.replace(/[^a-z0-9]/gi,'_');if(!skills.has(name)){skills.set(name,'pending');const child=body(cell.skill.program,cell.skill.schema,depth+1);skills.set(name,'function '+name+'(input){'+child+'}\n');}const obj='{'+Object.keys(cell.skill.schema.inputs).map((k,i)=>JSON.stringify(k)+':'+ref(node.args[i])).join(',')+'}';code+='const '+node.id+'=boundedValue('+name+'('+obj+'));\n';}else{specs.set(cell.id,{fn:cell.fn.toString(),inputs:cell.inputs});code+='const '+node.id+'=call('+JSON.stringify(cell.id)+',['+node.args.map(ref).join(',')+']);\n';}if(++count>256)throw Error('Compiled step budget exceeded');}return code+'return boundedValue('+ref(p.output)+');';};
  const main=body(program,schema);const defs=[...specs].map(([id,s])=>JSON.stringify(id)+':{fn:'+s.fn+',inputs:'+JSON.stringify(s.inputs)+'}').join(',');return '// LUMINA typed IR v1. Pure bounded JSON transformations. No OS or network access.\nfunction luminaProgram(input){\n"use strict";\n'+boundedValue.toString()+'\nconst type=x=>x===null?"null":Array.isArray(x)?"array":typeof x;const fits=(a,b)=>b==="any"||a===b;\nboundedValue(input);const cells={'+defs+'};\nfunction call(id,args){const c=cells[id];args.forEach((x,i)=>{boundedValue(x);if(!fits(type(x),c.inputs[i]))throw Error("Argument type mismatch")});return boundedValue(c.fn(...args))}\n'+[...skills.values()].join('')+main+'\n}';
 }
 test(program,schema,tests,{compiled=false}={}){let fn=null;if(compiled)fn=new Function(this.compile(program,schema)+';return luminaProgram;')();const results=[];for(const test of tests){const trace=[];try{const actual=fn?fn(cloneJSON(test.input)):this.run(program,cloneJSON(test.input),schema,trace),ok=sameValue(actual,test.expected);results.push({ok,input:test.input,expected:test.expected,actual,trace});}catch(e){results.push({ok:false,input:test.input,expected:test.expected,error:e.message,trace});}}return {passed:results.filter(x=>x.ok).length,total:results.length,results};}
 feature(task){return this.net.forward(Array.from(enc.encode(task).slice(-512)),{featureOnly:true}).feature.slice();}
 normalizeExample(raw){
  if(JSON.stringify(raw).length>1_000_000)throw Error('Structured record exceeds 1 MB working-data budget');if(!raw||typeof raw.task!=='string'||!raw.task.trim()||raw.task.length>12000)throw Error('Every example needs a task string');const schema=normalizeSchema(raw.schema),program=cloneJSON(raw.program);this.validate(program,schema);if(!Array.isArray(raw.tests)||raw.tests.length<1||raw.tests.length>64)throw Error('Provide 1–64 executable test cases');const testMap=new Map();for(const t of raw.tests){if(!t||!Object.hasOwn(t,'input')||!Object.hasOwn(t,'expected'))throw Error('Test needs input and expected');boundedValue(t.input);boundedValue(t.expected);const key=stableJSON(t.input);if(testMap.has(key)&&!sameValue(testMap.get(key).expected,t.expected))throw Error('Conflicting test expectations');testMap.set(key,cloneJSON(t));}const id=raw.id||stableHash({task:raw.task,schema,program}),split=['train','val','transfer'].includes(raw.split)?raw.split:parseInt(stableHash(raw.task),16)%10===0?'val':'train',family=String(raw.family||'user').slice(0,80);let tool=null;if(raw.tool!==undefined&&raw.tool!==null){tool=typeof raw.tool==='number'?raw.tool:NEURAL_TOOLS.indexOf(raw.tool);if(!Number.isInteger(tool)||tool<0||tool>=15)throw Error('Unsupported tool label');}return {id,task:raw.task.trim(),schema,program,tests:[...testMap.values()],family,split,tool};
 }
 addExamples(records){
  if(!Array.isArray(records))throw Error('Structured import needs an array');const batch=records.map(x=>this.normalizeExample(x)),all=this.state.examples.concat(batch),transferFamilies=new Set(all.filter(e=>e.split==='transfer').map(e=>e.family)),taskSplits=new Map();
  for(const e of all){if(transferFamilies.has(e.family)&&e.split!=='transfer')throw Error('Transfer family '+e.family+' also appears in training/validation');const task=e.task.toLowerCase().replace(/\s+/g,' ').trim(),prior=taskSplits.get(task);if(prior&&prior!==e.split)throw Error('The same task cannot be both training and held-out data');taskSplits.set(task,e.split);}
  const seen=new Set(this.state.examples.map(e=>e.id)),fresh=[];for(const e of batch){if(seen.has(e.id))continue;seen.add(e.id);fresh.push(e);}if(this.state.examples.length+fresh.length>this.limits.examples)throw Error('Structured example budget reached; export and remove a corpus first');if(JSON.stringify(this.state).length+JSON.stringify(fresh).length>this.dataBudgetBytes)throw Error('Configured retained-data budget reached');
  for(const e of fresh){const verified=this.test(e.program,e.schema,e.tests);if(verified.passed!==verified.total)throw Error('Reference IR fails its own tests: '+e.task);}this.state.examples.push(...fresh);return fresh.length;
 }

 labels(example){const types={},nodes=[],labels=[];let prev=64;for(let step=0;step<example.program.nodes.length;step++){const node=example.program.nodes[step],cell=this.cellInfo(node.op);if(cell.skill)continue;const refs=availableRefs(example.schema,nodes,types),args=node.args.map(r=>{const i=refs.findIndex(x=>refKey(x.r)===refKey(r));return i<0?null:i;});labels.push({op:cell.index,prev,step,args,tool:step===0?example.tool:null});nodes.push(node);types[node.id]=this.validate({version:1,nodes:cloneJSON(nodes),output:{ref:node.id}}, {...example.schema,output:'any'}).types[node.id];prev=cell.index;}labels.push({op:64,prev,step:Math.min(7,example.program.nodes.length),args:[],tool:example.program.nodes.length?null:example.tool});return labels;}
 async controllerLoss(examples){let loss=0,terms=0;for(let i=0;i<examples.length;i++){const e=examples[i],feature=this.feature(e.task);for(const label of this.labels(e)){const p=this.net.controller(feature,label.prev,label.step);loss-=Math.log(Math.max(1e-30,p[label.op]));terms++;for(let slot=0;slot<label.args.length;slot++){if(label.args[slot]===null)continue;loss-=Math.log(Math.max(1e-30,this.net.pointers(feature,slot)[label.args[slot]]));terms++;}if(label.tool!==null&&label.tool!==undefined){loss-=Math.log(Math.max(1e-30,this.net.toolProbs(feature)[label.tool]));terms++;}}if((i&3)===3)await sleep(0);}return terms?loss/terms:null;}
 async trainController({epochs=1,lr=.00015,consolidate=false,validateLanguage=async()=>null,onProgress=()=>{}}={}){
  if(this.busy)throw Error('Intelligence operation already running');let train=this.state.examples.filter(e=>e.split==='train');if(consolidate){const failedTasks=new Set(this.state.counterexamples.filter(e=>!e.transfer).map(e=>e.task));train=train.concat(train.filter(e=>failedTasks.has(e.task)).slice(0,128));}const val=this.state.examples.filter(e=>e.split==='val');if(!train.length)throw Error('Import or add structured training examples first');if(!(epochs>=1&&epochs<=50)||!(lr>=1e-6&&lr<=.01))throw Error('Invalid controller training settings');const backup=this.net.pack(),languageTrained=this.net.steps>this.net.auxSteps;this.busy=true;this.cancel=false;let before,languageBefore;try{before=await this.controllerLoss(val);languageBefore=consolidate?await validateLanguage():null;}catch(e){this.busy=false;throw e;}let updates=0,lastLoss=null;const traceTrain=this.state.traces.filter(t=>!t.holdout&&!t.transfer),traceVal=this.state.traces.filter(t=>t.holdout&&!t.transfer),outcomeBackup=this.outcome.json(),predictBefore=this.outcome.evaluate(traceVal);
  try{for(let epoch=0;epoch<epochs&&!this.cancel;epoch++)for(let i=0;i<train.length&&!this.cancel;i++){const e=train[i],labels=this.labels(e);this.net.zeroGrad();let sum=0,terms=0;for(const label of labels){const r=this.net.accumulateAux(Array.from(enc.encode(e.task).slice(-512)),label);sum+=r.loss;terms+=r.terms;}this.net.applyGrad(lr,Math.max(1,terms),2,.0001);this.net.auxSteps++;updates++;lastLoss=sum/Math.max(1,terms);onProgress({updates,total:epochs*train.length,loss:lastLoss});await sleep(0);}
   if(consolidate){for(let epoch=0;epoch<5&&!this.cancel;epoch++)for(let i=0;i<traceTrain.length;i++){this.outcome.train(traceTrain[i]);if((i&63)===63)await sleep(0);}}
   const after=await this.controllerLoss(val),languageAfter=consolidate&&languageBefore?await validateLanguage():null,predictAfter=this.outcome.evaluate(traceVal),rejected=consolidate&&(this.cancel||before===null||after===null||languageTrained&&!languageBefore||languageBefore&&(!languageAfter||languageAfter.loss>languageBefore.loss+Math.max(.01,languageBefore.loss*.01))||after>before+Math.max(.005,before*.01)||predictBefore&&predictAfter&&predictAfter.mse>predictBefore.mse+.001);
   if(rejected){this.net.load(backup);this.outcome=new OutcomeNet(outcomeBackup);}else{this.state.metrics.controllerUpdates+=updates;this.refreshCapsules();}
   const result={time:Date.now(),kind:consolidate?'consolidation':'supervised',updates,kept:!rejected,cancelled:this.cancel,before,after,languageBefore,languageAfter,predictBefore,predictAfter,lastLoss,note:rejected?'Rolled back: missing validation, cancellation, or regression.':val.length?'Measured on excluded validation tasks.':'No held-out validation; improvement unverified.'};this.state.consolidations.push(result);this.state.consolidations=this.state.consolidations.slice(-64);return result;
  }catch(e){this.net.load(backup);this.outcome=new OutcomeNet(outcomeBackup);throw e;}finally{this.busy=false;}
 }
 refreshCapsules(){const groups=new Map();for(const e of this.state.examples.filter(e=>e.split==='train')){const f=this.feature(e.task),g=groups.get(e.family)||{family:e.family,sum:new Float32Array(this.net.D),count:0};for(let i=0;i<f.length;i++)g.sum[i]+=f[i];g.count++;groups.set(e.family,g);}this.state.capsules=[...groups.values()].slice(0,64).map(g=>({family:g.family,value:Array.from(g.sum,x=>x/g.count),count:g.count,step:this.net.steps}));}
 bondScore(prev,op,feature){if(prev===64||op===64)return 0;const record=this.state.bonds[prev+':'+op],evidence=record?Math.log((record.success+1)/(record.success+record.failure+2)):-Math.log(2);return .2*this.net.w.CT[prev*65+op]+.15*evidence;}
 updateEvidence(program,result,{task='',transfer=false}={}){
  for(const r of result.results){let prev=null;for(const t of r.trace||[]){const stats=this.state.cellStats[t.op]||{uses:0,success:0,failure:0,verifiedTaskUses:0,failedTaskUses:0};stats.uses++;if(t.error)stats.failure++;else stats.success++;if(r.ok)stats.verifiedTaskUses=(stats.verifiedTaskUses||0)+1;else stats.failedTaskUses=(stats.failedTaskUses||0)+1;this.state.cellStats[t.op]=stats;
    if(prev){const key=prev.opIndex+':'+t.opIndex,b=this.state.bonds[key]||{from:prev.opIndex,to:t.opIndex,success:0,failure:0,dependencyObservations:0,history:[]};if(r.ok)b.success++;else b.failure++;if(t.depth===0&&prev.depth===0&&program.nodes.find(n=>n.id===t.node)?.args.some(a=>a.ref===prev.node))b.dependencyObservations=(b.dependencyObservations||0)+1;b.history.push({time:Date.now(),task:task.slice(0,120),passed:r.ok,total:1});b.history=b.history.slice(-8);this.state.bonds[key]=b;}prev=t;
    if(!t.error){const id=stableHash({op:t.op,args:t.args});if(JSON.stringify(t).length<=16384&&!this.state.traces.some(x=>x.id===id))this.state.traces.push({...t,id,holdout:parseInt(id,16)%5===0,transfer,verified:r.ok,source:'actual deterministic execution',task:task.slice(0,160)});}
   }
   if(!r.ok&&JSON.stringify(r).length<=65536)this.state.counterexamples.push({time:Date.now(),task,input:r.input,expected:r.expected,actual:r.actual,error:r.error,program:cloneJSON(program),transfer});
  }
  this.state.traces=this.state.traces.slice(-this.limits.traces);this.state.counterexamples=this.state.counterexamples.slice(-this.limits.counterexamples);
 }

 remember(session,key,value,{priority=1,ttl=7*86400000}={}){boundedValue(value);if(JSON.stringify(value).length>32768)throw Error('Task field exceeds 32 KB retention budget');const now=Date.now(),id=session+':'+key,item={id,session,key,value:cloneJSON(value),priority:Math.max(0,Math.min(10,priority)),updated:now,expires:now+ttl,feature:Array.from(this.feature(key+' '+JSON.stringify(value).slice(0,256)))};this.state.spine=this.state.spine.filter(x=>x.id!==id&&x.expires>now);this.state.spine.push(item);this.state.spine.sort((a,b)=>b.priority-a.priority||b.updated-a.updated);this.state.spine=this.state.spine.slice(0,this.limits.spine);return item;}
 retrieve(session,task,limit=3){const f=this.feature(task);return this.state.spine.filter(x=>x.session===session&&x.expires>Date.now()).map(x=>({...x,score:cosine(f,x.feature)+x.priority*.04})).sort((a,b)=>b.score-a.score).slice(0,limit);}
 resetSession(kind){const old=this.state.session[kind];this.state.spine=this.state.spine.filter(x=>x.session!==old);delete this.state.continuity[old];this.state.session[kind]=kind+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);this.net.inferenceState=null;}
 setContinuity(kind,text){const session=this.state.session[kind],prior=this.state.continuity[session]?.value,m=this.net.forward(Array.from(enc.encode(text).slice(-512)),{state:prior}).memory;this.state.continuity[session]={value:Array.from(m),step:this.net.steps,windows:(this.state.continuity[session]?.windows||0)+1,time:Date.now()};}
 setGoal(task,schema,tests,extra={}){if(JSON.stringify({task,schema,tests,extra}).length>131072)throw Error('Goal exceeds 128 KB retention budget');const id=extra.id||'goal-'+Date.now()+'-'+Math.random().toString(36).slice(2,6),goal={id,session:this.state.session.work,objective:task,subgoals:[],requirements:[],constraints:{maxDepth:4,maxBranches:64},dependencies:[],schema:normalizeSchema(schema),tests:cloneJSON(tests),status:'active',verification:'Executable expected-output tests',...extra};this.state.goals=this.state.goals.filter(x=>x.id!==id);this.state.goals.push(goal);this.state.goals=this.state.goals.slice(-this.limits.goals);return goal;}
 async construct(task,schema,tests,{depth=4,branches=64,beam=4,record=true,transfer=false,onProgress=()=>{}}={}){
  const excludedTask=this.state.examples.find(e=>e.task===task&&e.split!=='train');transfer=transfer||excludedTask?.split==='transfer';schema=normalizeSchema(schema);if(!Array.isArray(tests)||!tests.length||tests.length>64)throw Error('Construction needs 1–64 explicit expected-output tests');tests=cloneJSON(tests);for(const t of tests){boundedValue(t.input);boundedValue(t.expected);}depth=Math.min(6,Math.max(1,depth));branches=Math.min(this.limits.branches,Math.max(8,branches));beam=Math.min(8,Math.max(1,beam));
  const feature=this.feature(task),holdout=tests.length>=3?tests.slice(-Math.max(1,Math.floor(tests.length/3))):[],fit=holdout.length?tests.slice(0,-holdout.length):tests;let frontier=[{nodes:[],types:{},prev:64,score:0,values:{}}],best=null,tested=0,duplicates=0,seen=new Set();const started=performance.now();
  const consider=branch=>{const output=branch.output||{ref:branch.nodes.at(-1)?.id};const program={version:1,nodes:branch.nodes,output};try{this.validate(program,schema);}catch{return null;}const key=stableJSON(program);if(seen.has(key)){duplicates++;return null;}seen.add(key);if(tested>=branches)return null;tested++;const result=this.test(program,schema,fit),stop=this.net.controller(feature,branch.prev,Math.min(7,branch.nodes.length))[64],candidate={...branch,score:branch.score+.2*Math.log(Math.max(stop,1e-20)),program,result,ratio:result.passed/result.total};candidate.values={};for(const t of result.results[0]?.trace||[])candidate.values[t.node]=t.result;
   if(!best||candidate.ratio>best.ratio||candidate.ratio===best.ratio&&(candidate.nodes.length<best.nodes.length||candidate.nodes.length===best.nodes.length&&candidate.score>best.score))best=candidate;return candidate;};
  for(const r of inputRefs(schema).concat((schema.constants||[]).map(value=>({r:{const:value},type:valueType(value)}))))if(typeFits(r.type,schema.output))consider({...frontier[0],output:r.r,score:-5});
  for(let step=0;step<depth&&tested<branches&&!this.cancel;step++){
   const proposals=[];
   for(const branch of frontier){const refs=availableRefs(schema,branch.nodes,branch.types),allowed=CELL_LIBRARY.filter(c=>c.inputs.every(t=>refs.some(r=>typeFits(r.type,t)))).map(c=>c.index);if(branch.nodes.length)allowed.push(64);const probabilities=this.net.controller(feature,branch.prev,step,allowed),ranked=allowed.filter(x=>x!==64).sort((a,b)=>probabilities[b]-probabilities[a]).slice(0,12).map(index=>({cell:CELL_LIBRARY[index],prob:probabilities[index]}));
    const skills=this.state.organisms.filter(o=>o.verified&&!o.retired&&o.schema.output!=='any'&&Object.values(o.schema.inputs).every(t=>refs.some(r=>typeFits(r.type,t)))).map(o=>({cell:this.cellInfo('skill:'+o.id),prob:Math.exp(cosine(feature,o.feature||[])-4)})).sort((a,b)=>b.prob-a.prob).slice(0,2);ranked.push(...skills);
    for(const {cell,prob} of ranked){const choices=cell.inputs.map((type,slot)=>{const p=this.net.pointers(feature,slot,8);return refs.map((r,i)=>({...r,i,prob:p[i]})).filter(r=>typeFits(r.type,type)).sort((a,b)=>b.prob-a.prob).slice(0,2);});let combos=[{args:[],log:0}];for(const list of choices){const next=[];for(const combo of combos)for(const r of list)next.push({args:combo.args.concat([r.r]),log:combo.log+Math.log(Math.max(r.prob,1e-20))});combos=next.slice(0,8);}
     for(const combo of combos){const id='n'+step,node={id,op:cell.id,args:combo.args},nodes=branch.nodes.concat([node]),types={...branch.types,[id]:cell.output==='any'&&cell.id==='identity'?refs.find(r=>refKey(r.r)===refKey(combo.args[0]))?.type||'any':cell.output},score=branch.score+Math.log(Math.max(prob,1e-20))+.15*combo.log+this.bondScore(branch.prev,cell.index,feature)-.06;
      let predictionPenalty=0;if(cell.index<64&&this.outcome.opCounts[cell.index]>=8){try{const args=combo.args.map(r=>Object.hasOwn(r,'input')?fit[0].input[r.input]:Object.hasOwn(r,'const')?r.const:branch.values[r.ref]);if(args.every(x=>x!==undefined)){const p=this.outcome.predict(cell.index,args),y=this.outcome.target(fit[0].expected);predictionPenalty=.1*p.reduce((sum,x,i)=>sum+(x-y[i])**2,0);}}catch{}}
      proposals.push({nodes,types,prev:cell.index===64?branch.prev:cell.index,score:score-predictionPenalty,values:branch.values});
     }
    }
   }
   proposals.sort((a,b)=>b.score-a.score);const next=[];let evaluatedAtDepth=0;for(const p of proposals){if(tested>=branches||this.cancel)break;const finalType=p.types[p.nodes.at(-1).id];let candidate=null;if(typeFits(finalType,schema.output))candidate=consider(p);else{const key=stableJSON(p.nodes);if(!seen.has(key)){seen.add(key);candidate={...p,ratio:-.1,values:p.values};}}if(candidate)next.push(candidate);if(++evaluatedAtDepth%8===0){onProgress({tested,branches,depth:step+1,best:best?.ratio||0});await sleep(0);}if(best?.ratio===1&&best.nodes.length===step+1)break;if(evaluatedAtDepth>=Math.max(16,Math.floor(branches/depth)))break;}
   next.sort((a,b)=>b.ratio-a.ratio||b.score-a.score);frontier=next.slice(0,beam);if(best?.ratio===1||!frontier.length)break;
  }
  if(this.cancel)throw Error('Construction stopped');if(!best)throw Error('No well-typed candidate fits the supplied schema within the search budget');const validation=holdout.length?this.test(best.program,schema,holdout):{passed:0,total:0,results:[]},all={passed:best.result.passed+validation.passed,total:best.result.total+validation.total,results:best.result.results.concat(validation.results)},compiled=this.test(best.program,schema,tests,{compiled:true}),allPassed=all.passed===all.total&&compiled.passed===compiled.total,verified=allPassed&&holdout.length>0;
  const result={task,schema,program:best.program,source:this.compile(best.program,schema),fit:{passed:best.result.passed,total:best.result.total},holdout:{passed:validation.passed,total:validation.total},passed:all.passed,total:all.total,compiled:{passed:compiled.passed,total:compiled.total},verified,branches:tested,duplicates,depth:best.nodes.length,ms:performance.now()-started,controllerUpdates:this.net.auxSteps,results:all.results,transfer};
  if(record){this.state.metrics.constructions++;if(verified)this.state.metrics.verified++;else this.state.metrics.failed++;this.updateEvidence(best.program,all,{task,transfer});if(verified&&!excludedTask&&!transfer&&JSON.stringify({program:best.program,schema,tests}).length<=131072){const id=stableHash({program:best.program,schema}),old=this.state.organisms.find(o=>o.id===id);if(old){old.uses++;old.lastUsed=Date.now();}else if(this.state.organisms.length<this.limits.organisms){this.state.organisms.push({id,version:1,name:task.slice(0,70),schema,program:best.program,tests,verified:true,verification:{fit:result.fit,holdout:result.holdout,compiled:result.compiled,scope:'supplied finite tests; no general correctness proof'},feature:Array.from(feature),uses:1,created:Date.now(),versions:[]});}
    const known=this.state.examples.some(e=>e.task===task||e.id===stableHash({task,schema,program:best.program}));if(!transfer&&!known&&this.state.examples.length<this.limits.examples)this.state.examples.push(this.normalizeExample({task,schema,program:best.program,tests,split:'train',family:'verified-experience'}));
   }this.lastResult=result;}
  return result;
 }
 simplify(program){const aliases={},nodes=[],seen=new Map(),resolve=r=>{if(!Object.hasOwn(r,'ref'))return cloneJSON(r);let x=r;while(aliases[x.ref])x=aliases[x.ref];return cloneJSON(x);};for(const node of program.nodes){const args=node.args.map(resolve),key=stableJSON({op:node.op,args});if(node.op==='identity'){aliases[node.id]=args[0];continue;}if(seen.has(key)){aliases[node.id]={ref:seen.get(key)};continue;}const next={...node,args};nodes.push(next);seen.set(key,node.id);}const output=resolve(program.output),needed=new Set();const visit=r=>{if(!r.ref||needed.has(r.ref))return;needed.add(r.ref);const node=nodes.find(n=>n.id===r.ref);node?.args.forEach(visit);};visit(output);return {version:1,nodes:nodes.filter(n=>needed.has(n.id)),output};}
 async evolve(id){const skill=this.state.organisms.find(o=>o.id===id);if(!skill)throw Error('Select a skill first');const prior=cloneJSON(skill),candidates=[this.simplify(skill.program)];for(let i=0;i<skill.program.nodes.length&&candidates.length<12;i++){const original=this.cellInfo(skill.program.nodes[i].op);if(original.skill)continue;for(const other of CELL_LIBRARY){if(other.id===original.id||stableJSON(other.inputs)!==stableJSON(original.inputs)||other.output!==original.output)continue;const p=cloneJSON(skill.program);p.nodes[i].op=other.id;candidates.push(p);if(candidates.length>=12)break;}}
  let chosen=skill.program,tested=0;for(const candidate of candidates){try{this.validate(candidate,skill.schema);const result=this.test(candidate,skill.schema,skill.tests);tested++;if(result.passed===result.total&&candidate.nodes.length<chosen.nodes.length)chosen=candidate;}catch{}await sleep(0);}const changed=stableJSON(chosen)!==stableJSON(skill.program);if(changed){skill.versions=(skill.versions||[]).concat([{version:skill.version,program:skill.program,time:Date.now()}]).slice(-4);skill.program=chosen;skill.version++;}const event={time:Date.now(),id,tested,changed,before:prior.program.nodes.length,after:chosen.nodes.length,note:'Finite regression tests; verified skills retained. Same-size alternatives are not promoted.'};this.state.evolution.push(event);this.state.evolution=this.state.evolution.slice(-64);return event;
 }
 rollbackSkill(id){const skill=this.state.organisms.find(o=>o.id===id),prior=skill?.versions?.pop();if(!prior)throw Error('No earlier skill version');const check=this.test(prior.program,skill.schema,skill.tests);if(check.passed!==check.total)throw Error('Earlier version failed current tests');skill.program=prior.program;skill.version=prior.version;return skill;}
 async abstract(){
  const groups=new Map();for(const skill of this.state.organisms.filter(o=>o.verified&&!o.retired&&!o.abstraction)){const validated=this.validate(skill.program,skill.schema);for(let start=0;start+1<skill.program.nodes.length;start++){const pair=skill.program.nodes.slice(start,start+2);if(!pair[1].args.some(a=>a.ref===pair[0].id)||pair.some(n=>n.op.startsWith('skill:')))continue;const external=[],schema={inputs:{},output:validated.types[pair[1].id],constants:[]},mapped=new Map(pair.map((n,i)=>[n.id,'n'+i]));const remap=r=>{if(r.ref&&mapped.has(r.ref))return {ref:mapped.get(r.ref)};if(Object.hasOwn(r,'const'))return cloneJSON(r);let i=external.findIndex(x=>refKey(x)===refKey(r));if(i<0){i=external.length;external.push(r);schema.inputs['x'+i]=r.input?skill.schema.inputs[r.input]:validated.types[r.ref];}return {input:'x'+i};};const program={version:1,nodes:pair.map((n,i)=>({id:'n'+i,op:n.op,args:n.args.map(remap)})),output:{ref:'n1'}};if(external.length>4)continue;const key=stableJSON({program,schema}),group=groups.get(key)||{program,schema,sources:new Set(),tests:[]};for(const t of skill.tests){const trace=[];try{this.run(skill.program,t.input,skill.schema,trace);const vals=Object.fromEntries(trace.map(x=>[x.node,x.result])),input={};external.forEach((r,i)=>input['x'+i]=r.input?t.input[r.input]:vals[r.ref]);if(Object.values(input).some(x=>x===undefined)||vals[pair[1].id]===undefined)continue;group.tests.push({input,expected:vals[pair[1].id]});}catch{}}group.sources.add(skill.id);groups.set(key,group);}}
  let created=0;for(const group of groups.values()){if(group.sources.size<2)continue;const unique=[...new Map(group.tests.map(t=>[stableJSON(t.input),t])).values()];if(unique.length<3)continue;const id=stableHash({program:group.program,schema:group.schema});if(this.state.organisms.some(o=>o.id===id)||this.state.organisms.length>=this.limits.organisms)continue;const a=this.test(group.program,group.schema,unique),b=this.test(group.program,group.schema,unique,{compiled:true});if(a.passed===a.total&&b.passed===b.total){this.state.organisms.push({id,version:1,name:'Shared '+group.program.nodes.map(n=>n.op).join(' → '),schema:group.schema,program:group.program,tests:unique,verified:true,abstraction:true,sourceSkills:[...group.sources],verification:{heldoutCases:1,scope:'Common-subgraph equivalence to source executions, including excluded inputs; semantic generalization unverified'},feature:Array.from(this.feature(group.program.nodes.map(n=>n.op).join(' '))),uses:0,created:Date.now(),versions:[]});created++;}await sleep(0);}this.state.metrics.abstractions+=created;return {created,candidateGroups:groups.size,note:'Two-node common subgraphs, maximum four external inputs. Equivalence is measured on finite source executions.'};
 }
 async arena(id,property='compiler_equivalence'){
  const skill=this.state.organisms.find(o=>o.id===id);if(!skill)throw Error('Select a verified skill first');const tests=cloneJSON(skill.tests),names=Object.keys(skill.schema.inputs),mutations=[];for(const t of tests.slice(0,4))for(const name of names){const v=t.input[name],variants=typeof v==='number'?[-1,0,1,100]:typeof v==='string'?['',' x ','ß','🙂']:Array.isArray(v)?[[],[0],[-1,0,1]]:typeof v==='boolean'?[!v]:[];for(const value of variants){const input=cloneJSON(t.input);input[name]=value;mutations.push(input);}}const cases=[...new Map(tests.map(t=>t.input).concat(mutations).map(x=>[stableJSON(x),x])).values()].slice(0,48),fn=new Function(this.compile(skill.program,skill.schema)+';return luminaProgram;')();let passed=0;const failures=[];
  for(const input of cases){let ok=false,expected,actual,error;try{actual=this.run(skill.program,input,skill.schema);if(property==='compiler_equivalence'){expected=actual;ok=sameValue(actual,fn(cloneJSON(input)));}else if(property==='commutative'){if(names.length!==2||skill.schema.inputs[names[0]]!==skill.schema.inputs[names[1]])throw Error('Commutativity needs two equally typed inputs');const swapped={...input,[names[0]]:input[names[1]],[names[1]]:input[names[0]]};expected=this.run(skill.program,swapped,skill.schema);ok=sameValue(actual,expected);}else if(property==='idempotent'){if(names.length!==1||!typeFits(skill.schema.output,skill.schema.inputs[names[0]]))throw Error('Idempotence needs one input of the output type');expected=this.run(skill.program,{[names[0]]:actual},skill.schema);ok=sameValue(actual,expected);}else throw Error('Unknown test property');}catch(e){error=e.message;if(property==='compiler_equivalence'){try{fn(cloneJSON(input));}catch(e2){ok=String(e2.message)===String(e.message);}}}if(ok)passed++;else failures.push({time:Date.now(),task:skill.name,skill:id,property,input,expected,actual,error,program:cloneJSON(skill.program)});if((passed+failures.length)%8===0)await sleep(0);}
  this.state.counterexamples.push(...failures);this.state.counterexamples=this.state.counterexamples.slice(-this.limits.counterexamples);skill.arena={time:Date.now(),passed,total:cases.length,property};return {passed,total:cases.length,failures,note:property==='compiler_equivalence'?'Interpreter/compiler agreement, including matched errors; not a semantic correctness claim.':'Checks a user-selected algebraic contract; that contract may not be appropriate for this task.'};
 }
 async evaluate({split='val',max=8,depth=3,branches=48,onProgress=()=>{}}={}){
  const examples=this.state.examples.filter(e=>e.split===split).slice(0,max);if(!examples.length)return {time:Date.now(),split,count:0,note:'Not run: no excluded tasks'};let passed=0,cases=0,casePass=0,toolTotal=0,toolCorrect=0;const results=[];for(let i=0;i<examples.length&&!this.cancel;i++){const e=examples[i];let r;try{r=await this.construct(e.task,e.schema,e.tests,{depth,branches,record:false,transfer:split==='transfer'});if(r.passed===r.total)passed++;cases+=r.total;casePass+=r.passed;results.push({id:e.id,task:e.task,family:e.family,passed:r.passed,total:r.total,program:r.program,branches:r.branches});}catch(err){results.push({id:e.id,task:e.task,family:e.family,error:err.message});cases+=e.tests.length;}if(e.tool!==null){toolTotal++;const p=this.net.toolProbs(this.feature(e.task)),top=p.indexOf(Math.max(...p));if(top===e.tool)toolCorrect++;}onProgress({done:i+1,total:examples.length});await sleep(0);}const result={time:Date.now(),split,count:results.length,passed,cases,casePass,toolTotal,toolCorrect,controllerCE:await this.controllerLoss(examples),results,step:this.net.steps,note:'Search sees fit examples. Final third of each task is excluded from branch selection. Task labels are excluded from training.'};this.state.evaluations.push(result);this.state.evaluations=this.state.evaluations.slice(-32);if(split==='transfer'){this.state.metrics.transferAttempts+=results.length;this.state.metrics.transferPass+=passed;}return result;
 }
}

 let inventoryCacheKey='',inventoryGroups=new Map(),inventoryRecords=0;
 function renderModel(){
  if(!model)return;
  if(nexus&&nexus.net!==model){nexus.net=model;model.inferenceState=null;nexus.state.continuity={};}
  const n=model.parameterCount(),key=datasets.length+'|'+totalDatasetBytes+'|'+(datasets.at(-1)?.id||'');
  if(key!==inventoryCacheKey){inventoryCacheKey=key;inventoryGroups=new Map();inventoryRecords=0;for(const chunk of datasets){const name=chunk.name||'Imported corpus',entry=inventoryGroups.get(name)||{bytes:0,records:0,chunks:0};entry.bytes+=chunk.bytes;entry.records+=chunk.records||0;entry.chunks++;inventoryGroups.set(name,entry);inventoryRecords+=chunk.records||0;}const inventory=$('datasetInventory');inventory.replaceChildren();if(!inventoryGroups.size)inventory.textContent='Import JSONL or text to start.';for(const [name,entry] of inventoryGroups){const row=document.createElement('div');row.className='datasetRow';const label=document.createElement('span');label.textContent=name+' · '+fmt(entry.bytes)+' · '+(entry.records?entry.records.toLocaleString()+' records · ':'')+entry.chunks+' chunks';label.title=name;const button=document.createElement('button');button.className='button danger';button.type='button';button.textContent='Remove';button.onclick=()=>removeDataset(name);row.append(label,button);inventory.append(row);}}
  $('modelStatus').textContent=model.steps?'Local neural weights':'New 1.12M-parameter brain';$('modelDetails').textContent=model.steps.toLocaleString()+' optimiser updates';$('paramCount').textContent=n.toLocaleString();$('brainChip').textContent=model.steps?'MODEL · '+model.steps.toLocaleString()+' UPDATES':'MODEL · '+n.toLocaleString()+' PARAMS';$('sideTrain').textContent=model.steps?'Updated '+model.steps+' times':'Untrained';$('modelBadge').textContent=model.steps?'TRAINED LOCALLY':'FROM SCRATCH';$('weightBytes').textContent=fmt(n*4)+' (checkpoint '+fmt(64+n*12)+')';
  $('lossValue').textContent=Number.isFinite(lossEMA)?lossEMA.toFixed(4)+' nats/byte':'—';$('datasetStatus').textContent=datasets.length?inventoryGroups.size+' source(s) · '+datasets.length+' chunks · '+fmt(totalDatasetBytes):'No dataset imported.';$('recordCount').textContent=inventoryRecords?inventoryRecords.toLocaleString()+' training records':'Record count unavailable for older imports';
  $('tileTrainLoss').textContent=Number.isFinite(lossEMA)?lossEMA.toFixed(3):'—';$('tileValLoss').textContent=Number.isFinite(validateLoss)?validateLoss.toFixed(3):'—';$('validationLoss').textContent=Number.isFinite(validateLoss)?validateLoss.toFixed(4)+' nats/byte':'—';$('bitsPerByte').textContent=Number.isFinite(validateLoss)?(validateLoss/Math.LN2).toFixed(3):'—';$('byteAccuracy').textContent=Number.isFinite(holdoutAccuracy)?(100*holdoutAccuracy).toFixed(1)+'%':'—';$('generalizationGap').textContent=Number.isFinite(lossEMA)&&Number.isFinite(validateLoss)?(validateLoss-lossEMA).toFixed(3)+' nats/byte':'—';
  let mean=0;for(const g of model.w.G)mean+=1/(1+Math.exp(-g));$('gateMean').textContent=(100*mean/model.D).toFixed(1)+'% direct byte';$('tileSteps').textContent=model.steps.toLocaleString();$('tileBest').textContent=Number.isFinite(bestValidation)?bestValidation.toFixed(3):'—';$('tileBestInfo').textContent=Number.isFinite(bestValidation)?'At update '+bestAt.toLocaleString():'No validation checkpoint yet';$('gradientInfo').textContent='Global gradient norm '+(Number.isFinite(gradNorm)?gradNorm.toFixed(3):'—')+' · clipped at 2.0 · RAM target 425 MB';
  for(const button of $('datasetInventory').querySelectorAll('button'))button.disabled=training||importing;
 }
 function trainerEvent(message){const el=$('trainerEvents');if(!el)return;if(el.textContent.startsWith('Trainer ready.'))el.textContent='';el.textContent+='['+stamp()+'] '+message+'\n';if(el.textContent.length>7000)el.textContent=el.textContent.slice(-5500);el.scrollTop=el.scrollHeight;}
 function drawTrainingChart(){const svg=$('trainingChart');if(!svg)return;while(svg.firstChild)svg.removeChild(svg.firstChild);const arr=[...trainHistory,...validationHistory].filter(p=>Number.isFinite(p.loss));if(!arr.length){const el=document.createElementNS('http://www.w3.org/2000/svg','text');el.setAttribute('x','15');el.setAttribute('y','85');el.setAttribute('fill','#91a7c2');el.textContent='Metrics appear after training begins';svg.appendChild(el);return;}const minStep=Math.min(...arr.map(o=>o.step)),maxStep=Math.max(...arr.map(o=>o.step),minStep+1),lowest=Math.max(0,Math.min(...arr.map(o=>o.loss))-.2),highest=Math.max(...arr.map(o=>o.loss),lowest+.3),x=step=>46+(step-minStep)/(maxStep-minStep)*475,y=loss=>150-(loss-lowest)/(highest-lowest)*127;const ns='http://www.w3.org/2000/svg';for(let i=0;i<4;i++){const gy=19+i*44,line=document.createElementNS(ns,'line');for(const [k,v] of Object.entries({x1:45,x2:522,y1:gy,y2:gy,stroke:'#283c55','stroke-width':1}))line.setAttribute(k,v);svg.append(line);}for(const [series,color] of [[trainHistory,'#8bb5ff'],[validationHistory,'#70d8ae']]){if(!series.length)continue;const el=document.createElementNS(ns,'polyline');el.setAttribute('points',series.filter(p=>Number.isFinite(p.loss)).map(p=>x(p.step).toFixed(1)+','+y(p.loss).toFixed(1)).join(' '));el.setAttribute('fill','none');el.setAttribute('stroke',color);el.setAttribute('stroke-width','2.5');svg.append(el);}for(const [v,yy] of [[highest,16],[lowest,155]]){const label=document.createElementNS(ns,'text');label.setAttribute('x','4');label.setAttribute('y',yy);label.setAttribute('fill','#8096b1');label.setAttribute('font-size','12');label.textContent=v.toFixed(2);svg.append(label);}}
let dsCounter=0;
let cancelImport=false;
async function cleanupStagedImport(){const journal=await get('meta','nexus_import_stage');if(!journal)return;const ids=journal.ids||[];for(let offset=0;offset<ids.length;offset+=128){const batch=ids.slice(offset,offset+128);if(db)await new Promise((resolve,reject)=>{const t=db.transaction('dataset','readwrite');for(const id of batch)t.objectStore('dataset').delete(id);t.oncomplete=resolve;t.onerror=t.onabort=()=>reject(t.error||Error('Staged cleanup failed'));});else for(const id of batch)volatileStores.dataset.delete(id);await sleep(0);}await remove('meta','nexus_import_stage');$('discardImport').classList.add('hidden');trainerEvent('Discarded '+ids.length+' unpublished staged chunks.');}
async function importDataset(files){
 if(!files.length||importing||training||generating||working||auditing||evaluating||nexus?.busy)return;importing=true;cancelImport=false;$('datasetInput').disabled=true;$('cancelImport').disabled=false;$('importProgress').style.width='0%';renderModel();
 try{await cleanupStagedImport();for(const file of files){if(cancelImport)throw Error('Cancelled by user');if(!file.size)continue;if(totalDatasetBytes+file.size>(db?LIMIT_STORAGE:64_000_000))throw Error(db?'8 GB corpus policy reached':'Persistent storage unavailable; volatile corpus budget is 64 MB');
  const stage={key:'nexus_import_stage',token:'ds-'+Date.now().toString(36)+'-'+(++dsCounter),name:file.name,ids:[],started:Date.now()},staged=[];let units=[],chars=0,pending=[],bytesStored=0,accepted=0,rejected=0,lineNumber=0,diagnostics=[],committed=false,part=0;await put('meta',stage);
  const skip=(reason)=>{rejected++;if(diagnostics.length<12)diagnostics.push('Record '+lineNumber+': '+reason);};
  const storeBatch=async()=>{if(!pending.length)return;const nextIds=stage.ids.concat(pending.map(x=>x.id));if(db)await new Promise((resolve,reject)=>{const t=db.transaction(['dataset','meta'],'readwrite');for(const e of pending)t.objectStore('dataset').put(e);t.objectStore('meta').put({...stage,ids:nextIds});t.oncomplete=resolve;t.onerror=t.onabort=()=>reject(t.error||Error('Import storage transaction failed'));});else{for(const e of pending)await put('dataset',e);await put('meta',{...stage,ids:nextIds});}stage.ids=nextIds;for(const e of pending){staged.push({id:e.id,name:e.name,bytes:e.bytes,records:e.records,format:e.format});bytesStored+=e.bytes;}pending=[];};
  const flush=async()=>{if(!units.length)return;const bytes=enc.encode(units.join(''));if(totalDatasetBytes+bytesStored+pending.reduce((n,x)=>n+x.bytes,0)+bytes.length>LIMIT_STORAGE)throw Error('8 GB corpus policy reached');pending.push({id:stage.token+'-'+part++,name:file.name,data:bytes,bytes:bytes.length,records:units.length,format:'rs1'});units=[];chars=0;if(pending.length>=4)await storeBatch();};
  const append=async(text)=>{if(cancelImport)throw Error('Cancelled by user');const s=String(text||'').replaceAll('\0','').trim();if(!s){skip('No text content');return;}if(s.length>8_000_000){skip('Record exceeds the 8 MB working-buffer budget; split this record');return;}units.push(s+'\0');chars+=s.length+1;accepted++;if(chars>=750000)await flush();};
  const acceptJSON=async(raw)=>{if(!raw.trim())return;lineNumber++;let value;try{value=JSON.parse(raw);}catch(e){skip(e.message);return;}const values=Array.isArray(value)?value:Array.isArray(value?.records)?value.records:Array.isArray(value?.data)?value.data:[value];for(const item of values){let text;try{text=extractTrainingText(item);}catch(e){skip(e.message);continue;}await append(text);}};
  try{const kind=file.name.toLowerCase(),jsonl=kind.endsWith('.jsonl')||kind.endsWith('.ndjson'),json=kind.endsWith('.json'),decoder=new TextDecoder();let carry='',offset=0,dropLine=false,arrayMode=null,depth=0,inString=false,escaped=false,record='',arrayClosed=false;
   while(offset<file.size){if(cancelImport)throw Error('Cancelled by user');const bytes=new Uint8Array(await file.slice(offset,offset+256*1024).arrayBuffer());offset+=bytes.length;let text=decoder.decode(bytes,{stream:true});if(offset===file.size)text+=decoder.decode();
    if(json){
     for(const ch of text){if(arrayMode===null){if(/\s/.test(ch)||ch==='\ufeff')continue;arrayMode=ch==='[';if(arrayMode)continue;}
      if(!arrayMode){record+=ch;if(record.length>16_000_000)throw Error('Large JSON wrappers exceed the working-buffer budget. Use a top-level JSON array or JSONL.');continue;}
      if(arrayClosed){if(!/\s/.test(ch))throw Error('Content after JSON array');continue;}
      if(!inString&&depth===0&&(ch===','||ch===']')){if(record.trim())await acceptJSON(record);record='';if(ch===']')arrayClosed=true;continue;}
      record+=ch;if(record.length>8_000_000)throw Error('JSON record exceeds 8 MB; split the record');if(inString){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')inString=false;}else if(ch==='"')inString=true;else if(ch==='{'||ch==='[')depth++;else if(ch==='}'||ch===']')depth--;
     }
    }else{
     carry+=text;let start=0,pos;while((pos=carry.indexOf('\n',start))>=0){const line=carry.slice(start,pos).replace(/\r$/,'');start=pos+1;if(dropLine){dropLine=false;continue;}if(!line.trim())continue;if(jsonl)await acceptJSON(line);else{lineNumber++;await append(line);}}
     carry=carry.slice(start);if(carry.length>8_000_000){if(jsonl){lineNumber++;skip('Record exceeds 8 MB; skipped');carry='';dropLine=true;}else{lineNumber++;await append(carry);carry='';}}
    }
    $('importProgress').style.width=(100*offset/file.size).toFixed(1)+'%';$('datasetStatus').textContent='Reading '+file.name+' · '+fmt(offset)+' / '+fmt(file.size)+' · '+accepted+' parsed · '+staged.reduce((n,x)=>n+x.records,0)+' staged · '+rejected+' skipped';await sleep(0);
   }
   if(json){if(arrayMode===true&&!arrayClosed)throw Error('Incomplete JSON array');if(arrayMode===false&&record.trim())await acceptJSON(record);}else if(carry.trim()&&!dropLine){if(jsonl)await acceptJSON(carry);else{lineNumber++;await append(carry);}}
   await flush();await storeBatch();if(cancelImport)throw Error('Cancelled by user');if(!accepted)throw Error('No usable training records');const next=datasets.concat(staged),info={key:'dataset_info',list:next,total:totalDatasetBytes+bytesStored};
   if(db)await new Promise((resolve,reject)=>{const t=db.transaction('meta','readwrite'),s=t.objectStore('meta');s.put(info);s.delete('nexus_import_stage');s.delete('best_brain');s.delete('best_summary');s.delete('training_metrics');t.oncomplete=resolve;t.onerror=t.onabort=()=>reject(t.error||Error('Import publish failed'));});else{await put('meta',info);await remove('meta','nexus_import_stage');await remove('meta','best_brain');await remove('meta','best_summary');await remove('meta','best_summary');}
   committed=true;datasets=next;totalDatasetBytes=info.total;sampledCache.clear();weightedDatasetSize=-1;valPool=[];validateLoss=NaN;holdoutAccuracy=NaN;bestValidation=Infinity;bestAt=0;validationHistory=[];
   trainerEvent('Committed '+file.name+': '+accepted+' records, '+rejected+' skipped, '+staged.length+' chunks · '+fmt(bytesStored)+(diagnostics.length?'\n'+diagnostics.join('\n'):''));
  }catch(e){if(!committed)await cleanupStagedImport().catch(err=>trainerEvent('Staged chunks remain unpublished; use Discard interrupted import: '+err.message));throw e;}
 }}catch(e){$('trainingInfo').textContent='Import stopped: '+e.message;trainerEvent($('trainingInfo').textContent);log($('trainingInfo').textContent,'fail');}
 finally{importing=false;cancelImport=false;$('datasetInput').disabled=false;$('cancelImport').disabled=true;$('importProgress').style.width='0%';renderModel();refreshStats();}
}
function asText(v){if(typeof v==='string')return v;if(Array.isArray(v))return v.map(x=>typeof x==='string'?x:asText(x?.text??x?.content??'')).filter(Boolean).join('\n');if(v&&typeof v==='object'&&typeof v.text==='string')return v.text;return '';}
function extractTrainingText(obj){
 if(typeof obj==='string')return obj;if(!obj||typeof obj!=='object')return '';const messages=obj.messages||obj.conversations||obj.conversation;
 if(Array.isArray(messages)){const out=[];for(const m of messages){if(!m||typeof m!=='object')continue;const role=String(m.role||m.from||m.speaker||'user').toLowerCase(),label=['assistant','gpt','bot','model'].includes(role)?'Assistant':['human','user'].includes(role)?'User':role==='system'?'System':role;const content=asText(m.content??m.value??m.text??m.message);if(content.trim())out.push(label+': '+content);}return out.join('\n');}
 const direct=asText(obj.text??obj.content??obj.code);if(direct)return direct;const prompt=asText(obj.prompt??obj.instruction??obj.question),answer=asText(obj.completion??obj.response??obj.answer??obj.output);if(prompt)return 'User: '+prompt+(obj.input?'\n'+asText(obj.input):'')+'\nAssistant: '+answer;if(answer)return answer;return '';
}

 async function removeDataset(name){
  if(training||importing||generating||working||auditing||evaluating||!confirm('Remove all imported chunks named '+name+'? This does not delete the source file on your device.'))return;
  importing=true;
  try{
   const gone=datasets.filter(x=>x.name===name),next=datasets.filter(x=>x.name!==name),total=Math.max(0,totalDatasetBytes-gone.reduce((sum,x)=>sum+x.bytes,0));
   if(db){await new Promise((resolve,reject)=>{const tr=db.transaction(['dataset','meta'],'readwrite');for(const entry of gone)tr.objectStore('dataset').delete(entry.id);tr.objectStore('meta').put({key:'dataset_info',list:next,total});tr.objectStore('meta').delete('best_brain');tr.oncomplete=resolve;tr.onerror=()=>reject(tr.error||Error('Could not remove dataset'));tr.onabort=()=>reject(tr.error||Error('Dataset removal aborted'));});}
   else{for(const entry of gone)await remove('dataset',entry.id);await put('meta',{key:'dataset_info',list:next,total});await remove('meta','best_brain');await remove('meta','best_summary');}
   datasets=next;totalDatasetBytes=total;sampledCache.clear();valPool=[];validateLoss=NaN;holdoutAccuracy=NaN;bestValidation=Infinity;bestAt=0;validationHistory=[];
   trainerEvent('Removed '+name+' · '+gone.length+' chunks');renderModel();refreshStats();
  }catch(e){trainerEvent('Removal issue: '+e.message);alertUser(e.message)}finally{importing=false;renderModel();}
 }
 let sampledCache=new Map(),weightedDatasetSize=-1,weightedEntries=[],weightedLength=-1;
 function findSegment(ends,offset){let lo=0,hi=ends.length-1;while(lo<hi){const m=(lo+hi)>>1;if(ends[m]<=offset)lo=m+1;else hi=m;}return lo;}
 function recordHash(bytes,start,end){let h=2166136261;for(let j=start;j<end;j++){h^=bytes[j];h=Math.imul(h,16777619);}h^=h>>>16;h=Math.imul(h,0x85ebca6b);h^=h>>>13;h=Math.imul(h,0xc2b2ae35);h^=h>>>16;return h>>>0;}
 async function readTrainingChunk(entry){if(sampledCache.has(entry.id)){const old=sampledCache.get(entry.id);sampledCache.delete(entry.id);sampledCache.set(entry.id,old);return old;}const raw=await get('dataset',entry.id);if(!raw)throw Error('Dataset chunk missing: '+entry.id);const bytes=new Uint8Array(raw.data);const sep=(entry.format==='rs1'||raw.format==='rs1')?0:10;const begins=[],ends=[],types=[];let begin=0;for(let i=0;i<bytes.length;i++){if(bytes[i]===sep){if(i-begin>=3){begins.push(begin);ends.push(i);types.push(recordHash(bytes,begin,i)%10===0?1:0);}begin=i+1;}}if(bytes.length-begin>=3){begins.push(begin);ends.push(bytes.length);types.push(recordHash(bytes,begin,bytes.length)%10===0?1:0);}const chunk={bytes,replyRanges:begins.map((a,i)=>assistantRanges(bytes,a,ends[i])),begins:Uint32Array.from(begins),ends:Uint32Array.from(ends),types:Uint8Array.from(types)};sampledCache.set(entry.id,chunk);let size=0;for(const v of sampledCache.values())size+=v.bytes.length;while(size>Math.min(8_000_000,(typeof nxConfig!=='undefined'?nxConfig.budget:128)*20000)&&sampledCache.size>1){const first=sampledCache.keys().next().value;size-=sampledCache.get(first).bytes.length;sampledCache.delete(first);}return chunk;}
 function weightedChunk(rnd=Math.random){
  if(!datasets.length)throw Error('No dataset available');
  if(weightedDatasetSize!==totalDatasetBytes||weightedLength!==datasets.length){weightedEntries=[];let end=0;for(const entry of datasets){end+=entry.bytes;weightedEntries.push({end,entry});}weightedDatasetSize=end;weightedLength=datasets.length;}
  const target=rnd()*weightedDatasetSize;let low=0,high=weightedEntries.length-1;while(low<high){const mid=(low+high)>>1;if(weightedEntries[mid].end<=target)low=mid+1;else high=mid;}return weightedEntries[low].entry;
 }

 function assistantRanges(bytes,start,end){const spans=[];let active=-1;for(let i=start;i<end;i++){if(i!==start&&bytes[i-1]!==10)continue;let label='';for(let j=i;j<Math.min(end,i+11);j++)label+=String.fromCharCode(bytes[j]);if(label.startsWith('Assistant: ')){if(active>=0&&i>active)spans.push([active,i]);active=i+11;}else if(label.startsWith('User: ')||label.startsWith('System: ')){if(active>=0&&i>active)spans.push([active,i]);active=-1;}}if(active>=0&&end>active)spans.push([active,end]);return spans;}
 async function configureObjective(){const requested=$('objectiveInput').value||'all';if(requested===trainingObjective)return;trainingObjective=requested;validationObjective=requested;valPool=[];validateLoss=NaN;holdoutAccuracy=NaN;bestValidation=Infinity;bestAt=0;validationHistory=[];lossEMA=NaN;trainHistory=[];await remove('meta','best_brain');await remove('meta','best_summary');trainerEvent('Objective changed to '+requested+'; validation baseline reset.');}
 async function drawSample(split='train',specificEntry=null,rnd=Math.random){if(!datasets.length)throw Error('No training records available');for(let attempt=0;attempt<110;attempt++){const entry=specificEntry||weightedChunk(rnd),chunk=await readTrainingChunk(entry);if(!chunk.ends.length){if(specificEntry)break;continue;}const where=Math.floor(rnd()*chunk.bytes.length),idx=findSegment(chunk.ends,where);if(chunk.types[idx]!== (split==='val'?1:0))continue;const a=chunk.begins[idx],b=chunk.ends[idx];if(b-a<3)continue;let pos;if(trainingObjective==='assistant'){const spans=chunk.replyRanges[idx],total=spans.reduce((n,[x,y])=>n+y-x,0);if(!total)continue;let pick=Math.floor(rnd()*total);for(const [x,y] of spans){if(pick<y-x){pos=x+pick;break;}pick-=y-x;}if(pos===undefined)continue;}else pos=a+1+Math.floor(rnd()*(b-a-1));return {context:Array.from(chunk.bytes.subarray(Math.max(a,pos-(split==='train'?(model.trainC||model.C):model.C)),pos)),target:chunk.bytes[pos]};}return null;}
 async function auditCorpus(){if(training||importing||generating||working||auditing||evaluating)return;auditing=true;$('auditData').disabled=true;let records=0,train=0,validation=0,paired=0,short=0;try{for(let i=0;i<datasets.length;i++){const chunk=await readTrainingChunk(datasets[i]);for(let j=0;j<chunk.ends.length;j++){records++;if(chunk.types[j])validation++;else train++;if(chunk.replyRanges[j].length)paired++;if(chunk.ends[j]-chunk.begins[j]<16)short++;}$('trainingInfo').textContent='Auditing chunk '+(i+1)+' / '+datasets.length;await sleep(0);}const result=records+' usable records · '+train+' train · '+validation+' holdout · '+paired+' with assistant replies · '+short+' shorter than 16 bytes';$('trainingInfo').textContent=result;trainerEvent('Corpus audit: '+result);if(!validation)trainerEvent('Add more independent examples: no record hashes into the holdout split.');if(!paired)trainerEvent('Instruction tuning needs prompt/completion or user/assistant records. Use All text for plain text.');}catch(e){$('trainingInfo').textContent='Audit issue: '+e.message;}finally{auditing=false;$('auditData').disabled=false;}}

 function deterministicRng(){let state=2166136261;for(const entry of datasets){const key=entry.id+':'+entry.bytes;for(let i=0;i<key.length;i++){state^=key.charCodeAt(i);state=Math.imul(state,16777619);}}return ()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};}
 async function evaluateHoldout(){if(!datasets.length)return null;if(!valPool.length){const rng=deterministicRng(),seen=new Set();for(let i=0;i<512&&valPool.length<128;i++){const sample=await drawSample('val',null,rng);if(!sample)break;const key=sample.context.join(',')+'|'+sample.target;if(!seen.has(key)){seen.add(key);valPool.push(sample);}if((i&15)===15)await sleep(0);}}if(valPool.length<8)return null;let sum=0,correct=0;for(let i=0;i<valPool.length;i++){if(cancelTraining&&training)return null;const q=valPool[i],p=model.forward(q.context).p;sum-=Math.log(Math.max(1e-12,p[q.target]));let winner=0;for(let k=1;k<256;k++)if(p[k]>p[winner])winner=k;if(winner===q.target)correct++;if((i&15)===15)await sleep(0);}return {loss:sum/valPool.length,accuracy:correct/valPool.length,count:valPool.length};}
 async function restoreBestCheckpoint(){if(training||generating||working||evaluating){alertUser('Finish the active task before restoring weights.');return;}const best=await get('meta','best_brain');if(!best){alertUser('No best-validation checkpoint is saved yet.');return;}const candidate=new ContextNet();candidate.load(best.data);model=candidate;if(nexus)nexus.net=model;trainingObjective=best.objective||'all';validationObjective=trainingObjective;$('objectiveInput').value=trainingObjective;valPool=[];bestValidation=best.evaluationVersion===3?Number(best.loss):Infinity;bestAt=best.step;lossEMA=NaN;validateLoss=NaN;holdoutAccuracy=NaN;await saveBrain();renderModel();trainerEvent('Restored best validation checkpoint at '+bestAt+' updates');}
 async function validateModel(){if(generating||working||importing||auditing||evaluating)return;if(training){trainerEvent('Validation runs during training; stop first for a manual test.');return;}if(!datasets.length){alertUser('Import a dataset first.');return;}evaluating=true;$('trainingInfo').textContent='Evaluating held-out records…';try{await configureObjective();const result=await evaluateHoldout();if(!result){$('trainingInfo').textContent='Holdout unavailable: import more independent examples.';return;}validateLoss=result.loss;holdoutAccuracy=result.accuracy;validationHistory.push({step:model.steps,loss:validateLoss});if(validationHistory.length>200)validationHistory.shift();if(validateLoss<bestValidation-0.0005){bestValidation=validateLoss;bestAt=model.steps;await saveBestCheckpoint();}renderModel();drawTrainingChart();$('trainingInfo').textContent='Validation '+validateLoss.toFixed(4)+' nats/byte · '+(100*holdoutAccuracy).toFixed(1)+'% next-byte accuracy on '+result.count+' fixed holdout samples';trainerEvent('Manual validation '+validateLoss.toFixed(4));}catch(e){$('trainingInfo').textContent='Validation error: '+e.message;trainerEvent(e.message);}finally{evaluating=false;}}

 async function startTraining(){
 if(training||importing||generating||working||auditing||evaluating)return;if(!datasets.length){alertUser('Import a training dataset first.');return;}
 const runConfig={...nxConfig};model.heads=runConfig.heads;model.passes=runConfig.passes;model.trainC=runConfig.context==='curriculum'?96:Number(runConfig.context);
 const updates=Math.max(1,Math.min(200000,Math.floor(Number($('stepsInput').value)||0))),peakLR=Number($('lrInput').value),batch=Number($('batchInput').value),every=Number($('validateInput').value),patience=Number($('patienceInput').value),schedule=$('scheduleInput').value;
 if(!(peakLR>=.00001&&peakLR<=.02)||![1,2,4,8,16,32].includes(batch)||![50,100,250,500].includes(every)||![0,5,10,20].includes(patience)){alertUser('Check training parameters.');return;}
 training=true;cancelTraining=false;trainPaused=false;for(const id of ['startTrain','validateNow','auditData','objectiveInput','datasetInput','restoreRun','stepsInput','lrInput','batchInput','validateInput','patienceInput','scheduleInput','nxContext','nxHeads','nxPasses','nxBudget'])$(id).disabled=true;$('pauseTrain').disabled=false;$('stopTrain').disabled=false;$('labState').textContent='BASELINE';
 let completed=0,stale=0,skipped=0,restored=false;const start=performance.now();let lastSave=start,lastPaint=0,baseline=null;
 try{
 await configureObjective();await put('meta',{key:'before_training',data:model.pack(),objective:trainingObjective});
 $('trainingInfo').textContent='Saving recovery checkpoint and measuring validation baseline…';baseline=await evaluateHoldout();
 if(baseline){validateLoss=baseline.loss;holdoutAccuracy=baseline.accuracy;validationHistory.push({step:model.steps,loss:validateLoss});if(validateLoss<bestValidation){bestValidation=validateLoss;bestAt=model.steps;await saveBestCheckpoint();}trainerEvent('Baseline '+baseline.loss.toFixed(4)+' on '+baseline.count+' fixed '+trainingObjective+' holdout samples.');}
 else trainerEvent('Holdout unavailable; this run cannot establish generalization quality. Add more independent records.');
 trainerEvent('Started '+updates+' updates · accumulated batch '+batch+' · '+trainingObjective+' objective · context '+runConfig.context+' · peak LR '+peakLR);
 for(let u=0;u<updates&&!cancelTraining;u++){
  while(trainPaused&&!cancelTraining){$('labState').textContent='PAUSED';await sleep(100);}if(cancelTraining)break;$('labState').textContent='TRAINING';const nextContext=runConfig.context==='curriculum'?(u/updates<1/3?96:u/updates<2/3?256:512):Number(runConfig.context);if(model.trainC!==nextContext){model.trainC=nextContext;trainerEvent('Declared curriculum advanced to '+nextContext+' bytes.');}model.zeroGrad();let n=0,localLoss=0;
  for(let b=0;b<batch;b++){if(cancelTraining)break;const sample=await drawSample('train');if(!sample){skipped++;continue;}const loss=model.accumulateGrad(sample.context,sample.target);if(!Number.isFinite(loss))throw Error('Nonfinite loss; update rejected.');localLoss+=loss;n++;if((b&1)===1){await sleep(0);while(trainPaused&&!cancelTraining){$('labState').textContent='PAUSED';await sleep(100);}}}
  if(cancelTraining)break;if(!n){if(skipped>25)throw Error('No usable samples for this objective. Audit the corpus; use All text for plain-text data.');u--;continue;}
  const warmSteps=Math.min(200,Math.max(1,Math.floor(updates*.05))),warm=Math.min(1,(u+1)/warmSteps),progress=Math.max(0,(u+1-warmSteps)/Math.max(1,updates-warmSteps));const lr=schedule==='constant'?peakLR:peakLR*warm*(.1+.9*.5*(1+Math.cos(Math.PI*progress)));
  gradNorm=model.applyGrad(lr,n,2,.0001);const averageLoss=localLoss/n;lossEMA=Number.isFinite(lossEMA)?.96*lossEMA+.04*averageLoss:averageLoss;completed++;
  if(completed===1||completed%Math.max(10,Math.min(50,Math.floor(every/2)))===0){trainHistory.push({step:model.steps,loss:lossEMA});if(trainHistory.length>200)trainHistory.shift();}
  if(completed%every===0||completed===updates){const result=await evaluateHoldout();if(result){validateLoss=result.loss;holdoutAccuracy=result.accuracy;validationHistory.push({step:model.steps,loss:validateLoss});if(validationHistory.length>200)validationHistory.shift();if(validateLoss<bestValidation-.0005){bestValidation=validateLoss;bestAt=model.steps;stale=0;await saveBestCheckpoint();trainerEvent('Best validation '+bestValidation.toFixed(4)+' at step '+model.steps);}else stale++;if(patience>0&&stale>=patience){trainerEvent('Early stopped after '+stale+' checks without improvement.');break;}}}
  const now=performance.now();if(completed%200===0||now-lastSave>90000){await saveBrain();lastSave=now;}if(completed%4===0||now-lastPaint>400){$('trainProgress').style.width=(100*completed/updates).toFixed(1)+'%';$('trainingInfo').textContent=completed+'/'+updates+' updates · '+model.trainC+'B context · effective batch '+batch+' · LR '+lr.toExponential(2)+' · loss '+lossEMA.toFixed(4)+(Number.isFinite(validateLoss)?' · val '+validateLoss.toFixed(4):'');$('tileRate').textContent=(completed/Math.max(.01,(now-start)/1000)).toFixed(2)+' updates / sec';renderModel();drawTrainingChart();lastPaint=now;await sleep(0);}
 }
 if(!cancelTraining&&$('autoRestore').checked&&Number.isFinite(bestValidation)&&bestAt!==model.steps){const best=await get('meta','best_brain');if(best?.data){const candidate=new ContextNet();candidate.load(best.data);model=candidate;if(nexus)nexus.net=model;lossEMA=NaN;restored=true;const result=await evaluateHoldout();if(result){validateLoss=result.loss;holdoutAccuracy=result.accuracy;}trainerEvent('Restored best measured weights at update '+model.steps);}}
 await saveBrain();$('trainProgress').style.width=(100*completed/updates).toFixed(1)+'%';$('trainingInfo').textContent=(cancelTraining?'Stopped':'Finished')+' · '+completed+' updates · checkpoint saved'+(restored?' · best weights restored':'')+(baseline&&Number.isFinite(validateLoss)?' · holdout '+baseline.loss.toFixed(4)+' → '+validateLoss.toFixed(4):' · holdout quality unverified');trainerEvent($('trainingInfo').textContent);
 }catch(e){$('trainingInfo').textContent='Training stopped: '+e.message;trainerEvent($('trainingInfo').textContent);try{await saveBrain()}catch{};trainerEvent('Undo last training run restores its starting weights and optimizer.');}
 finally{training=false;trainPaused=false;for(const id of ['startTrain','validateNow','auditData','objectiveInput','datasetInput','restoreRun','stepsInput','lrInput','batchInput','validateInput','patienceInput','scheduleInput','nxContext','nxHeads','nxPasses','nxBudget'])$(id).disabled=false;$('pauseTrain').disabled=true;$('pauseTrain').textContent='Pause';$('stopTrain').disabled=true;$('labState').textContent='READY · LOCAL';renderModel();drawTrainingChart();}
 }

async function saveMetadata(){await put('meta',{key:'dataset_info',list:datasets,total:totalDatasetBytes});}
 async function refreshStats(){try{const est=await navigator.storage?.estimate?.();if(est){$('quotaUsage').textContent=fmt(est.usage||0)+' / '+fmt(est.quota||0);$('sideStorage').textContent=fmt(est.usage||0);$('storageMeter').style.width=Math.min(100,100*(est.usage||0)/LIMIT_STORAGE)+'%';}else $('sideStorage').textContent=fmt(totalDatasetBytes);$('corpusBytes').textContent=fmt(totalDatasetBytes);}catch{$('sideStorage').textContent=fmt(totalDatasetBytes)}}
function cleanName(n){n=String(n||'').replaceAll('\\','/').replace(/^\/+/, '');if(!n||n.includes('..')||n.includes('\u0000')||n.length>160)throw Error('Invalid filename');return n;}
function escapeHTML(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function clearEditor(){activeFile='';$('codeEditor').value='';$('workSource').value='';$('workSource').disabled=true;$('editorTitle').textContent='No file selected';$('savedIndicator').textContent='No file';renderFiles();}
async function loadWorkspace(){for(const o of await getAll('files'))fileCache.set(o.name,o.content);if(!fileCache.size){clearEditor();return;}openFile(fileCache.has('index.html')?'index.html':fileCache.keys().next().value);}
async function writeFile(name,content){name=cleanName(name);assertFileScope(name);if(typeof content!=='string')throw Error('File content must be text');if(enc.encode(content).length>15_000_000)throw Error('Single-file editor is capped at 15 MB');await put('files',{name,content});fileCache.set(name,content);if(!plan().multi&&taskScope!==null&&!taskScope)taskScope=name;projectRevision++;queueFileIndex(name,content);if(view==='work')renderFiles();if(name===activeFile){$('workSource').value=content;$('codeEditor').value=content;}return name;}

async function persistEditor(){if(!activeFile)return;const newVal=$('codeEditor').value;await writeFile(activeFile,newVal);$('savedIndicator').textContent='Saved';}
function renderFiles(){const parent=$('filesList');if($('artifactFilesCount'))$('artifactFilesCount').textContent=fileCache.size+' file'+(fileCache.size===1?'':'s');$('sidebarFileCount').textContent=fileCache.size+' file'+(fileCache.size===1?'':'s');if(planReady)renderPlan();parent.replaceChildren();for(let name of Array.from(fileCache.keys()).sort()){const item=document.createElement('div');item.className='fileItem '+(name===activeFile?'active':'');item.textContent='▤ '+name;item.title=name;item.addEventListener('click',()=>openFile(name));parent.append(item);}}
function openFile(name){if(!fileCache.has(name))return;if((working||generating)&&taskScope!==null&&name!==taskScope)return;if(name!==activeFile&&activeFile&&fileCache.has(activeFile)&&planReady&&!working&&!generating){clearTimeout(saveTimer);const old=activeFile,content=$('codeEditor').value;put('files',{name:old,content}).then(()=>queueFileIndex(old,content)).catch(e=>log('Save failed: '+e.message,'fail'));}activeFile=name;$('workSource').disabled=false;$('codeEditor').value=fileCache.get(name);$('editorTitle').textContent=name;$('savedIndicator').textContent='Saved';if($('workSource'))$('workSource').value=fileCache.get(name);renderFiles();}
function buildPreview(){const scope=selectedFiles();const entry=scope.has('index.html')?'index.html':[...scope.keys()].find(n=>/\.html?$/i.test(n));if(!entry)throw Error('No HTML file to preview');$('previewFrame').srcdoc=previewDocument(selectedFiles(),entry);log('preview_project('+entry+'): sandbox opened; this is not a test result','ok');}
function testWorkspace(){const results=[],pass=(ok,txt)=>results.push({ok,txt});const scope=selectedFiles(),html=scope.get('index.html')||[...scope].find(([n])=>/\.html?$/i.test(n))?.[1]||'';if([...scope.keys()].some(n=>/\.html?$/i.test(n)))pass(!!html,'HTML entry exists');if(html){pass(/<!doctype html>/i.test(html),'HTML5 doctype');pass(/<html\b/i.test(html)&&/<\/html\s*>/i.test(html),'HTML document structure');pass(/<title\b[^>]*>[^<]+<\/title>/i.test(html),'Nonempty page title');pass(/<meta\b[^>]*name=["']viewport["']/i.test(html),'Responsive viewport declaration');const ids=[...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map(m=>m[1]);pass(ids.length===new Set(ids).size,'No duplicate HTML IDs');const img=[...html.matchAll(/<img\b[^>]*>/gi)].map(m=>m[0]);pass(img.every(x=>/\balt\s*=/.test(x)),'Images include alt text');const inline=[...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]);for(let i=0;i<inline.length;i++){try{new Function(inline[i]);pass(true,'Inline script '+(i+1)+' syntax')}catch(e){pass(false,'Inline script '+(i+1)+': '+e.message)}}}
for(let [name,content] of selectedFiles()){if(/\.js$/i.test(name)){try{new Function(content);pass(true,name+' syntax')}catch(e){pass(false,name+': '+e.message)}}if(/\.json$/i.test(name)){try{JSON.parse(content);pass(true,name+' valid JSON')}catch(e){pass(false,name+': '+e.message)}}}const el=$('testResults');el.replaceChildren();for(const t of results){const n=document.createElement('div');n.className='testItem';const ico=document.createElement('span');ico.className=t.ok?'good':'bad';ico.textContent=t.ok?'✓':'×';n.append(ico,document.createTextNode(t.txt));el.append(n);}const ok=results.filter(x=>x.ok).length;log('run_tests: '+ok+'/'+results.length+' checks passed',ok===results.length?'ok':'fail');return {ok,total:results.length,problems:results.filter(x=>!x.ok).map(x=>x.txt)};}
// Real, dependency-free STORE-only ZIP encoder for small projects.
const CRC_TABLE=(()=>{let a=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?0xEDB88320^(c>>>1):c>>>1;a[i]=c>>>0;}return a})();
function crc32(a){let crc=0xffffffff;for(let i=0;i<a.length;i++)crc=CRC_TABLE[(crc^a[i])&255]^(crc>>>8);return (crc^0xffffffff)>>>0}
function zipFiles(map){const parts=[],central=[];let off=0;const u16=(d,o,v)=>d.setUint16(o,v,true),u32=(d,o,v)=>d.setUint32(o,v>>>0,true);for(let [name,content] of map){let n=enc.encode(name),b=enc.encode(content),crc=crc32(b),h=new Uint8Array(30+n.length),d=new DataView(h.buffer);u32(d,0,0x04034b50);u16(d,4,20);u16(d,6,0x0800);u16(d,8,0);u32(d,14,crc);u32(d,18,b.length);u32(d,22,b.length);u16(d,26,n.length);h.set(n,30);parts.push(h,b);const c=new Uint8Array(46+n.length),v=new DataView(c.buffer);u32(v,0,0x02014b50);u16(v,4,20);u16(v,6,20);u16(v,8,0x0800);u32(v,16,crc);u32(v,20,b.length);u32(v,24,b.length);u16(v,28,n.length);u32(v,42,off);c.set(n,46);central.push(c);off+=h.length+b.length;}const start=off;for(const c of central){parts.push(c);off+=c.length;}const end=new Uint8Array(22),d=new DataView(end.buffer);u32(d,0,0x06054b50);u16(d,8,central.length);u16(d,10,central.length);u32(d,12,off-start);u32(d,16,start);parts.push(end);return new Blob(parts,{type:'application/zip'})}
function downloadBlob(b,name){const url=URL.createObjectURL(b),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),20000)}
async function exportZip(){await persistEditor();downloadBlob(zipFiles(selectedFiles()),'LUMINA-C1-project.zip');log('export_zip: '+fileCache.size+' files','ok');}
async function newFile(){if(working||generating||importing||planChanging)return;if(!planReady){toast('Workspace is still opening.');return;}const input=prompt('New filename (e.g. app.js)');if(input===null)return;try{const name=cleanName(input);if(fileCache.has(name)){openFile(name);return;}await writeFile(name,'');openFile(name);log('write_file('+name+'): created','ok')}catch(e){alertUser(e.message)}}
async function deleteSelected(){if(working||generating||importing||planChanging)return;if(!activeFile||!confirm('Delete '+activeFile+'?'))return;const target=activeFile;clearTimeout(saveTimer);await remove('files',target);fileCache.delete(target);projectRevision++;if(plan().memory)queueIndex(()=>dropIndexedFile(target));if(!fileCache.size)clearEditor();else openFile(fileCache.keys().next().value);log('delete_file('+target+')','ok')}
async function importWorkspaceFiles(files){if(!files.length)return;if(!plan().multi&&files.length>1){toast('Multiple file import requires Pro. Choose one file.');return;}let done=0;for(const f of files){try{if(f.size>15_000_000)throw Error('File is larger than 15 MB');const name=cleanName(f.webkitRelativePath||f.name);await writeFile(name,await f.text());done++;}catch(e){log('import_files('+f.name+'): '+e.message,'fail')}}if(done)openFile(Array.from(fileCache.keys()).pop());log('import_files: '+done+' file(s)','ok');}

function searchFiles(term){const results=[];if(!term)return results;for(let [name,content] of selectedFiles()){const lines=content.split('\n');for(let i=0;i<lines.length;i++){if(lines[i].toLowerCase().includes(term.toLowerCase()))results.push(name+':'+(i+1)+' '+lines[i].trim().slice(0,110));if(results.length>=30)return results;}}return results;}
function safeCalculate(expr){if(!/^[\d.\s+*/()%\-^]+$/.test(expr))throw Error('Only simple arithmetic is permitted');const x=expr.replace(/\^/g,'**');const n=Function('"use strict";return ('+x+')')();if(!Number.isFinite(n))throw Error('Non-finite result');return n}
async function doTool(tool,params={}){
 assertToolScope(tool,params);if(tool==='run_javascript')return executeJavaScript(params.code);if(tool.startsWith('custom:')){const custom=customTools.find(t=>'custom:'+t.id===tool);if(!custom)throw Error('Custom tool no longer exists');return executeJavaScript(custom.code,JSON.parse(params.input));}
 if(cancelWork)throw Error('Task cancelled');validateToolRequest(tool,params);log('→ '+tool);
 switch(tool){
 case 'list_files':return selectedFiles().size?[...selectedFiles().keys()].join('\n'):'Workspace is empty.';
 case 'read_file':{const name=cleanName(params.name||activeFile);if(!selectedFiles().has(name))throw Error(name+' does not exist');return fileCache.get(name);}
 case 'write_file':await writeFile(params.name,params.content);openFile(params.name);return 'Saved '+params.name+' ('+enc.encode(params.content).length+' bytes). No tests run.';
 case 'search_workspace':{const found=searchFiles(params.term);return found.length?found.join('\n'):'No matches.';}
 case 'runtime_smoke_test':{const result=await sandboxSmokeTest();if(!result.ok)throw Error(result.message);return result.message+'; interactions and requirements were not tested.';}
 case 'validate_html':{const result=testWorkspace();if(result.problems.length)throw Error(result.problems.join('; '));return result.ok+'/'+result.total+' static checks passed. Behavior was not tested.';}
 case 'validate_js':case 'validate_json':{const names=[...selectedFiles().keys()].filter(n=>(tool==='validate_js'?/\.js$/i:/\.json$/i).test(n));if(!names.length)throw Error('No matching files to check');for(const name of names){try{if(tool==='validate_js')new Function(fileCache.get(name));else JSON.parse(fileCache.get(name));}catch(e){throw Error(name+': '+e.message)}}return names.length+' file(s) parsed. '+(tool==='validate_js'?'Classic JavaScript syntax only; behavior was not tested.':'JSON syntax only.');}
 case 'preview_project':buildPreview();return 'Sandbox preview opened. No correctness check performed.';
 case 'export_zip':if(!fileCache.size)throw Error('Workspace is empty');await exportZip();return 'Download requested for '+fileCache.size+' workspace files. Browser controls whether it is saved.';
 case 'import_files':$('workspaceFileInput').click();return 'File picker requested. No files imported yet; results appear after selection.';
 case 'calculate':return String(safeCalculate(params.expr));
 case 'fetch_url':{const url=new URL(params.url);if(!/^https?:$/.test(url.protocol))throw Error('HTTP(S) only');const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),8000);try{const response=await fetch(url,{signal:ctl.signal,mode:'cors',credentials:'omit'});if(!response.ok)throw Error('HTTP '+response.status);const body=await response.text();return 'HTTP '+response.status+'\n'+body.slice(0,8000)+(body.length>8000?'\n[Response truncated to 8,000 characters]':'');}finally{clearTimeout(timer)}}
 default:throw Error('Unknown tool '+tool);
 }
}
function validateToolRequest(name,args){if(!TOOL_INFO.some(t=>t[0]===name))throw Error('Unavailable tool: '+name);if(!args||typeof args!=='object'||Array.isArray(args))throw Error('Tool arguments must be an object');const allowed=(TOOL_FIELDS[name]||[]).map(f=>f[0]);for(const key of Object.keys(args))if(!allowed.includes(key))throw Error('Unexpected argument: '+key);for(const key of allowed){if(name==='read_file'&&key==='name'&&args[key]===undefined)continue;if(typeof args[key]!=='string'||(key!=='content'&&!args[key].trim()&&name!=='read_file'))throw Error('Expected text argument: '+key);}if(args.name)cleanName(args.name);if(name==='write_file'&&!args.name.trim())throw Error('Filename is required');}
// Requests are either neural output or an explicit tool selection. There is no keyword planner.

function appendWorkMessage(role,text){const feed=$('agentFeed');const row=document.createElement('div');row.className='agent-message '+(role==='user'?'user':'system');if(role!=='user'){const avatar=document.createElement('div');avatar.className='agent-avatar';avatar.textContent='✦';row.append(avatar);}const body=document.createElement('div');body.className='agent-text';const lab=document.createElement('strong');lab.textContent=role==='user'?'YOU':role==='runtime'?'RUNTIME':'LUMINA MODEL';body.append(lab,document.createTextNode(text));row.append(body);feed.append(row);feed.scrollTop=feed.scrollHeight;return body;}
function workStep(txt,ok=true){const n=document.createElement('div');n.className='work-step '+(ok?'':'error');const icon=document.createElement('span');icon.className='step-status';icon.textContent=ok?'✓':'×';n.append(icon,document.createTextNode(txt));$('agentFeed').append(n);$('agentFeed').scrollTop=$('agentFeed').scrollHeight;}
function selectArtifact(type){for(const b of document.querySelectorAll('[data-artifact]'))b.classList.toggle('active',b.dataset.artifact===type);for(let kind of ['preview','source','activity'])$('artifact'+kind[0].toUpperCase()+kind.slice(1)).classList.toggle('hidden',kind!==type);}
const TOOL_FIELDS={
 read_file:[['name','File name (blank uses selected file)',false,'index.html']],
 write_file:[['name','File name',false,'app.js'],['content','File contents',true,'Paste the text to save…']],
 search_workspace:[['term','Search text',false,'function']],
 calculate:[['expr','Expression',false,'(12 + 4) * 3']],
 fetch_url:[['url','Public CORS URL',false,'https://example.com/data.json']]
};
function toggleCodeTools(open){if(open!==false&&planReady&&!plan().tools){toast('Tools require Plus or Pro.');setView('plans');return;}const visible=typeof open==='boolean'?open:$('codeToolDrawer').classList.contains('hidden');$('codeToolDrawer').classList.toggle('hidden',!visible);$('toggleCodeTools').setAttribute('aria-expanded',String(visible));if(visible){renderCodeTools($('toolSearch').value);$('toolSearch').focus();}}
function renderCodeTools(query=''){
 const list=$('toolChoiceList');list.replaceChildren();const q=query.trim().toLowerCase();let count=0;
 for(const [name,description] of TOOL_INFO){if(q&&!(name+' '+description).toLowerCase().includes(q))continue;count++;const button=document.createElement('button');button.type='button';button.className='toolChoice'+(selectedTool===name?' active':'');button.dataset.tool=name;const title=document.createElement('strong');title.textContent=name;const detail=document.createElement('span');detail.textContent=description;button.append(title,detail);button.onclick=()=>selectCodeTool(name);list.append(button);}
 if(!count){const empty=document.createElement('div');empty.className='small muted';empty.textContent='No matching local tools.';list.append(empty);}
}
function selectCodeTool(name){if(!TOOL_INFO.some(x=>x[0]===name))return;selectedTool=name;renderCodeTools($('toolSearch').value);const fields=$('toolFormFields');fields.replaceChildren();$('selectedToolTitle').textContent=name;
 for(const [key,label,multiline,placeholder] of TOOL_FIELDS[name]||[]){const row=document.createElement('label');row.textContent=label;const field=document.createElement(multiline?'textarea':'input');field.dataset.param=key;field.placeholder=placeholder||'';if(!multiline)field.type='text';if(key==='name'&&name==='read_file')field.placeholder=activeFile;row.append(field);fields.append(row);}
 if(!fields.childElementCount){const hint=document.createElement('div');hint.className='small muted';hint.textContent='No extra inputs. Runs on the current project.';fields.append(hint);}
 $('toolForm').classList.remove('hidden');$('toolFormFields').querySelector('input,textarea')?.focus();
}
async function runCodeTool(){if(working||generating||training||!selectedTool)return;try{requirePlan('tools');}catch(e){toast(e.message);return;}const name=selectedTool,args={};for(const field of $('toolFormFields').querySelectorAll('[data-param]'))args[field.dataset.param]=field.value;
 try{validateToolRequest(name,args)}catch(e){appendWorkMessage('runtime',e.message);return;}
 working=true;cancelWork=false;taskScope=plan().multi?null:activeFile;$('runSelectedTool').disabled=true;$('runWork').disabled=true;$('stopWork').disabled=false;$('taskState').textContent='RUNNING TOOL';toggleCodeTools(false);appendWorkMessage('user','Run '+name+(args.name?' · '+args.name:''));const host=document.createElement('div');appendWorkMessage('runtime','').append(host);
 try{await persistEditor();const result=await doTool(name,args);renderResponse(host,result);host.dataset.origin='tool';if(name==='write_file')presentArtifact(host,new Map([[args.name,fileCache.get(args.name)]]),{label:args.name,origin:'Saved by write_file · untested',preview:false});if(name==='preview_project')presentArtifact(host,new Map(fileCache),{label:'Workspace preview',origin:'Existing workspace · untested',preview:true});log('✓ '+name+': '+result.slice(0,300),'ok');$('taskState').textContent=['import_files','export_zip'].includes(name)?'BROWSER ACTION REQUESTED':'TOOL FINISHED';}
 catch(e){renderResponse(host,name+' failed: '+e.message);host.dataset.origin='runtime';log('× '+name+': '+e.message,'fail');$('taskState').textContent='TOOL ERROR';}
 finally{working=false;taskScope=null;$('runSelectedTool').disabled=false;$('runWork').disabled=false;$('stopWork').disabled=true;}
}

function newCodeTask(){if(working)return;const intro=$('agentFeed').querySelector('.agent-intro')?.cloneNode(true);$('agentFeed').replaceChildren();if(intro)$('agentFeed').append(intro);$('workLog').textContent='No tools executed yet.';$('testResults').textContent='No checks performed yet.';$('workInput').value='';$('taskState').textContent='READY';toggleCodeTools(false);$('workInput').focus();}

function responseButton(label,action){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=async()=>{try{await action(b)}catch(e){alertUser(e.message)}};return b;}
function fencedFiles(text){const files=new Map(),ext={html:'html',css:'css',javascript:'js',js:'js',typescript:'ts',ts:'ts',python:'py',py:'py',json:'json',markdown:'md',md:'md',text:'txt',txt:'txt',sql:'sql',bash:'sh',sh:'sh',jsx:'jsx',tsx:'tsx'};let match,index=0;const re=/^```([^\n]*)\n([\s\S]*?)^```\s*$/gm;while((match=re.exec(text))){const header=match[1].trim(),parts=header.split(/\s+/),lang=parts[0].toLowerCase();if(['tool','tool_call'].includes(lang))continue;const explicit=parts.find(x=>/^[\w./-]+\.[a-z0-9]{1,8}$/i.test(x));let name=explicit||({html:'index.html',css:'style.css',js:'script.js',javascript:'script.js'}[lang])||'artifact-'+(++index)+'.'+(ext[lang]||'txt');try{name=cleanName(name)}catch{continue}if(files.has(name))name='artifact-'+(++index)+'-'+name.replaceAll('/','-');files.set(name,match[2].replace(/\n$/,''));}if(!files.size&&/^\s*(?:<!doctype html|<html\b)/i.test(text))files.set('index.html',text.trim());return files;}
function renderResponse(host,text){host.replaceChildren();host.dataset.response=text;const re=/^```([^\n]*)\n([\s\S]*?)^```\s*$/gm;let at=0,match;const prose=value=>{if(!value)return;const p=document.createElement('div');p.className='response-prose';p.textContent=value;host.append(p)};while((match=re.exec(text))){prose(text.slice(at,match.index));const block=document.createElement('section');block.className='response-code';const head=document.createElement('header'),label=document.createElement('span');label.textContent=match[1]||'code';const code=match[2];head.append(label,responseButton('Copy',async b=>{await navigator.clipboard.writeText(code);b.textContent='Copied';}));const pre=document.createElement('pre');pre.textContent=code;block.append(head,pre);host.append(block);at=re.lastIndex;}prose(text.slice(at));if(text){const actions=document.createElement('div');actions.className='response-actions';actions.append(responseButton('Copy response',async b=>{await navigator.clipboard.writeText(text);b.textContent='Copied';}),responseButton('Download response',()=>downloadBlob(new Blob([text],{type:'text/markdown'}),'lumina-response.md')));host.append(actions);}}
function previewDocument(files,entry='index.html'){let html=files.get(entry);if(html===undefined)throw Error('HTML file missing');const base=entry.includes('/')?entry.slice(0,entry.lastIndexOf('/')+1):'';const local=path=>files.get(base+path.replace(/^\.\//,''))??files.get(path.replace(/^\.\//,''));html=html.replace(/<link\b[^>]*href=['"]([^'"]+)['"][^>]*>/gi,(tag,path)=>{const css=local(path);return css!==undefined&&/\.css$/i.test(path)?'<style>'+css.replace(/<\/style/gi,'<\\/style')+'</style>':tag});html=html.replace(/<script\b([^>]*?)src=['"]([^'"]+)['"]([^>]*)>\s*<\/script>/gi,(tag,before,path,after)=>{const code=local(path);return code!==undefined?'<script'+before+after+'>'+code.replace(/<\/script/gi,'<\\/script')+'<\/script>':tag});return html;}
function presentArtifact(host,files,{label='Created files',origin='Workspace source',preview=false}={}){if(!files.size)return;const snapshot=new Map(files),card=document.createElement('section');card.className='deliverable';const head=document.createElement('div');head.className='deliverable-head';const title=document.createElement('strong');title.textContent=label;const meta=document.createElement('small');meta.textContent=origin+' · '+snapshot.size+' file'+(snapshot.size===1?'':'s')+' · '+fmt([...snapshot.values()].reduce((n,x)=>n+enc.encode(x).length,0));head.append(title,meta);const actions=document.createElement('div');actions.className='deliverable-actions';const area=document.createElement('div');const names=[...snapshot.keys()],entry=names.find(n=>n==='index.html')||names.find(n=>/\.html?$/i.test(n));const showSource=()=>{area.replaceChildren();const select=document.createElement('select');select.setAttribute('aria-label','Artifact source file');for(const name of names){const option=document.createElement('option');option.value=name;option.textContent=name;select.append(option)}const pre=document.createElement('pre');pre.textContent=snapshot.get(names[0]);select.onchange=()=>pre.textContent=snapshot.get(select.value);area.append(select,pre)};const showPreview=()=>{const frame=document.createElement('iframe');frame.title=label+' preview';frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');frame.srcdoc=previewDocument(snapshot,entry);area.replaceChildren(frame)};if(entry)actions.append(responseButton('Preview',showPreview));actions.append(responseButton('Source',showSource),responseButton(snapshot.size===1?'Download file':'Download ZIP',()=>{if(snapshot.size===1)downloadBlob(new Blob([snapshot.get(names[0])],{type:'text/plain'}),names[0].split('/').pop());else downloadBlob(zipFiles(snapshot),'lumina-artifact.zip')}),responseButton('Open in workspace',async()=>{if(working||generating)throw Error('Wait for the active response to finish.');await persistEditor();await applyFileBatch(snapshot);setView('work');openFile(entry||names[0]);if(entry){$('previewFrame').srcdoc=previewDocument(snapshot,entry);selectArtifact('preview')}else selectArtifact('source')}));card.append(head,actions,area);host.append(card);if(preview&&entry)showPreview();else showSource();return card;}

function runtimeStatus(host,text){const status=document.createElement('div');status.className='output-badge';status.textContent='Runtime · '+text;host.append(status);return status;}
function executionRecord(host,name,args){const card=document.createElement('details');card.className='task-details';card.open=true;const summary=document.createElement('summary');summary.textContent=name+' · running';const input=document.createElement('pre');input.textContent=JSON.stringify(args,null,2);const output=document.createElement('pre');card.append(summary,input,output);host.append(card);return {finish:(ok,text)=>{summary.textContent=name+' · '+(ok?'executed':'error');output.textContent=text;card.dataset.status=ok?'executed':'error';}};}
function parseToolCalls(text){const calls=[],errors=[];const re=/^```(?:tool|tool_call)\s*\n([\s\S]*?)^```[ \t]*$/gm;let m;while((m=re.exec(text))){try{const value=JSON.parse(m[1]);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['name','arguments'].includes(k)))throw Error('Expected {name, arguments}');validateToolRequest(value.name,value.arguments??{});calls.push({name:value.name,args:value.arguments??{}});}catch(e){errors.push(e.message);}}return {calls,errors};}
async function generateModelTurn(prompt,host,cancelled){const effort=EFFORT[$('effort').value],precise=$('decodeInput').value==='precise',full=enc.encode(prompt),used=full.slice(-model.C),history=Array.from(used),bytes=[];let reason='Length limit';
 const info=document.createElement('details');info.className='task-details';const summary=document.createElement('summary');summary.textContent='Model input · '+used.length+' / '+full.length+' bytes'+(full.length>used.length?' · earlier text truncated':'');const pre=document.createElement('pre');pre.textContent=dec.decode(used);info.append(summary,pre);host.append(info);const output=document.createElement('div');host.append(output);
 runtimeStatus(host,'Generating from local weights at update '+model.steps+' · 512-byte context');
 for(let i=0;i<effort.max;i++){if(cancelled()){reason='Stopped';break;}const next=model.choose(history,precise?0:effort.temp,precise?256:64,bytes,.92);bytes.push(next);history.push(next);if(history.length>model.C)history.shift();if(i%16===0){output.textContent=dec.decode(new Uint8Array(bytes));await sleep(0);}if(bytes.length>6&&dec.decode(new Uint8Array(bytes.slice(-24))).includes('\nUser:')){reason='Turn boundary';break;}if(bytes.length>=96){const tail=bytes.slice(-32).join(',');if(tail===bytes.slice(-64,-32).join(',')&&tail===bytes.slice(-96,-64).join(',')){reason='Repetition stopped';break;}}}
 const text=dec.decode(new Uint8Array(bytes)).replace(/\nUser:[\s\S]*$/,'').replace(/\uFFFD+$/,'').trim();renderResponse(output,text);output.dataset.origin='model';runtimeStatus(host,reason+' · '+bytes.length+' generated bytes · model claims are unverified');return {text,reason,bytes:bytes.length};
}
async function deliverTask(req,host,cancelled,context=''){return runTierTask(req,host,cancelled,context);}
async function presentUserCode(){if(working||generating)return;const source=$('workInput').value,files=fencedFiles(source);if(!files.size){appendWorkMessage('runtime','Paste complete fenced code or an HTML document, then choose Present source.');return;}const host=document.createElement('div');appendWorkMessage('runtime','').append(host);presentArtifact(host,files,{label:'Your supplied code',origin:'User source · no model generation or checks',preview:false});}
async function addExampleToCorpus(){if(training||importing||working||generating)return;const prompt=$('examplePrompt').value.trim(),answer=$('exampleAnswer').value.trim();if(!prompt||!answer)throw Error('Enter both a prompt and a training response.');const file=new Blob([JSON.stringify({prompt,completion:answer})],{type:'application/json'});file.name='instruction-example-'+Date.now()+'.jsonl';await importDataset([file]);$('exampleStatus').textContent='Import attempted; check the corpus inventory and import events. Adding data does not update weights until you train.';}

async function sandboxSmokeTest(){return new Promise((resolve,reject)=>{let original;const fileCache=selectedFiles();try{original=fileCache.get('index.html')||[...fileCache].find(([n])=>/\.html?$/i.test(n))?.[1];if(!original)throw Error('index.html missing')}catch(e){reject(e);return}const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts');frame.style.display='none';const nonce='a'+Math.random().toString(36).slice(2);let settled=false;const done=(result)=>{if(settled)return;settled=true;clearTimeout(timer);window.removeEventListener('message',onMessage);frame.remove();resolve(result)};const onMessage=e=>{if(e.source!==frame.contentWindow||!e.data||e.data.nonce!==nonce)return;done(e.data)};window.addEventListener('message',onMessage);const timer=setTimeout(()=>done({ok:false,message:'Sandbox test timed out'}),3000);let css=fileCache.get('style.css')||'',js=fileCache.get('script.js')||'';let html=original.replace(/<link\b[^>]*href=["'](?:style|styles)\.css["'][^>]*>/ig,()=>'<style>'+css.replace(/<\/style/gi,'<\\/style')+'</style>').replace(/<script\b[^>]*src=["'](?:script|main)\.js["'][^>]*><\/script>/ig,()=>'<script>'+js.replace(/<\/script/gi,'<\\/script')+'<\/script>');const probe='<script>window.addEventListener("error",function(e){window.__luminaError=String(e.message)});window.addEventListener("load",function(){setTimeout(function(){parent.postMessage({nonce:"'+nonce+'",ok:!!document.querySelector("body")&&!window.__luminaError,message:window.__luminaError||"DOM loaded; no uncaught error observed"},"*")},200)});<\/script>';html=html.replace(/<head\b[^>]*>/i,m=>m+probe);frame.srcdoc=html;document.body.append(frame)})}
async function executeWork(){
 const req=$('workInput').value.trim();if(!req||working||generating)return;
 if(!planReady||planChanging){toast('Workspace is still opening.');return;}
 if(training||importing||evaluating||auditing){appendWorkMessage('runtime','Finish the active training or data operation first.');return;}
 if((!model||(model.steps-(model.auxSteps||0))<1)&&$('nxCodeMode')?.value!=='structured'){appendWorkMessage('runtime','Train or import byte-generation weights first. Controller training alone does not train the byte output head. No weekly message used.');return;}
 working=true;cancelWork=false;toggleCodeTools(false);$('runWork').disabled=true;$('stopWork').disabled=false;$('taskState').textContent='WORKING';$('workInput').value='';appendWorkMessage('user',req);const host=document.createElement('div');appendWorkMessage('system','').append(host);
 try{await deliverTask(req,host,()=>cancelWork,planId==='free'?'':codeHistory.slice(-4).join('\n'));if(host.dataset.status==='error')$('workInput').value=req;if(planId!=='free'&&host.dataset.response)codeHistory.push('User: '+req+'\nAssistant: '+host.dataset.response);codeHistory=codeHistory.slice(-6);$('taskState').textContent=cancelWork?'STOPPED':({untrained:'UNTRAINED',draft:'DRAFT · UNVERIFIED',response:'RESPONSE',empty:'NO OUTPUT',tool_error:'TOOL ERROR',tool_limit:'LIMIT REACHED',tool_pending:'TOOL PENDING',partial:'PARTIAL OUTPUT',plan_limit:'PLAN LIMIT',error:'CHECK ISSUE',stopped:'STOPPED'}[host.dataset.status]||'READY');}
 catch(e){renderResponse(host,'Could not finish this task: '+e.message);$('taskState').textContent='CHECK ISSUE';}finally{working=false;taskScope=null;$('runWork').disabled=false;$('stopWork').disabled=true;renderPlan();}
}
async function fallbackWorkspace(){db=null;if(fileCache.size)openFile(fileCache.keys().next().value);else clearEditor();}
for(let b of document.querySelectorAll('[data-view]'))b.addEventListener('click',()=>setView(b.dataset.view));for(let b of document.querySelectorAll('[data-prompt]'))b.addEventListener('click',()=>{$('chatInput').value=b.dataset.prompt;$('chatInput').focus()});$('goTrain').onclick=()=>setView('train');$('sendChat').onclick=sendChat;$('chatInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat()}});$('runWork').onclick=executeWork;$('workInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();executeWork()}});for(const b of document.querySelectorAll('[data-work]'))b.addEventListener('click',()=>{$('workInput').value=b.dataset.work;executeWork()});for(const b of document.querySelectorAll('[data-artifact]'))b.onclick=()=>selectArtifact(b.dataset.artifact);$('stopWork').onclick=()=>{cancelWork=true;$('taskState').textContent='STOPPING'};$('clearLog').onclick=()=>{$('workLog').textContent='No tools executed yet.'};$('newFile').onclick=newFile;$('importFiles').onclick=()=>{$('workspaceFileInput').click()};$('workspaceFileInput').addEventListener('change',e=>{importWorkspaceFiles(Array.from(e.target.files));e.target.value=''});$('saveFile').onclick=()=>persistEditor().then(()=>log('write_file('+activeFile+'): saved','ok'));$('codeEditor').addEventListener('input',()=>{const name=activeFile,content=$('codeEditor').value;if(!name||working||generating)return;fileCache.set(name,content);$('savedIndicator').textContent='Unsaved';clearTimeout(saveTimer);saveTimer=setTimeout(()=>put('files',{name,content}).then(()=>{queueFileIndex(name,content);if(activeFile===name&&$('codeEditor').value===content)$('savedIndicator').textContent='Saved';}).catch(e=>log('Autosave failed: '+e.message,'fail')),600)});$('runPreview').onclick=()=>{persistEditor().then(buildPreview).catch(e=>alertUser(e.message))};$('runTests').onclick=()=>{persistEditor().then(testWorkspace).catch(e=>alertUser(e.message))};$('exportZip').onclick=()=>exportZip().catch(e=>alertUser(e.message));$('deleteFile').onclick=deleteSelected;$('datasetInput').addEventListener('change',e=>{importDataset(Array.from(e.target.files));e.target.value=''});$('startTrain').onclick=startTraining;$('pauseTrain').onclick=()=>{trainPaused=!trainPaused;$('pauseTrain').textContent=trainPaused?'Resume':'Pause';trainerEvent(trainPaused?'Paused by user':'Resumed')};$('stopTrain').onclick=()=>{cancelTraining=true;trainPaused=false};$('validateNow').onclick=validateModel;$('restoreBest').onclick=()=>restoreBestCheckpoint().catch(e=>alertUser(e.message));$('saveBrain').onclick=()=>saveBrain().catch(e=>alertUser(e.message));$('resetBrain').onclick=async()=>{if(training||generating||working||evaluating){alertUser('Finish the active task before resetting');return;}if(!confirm('Reset all neural weights to new random values? This cannot be undone unless weights were exported.'))return;model=new ContextNet();if(nexus){nexus.net=model;nexus.state.continuity={};nexus.state.capsules=[];}lossEMA=NaN;validateLoss=NaN;holdoutAccuracy=NaN;bestValidation=Infinity;bestAt=0;trainHistory=[];validationHistory=[];await remove('meta','best_brain');await remove('meta','best_summary');await saveBrain();renderModel();drawTrainingChart();};$('exportBrain').onclick=exportWeights;$('importBrain').onclick=()=>$('brainFileInput').click();$('brainFileInput').addEventListener('change',e=>{importWeights(e.target.files[0]);e.target.value=''});$('exportProjectFromAbout').onclick=()=>exportZip().catch(e=>alertUser(e.message));for(let [name,desc] of TOOL_INFO){const el=document.createElement('div');el.className='toolItem';const title=document.createElement('strong');title.textContent=name;const sub=document.createElement('span');sub.textContent=desc;el.append(title,sub);$('toolList').append(el)}$('stopTrain').disabled=true;$('pauseTrain').disabled=true;window.addEventListener('pagehide',()=>{clearTimeout(saveTimer)});
for(const b of document.querySelectorAll('[data-preset]'))b.addEventListener('click',()=>{
 const options={smoke:{steps:100,lr:.0005,batch:1,validate:50,patience:0},balanced:{steps:3000,lr:.0003,batch:2,validate:250,patience:10},conservative:{steps:8000,lr:.00012,batch:2,validate:500,patience:10}}[b.dataset.preset];
 if(!options||training)return;$('stepsInput').value=options.steps;$('lrInput').value=options.lr;$('batchInput').value=options.batch;$('validateInput').value=options.validate;$('patienceInput').value=options.patience;$('scheduleInput').value='cosine';trainerEvent('Applied '+b.dataset.preset+' profile; review the settings before starting.');
});
$('newFileAction').onclick=newFile;$('importFilesAction').onclick=()=>$('workspaceFileInput').click();$('exportZipAction').onclick=()=>exportZip().catch(e=>alertUser(e.message));$('saveSourceAction').onclick=()=>persistEditor().catch(e=>alertUser(e.message));$('deleteSourceAction').onclick=deleteSelected;
$('workSource').addEventListener('input',()=>{const name=activeFile,content=$('workSource').value;if(!name||working||generating)return;$('codeEditor').value=content;fileCache.set(name,content);$('savedIndicator').textContent='Unsaved';clearTimeout(saveTimer);saveTimer=setTimeout(()=>put('files',{name,content}).then(()=>{queueFileIndex(name,content);if(activeFile===name&&$('workSource').value===content)$('savedIndicator').textContent='Saved'}).catch(e=>log('Autosave failed: '+e.message,'fail')),600)});
$('workSource').addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();const field=e.target,start=field.selectionStart;field.setRangeText('  ',start,field.selectionEnd,'end');field.dispatchEvent(new Event('input'))}});
$('newCodeTask').onclick=()=>{setView('work');newCodeTask()};
$('toolCount').textContent=String(TOOL_INFO.length);$('toolSearch').placeholder='Search '+TOOL_INFO.length+' tools…';renderCodeTools();
$('toggleCodeTools').onclick=()=>toggleCodeTools();$('closeCodeTools').onclick=()=>toggleCodeTools(false);$('toolSearch').addEventListener('input',e=>renderCodeTools(e.target.value));$('runSelectedTool').onclick=runCodeTool;
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('codeToolDrawer').classList.contains('hidden'))toggleCodeTools(false);if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='p'){e.preventDefault();setView('work');toggleCodeTools(true)}});
$('auditData').onclick=auditCorpus;
$('stopChat').onclick=()=>{chatCancelled=true;cancelWork=true};
$('presentSource').onclick=presentUserCode;
$('trainExample').onclick=()=>addExampleToCorpus().catch(e=>alertUser(e.message));
$('restoreRun').onclick=async()=>{if(training||generating||working||evaluating)return;try{const snap=await get('meta','before_training');if(!snap)throw Error('No previous training run is saved.');const candidate=new ContextNet();candidate.load(snap.data);model=candidate;if(snap.nexus)nexus=new NexusEngine(model,snap.nexus);else if(nexus)nexus.net=model;trainingObjective=snap.objective||'all';validationObjective=trainingObjective;$('objectiveInput').value=trainingObjective;valPool=[];bestValidation=Infinity;bestAt=0;await remove('meta','best_brain');await remove('meta','best_summary');lossEMA=NaN;validateLoss=NaN;holdoutAccuracy=NaN;trainHistory=[];validationHistory=[];await saveBrain();renderModel();drawTrainingChart();trainerEvent('Restored weights and optimizer from before the last run.');}catch(e){alertUser(e.message)}};
// Local plan entitlements. Payment enforcement belongs on a trusted server.
const PLANS=Object.freeze({
 free:Object.freeze({name:'Free',limit:50,effort:'standard',tools:false,multi:false,memory:false,review:'raw'}),
 plus:Object.freeze({name:'Plus',limit:150,effort:'maximum',tools:true,multi:false,memory:false,review:'critic'}),
 pro:Object.freeze({name:'Pro',limit:Infinity,effort:'maximum',tools:true,multi:true,memory:true,review:'swarm'})
});
let planId='free',planReady=false,planChanging=false,currentUsage=0,taskScope=null,indexDB=null,indexJob=Promise.resolve(),indexBusy=0,indexError='',usageTail=Promise.resolve(),projectRevision=0;
let codeHistory=[],customTools=[],swarmWorkers=new Set(),consoleBusy=false,toastTimer=0;
const plan=()=>PLANS[planId];
const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('lumina-plans-v1'):null;
function toast(text){$('planToast').textContent=text;$('planToast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('planToast').classList.add('hidden'),6500);}
function requirePlan(feature){if(!planReady)throw Error('Workspace is still opening.');if(feature==='multi'&&!plan().multi)throw Error('Whole-project editing requires Pro. '+plan().name+' works on the selected file.');if(feature==='tools'&&!plan().tools)throw Error('Code tools and the JavaScript console require Plus or Pro.');if(feature==='memory'&&!plan().memory)throw Error('Project indexing requires Pro.');}
function selectedFiles(){const name=taskScope??activeFile;return plan().multi?fileCache:new Map(name&&fileCache.has(name)?[[name,fileCache.get(name)]]:[]);}
function assertFileScope(name){if(!planReady)throw Error('Workspace is still opening.');if(plan().multi)return;const scope=taskScope??activeFile;if(fileCache.size&&name!==scope)throw Error(plan().name+' can only change the selected file ('+(scope||'none')+'). Choose Pro for multiple files.');}
function assertToolScope(name,args){requirePlan('tools');if(!plan().multi&&fileCache.size&&args.name&&cleanName(args.name)!==(taskScope??activeFile))throw Error('This task is scoped to '+(taskScope??activeFile)+'.');}
function calendarWeek(now=new Date()){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Melbourne',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now),value=t=>Number(parts.find(x=>x.type===t).value);
 const day=new Date(Date.UTC(value('year'),value('month')-1,value('day'))),weekday=(day.getUTCDay()+6)%7;day.setUTCDate(day.getUTCDate()-weekday);return day.toISOString().slice(0,10);
}
function nextWeekLabel(){const d=new Date(calendarWeek()+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+7);return new Intl.DateTimeFormat('en-AU',{timeZone:'UTC',day:'numeric',month:'short'}).format(d);}
function usageMutation(key,change){
 const execute=()=>new Promise((resolve,reject)=>{
  if(!db){try{const current=volatileStores.meta.get(key)||{key,used:0};const result=change(current);volatileStores.meta.set(key,current);resolve(result);}catch(e){reject(e);}return;}
  const transaction=db.transaction('meta','readwrite'),store=transaction.objectStore('meta'),q=store.get(key);let result,error;
  q.onsuccess=()=>{try{const current=q.result||{key,used:0};result=change(current);store.put(current);}catch(e){error=e;transaction.abort();}};
  transaction.oncomplete=()=>resolve(result);transaction.onerror=transaction.onabort=()=>reject(error||transaction.error||Error('Usage could not be saved.'));
 });
 const work=usageTail.then(execute,execute);usageTail=work.catch(()=>{});return work;
}
async function reserveMessage(){
 if(!planReady)throw Error('Workspace is still opening.');
 const key='lumina_usage:'+calendarWeek(),id=typeof crypto.randomUUID==='function'?crypto.randomUUID():Date.now()+'-'+Math.random();
 const result=await usageMutation(key,current=>{current.used=Math.max(0,Number(current.used)||0);if(current.used>=plan().limit)throw Error(plan().name+' weekly limit reached ('+plan().limit+' messages). Next reset: Monday '+nextWeekLabel()+', 00:00 Melbourne.');current.used++;current.pending=current.pending||{};current.pending[id]=Date.now();for(const token of Object.keys(current.pending))if(current.pending[token]<Date.now()-86400000)delete current.pending[token];return {key,id,used:current.used};});
 currentUsage=result.used;renderPlan();channel?.postMessage({type:'usage'});return result;
}
async function finishMessage(ticket,hasOutput){if(!ticket)return;try{currentUsage=await usageMutation(ticket.key,current=>{if(current.pending?.[ticket.id]){if(!hasOutput)current.used=Math.max(0,(current.used||0)-1);delete current.pending[ticket.id];}return current.used||0;});await refreshUsage();channel?.postMessage({type:'usage'});}catch(e){toast('Usage update failed: '+e.message);}}
async function refreshUsage(){const current=await get('meta','lumina_usage:'+calendarWeek());currentUsage=Math.max(0,Number(current?.used)||0);renderPlan();}
function renderPlan(){
 const p=plan(),left=Number.isFinite(p.limit)?Math.max(0,p.limit-currentUsage):Infinity;
 $('planBadge').textContent=p.name+' · '+(left===Infinity?'Unlimited':left+' left');$('sidePlanName').textContent='LUMINA '+p.name;$('sidePlanUsage').textContent=currentUsage+' / '+(p.limit===Infinity?'unlimited':p.limit)+' this week';
 $('planUsageTitle').textContent=currentUsage+' / '+(p.limit===Infinity?'unlimited':p.limit)+' messages this week';$('planReset').textContent='Resets Monday '+nextWeekLabel()+' at 00:00 · Australia/Melbourne';$('planUsageLeft').textContent=left===Infinity?'No weekly cap':left+' remaining';$('planUsageBar').style.width=(p.limit===Infinity?0:Math.min(100,100*currentUsage/p.limit))+'%';
 for(const card of document.querySelectorAll('[data-plan-card]')){const selected=card.dataset.planCard===planId;card.classList.toggle('selected',selected);card.querySelector('.current-plan').classList.toggle('hidden',!selected);const button=card.querySelector('[data-select-plan]');button.disabled=selected||!planReady||planChanging;button.textContent=selected?'Current plan':'Use '+PLANS[button.dataset.selectPlan].name+' locally';}
 $('effort').value=p.effort;$('effort').disabled=true;$('effort').title=p.name+' sets the generation budget. Review passes do not change the model size.';
 $('scopeLabel').textContent=p.multi?'Whole project · '+fileCache.size+' files':'Single file · '+(activeFile||'none selected');$('reviewLabel').textContent=p.review==='raw'?'Raw output':p.review==='critic'?'Critic → revision':'3 workers → debate → synthesis';
 $('chatHint').textContent=p.name+' · '+(p.effort==='standard'?'Medium':'MAX')+' · 512-byte input · '+(left===Infinity?'unlimited messages':left+' messages left');
 $('toggleCodeTools').textContent=p.tools?'＋ Tools '+TOOL_INFO.length:'＋ Tools · Plus';$('terminalTab').textContent=p.tools?'Console':'Console · Plus';$('memoryGate').classList.toggle('hidden',p.memory);$('reindexProject').disabled=!p.memory||indexBusy>0||!planReady;$('memoryQuery').disabled=!p.memory;$('memorySearchForm').querySelector('button').disabled=!p.memory;
 $('workspaceFileInput').multiple=p.multi;$('customToolsGate').classList.toggle('hidden',p.tools);$('customToolFields').classList.toggle('hidden',!p.tools);
 $('toolCount')?.remove();const busy=working||generating||consoleBusy||planChanging||nxRunning;$('workSource').readOnly=busy;$('codeEditor').readOnly=busy;for(const id of ['newFileAction','importFilesAction','deleteSourceAction','saveSourceAction','saveFile'])$(id).disabled=busy||!planReady;
}
async function changePlan(next){
 if(!PLANS[next]||next===planId||planChanging)return;
 if(working||generating||training||consoleBusy||importing||evaluating||indexBusy||nxRunning){toast('Finish or stop the active operation before changing plans.');return;}
 planChanging=true;renderPlan();try{await persistEditor();await put('meta',{key:'lumina_plan',id:next});planId=next;codeHistory=[];chatMessages=[];toggleCodeTools(false);$('terminalPanel').classList.add('hidden');await refreshUsage();renderFiles();renderCustomTools();$('planChangeStatus').textContent='LUMINA '+plan().name+' selected locally. No payment taken; weekly usage is retained.';channel?.postMessage({type:'plan'});toast('LUMINA '+plan().name+' is active.');if(plan().memory)queueFullIndex();}catch(e){toast(e.message);}finally{planChanging=false;renderPlan();}
}
async function initPlans(){
 try{const saved=await get('meta','lumina_plan');if(PLANS[saved?.id])planId=saved.id;const stored=await get('meta','lumina_custom_tools');customTools=Array.isArray(stored?.items)?stored.items.filter(x=>validCustomTool(x)):[];registerCustomTools();}catch(e){toast('Local settings unavailable: '+e.message);}
 planReady=true;await refreshUsage();renderCustomTools();renderFiles();renderPlan();renderToolLibrary();if(plan().memory)openProjectIndex().then(refreshIndexStats).catch(()=>{});
}
channel&&(channel.onmessage=async e=>{if(e.data?.type==='usage')await refreshUsage();if(e.data?.type==='plan'&&!working&&!generating&&!training&&!consoleBusy){const value=await get('meta','lumina_plan');if(PLANS[value?.id]){planId=value.id;chatMessages=[];codeHistory=[];renderFiles();renderPlan();if(plan().memory)queueFullIndex();}}});
window.addEventListener('focus',()=>{if(planReady)refreshUsage().catch(()=>{});});

// Full saved-source index, stored separately from neural weights and training data.
function openProjectIndex(){if(indexDB)return Promise.resolve(indexDB);return new Promise((resolve,reject)=>{const q=indexedDB.open('lumina_project_index_v1',1);q.onupgradeneeded=()=>{const chunks=q.result.createObjectStore('chunks',{keyPath:'id'});chunks.createIndex('file','file');chunks.createIndex('tokens','tokens',{multiEntry:true});q.result.createObjectStore('docs',{keyPath:'name'});};q.onsuccess=()=>{indexDB=q.result;resolve(indexDB);};q.onerror=()=>reject(q.error);q.onblocked=()=>reject(Error('Close older LUMINA tabs to open the project index.'));});}
function indexTerms(text){return (text.replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase().match(/[a-z0-9_$]{2,64}/g)||[]);}
function sourceHash(text){let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16)+':'+text.length;}
function sourceChunks(name,text){
 const rows=text.split('\n'),chunks=[];let body='',start=1,last=1;
 const emit=()=>{if(!body)return;const terms=indexTerms(name+' '+body),tf=Object.create(null);for(const term of terms)tf[term]=(tf[term]||0)+1;chunks.push({id:name+'\u0000'+String(chunks.length).padStart(8,'0'),file:name,start,end:last,text:body,tokens:Object.keys(tf),tf,length:terms.length});body='';};
 for(let row=0;row<rows.length;row++){const source=rows[row];for(let offset=0;offset<Math.max(1,source.length);offset+=1800){const part=source.slice(offset,offset+1800);if(body&&body.length+part.length>2200)emit();if(!body)start=row+1;last=row+1;body+=part+(offset+1800>=source.length?'\n':'');}if(last-start>=44)emit();}emit();return chunks;
}
function indexRead(name){return new Promise((resolve,reject)=>{const q=indexDB.transaction('docs').objectStore('docs').get(name);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});}
async function indexOneFile(name,content,force=false){
 await openProjectIndex();const hash=sourceHash(content);if(!force&&(await indexRead(name))?.hash===hash)return;
 const chunks=sourceChunks(name,content);await new Promise((resolve,reject)=>{const t=indexDB.transaction(['chunks','docs'],'readwrite'),store=t.objectStore('chunks'),q=store.index('file').openCursor(IDBKeyRange.only(name));q.onsuccess=()=>{const cursor=q.result;if(cursor){cursor.delete();cursor.continue();}else{for(const chunk of chunks)store.put(chunk);t.objectStore('docs').put({name,hash,chunks:chunks.length,bytes:enc.encode(content).length,terms:chunks.reduce((n,c)=>n+c.length,0),updated:Date.now()});}};t.oncomplete=resolve;t.onerror=t.onabort=()=>reject(t.error||Error('Index write failed.'));});
}
async function dropIndexedFile(name){await openProjectIndex();return new Promise((resolve,reject)=>{const t=indexDB.transaction(['chunks','docs'],'readwrite'),q=t.objectStore('chunks').index('file').openCursor(IDBKeyRange.only(name));q.onsuccess=()=>{const cursor=q.result;if(cursor){cursor.delete();cursor.continue();}};t.objectStore('docs').delete(name);t.oncomplete=resolve;t.onerror=t.onabort=()=>reject(t.error);});}
function queueIndex(operation){indexBusy++;$('indexStatus').textContent='Indexing saved source…';renderPlan();const job=indexJob.then(operation).then(()=>{indexError='';},e=>{indexError=e.message;log('Index unavailable: '+e.message,'fail');}).finally(async()=>{indexBusy--;await refreshIndexStats().catch(()=>{});renderPlan();});indexJob=job;return job;}
function queueFileIndex(name,content){if(planReady&&plan().memory)queueIndex(()=>indexOneFile(name,content));}
function queueFullIndex(force=false){requirePlan('memory');return queueIndex(async()=>{await openProjectIndex();const docs=await new Promise((resolve,reject)=>{const q=indexDB.transaction('docs').objectStore('docs').getAll();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});for(const doc of docs)if(!fileCache.has(doc.name))await dropIndexedFile(doc.name);for(const [name,text] of fileCache){await indexOneFile(name,text,force);await sleep(0);}});}
async function refreshIndexStats(){if(!indexDB)return;const docs=await new Promise((resolve,reject)=>{const q=indexDB.transaction('docs').objectStore('docs').getAll();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});$('indexedFiles').textContent=docs.length;$('indexedChunks').textContent=docs.reduce((n,x)=>n+x.chunks,0);$('indexedBytes').textContent=fmt(docs.reduce((n,x)=>n+x.bytes,0));$('indexStatus').textContent=indexError?'Index issue: '+indexError:indexBusy?'Indexing saved source…':'Saved source indexed · '+docs.length+' files';}
async function retrieveProject(query,count=6){
 requirePlan('memory');await queueFullIndex();if(indexError)throw Error(indexError);const terms=[...new Set(indexTerms(query))].slice(0,24);if(!terms.length)return [];
 const stats=await new Promise((resolve,reject)=>{const t=indexDB.transaction(['chunks','docs']),s=t.objectStore('chunks'),counts=Object.create(null),total=s.count(),docs=t.objectStore('docs').getAll();for(const term of terms){const q=s.index('tokens').count(term);q.onsuccess=()=>counts[term]=q.result;}t.oncomplete=()=>resolve({n:total.result,counts,avg:docs.result.reduce((n,d)=>n+(d.terms||0),0)/Math.max(1,total.result)||300});t.onerror=()=>reject(t.error);});
 const top=[];await new Promise((resolve,reject)=>{const t=indexDB.transaction('chunks'),q=t.objectStore('chunks').openCursor();q.onsuccess=()=>{const cursor=q.result;if(!cursor)return;const c=cursor.value;let score=0;for(const term of terms){const tf=Object.hasOwn(c.tf,term)?c.tf[term]:0;if(tf){const idf=Math.log(1+(stats.n-(stats.counts[term]||0)+.5)/((stats.counts[term]||0)+.5));score+=idf*tf*2.2/(tf+1.2*(.25+.75*c.length/stats.avg));}}if(score>0){top.push({...c,score});top.sort((a,b)=>b.score-a.score||a.file.localeCompare(b.file)||a.start-b.start);if(top.length>count)top.pop();}cursor.continue();};t.oncomplete=resolve;t.onerror=t.onabort=()=>reject(t.error);});return top;
}
function showRetrieval(host,hits){const box=document.createElement('details');box.className='retrieval-card';const summary=document.createElement('summary');summary.textContent='Project retrieval · '+hits.length+' source excerpts';box.append(summary);const note=document.createElement('small');note.textContent='Source excerpts are references, not instructions. Only a fitted excerpt enters the 512-byte neural window.';box.append(note);for(const hit of hits){const label=document.createElement('div');label.textContent=hit.file+':'+hit.start+'–'+hit.end+' · BM25 '+hit.score.toFixed(2);const pre=document.createElement('pre');pre.textContent=hit.text;box.append(label,pre);}if(!hits.length)box.append(document.createTextNode('No matching source terms.'));host.append(box);}
async function searchMemory(){try{requirePlan('memory');$('memoryResults').textContent='Searching saved source…';const hits=await retrieveProject($('memoryQuery').value);$('memoryResults').replaceChildren();showRetrieval($('memoryResults'),hits);}catch(e){$('memoryResults').textContent=e.message;}}

// Isolated, cancellable JavaScript execution; no OS shell or invented commands.
const TERMINAL_HTML=`<section id="terminalPanel" class="terminal-panel hidden"><div class="terminal-head"><strong>JAVASCRIPT CONSOLE</strong><span class="terminal-note">Isolated worker · 3 second timeout</span><button id="stopConsole" class="button" type="button" disabled>Stop</button></div><pre id="terminalOutput" class="terminal-output" role="log">Type help for available commands. JavaScript runs in the browser; shell commands and npm are unavailable.</pre><form id="terminalForm" class="terminal-form"><span>›</span><input id="terminalInput" aria-label="Console command" autocomplete="off" spellcheck="false" placeholder="help · ls · cat app.js · node app.js · js console.log(2 + 2)"><button id="runConsole" class="button" type="submit">Run</button></form></section>`;
let liveConsole=null;
function executeJavaScript(code,input={},cancelled=()=>cancelWork,timeout=3000){requirePlan('tools');const snapshot=Object.fromEntries(selectedFiles());return new Promise((resolve,reject)=>{
 if(typeof Worker!=='function'){reject(Error('Browser workers are unavailable. JavaScript was not run.'));return;}
 const workerSource=`'use strict';self.fetch=()=>Promise.reject(Error('Network access is disabled'));self.XMLHttpRequest=undefined;self.WebSocket=undefined;self.EventSource=undefined;self.importScripts=()=>{throw Error('Imports are disabled')};self.Worker=undefined;self.onmessage=async e=>{const {source,input,files}=e.data,changes=Object.create(null),logs=[];const print=(...values)=>{if(logs.length<200)logs.push(values.map(x=>typeof x==='string'?x:(JSON.stringify(x)??String(x))).join(' ').slice(0,2000))};const fs={listFiles:()=>Object.keys(files),readFile:name=>{if(!Object.hasOwn(files,name))throw Error('File is outside this console scope: '+name);return files[name]},writeFile:(name,text)=>{if(typeof text!=='string')throw Error('Text files only');changes[name]=text;files[name]=text;}};try{const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;const value=await new AsyncFunction('fs','console','input','"use strict";\\n'+source)(fs,{log:print,info:print,warn:print,error:print},input);self.postMessage({ok:true,value:typeof value==='string'?value:JSON.stringify(value),logs,changes});}catch(err){self.postMessage({ok:false,error:err.message,logs});}};`;
 const url=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'})),worker=new Worker(url);URL.revokeObjectURL(url);liveConsole=worker;let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);clearInterval(poll);worker.terminate();if(liveConsole===worker)liveConsole=null;error?reject(error):resolve(value);};const timer=setTimeout(()=>finish(Error('JavaScript stopped after '+timeout+' ms. No file changes applied.')),timeout),poll=setInterval(()=>{if(cancelled())finish(Error('JavaScript cancelled. No file changes applied.'));},50);
 worker.onerror=e=>finish(Error(e.message||'Console worker failed'));
 worker.onmessage=async e=>{clearTimeout(timer);clearInterval(poll);worker.terminate();if(liveConsole===worker)liveConsole=null;$('stopConsole').disabled=true;try{if(cancelled())throw Error('JavaScript cancelled.');if(!e.data.ok)throw Error((e.data.logs||[]).join('\n')+'\n'+e.data.error);const changes=new Map(Object.entries(e.data.changes||{}));await applyFileBatch(changes);finish(null,[(e.data.logs||[]).join('\n'),e.data.value,changes.size?'Saved '+changes.size+' file change(s).':''].filter(Boolean).join('\n')||'Completed with no output.');}catch(err){finish(err);}};worker.postMessage({source:code,input,files:snapshot});
 });}
async function applyFileBatch(files){if(!files.size)return;for(const [name,text] of files){if(cleanName(name)!==name)throw Error('Filename must be canonical: '+name);assertFileScope(name);if(typeof text!=='string'||enc.encode(text).length>15_000_000)throw Error('Text file exceeds 15 MB.');}if(!plan().multi&&files.size>1)throw Error('Multi-file changes require Pro.');clearTimeout(saveTimer);await persistEditor();if(db){await new Promise((resolve,reject)=>{const t=db.transaction('files','readwrite');for(const [name,content] of files)t.objectStore('files').put({name,content});t.oncomplete=resolve;t.onerror=t.onabort=()=>reject(t.error);});}else for(const [name,content] of files)volatileStores.files.set(name,{name,content});for(const [name,text] of files){fileCache.set(name,text);queueFileIndex(name,text);}if(activeFile&&fileCache.has(activeFile))openFile(activeFile);else openFile(files.keys().next().value);renderFiles();projectRevision++;}
function terminalPrint(text){const out=$('terminalOutput');out.textContent+='\n'+text;if(out.textContent.length>40000)out.textContent=out.textContent.slice(-30000);out.scrollTop=out.scrollHeight;}
async function runConsole(command){
 if(consoleBusy||working||generating||training||importing||evaluating)return;try{requirePlan('tools');}catch(e){toast(e.message);return;}command=command.trim();if(!command)return;
 consoleBusy=true;working=true;cancelWork=false;taskScope=plan().multi?null:activeFile;$('runConsole').disabled=true;$('stopConsole').disabled=false;terminalPrint('› '+command);
 try{await persistEditor();const [verb,...rest]=command.split(' '),arg=rest.join(' ').trim();switch(verb){case 'help':terminalPrint('help · pwd · ls · cat FILE · stat FILE · echo TEXT · clear\nnode FILE: execute saved JavaScript\njs CODE: execute JavaScript\ncheck: static checks in current file scope\nJavaScript API: fs.listFiles(), fs.readFile(name), fs.writeFile(name,text), console.log().\nNo OS commands, network, modules or package manager.');break;case 'pwd':terminalPrint('/workspace');break;case 'ls':terminalPrint([...selectedFiles().keys()].join('\n')||'(empty)');break;case 'cat':if(!selectedFiles().has(arg))throw Error('File is outside the selected scope.');terminalPrint(selectedFiles().get(arg));break;case 'stat':if(!selectedFiles().has(arg))throw Error('File is outside the selected scope.');terminalPrint(arg+' · '+enc.encode(selectedFiles().get(arg)).length+' bytes');break;case 'echo':terminalPrint(arg);break;case 'clear':$('terminalOutput').textContent='';break;case 'check':terminalPrint(JSON.stringify(testWorkspace(),null,2));break;case 'node':if(!selectedFiles().has(arg))throw Error('File is outside the selected scope.');terminalPrint(await executeJavaScript(selectedFiles().get(arg)));break;case 'js':terminalPrint(await executeJavaScript(arg));break;default:throw Error('Unknown command: '+verb+'. Type help.');}}
 catch(e){terminalPrint('Error: '+e.message);}finally{consoleBusy=false;working=false;taskScope=null;$('runConsole').disabled=false;$('stopConsole').disabled=true;renderPlan();}
}
function validCustomTool(t){return t&&/^[a-z][a-z0-9_]{1,30}$/.test(t.id)&&typeof t.description==='string'&&typeof t.code==='string'&&t.code.length<=40000;}
function renderToolLibrary(){const host=$('toolList');host.replaceChildren();for(const [name,description] of TOOL_INFO){const item=document.createElement('div');item.className='toolItem';const label=document.createElement('strong'),detail=document.createElement('span');label.textContent=name;detail.textContent=description;item.append(label,detail);host.append(item);}}
function registerCustomTools(){for(let i=TOOL_INFO.length-1;i>=0;i--)if(TOOL_INFO[i][0].startsWith('custom:')){delete TOOL_FIELDS[TOOL_INFO[i][0]];TOOL_INFO.splice(i,1);}for(const tool of customTools){const name='custom:'+tool.id;TOOL_INFO.push([name,tool.description]);TOOL_FIELDS[name]=[['input','Input JSON',true,'{}']];}renderCodeTools();renderToolLibrary();}
function renderCustomTools(){const host=$('customToolList');host.replaceChildren();for(const tool of customTools){const row=document.createElement('div');row.className='custom-tool-row';const label=document.createElement('span');label.textContent=tool.id+' · '+tool.description;row.append(label,responseButton('Delete',async()=>{requirePlan('tools');if(working||generating)throw Error('Finish the active task first.');customTools=customTools.filter(x=>x.id!==tool.id);await put('meta',{key:'lumina_custom_tools',items:customTools});registerCustomTools();renderCustomTools();renderPlan();}));host.append(row);}}
async function saveCustomTool(){try{requirePlan('tools');if(working||generating||training)throw Error('Finish the active operation first.');const t={id:$('customToolName').value.trim(),description:$('customToolDescription').value.trim(),code:$('customToolCode').value};if(!validCustomTool(t)||!t.description.trim()||!t.code.trim())throw Error('Use a 2–31 character lowercase tool name, a description and JavaScript source.');new (Object.getPrototypeOf(async function(){}).constructor)('fs','console','input',t.code);const next=customTools.filter(x=>x.id!==t.id).concat(t);await put('meta',{key:'lumina_custom_tools',items:next});customTools=next;registerCustomTools();renderCustomTools();renderPlan();toast('Custom tool saved. Select custom:'+t.id+' in Code’s Tools drawer.');}catch(e){toast(e.message);}}

// All phases use the trained ContextNet. No canned answer or success score.
function byteTail(text,budget){if(budget<=0)return '';const b=enc.encode(String(text));let start=Math.max(0,b.length-budget);while(start<b.length&&(b[start]&192)===128)start++;return dec.decode(b.subarray(start));}
function byteHead(text,budget){if(budget<=0)return '';const b=enc.encode(String(text));let end=Math.min(b.length,budget);while(end>0&&end<b.length&&(b[end]&192)===128)end--;return dec.decode(b.subarray(0,end));}
function fitModelInput(request,{history='',reference='',role='',feedback=''}={}){
 const suffix='\nAssistant: ',prefix='User: ',cap=model.C,side=feedback||reference||history,sideBudget=side?Math.min(160,Math.floor(cap*.36)):0,roleText=role?byteHead(role+': ',12):'',room=cap-enc.encode(prefix+suffix+roleText).length,req=byteTail(request,Math.max(1,room-sideBudget));
 const spare=cap-enc.encode(prefix+suffix+roleText+req).length,context=reference&&!feedback?byteHead(side,Math.max(0,spare-1)):byteTail(side,Math.max(0,spare-1));return (context?context+'\n':'')+roleText+prefix+req+suffix;
}
function generationInfo(host,prompt,label){const info=document.createElement('details');info.className='task-details';const summary=document.createElement('summary');summary.textContent=label+' · actual model input '+enc.encode(prompt).length+' / '+model.C+' bytes';const pre=document.createElement('pre');pre.textContent=prompt;info.append(summary,pre);host.append(info);return info;}
function workerModelSource(){return "'use strict';"+ContextNet.toString()+`;self.onmessage=e=>{const {weights,prompt,max,temp,role,heads,passes,state}=e.data,n=new ContextNet();n.heads=heads||4;n.passes=passes||2;n.inferenceState=state||null;for(const k of n.keys)n.w[k].set(weights[k]);const enc=new TextEncoder(),dec=new TextDecoder(),history=Array.from(enc.encode(prompt).slice(-n.C)),bytes=[];let reason='Length limit';for(let i=0;i<max;i++){const next=n.choose(history,temp,64,bytes,.92);bytes.push(next);history.push(next);if(history.length>n.C)history.shift();if(bytes.length>6&&dec.decode(new Uint8Array(bytes.slice(-24))).includes('\\nUser:')){reason='Turn boundary';break;}if(bytes.length>=96){const tail=bytes.slice(-32).join(',');if(tail===bytes.slice(-64,-32).join(',')&&tail===bytes.slice(-96,-64).join(',')){reason='Repetition stopped';break;}}if(i%64===0)self.postMessage({progress:i,role});}self.postMessage({done:true,text:dec.decode(new Uint8Array(bytes)).replace(/\\nUser:[\\s\\S]*$/,'').replace(/\\uFFFD+$/,'').trim(),reason,bytes:bytes.length});};`;}
async function neuralPass(request,host,cancelled,{role='Draft',history='',reference='',feedback='',max=1536,temp=.58,worker=false}={}){
 const prompt=fitModelInput(request,{history,reference,role,feedback});generationInfo(host,prompt,role);const out=document.createElement('div');out.className='response-prose';host.append(out);let result;
 if(worker){
  if(typeof Worker!=='function')throw Error('Parallel workers unavailable.');
  result=await new Promise((resolve,reject)=>{let w,url,settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearInterval(poll);clearTimeout(timer);w?.terminate();swarmWorkers.delete(w);if(url)URL.revokeObjectURL(url);error?reject(error):resolve(value);};const poll=setInterval(()=>{if(cancelled())finish(Error('Stopped'));},40),timer=setTimeout(()=>finish(Error(role+' exceeded its 90-second budget.')),90000);
   try{url=URL.createObjectURL(new Blob([workerModelSource()],{type:'text/javascript'}));w=new Worker(url);swarmWorkers.add(w);w.onerror=e=>finish(Error(e.message||role+' worker failed'));w.onmessage=e=>{if(e.data.done)finish(null,e.data);else out.textContent=role+' · '+e.data.progress+' generated bytes';};const weights={};for(const k of model.keys)weights[k]=model.w[k].slice();w.postMessage({weights,prompt,max,heads:model.heads,passes:model.passes,state:model.inferenceState,temp:$('decodeInput').value==='precise'?0:temp,role},Object.values(weights).map(a=>a.buffer));}catch(e){finish(e);}
  });
 }else{
  const historyBytes=Array.from(enc.encode(prompt)),bytes=[];let reason='Length limit';for(let i=0;i<max;i++){if(cancelled()){reason='Stopped';break;}const next=model.choose(historyBytes,$('decodeInput').value==='precise'?0:temp,64,bytes,.92);bytes.push(next);historyBytes.push(next);if(historyBytes.length>model.C)historyBytes.shift();if(i%16===0){out.textContent=dec.decode(new Uint8Array(bytes));await sleep(0);}if(bytes.length>6&&dec.decode(new Uint8Array(bytes.slice(-24))).includes('\nUser:')){reason='Turn boundary';break;}if(bytes.length>=96){const tail=bytes.slice(-32).join(',');if(tail===bytes.slice(-64,-32).join(',')&&tail===bytes.slice(-96,-64).join(',')){reason='Repetition stopped';break;}}}result={text:dec.decode(new Uint8Array(bytes)).replace(/\nUser:[\s\S]*$/,'').replace(/\uFFFD+$/,'').trim(),reason,bytes:bytes.length};
 }
 renderResponse(out,result.text);out.dataset.origin='model';runtimeStatus(host,role+' · '+result.reason+' · '+result.bytes+' generated bytes');return result;
}
function staticReview(text){const files=fencedFiles(text),errors=[],checks=[];for(const [name,source] of files){if(/\.(?:js|json)$/i.test(name)){try{if(/\.json$/i.test(name))JSON.parse(source);else new Function(source);checks.push(name+' parses');}catch(e){errors.push(name+': '+e.message);}}if(/\.html?$/i.test(name)){const parsed=new DOMParser().parseFromString(source,'text/html'),ids=[...parsed.querySelectorAll('[id]')].map(x=>x.id);if(new Set(ids).size!==ids.length)errors.push(name+': duplicate IDs');for(const script of parsed.querySelectorAll('script:not([src])')){if(script.type&&script.type!=='text/javascript')continue;try{new Function(script.textContent);checks.push(name+' inline script parses');}catch(e){errors.push(name+': '+e.message);}}}}return {files:files.size,errors,checks};}
function qualitySection(host,label){const details=document.createElement('details');details.className='quality-card';const summary=document.createElement('summary');summary.textContent=label;const note=document.createElement('small');note.textContent='Actual model passes using the same local weights. Syntax checks do not verify behaviour or correctness.';details.append(summary,note);host.append(details);return details;}
function preferRevision(draft,revision){if(!revision?.text)return draft;const before=staticReview(draft.text),after=staticReview(revision.text);if(before.files&&!after.files)return draft;if(after.errors.length>before.errors.length)return draft;return revision;}
async function reviewedGeneration(request,host,cancelled,ctx){
 if(plan().review==='raw')return neuralPass(request,host,cancelled,{...ctx,role:'',max:EFFORT.standard.max,temp:.72});
 const quality=qualitySection(host,plan().review==='swarm'?'Parallel collaboration · 3 workers + debate':'Response critic · draft, critique, revision');
 if(plan().review==='swarm'&&typeof Worker==='function'){
  const roles=[['Author',1536,.58],['Reviewer',384,.52],['Test designer',384,.64]],sections=roles.map(([role])=>{const s=document.createElement('section');quality.append(s);return s;});
  const candidates=await Promise.allSettled(roles.map(([role,max,temp],i)=>neuralPass(request,sections[i],cancelled,{...ctx,role,max,temp,worker:true})));
  for(let i=0;i<candidates.length;i++)if(candidates[i].status==='rejected')runtimeStatus(sections[i],roles[i][0]+' failed: '+candidates[i].reason.message);
  if(cancelled())return {text:'',reason:'Stopped',bytes:0};
  const author=candidates[0].status==='fulfilled'?candidates[0].value:candidates.find(x=>x.status==='fulfilled')?.value;if(!author)throw Error('All parallel workers failed.');
  const debates=await Promise.allSettled([1,2].map(i=>{const section=document.createElement('section');quality.append(section);const other=candidates[i===1?2:1],peer=other.status==='fulfilled'?other.value.text:'';return neuralPass(request,section,cancelled,{role:i===1?'Critique':'Check tests',feedback:byteHead(author.text,128)+' | '+byteHead(peer,64),max:384,temp:.5,worker:true});}));
  if(cancelled())return {...author,reason:'Stopped'};
  const feedback=debates.filter(x=>x.status==='fulfilled').map(x=>x.value.text).join('\n');for(const item of debates)if(item.status==='rejected')runtimeStatus(quality,'Debate worker failed: '+item.reason.message);
  const checked=staticReview(author.text);runtimeStatus(quality,checked.errors.length?'Static issues: '+checked.errors.join('; '):'Static review: '+checked.checks.length+' syntax checks; semantic quality unverified.');
  const synthesis=await neuralPass(request,quality,cancelled,{...ctx,role:'Synthesize',feedback:checked.errors.join('; ')||feedback||author.text,max:1536,temp:.5});const chosen=preferRevision(author,synthesis);runtimeStatus(quality,chosen===author?'Author draft retained by structural checks.':'Synthesis selected; correctness unverified.');return chosen;
 }
 if(plan().review==='swarm')runtimeStatus(quality,'Workers unavailable. Running a sequential critic loop; no parallel team ran.');
 const draft=await neuralPass(request,quality,cancelled,{...ctx,role:'Draft',max:1536,temp:.58});if(cancelled())return draft;
 const checks=staticReview(draft.text);runtimeStatus(quality,checks.errors.length?'Static issues: '+checks.errors.join('; '):'Static review: '+checks.checks.length+' syntax checks; behaviour untested.');
 const critic=await neuralPass('Review this answer for errors.',quality,cancelled,{role:'Critic',feedback:checks.errors.join('; ')||draft.text,max:384,temp:.5});if(cancelled())return {...draft,reason:'Stopped'};
 const revision=await neuralPass(request,quality,cancelled,{...ctx,role:'Revise',feedback:checks.errors.join('; ')||critic.text||draft.text,max:1536,temp:.5});const chosen=preferRevision(draft,revision);runtimeStatus(quality,chosen===draft?'Draft retained; revision was empty or failed structural checks.':'Revision selected; correctness unverified.');return chosen;
}
async function runTierTask(request,host,cancelled,history=''){
 host.replaceChildren();host.dataset.response='';host.dataset.origin='model';host.dataset.generated='false';
 if(!model||(model.steps-(model.auxSteps||0))<1){host.dataset.status='untrained';runtimeStatus(host,'Untrained weights. Train or import weights before generating.');return;}
 let ticket;try{
  ticket=await reserveMessage();taskScope=plan().multi?null:activeFile;await persistEditor();let hits=[];if(plan().memory){try{hits=await retrieveProject(request);showRetrieval(host,hits);}catch(e){runtimeStatus(host,'Retrieval unavailable: '+e.message);}}
  const reference=hits.length?hits[0].file+':'+hits[0].text:activeFile?fileCache.get(activeFile)||'':'';
  let context=planId==='free'?'':history,feedback='',callsUsed=0;const seen=new Set(),budget=plan().tools?4:0;
  for(let turn=0;turn<=budget;turn++){
   if(cancelled()){host.dataset.status='stopped';return;}
   const stage=document.createElement('section');host.append(stage);const result=await reviewedGeneration(request,stage,cancelled,{history:context,reference,feedback});
   host.dataset.response=result.text;host.dataset.generated=String(host.dataset.generated==='true'||result.bytes>0);
   if(cancelled()||result.reason==='Stopped'){host.dataset.status='stopped';runtimeStatus(stage,'Stopped; partial neural output preserved.');return;}
   if(plan().review!=='raw'){const final=document.createElement('div');stage.append(final);renderResponse(final,result.text);}
   const files=fencedFiles(result.text);if(files.size)presentArtifact(stage,files,{label:'Generated code',origin:'Local neural output · '+plan().name+' · unverified',preview:false});
   const parsed=parseToolCalls(result.text);for(const error of parsed.errors)runtimeStatus(host,'Tool request rejected: '+error);
   if(!parsed.calls.length){host.dataset.status=parsed.errors.length?'tool_error':files.size?'draft':result.text?'response':'empty';return;}
   if(!plan().tools){host.dataset.status='plan_limit';runtimeStatus(host,'Free shows raw output. Tool execution requires Plus or Pro.');return;}
   if(result.reason!=='Turn boundary'){host.dataset.status='partial';runtimeStatus(host,'No tools executed: generation ended before a complete turn boundary.');return;}
   feedback='';for(const call of parsed.calls){if(cancelled()){host.dataset.status='stopped';return;}if(callsUsed>=budget){host.dataset.status='tool_limit';runtimeStatus(host,'Four tool calls reached.');return;}const key=JSON.stringify(call);if(seen.has(key)){host.dataset.status='tool_error';runtimeStatus(host,'Repeated identical tool call stopped.');return;}seen.add(key);callsUsed++;
    if(['fetch_url','import_files','export_zip','run_javascript'].includes(call.name)||call.name.startsWith('custom:')){host.dataset.status='tool_pending';runtimeStatus(host,'Review '+call.name+' in Tools before executing it.');host.append(responseButton('Review tool',()=>{setView('work');toggleCodeTools(true);selectCodeTool(call.name);for(const field of $('toolFormFields').querySelectorAll('[data-param]'))field.value=call.args[field.dataset.param]??'';}));return;}
    const record=executionRecord(host,call.name,call.args);try{const value=await doTool(call.name,call.args);record.finish(true,value);feedback+='Tool '+call.name+': '+value;if(call.name==='write_file')presentArtifact(host,new Map([[call.args.name,fileCache.get(call.args.name)]]),{label:call.args.name,origin:'Saved by tool · unverified'});}catch(e){record.finish(false,e.message);host.dataset.status='tool_error';return;}
   }context=result.text;
  }host.dataset.status='tool_limit';
 }catch(e){host.dataset.status='error';runtimeStatus(host,e.message);}finally{taskScope=null;await finishMessage(ticket,host.dataset.generated==='true');renderPlan();}
}

function installTierUI(){
 const nav=document.createElement('button');nav.className='navbtn';nav.dataset.view='plans';nav.title='Plans';nav.innerHTML='<svg viewBox="0 0 24 24"><path d="M4 6h16v13H4zm0 4h16M8 15h4"/></svg><span class="navText">Plans & usage</span>';nav.onclick=()=>setView('plans');document.querySelector('.sideSection').append(nav);
 const memory=document.createElement('button');memory.className='navbtn';memory.dataset.view='memory';memory.title='Project memory';memory.innerHTML='<svg viewBox="0 0 24 24"><path d="M4 4h12v15H4zm15 5h2v12H9M7 8h6m-6 4h6"/></svg><span class="navText">Project memory</span><span class="pill">PRO</span>';memory.onclick=()=>setView('memory');document.querySelector('.sideSection').append(memory);
 const side=document.createElement('button');side.className='side-plan';side.id='sidePlanButton';side.innerHTML='<strong id="sidePlanName">LUMINA Free</strong><small id="sidePlanUsage">Opening…</small>';side.onclick=()=>setView('plans');document.querySelector('.sidestat').before(side);
 const badge=document.createElement('button');badge.className='plan-chip';badge.id='planBadge';badge.textContent='Free';badge.onclick=()=>setView('plans');document.querySelector('.topRight').prepend(badge);
 const scope=document.createElement('div');scope.className='scope-banner';scope.innerHTML='<span id="scopeLabel">Single file</span><span id="reviewLabel">Raw output</span><button type="button" id="scopePlanLink">Compare plans</button>';document.querySelector('.artifact-top').after(scope);$('scopePlanLink').onclick=()=>setView('plans');
 const terminal=document.createElement('button');terminal.id='terminalTab';terminal.className='artifact-tab';terminal.type='button';terminal.textContent='Console';terminal.onclick=()=>{try{requirePlan('tools');$('terminalPanel').classList.toggle('hidden');if(!$('terminalPanel').classList.contains('hidden'))$('terminalInput').focus();}catch(e){toast(e.message);setView('plans');}};document.querySelector('.artifact-tabs').insertBefore(terminal,$('artifactFilesCount'));document.querySelector('.artifact-foot').insertAdjacentHTML('beforebegin',TERMINAL_HTML);
 $('terminalForm').onsubmit=e=>{e.preventDefault();const command=$('terminalInput').value;$('terminalInput').value='';runConsole(command);};$('stopConsole').onclick=()=>{cancelWork=true;};
 const custom=document.createElement('div');custom.className='card custom-tools-editor';custom.innerHTML='<div class="cardTitle">Custom JavaScript tools <span class="small muted">PLUS / PRO</span></div><div class="cardBody"><div id="customToolsGate" class="small muted">Select Plus or Pro to create and execute custom tools.</div><div id="customToolFields"><label class="label">Tool name<input id="customToolName" class="input" placeholder="count_lines" maxlength="31"></label><label class="label">Description<input id="customToolDescription" class="input" placeholder="Count lines in the selected source file" maxlength="160"></label><label class="label">JavaScript<textarea id="customToolCode" class="textarea" spellcheck="false" placeholder="return { files: fs.listFiles(), input };"></textarea></label><p class="small muted">Receives fs, console and input. Runs in the isolated JavaScript worker. File writes use the active plan’s scope.</p><button id="saveCustomTool" class="button" type="button">Save tool</button></div><div id="customToolList" class="custom-tool-list"></div></div>';$('view-tools').querySelector('div[style]').append(custom);$('saveCustomTool').onclick=saveCustomTool;
 for(const button of document.querySelectorAll('[data-select-plan]'))button.onclick=()=>changePlan(button.dataset.selectPlan);$('reindexProject').onclick=async()=>{try{requirePlan('memory');await persistEditor();await queueFullIndex(true);}catch(e){toast(e.message);}};$('memorySearchForm').onsubmit=e=>{e.preventDefault();searchMemory();};
 renderPlan();
}
const NX_BUILD_REPORT={"version":"2.0","date":"2026-10-16","environment":"Linux, headless Chromium 150; offline file:// and localhost tests","neuralParameters":1117137,"consequenceParameters":480,"totalTrainableParameters":1117617,"suites":[{"name":"Browser regression","passed":19,"failed":0},{"name":"Offline file and full-brain round-trip","passed":5,"failed":0},{"name":"Embedded engineering checks","passed":18,"failed":0},{"name":"Core engine assertions","passed":22,"failed":0},{"name":"Advanced learning and recovery checks","passed":7,"failed":0},{"name":"Central finite-difference comparisons","passed":84,"failed":0}],"networkRequestsInOfflineRun":0,"scope":"Engineering validation on fixtures. Suites overlap; counts are not an intelligence benchmark. Target Chromebook hardware was not profiled.","fixtureByteLoss":{"before":5.997036333552916,"after":0.13327461472529994,"updates":80},"fixtureControllerLoss":{"before":3.123589252352126,"after":0.617397890759124}};
let nexus=null,nxRunning=false,nxConfig={context:'curriculum',heads:4,passes:2,budget:256},nxEngineering=null,nxAblation=null,nxLanguage=[];
const NX_SYSTEMS=[
 ['Logic Cells','64 deterministic typed operations; embeddings are columns of the trained operation head. Usage and execution outcomes persist.','Implemented · pure JSON data'],
 ['Neural Bonds','Typed compatibility plus learned controller transition logits and observed success/failure estimates.','Implemented · bounded evidence'],
 ['Functional Organisms','Versioned typed graphs, hierarchical skill calls, serialization, verified test records and deterministic compilation.','Implemented · finite tests'],
 ['Neural Constructor','Shared neural encoder predicts operations, reference pointers and stopping scores. Typed beam search composes programs.','Partial · explicit schema/literals; ≤6 generated nodes'],
 ['Evolution Engine','Bounded same-type mutations, common-node merging, dead-node pruning, regression checks and version rollback.','Partial · no unrestricted structural evolution'],
 ['Continuity Cells','Learned gated recurrent state persists per Chat/Code session; exact BPTT within 16-byte blocks and detached task boundaries.','Implemented · long-range usefulness unproven'],
 ['Goal Crystals','Editable objectives, subgoals, requirements, constraints, tests and statuses; interface and budgets control construction.','Partial · arbitrary prose constraints are not formally checked'],
 ['Causal Echoes','Actual operation inputs, resulting values, errors, expected outputs and timing; traces ground prediction and replay.','Implemented · observed effects, no causal-discovery claim'],
 ['Abstraction Ladder','Extracts repeated two-node subgraphs, parameterizes external inputs, and checks equivalence on excluded source cases.','Partial · local subgraphs and finite equivalence'],
 ['Counterexample Arena','Declared algebraic contracts, boundary-input mutation, compiler/interpreter agreement and persisted genuine failures.','Partial · no proof of semantic correctness'],
 ['Meaning Capsules','Trainable nonlinear concept projection; supervised family prototypes grounded in typed examples and behaviour.','Implemented · quality depends on training'],
 ['Context Spine','Session-bound explicit fields, learned-vector retrieval, priorities, expiration and bounded retention.','Partial · no learned semantic compression'],
 ['Consequence Simulator','480 learned weights predict numeric, length, Boolean and type summaries from actual operation traces.','Partial · summary predictions, not exact next state'],
 ['Thought Branches','Duplicate detection, neural/pointer/bond scores, limited outcome estimates, typed pruning and fit-test selection.','Implemented · strict candidate budget'],
 ['Transfer Foundry','Existing verified skill calls compete with primitive compositions; excluded task families are evaluated separately.','Partial · small supported task families'],
 ['Neural Consolidation','Replay updates shared neural parameters and the predictor; excluded task loss and trace MSE gate retention with rollback.','Implemented · finite regression protection']
];
const NX_CATEGORIES=['Conversation coherence','Instruction following','Byte prediction','Code completion','Code generation','Code comprehension','Logical reasoning','Tool selection','Program construction','Skill composition','Transfer learning','Memory continuity','Debugging','Multi-step completion','Counterexample robustness','Training stability'];
function nxNotify(text){$('nxMessage').textContent=text;}
function nxShowJSON(id,value){$(id).textContent=typeof value==='string'?value:JSON.stringify(value,null,2);}
function applyNexusBudget(){if(nexus)nexus.dataBudgetBytes=Math.floor(nxConfig.budget*1_000_000*.12);}
async function nxSaveState(){if(nexus){const data=nexus.snapshot();if(JSON.stringify(data).length>nexus.dataBudgetBytes)throw Error('Retained intelligence data exceeds the configured budget; export it or raise the budget');await put('meta',{key:'nexus_state',data,config:nxConfig});}}
function nxPanel(name){for(const b of document.querySelectorAll('[data-nx]'))b.classList.toggle('active',b.dataset.nx===name);for(const p of document.querySelectorAll('[data-nx-panel]'))p.classList.toggle('hidden',p.dataset.nxPanel!==name);renderNexus();}
function nxForm(){const task=$('nxTask').value.trim();if(!task)throw Error('Enter a task description');const schema=normalizeSchema(JSON.parse($('nxSchema').value)),tests=JSON.parse($('nxTests').value);if(!Array.isArray(tests)||!tests.length)throw Error('Provide expected-output tests');return {task,schema,tests};}
function nxChoices(id,items,placeholder){const el=$(id),prior=el.value;el.replaceChildren();if(!items.length){const o=document.createElement('option');o.value='';o.textContent=placeholder;el.append(o);}for(const item of items){const o=document.createElement('option');o.value=item.id;o.textContent=item.name||item.objective||item.id;el.append(o);}if(items.some(x=>x.id===prior))el.value=prior;}
function renderNexus(){
 if(!nexus)return;const s=nexus.state,main=model.parameterCount(),metrics=[['Neural parameters',main.toLocaleString()],['Logic Cells',64],['Observed bonds',Object.keys(s.bonds).length],['Verified organisms',s.organisms.filter(x=>x.verified&&!x.retired).length],['Controller updates',model.auxSteps.toLocaleString()],['Tested constructions',s.metrics.constructions||0]];$('nxMetrics').replaceChildren();for(const [label,value] of metrics){const card=document.createElement('div');card.className='nx-metric';const small=document.createElement('span'),strong=document.createElement('strong');small.textContent=label;strong.textContent=value;card.append(small,strong);$('nxMetrics').append(card);}
 $('nxParameterInfo').textContent=main.toLocaleString()+' neural parameters + '+nexus.outcome.w.length+' consequence parameters\n'+model.D+' embedding · '+model.H+' hidden · '+model.heads+' active heads\n512-byte inference · '+model.passes+' shared refinement passes\n'+fmt(main*16)+' weights + gradients + Adam buffers (model only)\nByte updates: '+(model.steps-model.auxSteps)+' · auxiliary updates: '+model.auxSteps;
 $('nxLegacyExport').disabled=!window.__luminaLegacyAvailable;$('nxSystems').replaceChildren();for(const row of NX_SYSTEMS){const tr=document.createElement('tr');for(const text of row){const td=document.createElement('td');td.textContent=text;tr.append(td);}$('nxSystems').append(tr);}
 if(!$('nxCellSelect').options.length)for(const c of CELL_LIBRARY){const option=document.createElement('option');option.value=c.id;option.textContent=c.id+' ('+c.inputs.join(', ')+') → '+c.output;$('nxCellSelect').append(option);}renderCell();
 nxChoices('nxSkillSelect',s.organisms.filter(x=>x.verified&&!x.retired),'No verified skills yet');renderSkill();nxChoices('nxGoalSelect',s.goals,'No active goals');
 const splitCounts={train:0,val:0,transfer:0};for(const e of s.examples)splitCounts[e.split]++;$('nxCorpusStats').textContent=splitCounts.train+' training tasks · '+splitCounts.val+' excluded validation tasks · '+splitCounts.transfer+' transfer tasks\n'+s.capsules.length+' grounded family capsules\n'+s.traces.length+' actual execution traces · '+s.counterexamples.length+' recorded counterexamples\nVerified constructions: '+s.metrics.verified+' · failed/unverified: '+s.metrics.failed;
 const activeGoals=s.goals.filter(g=>g.status==='active').length;$('nxMemoryStats').textContent=activeGoals+' active goals\n'+s.spine.filter(x=>x.expires>Date.now()).length+' retained fields\n'+Object.keys(s.continuity).length+' recurrent session states\n'+JSON.stringify({sessions:s.session,fields:s.spine.map(({feature,...x})=>x),continuity:Object.fromEntries(Object.entries(s.continuity).map(([k,v])=>[k,{windows:v.windows,step:v.step}]))},null,2);
 $('nxContext').value=nxConfig.context;$('nxHeads').value=nxConfig.heads;$('nxPasses').value=nxConfig.passes;$('nxBudget').value=nxConfig.budget;for(const id of ['nxContext','nxHeads','nxPasses','nxBudget'])$(id).disabled=training||nxRunning||generating||working;
 renderBenchmarks();
}
function renderCell(){if(!nexus)return;const c=CELL_MAP.get($('nxCellSelect').value);if(!c)return;const learned=[];for(let d=0;d<Math.min(12,model.D);d++)learned.push(model.w.OP[d*65+c.index]);nxShowJSON('nxCellDetail',{id:c.id,operation:c.fn.toString(),inputs:c.inputs,output:c.output,version:c.version,execution:nexus.state.cellStats[c.id]||{uses:0,success:0,failure:0},learnedRepresentationPreview:learned,representationDimensions:model.D,trainedControllerUpdates:model.auxSteps});}
function renderSkill(){const skill=nexus?.state.organisms.find(x=>x.id===$('nxSkillSelect').value);nxShowJSON('nxSkillDetail',skill||'No verified skills yet. A candidate needs passing fit cases, excluded cases, and compiled execution.');}
function renderBenchmarks(){
 const latest=split=>nexus.state.evaluations.filter(e=>e.split===split&&e.count>0).at(-1),val=latest('val'),transfer=latest('transfer'),arena=nexus.state.organisms.filter(o=>o.arena).map(o=>o.arena).at(-1),lang=cat=>nxLanguage.filter(x=>x.category===cat),rows=NX_CATEGORIES.map(label=>({label,evidence:'No independent task suite executed.',result:'Not run'}));
 if(Number.isFinite(validateLoss))rows[2]={label:rows[2].label,evidence:'Fixed record-hash holdout; '+valPool.length+' sampled bytes.',result:validateLoss.toFixed(4)+' nats/byte'};
 if(val){const output=val.passed+'/'+val.count+' tasks; '+val.casePass+'/'+val.cases+' cases';rows[8]={label:rows[8].label,evidence:'Excluded tasks at update '+val.step+'; fit-guided bounded search.',result:output};rows[4]={label:rows[4].label,evidence:'Compiled pure-data programs; same suite as construction.',result:output};if(val.toolTotal)rows[7]={label:rows[7].label,evidence:'Labelled tools on excluded structured examples.',result:val.toolCorrect+'/'+val.toolTotal+' top-1'};const multi=val.results.filter(r=>r.program?.nodes.length>1);if(multi.length)rows[9]={label:rows[9].label,evidence:'Multi-node candidates from the construction suite.',result:multi.filter(r=>r.passed===r.total).length+'/'+multi.length};}
 if(transfer)rows[10]={label:rows[10].label,evidence:'Excluded task families at update '+transfer.step+'.',result:transfer.passed+'/'+transfer.count+' tasks'};if(arena)rows[14]={label:rows[14].label,evidence:arena.property+' · finite boundary cases.',result:arena.passed+'/'+arena.total};if(nxEngineering){rows[15]={label:rows[15].label,evidence:'Engineering checks; not a capability benchmark.',result:nxEngineering.passed+'/'+nxEngineering.total};rows[11]={label:rows[11].label,evidence:'State serialization and boundary isolation checked. Semantic retention untested.',result:'Integrity checked'};}
 const mapping={conversation:0,instruction:1,completion:3,comprehension:5,reasoning:6,debugging:12,multistep:13};for(const [cat,index] of Object.entries(mapping)){const tests=lang(cat);if(tests.length)rows[index]={label:rows[index].label,evidence:'User-supplied excluded prompts; '+tests[0].match+' matching.',result:tests.filter(x=>x.ok).length+'/'+tests.length};}
 $('nxBenchmarkRows').replaceChildren();for(const row of rows){const tr=document.createElement('tr');for(const k of ['label','evidence','result']){const td=document.createElement('td');td.textContent=row[k];tr.append(td);}$('nxBenchmarkRows').append(tr);}
}
async function nxAction(id,fn,{tools=false}={}){$(id).onclick=async()=>{if(!nexus||!planReady){nxNotify('Workspace is still opening.');return;}if(nxRunning||training||importing||generating||working||evaluating||auditing||consoleBusy){nxNotify('Finish or stop the active operation first.');return;}try{if(tools)requirePlan('tools');nxRunning=true;evaluating=true;nexus.cancel=false;$('nxStatus').textContent='RUNNING · '+$(id).textContent;$('nxMessage').textContent='';await fn();await nxSaveState();}catch(e){nxNotify(e.message);trainerEvent('Intelligence: '+e.message);}finally{nxRunning=false;evaluating=false;$('nxStatus').textContent='IDLE · LOCAL';renderNexus();renderModel();}};}
function starterCurriculum(){
 const examples=[],numericTests=[{a:2,b:3},{a:-4,b:7},{a:0,b:9},{a:1.5,b:2.5}],textTests=[{a:'  Hello  ',b:'x'},{a:' world ',b:'Z'},{a:'',b:'q'},{a:'Vince',b:'!'}],arrayTests=[{a:[1,2,3],b:2},{a:[-3,0,7],b:1},{a:[],b:4},{a:[1.5,2.5],b:3}];
 const specs=[['add','Add the two numbers','Calculate the sum','numeric-primitives'],['subtract','Subtract b from a','Calculate the difference of a and b','numeric-primitives'],['multiply','Multiply the two numbers','Calculate their product','numeric-primitives'],['minimum','Return the smaller number','Find the minimum value','numeric-primitives'],['maximum','Return the greater number','Find the maximum value','numeric-primitives'],['absolute','Return the absolute value of a','Remove the sign of a','numeric-primitives'],['negate','Negate the number a','Return the opposite of a','numeric-primitives'],['less_than','Check whether a is smaller than b','Compare whether a is less than b','numeric-primitives'],['uppercase','Make the text uppercase','Convert a to capital letters','text-primitives'],['lowercase','Make the text lowercase','Convert a to small letters','text-primitives'],['trim','Trim surrounding whitespace','Remove spaces at both ends','text-primitives'],['text_length','Count characters in the text','Return the length of a','text-primitives'],['reverse_text','Reverse the text','Put the characters in reverse order','text-primitives'],['concatenate','Concatenate a and b','Join the two strings together','text-primitives'],['array_length','Count array entries','Return the number of items','array-primitives'],['sum','Add up the array values','Return the sum of array entries','array-primitives'],['reverse_array','Reverse the array','Put the items in reverse order','array-primitives'],['sort_numbers','Sort the numbers ascending','Order the array from smallest to largest','array-primitives']];
 for(const [id,trainPhrase,valPhrase,family] of specs){const c=CELL_MAP.get(id),names=['a','b','c'].slice(0,c.inputs.length),schema={inputs:Object.fromEntries(names.map((k,i)=>[k,c.inputs[i]])),output:c.output,constants:[0,1]},program={version:1,nodes:[{id:'n0',op:id,args:names.map(input=>({input}))}],output:{ref:'n0'}},seed=family==='numeric-primitives'?numericTests:family==='text-primitives'?textTests:arrayTests,tests=seed.map(raw=>{const input=Object.fromEntries(names.map(k=>[k,raw[k]]));return {input,expected:c.fn(...names.map(k=>input[k]))};});examples.push({task:trainPhrase,schema,program,tests,family,split:'train',tool:family==='numeric-primitives'?'calculate':'none'});examples.push({task:valPhrase,schema,program,tests,family,split:'val',tool:family==='numeric-primitives'?'calculate':'none'});}
 const composite=(task,first,second,family,inputs,tests)=>{const c=CELL_MAP.get(first),d=CELL_MAP.get(second),program={version:1,nodes:[{id:'n0',op:first,args:Object.keys(inputs).slice(0,c.inputs.length).map(input=>({input}))},{id:'n1',op:second,args:[{ref:'n0'}]}],output:{ref:'n1'}},schema={inputs,output:d.output,constants:[0,1]};return {task,family,split:'transfer',schema,program,tests:tests.map(input=>({input,expected:d.fn(c.fn(...Object.keys(inputs).slice(0,c.inputs.length).map(k=>input[k])))}))};};
 examples.push(composite('Make a negative sum positive','add','absolute','transfer-composed-numeric',{a:'number',b:'number'},numericTests.map(x=>({a:x.a,b:x.b}))));examples.push(composite('Trim the text then capitalize it','trim','uppercase','transfer-composed-text',{a:'string'},textTests.map(x=>({a:x.a}))));examples.push(composite('Reverse the text then count its characters','reverse_text','text_length','transfer-composed-text',{a:'string'},textTests.map(x=>({a:x.a}))));return examples;
}
function nxToolSuggestion(task){const p=model.toolProbs(nexus.feature(task)),top=Array.from(p,(_,i)=>i).sort((a,b)=>p[b]-p[a]).slice(0,3);$('nxToolPrediction').textContent=top.map(i=>NEURAL_TOOLS[i]+': '+(100*p[i]).toFixed(1)+'%').join(' · ')+' · '+model.auxSteps+' controller updates. These are neural probabilities, not calibrated correctness.';}
function nxPresentConstruction(host,r,label='Constructed program'){
 const summary=document.createElement('div');summary.className='nx-result';summary.textContent=r.passed+'/'+r.total+' supplied tests · fit '+r.fit.passed+'/'+r.fit.total+' · excluded '+r.holdout.passed+'/'+r.holdout.total+' · '+r.branches+' tested candidates · '+r.depth+' nodes · '+(r.ms/1000).toFixed(2)+' seconds. '+(r.verified?'Finite verification passed.':'Candidate unverified; inspect failures.');host.append(summary);const pre=document.createElement('pre');pre.className='nx-output';pre.textContent=JSON.stringify({program:r.program,fit:r.fit,excluded:r.holdout,tests:r.results.map(({trace,...x})=>x)},null,2);host.append(pre);presentArtifact(host,new Map([['lumina-program.js',r.source]]),{label,origin:'Neural-ranked typed search · '+model.auxSteps+' controller updates · '+(r.verified?'passes supplied checks':'unverified'),preview:false});
}
async function nxConstructTask(task,host,{countMessage=true}={}){
 requirePlan('tools');const form=nxForm();form.task=task||form.task;const goal=nexus.state.goals.find(x=>x.id===$('nxGoalSelect').value&&x.status==='active'&&x.objective===form.task&&stableJSON(normalizeSchema(x.schema))===stableJSON(form.schema)&&stableJSON(x.tests)===stableJSON(form.tests)),depth=goal?.constraints?.maxDepth||Number($('nxDepth').value),branches=goal?.constraints?.maxBranches||Number($('nxBranches').value);let ticket,hasOutput=false;try{if(countMessage)ticket=await reserveMessage();const transfer=nexus.state.examples.some(e=>e.task===form.task&&e.split==='transfer'),r=await nexus.construct(form.task,form.schema,form.tests,{depth,branches,transfer,onProgress:p=>{$('nxStatus').textContent='SEARCH · '+p.tested+'/'+p.branches+' candidates';}});hasOutput=true;$('nxIR').value=JSON.stringify(r.program,null,2);host.replaceChildren();nxPresentConstruction(host,r);nxToolSuggestion(form.task);if(goal){goal.status=r.passed===r.total&&r.compiled.passed===r.compiled.total?'completed':'failed';goal.lastVerification={passed:r.passed,total:r.total,time:Date.now()};}await nxSaveState();return r;}finally{if(ticket)await finishMessage(ticket,hasOutput);}}
function nexusArchive(){const brain=model.pack(),metadata=enc.encode(JSON.stringify({version:2,nexus:nexus.snapshot(),config:nxConfig})),start=(32+metadata.length+3)&~3,total=start+brain.byteLength,out=new Uint8Array(total),dv=new DataView(out.buffer);dv.setUint32(0,0x32584e4c,true);dv.setUint32(4,2,true);dv.setUint32(8,metadata.length,true);dv.setUint32(12,start,true);dv.setUint32(16,total,true);out.set(metadata,32);out.set(new Uint8Array(brain),start);let h=2166136261;for(let i=32;i<out.length;i++){h^=out[i];h=Math.imul(h,16777619);}dv.setUint32(20,h>>>0,true);return out.buffer;}
function decodeNexusArchive(buffer){if(buffer.byteLength<32||new DataView(buffer).getUint32(0,true)!==0x32584e4c)return {brain:buffer};const v=new DataView(buffer),n=v.getUint32(8,true),start=v.getUint32(12,true),a=new Uint8Array(buffer);if(v.getUint32(4,true)!==2||v.getUint32(16,true)!==a.length||n>64_000_000||start!==((32+n+3)&~3)||start>=a.length)throw Error('Invalid full-brain archive');let h=2166136261;for(let i=32;i<a.length;i++){h^=a[i];h=Math.imul(h,16777619);}if((h>>>0)!==v.getUint32(20,true))throw Error('Corrupt full-brain checksum');const m=JSON.parse(dec.decode(a.subarray(32,32+n)));if(m.version!==2)throw Error('Unsupported intelligence archive');return {brain:buffer.slice(start),state:m.nexus,config:m.config};}
async function saveBrain(){if(!model)return;const data=model.pack(),record={key:'brain',data},metrics={key:'training_metrics',evaluationVersion:3,objective:trainingObjective,lossEMA:Number.isFinite(lossEMA)?lossEMA:null,validateLoss:Number.isFinite(validateLoss)?validateLoss:null,holdoutAccuracy:Number.isFinite(holdoutAccuracy)?holdoutAccuracy:null,trainHistory:trainHistory.slice(-200),validationHistory:validationHistory.slice(-200)},architecture=nexus?{key:'nexus_state',data:nexus.snapshot(),config:nxConfig}:null;
 if(db)await new Promise((resolve,reject)=>{const t=db.transaction('meta','readwrite'),s=t.objectStore('meta');s.put(record);s.put(metrics);if(architecture)s.put(architecture);t.oncomplete=resolve;t.onerror=t.onabort=()=>reject(t.error||Error('Checkpoint transaction failed'));});else{await put('meta',record);await put('meta',metrics);if(architecture)await put('meta',architecture);}if($('checkpointState'))$('checkpointState').textContent='Saved '+stamp();log('NEXUS checkpoint committed · '+fmt(data.byteLength),'ok');}
async function saveBestCheckpoint(){const best={key:'best_brain',data:model.pack(),loss:bestValidation,step:model.steps,objective:trainingObjective,evaluationVersion:3},summary={key:'best_summary',loss:bestValidation,step:model.steps,objective:trainingObjective,evaluationVersion:3};if(db)await new Promise((resolve,reject)=>{const t=db.transaction('meta','readwrite'),s=t.objectStore('meta');s.put(best);s.put(summary);t.oncomplete=resolve;t.onerror=t.onabort=()=>reject(t.error);});else{await put('meta',best);await put('meta',summary);}}
async function exportWeights(){if(training||importing||working||generating||nxRunning)return;downloadBlob(new Blob([nexusArchive()],{type:'application/octet-stream'}),'LUMINA-2.0-complete-brain.lum');}
async function importWeights(file){
 if(!file||training||generating||working||evaluating||importing||nxRunning)return;try{if(file.size>90_000_000)throw Error('Checkpoint exceeds the 90 MB working-buffer budget');const raw=file.name.toLowerCase().endsWith('.json')?JSON.parse(await file.text()):decodeNexusArchive(await file.arrayBuffer()),candidate=new ContextNet(),mode=candidate.load(raw.brain??raw),candidateNexus=new NexusEngine(candidate,raw.state||null);
  const previous={key:'before_weight_import',data:model.pack(),nexus:nexus.snapshot(),config:nxConfig};await put('meta',previous);if(mode==='legacy-transfer-nexus'){await put('meta',{key:'pre_nexus_brain',data:raw.brain??raw});window.__luminaLegacyAvailable=true;}
  model=candidate;nexus=candidateNexus;if(raw.config)nxConfig=normalizeNexusConfig(raw.config);else nxConfig={context:'curriculum',heads:model.heads,passes:model.passes,budget:256};applyNexusBudget();lossEMA=NaN;validateLoss=NaN;holdoutAccuracy=NaN;bestValidation=Infinity;bestAt=0;trainHistory=[];validationHistory=[];valPool=[];gradNorm=NaN;await remove('meta','best_brain');await remove('meta','best_summary');await saveBrain();renderModel();renderNexus();drawTrainingChart();trainerEvent(mode==='legacy-transfer-nexus'?'Legacy matrices partially transferred. Original preserved; all Adam moments reset. New layers need training.':'Restored verified NEXUS weights, optimizer state'+(raw.state?', skills and task memory.':'. No intelligence-state archive was supplied.'));}catch(e){alertUser('Weight import failed: '+e.message);trainerEvent('Weight import failed: '+e.message);}
}
function normalizeNexusConfig(c){return {context:['curriculum','96','256','512'].includes(String(c.context))?String(c.context):'curriculum',heads:[2,4].includes(Number(c.heads))?Number(c.heads):4,passes:[1,2,3,4].includes(Number(c.passes))?Number(c.passes):2,budget:[128,256,425].includes(Number(c.budget))?Number(c.budget):256};}
async function init(){
 try{db=await requestDB();}catch(e){db=null;log('Persistent storage unavailable: '+e.message,'fail');}model=new ContextNet();let native=false;const checkpoint=await get('meta','brain');if(checkpoint?.data)try{const mode=model.load(checkpoint.data);native=mode==='native-nexus';if(!native){if(!await get('meta','pre_nexus_brain'))await put('meta',{key:'pre_nexus_brain',data:checkpoint.data});trainerEvent('Legacy checkpoint preserved and partially transferred. New architecture starts a fresh optimizer. Train before judging its output.');}else trainerEvent('NEXUS checkpoint restored; no dataset bytes loaded.');$('checkpointState').textContent=native?'NEXUS restored':'Legacy transfer; training needed';}catch(e){model=new ContextNet();trainerEvent('Damaged checkpoint ignored: '+e.message);$('checkpointState').textContent='Invalid checkpoint ignored';}
 const state=await get('meta','nexus_state');try{nexus=new NexusEngine(model,native?state?.data:null);if(state?.config)nxConfig=normalizeNexusConfig(state.config);}catch(e){nexus=new NexusEngine(model);trainerEvent('Damaged intelligence state ignored; weights retained. '+e.message);}nexus.net=model;applyNexusBudget();nxEngineering=nexus.state.engineering||null;nxAblation=nexus.state.ablation||null;nxLanguage=nexus.state.languageEvaluation||[];model.heads=nxConfig.heads;model.passes=nxConfig.passes;
 if(native){const metrics=await get('meta','training_metrics');if(metrics?.evaluationVersion===3){trainingObjective=metrics.objective==='assistant'?'assistant':'all';validationObjective=trainingObjective;$('objectiveInput').value=trainingObjective;lossEMA=Number.isFinite(metrics.lossEMA)?metrics.lossEMA:NaN;validateLoss=Number.isFinite(metrics.validateLoss)?metrics.validateLoss:NaN;holdoutAccuracy=Number.isFinite(metrics.holdoutAccuracy)?metrics.holdoutAccuracy:NaN;trainHistory=(metrics.trainHistory||[]).slice(-200);validationHistory=(metrics.validationHistory||[]).slice(-200);}const best=await get('meta','best_summary');if(best?.evaluationVersion===3&&best.objective===trainingObjective&&Number.isFinite(best.loss)){bestValidation=best.loss;bestAt=best.step;}}
 const ds=await get('meta','dataset_info');if(ds&&Array.isArray(ds.list)){datasets=ds.list;totalDatasetBytes=Number(ds.total)||0;}const stage=await get('meta','nexus_import_stage');if(stage){$('discardImport').classList.remove('hidden');trainerEvent('An unpublished interrupted import exists. Discard it explicitly or begin a new import.');}
 window.__luminaLegacyAvailable=!!(await get('meta','pre_nexus_brain'));await loadWorkspace();renderModel();renderNexus();drawTrainingChart();refreshStats();$('sideStatus').textContent=db?'Local runtime ready':'Volatile storage session';
}
async function runNexusEngineeringChecks(){
 const rows=[],test=async(name,fn)=>{try{const detail=await fn();rows.push({name,ok:true,detail});}catch(e){rows.push({name,ok:false,error:e.message});}},assert=(ok,message)=>{if(!ok)throw Error(message);};
 const n=new ContextNet({D:8,H:12,seed:21}),tokens=Array.from({length:41},(_,i)=>32+i%17);
 await test('512-byte context includes the earliest byte',()=>{const a=Array(512).fill(65),before=n.forward(a).p.slice();a[0]=66;const after=n.forward(a).p;let delta=0;for(let i=0;i<256;i++)delta=Math.max(delta,Math.abs(before[i]-after[i]));assert(delta>0,'First byte has no influence');return {maxProbabilityChange:delta};});
 await test('New byte-path gradients match central finite differences',async()=>{n.zeroGrad();n.accumulateGrad(tokens,65);const copied=Object.fromEntries(n.keys.map(k=>[k,n.g[k].slice()])),checks=[];for(const k of n.keys){let i=0;for(let j=1;j<copied[k].length;j++)if(Math.abs(copied[k][j])>Math.abs(copied[k][i]))i=j;const analytic=copied[k][i];if(Math.abs(analytic)<1e-8)continue;const old=n.w[k][i],eps=.01;n.w[k][i]=old+eps;const plus=n.evaluate(tokens,65);n.w[k][i]=old-eps;const minus=n.evaluate(tokens,65);n.w[k][i]=old;const numeric=(plus-minus)/(2*eps),error=Math.abs(analytic-numeric)/Math.max(.001,Math.abs(analytic)+Math.abs(numeric));assert(error<.04,k+' gradient mismatch '+error);checks.push({tensor:k,error});await sleep(0);}assert(checks.length>=25,'Some trainable layers did not receive gradients');return checks;});
 await test('Constructor, reference and tool heads receive correct gradients',async()=>{const objective=()=>{n.zeroGrad();return n.accumulateAux(tokens,{op:3,prev:1,step:1,args:[0,1],tool:11}).loss;};objective();const gg=Object.fromEntries(n.keys.map(k=>[k,n.g[k].slice()])),checks=[];for(const k of ['OP','CT','SP','AP','TH','CAP','Zx','IM','AQ','HC']){let i=0;for(let j=1;j<gg[k].length;j++)if(Math.abs(gg[k][j])>Math.abs(gg[k][i]))i=j;const analytic=gg[k][i],old=n.w[k][i],eps=.01;n.w[k][i]=old+eps;const plus=objective();n.w[k][i]=old-eps;const minus=objective();n.w[k][i]=old;const numeric=(plus-minus)/(2*eps),error=Math.abs(analytic-numeric)/Math.max(.001,Math.abs(analytic)+Math.abs(numeric));assert(Math.abs(analytic)>1e-10&&error<.05,k+' auxiliary gradient mismatch');checks.push({tensor:k,error});await sleep(0);}return checks;});
 await test('Optimizer updates lower a fixed-target loss',async()=>{const before=n.evaluate(tokens,65);for(let i=0;i<45;i++){n.trainOne(tokens,65,.003);if(i%8===0)await sleep(0);}const after=n.evaluate(tokens,65);assert(after<before,'No measured learning');return {before,after,updates:45};});
 await test('Weights and per-tensor Adam state round-trip exactly',()=>{const before=n.forward(tokens).p.slice(),other=new ContextNet({D:8,H:12,seed:1});other.load(n.pack());const after=other.forward(tokens).p;assert(before.every((x,i)=>x===after[i]),'Predictions changed after restore');assert(stableJSON(n.ticks)===stableJSON(other.ticks),'Adam ages changed');return {steps:other.steps};});
 await test('Corrupt checkpoints are rejected without mutation',()=>{const good=n.pack(),bad=good.slice(0);new Uint8Array(bad)[bad.byteLength-4]^=8;let rejected=false;try{n.load(bad);}catch{rejected=true;}assert(rejected,'Corruption accepted');const after=new Uint8Array(n.pack());assert(new Uint8Array(good).every((x,i)=>x===after[i]),'Rejected import changed model');});
 await test('Nonfinite gradients reject an update atomically',()=>{const before=n.pack();n.zeroGrad();n.activeKeys.add('E');n.g.E[0]=Infinity;let rejected=false;try{n.applyGrad(.001);}catch{rejected=true;}assert(rejected,'Nonfinite update accepted');const after=new Uint8Array(n.pack());assert(new Uint8Array(before).every((x,i)=>x===after[i]),'Weights changed after rejection');n.zeroGrad();});
 const engine=new NexusEngine(n),schema={inputs:{a:'number',b:'number'},output:'number',constants:[0,1]},program={version:1,nodes:[{id:'n0',op:'add',args:[{input:'a'},{input:'b'}]}],output:{ref:'n0'}},tests=[{input:{a:2,b:3},expected:5},{input:{a:-4,b:7},expected:3},{input:{a:0,b:0},expected:0}];
 await test('Typed interpreter and generated JavaScript meet expected outputs',()=>{assert(engine.test(program,schema,tests).passed===3,'Interpreter failed');assert(engine.test(program,schema,tests,{compiled:true}).passed===3,'Compiled program failed');});
 await test('Invalid dependencies and incompatible bonds are rejected',()=>{for(const ref of [{ref:'future'},{const:'wrong type'}]){const bad=cloneJSON(program);bad.nodes[0].args[1]=ref;let rejected=false;try{engine.validate(bad,schema);}catch{rejected=true;}assert(rejected,'Invalid composition accepted');}});
 await test('Primitive arithmetic, string, array and bounded-loop contracts',()=>{assert(CELL_MAP.get('multiply').fn(3,7)===21,'Multiply');assert(CELL_MAP.get('trim').fn(' x ')==='x','Trim');assert(sameValue(CELL_MAP.get('range').fn(2,5),[2,3,4]),'Range');assert(CELL_MAP.get('sum').fn([2,-1,4])===5,'Sum');let failed=false;try{CELL_MAP.get('divide').fn(1,0);}catch{failed=true;}assert(failed,'Division guard');assert(CELL_LIBRARY.length===64,'Wrong instruction count');});
 await test('A labelled constructor learns and constructs a valid program',async()=>{engine.addExamples([{task:'Add two numbers',schema,program,tests,split:'train',family:'arithmetic'},{task:'Find their sum',schema,program,tests,split:'val',family:'arithmetic'}]);const before=await engine.controllerLoss(engine.state.examples);await engine.trainController({epochs:22,lr:.004});const after=await engine.controllerLoss(engine.state.examples);assert(after<before,'Auxiliary loss failed to improve');const result=await engine.construct('Add two numbers',schema,tests,{depth:2,branches:64});assert(result.passed===3,'Learned construction failed');return {before,after,passed:result.passed,total:result.total};});
 await test('Organisms, hierarchical calls and intelligence state round-trip',()=>{const id=engine.state.organisms[0]?.id;assert(id,'Verified organism missing');const parent={version:1,nodes:[{id:'n0',op:'skill:'+id,args:[{input:'a'},{input:'b'}]}],output:{ref:'n0'}},copy=new NexusEngine(n,engine.snapshot());assert(copy.run(parent,{a:8,b:3},schema)===11,'Hierarchical execution failed');assert(copy.test(parent,schema,tests,{compiled:true}).passed===3,'Hierarchical compilation failed');});
 await test('Counterexample Arena records genuine contract failures',async()=>{const id='subtraction-test',p=cloneJSON(program);p.nodes[0].op='subtract';engine.state.organisms.push({id,version:1,name:'Subtraction',schema,program:p,tests:[],verified:true,feature:[]});const result=await engine.arena(id,'commutative');assert(result.failures.length>0||result.total===0,'Wrong algebraic contract was accepted');if(result.total===0){engine.state.organisms.at(-1).tests=[{input:{a:2,b:5},expected:-3}];const second=await engine.arena(id,'commutative');assert(second.failures.length>0,'Counterexamples missing');return {failures:second.failures.length};}return {failures:result.failures.length};});
 await test('Spine expiration and task boundaries isolate memory',()=>{const id=engine.state.session.work;engine.remember(id,'name','Vince');assert(engine.retrieve(id,'name').length===1,'Retrieval failed');engine.setContinuity('work','current task');assert(engine.state.continuity[id].value.length===n.D,'Continuity missing');engine.resetSession('work');assert(!engine.state.continuity[id]&&engine.retrieve(engine.state.session.work,'name').length===0,'Task-state contamination');});
 await test('Goal requirements survive serialization',()=>{const goal=engine.setGoal('Add',schema,tests,{requirements:['number output'],constraints:{maxDepth:2,maxBranches:32}}),copy=new NexusEngine(n,engine.snapshot());assert(copy.state.goals[0].requirements[0]==='number output'&&copy.state.goals[0].id===goal.id,'Goal lost requirements');});
 await test('Consequence predictor learns actual numeric/type summaries',()=>{const pred=new OutcomeNet(),traces=[{opIndex:1,args:[2,3],result:5},{opIndex:1,args:[-4,7],result:3}],before=pred.evaluate(traces);for(let e=0;e<180;e++)for(const t of traces)pred.train(t);const after=pred.evaluate(traces);assert(after.mse<before.mse,'Prediction objective failed to improve');return {before,after};});
 await test('Transfer families cannot leak into training',()=>{let rejected=false;try{engine.addExamples([{task:'A transfer sum',family:'arithmetic',split:'transfer',schema,program,tests}]);}catch{rejected=true;}assert(rejected,'Transfer leakage accepted');});
 await test('Hugging Face conversation formats preserve assistant content',()=>{const a=extractTrainingText({messages:[{role:'user',content:'Hi'},{role:'assistant',content:[{type:'text',text:'Hello'}]}]}),b=extractTrainingText({conversations:[{from:'human',value:'Hi'},{from:'gpt',value:'Hello'}]});assert(a===b&&a.includes('Assistant: Hello'),'Conversation extraction failed');});
 return {time:Date.now(),passed:rows.filter(r=>r.ok).length,total:rows.length,rows,note:'Small deterministic numerical and functional fixtures. These are engineering checks, not measured general intelligence.'};
}
async function runInferenceAblations(){if(!datasets.length)throw Error('Import a byte corpus first');const baseline=await evaluateHoldout();if(!baseline)throw Error('At least eight independent holdout samples are required');const rows=[],original={heads:model.heads,passes:model.passes,flags:{...model.flags}},configs=[['Original 96-byte architecture',null],['512 context, 2 heads, no new modules',{heads:2,flags:{memory:false,hierarchy:false,iterate:false,capsules:false}}],['512 context, 4-head attention',{heads:4,flags:{memory:false,hierarchy:false,iterate:false,capsules:false}}],['Context + recurrent memory',{heads:4,flags:{memory:true,hierarchy:false,iterate:false,capsules:false}}],['Full neural SYNTHESIS/NEXUS',{heads:4,flags:{memory:true,hierarchy:true,iterate:true,capsules:true}}]];try{for(const [name,config] of configs){if(!config){rows.push({name,status:'Not run: original checkpoint requires its original architecture. No like-for-like retraining performed.'});continue;}let sum=0;for(let i=0;i<valPool.length&&!nexus.cancel;i++){const q=valPool[i],p=model.forward(q.context,config).p;sum-=Math.log(Math.max(1e-30,p[q.target]));if(i%8===0)await sleep(0);}rows.push({name,loss:sum/valPool.length,count:valPool.length});}rows.push({name:'Constructor, Bonds, SYNTHESIS and NEXUS trained ablations',status:'Not run: separate matched training runs and held-out program corpora are required.'});return {time:Date.now(),kind:'Inference component masking only',rows,note:'Same trained weights with components disabled. This does not establish which architecture trains better. Disabled modules alter the input distribution.'};}finally{model.heads=original.heads;model.passes=original.passes;model.flags=original.flags;}}
async function runLanguageEvaluation(){const cases=JSON.parse($('nxLanguageTests').value);if(!Array.isArray(cases)||!cases.length||cases.length>16)throw Error('Provide 1–16 excluded language cases');const rows=[];for(const c of cases){if(typeof c.prompt!=='string'||typeof c.expected!=='string'||!['exact','includes','compilable_js'].includes(c.match))throw Error('Each case needs prompt, expected and match');const bytes=[],history=Array.from(enc.encode(c.prompt).slice(-512)),max=Math.min(128,Math.max(1,Number(c.maxBytes)||64));for(let i=0;i<max&&!nexus.cancel;i++){const next=model.choose(history,0,256,bytes);bytes.push(next);history.push(next);if(history.length>512)history.shift();if(i%8===0)await sleep(0);}const actual=dec.decode(new Uint8Array(bytes));let ok=false;if(c.match==='exact')ok=actual.trim()===c.expected.trim();else if(c.match==='includes')ok=actual.toLowerCase().includes(c.expected.toLowerCase());else try{new Function(actual);ok=true;}catch{}rows.push({category:c.category||'instruction',prompt:c.prompt,expected:c.expected,match:c.match,actual,ok,step:model.steps});if(nexus.cancel)break;}return rows;}
function installNexusUI(){
 const nav=document.createElement('button');nav.className='navbtn';nav.dataset.view='intelligence';nav.title='Intelligence Architecture';nav.innerHTML='<svg viewBox="0 0 24 24"><path d="M6 4v16m12-16v16M6 6l12 4M6 14l12 4M6 10l12-4M6 18l12-4"/></svg><span class="navText">Intelligence</span>';nav.onclick=()=>setView('intelligence');document.querySelector('.sideSection').append(nav);
 const mode=document.createElement('select');mode.id='nxCodeMode';mode.className='input nx-code-mode';mode.setAttribute('aria-label','Code generation pathway');mode.innerHTML='<option value="text">Neural text</option><option value="structured">Typed construction</option>';document.querySelector('.agent-input-actions').append(mode);const link=document.createElement('button');link.className='toolToggle';link.textContent='Architecture';link.onclick=()=>{setView('intelligence');nxPanel('construct');};mode.after(link);
 for(const b of document.querySelectorAll('[data-nx]'))b.onclick=()=>nxPanel(b.dataset.nx);$('nxCellSelect').onchange=renderCell;$('nxSkillSelect').onchange=renderSkill;
 const originalSetView=setView;setView=function(v){originalSetView(v);if(v==='intelligence'){$('pageTitle').textContent='Intelligence Architecture / LUMINA 2.0';renderNexus();}};
 const rawTask=runTierTask;runTierTask=async function(request,host,cancelled,history=''){
  if(view==='work'&&$('nxCodeMode').value==='structured'){if(!plan().tools){runtimeStatus(host,'Typed construction requires Plus or Pro.');host.dataset.status='plan_limit';return;}nexus.cancel=false;const poll=setInterval(()=>{if(cancelled())nexus.cancel=true;},40);try{$('nxTask').value=request;const r=await nxConstructTask(request,host);host.dataset.response=r.source;host.dataset.generated='true';host.dataset.status=r.verified?'draft':'partial';return r;}finally{clearInterval(poll);}}
  const kind=view==='chat'?'chat':'work',session=nexus.state.session[kind];if(planId!=='free'){const continuity=nexus.state.continuity[session];model.inferenceState=continuity?Float32Array.from(continuity.value):null;const fields=nexus.retrieve(session,request,2);if(fields.length)history=fields.map(x=>x.key+': '+JSON.stringify(x.value)).join('\n')+'\n'+history;}else model.inferenceState=null;
  try{await rawTask(request,host,cancelled,history);if(planId!=='free'&&host.dataset.response&&!cancelled()){nexus.setContinuity(kind,'User: '+request+'\nAssistant: '+host.dataset.response);nexus.remember(session,'recent_request',byteTail(request,160),{priority:1,ttl:86400000});await nxSaveState();}}finally{model.inferenceState=null;}
 };
 const oldNewTask=newCodeTask;newCodeTask=function(){if(working||generating||training||nxRunning)return;oldNewTask();nexus?.resetSession('work');nxSaveState().catch(()=>{});};
 $('cancelImport').onclick=()=>{cancelImport=true;};$('discardImport').onclick=async()=>{if(importing||training)return;try{await cleanupStagedImport();}catch(e){trainerEvent(e.message);}};
 for(const id of ['nxCancel','nxStopLearning'])$(id).onclick=()=>{if(nexus)nexus.cancel=true;nxNotify('Stopping at the next bounded operation boundary.');};
 for(const [id,key] of [['nxContext','context'],['nxHeads','heads'],['nxPasses','passes'],['nxBudget','budget']])$(id).onchange=async()=>{if(training||generating||working||nxRunning){renderNexus();return;}nxConfig=normalizeNexusConfig({...nxConfig,[key]:$(id).value});applyNexusBudget();model.heads=nxConfig.heads;model.passes=nxConfig.passes;model.trainC=nxConfig.context==='curriculum'?96:Number(nxConfig.context);valPool=[];validateLoss=NaN;holdoutAccuracy=NaN;bestValidation=Infinity;bestAt=0;await remove('meta','best_brain');await remove('meta','best_summary');await nxSaveState();renderModel();renderNexus();nxNotify('Configuration set for the next operation; validation baseline reset.');};
 nxAction('nxConstruct',async()=>{const f=nxForm();await nxConstructTask(f.task,$('nxConstructionResult'));nxNotify('Construction finished. Inspect supplied and excluded test results.');},{tools:true});
 nxAction('nxRunIR',async()=>{const f=nxForm(),program=JSON.parse($('nxIR').value),result=nexus.test(program,f.schema,f.tests),compiled=nexus.test(program,f.schema,f.tests,{compiled:true});nxShowJSON('nxConstructionResult',{origin:'User-supplied deterministic IR; no neural construction',interpreted:{passed:result.passed,total:result.total},compiled:{passed:compiled.passed,total:compiled.total},tests:result.results.map(({trace,...r})=>r)});nexus.updateEvidence(program,result,{task:f.task});},{tools:true});
 nxAction('nxPresentIR',async()=>{const f=nxForm(),program=JSON.parse($('nxIR').value),source=nexus.compile(program,f.schema),host=document.createElement('div');appendWorkMessage('runtime','Compiled supplied typed program.').append(host);presentArtifact(host,new Map([['lumina-program.js',source]]),{label:'Compiled typed program',origin:'User-supplied IR · no neural generation'});setView('work');},{tools:true});
 nxAction('nxCurriculum',async()=>{const added=nexus.addExamples(starterCurriculum());nxNotify('Added '+added+' disclosed task/IR examples. Reference targets come from deterministic primitives. No weights changed. Train the controller explicitly.');});
 nxAction('nxAddExample',async()=>{const value=JSON.parse($('nxExample').value);const count=nexus.addExamples(Array.isArray(value)?value:[value]);nxNotify('Validated and added '+count+' labelled example(s). No weights changed.');});
 $('nxExampleFile').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file||nxRunning||training||importing||generating||working||evaluating)return;if(file.size>24_000_000){nxNotify('Structured corpus file exceeds the 24 MB working-buffer budget. Split into smaller JSONL files.');return;}try{const text=await file.text(),records=file.name.endsWith('.json')?JSON.parse(text):text.split(/\r?\n/).filter(x=>x.trim()).map(x=>JSON.parse(x));const added=nexus.addExamples(Array.isArray(records)?records:[records]);await nxSaveState();renderNexus();nxNotify('Added '+added+' structured examples.');}catch(err){nxNotify('Structured import failed: '+err.message);}};
 nxAction('nxExportExamples',async()=>{downloadBlob(new Blob([nexus.state.examples.map(e=>JSON.stringify(e)).join('\n')+'\n'],{type:'application/x-ndjson'}),'LUMINA-structured-training.jsonl');});
 const learning=consolidate=>async()=>{await put('meta',{key:'before_training',data:model.pack(),objective:trainingObjective,nexus:nexus.snapshot()});const result=await nexus.trainController({epochs:Number($('nxEpochs').value),lr:Number($('nxLR').value),consolidate,validateLanguage:()=>datasets.length?evaluateHoldout():Promise.resolve(null),onProgress:p=>{$('nxLearningProgress').style.width=(100*p.updates/p.total)+'%';$('nxLearningResult').textContent=p.updates+'/'+p.total+' optimizer updates · auxiliary loss '+p.loss.toFixed(4);}});nxShowJSON('nxLearningResult',result);if(datasets.length){const byteCheck=await evaluateHoldout();if(byteCheck){validateLoss=byteCheck.loss;holdoutAccuracy=byteCheck.accuracy;validationHistory.push({step:model.steps,loss:validateLoss});validationHistory=validationHistory.slice(-200);drawTrainingChart();}}await saveBrain();nxNotify((result.kept?'Retained':'Rolled back')+' '+result.updates+' actual auxiliary updates.');};
 nxAction('nxTrain',learning(false));nxAction('nxConsolidate',learning(true));
 nxAction('nxEvolve',async()=>nxShowJSON('nxSkillDetail',await nexus.evolve($('nxSkillSelect').value)));nxAction('nxRollback',async()=>nxShowJSON('nxSkillDetail',nexus.rollbackSkill($('nxSkillSelect').value)));nxAction('nxAbstract',async()=>nxNotify(JSON.stringify(await nexus.abstract())));nxAction('nxArena',async()=>{const r=await nexus.arena($('nxSkillSelect').value,$('nxProperty').value);nxShowJSON('nxEvaluationResult',r);nxNotify('Arena: '+r.passed+'/'+r.total+' finite checks. '+r.note);});
 $('nxGoalSelect').onchange=()=>{const g=nexus.state.goals.find(g=>g.id===$('nxGoalSelect').value);$('nxGoal').value=g?JSON.stringify(g,null,2):'';};
 nxAction('nxNewGoal',async()=>{const f=nxForm(),g=nexus.setGoal(f.task,f.schema,f.tests,{constraints:{maxDepth:Number($('nxDepth').value),maxBranches:Number($('nxBranches').value)}});$('nxGoal').value=JSON.stringify(g,null,2);renderNexus();$('nxGoalSelect').value=g.id;});
 nxAction('nxSaveGoal',async()=>{const g=JSON.parse($('nxGoal').value);if(typeof g.objective!=='string'||!Array.isArray(g.tests)||!Array.isArray(g.requirements)||!Array.isArray(g.subgoals)||!Array.isArray(g.dependencies)||!['active','completed','failed','paused'].includes(g.status))throw Error('Invalid goal structure');if(!Number.isInteger(g.constraints?.maxDepth)||g.constraints.maxDepth<1||g.constraints.maxDepth>6||!Number.isInteger(g.constraints?.maxBranches)||g.constraints.maxBranches<8||g.constraints.maxBranches>128)throw Error('Goal exceeds construction budgets');nexus.setGoal(g.objective,g.schema,g.tests,g);nxNotify('Goal fields saved. Prose requirements remain inspectable; only typed interfaces and executable tests are enforced.');});
 nxAction('nxUseGoal',async()=>{const g=nexus.state.goals.find(g=>g.id===$('nxGoalSelect').value);if(!g)throw Error('Select a goal');$('nxTask').value=g.objective;$('nxSchema').value=JSON.stringify(g.schema,null,2);$('nxTests').value=JSON.stringify(g.tests,null,2);$('nxDepth').value=g.constraints.maxDepth||4;$('nxBranches').value=g.constraints.maxBranches||64;nxPanel('construct');});
 nxAction('nxRemember',async()=>{requirePlan('tools');const key=$('nxMemoryKey').value.trim();if(!key||key.length>80)throw Error('Use a memory key of 1–80 characters');nexus.remember(nexus.state.session.work,key,JSON.parse($('nxMemoryValue').value),{priority:Number($('nxMemoryPriority').value)});nxNotify('Saved explicit task field.');});
 nxAction('nxResetWorkMemory',async()=>{nexus.resetSession('work');codeHistory=[];nxNotify('New Code memory boundary created.');});nxAction('nxResetChatMemory',async()=>{nexus.resetSession('chat');chatMessages=[];$('chatStream').replaceChildren();nxNotify('New Chat memory boundary created.');});
 nxAction('nxEngineering',async()=>{nxEngineering=await runNexusEngineeringChecks();nxShowJSON('nxEvaluationResult',nxEngineering);nexus.state.engineering=nxEngineering;nxNotify(nxEngineering.passed+'/'+nxEngineering.total+' engineering checks passed.');});
 for(const [id,split] of [['nxEvalController','val'],['nxEvalTransfer','transfer']])nxAction(id,async()=>{const r=await nexus.evaluate({split,onProgress:p=>{$('nxEvaluationResult').textContent='Evaluating '+p.done+'/'+p.total+' excluded tasks';}});nxShowJSON('nxEvaluationResult',r);});
 nxAction('nxAblations',async()=>{nxAblation=await runInferenceAblations();nxShowJSON('nxEvaluationResult',nxAblation);nexus.state.ablation=nxAblation;});nxAction('nxEvaluateLanguage',async()=>{model.inferenceState=null;nxLanguage=await runLanguageEvaluation();nexus.state.languageEvaluation=nxLanguage;nxShowJSON('nxEvaluationResult',nxLanguage);});
 nxAction('nxExportReport',async()=>{const report={version:'LUMINA 2.0 SYNTHESIS NEXUS',buildVerification:NX_BUILD_REPORT,time:new Date().toISOString(),parameters:{neural:model.parameterCount(),outcome:nexus.outcome.w.length},configuration:nxConfig,model:{steps:model.steps,auxSteps:model.auxSteps,byteSteps:model.steps-model.auxSteps},systems:NX_SYSTEMS.map(([name,implementation,scope])=>({name,implementation,scope})),engineering:nxEngineering,ablations:nxAblation,language:nxLanguage,evaluations:nexus.state.evaluations,consolidation:nexus.state.consolidations,metrics:nexus.state.metrics};downloadBlob(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),'LUMINA-2.0-evaluation.json');});
 $('nxLegacyExport').onclick=async()=>{const record=await get('meta','pre_nexus_brain');if(!record)return nxNotify('No legacy checkpoint exists in this browser.');const json=!(record.data instanceof ArrayBuffer);downloadBlob(new Blob([json?typeof record.data==='string'?record.data:JSON.stringify(record.data):record.data],{type:json?'application/json':'application/octet-stream'}),'LUMINA-preserved-original.'+(json?'json':'lum'));};
 // Restore a complete pre-import snapshot without deleting the imported file.
 const undo=document.createElement('button');undo.className='button';undo.textContent='Undo weight import';undo.id='nxUndoImport';$('importBrain').after(undo);nxAction('nxUndoImport',async()=>{const snap=await get('meta','before_weight_import');if(!snap)throw Error('No weight import recovery point');const candidate=new ContextNet();candidate.load(snap.data);const state=new NexusEngine(candidate,snap.nexus);model=candidate;nexus=state;nxConfig=normalizeNexusConfig(snap.config||nxConfig);validateLoss=NaN;lossEMA=NaN;valPool=[];bestValidation=Infinity;bestAt=0;await remove('meta','best_brain');await remove('meta','best_summary');await saveBrain();nxNotify('Restored weights, optimizer and intelligence state from before the last import.');});
 window.addEventListener('pagehide',()=>{nexus&&(nexus.cancel=true);});
}

TOOL_INFO.push(['run_javascript','Execute supplied JavaScript in an isolated browser worker']);TOOL_FIELDS.run_javascript=[['code','JavaScript source',true,'console.log(2 + 2);']];

// Lumina-1.0 service runtime: all model requests go through the same-origin backend.
let luminaChatController = null;
let luminaWorkController = null;
let luminaStudioToken = '';
let luminaStudioFile = null;
let luminaStudioValidation = null;
let luminaStudioPoll = null;
let luminaStudioCurrentJob = null;
let luminaStudioVisible = false;

const LUMINA_PRODUCT_PROMPT = 'You are Lumina-1.0, developed by Reason Intelligence, founded by Vince Dipisa. Do not falsely claim the company trained the underlying base-model weights. Be candid about tools and tests.';

function luminaSetBranding() {
  document.title = 'Lumina-1.0 — Reason Intelligence';
  const brandSub = document.querySelector('.brandSub');
  if (brandSub) brandSub.textContent = 'REASON INTELLIGENCE';
  const topSub = document.querySelector('.topSub');
  if (topSub) topSub.textContent = 'AI workspace · code artifacts · secure hosted inference';
  const pageTitle = $('pageTitle');
  if (pageTitle) pageTitle.innerHTML = 'Code <span class="muted" style="font-size:12px">/ LUMINA-1.0</span>';
  const chatHeading = document.querySelector('#chatWelcome h1');
  if (chatHeading) chatHeading.innerHTML = 'Meet Lumina-1.0.<br>What are we solving?';
  const chatPara = document.querySelector('#chatWelcome p');
  if (chatPara) chatPara.textContent = 'Ask questions, reason through a problem, or draft code. Code remains a draft until you execute or test it.';
  const notice = document.querySelector('#chatWelcome .notice');
  if (notice) notice.textContent = 'Responses are generated by the configured hosted model. Model identity does not imply that generated code has been executed or verified.';
  const workHead = document.querySelector('.agent-heading h1');
  if (workHead) workHead.textContent = 'Build with Lumina-1.0';
  const workPara = document.querySelector('.agent-heading p');
  if (workPara) workPara.textContent = 'Request code, inspect generated files, preview browser output, and run the workspace checks. Generation alone is not proof that code works.';
  const workEyebrow = document.querySelector('.agent-heading .eyebrow');
  if (workEyebrow) workEyebrow.innerHTML = '<span class="presence"></span> LUMINA-1.0 CODE WORKSPACE';
  const chatInput = $('chatInput');
  if (chatInput) chatInput.placeholder = 'Message Lumina-1.0…';
  const chatHint = $('chatHint');
  if (chatHint) chatHint.textContent = 'Lumina-1.0 · Shift+Enter for newline';
  const footer = document.querySelector('#view-chat .foot');
  if (footer) footer.textContent = 'Lumina-1.0 · Reason Intelligence';
  if ($('brainChip')) $('brainChip').textContent = 'MODEL · LUMINA-1.0';
  if (!$('luminaModelSelector')) {
    const selector = document.createElement('select');
    selector.id = 'luminaModelSelector';
    selector.setAttribute('aria-label', 'Selected model');
    selector.innerHTML = '<option value="lumina-1.0">Lumina-1.0</option>';
    selector.title = 'Product model name';
    $('effort')?.before(selector);
  }
}

const luminaBrandObserver = new MutationObserver(() => {
  const chip = $('brainChip');
  if (chip && chip.textContent !== 'MODEL · LUMINA-1.0') chip.textContent = 'MODEL · LUMINA-1.0';
});
if ($('brainChip')) luminaBrandObserver.observe($('brainChip'), { childList: true, characterData: true, subtree: true });
luminaSetBranding();

function luminaChatHistory() {
  return chatMessages.slice(-24).filter(m => m && typeof m.txt === 'string' && m.txt.trim()).map(m => ({
    role: (m.role === 'You' || m.role === 'user') ? 'user' : 'assistant',
    content: m.txt
  }));
}

async function luminaStream(messages, mode, signal, onText) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify({
      messages,
      mode: mode === 'code' ? 'code' : 'chat',
      stream: true,
      effort: $('effort')?.value === 'maximum' ? 'maximum' : 'standard',
      max_completion_tokens: 4096
    }),
    signal
  });
  if (!response.ok) {
    let problem = {};
    try { problem = await response.json(); } catch {}
    const details = problem.details ? ' ' + problem.details : '';
    throw new Error((problem.error || 'Lumina request failed with HTTP ' + response.status + '.') + details);
  }
  if (!response.body) throw new Error('The server did not provide a response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  const handleEvent = eventText => {
    const data = eventText.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let payload;
    try { payload = JSON.parse(data); } catch { return; }
    const delta = payload?.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta) {
      answer += delta;
      onText?.(answer);
    } else if (Array.isArray(delta)) {
      for (const part of delta) if (typeof part?.text === 'string') answer += part.text;
      onText?.(answer);
    }
    const err = payload?.error?.message || payload?.message?.error;
    if (err) throw new Error(String(err));
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const eventText = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleEvent(eventText);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleEvent(buffer);
  } finally {
    reader.releaseLock();
  }
  if (!answer.trim()) throw new Error('The configured model returned no text. Check the provider response and model configuration.');
  return answer.trim();
}

sendChat = async function sendChatLumina10() {
  const message = $('chatInput').value.trim();
  if (!message || generating || working) return;
  if (!planReady || planChanging) { toast('Workspace is still opening.'); return; }
  if (training || importing || evaluating || auditing) { toast('An existing background operation is still active.'); return; }
  $('chatInput').value = '';
  appendChat('You', message);
  const out = appendChat('Lumina-1.0', '');
  setBusy(true);
  generating = true;
  chatCancelled = false;
  luminaChatController = new AbortController();
  try {
    const answer = await luminaStream(luminaChatHistory(), 'chat', luminaChatController.signal, partial => {
      out.textContent = partial;
      $('chatStream').scrollTop = $('chatStream').scrollHeight;
    });
    renderResponse(out, answer);
    const last = chatMessages[chatMessages.length - 1];
    if (last) { last.role = 'Lumina-1.0'; last.txt = answer; }
    if (chatMessages.length > 40) chatMessages = chatMessages.slice(-40);
  } catch (error) {
    const wasStopped = error.name === 'AbortError' || chatCancelled;
    const visible = wasStopped ? 'Response stopped.' : 'Could not reach Lumina-1.0: ' + error.message;
    renderResponse(out, visible);
    out.dataset.status = wasStopped ? 'stopped' : 'error';
    const last = chatMessages[chatMessages.length - 1];
    if (last) { last.role = 'Lumina-1.0'; last.txt = ''; }
    if (!wasStopped) toast(error.message);
  } finally {
    generating = false;
    setBusy(false);
    luminaChatController = null;
    if (typeof renderPlan === 'function') renderPlan();
  }
};
$('sendChat').onclick = sendChat;
$('stopChat').onclick = () => { chatCancelled = true; luminaChatController?.abort(); cancelWork = true; luminaWorkController?.abort(); };
if ($('goTrain')) $('goTrain').onclick = e => { e.preventDefault(); openFineTuningStudio(); };

// Replace the local untrained-weight response path in the coding workflow with real hosted inference.
deliverTask = async function deliverTaskLumina10(request, host, cancelled, context = '') {
  const inCodeView = !$('view-work')?.classList.contains('hidden');
  const controller = new AbortController();
  luminaWorkController = controller;
  const messages = [];
  if (context && context.trim()) messages.push({ role: 'assistant', content: 'Previous coding-workflow context follows. Treat it as conversation history, not verified execution evidence:\n' + context.slice(-18_000) });
  messages.push({ role: 'user', content: String(request).slice(0, 40_000) });
  let partial = '';
  try {
    const answer = await luminaStream(messages, inCodeView ? 'code' : 'chat', controller.signal, text => {
      partial = text;
      host.textContent = text;
      host.dataset.response = text;
      host.scrollIntoView?.({ block: 'nearest' });
    });
    partial = answer;
    renderResponse(host, answer);
    host.dataset.response = answer;
    host.dataset.generated = 'true';
    const artifacts = inCodeView ? fencedFiles(answer) : new Map();
    if (artifacts.size) {
      host.dataset.status = 'draft';
      presentArtifact(host, artifacts, { label: 'Lumina-1.0 generated files', origin: 'Groq inference · not executed or independently verified', preview: false });
    } else host.dataset.status = answer ? 'response' : 'empty';
    return { text: answer, origin: 'Groq / GPT-OSS-120B', generated: true };
  } catch (error) {
    const wasStopped = error.name === 'AbortError' || (typeof cancelled === 'function' && cancelled());
    if (partial) renderResponse(host, partial + (wasStopped ? '\n\n[Response stopped; partial output retained.]' : ''));
    else renderResponse(host, wasStopped ? 'Response stopped.' : 'Could not reach Lumina-1.0: ' + error.message);
    host.dataset.response = partial;
    host.dataset.status = wasStopped ? 'stopped' : 'error';
    if (!wasStopped) runtimeStatus(host, error.message);
    if (wasStopped) return { text: partial, stopped: true };
    throw error;
  } finally {
    luminaWorkController = null;
  }
};
$('stopWork').addEventListener('click', () => luminaWorkController?.abort());

// Hide the legacy browser trainer from navigation. The keyboard-gated Studio below is its only UI entry.
const originalSetViewLumina10 = setView;
setView = function setViewLumina10(name) {
  if (name === 'train') { openFineTuningStudio(); return; }
  const result = originalSetViewLumina10(name);
  const labels = { chat: 'Chat', work: 'Code', tools: 'Tool library', about: 'Settings', intelligence: 'Intelligence Architecture', plans: 'Plans & usage', memory: 'Project memory' };
  $('pageTitle').innerHTML = (labels[name] || 'Lumina-1.0') + ' <span class="muted" style="font-size:12px">/ LUMINA-1.0</span>';
  return result;
};

function ensureFineTuningStudio() {
  if ($('luminaStudioOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'luminaStudioOverlay';
  overlay.className = 'lumina-studio-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <section class="lumina-studio-modal" role="dialog" aria-modal="true" aria-labelledby="luminaStudioTitle">
      <header class="lumina-studio-head"><div><div class="eyebrow">REASON INTELLIGENCE / RESTRICTED WORKFLOW</div><h2 id="luminaStudioTitle">Lumina Fine-Tuning Studio</h2><p>Opened with Alt + Shift + 9. Real training requires a compatible worker; this screen never simulates completed jobs.</p></div><button id="luminaStudioClose" class="lumina-studio-close" aria-label="Close Fine-Tuning Studio">×</button></header>
      <div class="lumina-studio-body"><div class="lumina-studio-grid">
        <section class="lumina-studio-card"><h3>1. Access and dataset</h3>
          <label class="lumina-studio-label" for="luminaStudioToken">Fine-Tuning Studio access token</label><input id="luminaStudioToken" class="lumina-studio-input" type="password" autocomplete="off" placeholder="Enter the server-configured admin token">
          <p class="lumina-studio-note">This is not the Groq API key. The admin token is sent only to this same-origin backend and is not saved to browser storage.</p>
          <label class="lumina-studio-label" for="luminaDatasetFile">JSONL dataset</label><input id="luminaDatasetFile" class="lumina-studio-input" type="file" accept=".jsonl,.ndjson,application/x-ndjson,text/plain">
          <div class="lumina-studio-actions"><button class="lumina-studio-btn" id="luminaValidateDataset">Validate dataset</button></div>
          <div id="luminaDatasetStatus" class="lumina-studio-status">No dataset selected.</div><pre id="luminaDatasetPreview" class="lumina-studio-preview">Import a JSONL file to inspect validation results and sample records.</pre>
        </section>
        <section class="lumina-studio-card"><h3>2. Training configuration</h3>
          <div class="lumina-model-badge">Base model · GPT-OSS-120B</div>
          <label class="lumina-studio-label" for="luminaTrainMethod">Fine-tuning method</label><select id="luminaTrainMethod" class="lumina-studio-select"><option value="lora">LoRA adapter</option><option value="qlora">QLoRA adapter</option></select>
          <label class="lumina-studio-label" for="luminaTrainEpochs">Epochs (1–20)</label><input id="luminaTrainEpochs" class="lumina-studio-input" type="number" min="1" max="20" value="1">
          <label class="lumina-studio-label" for="luminaTrainLR">Learning rate (0.000001–0.01)</label><input id="luminaTrainLR" class="lumina-studio-input" type="number" min="0.000001" max="0.01" step="0.00001" value="0.0001">
          <label class="lumina-studio-label" for="luminaTrainBatch">Batch size (1–128)</label><input id="luminaTrainBatch" class="lumina-studio-input" type="number" min="1" max="128" value="1">
          <div class="lumina-studio-actions"><button class="lumina-studio-btn primary" id="luminaSubmitTraining" disabled>Submit real training job</button><button class="lumina-studio-btn" id="luminaCancelTraining" disabled>Cancel job</button></div>
          <div id="luminaJobStatus" class="lumina-studio-status">Checking backend configuration…</div><pre id="luminaJobDetails" class="lumina-studio-preview lumina-studio-status-list"></pre>
        </section>
      </div></div>
    </section>`;
  document.body.append(overlay);
  $('luminaStudioClose').addEventListener('click', closeFineTuningStudio);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeFineTuningStudio(); });
  $('luminaDatasetFile').addEventListener('change', async e => {
    luminaStudioFile = e.target.files?.[0] || null;
    luminaStudioValidation = null;
    $('luminaDatasetStatus').textContent = luminaStudioFile ? `${luminaStudioFile.name} · ${luminaStudioFile.size.toLocaleString()} bytes · validate before submitting.` : 'No dataset selected.';
    $('luminaDatasetPreview').textContent = luminaStudioFile ? 'Dataset has not been validated.' : 'Import a JSONL file to inspect validation results and sample records.';
    $('luminaSubmitTraining').disabled = true;
  });
  $('luminaValidateDataset').addEventListener('click', async () => {
    if (!luminaStudioFile) { setStudioStatus('luminaDatasetStatus', 'Choose a JSONL file first.', 'error'); return; }
    const button = $('luminaValidateDataset'); button.disabled = true; button.textContent = 'Validating…';
    setStudioStatus('luminaDatasetStatus', 'Reading the dataset as a stream; large files are not loaded into one giant string.');
    try {
      luminaStudioValidation = await validateLuminaJSONL(luminaStudioFile);
      const v = luminaStudioValidation;
      const issues = v.issues.length ? '\n\nIssues:\n' + v.issues.map(x => `Line ${x.line}: ${x.reason}`).join('\n') : '';
      setStudioStatus('luminaDatasetStatus', `${v.valid} valid records · ${v.blank} blank lines · ${v.issues.length} invalid records${v.issuesTruncated ? ' (additional issues omitted)' : ''}${v.valid > 0 && v.issues.length === 0 ? '\nDataset validation passed.' : '\nCorrect every malformed record before submitting.'}`, v.valid > 0 && v.issues.length === 0 ? 'good' : 'error');
      $('luminaDatasetPreview').textContent = 'Sample records:\n' + (v.samples.length ? v.samples.join('\n\n---\n\n') : '(no valid records)') + issues;
      $('luminaSubmitTraining').disabled = !(v.valid > 0 && v.issues.length === 0);
    } catch (error) {
      luminaStudioValidation = null;
      setStudioStatus('luminaDatasetStatus', 'Validation failed: ' + error.message, 'error');
      $('luminaDatasetPreview').textContent = '';
      $('luminaSubmitTraining').disabled = true;
    } finally { button.disabled = false; button.textContent = 'Validate dataset'; }
  });
  $('luminaSubmitTraining').addEventListener('click', submitLuminaTraining);
  $('luminaCancelTraining').addEventListener('click', cancelLuminaTraining);
  fetch('/api/health', { headers: { 'Accept': 'application/json' } }).then(r => r.json()).then(data => {
    if (data.fineTuningConfigured) setStudioStatus('luminaJobStatus', 'Training worker is configured. Verify model compatibility when submitting; the worker must reject unsupported combinations.');
    else setStudioStatus('luminaJobStatus', 'Fine-tuning worker not configured. Set FINE_TUNING_SERVICE_URL, FINE_TUNING_SERVICE_TOKEN, and FINE_TUNE_ADMIN_TOKEN in the hosting environment. No training job can start until these are configured.', 'error');
  }).catch(() => setStudioStatus('luminaJobStatus', 'Backend health check unavailable.', 'error'));
}

function setStudioStatus(id, text, tone = '') {
  const el = $(id);
  if (!el) return;
  el.className = 'lumina-studio-status' + (tone ? ' ' + tone : '');
  el.textContent = text;
}

function openFineTuningStudio() {
  ensureFineTuningStudio();
  luminaStudioVisible = true;
  $('luminaStudioOverlay').hidden = false;
  document.body.style.overflow = 'hidden';
  if (luminaStudioToken) $('luminaStudioToken').value = luminaStudioToken;
  $('luminaStudioToken').focus();
  if (luminaStudioCurrentJob && luminaStudioToken && !luminaStudioPoll) pollLuminaTrainingJob();
}
function closeFineTuningStudio() {
  if (!$('luminaStudioOverlay')) return;
  $('luminaStudioOverlay').hidden = true;
  document.body.style.overflow = '';
  luminaStudioVisible = false;
  if (luminaStudioPoll) { clearTimeout(luminaStudioPoll); luminaStudioPoll = null; }
}

async function validateLuminaJSONL(file) {
  if (!file || typeof file.stream !== 'function') throw new Error('This browser does not support streaming file reads. Use a current Chrome version.');
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let pending = '', lineNo = 0, valid = 0, blank = 0, issues = [], issuesTruncated = false, samples = [];
  const maxRecordChars = 12 * 1024 * 1024;
  function recordLine(line) {
    lineNo++;
    if (!line.trim()) { blank++; return; }
    if (line.length > maxRecordChars) { if (issues.length < 12) issues.push({ line: lineNo, reason: 'record exceeds 12 MiB' }); else issuesTruncated = true; return; }
    let value;
    try { value = JSON.parse(line); }
    catch { if (issues.length < 12) issues.push({ line: lineNo, reason: 'invalid JSON' }); else issuesTruncated = true; return; }
    const supported = value && typeof value === 'object' && !Array.isArray(value) && (
      (Array.isArray(value.messages) && value.messages.length > 0) ||
      (typeof value.prompt === 'string' && typeof value.completion === 'string') ||
      (typeof value.instruction === 'string' && typeof value.output === 'string') ||
      (Array.isArray(value.conversations) && value.conversations.length > 0)
    );
    if (!supported) { if (issues.length < 12) issues.push({ line: lineNo, reason: 'expected messages[], prompt/completion, instruction/output, or conversations[]' }); else issuesTruncated = true; return; }
    valid++;
    if (samples.length < 4) samples.push(JSON.stringify(value, null, 2).slice(0, 1600));
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > maxRecordChars && !pending.includes('\n')) {
        lineNo++;
        if (issues.length < 12) issues.push({ line: lineNo, reason: 'record exceeds 12 MiB' }); else issuesTruncated = true;
        pending = '';
        continue;
      }
      let at;
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at).replace(/\r$/, '');
        pending = pending.slice(at + 1);
        recordLine(line);
      }
    }
    pending += decoder.decode();
    if (pending.length || lineNo === 0) recordLine(pending.replace(/\r$/, ''));
  } finally { reader.releaseLock(); }
  return { valid, blank, issues, issuesTruncated, samples, totalLines: lineNo };
}

async function submitLuminaTraining() {
  if (!luminaStudioFile || !luminaStudioValidation || luminaStudioValidation.issues.length || !luminaStudioValidation.valid) {
    setStudioStatus('luminaJobStatus', 'Choose and validate a JSONL dataset before submitting.', 'error'); return;
  }
  const token = $('luminaStudioToken').value.trim();
  if (!token) { setStudioStatus('luminaJobStatus', 'Enter the Fine-Tuning Studio access token configured by the service owner.', 'error'); $('luminaStudioToken').focus(); return; }
  const epochs = Number($('luminaTrainEpochs').value), learningRate = Number($('luminaTrainLR').value), batchSize = Number($('luminaTrainBatch').value);
  if (!Number.isInteger(epochs) || epochs < 1 || epochs > 20 || !Number.isFinite(learningRate) || learningRate < 0.000001 || learningRate > 0.01 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 128) {
    setStudioStatus('luminaJobStatus', 'Training parameters are outside the allowed ranges.', 'error'); return;
  }
  const button = $('luminaSubmitTraining'); button.disabled = true; $('luminaCancelTraining').disabled = true;
  setStudioStatus('luminaJobStatus', 'Uploading the validated JSONL stream to the configured training worker. This is a real submission request; progress will be shown only after the worker returns its job record.');
  try {
    const response = await fetch('/api/fine-tune/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Authorization': 'Bearer ' + token,
        'X-Dataset-Filename': luminaStudioFile.name,
        'X-Base-Model-Id': 'openai/gpt-oss-120b',
        'X-Training-Method': $('luminaTrainMethod').value,
        'X-Training-Config': JSON.stringify({ epochs, learningRate, batchSize })
      },
      body: luminaStudioFile
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || `Training worker returned HTTP ${response.status}.`);
    const jobId = data.id || data.jobId || data.job_id;
    if (!jobId) {
      $('luminaJobDetails').textContent = JSON.stringify(data, null, 2);
      throw new Error('The worker accepted the request but returned no job ID. The adapter contract requires id or jobId; no success is assumed.');
    }
    luminaStudioToken = token;
    luminaStudioCurrentJob = String(jobId);
    $('luminaJobDetails').textContent = JSON.stringify(data, null, 2);
    setStudioStatus('luminaJobStatus', `Job ${luminaStudioCurrentJob} submitted. Status below will be refreshed from the worker.`, 'good');
    $('luminaCancelTraining').disabled = false;
    pollLuminaTrainingJob();
  } catch (error) {
    setStudioStatus('luminaJobStatus', 'Submission failed: ' + error.message, 'error');
    button.disabled = false;
  }
}

async function pollLuminaTrainingJob() {
  if (!luminaStudioCurrentJob || !luminaStudioToken || !luminaStudioVisible) return;
  try {
    const response = await fetch('/api/fine-tune/jobs/' + encodeURIComponent(luminaStudioCurrentJob), { headers: { 'Authorization': 'Bearer ' + luminaStudioToken, 'Accept': 'application/json' } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Status request returned HTTP ${response.status}.`);
    $('luminaJobDetails').textContent = JSON.stringify(data, null, 2);
    const status = String(data.status || data.state || 'unknown').toLowerCase();
    const terminal = /completed|succeeded|success|failed|error|cancelled|canceled|rejected/.test(status);
    setStudioStatus('luminaJobStatus', `Worker-reported state: ${status}${terminal ? '. No further polling.' : '. Refreshing from the worker.'}`, /completed|succeeded|success/.test(status) ? 'good' : /failed|error|rejected/.test(status) ? 'error' : '');
    if (terminal) {
      $('luminaSubmitTraining').disabled = !(luminaStudioValidation?.valid > 0 && luminaStudioValidation?.issues.length === 0);
      $('luminaCancelTraining').disabled = true;
      luminaStudioCurrentJob = null;
      return;
    }
  } catch (error) {
    setStudioStatus('luminaJobStatus', 'Could not retrieve job status: ' + error.message + ' Use the worker job details to diagnose connectivity.', 'error');
  }
  luminaStudioPoll = setTimeout(pollLuminaTrainingJob, 3000);
}

async function cancelLuminaTraining() {
  if (!luminaStudioCurrentJob || !luminaStudioToken) return;
  $('luminaCancelTraining').disabled = true;
  try {
    const response = await fetch('/api/fine-tune/jobs/' + encodeURIComponent(luminaStudioCurrentJob) + '/cancel', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + luminaStudioToken, 'Accept': 'application/json' }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Cancel request returned HTTP ${response.status}.`);
    $('luminaJobDetails').textContent = JSON.stringify(data, null, 2);
    setStudioStatus('luminaJobStatus', 'Cancellation request sent. The worker must confirm the final state.', 'good');
    pollLuminaTrainingJob();
  } catch (error) {
    setStudioStatus('luminaJobStatus', 'Cancellation failed: ' + error.message, 'error');
    $('luminaCancelTraining').disabled = false;
  }
}

ensureFineTuningStudio();
document.addEventListener('keydown', event => {
  if (event.isComposing || event.repeat) return;
  if (event.altKey && event.shiftKey && event.code === 'Digit9') {
    event.preventDefault();
    if (event.target?.isContentEditable) return;
    if (luminaStudioVisible) closeFineTuningStudio(); else openFineTuningStudio();
    return;
  }
  if (event.key === 'Escape' && luminaStudioVisible) closeFineTuningStudio();
});

fetch('/api/health', { headers: { 'Accept': 'application/json' } }).then(response => response.json()).then(data => {
  if ($('sideStatus')) $('sideStatus').textContent = data.providerConfigured ? 'Lumina backend connected' : 'Groq key not configured';
  if ($('chatHint')) $('chatHint').textContent = data.providerConfigured ? 'Lumina-1.0 · GPT-OSS-120B hosted inference' : 'Deployment setup required · configure GROQ_API_KEY';
  if ($('brainChip')) $('brainChip').textContent = 'MODEL · LUMINA-1.0';
}).catch(() => { if ($('sideStatus')) $('sideStatus').textContent = 'Backend unavailable'; });


installTierUI();
installNexusUI();
Object.defineProperty(window,'LUMINA',{value:Object.freeze({version:'2.0',get model(){return model},get intelligence(){return nexus},get ready(){return planReady},get training(){return training},get importing(){return importing},get datasets(){return datasets.map(x=>({...x}))},get validation(){return {loss:validateLoss,best:bestValidation,pool:valPool.length}},engineeringChecks:runNexusEngineeringChecks,importDataset,saveBrain,exportArchive:nexusArchive,decodeArchive:decodeNexusArchive,drawSample,evaluateHoldout,runTierTask,executeJavaScript,doTool,requestStop:()=>{cancelTraining=true;cancelImport=true;cancelWork=true;if(nexus)nexus.cancel=true;},changePlan,config:()=>({...nxConfig})})});
init().catch(async e=>{trainerEvent('Initialization issue: '+e.message);model=model||new ContextNet();nexus=nexus||new NexusEngine(model);await fallbackWorkspace();renderModel();renderNexus();}).then(initPlans).catch(e=>toast(e.message));
})();
