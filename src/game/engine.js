/* PK LOẠN CHIẾN 0.1.26 — Procedural movement and ground-contact Foley; offline, gesture-unlocked Web Audio. 
   Terrain data, collision, rendering and excavation are code-driven; backgrounds and character are WebP. */
(()=>{'use strict';
const $=id=>document.getElementById(id);
// Keep menu and settings fixed in the physical screen orientation, independent of rotated gameplay.
// React hosts #overlay alongside #game (outside the rotatable game area).
const PixelFX=window.PK_PIXELFX;
// Character actions reuse original Diệp Tu sprites; all skill effects use PixelFX.
// Actual fire effects below come from the official fire/ and arcane/ modules of PixelFX.
if(!PixelFX)throw new Error('PixelFX bundle must load before game.js');
const canvas=$('scene'),ctx=canvas.getContext('2d',{alpha:false});
const CELL=10,CHUNK=32,WORLD_W=4800,WORLD_H=2400,CHAR_SCALE=.52,CHAR_H=238*CHAR_SCALE,GRAVITY=890;
const CLIPS=[['idle',8,true],['walk',8,true],['run',8,true],['jump_start',3,false],['jump_air',3,false],['fall',8,true],['land',3,false],['hand_seal',8,false],['hurt',8,false],['knockdown',8,false],['down_idle',8,true],['getup',8,false],['fly_up',6,false],['hover',8,true],['charge_raise',8,false],['charge_hold',4,true],['cast_fire',12,false]];
const clipMap=Object.fromEntries(CLIPS.map(([id,frames,loop])=>[id,{id,frames,loop}]));
const sourceAssets={
 sky:'assets/backgrounds/01_Khong_Trung.webp',
 surface:'assets/backgrounds/02_Phong_Canh_Mat_Dat.webp',
 cave:'assets/backgrounds/03_Hang_Dong_Sau.webp',
 ...Object.fromEntries(CLIPS.map(([id])=>[id,'assets/sprites/'+id+'.webp']))
};
const settings={speed:100,quality:'high',fxQuality:'medium',stats:true,geology:false,zoom:.70,orientation:'landscape',soundEnabled:true,soundVolume:70};
const game={started:false,running:false,menu:'menu',quality:'high',images:{},ready:false,viewW:0,viewH:0,dpr:1,last:0,acc:0,elapsed:0,fps:60,frames:0,fpsAcc:0};
// Original procedural Foley: short boot contacts, grit, sole roll and two-foot landing.
// Buffers are generated locally and cached. No network, audio files or audio worklets required.
function makeFoleyPCM(kind,material,variant,sampleRate=32000){
 const landing=kind==='land',m=Math.max(1,Math.min(4,material|0));
 const profile=[
  {body:115,cut:3300,grit:.76,tail:.060,grains:27}, // topsoil / grass and grit
  {body:132,cut:2600,grit:.56,tail:.045,grains:17}, // packed clay
  {body:185,cut:6800,grit:.48,tail:.032,grains:12}, // stone
  {body:154,cut:4900,grit:.40,tail:.040,grains:15}  // deep rock
 ][m-1];
 let seed=(0x39e8a27+variant*6143+m*3761+(landing?9857:0))>>>0;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const duration=landing?.43:.21,pcm=new Float32Array(Math.ceil(duration*sampleRate));
 const grit=new Float32Array(pcm.length),scale=.94+random()*.12;
 const roll=(landing?.020:.030)+random()*.012;
 // Individual grains are softer than the heel; their irregular placement avoids a repeated hiss.
 for(let g=0;g<profile.grains*(landing?2:1);g++){
  const at=Math.floor((.007+Math.pow(random(),1.7)*(landing?.25:.145))*sampleRate);
  const len=Math.floor(sampleRate*(.0006+random()*.0024));
  const amp=(.05+random()*.15)*Math.exp(-at/sampleRate/(landing?.11:.065));
  for(let j=0;j<len&&at+j<grit.length;j++)grit[at+j]+=(random()*2-1)*Math.sin(Math.PI*j/len)*amp;
 }
 const coefficient=f=>1-Math.exp(-2*Math.PI*f/sampleRate);
 const aBody=coefficient(420),aLow=coefficient(220),aHigh=coefficient(profile.cut);
 const dc=Math.exp(-2*Math.PI*30/sampleRate);
 let bodyNoise=0,lo=0,hi=0,previous=0,filtered=0,phase=0,peak=0;
 for(let i=0;i<pcm.length;i++){
  const t=i/sampleRate,noise=random()*2-1;
  bodyNoise+=aBody*(noise-bodyNoise);lo+=aLow*(noise-lo);hi+=aHigh*(noise-hi);
  const heel=(1-Math.exp(-t/.0016))*Math.exp(-t/(landing?.058:.027));
  const rt=Math.max(0,t-roll),toe=t>roll?(1-Math.exp(-rt/.004))*Math.exp(-rt/(landing?.085:.035)):0;
  const scrape=(1-Math.exp(-t/.003))*Math.exp(-t/(profile.tail*(landing?1.9:1)));
  phase+=2*Math.PI*(profile.body*scale*(landing?.65:1))*(.74+.26*Math.exp(-t*48))/sampleRate;
  const resonance=Math.sin(phase)*Math.exp(-t/(landing?.033:.016));
  let value=bodyNoise*(heel*(landing?2.9:2.0)+toe*.95)
   +(hi-lo)*profile.grit*(scrape*.40+toe*.34)
   +resonance*(landing?.22:.16)+grit[i]*(landing?1.15:.85);
  // Quiet, short sole click on rock; never a sustained pitched beep.
  if(m>=3)value+=noise*.11*Math.exp(-t/.0035)*(1-Math.exp(-t/.0007));
  filtered=dc*(filtered+value-previous);previous=value;
  const fade=Math.max(0,Math.min(1,(duration-t)/.016));
  value=filtered*fade*fade*Math.min(1,t/.001);
  pcm[i]=value;peak=Math.max(peak,Math.abs(value));
 }
 const gain=(landing?.82:.72)/Math.max(.001,peak);
 for(let i=0;i<pcm.length;i++)pcm[i]*=gain;
 pcm[0]=pcm[pcm.length-1]=0;
 return pcm;
}

function makeActionAudio(){
 const STORE='pk-loan-chien-action-audio-v1';
 let context=null,master=null,limiter=null,unavailable=false,serial=0;
 let lastStep=-Infinity,lastLanding=-Infinity,lastEvent=null,totalPlayed=0;
 const buffers=new Map(),voices=new Set();
 function restore(){
  try{const saved=JSON.parse(window.localStorage.getItem(STORE)||'null');
   if(saved&&typeof saved.enabled==='boolean')settings.soundEnabled=saved.enabled;
   if(saved&&Number.isFinite(saved.volume))settings.soundVolume=Math.max(0,Math.min(100,saved.volume));
  }catch{}
 }
 function persist(){try{window.localStorage.setItem(STORE,JSON.stringify({enabled:settings.soundEnabled,volume:settings.soundVolume}));}catch{}}
 function sync(){
  if(!master||!context||context.state==='closed')return;
  const volume=settings.soundEnabled?.76*Math.pow(settings.soundVolume/100,1.35):0;
  master.gain.cancelScheduledValues(context.currentTime);
  master.gain.setTargetAtTime(volume,context.currentTime,.012);
 }
 function unlock(){
  if(!settings.soundEnabled||settings.soundVolume<=0||document.hidden)return false;
  try{
   if(!context||context.state==='closed'){
    const AudioContextClass=window.AudioContext||window.webkitAudioContext;
    if(!AudioContextClass){unavailable=true;return false;}
    context=new AudioContextClass({latencyHint:'interactive'});buffers.clear();voices.clear();
    master=context.createGain();master.gain.value=0;
    limiter=context.createDynamicsCompressor();limiter.threshold.value=-9;limiter.knee.value=6;
    limiter.ratio.value=4;limiter.attack.value=.003;limiter.release.value=.09;
    master.connect(limiter);limiter.connect(context.destination);unavailable=false;
   }
   if(context.state==='suspended'||context.state==='interrupted'){
    const pending=context.resume();if(pending?.catch)pending.catch(()=>{});
   }
   sync();return true;
  }catch{unavailable=true;return false;}
 }
 function getBuffer(kind,material,variant){
  const key=kind+':'+material+':'+variant;
  if(buffers.has(key))return buffers.get(key);
  const data=makeFoleyPCM(kind,material,variant),buffer=context.createBuffer(1,data.length,32000);
  buffer.getChannelData(0).set(data);buffers.set(key,buffer);return buffer;
 }
 function stopVoice(voice){
  try{const now=context.currentTime;voice.gain.gain.cancelScheduledValues(now);
   voice.gain.gain.setTargetAtTime(0,now,.005);voice.source.stop(now+.025);
  }catch{}
 }
 function stopAll(){
  for(const voice of voices)stopVoice(voice);voices.clear();
  lastStep=lastLanding=-Infinity;
 }
 function emit(kind,intensity,material){
  if(!game.running||document.hidden||!settings.soundEnabled||settings.soundVolume<=0||!context||context.state!=='running')return false;
  // Drop obsolete contacts while audio is locked; never replay a backlog on resume.
  const now=context.currentTime,step=kind==='step';
  if(step&&now-lastStep<.07||!step&&now-lastLanding<.12)return false;
  const m=Math.max(1,Math.min(4,material|0)),v=serial++%4;
  let source,gain;
  try{
   if(voices.size>=6){const oldest=voices.values().next().value;stopVoice(oldest);voices.delete(oldest);}
   source=context.createBufferSource();gain=context.createGain();source.buffer=getBuffer(kind,m,v);
   source.playbackRate.value=[.97,1.025,.99,1.015][v]*(step?1:.94);
   const strength=Math.max(0,Math.min(1,intensity));
   gain.gain.value=(step?.30+.48*strength:.46+.54*strength)*(v%2?.94:1);
   source.connect(gain);gain.connect(master);
   const voice={source,gain};voices.add(voice);
   source.onended=()=>{voices.delete(voice);try{source.disconnect();gain.disconnect();}catch{}};
   source.start(now+.002);
   if(step)lastStep=now;else lastLanding=now;
   totalPlayed++;lastEvent={kind,material:m,intensity:strength,variant:v};return true;
  }catch{
   if(source){for(const voice of voices)if(voice.source===source)voices.delete(voice);try{source.disconnect();}catch{}}
   try{gain?.disconnect();}catch{}return false;
  }
 }
 function footstep(speed,material){return emit('step',Math.min(1,Math.abs(speed)/220),material);}
 function land(speed,material,body=false){return emit('land',Math.min(1,Math.max(0,(speed-80)/460)+(body?.16:0)),material);}
 function change(enabled,volume){
  settings.soundEnabled=!!enabled;settings.soundVolume=Math.max(0,Math.min(100,Number(volume)||0));
  persist();sync();if(!settings.soundEnabled||settings.soundVolume<=0)stopAll();else unlock();
 }
 return {restore,unlock,stopAll,change,footstep,land,status:()=>({enabled:settings.soundEnabled,volume:settings.soundVolume,state:context?.state||(unavailable?'unavailable':'locked'),buffers:buffers.size,voices:voices.size,played:totalPlayed,lastEvent})};
}
const actionAudio=makeActionAudio();

const keys={left:false,right:false,up:false,down:false,slow:false};
const analog={moveX:0,moveY:0};
const player={x:520,y:0,vx:0,vy:0,facing:1,flying:false,grounded:false,anim:'idle',animTime:0,jumpTime:999,landTime:0,forceAnim:'',forceTime:0,visualScale:1,maxHp:1000,hp:1000,maxMana:300,mana:300,manaRegen:22,lastManaCost:0};
// Character timing uses the supplied Diệp Tu frames. No extra raster assets or skill renderers.
const ACTION_TIME={jump_prepare:.085,takeoff:.32,flight_stop:.13,land:.23,brake:.15,hand_seal:.64,hurt:.46,knockdown:.44,down_idle:.54,getup:.64,charge_recover:.24};
const motion={action:null,jumpBuffer:0,coyote:0,gait:0,lastFoot:-1,mode:'idle',lean:0,airTime:0,landingSpeed:0};
const reactionLocked=()=>!!motion.action&&['hurt','knockdown','down_idle','getup'].includes(motion.action.name);
const castLocked=()=>!!charge&&['windup','cast'].includes(charge.phase);
function startAction(name,extra={}){
 const old=motion.action;
 if(old?.name==='hand_seal')for(const q of fxInstances)if(q.follow==='hands'){q.follow=null;q.fx.stop();}
 motion.action={name,time:0,duration:ACTION_TIME[name],face:player.facing,...extra};
 if(!['jump_prepare','takeoff','flight_stop','land','hurt','knockdown','brake'].includes(name))player.vx=0;
 setAnim(name==='jump_prepare'?'jump_start':name==='takeoff'?'fly_up':name==='flight_stop'?'fall':name==='brake'?'land':name==='charge_recover'?'charge_raise':name,true);
}
function finishAction(){
 if(motion.action?.name==='hand_seal')for(const q of fxInstances)if(q.follow==='hands'){q.follow=null;q.fx.stop();}
 motion.action=null;
}
function resetMotion(){
 Object.assign(motion,{action:null,jumpBuffer:0,coyote:.10,gait:0,lastFoot:-1,mode:'idle',lean:0,airTime:0,landingSpeed:0});
 player.forceAnim='';player.forceTime=0;player.demo=null;
}
function launchJump(){
 finishAction();motion.jumpBuffer=0;motion.coyote=0;motion.airTime=0;
 player.vy=-355;player.grounded=false;player.jumpTime=0;
 setAnim('jump_start',true);fxDust('groundBurst',player.x,player.y,.57);
}
function updateAction(dt){
 const a=motion.action;if(!a)return;
 a.time+=dt;
 if(a.name==='knockdown'){
  // An airborne knockdown cannot become a floor pose before real contact.
  if(player.grounded){if(a.groundAt===undefined)a.groundAt=a.time;
   if(a.time>=Math.max(a.duration,a.groundAt+.19))startAction('down_idle');
  }
  return;
 }
 if(a.time<a.duration)return;
 if(a.name==='jump_prepare'){
  if(player.grounded||motion.coyote>0)launchJump();else finishAction();
 }else if(a.name==='down_idle')startAction('getup');
 else finishAction();
}
function landCharacter(speed){
 actionAudio.land(speed,geoMaterial(player.x,player.y),motion.action?.name==='knockdown');
 motion.landingSpeed=speed;motion.airTime=0;
 if(motion.jumpBuffer>0)motion.jumpBuffer=Math.max(motion.jumpBuffer,.15);
 if(motion.action?.name==='knockdown'){
  motion.action.groundAt=motion.action.time;player.vx*=.45;
 }else if(!charge&&!reactionLocked()&&motion.action?.name!=='hand_seal'){
  startAction('land',{duration:speed>440?.32:.23});
 }
 if(speed>85)fxDust('groundBurst',player.x,player.y,Math.min(1.85,.35+speed/430));
}
function canMove(){
 return !charge&&(!motion.action||['jump_prepare','takeoff','flight_stop','brake'].includes(motion.action.name));
}
function tryBufferedJump(){
 if(motion.jumpBuffer<=0||player.flying||charge||reactionLocked())return;
 const a=motion.action;
 if(a&&!(a.name==='land'&&a.time>=.10)&&a.name!=='brake')return;
 if(player.grounded){
  if(a?.name==='land')launchJump();
  else{motion.jumpBuffer=0;startAction('jump_prepare');}
 }
 else if(motion.coyote>0)launchJump();
}
function selectPlayerAnimation(dt,dx,axis,slow){
 const a=motion.action;
 let mode;
 if(charge){mode=charge.phase==='cast'?'cast_fire':charge.phase==='hold'?'charge_hold':'charge_raise';}
 else if(a){mode=a.name==='jump_prepare'?'jump_start':a.name==='takeoff'?'fly_up':a.name==='flight_stop'?'fall':a.name==='brake'?'land':a.name==='charge_recover'?'charge_raise':a.name;}
 else if(player.flying){mode=player.vy<-45?'fly_up':'hover';}
 else if(!player.grounded){mode=player.jumpTime<.105&&player.vy<0?'jump_start':player.vy<0?'jump_air':'fall';}
 else if(Math.abs(dx)>.025){
  const fast=!slow&&Math.abs(player.vx)>(player.anim==='run'?105:124);
  mode=fast?'run':'walk';
 }else mode='idle';
 setAnim(mode);player.animTime+=dt;
 motion.mode=charge?(charge.phase==='cast'?'cast':'charge'):a?.name||
  (player.flying?(player.vy<-45?'fly_up':player.vy>45?'fly_down':Math.abs(player.vx)>20?'fly_move':'hover'):
  (axis&&player.vx*axis<0?'turn':mode));
 if(mode==='walk'||mode==='run'){
  const stride=mode==='run'?74:43;
  const before=Math.floor(motion.gait/4);motion.gait+=Math.abs(dx)/stride*8;
  const after=Math.floor(motion.gait/4);
  if(after!==before&&player.grounded){
   fxDust('footsteps',player.x-player.facing*5,player.y,mode==='run'?1.02:.52);
   actionAudio.footstep(player.vx,geoMaterial(player.x,player.y));
   motion.lastFoot=after;
  }
 }else if(mode==='idle'){motion.gait=0;motion.lastFoot=-1;}
 // Different source sheets contain different painted heights (199 / 226 / 218 px).
 // Normalize the art itself so the body does not inflate when fly_up changes to hover.
 player.visualScale=mode==='fly_up'?1.10:mode==='hover'?.97:1;
 // A slight bank on flight and braking, always relaxed before hand-anchored effects.
 const desiredLean=charge||a||!player.flying?0:clamp(player.vx*player.facing/181,-1,1)*.065;
 motion.lean+=(desiredLean-motion.lean)*(1-Math.exp(-dt*12));
}
function playerPose(){
 let id=player.anim,f=0,anchor=238;
 const clip=clipMap[id]||clipMap.idle,a=motion.action;
 if(charge){
  if(charge.phase==='cast')f=Math.min(11,Math.floor(charge.castTime*CAST_FRAME_RATE));
  else if(charge.phase==='hold')f=Math.floor(player.animTime*10)%4;
  else f=chargeFrame();
 }else if(a){
  const u=clamp(a.time/a.duration,0,.99999);
  switch(a.name){
   case 'jump_prepare':id='jump_start';f=0;break;
   case 'takeoff':id='fly_up';f=Math.min(5,Math.floor(u*6));break;
   case 'flight_stop':id='fall';f=Math.min(2,Math.floor(u*3));break;
   case 'brake':id='land';f=a.time<.065?1:2;break;
   case 'land':id='land';f=u<.18?0:u<.68?1:2;break;
   case 'hand_seal':id='hand_seal';f=Math.min(7,Math.floor(u*8));break;
   case 'hurt':id='hurt';f=[1,2,3,3,4,5,6,7][Math.min(7,Math.floor(u*8))];break;
   case 'knockdown':id='knockdown';f=a.groundAt===undefined?Math.min(4,Math.floor(a.time*16)):
    Math.min(7,5+Math.floor((a.time-a.groundAt)/.065));break;
   case 'down_idle':id='knockdown';f=7;break;
   case 'getup':{
    const frames=[['knockdown',7],['getup',0],['getup',0],['getup',1],['getup',2],['getup',3],['getup',4],['getup',5],['getup',6],['getup',7]];
    [id,f]=frames[Math.min(9,Math.floor(u*10))];break;
   }
   case 'charge_recover':id='charge_raise';f=Math.max(0,Math.round(a.fromFrame*(1-u)));break;
  }
 }else if(id==='walk'||id==='run')f=Math.floor(motion.gait)%8;
 else if(id==='jump_start')f=player.jumpTime<.05?1:2;
 else if(id==='jump_air'){
  // The old jump_air sheet cuts off the crown at y=0. These original airborne poses retain the full hair.
  id='fall';f=[0,2,4][Math.min(2,Math.floor(Math.max(0,player.jumpTime-.105)/.085))];
 }
 else if(id==='fly_up')f=[2,3,4,5,4,3][Math.floor(player.animTime*12)%6];
 else {const rate=id==='idle'?10:id==='hover'?12:16;f=Math.floor(player.animTime*rate);f=clip.loop?f%clip.frames:Math.min(f,clip.frames-1);}
 // The jump frames contain internal upward offsets. Feet follow physics, not two jumps at once.
 if(id==='jump_start')anchor=[238,234,221][f];
 if(id==='jump_air')anchor=[213,200,210][f];
 if(id==='fall')anchor=[233,233,234,234,233,233,233,233][f];
 return {id,f,anchor};
}

// PK Loạn Chiến 0.1.30 — Both fighters use EXACT decoded frames from one WebP atlas.
// The frames are cropped only through transparent margins; source pixels are untouched.
const CODE_NPC_STATES=CLIPS.map(([id])=>id);
const CODE_NPC_NAMES={idle:'ĐỨNG',walk:'ĐI BỘ',run:'CHẠY',jump_start:'LẤY ĐÀ',jump_air:'NHẢY',fall:'RƠI',land:'TIẾP ĐẤT',hand_seal:'KẾT ẤN',hurt:'TRÚNG ĐÒN',knockdown:'NGÃ',down_idle:'NẰM',getup:'ĐỨNG DẬY',fly_up:'CẤT CÁNH',hover:'LƠ LỬNG',charge_raise:'GIƠ TAY',charge_hold:'TỤ LỰC',cast_fire:'PHÓNG HỎA CẦU'};
const NPC_FRAME_RATE={idle:10,walk:11,run:16,jump_start:8,jump_air:9,fall:13,land:8,hand_seal:10,hurt:13,knockdown:11,down_idle:8,getup:10,fly_up:11,hover:12,charge_raise:12,charge_hold:8,cast_fire:14};
function cycleCodeNpc(){
 if(!game.running||dummy.broken)return;
 dummy.demoIndex=(dummy.demoIndex+1)%CODE_NPC_STATES.length;
 dummy.demoAction=CODE_NPC_STATES[dummy.demoIndex];
 dummy.demoTimer=2.5;
 dummy.demoElapsed=0;
 const label='NPC GỐC: '+CODE_NPC_NAMES[dummy.demoAction];
 const btn=document.querySelector('[data-demo="npc"]');
 if(btn)btn.textContent=label;
 showNotice('Diệp Tu WEBP · '+CODE_NPC_NAMES[dummy.demoAction]+' · phím N: chuyển 17 động tác');
}
function atlasAnchor(id,f){
 if(id==='jump_start')return [238,234,221][f]||238;
 if(id==='jump_air')return [213,200,210][f]||238;
 if(id==='fall')return [233,233,234,234,233,233,233,233][f]||238;
 return 238;
}
// Shared draw path for hero and NPC, preserving all original frame dimensions and anchors.
const SPRITE_TEXTURE_SIZE=128;
// v0.1.31: 17 compressed source strips, no large atlas.
// World frame remains 256 × 256; each displayed source frame is 128 × 128.
// All original animation frames/anchors preserved in world coordinates.
function drawAtlasFrame(id,f,scale,anchor){
 const clip=clipMap[id]||clipMap.idle;
 const img=game.images[clip.id];
 if(!img)return false;
 const frame=Math.max(0,Math.min(clip.frames-1,f|0));
 ctx.drawImage(img,frame*SPRITE_TEXTURE_SIZE,0,SPRITE_TEXTURE_SIZE,SPRITE_TEXTURE_SIZE,
  -128*scale,-anchor*scale,256*scale,256*scale);
 return true;
}
function codeNpcPose(){
 const name=dummy.broken?'knockdown':dummy.demoTimer>0?dummy.demoAction:dummy.recoil>0?'hurt':dummy.patrol?'walk':'idle';
 const clip=clipMap[name]||clipMap.idle;
 const elapsed=dummy.demoTimer>0?dummy.demoElapsed:game.elapsed;
 const rate=NPC_FRAME_RATE[name]||10;
 let f=Math.floor(elapsed*rate);
 if(dummy.broken)f=7;
 else if(dummy.recoil>0&&dummy.demoTimer<=0)f=Math.min(7,Math.floor((.42-dummy.recoil)*17));
 else f=clip.loop?f%clip.frames:Math.min(f,clip.frames-1);
 let lift=0;
 if(name==='jump_air')lift=-33*Math.sin(Math.PI*Math.min(1,dummy.demoElapsed/2.5));
 else if(name==='fly_up'||name==='hover')lift=-13-4*Math.sin(game.elapsed*2.8);
 else if(name==='fall')lift=-18*(1-Math.min(1,dummy.demoElapsed/2.5));
 return {name,f,lift,anchor:atlasAnchor(name,f)};
}
function drawCodeNpcRig(){
 if(!game.images.idle)return false;
 const p=codeNpcPose();
 ctx.save();ctx.imageSmoothingEnabled=false;
 ctx.translate(0,p.lift);
 if(dummy.patrol&&dummy.patrolDir<0)ctx.scale(-1,1);
 if(dummy.shake>0)ctx.translate(Math.sin(game.elapsed*58)*Math.min(4,dummy.shake*11),0);
 const ok=drawAtlasFrame(p.name,p.f,CHAR_SCALE,p.anchor);
 ctx.restore();return ok;
}

const camera={x:520,y:300};
// Training target: static game object, rendered with the real PixelFX Painter.
const dummy={x:660,y:0,vy:0,maxHp:1000,hp:1000,flash:0,shake:0,damageTimer:0,lastDamage:100,respawn:0,broken:false,burn:0,burnTick:0,burnPower:0,recoil:0,demoIndex:0,demoAction:"idle",demoElapsed:0,demoTimer:0,patrol:false,patrolDir:1,patrolAnchor:660};
function resetDummy(avoidPlayer=false){
 dummy.x=660;dummy.y=terrain.firstSolidY(dummy.x)-.5;
 if(avoidPlayer&&Math.abs(player.x-dummy.x)<HERO_HALF+NPC_HALF+6&&player.y>dummy.y-NPC_HEIGHT&&player.y-HERO_HEIGHT<dummy.y){
  const spots=[780,540,850,470];
  for(const testX of spots){const testY=terrain.firstSolidY(testX)-.5;
   if(Math.abs(player.x-testX)>HERO_HALF+NPC_HALF+6||player.y<=testY-NPC_HEIGHT||player.y-HERO_HEIGHT>=testY){dummy.x=testX;dummy.y=testY;break;}
  }
 }
dummy.vy=0;dummy.patrolDir=1;dummy.patrolAnchor=dummy.x;dummy.hp=dummy.maxHp;dummy.flash=0;dummy.shake=0;dummy.damageTimer=0;dummy.lastDamage=100;dummy.respawn=0;dummy.broken=false;dummy.burn=0;dummy.burnTick=0;dummy.burnPower=0;dummy.recoil=0;dummy.demoTimer=0;dummy.demoElapsed=0;}
function updateDummy(dt){
 dummy.flash=Math.max(0,dummy.flash-dt);dummy.shake=Math.max(0,dummy.shake-dt);
 dummy.damageTimer=Math.max(0,dummy.damageTimer-dt);dummy.recoil=Math.max(0,dummy.recoil-dt);if(dummy.demoTimer>0){dummy.demoTimer=Math.max(0,dummy.demoTimer-dt);dummy.demoElapsed+=dt;}
 if(dummy.broken){dummy.burn=0;dummy.burnTick=0;dummy.burnPower=0;dummy.respawn-=dt;if(dummy.respawn<=0){resetDummy(true);}return;}
 if(dummy.patrol&&dummy.demoTimer<=0){
  // Optional moving target for verifying homing; never crosses the player or terrain.
  const left=Math.max(65,dummy.patrolAnchor-45),right=Math.min(WORLD_W-65,dummy.patrolAnchor+340);
  const proposed=dummy.x+dummy.patrolDir*116*dt;
  if(proposed<=left||proposed>=right){dummy.patrolDir*=-1;}
  else{
   const foot=terrain.firstSolidY(proposed)-.5;
   const intersectsHero=Math.abs(proposed-player.x)<HERO_HALF+NPC_HALF+5 && player.y>foot-NPC_HEIGHT && player.y-HERO_HEIGHT<foot;
   if(intersectsHero||Math.abs(foot-dummy.y)>24||terrain.solid(proposed,foot-65)){dummy.patrolDir*=-1;}
   else{dummy.x=proposed;dummy.y=foot;dummy.vy=0;}
  }
 }
 if(dummy.burn>0){dummy.burn=Math.max(0,dummy.burn-dt);dummy.burnTick-=dt;if(dummy.burnTick<=0){dummy.burnTick=.22;dummyDamage(Math.round(10+18*dummy.burnPower),{notice:false,palette:['#562012','#b33918','#ff871d','#ffd35a','#fff0bf','#ffffff'],sparkX:dummy.x+Math.sin(game.elapsed*8)*12,sparkY:dummy.y-82+Math.cos(game.elapsed*10)*10});}
 }else dummy.burnPower=0;
 if(terrain.solid(dummy.x,dummy.y+3)){dummy.vy=0;return;}
 if(npcCanStandOnPlayer(dummy.x,dummy.y,dummy.y+1)){dummy.y=player.y-HERO_HEIGHT;dummy.vy=0;return;}
 dummy.vy=Math.min(640,dummy.vy+GRAVITY*dt);
 const n=Math.max(1,Math.ceil(Math.abs(dummy.vy)*dt/4)),dy=dummy.vy*dt/n;
 for(let i=0;i<n;i++){
  if(npcCanStandOnPlayer(dummy.x,dummy.y,dummy.y+dy)){dummy.y=player.y-HERO_HEIGHT;dummy.vy=0;break;}
  if(terrain.solid(dummy.x,dummy.y+dy+3)){dummy.y=Math.floor((dummy.y+dy+3)/CELL)*CELL-1;dummy.vy=0;break;}
  dummy.y+=dy;
 }
}
function dummyDamage(amount=100,opts={}){
 if(!game.running||dummy.broken)return false;
 const palette=opts.palette||['#352314','#80502c','#c58b4d','#e9ba71','#ffdf9c','#fff5d9','#ffffff'];
 dummy.hp=Math.max(0,dummy.hp-amount);dummy.flash=.20;dummy.recoil=.42;dummy.shake=Math.max(dummy.shake,.32);dummy.damageTimer=Math.max(dummy.damageTimer,.8);dummy.lastDamage=amount;
 fxEmit('hitSpark',opts.sparkX??(dummy.x+5),opts.sparkY??(dummy.y-78),{height:0,aim:player.facing>0?Math.PI:0,palette},null,'front');
 if(dummy.hp===0){dummy.broken=true;dummy.burn=0;dummy.burnTick=0;dummy.burnPower=0;dummy.respawn=3.0;fxDust('groundBurst',dummy.x,dummy.y-22,1.25,1);showNotice(opts.killNotice||'Diệp Tu ATLAS gục ngã · Tái xuất sau 3 giây');}
 else if(opts.notice!==false)showNotice((opts.noticeText||('Diệp Tu WEBP nhận '+amount+' sát thương'))+' · còn '+dummy.hp+'/'+dummy.maxHp+' HP');
 return true;
}
function igniteDummy(power=.5){
 if(!game.running||dummy.broken)return;
 dummy.burn=Math.max(dummy.burn,1.6+1.6*power);dummy.burnTick=.20;dummy.burnPower=Math.max(dummy.burnPower,.38+.48*power);
 const active=fxInstances.find(v=>v.follow==='dummyBurn');
 if(active){active.fx.options.power=dummy.burnPower;active.dirty=true;}
 else fxEmit('originalFireTornado',dummy.x,dummy.y-8,{palette:FIREBALL_PALETTE,height:70},'dummyBurn','front',{ox:70,oy:143,scale:.95,opacity:.83});
}
function hitDummy(amount=100){return dummyDamage(amount,{noticeText:'Diệp Tu WEBP nhận '+amount+' sát thương'});}
function toggleNpcPatrol(){
 dummy.patrol=!dummy.patrol;dummy.patrolDir=1;dummy.patrolAnchor=dummy.x;
 const b=$('patrolBtn');if(b)b.textContent='NPC DI CHUYỂN: '+(dummy.patrol?'BẬT':'TẮT');
 showNotice(dummy.patrol?'NPC thử đang di chuyển · Hỏa Cầu bám mục tiêu với 70°/giây':'Đã dừng NPC di chuyển');
 return dummy.patrol;
}
function dummyHitTest(wx,wy){return !dummy.broken&&Math.abs(wx-dummy.x)<48&&wy>dummy.y-156&&wy<dummy.y+12;}
function drawDummy(){
 const px=dummy.x-camera.x+game.viewW/2,py=dummy.y-camera.y+game.viewH/2;
 if(px < -130||px>game.viewW+130||py < -170||py>game.viewH+220)return;
 ctx.save();ctx.translate(px,py);
 const ready=drawCodeNpcRig();
 const by=-144+Math.min(0,codeNpcPose().lift);
 ctx.textAlign='center';ctx.textBaseline='bottom';ctx.font='bold 11px system-ui,sans-serif';
 ctx.shadowColor='#06111a';ctx.shadowBlur=4;ctx.fillStyle='#c9f1ff';
 ctx.fillText('DIỆP TU · WEBP NHẸ',0,by-8);
 ctx.shadowBlur=0;ctx.fillStyle='#081521';ctx.fillRect(-57,by,114,10);
 ctx.fillStyle='#56292c';ctx.fillRect(-55,by+2,110,6);
 ctx.fillStyle=dummy.hp>300?'#85ce79':'#ed895c';ctx.fillRect(-55,by+2,110*dummy.hp/dummy.maxHp,6);
 ctx.strokeStyle='#e4be79';ctx.strokeRect(-57.5,by-.5,115,11);
 if(dummy.demoTimer>0){ctx.fillStyle='#d5eaff';ctx.font='bold 9px system-ui,sans-serif';ctx.fillText(CODE_NPC_NAMES[dummy.demoAction],0,by-25);}
 if(!ready){ctx.fillStyle='#bde4ef';ctx.font='10px system-ui,sans-serif';ctx.fillText('Đang tải hoạt ảnh...',0,-65);}
 if(dummy.flash>0){ctx.globalAlpha=Math.min(.6,dummy.flash*2.5);ctx.fillStyle='#fff0af';ctx.fillRect(-25,-111,50,100);ctx.globalAlpha=1;}
 if(dummy.damageTimer>0){ctx.globalAlpha=Math.min(1,dummy.damageTimer*1.7);ctx.fillStyle=dummy.burn>0?'#ffd56c':'#ffce83';ctx.font='bold 19px system-ui,sans-serif';ctx.fillText('-'+dummy.lastDamage,0,-103-(.8-dummy.damageTimer)*30);}
 ctx.restore();
}
let terrain,noticeTimer=0,statsTimer=0;
const FXLIMIT={high:24,medium:13,low:6,off:0};
const FX_PALETTE={
 1:['#4c3425','#8c6147','#c6a783'], // topsoil
 2:['#6c4d34','#b08960','#dfbd8d'], // clay/sediment
 3:['#414b53','#7f8589','#b8bec2'], // rock
 4:['#283540','#63757f','#9aaebb']  // deep bedrock
};
let fxInstances=[],fxSeed=0,footFrame=-1;
const CHARGE_SKILLS={fire:{label:'HỎA CẦU',palette:['#4a1712','#8a1f17','#c9281f','#f2561d','#ff8a2a','#ffc23d','#ffe26b','#fff3a6','#ffffff']}};
const CHARGE_ANGLES=[0,7,19,33,49,68,89,106];
const CHARGE_RAISE_TIME=.40;
const FIREBALL_PALETTE=['#4a1712','#8a1f17','#c9281f','#f2561d','#ff8a2a','#ffc23d','#ffe26b','#fff3a6','#ffffff'];
// Coordinates taken from the original hand-seal/raised-hand sprite frames.
const FIRE_CAST_HANDS=[[206,73],[200,80],[186,109],[161,142],[171,121],[164,105],[175,112],[190,131],[190,131],[176,139],[163,145],[151,151]];
const CAST_LAUNCH_FRAME=7,CAST_FRAME_RATE=20,CAST_DURATION=12/CAST_FRAME_RATE;
let charge=null,fireballs=[];
// v0.1.32 — reusable Auto Target Lock, world-space units (not screen px).
const AUTO_TARGET_RANGE=900;
const FIREBALL_WEAK_TURN_RATE=70*Math.PI/180; // maximum steering angle per second
const skillTargets={
 dummy:()=>!dummy.broken?{x:dummy.x,y:dummy.y-77}:null
};
function targetPosition(id){return id&&skillTargets[id]?skillTargets[id]():null;}
function targetDistanceFromPlayer(point){return Math.hypot(point.x-player.x,point.y-(player.y-67));}
function acquireSkillTarget(range=AUTO_TARGET_RANGE){
 let best=null,closest=range;
 for(const id of Object.keys(skillTargets)){
  const target=targetPosition(id);if(!target)continue;
  const distance=targetDistanceFromPlayer(target);
  if(distance<=closest){best=id;closest=distance;}
 }
 return best;
}
function updateChargeTarget(c){
 if(!c)return;
 let pos=targetPosition(c.targetId);
 if(!pos||targetDistanceFromPlayer(pos)>AUTO_TARGET_RANGE){c.targetId=acquireSkillTarget();pos=targetPosition(c.targetId);}
 // Preserve the casting animation facing once the projectile has launched.
 if(pos&&!c.fired&&Math.abs(pos.x-player.x)>3)player.facing=pos.x>=player.x?1:-1;
}
function lockedTargetForUI(){
 if(charge?.targetId&&targetPosition(charge.targetId)&&targetDistanceFromPlayer(targetPosition(charge.targetId))<=AUTO_TARGET_RANGE)return charge.targetId;
 for(const f of fireballs)if(f.targetId&&targetPosition(f.targetId)&&targetDistanceFromPlayer(targetPosition(f.targetId))<=AUTO_TARGET_RANGE)return f.targetId;
 return null;
}

const chargePower=c=>clamp(.24+Math.max(0,(c?.time||0)-CHARGE_RAISE_TIME)/.95,.24,1.28);
function chargeFrame(){
 if(!charge)return 0;
 if(charge.phase==='hold'||charge.phase==='cast')return 7;
 if(charge.phase==='windup'){
  const f=clamp(charge.windupTime/Math.max(.001,charge.windupDuration),0,1);
  return Math.round(charge.windupFrom+(7-charge.windupFrom)*f);
 }
 return Math.min(7,Math.floor(charge.time/CHARGE_RAISE_TIME*8));
}
function chargeHand(){
 let sx,sy;
 if(charge?.phase==='cast'){
  const frame=Math.min(11,Math.floor(charge.castTime*CAST_FRAME_RATE));
  [sx,sy]=FIRE_CAST_HANDS[frame];
 }else{
  const a=CHARGE_ANGLES[chargeFrame()]*Math.PI/180;
  sx=150-Math.cos(a)+58*Math.sin(a);
  sy=87+Math.sin(a)+58*Math.cos(a);
 }
 const sc=CHAR_SCALE*player.visualScale;
 return {x:player.x+player.facing*(sx-128)*sc,y:player.y-(238-sy)*sc};
}
// The magical orb floats well clear of Diệp Tu's sprite; only the small spell charge stays near the fist.
// Clamping the orb outside the actor's silhouette also avoids covering the face at full charge.
function fireOrbPoint(c=charge){
 const power=c?.power||chargePower(c),phase=c?.phase;
 const grown=Math.max(.24,Math.min(1.28,power));
 const castPush=phase==='cast'?8*Math.max(0,Math.min(1,(c.castTime||0)*CAST_FRAME_RATE/CAST_LAUNCH_FRAME)):0;
 return {x:player.x+player.facing*(112+29*grown+castPush),y:player.y-84-3*grown};
}
function stopChargeHandFx(){for(const q of fxInstances)if(q.follow==='charge'||q.follow==='chargeFlame'){q.follow=null;q.fx.stop();}}
function stopChargeFx(){for(const q of fxInstances)if(q.follow==='charge'||q.follow==='chargeFlame'||q.follow==='chargeBody'){q.follow=null;q.fx.stop();}}
function abortCharge(recover=false){
 if(!charge)return;
 const fromFrame=charge.phase==='cast'?0:chargeFrame();
 document.querySelectorAll('[data-charge]').forEach(b=>b.classList.remove('charging'));
 charge=null;stopChargeFx();
 if(recover&&fromFrame>0&&!reactionLocked())startAction('charge_recover',{fromFrame,duration:.10+fromFrame*.02});
}
function beginCharge(kind='fire',pointerId=null){
 if(!game.running||!CHARGE_SKILLS[kind]||charge||reactionLocked()||(motion.action&&!['brake','flight_stop'].includes(motion.action.name)))return false;
 if(player.mana<23){showNotice('Không đủ linh lực');return false;}
 finishAction();motion.jumpBuffer=0;player.vx=0;motion.lean=0;
 const targetId=acquireSkillTarget();const target=targetPosition(targetId);
 if(target&&Math.abs(target.x-player.x)>3)player.facing=target.x>=player.x?1:-1;
 charge={kind,pointerId,targetId,time:0,phase:'raise',windupTime:0,windupDuration:.1,windupFrom:0,castTime:0,bodyFxStarted:false,handFxStarted:false,fired:false,power:.24};
 document.querySelectorAll('[data-charge]').forEach(b=>b.classList.toggle('charging',b.dataset.charge===kind));
 setAnim('charge_raise',true);return true;
}
function beginChargeFx(c){
 if(!c.bodyFxStarted){fxEmit('originalFireTornado',player.x,player.y-4,{palette:FIREBALL_PALETTE,height:76},'chargeBody','back',{ox:70,oy:143,scale:.90,opacity:.7});c.bodyFxStarted=true;}
}
function beginHandChargeFx(c){
 if(c.handFxStarted)return;
 const h=chargeHand(),f=fireOrbPoint(c),sk=CHARGE_SKILLS[c.kind];
 // Spell-charge is an original PixelFX module. It stays compact behind the character.
 fxEmit('originalSpellCharge',h.x,h.y,{palette:sk.palette},'charge','back',{ox:95,oy:68,scale:.46,opacity:.64});
 // The original PixelFX Fireball becomes the held orb and is REUSED as the flying projectile.
 fxEmit('originalFireball',f.x,f.y,{palette:FIREBALL_PALETTE,radius:6,speed:50},'chargeFlame','front',{ox:151,oy:49,scale:.67,opacity:.99,mirror:player.facing<0});
 c.handFxStarted=true;
}
function endCharge(cancel=false){
 if(!charge||charge.phase==='windup'||charge.phase==='cast')return;
 if(cancel){abortCharge(true);return;}
 const c=charge;
 const power=chargePower(c),manaCost=Math.round(16+30*power);
 if(player.mana<manaCost){showNotice('Không đủ linh lực');abortCharge(true);return;}
 c.manaCost=manaCost;
 document.querySelectorAll('[data-charge]').forEach(b=>b.classList.remove('charging'));
 c.power=power;c.windupFrom=chargeFrame();c.windupTime=0;
 c.windupDuration=(7-c.windupFrom)*.035;
 c.castTime=0;c.fired=false;c.phase='windup';
 beginChargeFx(c);
 setAnim('charge_raise');
}
function spawnFireball(c){
 const hand=chargeHand(),focus=fireOrbPoint(c),power=c.power,radius=8+15*power;
 updateChargeTarget(c);
 const face=player.facing,sx=focus.x,sy=focus.y,target=targetPosition(c.targetId);
 const initialAngle=target?Math.atan2(target.y-sy,target.x-sx):(face>0?0:Math.PI);
 const flySpeed=290+235*power+player.vx*face*.18;
 const vx=Math.cos(initialAngle)*flySpeed,vy=Math.sin(initialAngle)*flySpeed;
 let fxRef=fxInstances.find(q=>q.follow==='chargeFlame');
 if(fxRef){
  fxRef.follow='projectile';fxRef.x=sx;fxRef.y=sy;fxRef.layer='front';fxRef.mirror=face<0;
  fxRef.fx.options.radius=5.5+11.5*power;fxRef.fx.options.speed=110+110*power;
  fxRef.renderScale=.64+power*.48;fxRef.opacity=1;fxRef.mirror=false;fxRef.rotation=initialAngle;fxRef.dirty=true;
 }else fxRef=fxEmit('originalFireball',sx,sy,{palette:FIREBALL_PALETTE,radius:5.5+11.5*power,speed:110+110*power},'projectile','front',{ox:151,oy:49,scale:.64+power*.48,rotation:initialAngle});
 // At touching distance, the held orb can already be beyond the solid character.
 // Trace the launch segment (hand -> orb) so a point-blank cast hits the NPC.
 const along=(dummy.x-player.x)*face,orbAlong=(sx-player.x)*face;
 const closeHit=!dummy.broken&&along>0&&along<=orbAlong+radius+NPC_HALF&&Math.abs((dummy.y-76)-sy)<78+radius;
 // Check the hand-to-orb launch segment so the extended casting pose cannot teleport
 // a projectile through a wall before its ordinary substep collision begins.
 let blocked=null;
 const traceSteps=Math.max(1,Math.ceil(Math.hypot(sx-hand.x,sy-hand.y)/7));
 for(let k=1;k<=traceSteps;k++){
  const t=k/traceSteps,x=hand.x+(sx-hand.x)*t,y=hand.y+(sy-hand.y)*t;
  if(fireballTouchesTerrain(x,y,Math.min(radius,8))){blocked={x,y};break;}
 }
 if(blocked){explodeFireball({x:sx,y:sy,power,radius,fxRef},blocked.x,blocked.y);}
 else if(closeHit){
  const impactX=dummy.x-face*(npcShape().half+Math.min(7,radius*.35));
  explodeFireball({x:sx,y:sy,power,radius,fxRef},impactX,sy);
 }else fireballs.push({x:sx,y:sy,vx,vy,speed:flySpeed,targetId:c.targetId||null,face,radius,power,life:Math.max(1.45+power*.22,(AUTO_TARGET_RANGE+120)/flySpeed+.65),fxRef});
 stopChargeHandFx();
 // Original PixelFX impact sparks accent the instant of the thrust, while the orb is now fully airborne.
 fxEmit('hitSpark',hand.x+face*10,hand.y,{height:0,aim:face>0?Math.PI:0,palette:['#4a1712','#c9281f','#f2561d','#ff9b38','#ffe26b','#fff3a6','#ffffff']},null,'front',{scale:.54,opacity:.82});
}
function fireballTouchesTerrain(x,y,r){return terrain.solid(x+r*.48,y)||terrain.solid(x-r*.48,y)||terrain.solid(x,y-r*.4)||terrain.solid(x,y+r*.4);}
function explodeFireball(fb,x,y){
 if(fb.fxRef){fb.fxRef.follow=null;fb.fxRef.fx.stop();}
 fxEmit('originalFireBlast',x,y,{palette:FIREBALL_PALETTE.slice(1),size:.76+.5*fb.power,stone:'#5a493c'},null,'front',{ox:150,oy:196,scale:.79+fb.power*.24});
 // Fire spread is the stock PixelFX fire/fire-ring recipe, not a custom geometric drawing.
 const impactGround=terrain.solid(x,y+Math.max(3,fb.radius*.5))||Math.abs(y-surfaceAt(x))<28;
 if(impactGround){
  fxEmit('originalFireRing',x,y+Math.min(15,fb.radius*.55),{palette:FIREBALL_PALETTE,reach:39+21*fb.power},null,'back',{ox:112,oy:92,scale:.48+fb.power*.13,opacity:.8});
 }
 const dx=Math.abs(dummy.x-x),dy=Math.abs((dummy.y-76)-y);
 if(!dummy.broken&&dx<58+fb.radius&&dy<78+fb.radius){
  dummyDamage(Math.round(95+95*fb.power),{notice:false,palette:['#6b1b0d','#cf3517','#ff8f2a','#ffd86b','#fff1bf','#ffffff']});igniteDummy(fb.power);
 }
}
function updateFireballs(dt){
 for(let i=fireballs.length-1;i>=0;i--){
  const fb=fireballs[i];fb.life-=dt;
  if(fb.life<=0){explodeFireball(fb,fb.x,fb.y);fireballs.splice(i,1);continue;}
  // 8 world-units per substep prevents tunneling at high projectile velocity.
  const speed=fb.speed||Math.hypot(fb.vx,fb.vy);
  const steps=Math.max(1,Math.ceil(speed*dt/8)),stepDt=dt/steps;
  let hit=false;
  for(let s=0;s<steps;s++){
   const candidate=targetPosition(fb.targetId);
   const target=candidate&&targetDistanceFromPlayer(candidate)<=AUTO_TARGET_RANGE?candidate:null;
   if(target){
    const desired=Math.atan2(target.y-fb.y,target.x-fb.x);
    const current=Math.atan2(fb.vy,fb.vx);
    // Shortest signed angular distance in [-PI, PI], capped to 70 degrees per second.
    const difference=Math.atan2(Math.sin(desired-current),Math.cos(desired-current));
    const next=current+clamp(difference,-FIREBALL_WEAK_TURN_RATE*stepDt,FIREBALL_WEAK_TURN_RATE*stepDt);
    fb.vx=Math.cos(next)*speed;fb.vy=Math.sin(next)*speed;
   }else fb.targetId=null; // Do not instantly retarget after loss/death.
   fb.x+=fb.vx*stepDt;fb.y+=fb.vy*stepDt;
   if(dummyHitTest(fb.x,fb.y)||fireballTouchesTerrain(fb.x,fb.y,fb.radius)){
    explodeFireball(fb,fb.x,fb.y);hit=true;break;
   }
  }
  if(hit){fireballs.splice(i,1);continue;}
  if(fb.x<-50||fb.x>WORLD_W+50||fb.y<-1600||fb.y>WORLD_H+120){if(fb.fxRef)fb.fxRef.fx.stop();fireballs.splice(i,1);continue;}
  if(fb.fxRef){fb.fxRef.x=fb.x;fb.fxRef.y=fb.y;fb.fxRef.rotation=Math.atan2(fb.vy,fb.vx);fb.fxRef.mirror=false;fb.fxRef.dirty=true;}
 }
}

const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const pfxFrame=(w=192,h=160)=>{const frame=PixelFX.createFrame(w,h);const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const context=canvas.getContext('2d');const image=context.createImageData(w,h);return {frame,canvas,context,image};};
function geoMaterial(x,y){if(!terrain)return 1;const c=Math.floor(x/CELL);for(let dy=0;dy<5*CELL;dy+=CELL){const t=terrain.get(c,Math.floor((y+dy)/CELL));if(t)return t;}return Math.max(1,Math.min(4,1+Math.floor((y-surfaceAt(x))/225)));}
function fxEmit(kind,x,y,opts={},follow=null,layer='front',visual={}){
 if(settings.fxQuality==='off'||!PixelFX[kind])return null;
 const limit=FXLIMIT[settings.fxQuality];if(fxInstances.length>=limit){const idx=fxInstances.findIndex(v=>v.follow===null);if(idx>=0)fxInstances.splice(idx,1);else return null;}
 const frameSize={originalFireball:[196,98],originalFireTornado:[140,170],originalFireBlast:[300,240],originalFireRing:[224,128],originalSpellCharge:[160,130],groundBurst:[224,160],hitSpark:[176,144]};
 const [w,h]=frameSize[kind]||[160,144];
 const ox=visual.ox??(w/2),oy=visual.oy??(h/2);const surface=pfxFrame(w,h);
 const fx=PixelFX.createFx(PixelFX[kind],{x:ox,y:oy,seed:++fxSeed,light:.74,...opts});
 const inst={fx,...surface,x,y,follow,layer,acc:0,dirty:true,originX:ox,originY:oy,renderScale:visual.scale||1,opacity:visual.opacity??1,mirror:!!visual.mirror,rotation:visual.rotation||0};
 fxInstances.push(inst);return inst;
}
function fxDust(kind,x,y,power=1,material=geoMaterial(x,y),side=player.facing){
 const palette=FX_PALETTE[material]||FX_PALETTE[1];const count=(kind==='footsteps'?10:22)*(settings.fxQuality==='low'?.5:settings.fxQuality==='medium'?.75:1);
 fxEmit(kind,x,y,{palette,power,side,count:Math.round(count)});
}
function fxUpdate(dt){if(!game.running)return;for(let i=fxInstances.length-1;i>=0;i--){const q=fxInstances[i];q.fx.update(dt);q.acc+=dt;if(q.fx.done()){fxInstances.splice(i,1);continue;}if(q.follow==='feet'){q.x=player.x;q.y=player.y-4;}if(q.follow==='hands'){q.x=player.x+player.facing*11;q.y=player.y-75;}if(q.follow==='charge'){const hand=chargeHand();q.x=hand.x;q.y=hand.y;q.renderScale=.42+Math.min(1.28,charge?.power||chargePower(charge))*.22;q.opacity=charge?.phase==='cast'?.45:.66;}if(q.follow==='chargeFlame'){const f=fireOrbPoint(charge),power=charge?.power||chargePower(charge);q.x=f.x;q.y=f.y;q.fx.options.radius=5.5+11.5*Math.min(1.28,power);q.renderScale=.64+Math.min(1.28,power)*.48;q.mirror=player.facing<0;q.layer='front';q.opacity=.99;}if(q.follow==='chargeBody'){q.x=player.x;q.y=player.y-4;q.opacity=.49+Math.min(1,charge?.power||chargePower(charge))*.27;}if(q.follow==='dummyBurn'){if(dummy.broken||dummy.burn<=0){q.follow=null;q.fx.stop();}else{q.x=dummy.x;q.y=dummy.y-8;q.opacity=.72+.24*dummy.burnPower;}}if(q.acc>=1/30){q.acc%=1/30;q.dirty=true;}}}
function fxDraw(layer){
 if(settings.fxQuality==='off')return;
 const wx0=camera.x-game.viewW/2,wy0=camera.y-game.viewH/2;
 ctx.save();ctx.imageSmoothingEnabled=false;
 for(const q of fxInstances){if(q.layer!==layer)continue;
  const px=q.x-wx0,py=q.y-wy0,sc=q.renderScale||1;
  if(px < -310*sc || px>game.viewW+310*sc || py < -290*sc || py>game.viewH+290*sc)continue;
  if(q.dirty){PixelFX.clearFrame(q.frame);q.fx.draw(q.frame);PixelFX.composite(q.frame,q.image.data,null,.82);q.context.putImageData(q.image,0,0);q.dirty=false;}
  ctx.save();ctx.translate(Math.round(px),Math.round(py));if(q.rotation)ctx.rotate(q.rotation);ctx.scale(q.mirror?-sc:sc,sc);ctx.globalAlpha=q.opacity??1;
  ctx.drawImage(q.canvas,-q.originX,-q.originY);ctx.restore();
 }
 ctx.restore();
}
function fxClear(){fxInstances=[];fxSeed=0;footFrame=-1;}
function fxTakeoff(){fxEmit('qiIgnite',player.x,player.y-4,{},null,'back');fxEmit('hoverQi',player.x,player.y-4,{},'feet','front');}
function fxFlightStop(){for(const q of fxInstances)if(q.follow==='feet')q.fx.stop();fxEmit('qiStop',player.x,player.y-4,{},null,'back');}
function fxSeal(){fxEmit('sealGather',player.x+player.facing*11,player.y-75,{},'hands');}
function fxHit(){fxEmit('hitSpark',player.x+player.facing*14,player.y-54,{height:0,aim:player.facing>0?Math.PI:0,palette:['#392b2d','#75413d','#bf6857','#e8a184','#ffe3bd','#fff0dc','#ffffff']});}
const testAction=(kind)=>{
 if(!game.running||reactionLocked())return false;
 if(!['seal','hurt','knockdown'].includes(kind))return false;
 if(kind==='seal'&&(charge||motion.action))return false;
 abortCharge();finishAction();motion.jumpBuffer=0;motion.coyote=0;
 if(kind==='seal'){startAction('hand_seal');fxSeal();}
 else if(kind==='hurt'){
  startAction('hurt');player.vx=-player.facing*82;fxHit();
 }else{
  if(player.flying){player.flying=false;fxFlightStop();setFlightUI();}
  startAction('knockdown');player.vx=-player.facing*140;
  player.vy=player.grounded?-125:Math.max(75,player.vy);player.grounded=false;fxHit();
 }
 return true;
};
function hash(a,b){let h=(Math.imul(a,374761393)+Math.imul(b,668265263))|0;h=Math.imul(h^(h>>>13),1274126177);return ((h^(h>>>16))>>>0)/4294967295;}
function surfaceAt(x){return 355+Math.sin(x/168)*14+Math.sin(x/61)*8+Math.sin(x/35)*2;}
class Terrain{
 constructor(){this.cols=Math.ceil(WORLD_W/CELL);this.rows=Math.ceil(WORLD_H/CELL);this.data=new Uint8Array(this.cols*this.rows);this.cache=new Map();this.broken=0;this.excavations=[];this.generate();this.baseData=this.data.slice();}
 index(c,r){return r*this.cols+c;}
 get(c,r){if(c<0||c>=this.cols||r>=this.rows)return 4;if(r<0)return 0;return this.data[this.index(c,r)];}
 getBase(c,r){if(c<0||c>=this.cols||r>=this.rows)return 4;if(r<0)return 0;return this.baseData[this.index(c,r)];}
 solid(x,y){return this.get(Math.floor(x/CELL),Math.floor(y/CELL))!==0;}
 generate(){const cave=[
 [780,900,145,84],[980,1010,145,92],[1460,670,160,88],[1640,760,135,82],
 [2190,1050,220,95],[2820,720,180,90],[3400,1130,245,105],[3970,770,188,102],
 [1040,1570,200,116],[2500,1680,220,112],[3890,1720,240,118]];
 for(let r=0;r<this.rows;r++)for(let c=0;c<this.cols;c++){
 const x=c*CELL+CELL/2,y=r*CELL+CELL/2,d=y-surfaceAt(x);let t=0;
 if(d>=0){t=d<45?1:d<190?2:d<700?3:4;
 for(const [cx,cy,rx,ry] of cave){const dx=(x-cx)/rx,dy=(y-cy)/ry;if(dx*dx+dy*dy<1){t=0;break;}}
 // Organic sub-surface fissures; terrain remains one solid mass outside cavities.
 if(d>290&&d<1650){const valley=Math.abs(Math.sin(x/91+y/59)*.78+Math.sin(x/147-y/74)*.38);if(valley<.032&&hash(c>>2,r>>2)>.48)t=0;}}
 this.data[this.index(c,r)]=t;}}
 firstSolidY(x){for(let y=275;y<WORLD_H;y+=CELL/2)if(this.solid(x,y))return Math.floor(y/CELL)*CELL;return WORLD_H-20;}
 chunkKey(cx,cy){return cx+','+cy;}
 invalidate(c,r){const cx=Math.floor(c/CHUNK),cy=Math.floor(r/CHUNK);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)this.cache.delete(this.chunkKey(cx+dx,cy+dy));}
 cut(wx,wy,radius){let removed=0;const minX=clamp(Math.floor((wx-radius-7)/CELL),0,this.cols-1),maxX=clamp(Math.floor((wx+radius+7)/CELL),0,this.cols-1);
 const minY=clamp(Math.floor((wy-radius-7)/CELL),0,this.rows-1),maxY=clamp(Math.floor((wy+radius+7)/CELL),0,this.rows-1);
 const invalidated=new Set();for(let r=minY;r<=maxY;r++)for(let c=minX;c<=maxX;c++){
 const t=this.get(c,r);if(!t)continue;
 const dx=c*CELL+5-wx,dy=r*CELL+5-wy,dist=Math.hypot(dx,dy);
 const jag=(hash(c,r)-.5)*CELL*1.7;
 if(dist<=radius+jag){this.data[this.index(c,r)]=0;removed++;
 const cx=Math.floor(c/CHUNK),cy=Math.floor(r/CHUNK);
 for(let uy=-1;uy<=1;uy++)for(let ux=-1;ux<=1;ux++)invalidated.add(this.chunkKey(cx+ux,cy+uy));}}
 for(const k of invalidated)this.cache.delete(k);
 if(removed>0)this.excavations.push({x:wx,y:wy,radius});
 this.broken+=removed;return removed;}
 renderChunk(cx,cy){
  const key=this.chunkKey(cx,cy);if(this.cache.has(key))return this.cache.get(key);
  const startC=cx*CHUNK,startR=cy*CHUNK,nc=Math.min(CHUNK,this.cols-startC),nr=Math.min(CHUNK,this.rows-startR);
  if(nc<=0||nr<=0)return null;
  const W=nc*CELL,H=nr*CELL,baseX=startC*CELL,baseY=startR*CELL;
  const off=document.createElement('canvas');off.width=W;off.height=H;
  const pen=off.getContext('2d');pen.imageSmoothingEnabled=false;
  const bitmap=pen.createImageData(W,H),pixels=bitmap.data;
  // Vật lý vẫn theo lưới 10 px; phần HIỂN THỊ là một bề mặt liên tục.
  const gridW=nc+4,gridH=nr+4,occupancy=new Uint8Array(gridW*gridH);
  const localCuts=this.excavations.filter(d=>d.x+d.radius+14>=baseX&&d.x-d.radius-14<=baseX+W&&d.y+d.radius+14>=baseY&&d.y-d.radius-14<=baseY+H);
  for(let gy=0;gy<gridH;gy++)for(let gx=0;gx<gridW;gx++)occupancy[gy*gridW+gx]=this.getBase(startC+gx-2,startR+gy-2)?1:0;
  const mix=(a,b,t)=>a+(b-a)*t;
  const sat=t=>Math.max(0,Math.min(1,t));
  const ease=t=>{t=sat(t);return t*t*(3-2*t)};
  const noise=(x,y,step)=>{
   const ax=Math.floor(x/step),ay=Math.floor(y/step),u=ease(x/step-ax),v=ease(y/step-ay);
   return mix(mix(hash(ax,ay),hash(ax+1,ay),u),mix(hash(ax,ay+1),hash(ax+1,ay+1),u),v);
  };
  // Palette của minh hoạ tiên hiệp: đất nâu ấm, trầm tích đất son, đá xám xanh.
  const pal=[[100,77,56],[143,106,73],[95,103,107],[60,73,83]];
  const geology=d=>{
   if(d<33)return [0,0,0];
   if(d<53)return [0,1,ease((d-33)/20)];
   if(d<170)return [1,1,0];
   if(d<214)return [1,2,ease((d-170)/44)];
   if(d<688)return [2,2,0];
   if(d<730)return [2,3,ease((d-688)/42)];
   return [3,3,0];
  };
  const xinfo=new Array(W),yinfo=new Array(H),surfaces=new Float32Array(W),bed=new Float32Array(W);
  for(let x=0;x<W;x++){
   const wx=baseX+x+.5,u=wx/CELL-.5,c0=Math.floor(u);
   xinfo[x]=[c0-startC+2,ease(u-c0),wx];
   surfaces[x]=surfaceAt(wx);
   bed[x]=Math.sin(wx/48)*3.5+Math.sin(wx/17)*1.2;
  }
  for(let y=0;y<H;y++){
   const wy=baseY+y+.5,u=wy/CELL-.5,r0=Math.floor(u);
   yinfo[y]=[r0-startR+2,ease(u-r0),wy];
  }
  for(let py=0;py<H;py++){
   const [gy,fy,wy]=yinfo[py],row0=gy*gridW,row1=(gy+1)*gridW;
   let j=py*W*4;
   for(let px=0;px<W;px++,j+=4){
    const [gx,fx,wx]=xinfo[px];
    const a=mix(occupancy[row0+gx],occupancy[row0+gx+1],fx);
    const b=mix(occupancy[row1+gx],occupancy[row1+gx+1],fx);
    let fill=mix(a,b,fy);
    const depth=wy-surfaces[px];
    if(depth<13)fill=sat((depth+.65)/1.3);
    if(fill<.35)continue;
    let cut=1,rimDist=1000;
    for(let k=0;k<localCuts.length;k++){
      const dig=localCuts[k],dx=wx-dig.x,dy=wy-dig.y;
      if(Math.abs(dx)>dig.radius+14||Math.abs(dy)>dig.radius+14)continue;
      const dist=Math.hypot(dx,dy);
      if(dist>dig.radius+14)continue;
      let distEdge=dist-dig.radius;
      if(Math.abs(distEdge)<9)distEdge+=(noise(wx,wy,27)-.5)*4.8+(noise(wx,wy,10)-.5)*1.5;
      const cutHere=sat((distEdge+.55)/1.1);
      if(cutHere<cut)cut=cutHere;
      if(distEdge>=0&&distEdge<rimDist)rimDist=distEdge;
      if(cut<=.001)break;
    }
    if(cut<.01)continue;
    // Viền chỉ anti-alias ~1 pixel, không làm loang màu đất hay nhoè hố đào.
    const alpha=sat((fill-.36)*5.8)*cut;
    if(alpha<.02)continue;
    const [m0,m1,t]=geology(depth+bed[px]*.25),p0=pal[m0],p1=pal[m1];
    const coarse=noise(wx,wy,38)-.5;
    const small=noise(wx,wy,7)-.5;
    const grain=hash(Math.floor(wx/2),Math.floor(wy/2));
    const fine=hash(Math.floor(wx),Math.floor(wy));
    // Chi tiết nhỏ và sắc nét thay cho nhiễu mịn/blur cũ.
    let light=coarse*16+small*15+(grain-.5)*17;
    if(fine>.955)light+=25;else if(fine<.085)light-=19;
    const wave=(depth+bed[px])/(m0===2?32:m0===3?39:23);
    const band=Math.abs(wave-Math.round(wave));
    if(band<.050){light+=(m0===1?11:-12)*(1-band/.050);}
    if(m0===1&&fine>.82&&grain<.34)light+=12;
    if(m0>=2){
      // Tinh thể đá có mặt sáng và đường nứt: hình khối nhỏ, không phải tile vuông.
      const vein=Math.sin(wx*.115+wy*.047+coarse*3.2);
      if(vein>.985&&small>.18)light+=17;
      if(vein<-.987&&grain<.30)light-=15;
    }
    // Bóng đổ viền hố: khắc sâu rõ, không kéo bóng mờ lên toàn bộ nền.
    const edgeFromGrid=sat((.90-fill)*2.5);
    light-=edgeFromGrid*10;
    if(rimDist<12)light-=Math.max(0,1-rimDist/12)*26;
    if(rimDist<2.3)light+=7;
    let rr=mix(p0[0],p1[0],t)+light;
    let gg=mix(p0[1],p1[1],t)+light*.87;
    let bb=mix(p0[2],p1[2],t)+light*.72;
    if(depth>=-.8&&depth<2.8){
      const grass=(1-depth/3.4)*.45;
      rr=mix(rr,97,grass);gg=mix(gg,135,grass);bb=mix(bb,68,grass);
    }
    pixels[j]=Math.round(sat(rr/255)*255);
    pixels[j+1]=Math.round(sat(gg/255)*255);
    pixels[j+2]=Math.round(sat(bb/255)*255);
    pixels[j+3]=alpha>.96?255:Math.round(alpha*255);
   }
  }
  pen.putImageData(bitmap,0,0);
  // Họa tiết vẽ NÉT: sỏi, mạch trầm tích, vân nứt đá, rễ cỏ.
  // source-atop giữ mọi nét nằm trong đất thật; không vẽ đè lên hố đào.
  pen.save();pen.globalCompositeOperation='source-atop';pen.lineCap='round';pen.lineJoin='round';
  // Lớp trầm tích uốn theo địa hình, chạy liền qua các chunk.
  for(const d of [41,68,102,145,185,235,302,377,460,558,666,795,930,1100,1330,1590,1860,2150]){
   const worldY=surfaceAt(baseX+W/2)+d;
   if(worldY<baseY-40||worldY>baseY+H+40)continue;
   const rocky=d>=210;
   pen.beginPath();
   for(let x=0;x<=W+4;x+=4){
    const wx=baseX+x,yy=surfaceAt(wx)+d+Math.sin(wx/52+d*.085)*2.7+Math.sin(wx/19+d*.13)*.9-baseY;
    if(x===0)pen.moveTo(x,yy);else pen.lineTo(x,yy);
   }
   pen.strokeStyle=rocky?'rgba(21,30,39,.29)':'rgba(75,48,30,.22)';pen.lineWidth=rocky?1.1:1;pen.stroke();
   pen.translate(0,2);pen.strokeStyle=rocky?'rgba(173,188,198,.15)':'rgba(223,182,125,.17)';pen.lineWidth=.8;pen.stroke();pen.translate(0,-2);
  }
  const grid=34;
  for(let sy=Math.floor((baseY-26)/grid);sy<=Math.ceil((baseY+H+26)/grid);sy++){
   for(let sx=Math.floor((baseX-26)/grid);sx<=Math.ceil((baseX+W+26)/grid);sx++){
    const q=hash(sx*3,sy*7),wx=sx*grid+5+hash(sx+12,sy)*18,wy=sy*grid+4+hash(sx,sy+31)*19;
    const x=wx-baseX,y=wy-baseY,depth=wy-surfaceAt(wx);
    if(depth<8||q<(depth<190?.38:.59))continue;
    pen.save();pen.translate(Math.round(x),Math.round(y));
    if(depth<190){
     const rad=1+Math.floor(hash(sx+9,sy+1)*4);
     pen.fillStyle=q>.75?'rgba(212,178,128,.64)':'rgba(61,42,29,.34)';
     pen.beginPath();pen.moveTo(-rad,-1);pen.lineTo(0,-rad*.55);pen.lineTo(rad+1,0);pen.lineTo(rad*.5,rad*.65);pen.lineTo(-rad*.75,rad*.55);pen.closePath();pen.fill();
     if(rad>=3){pen.fillStyle='rgba(245,215,167,.43)';pen.fillRect(-rad+1,-1,rad,1)}
     if(q>.62){pen.strokeStyle='rgba(65,44,30,.30)';pen.lineWidth=1;pen.beginPath();pen.moveTo(-9,6);pen.lineTo(-4,5);pen.lineTo(0,7);pen.lineTo(5,6);pen.stroke();}
    }else{
     const ang=(hash(sx*17,sy*11)-.5)*1.2;
     pen.rotate(ang);
     pen.fillStyle=q>.63?'rgba(154,167,175,.23)':'rgba(15,22,30,.29)';
     pen.beginPath();pen.moveTo(-7,-3);pen.lineTo(-2,-5);pen.lineTo(7,-2);pen.lineTo(8,2);pen.lineTo(3,4);pen.lineTo(-7,2);pen.closePath();pen.fill();
     pen.strokeStyle='rgba(20,27,34,.40)';pen.lineWidth=1;
     pen.beginPath();pen.moveTo(-8,3);pen.lineTo(-3,1);pen.lineTo(3,3);pen.lineTo(9,1);pen.stroke();
     if(q>.66){pen.strokeStyle='rgba(180,195,204,.38)';pen.beginPath();pen.moveTo(-6,-3);pen.lineTo(0,-4);pen.lineTo(6,-2);pen.stroke();}
    }
    pen.restore();
   }
  }
  // Rễ cây nhỏ nhìn rõ trên đất mặt, không dùng hiệu ứng blur.
  for(let gx=Math.floor((baseX-12)/22);gx<=Math.ceil((baseX+W+12)/22);gx++){
   const wx=gx*22+Math.round(hash(gx,7)*13),wy=surfaceAt(wx)+2;
   if(wy<baseY-16||wy>baseY+H+16||hash(gx,3)<.27)continue;
   const rx=wx-baseX,ry=wy-baseY,len=5+Math.floor(hash(gx,17)*13);
   pen.strokeStyle='rgba(56,43,30,.57)';pen.lineWidth=1;
   pen.beginPath();pen.moveTo(rx,ry);pen.lineTo(rx-2,ry+len*.42);pen.lineTo(rx-1+hash(gx,10)*4,ry+len);pen.stroke();
  }
  pen.restore();
  // Cỏ/nhánh mảnh ngoài bề mặt (không mọc trong vùng đã phá).
  pen.save();pen.globalCompositeOperation='source-over';pen.lineWidth=1;pen.lineCap='round';
  for(let gx=Math.floor((baseX-8)/8);gx<=Math.ceil((baseX+W+8)/8);gx++){
   const wx=gx*8+Math.floor(hash(gx,9)*4),wy=surfaceAt(wx);
   if(wy<baseY-7||wy>baseY+H+7)continue;
   if(hash(gx,19)<.48)continue;
   if(localCuts.some(d=>Math.hypot(wx-d.x,wy-d.y)<d.radius+4))continue;
   const localX=wx-baseX,localY=wy-baseY,len=1+Math.floor(hash(gx,11)*4);
   pen.strokeStyle=hash(gx,32)>.5?'rgba(117,151,81,.92)':'rgba(78,116,59,.88)';
   pen.beginPath();pen.moveTo(localX,localY+1);pen.lineTo(localX+(hash(gx,16)>.5?1:-1),localY-len);pen.stroke();
  }
  pen.restore();
  this.cache.set(key,off);return off;
 }
 draw(ctx,left,top,w,h){const leftCol=clamp(Math.floor(left/(CELL*CHUNK)),0,Math.ceil(this.cols/CHUNK)-1),rightCol=clamp(Math.floor((left+w)/(CELL*CHUNK)),0,Math.ceil(this.cols/CHUNK)-1);
 const startRow=clamp(Math.floor(top/(CELL*CHUNK)),0,Math.ceil(this.rows/CHUNK)-1),endRow=clamp(Math.floor((top+h)/(CELL*CHUNK)),0,Math.ceil(this.rows/CHUNK)-1);
 for(let cy=startRow;cy<=endRow;cy++)for(let cx=leftCol;cx<=rightCol;cx++){
 const img=this.renderChunk(cx,cy);if(img)ctx.drawImage(img,cx*CHUNK*CELL,cy*CHUNK*CELL);}
 }
}
function resetWorld(){actionAudio.stopAll();setInput(false);resetMotion();fireballs=[];terrain=new Terrain();fxClear();resetDummy();dummy.patrol=false;const patrolBtn=$('patrolBtn');if(patrolBtn)patrolBtn.textContent='NPC DI CHUYỂN: TẮT';player.x=520;player.y=terrain.firstSolidY(player.x)-.5;player.vx=0;player.vy=0;player.flying=false;player.grounded=true;player.anim='idle';player.animTime=0;player.jumpTime=999;player.landTime=0;player.forceAnim='';player.forceTime=0;player.visualScale=1;player.facing=1;player.hp=player.maxHp;player.mana=player.maxMana;player.lastManaCost=0;camera.x=player.x;camera.y=player.y-26;setFlightUI();updateVitals();}
function updateVitals(){const hpRatio=clamp(player.hp/player.maxHp,0,1),mpRatio=clamp(player.mana/player.maxMana,0,1);const hpFill=$('hpFill'),mpFill=$('mpFill');if(hpFill)hpFill.style.width=(hpRatio*100).toFixed(1)+'%';if(mpFill)mpFill.style.width=(mpRatio*100).toFixed(1)+'%';const hpText=$('hpText'),mpText=$('mpText');if(hpText)hpText.textContent=Math.round(player.hp)+' / '+player.maxHp;if(mpText)mpText.textContent=Math.round(player.mana)+' / '+player.maxMana;}
function spendMana(amount){if(player.mana<amount){showNotice('Không đủ linh lực');return false;}player.mana=Math.max(0,player.mana-amount);player.lastManaCost=amount;updateVitals();return true;}
function showNotice(message){$('notice').textContent=message;$('notice').classList.remove('hidden');noticeTimer=2.1;}
function loadImage(key,path){return new Promise((resolve)=>{const img=new Image();img.decoding='async';img.onload=()=>{game.images[key]=img;resolve(true)};img.onerror=()=>{console.warn('Asset failed',key);resolve(false)};img.src=import.meta.env.BASE_URL+path;});}
async function preload(){const names=Object.keys(sourceAssets);let n=0,errors=[];for(const k of names){const ok=await loadImage(k,sourceAssets[k]);if(!ok)errors.push(k);n++;$('loadStatus').textContent=`Đã tải ${n}/${names.length} tài nguyên`;}game.ready=CLIPS.every(([id,n])=>!!game.images[id]&&game.images[id].naturalWidth===n*SPRITE_TEXTURE_SIZE);$('startBtn').disabled=!game.ready;$('loadStatus').textContent=!game.ready?'Lỗi tải nhân vật Diệp Tu. Hãy mở lại bản HTML offline.':errors.length?`Tải thiếu ${errors.length} tài nguyên: ${errors.join(', ')}`:'Sẵn sàng · Auto Target 900 · truy đuổi nhẹ';}
function setMenu(which){actionAudio.stopAll();game.menu=which;$('overlay').classList.remove('hidden');$('menu').classList.toggle('hidden',which!=='menu');$('settings').classList.toggle('hidden',which!=='settings');$('about').classList.toggle('hidden',which!=='about');game.running=false;setInput(false);$('controls').classList.add('hidden');$('fxDemo')?.classList.add('hidden');$('hud').classList.add('hidden');$('vitals').classList.add('hidden');$('hint').classList.add('hidden');$('startBtn').textContent=game.started?'Tiếp tục':'Bắt đầu';$('restartBtn').classList.toggle('hidden',!game.started);}
function play(){if(!game.ready){showNotice('Tài nguyên đang được tải');return}actionAudio.unlock();if(!game.started){resetWorld();game.started=true;}
 game.acc=0;game.running=true;$('overlay').classList.add('hidden');$('controls').classList.remove('hidden');$('hud').classList.remove('hidden');$('vitals').classList.remove('hidden');updateVitals();$('hint').classList.remove('hidden');game.last=0;setTimeout(()=>{$('hint').classList.add('hidden')},6200);}
function rotated(){return $('game').classList.contains('rotate-cw')?1:$('game').classList.contains('rotate-ccw')?-1:0;}
// Translate browser pointer movement back into the game's coordinate system if the page is virtually rotated.
function pointerDelta(x,y,cx,cy){const dx=x-cx,dy=y-cy,rot=rotated();return rot===1?{x:dy,y:-dx}:rot===-1?{x:-dy,y:dx}:{x:dx,y:dy};}
function setOrientation(mode,requestDevice=false){
 settings.orientation=mode==='portrait'?'portrait':'landscape';setInput(false);
 const gameEl=$('game');const landscape=window.innerWidth>=window.innerHeight;const wantsLandscape=settings.orientation==='landscape';
 gameEl.classList.toggle('rotate-cw',!landscape&&wantsLandscape);
 gameEl.classList.toggle('rotate-ccw',landscape&&!wantsLandscape);
 $('orientationMode').value=settings.orientation;
 $('orientationBtn').textContent=wantsLandscape?'NGANG':'DỌC';
 $('orientationBtn').setAttribute('aria-label',`Đang ở chế độ ${wantsLandscape?'ngang':'dọc'}. Chạm để chuyển sang ${wantsLandscape?'dọc':'ngang'}`);
 // A content:// offline document generally cannot lock device orientation; CSS remains a reliable fallback.
 if(requestDevice&&screen.orientation&&typeof screen.orientation.lock==='function'){
  Promise.resolve().then(()=>screen.orientation.lock(wantsLandscape?'landscape':'portrait')).catch(()=>{});
 }
 requestAnimationFrame(resize);
}
function resize(){const box=$('game');const w=Math.max(1,box.clientWidth),h=Math.max(1,box.clientHeight),dpr=Math.min(window.devicePixelRatio||1,settings.quality==='high'?2:settings.quality==='medium'?1.5:1);
 game.viewW=w;game.viewH=h;game.dpr=dpr;canvas.style.width=w+'px';canvas.style.height=h+'px';canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.imageSmoothingEnabled=false;}
function setInput(v){abortCharge(true);motion.jumpBuffer=0;for(const k of Object.keys(keys))keys[k]=v;analog.moveX=analog.moveY=0;document.querySelectorAll('[data-key]').forEach(x=>x.classList.remove('pressed'));for(const id of ['moveJoystick']){const el=$(id);el.classList.remove('active');el._resetJoystick?.();}}
function attachJoystick(id,axisX,axisY){
 const el=$(id),thumb=el.querySelector('.joy-thumb');let pointer=null;
 function updatePointer(e){
  const r=el.getBoundingClientRect(),radius=el.offsetWidth*.33;const v=pointerDelta(e.clientX,e.clientY,r.left+r.width/2,r.top+r.height/2),dx=v.x,dy=v.y;const len=Math.hypot(dx,dy);const gain=Math.min(1,len/Math.max(radius,1));const nx=(len>0?dx/len:0)*gain,ny=(len>0?dy/len:0)*gain;
  const dead=.14;const remap=v=>Math.abs(v)<=dead?0:Math.sign(v)*((Math.abs(v)-dead)/(1-dead));
  analog[axisX]=remap(nx);analog[axisY]=remap(ny);
  thumb.style.left=`calc(50% + ${nx*radius}px)`;thumb.style.top=`calc(50% + ${ny*radius}px)`;
 }
 const reset=()=>{pointer=null;analog[axisX]=0;analog[axisY]=0;thumb.style.left='50%';thumb.style.top='50%';el.classList.remove('active')};el._resetJoystick=reset;
 el.addEventListener('pointerdown',e=>{if(!game.running||pointer!==null)return;e.preventDefault();pointer=e.pointerId;el.setPointerCapture?.(pointer);el.classList.add('active');updatePointer(e)});
 el.addEventListener('pointermove',e=>{if(e.pointerId===pointer){e.preventDefault();updatePointer(e)}});
 for(const name of ['pointerup','pointercancel','lostpointercapture'])el.addEventListener(name,e=>{if(e.pointerId===pointer){e.preventDefault();reset()}});
}

function toggleFlight(){
 if(!game.running||reactionLocked()||castLocked()||(motion.action&&!['takeoff','flight_stop','brake','land','charge_recover'].includes(motion.action.name)))return;
 abortCharge();finishAction();motion.jumpBuffer=0;motion.coyote=0;
 player.flying=!player.flying;player.jumpTime=999;
 if(player.flying){player.grounded=false;player.y-=3;player.vy=-95;startAction('takeoff');fxTakeoff();}
 else{fxFlightStop();player.vy=Math.max(45,player.vy);player.grounded=false;startAction('flight_stop');}
 setFlightUI();showNotice(player.flying?'Đang BAY: kéo vòng trái lên/xuống để thay độ cao':'Đã tắt BAY: Diệp Tu rơi tự do');
}
function setFlightUI(){$('flightBtn').classList.toggle('on',player.flying);$('flightBtn').textContent=player.flying?'RƠI':'BAY';$('moveCaption').textContent=player.flying?'TRÁI / PHẢI · LÊN / XUỐNG':'ĐI / CHẠY · ĐỘ CAO';}
function jump(){
 if(!game.running||player.flying||reactionLocked()||castLocked())return;
 if(charge){if(!player.grounded&&motion.coyote<=0)return;abortCharge();}
 motion.jumpBuffer=.16;tryBufferedJump();
}
function excavate(x=player.x,y=player.y+28,r=76){if(!game.running)return;const material=geoMaterial(x,y);const removed=terrain.cut(x,y,r);if(removed){player.grounded=false;fxDust('groundBurst',x,y,1.45,material);showNotice(`Địa hình đã bị phá: ${removed} ô · Hố tồn tại cho đến khi chơi lại`);}else showNotice('Vị trí này không có đất đá');}
function setAnim(anim,restart=false){if(player.anim!==anim||restart){player.anim=anim;player.animTime=0;player.visualScale=anim==='fly_up'?1.10:anim==='hover'?.97:1;}}
// v0.1.28: Shared world-space AABB contact bounds (feet are y=0).
// Keep the combat hit-test separate from physical blocking: pixel art includes hair/robes.
const HERO_HALF=17,HERO_HEIGHT=100,NPC_HALF=23,NPC_HEIGHT=113,CONTACT_EPS=.25;
function npcShape(){
 // A lying target is low and wide; the hitbox follows the demonstrated pose.
 const down=dummy.demoTimer>0&&dummy.demoAction==='knockdown';
 return {half:down?48:NPC_HALF,height:down?39:NPC_HEIGHT};
}
function npcEnabled(){return !dummy.broken;}
function npcWidthOverlap(x){return npcEnabled()&&Math.abs(x-dummy.x)<HERO_HALF+npcShape().half-CONTACT_EPS;}
function npcBodyOverlap(x,y){
 if(!npcWidthOverlap(x))return false;
 const top=dummy.y-npcShape().height;
 return y>top+CONTACT_EPS&&y-HERO_HEIGHT<dummy.y-CONTACT_EPS;
}
function npcFeetSupport(x,y){
 return npcWidthOverlap(x)&&Math.abs(y-(dummy.y-npcShape().height))<1.25;
}
function npcLanding(x,previousFoot,nextFoot){
 if(!npcWidthOverlap(x))return false;
 const top=dummy.y-npcShape().height;
 return previousFoot<=top+CONTACT_EPS&&nextFoot>=top-CONTACT_EPS;
}
function npcHeadContact(x,previousHead,nextHead){
 return npcWidthOverlap(x)&&previousHead>=dummy.y-CONTACT_EPS&&nextHead<=dummy.y+CONTACT_EPS;
}
function npcCanStandOnPlayer(x,previousFoot,nextFoot){
 const top=player.y-HERO_HEIGHT;
 return npcEnabled()&&Math.abs(x-player.x)<HERO_HALF+npcShape().half-CONTACT_EPS&&previousFoot<=top+CONTACT_EPS&&nextFoot>=top-CONTACT_EPS;
}
const collideX=(x,y)=>terrain.solid(x-17,y-7)||terrain.solid(x+17,y-7)||terrain.solid(x-17,y-55)||terrain.solid(x+17,y-55)||terrain.solid(x-17,y-99)||terrain.solid(x+17,y-99);
function moveBody(dx,dy){
 // Substeps prevent tunneling at full running / flying speed and across low frame rates.
 const steps=Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))/5));
 const xstep=dx/steps,ystep=dy/steps;let landingSpeed=0;
 const terrainSupport=(x,y)=>terrain.solid(x-12,y+1)||terrain.solid(x+12,y+1)||terrain.solid(x,y+1);
 const support=(x,y)=>terrainSupport(x,y)||npcFeetSupport(x,y);
 for(let i=0;i<steps;i++){
  const wasGrounded=player.grounded,x=player.x+xstep;
  let nextX=player.x,nextY=player.y;
  if(x>19&&x<WORLD_W-19&&!collideX(x,nextY))nextX=x;
  else if(wasGrounded&&x>19&&x<WORLD_W-19){
   let stepped=false;
   for(let rise=2;rise<=20;rise+=2)if(!collideX(x,nextY-rise)){
    nextX=x;nextY-=rise;stepped=true;break;
   }
   if(!stepped)player.vx=0;
  }else player.vx=0;
  // Contact with NPC is never considered terrain a player may automatically step up.
  if(npcBodyOverlap(nextX,nextY)){
   if(xstep>0)nextX=Math.min(player.x,dummy.x-(HERO_HALF+npcShape().half));
   else if(xstep<0)nextX=Math.max(player.x,dummy.x+(HERO_HALF+npcShape().half));
   else nextX=player.x;
   // Do not teleport into terrain while trying to resolve character collision.
   if(collideX(nextX,player.y))nextX=player.x;
   nextY=player.y;
   player.vx=0;
  }
  player.x=nextX;player.y=nextY;
  // Preserve the original surface snapping, but also recognize an NPC's top as support.
  if(wasGrounded&&!player.flying&&ystep>=0&&!support(player.x,player.y)){
   let snap=0;for(let d=1;d<=20;d++)if(support(player.x,player.y+d)){snap=d;break;}
   if(snap){
    if(npcLanding(player.x,player.y,player.y+snap)&&!terrainSupport(player.x,player.y+snap))player.y=dummy.y-npcShape().height;
    else player.y=Math.floor((player.y+snap+1)/CELL)*CELL-1;
    player.vy=0;
   }else player.grounded=false;
  }
  const previousY=player.y,y=previousY+ystep;
  if(ystep>=0){
   if(npcLanding(player.x,previousY,y)){
    if(!player.grounded&&player.vy>85)landingSpeed=Math.max(landingSpeed,player.vy);
    player.y=dummy.y-npcShape().height;player.vy=0;player.grounded=true;
    if(player.flying){player.flying=false;fxFlightStop();setFlightUI();landingSpeed=Math.max(landingSpeed,90);}
   }else if(terrainSupport(player.x,y)){
    if(!player.grounded&&player.vy>85)landingSpeed=Math.max(landingSpeed,player.vy);
    player.y=Math.floor((y+1)/CELL)*CELL-1;player.vy=0;player.grounded=true;
    if(player.flying){player.flying=false;fxFlightStop();setFlightUI();landingSpeed=Math.max(landingSpeed,90);}
   }else{player.y=y;player.grounded=false;}
  }else if(npcHeadContact(player.x,previousY-HERO_HEIGHT,y-HERO_HEIGHT)){
   // Flying/jumping up into an NPC from below cannot tunnel through its feet.
   player.y=dummy.y+HERO_HEIGHT;player.vy=Math.max(0,player.vy);player.grounded=false;
  }else if(terrain.solid(player.x-12,y-100)||terrain.solid(player.x+12,y-100)||terrain.solid(player.x,y-100))player.vy=Math.max(0,player.vy);
  else{player.y=y;player.grounded=false;}
 }
 if(landingSpeed)landCharacter(landingSpeed);
 player.x=clamp(player.x,20,WORLD_W-20);player.y=clamp(player.y,-1400,WORLD_H-20);
}
function update(dt){if(!game.running)return;
 game.elapsed+=dt;statsTimer+=dt;
 motion.jumpBuffer=Math.max(0,motion.jumpBuffer-dt);
 motion.coyote=player.grounded?.10:Math.max(0,motion.coyote-dt);
 if(!player.grounded)motion.airTime+=dt;
 const launchedBefore=player.jumpTime;
 updateAction(dt);tryBufferedJump();
 const keyboardAxis=(keys.right?1:0)-(keys.left?1:0);
 const requestedAxis=keyboardAxis||analog.moveX;
 const axis=canMove()?requestedAxis:0;
 const isAnalog=!keyboardAxis&&Math.abs(analog.moveX)>.02;
 const slow=keys.slow||(isAnalog&&Math.abs(axis)<.67)||settings.speed<75;
 const magnitude=Math.abs(axis),moveFactor=isAnalog?(slow?Math.min(1,magnitude/.67):(.75+.25*magnitude)):magnitude;
 const speed=(slow?93:181)*(settings.speed/100);
 let targetV=Math.sign(axis)*moveFactor*speed;
 // Brake in the old facing direction, then change direction as the feet replant.
 const reversing=axis&&player.vx*axis<0&&Math.abs(player.vx)>30;
 if(reversing)targetV=0;
 if(axis&&!reversing&&!charge&&!reactionLocked())player.facing=axis>0?1:-1;
 const a=motion.action;
 let stiffness=player.grounded?17:player.flying?11:7;
 if(reversing||(!axis&&player.grounded))stiffness=25;
 if(a&&['hurt','knockdown'].includes(a.name))stiffness=player.grounded?9:2.6;
 if(a&&['down_idle','getup','hand_seal','charge_recover'].includes(a.name))player.vx=0;
 else player.vx+=(targetV-player.vx)*(1-Math.exp(-dt*stiffness));
 if(Math.abs(player.vx)<1&&!axis)player.vx=0;
 if(player.flying){
  const vertical=(keys.down?1:0)-(keys.up?1:0)||analog.moveY;
  const dir=charge||reactionLocked()||a?.name==='hand_seal'?0:vertical;
  const targetY=a?.name==='takeoff'?-115:dir*210;
  player.vy+=(targetY-player.vy)*(1-Math.exp(-dt*9));
  if(Math.abs(dir)<.02&&a?.name!=='takeoff')player.vy*=Math.exp(-4*dt);
 }else player.vy=Math.min(540,player.vy+GRAVITY*dt);
 // Preserve frame 1 for a whole tick when the anticipation finishes.
 if(!(launchedBefore>0&&player.jumpTime===0))player.jumpTime+=dt;
 if(player.mana<player.maxMana)player.mana=Math.min(player.maxMana,player.mana+player.manaRegen*dt);
 const previousX=player.x,wasMoving=['walk','run'].includes(player.anim);
 moveBody(player.vx*dt,player.vy*dt);
 if(!motion.action&&!charge&&player.grounded&&!axis&&wasMoving&&Math.abs(player.vx)<22)startAction('brake');
 if(charge){
  const c=charge;updateChargeTarget(c);
  if(c.phase==='raise'||c.phase==='hold'){
   c.time+=dt;c.power=chargePower(c);
   if(c.time>=.10)beginChargeFx(c);
   if(c.time>=.22)beginHandChargeFx(c);
   if(c.time>=CHARGE_RAISE_TIME)c.phase='hold';
  }else if(c.phase==='windup'){
   c.windupTime=Math.min(c.windupDuration,c.windupTime+dt);
   if(chargeFrame()>=4)beginHandChargeFx(c);
   if(c.windupTime>=c.windupDuration){c.phase='cast';c.castTime=0;setAnim('cast_fire',true);}
  }else if(c.phase==='cast'){
   c.castTime+=dt;
   if(!c.fired&&c.castTime>=CAST_LAUNCH_FRAME/CAST_FRAME_RATE){
    if(spendMana(c.manaCost)){c.fired=true;spawnFireball(c);}else abortCharge(true);
   }
   if(charge===c&&c.castTime>=CAST_DURATION){stopChargeFx();charge=null;}
  }
 }
 selectPlayerAnimation(dt,player.x-previousX,axis,slow);
 updateFireballs(dt);updateDummy(dt);fxUpdate(dt);
 // Camera follows both world axes; keep the hero lower on screen near the surface so the game does not stare too deep underground.
 const cx=player.x+player.vx*.24;
 const surfaceY=surfaceAt(player.x);
 const depthBelowSurface=player.y-surfaceY;
 const verticalLift=player.flying?90:(depthBelowSurface<120?128:92);
 let cy=player.y-verticalLift;
 if(depthBelowSurface<140){cy=Math.min(cy,surfaceY+54);}
 camera.x+=(cx-camera.x)*Math.min(1,dt*4.5);camera.y+=(cy-camera.y)*Math.min(1,dt*6.0);
 const max=game.viewW/(2*settings.zoom);camera.x=clamp(camera.x,Math.min(max,WORLD_W/2),Math.max(max,WORLD_W/2));
 camera.y=Math.round(clamp(camera.y,-1300,WORLD_H-160));
 camera.x=Math.round(camera.x*10)/10;
 if(noticeTimer>0){noticeTimer-=dt;if(noticeTimer<=0)$('notice').classList.add('hidden');}
 if(statsTimer>=.14){statsTimer=0;let depth=player.y-surfaceAt(player.x);$('pos').textContent=`X ${Math.round(player.x)} · ${depth<=0?'Cao':'Sâu'} ${Math.round(Math.abs(depth))}`;
 $('zone').textContent=depth<-180?'Không trung':depth<60?'Mặt đất':depth<200?'Địa tầng đất sét':depth<720?'Tầng đá':'Lòng đất sâu';
 $('fps').textContent=Math.round(game.fps)+' FPS';$('pos').style.display=settings.stats?'':'none';$('zone').style.display=settings.stats?'':'none';$('fps').style.display=settings.stats?'':'none';updateVitals();}
 }
function drawBackdrop(img,alpha,parallax){
 if(!img||alpha<=0)return;
 const w=game.viewW,h=game.viewH;
 ctx.save();ctx.globalAlpha=alpha;ctx.imageSmoothingEnabled=true;
 // v0.1.9: Make the background larger and calmer so motion looks smoother on mobile.
 const cover=Math.max(w/img.width,h/img.height);
 const scale=cover*1.62,dw=img.width*scale,dh=img.height*scale;
 const roomX=Math.max(0,(dw-w)/2);
 const calmParallax=parallax*.55;
 const shiftX=roomX>0?roomX*Math.tanh((camera.x-520)*calmParallax/Math.max(1,roomX)):0;
 const x=Math.round((w-dw)/2-shiftX);
 const y=Math.round((h-dh)/2);
 ctx.drawImage(img,x,y,Math.round(dw),Math.round(dh));
 ctx.restore();
}
function drawEnvironment(){const w=game.viewW,h=game.viewH;ctx.fillStyle='#152a42';ctx.fillRect(0,0,w,h);
 drawBackdrop(game.images.surface,1,.08);
 const skyAlpha=clamp((255-camera.y)/360,0,1);const caveAlpha=clamp((camera.y-430)/310,0,1);
 drawBackdrop(game.images.sky,skyAlpha,.12);drawBackdrop(game.images.cave,caveAlpha,.04);
 if(caveAlpha>0){ctx.fillStyle=`rgba(4,10,22,${.13*caveAlpha})`;ctx.fillRect(0,0,w,h)}
 // Atmospheric depth tint over the art only, not a solid ground layer.
}
function drawTerrain(){const w=game.viewW,h=game.viewH,z=settings.zoom,left=camera.x-w/(2*z),top=camera.y-h/(2*z);
 ctx.save();ctx.translate(-camera.x+w/2,-camera.y+h/2);ctx.imageSmoothingEnabled=false;
 terrain.draw(ctx,left,top,w/z,h/z);
 if(settings.geology){ctx.save();ctx.globalAlpha=.5;ctx.strokeStyle='#ffc987';ctx.lineWidth=1;for(let x=Math.floor(left/100)*100;x<left+w;x+=100){const sy=surfaceAt(x);ctx.beginPath();ctx.moveTo(x,sy);ctx.lineTo(x+100,surfaceAt(x+100));ctx.stroke();}ctx.restore();}
 ctx.restore();}
function drawTargetLock(){
 const id=lockedTargetForUI(),target=targetPosition(id);if(!target)return;
 const sx=target.x-camera.x+game.viewW/2,sy=target.y-camera.y+game.viewH/2;
 if(sx<-90||sx>game.viewW+90||sy<-90||sy>game.viewH+90)return;
 const r=34+Math.sin(game.elapsed*5)*1.5,edge=12;
 ctx.save();ctx.strokeStyle='#ff7166';ctx.lineWidth=2;ctx.globalAlpha=.91;
 // Four quiet corner brackets: a targeting marker, not a skill visual effect.
 for(let k=0;k<4;k++){
  ctx.save();ctx.translate(sx,sy);ctx.rotate(k*Math.PI/2);
  ctx.beginPath();ctx.moveTo(r-edge,-r);ctx.lineTo(r,-r);ctx.lineTo(r,-r+edge);ctx.stroke();ctx.restore();
 }
 ctx.textAlign='center';ctx.textBaseline='bottom';ctx.fillStyle='#ffd0bc';ctx.font='bold 10px system-ui,sans-serif';
 ctx.fillText('KHÓA · '+Math.round(targetDistanceFromPlayer(target))+' / '+AUTO_TARGET_RANGE,sx,sy-r-9);
 ctx.restore();
}
function drawPlayer(){
 const pose=playerPose();if(!game.images.idle)return;
 const px=player.x-camera.x+game.viewW/2,py=player.y-camera.y+game.viewH/2;
 ctx.save();ctx.translate(Math.round(px),Math.round(py));if(player.facing<0)ctx.scale(-1,1);
 ctx.rotate(motion.lean);ctx.imageSmoothingEnabled=false;
 drawAtlasFrame(pose.id,pose.f,CHAR_SCALE*player.visualScale,pose.anchor);
 ctx.restore();
}
function draw(){const w=game.viewW,h=game.viewH;if(!w||!h)return;
 ctx.setTransform(game.dpr,0,0,game.dpr,0,0);ctx.imageSmoothingEnabled=false;
 drawEnvironment();ctx.save();const z=settings.zoom;ctx.translate(w/2,h/2);ctx.scale(z,z);ctx.translate(-w/2,-h/2);if(terrain)drawTerrain();fxDraw('back');drawDummy();if(game.images.idle)drawPlayer();fxDraw('front');drawTargetLock();ctx.restore();
 if(game.running&&settings.geology){ctx.save();ctx.fillStyle='#f9e6ba';ctx.font='11px monospace';ctx.fillText(`Ô đất đã khoét: ${terrain.broken} · ${CELL}px/ô`,13,h-120);ctx.restore();}
}
function loop(now){if(!game.last)game.last=now;const elapsed=clamp((now-game.last)/1000,0,.05);game.last=now;game.frames++;game.fpsAcc+=elapsed;if(game.fpsAcc>.55){game.fps=game.frames/game.fpsAcc;game.fpsAcc=0;game.frames=0;}
 if(game.running){game.acc+=elapsed;let count=0;while(game.acc>=1/60&&count<4){update(1/60);game.acc-=1/60;count++;}}draw();requestAnimationFrame(loop);}
function bindInput(){
 window.addEventListener('pointerdown',()=>{if(game.running)actionAudio.unlock();},{passive:true});
 window.addEventListener('keydown',()=>{if(game.running)actionAudio.unlock();});
 attachJoystick('moveJoystick','moveX','moveY');document.querySelectorAll('[data-key]').forEach(button=>{
 const key=button.dataset.key;
 const press=e=>{e.preventDefault();if(!game.running)return;button.setPointerCapture?.(e.pointerId);button.classList.add('pressed');if(key==='jump')jump();else keys[key]=true;};
 const release=e=>{e.preventDefault();button.classList.remove('pressed');if(key!=='jump')keys[key]=false;};
 button.addEventListener('pointerdown',press);button.addEventListener('pointerup',release);button.addEventListener('pointercancel',release);button.addEventListener('lostpointercapture',release);});
 // BAY must respond to each finger independently: a secondary touch does not generate click.
 const flightButton=$('flightBtn');
 flightButton.addEventListener('pointerdown',e=>{
   if(!game.running || (e.pointerType==='mouse' && e.button!==0))return;
   e.preventDefault();
   flightButton.classList.add('pressed');
   toggleFlight();
 });
 const releaseFlight=()=>flightButton.classList.remove('pressed');
 for(const eventName of ['pointerup','pointercancel','lostpointercapture'])flightButton.addEventListener(eventName,releaseFlight);
 // Keyboard and screen-reader activation still work; pointer-generated clicks must not toggle twice (including touch clicks with detail=0).
 flightButton.addEventListener('click',e=>{if(e.detail===0 && !e.pointerType)toggleFlight();});
 $('digBtn').addEventListener('click',()=>excavate());
 document.querySelectorAll('[data-charge]').forEach(button=>{
   button.addEventListener('pointerdown',e=>{if(!game.running||(e.pointerType==='mouse'&&e.button!==0))return;e.preventDefault();if(beginCharge(button.dataset.charge,e.pointerId))button.setPointerCapture?.(e.pointerId);});
   button.addEventListener('pointerup',e=>{e.preventDefault();if(charge?.pointerId===e.pointerId)endCharge(false);});
   button.addEventListener('pointercancel',e=>{if(charge?.pointerId===e.pointerId)endCharge(true);});
   button.addEventListener('lostpointercapture',e=>{if(charge?.pointerId===e.pointerId)endCharge(true);});
   button.addEventListener('contextmenu',e=>e.preventDefault());
 });
 $('fxTestToggle').addEventListener('click',()=>{$('fxDemo')?.classList.toggle('hidden');});document.querySelectorAll('[data-demo]').forEach(b=>b.addEventListener('click',()=>b.dataset.demo==='dummy'?hitDummy(100):b.dataset.demo==='npc'?cycleCodeNpc():b.dataset.demo==='patrol'?toggleNpcPatrol():testAction(b.dataset.demo)));
 canvas.addEventListener('pointerdown',e=>{if(!game.running)return;const rect=canvas.getBoundingClientRect(),p=pointerDelta(e.clientX,e.clientY,rect.left+rect.width/2,rect.top+rect.height/2),wx=camera.x+p.x/settings.zoom,wy=camera.y+p.y/settings.zoom;
 if(dummyHitTest(wx,wy)){hitDummy(100);return;}if(terrain.solid(wx,wy))excavate(wx,wy,55);});
 const keymap={ArrowLeft:'left',KeyA:'left',ArrowRight:'right',KeyD:'right',ArrowUp:'up',KeyW:'up',ArrowDown:'down',KeyS:'down',ShiftLeft:'slow',ShiftRight:'slow'};
 window.addEventListener('keydown',e=>{const name=keymap[e.code];if(name){if(game.running){keys[name]=true;e.preventDefault();}return;}
 if(e.code==='Digit1'){e.preventDefault();if(!e.repeat)beginCharge('fire',e.code);return;}
 if(e.repeat)return;switch(e.code){case 'Space':e.preventDefault();jump();break;case 'KeyF':toggleFlight();break;case 'KeyX':case 'KeyT':excavate();break;case 'KeyC':testAction('seal');break;case 'KeyH':testAction('hurt');break;case 'KeyK':testAction('knockdown');break;case 'KeyN':cycleCodeNpc();break;case 'KeyJ':hitDummy(100);break;
 case 'Escape':if(game.running)setMenu('menu');else if(game.started)play();break;case 'KeyR':if(game.running){resetWorld();showNotice('Đã tạo lại toàn bộ địa hình');}break;}});
 window.addEventListener('keyup',e=>{const name=keymap[e.code];if(name)keys[name]=false;if(charge?.pointerId===e.code)endCharge(false);});
 document.querySelectorAll('.joystick').forEach(el=>el.addEventListener('contextmenu',e=>e.preventDefault()));
 window.addEventListener('blur',()=>{setInput(false);if(game.running)setMenu('menu');});document.addEventListener('visibilitychange',()=>{if(document.hidden){setInput(false);if(game.running)setMenu('menu');}});
}
function bindUI(){
 actionAudio.restore();
 $('soundEnabled').checked=settings.soundEnabled;$('soundVolume').value=settings.soundVolume;$('soundVolumeOut').textContent=settings.soundVolume+'%';
 $('soundEnabled').onchange=e=>actionAudio.change(e.target.checked,settings.soundVolume);
 $('soundVolume').oninput=e=>{actionAudio.change(settings.soundEnabled,e.target.value);$('soundVolumeOut').textContent=settings.soundVolume+'%';};
 $('startBtn').disabled=true;$('startBtn').onclick=play;$('restartBtn').onclick=()=>{resetWorld();game.started=true;play();showNotice('Đã tạo lại địa hình và đưa Diệp Tu về vị trí ban đầu');};$('pauseBtn').onclick=()=>setMenu('menu');$('settingsBtn').onclick=()=>setMenu('settings');$('aboutBtn').onclick=()=>setMenu('about');$('backSettings').onclick=()=>setMenu('menu');$('closeSettingsTop').onclick=()=>setMenu('menu');$('backAbout').onclick=()=>setMenu('menu');
 $('speedRange').oninput=e=>{settings.speed=Number(e.target.value);$('speedOut').textContent=settings.speed+'%'};
 /* Camera zoom fixed to 70% for the compact native-resolution sprites. */
 $('orientationBtn').onclick=()=>setOrientation(settings.orientation==='landscape'?'portrait':'landscape',true);
 $('orientationMode').onchange=e=>setOrientation(e.target.value,true);
 $('quality').onchange=e=>{settings.quality=e.target.value;resize()};$('statsToggle').onchange=e=>settings.stats=e.target.checked;
 $('geoToggle').onchange=e=>settings.geology=e.target.checked;
 $('fxQuality').onchange=e=>{const old=settings.fxQuality;settings.fxQuality=e.target.value;if(settings.fxQuality==='off')fxClear();else if(old==='off'&&player.flying)fxTakeoff();};
 $('joystickSize').onchange=e=>{$('game').classList.toggle('joy-small',e.target.value==='small');$('game').classList.toggle('joy-large',e.target.value==='large');};
 window.addEventListener('resize',()=>setOrientation(settings.orientation));window.addEventListener('orientationchange',()=>setTimeout(()=>setOrientation(settings.orientation),250));if(window.visualViewport)window.visualViewport.addEventListener('resize',()=>setOrientation(settings.orientation));}
window.PK_QA={spriteInfo:()=>({size:SPRITE_TEXTURE_SIZE,clips:CLIPS.length,frames:CLIPS.reduce((a,b)=>a+b[1],0),ready:game.ready,zoom:settings.zoom}),hitDummy:()=>hitDummy(100),snapshot:()=>({dummyHp:dummy.hp,dummyX:dummy.x,dummyY:dummy.y,npcHeight:npcShape().height,npcHalfWidth:npcShape().half,npcBodyOverlap:npcBodyOverlap(player.x,player.y),npcSupport:npcFeetSupport(player.x,player.y),dummyBroken:dummy.broken,dummyCodeAction:codeNpcPose().name,npcAtlasReady:!!game.images.idle&&game.images.idle.complete&&game.images.idle.naturalWidth>0,x:player.x,y:player.y,vx:player.vx,vy:player.vy,facing:player.facing,running:game.running,audio:actionAudio.status(),action:motion.action?{name:motion.action.name,time:motion.action.time}:null,motion:motion.mode,pose:playerPose(),jumpBuffer:motion.jumpBuffer,gait:motion.gait,visualScale:player.visualScale,cameraX:camera.x,cameraY:camera.y,flying:player.flying,grounded:player.grounded,anim:player.anim,fallFrame:player.anim==='fall'?Math.floor(player.animTime*20)%8:null,charge:charge?{kind:charge.kind,time:charge.time,phase:charge.phase,power:charge.power,orb:fireOrbPoint(charge),castFrame:charge.phase==='cast'?Math.floor(charge.castTime*20):null,fired:charge.fired}:null,hp:player.hp,mana:player.mana,fxCount:fxInstances.length,fxKinds:fxInstances.map(e=>e.fx.meta.name||'custom'),fireEffectPoints:fxInstances.filter(f=>['chargeFlame','projectile','charge'].includes(f.follow)).map(f=>({follow:f.follow,x:f.x,y:f.y,mirror:f.mirror,scale:f.renderScale})),targetLock:{range:AUTO_TARGET_RANGE,turnRateDeg:70,id:lockedTargetForUI(),chargeTarget:charge?.targetId||null},patrol:dummy.patrol,fireballs:fireballs.map(f=>({x:f.x,y:f.y,vx:f.vx,vy:f.vy,angle:Math.atan2(f.vy,f.vx),speed:f.speed,targetId:f.targetId,power:f.power})),dummyBurn:dummy.burn,broken:terrain?.broken,ready:game.ready,quality:settings.fxQuality,zoom:settings.zoom,orientation:settings.orientation,rotated:rotated(),viewW:game.viewW,viewH:game.viewH}),testAction,beginCharge,endCharge,abortCharge,toggleNpcPatrol,setNpcTestPosition:(x,y)=>{dummy.patrol=false;dummy.x=Math.max(70,Math.min(WORLD_W-70,Number(x)));dummy.y=Number.isFinite(y)?Number(y):terrain.firstSolidY(dummy.x)-.5;dummy.vy=0;return{x:dummy.x,y:dummy.y};},setNpcTestBroken:v=>{dummy.broken=!!v;if(!v){dummy.hp=dummy.maxHp;dummy.respawn=0;}return dummy.broken;}};
function init(){bindUI();bindInput();setOrientation(settings.orientation);resize();resetWorld();updateVitals();requestAnimationFrame(loop);preload();}
init();
})();

