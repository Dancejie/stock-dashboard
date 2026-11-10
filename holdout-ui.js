(function(root,factory){
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./holdout.js'));
  else root.StockHoldoutUI=factory(root.StockHoldout);
})(typeof globalThis!=='undefined'?globalThis:this,function(H){
  'use strict';
  const labels={hold:'买入持有',mr:'均值回归',ma:'双均线',turtle:'海龟突破',boll:'布林带',td:'TD 序列',grid:'网格',supertrend:'超级趋势',tsmom:'动量入场定仓',chandelier:'突破与吊灯止损'};
  function basePath(env){return new URL('.',env.location.href).pathname;}
  // The public site never asks for a Cowork identity or transmits local study settings.
  function sessionReader(env,publicMode){
    return async function session(){
      const now=typeof env.now==='function'?env.now():Date.now(),local=new Date(now).toISOString();
      const make=(scope,time,trusted)=>({scope,time:trusted?time:local,trusted});
      const trusted=(value,response)=>{
        const ms=Date.parse(value),age=response.headers.get('Age');
        return env.location.protocol==='https:'&&Number.isFinite(ms)&&Math.abs(ms-now)<=10*60*1000&&
          (age==null||(/^\d+$/.test(age)&&Number(age)<=90));
      };
      if(publicMode){
        const scope='public:'+basePath(env);
        try {
          const u=new URL('./index.html',env.location.href);u.searchParams.set('holdout_clock',String(now));
          const res=await env.fetch(u.href,{method:'HEAD',cache:'no-store',mode:'same-origin',credentials:'omit',redirect:'error'});
          const date=res.headers.get('Date');
          return make(scope,date,res.ok&&trusted(date,res));
        }catch(_){return make(scope,local,false);}
      }
      const res=await env.fetch(new URL('./api/session/me',env.location.href).href,{method:'GET',cache:'no-store',mode:'same-origin',credentials:'same-origin',redirect:'error'});
      if(!res.ok)throw new Error('登录身份未确认，不能读取或写入此账户的实验');
      const user=await res.json(),id=user&&user.userId;
      if((typeof id!=='string'&&typeof id!=='number')||!String(id).trim())throw new Error('无法识别登录工作区');
      const date=user.serverTime||res.headers.get('Date');
      return make('cowork:'+basePath(env)+':'+String(id),date,trusted(date,res));
    };
  }
  async function engineFingerprint(env){
    const sources=await Promise.all(['quant-core.js','holdout.js'].map(async name=>{
      const r=await env.fetch(new URL('./'+name,env.location.href).href,{method:'GET',cache:'no-store',mode:'same-origin',credentials:'same-origin',redirect:'error'});
      if(!r.ok)throw new Error('无法读取策略版本：'+name);
      const src=await r.text();if(src.length<100||/^\s*</.test(src))throw new Error('策略版本响应无效：'+name);
      return [name,await H.digest(src)];
    }));
    return H.digest(sources);
  }
  const pct=x=>(x>0?'+':'')+x.toFixed(2)+'%';
  function mount(host,opts={}){
    if(!host)return null;
    if(host.__finalHoldout)return host.__finalHoldout;
    const doc=host.ownerDocument,env=opts.env||doc.defaultView;
    const publicMode=opts.publicMode===true||(opts.publicMode==null&&Boolean(env.StockLocalWorkspace));
    host.innerHTML='<h3>最终留出验证</h3><p>先登记一个标的和一套参数，再在预定结束日后只揭盲一次。滚动验证和策略比较仍属于开发阶段。</p>'+
      '<details data-ho="setup"><summary>登记实验与查看结果</summary>'+
      '<p class="audit-note" data-ho="scope"></p><div class="audit-form">'+
      '<label>验证类型<select data-ho="mode"><option value="prospective">前瞻封存（窗口尚未开始）</option><option value="replay">历史回放（不能称为未见样本）</option></select></label>'+
      '<label>训练数据开始<input type="date" data-ho="trainStart"></label><label>训练截止日<input type="date" data-ho="cutoff"></label>'+
      '<label>留出开始<input type="date" data-ho="testStart"></label><label>留出结束<input type="date" data-ho="testEnd"></label>'+
      '<label>价格口径<select data-ho="adjust"><option value="qfq">前复权（训练历史修订会阻止揭盲）</option><option value="raw">不复权（不含分红及股数调整）</option></select></label>'+
      '<label>此前试过几套候选条件？<input type="number" min="0" max="1000000" step="1" data-ho="trials" placeholder="含在其他工具试过的配置"></label></div>'+
      '<button type="button" class="audit-button" data-ho="snapshot">读取当前股票、策略与执行设置</button><p data-ho="draft"></p>'+
      '<label><input type="checkbox" data-ho="ack"> 我已披露此前尝试次数；看过的历史不能称为未见样本。只登记这一套参数，不按留出收益换策略。</label><p>'+
      '<button type="button" class="audit-button" data-ho="seal">封存此配置</button> <button type="button" class="audit-button" data-ho="refresh">读取本机实验</button></p>'+
      '<p data-ho="status" role="status" aria-live="polite"></p><div data-ho="history"></div>'+
      '<p class="audit-note">此浏览器及站点本地保存，不跨设备。指纹用于防误改，不是第三方时间戳或不可篡改证明；清除站点数据会丢失记录。系统不能证明你没在别处查看行情或尝试其他参数。</p></details>';
    const el=k=>host.querySelector('[data-ho="'+k+'"]'),text=(k,v)=>{el(k).textContent=v;};
    text('scope',publicMode?'公开版：配置仅保存在本机浏览器，不登录、不上传。':'工作区版：记录按当前登录身份隔离，配置仅保存在本机浏览器。');
    let service,draft=null,state=null,busy=false,loaded=false;
    function err(e){text('status','未完成：'+(e&&e.message||e));}
    function snap(){
      try{
        const c=opts.getContext();
        if(!c||!labels[c.strategy]||!c.symbol)throw new Error('请先选择一只股票和单个策略，不支持“全部比较”');
        draft=JSON.parse(JSON.stringify(c));
        text('draft','待封存：'+(draft.name||draft.symbol)+' '+draft.symbol+' · '+labels[draft.strategy]+'；输入参数 '+JSON.stringify(draft.params||{})+'；执行设置 '+JSON.stringify(draft.executionOptions||{})+'。修改主面板后请重新读取。');
      }catch(e){draft=null;text('draft',e.message);}
    }
    function presets(){
      if(!state)return;
      const isForward=el('mode').value==='prospective';
      const cut=H.shift(state.today,isForward?-1:-366);
      el('cutoff').value=cut;el('trainStart').value=H.shift(cut,-730);
      el('testStart').value=isForward?H.shift(state.today,1):H.shift(cut,1);
      el('testEnd').value=isForward?H.shift(state.today,90):H.shift(state.today,-1);
    }
    function section(tag,value,parent){
      const node=doc.createElement(tag);if(value!==undefined)node.textContent=value;parent.appendChild(node);return node;
    }
    function render(){
      const target=el('history');target.replaceChildren();
      if(!state.rows.length){section('p','还没有封存记录。',target);return;}
      section('h4','全部记录（不按收益排名）',target);
      for(const row of state.rows.slice().reverse()){
        const p=row.plan,box=section('details',undefined,target),forward=p.mode==='prospective';
        section('summary','#'+p.trialNumber+' · '+(forward?'前瞻封存':'历史回放 · 非未见样本')+' · '+p.name+' '+labels[p.strategy]+' · '+(row.result?'已揭盲':'已封存'),box);
        section('p','封存 '+p.sealedAt+'；训练 '+p.trainStart+' → '+p.cutoff+'（实际 '+p.train.first+' → '+p.train.last+'，'+p.train.count+' 根）；留出 '+p.testStart+' → '+p.testEnd+'。',box);
        section('p','标的 '+p.symbol+'；口径 '+p.adjust+'；此前自报尝试 '+p.priorTrials+' 次；引擎 '+p.engineVersion+'。固定报告策略与同标的买入持有，均从相同现金起步、用相同费用。',box);
        section('p','冻结参数 '+JSON.stringify(p.params)+'；冻结执行参数 '+JSON.stringify(p.executionOptions),box);
        const details=section('details',undefined,box);section('summary','实验指纹与核验信息',details);
        const pre=section('pre',JSON.stringify({receipt:row.id,engine:p.engine,training:p.train.hash,result:row.resultHash||null},null,2),details);
        pre.style.whiteSpace='pre-wrap';pre.style.overflowWrap='anywhere';
        if(row.result){
          const v=row.result;
          section('p','已揭盲：'+v.first+' → '+v.last+'（'+v.days+' 个交易日），策略收益 '+pct(v.strategy.totalReturn)+'；扣费买入持有 '+pct(v.benchmark.totalReturn)+'；差额 '+v.excessPctPoints.toFixed(2)+' 个百分点。',box);
          section('p','最大回撤 '+v.strategy.maxDrawdown.toFixed(2)+'%；完整交易 '+v.strategy.tradeCount+' 次；期末持股 '+v.strategy.finalShares+' 股。没有已平仓交易时，收益可来自期末持仓估值。',box);
          section('p','结果已固定。一次留出结果不能证明策略有效。',box);
        }else if(state.completed<p.testEnd||(forward&&!state.trusted)){
          section('p',forward&&!state.trusted?'可信服务器时间不可用，不能揭盲。':'留出期尚未结束；没有请求留出行情，不显示中途收益。',box);
        }else{
          const btn=section('button','按原配置揭盲一次',box);btn.type='button';btn.className='audit-button';
          btn.addEventListener('click',()=>act(async()=>{await service.reveal(row.id);state=await service.list();render();text('status','已按原配置揭盲并保存完整结果。');}));
        }
      }
    }
    async function act(fn){
      if(busy)return;busy=true;
      try{for(const b of host.querySelectorAll('button'))b.disabled=true;await fn();}
      catch(e){err(e);}
      finally{busy=false;for(const b of host.querySelectorAll('button'))b.disabled=false;}
    }
    async function reload(initial=false){
      if(!service){
        const store=opts.store||H.indexedStore(env.indexedDB,(publicMode?'public:':'cowork:')+basePath(env));
        service=H.create({quant:opts.quant||env.StockQuant,store,getBars:opts.getBars,
          session:opts.session||sessionReader(env,publicMode),getEngineId:opts.getEngineId||(()=>engineFingerprint(env))});
      }
      state=await service.list();
      if(initial&&!loaded){if(!state.trusted)el('mode').value='replay';presets();snap();loaded=true;}
      render();text('status',state.trusted?'服务器日期（上海）：'+state.today+'。':'无法确认在线时间，只允许历史回放。');
    }
    el('setup').addEventListener('toggle',()=>{if(el('setup').open&&!loaded)act(()=>reload(true));});
    el('mode').addEventListener('change',presets);
    el('refresh').addEventListener('click',()=>act(()=>reload(!loaded)));el('snapshot').addEventListener('click',snap);
    el('seal').addEventListener('click',()=>act(async()=>{
      if(!draft)throw new Error('请读取当前股票与单个策略');
      if(!service||!state)throw new Error('请先读取本机实验');
      const raw=el('trials').value.trim();
      if(!/^\d+$/.test(raw))throw new Error('请填写真实的此前尝试次数（可以为 0）');
      const req=Object.assign({},draft,{priorTrials:Number(raw),acknowledged:el('ack').checked});
      for(const k of ['mode','trainStart','cutoff','testStart','testEnd','adjust'])req[k]=el(k).value;
      text('status','只读取训练区间并冻结参数。');
      const row=await service.seal(req);el('ack').checked=false;state=await service.list();render();
      text('status','已封存 #'+row.plan.trialNumber+'。参数不能修改；此时未请求留出行情。');
    }));
    const api={reload:()=>act(()=>reload(!loaded))};host.__finalHoldout=api;return api;
  }
  return {mount,sessionReader,engineFingerprint};
});
