const app = document.querySelector('#app');
const faces = ['🐰','🐻','🐱','🦊','🐼','🐸','🐨','🐥'];
let session; try { session = JSON.parse(sessionStorage.getItem('relay')); } catch {}
let state, timer, busy = false, lastPhase = '', draft = '', chatDraft = '', chatSending = false, polling = false, failedChat = null;
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(message){const el=document.querySelector('#toast');el.textContent=message;el.style.display='block';clearTimeout(timer);timer=setTimeout(()=>el.style.display='none',3500)}
async function api(action, data={}){const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15000);try{const response=await fetch('/api/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...session,...data}),signal:controller.signal});const result=await response.json();if(!response.ok){const error=Error(result.error);error.status=response.status;throw error;}return result}finally{clearTimeout(timeout)}}
function applyState(next){
if(state&&next.code===state.code&&(next.snapshot||0)<(state.snapshot||0))return;
const changed=!state||next.phase!==lastPhase||next.round!==state.round||next.revision!==state.revision||next.host!==state.host||JSON.stringify(next.history)!==JSON.stringify(state.history)||next.readyCount!==state.readyCount||next.submitted!==state.submitted||JSON.stringify(next.players.map(p=>[p.key,p.name]))!==JSON.stringify(state.players.map(p=>[p.key,p.name]));
if(state&&next.revision!==state.revision){draft='';chatDraft='';failedChat=null;const input=document.querySelector('#chat-text');if(input)input.value='';}
state=next;if(changed)render();else updateLive();
}
function gameScene(game){
const distance=game.distance||0, finished=game.phase==='finished', count=game.players.length;
const span=finished?Math.min(28,(count-1)*7):Math.min(82,32+distance/100*16);
const positions=game.players.map((p,i)=>count===1?50:50-span/2+i*span/(count-1));
return `<section class="journey ${finished?'journey-finished':''}" aria-label="默契接力路，累计接力 ${distance} 米">
<div class="journey-bar"><h2>默契接力路</h2><div class="distance-total"><strong>${distance}<small> m</small></strong><span>累计接力距离</span></div></div>
<div class="journey-map"><img class="landscape" src="journey.svg" alt="树林、远山与弯弯的接力小路">
${positions.slice(1).map((x,i)=>`<div class="distance-link" style="left:${positions[i]}%;width:${x-positions[i]}%"><span>${finished?'♥':distance?distance+' m':'出发'}</span></div>`).join('')}
${game.players.map((p,i)=>`<div class="map-player ${p.self?'is-me':''}" style="left:${positions[i]}%"><div class="map-avatar">${faces[i]}</div><span class="map-number">${p.self?'你':i+1}${p.submitted?' ✓':''}</span></div>`).join('')}
<span class="map-caption">${finished?'默契达成':'未同词 +100 m'}</span></div>
<div class="journey-roster">${game.players.map((p,i)=>`<div class="roster-player"><span>${faces[i]}</span><div><strong title="${esc(p.name)}">${esc(p.name)}${p.self?' <em>你</em>':''}</strong><small>${game.phase==='lobby'?'已就位':p.submitted?'✓ 已提交':'正在联想…'}</small></div></div>`).join('')}</div></section>`;
}
function home(){app.innerHTML=`<section class="hero home-hero"><span class="badge">2—5 人</span><h1>同词相逢</h1></section><div class="grid"><section class="card home-card"><h2>创建房间</h2><button class="full" id="create">创建房间</button></section><section class="card home-card"><h2>加入房间</h2><label class="label" for="code">房间码</label><input id="code" maxlength="6" placeholder="6 位房间码" value="${esc(new URLSearchParams(location.search).get('room')||'')}"><button class="full secondary" id="join">加入房间</button></section></div><p class="rules">输入词语 → 全员揭晓 → 继续联想，直到同词</p>`;for(const action of ['create','join'])document.getElementById(action).onclick=async()=>{if(busy)return;busy=true;try{const result=await api(action,action==='join'?{code:document.querySelector('#code').value}:{});session={code:result.code,token:result.token};sessionStorage.setItem('relay',JSON.stringify(session));state=result.state;render()}catch(e){toast(e.message)}finally{busy=false}}}
function render(){if(!state)return home();const savedChat=document.querySelector('.chat');const savedScroll=savedChat?.querySelector('#chat-log')?.scrollTop||0;const chatFocused=document.activeElement?.id==='chat-text';const chatSelection=chatFocused?document.activeElement.selectionStart:null;lastPhase=state.phase;const previous=state.history.at(-1);app.innerHTML=`<div class="topline"><span class="room-round">${state.phase==='lobby'?'房间大厅':state.phase==='finished'?'游戏结束':`第 ${state.round} 轮`}</span><button class="secondary" id="copy">房间 ${esc(state.code)} ⧉</button></div><div id="track">${gameScene(state)}</div><section class="card" id="stage"></section><section class="card chat" aria-label="房间公共聊天"><div class="topline"><h2>聊天</h2></div><div id="chat-log" class="chat-log" role="log" aria-live="polite" aria-label="聊天记录"></div><form id="chat-form"><div class="chat-compose"><input id="chat-text" maxlength="200" autocomplete="off" aria-label="聊天消息，最多200字" placeholder="输入消息" value="${esc(chatDraft)}" required><button id="chat-send" ${chatSending?'disabled':''}>发送</button></div></form></section><section class="card" style="margin-top:20px"><div class="topline"><button class="secondary" id="leave">离开房间</button>${state.host?'<button class="secondary" id="restart">本房间重新开局</button>':''}</div><details class="room-notes"><summary>房间规则</summary><p class="hint">离线 90 秒自动离开；不足两人时回大厅并清空本局。</p></details>${state.host?`<details><summary>管理参与者</summary><div class="players">${state.players.filter(p=>!p.self).map(p=>`<button class="secondary" data-remove="${esc(p.key)}">移除 ${esc(p.name)}</button>`).join('')}</div></details>`:''}</section>${state.history.length?`<section class="card history" aria-label="我们的联想足迹"><h2>我们的联想足迹 · ${state.history.length} 轮</h2>${state.history.map((round,i)=>`<article class="history-round"><h3>第 ${i+1} 轮</h3>${words(round)}</article>`).join('')}</section>`:''}`;
if(savedChat){document.querySelector('.chat').replaceWith(savedChat);savedChat.querySelector('#chat-log').scrollTop=savedScroll;}
document.querySelector('#track').dataset.version=JSON.stringify([state.phase,state.distance,state.players]);
const stage=document.querySelector('#stage');
if(state.phase==='lobby'){stage.innerHTML=`<div class="topline"><h2>参与者</h2><span class="hint">${state.players.length}/5 位伙伴</span></div><div class="players">${state.players.map((p,i)=>`<span class="chip">${faces[i]} ${esc(p.name)}</span>`).join('')}</div>${state.host?`<button id="start" class="full" ${state.players.length<2?'disabled':''}>开始游戏</button>`:'<p>等待房主开始</p>'}`;bind('start','start')}
else if(state.phase==='finished'){stage.innerHTML=`<div class="hero"><span class="badge">✧ 默契达成</span><h2 class="success">${esc(previous[0].word)}</h2><p>${state.round} 轮 · ${state.distance} m</p><button id="home">返回首页</button></div>`;document.querySelector('#home').onclick=leaveRoom}
else if(state.phase==='reveal'){stage.innerHTML=`<div class="topline"><h2>第 ${state.round} 轮的答案</h2><span class="badge">伙伴间距 +100 米</span></div>${words(previous)}<button id="next" class="full" ${state.ready?'disabled':''}>${state.ready?`已准备（${state.readyCount}/${state.players.length}）`:'准备下一轮'}</button>`;bind('next','next')}
else{stage.innerHTML=`${previous?`<span class="eyebrow">上一轮</span>${words(previous)}`:''}${state.submitted?`<div class="hero"><h2>已提交 ✓</h2><p id="progress">${progress()}</p></div>`:`<h2>输入词语</h2><form id="wordform"><label class="label" for="word">你的词语 · 1—20 个字</label><input id="word" maxlength="20" autocomplete="off" placeholder="输入词语" value="${esc(draft)}" required><button class="full">提交</button></form><p class="hint" id="progress">${progress()}</p>`}`;const form=document.querySelector('#wordform');if(form){document.querySelector('#word').oninput=e=>draft=e.target.value;form.onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;try{const result=await api('word',{word:draft});draft='';applyState(result)}catch(err){toast(err.message)}finally{busy=false}}}}

updateChat();
const chatInput=document.querySelector('#chat-text');chatInput.oninput=e=>chatDraft=e.target.value;
if(chatFocused){chatInput.focus({preventScroll:true});chatInput.setSelectionRange(chatSelection,chatSelection)}
document.querySelector('#chat-form').onsubmit=sendChat;
if(!chatInput.dataset.imeBound){chatInput.addEventListener('compositionstart',()=>chatInput.dataset.composing='true');chatInput.addEventListener('compositionend',()=>{delete chatInput.dataset.composing;chatDraft=chatInput.value});chatInput.dataset.imeBound='true';}
chatInput.onkeydown=e=>{if(e.key==='Enter'&&(e.isComposing||chatInput.dataset.composing==='true'||e.keyCode===229))e.preventDefault()};
updateChatButton();
document.querySelector('#leave').onclick=leaveRoom;
const restart=document.querySelector('#restart');if(restart)restart.onclick=async()=>{if(!confirm('让所有人回到大厅，清空本局进度并重新开始？'))return;try{const result=await api('restart');draft='';chatDraft='';applyState(result)}catch(e){toast(e.message)}};
document.querySelectorAll('[data-remove]').forEach(b=>b.onclick=async()=>{if(!confirm('移除这位玩家？剩余玩家将继续，不足两人则回到大厅。'))return;try{applyState(await api('remove',{player:b.dataset.remove}))}catch(e){toast(e.message)}});
document.querySelector('#copy').onclick=async()=>{try{await navigator.clipboard.writeText(`${location.origin}/?room=${state.code}`);toast('邀请链接已复制')}catch{toast('把房间码 '+state.code+' 发给朋友吧')}};
}
function updateChatButton(){const button=document.querySelector('#chat-send');if(button){button.disabled=chatSending;button.textContent=chatSending?'发送中…':'发送'}}
async function sendChat(e){
e.preventDefault();const input=document.querySelector('#chat-text');if(chatSending||!session||input?.dataset.composing==='true')return;
const text=(input?.value||'').trim();if(!text)return;
const current=session, revision=state.revision;
const message=failedChat&&failedChat.text===text?failedChat:{text,client_id:crypto.randomUUID()};
failedChat=null;chatSending=true;chatDraft='';input.value='';updateChatButton();
try{const result=await api('chat',{...message,revision});if(current!==session)return;applyState(result)}
catch(err){if(current!==session||state.revision!==revision)return;failedChat=message;const liveInput=document.querySelector('#chat-text');if(!chatDraft&&!liveInput?.value){chatDraft=text;if(liveInput)liveInput.value=text}toast(err.status?err.message:'发送未确认，请重试')}
finally{chatSending=false;updateChatButton()}
}
function words(entries){return `<div class="words">${entries.map(p=>`<div class="word"><small>${esc(p.name)}</small><strong>${esc(p.word)}</strong></div>`).join('')}</div>`}
function progress(){return `${state.players.filter(p=>p.submitted).length}/${state.players.length} 已提交`}
function bind(id,action){const b=document.getElementById(id);if(b)b.onclick=async()=>{if(busy)return;busy=true;try{applyState(await api(action))}catch(e){toast(e.message)}finally{busy=false}}}
function updateChat(){const log=document.querySelector('#chat-log');if(!log)return;const messages=state.messages||[];const previous=JSON.parse(log.dataset.ids||'[]');const ids=messages.map(m=>m.id);if(JSON.stringify(previous)===JSON.stringify(ids))return;const nearBottom=log.scrollHeight-log.scrollTop-log.clientHeight<60;const append=previous.length<=ids.length&&previous.every((id,i)=>ids[i]===id);if(!append)log.replaceChildren();const fresh=append?messages.slice(previous.length):messages;log.insertAdjacentHTML('beforeend',fresh.map(m=>`<div class="chat-message"><div class="chat-meta"><strong>${esc(m.name)}</strong><span>第 ${m.round} 轮</span></div><div class="chat-bubble">${esc(m.text)}</div></div>`).join(''));log.dataset.ids=JSON.stringify(ids);if(nearBottom)log.scrollTop=log.scrollHeight}
function updateLive(){updateChat();const track=document.querySelector('#track');const version=JSON.stringify([state.phase,state.distance,state.players]);if(track.dataset.version!==version){track.innerHTML=gameScene(state);track.dataset.version=version}const p=document.querySelector('#progress');if(p)p.textContent=progress()}
function clearSession(){session=null;state=null;draft='';chatDraft='';failedChat=null;sessionStorage.removeItem('relay');history.replaceState({},'', '/');home()}
async function leaveRoom(){if(busy)return;busy=true;try{await api('leave');clearSession()}catch(e){if(e.status===400)clearSession();else toast('暂时无法退出，请稍后再试')}finally{busy=false}}
async function poll(){if(!session||busy||polling)return;polling=true;const current=session;try{const next=await api('state');if(current!==session)return;try{applyState(next)}catch(error){console.error('Page update failed',error);toast('页面更新失败，请刷新页面')}}catch(e){if(current!==session)return;if(e.status===400){clearSession();toast('房间已失效或你已离开')}else toast('连接中断，正在重试…')}finally{polling=false}}
home();if(session)poll();setInterval(poll,1200);
