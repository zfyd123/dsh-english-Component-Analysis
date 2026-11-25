/**
 * dsh-english-coach —— 客户端面板。
 *
 * 三种视图都由同一套引擎驱动，但诊断方式不同：
 *   ① 结构：LLM 给出的成分树（每段带中文），可点句子任意词看归属
 *   ② 标注：自己框选 + 选标签 → 批改出覆盖率/准确率与错法
 *   ③ 结果：逐段对错、漏标、归因与练法，附标准答案树
 *   ④ 画像：跨句累计的卡点分布
 *
 * 手写模块（无 JSX、无构建）：
 *   - React 从宿主模块表 require('react') 取，不打包第二份
 *   - 样式只用 --dsw-alias-* 主题变量，跟随明暗主题
 *   - 不 require 任何 Harness Client 包（官方明令禁止）
 *   - 语法/解析/判分全部走 Host 的 /api/dsh-en-coach/*
 */

window.__ModuleLoader__.load({
  id: 'dsh-english-coach',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const CLIENT_VERSION = 'v0.6-panel';
    const PANEL_ID = 'dsh-english-coach';
    const PANEL_ORDER = 26;
    const API = '/api/dsh-en-coach';
    const CONTENT_MAX = 1080;
    const RESTORE_KEY = 'dsh-english-coach:panel-state';

    /* ── 主题 ─────────────────────────────────────────────────────── */
    const T = {
      label1: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      label3: 'var(--dsw-alias-label-tertiary)',
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      bg3: 'var(--dsw-alias-bg-layer-3)',
      border: 'var(--dsw-alias-border-l2)',
      border3: 'var(--dsw-alias-border-l3)',
      accent: 'var(--dsw-alias-state-business-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)'
    };
    const mix = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

    /** 成分 → 配色（按成分名，不按层级） */
    const ROLE_COLOR = {
      主语: T.accent, 谓语: T.bad, 宾语: T.ok, 表语: T.ok, 定语: T.warn,
      状语: T.warn, 补语: T.warn, 连词: T.label2, 中心词: T.label2,
      主语从句: T.accent, 宾语从句: T.ok, 表语从句: T.ok,
      定语从句: T.warn, 状语从句: T.warn, 同位语从句: T.warn,
      插入语: T.label3, 其他: T.label3
    };
    const roleColor = (role) => spanColor(role);

    const LAYER_COLOR = { V: T.accent, S: T.bad, R: T.ok, L: T.warn, E: T.label2 };
    const LAYER_NAME = { V: '词汇', S: '句法', R: '指代', L: '逻辑', E: '表达' };

    /* ── 元素简写 ─────────────────────────────────────────────────── */
    const box = (style, ...kids) => h('div', { style }, ...kids);
    const text = (style, content) => h('span', { style }, content);

    const btn = (primary, textContent, onClick, extra) => h('button', {
      type: 'button',
      onClick,
      disabled: extra?.disabled,
      style: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        height: 30, padding: '0 12px', borderRadius: 6, cursor: extra?.disabled ? 'not-allowed' : 'pointer',
        fontSize: 13, font: 'inherit', whiteSpace: 'nowrap',
        opacity: extra?.disabled ? 0.5 : 1,
        border: '1px solid ' + (primary ? 'transparent' : T.border),
        background: primary ? T.accent : 'transparent',
        color: primary ? 'var(--dsw-alias-label-primary-foreground)' : T.label1
      }
    }, textContent);

    const inputStyle = {
      flex: 1, minWidth: 0, height: 34, padding: '0 10px', borderRadius: 6,
      border: '1px solid ' + T.border, background: T.bg2, color: T.label1,
      fontSize: 13, outline: 'none'
    };
    const cardStyle = { border: '1px solid ' + T.border, borderRadius: 8, background: T.bg1 };
    const small = { fontSize: 12, color: T.label3, lineHeight: '19px' };
    const body = { fontSize: 13, color: T.label2, lineHeight: '21px' };
    const tinyLabel = { fontSize: 11, letterSpacing: '0.08em', color: T.label3, textTransform: 'uppercase' };
    const sectionTitle = { fontSize: 12, fontWeight: 600, color: T.label2, marginBottom: 8 };

    /**
     * 成分配色：同一种成分永远同一颜色，扫一眼能看出句子骨架。
     * 色值沿用本工作区「阅读分析」页那套（六类各一色，其余中性灰）。
     */
    const SPAN_COLORS = {
      主语: '#3B6344', 谓语: '#B4552D', 宾语: '#4A5FA0', 表语: '#4A5FA0',
      定语: '#7A4B7A', 状语: '#2F7070', 补语: '#2F7070', 从句: '#9A6B2F', 其他: '#6E6558'
    };
    const spanColor = (role) => {
      const r = String(role || '');
      if (!r) return SPAN_COLORS.其他;
      if (r.endsWith('从句')) return SPAN_COLORS.从句;
      return SPAN_COLORS[r] || SPAN_COLORS.其他;
    };
    const tintOf = (hex, pct) => `color-mix(in srgb, ${hex} ${pct}%, transparent)`;

    /** 按坐标取最近的词：词间空隙、行末留白都能落到最近的词上 */
    function nearestIndexIn(root, x, y) {
      if (!root || typeof root.querySelectorAll !== 'function') return NaN;
      let best = NaN;
      let bestD = Infinity;
      root.querySelectorAll('[data-idx]').forEach((el) => {
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (!r) return;
        const d = Math.abs((r.left + r.right) / 2 - x) + Math.abs((r.top + r.bottom) / 2 - y) * 3;
        if (d < bestD) { bestD = d; best = Number(el.dataset.idx); }
      });
      return best;
    }

    /** 把面板里的调试打点写进 Host：浏览器控制台我读不到，落成文件我就能读 */
    const report = (event, data) => {
      try {
        fetch(API + '/trace', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event: String(event ?? ''), data: data ?? null })
        }).catch(() => { /* 上报失败无所谓 */ });
      } catch { /* 无 fetch 环境 */ }
    };
    const dbg = (...args) => {
      try { console.log('[en-coach]', ...args); } catch { /* 无控制台 */ }
      report(args[0], args.slice(1));
    };


    const ROLE_TAGS = ['主语', '谓语', '宾语', '表语', '定语', '状语', '补语', '连词',
      '定语从句', '状语从句', '宾语从句', '主语从句', '表语从句', '同位语从句'];

    /* ── API ────────────────────────────────────────────────────── */
    async function apiPost(path, payload) {
      const res = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {})
      });
      const json = await res.json().catch(() => null);
      if (!json) throw new Error(`请求失败 (${res.status})`);
      if (json.ok !== true && !json.code) throw new Error(json.error || `请求失败 (${res.status})`);
      return json;
    }
    async function apiGet(path) {
      const res = await fetch(API + path);
      const json = await res.json().catch(() => null);
      if (!json || json.ok !== true) throw new Error(json?.error || `请求失败 (${res.status})`);
      return json;
    }

    /* ── 错误卡片：渲染异常时显示它，而不是让整个面板变白 ──────────── */
    function ErrorCard({ error, context }) {
      const msg = String(error?.message ?? error ?? '未知错误');
      const stack = String(error?.stack ?? msg).slice(0, 1600);
      return box({
        padding: 16, borderRadius: 8,
        border: '1px solid ' + T.bad, background: mix(T.bad, 8)
      },
        box({ fontSize: 14, fontWeight: 600, color: T.bad, marginBottom: 6 }, '面板渲染出错了'),
        context ? box({ ...small, marginBottom: 4 }, `发生在：${context}`) : null,
        box({ ...body, marginBottom: 8 }, msg),
        box({ ...small, marginBottom: 8 }, '把下面这段发给我就能定位：'),
        h('pre', {
          style: {
            margin: 0, padding: 10, borderRadius: 6, overflowX: 'auto',
            background: T.bg2, border: '1px solid ' + T.border,
            fontSize: 11.5, lineHeight: '17px', color: T.label2, whiteSpace: 'pre-wrap'
          }
        }, stack)
      );
    }

    const ReactComponent = React.Component ?? class { };

    class Boundary extends ReactComponent {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error, info) {
        try {
          // eslint-disable-next-line no-console
          console.error('[dsh-english-coach] 渲染异常', error, info);
        } catch { /* 控制台不可用 */ }
      }

      render() {
        const err = this.state?.error;
        if (!err) return this.props?.children ?? null;
        return h(ErrorCard, { error: err });
      }
    }
    function SidebarIcon() {
      return h('svg', { viewBox: '0 0 20 20', width: 18, height: 18, 'aria-hidden': true, style: { display: 'block' } },
        h('path', { d: 'M4 5.5h5.2M4 10h8.4M4 14.5h4.2', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', fill: 'none' }),
        h('circle', { cx: 14.6, cy: 14.4, r: 2.1, stroke: 'currentColor', strokeWidth: 1.6, fill: 'none' }),
        h('path', { d: 'M16.2 16l1.6 1.6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' })
      );
    }

    /**
     * 从句前紧邻的名词短语。定语从句的先行词按语法就贴在引导词前面，
     * 比「在同级成分里往前找」可靠——后者会因为先行词被包进别的段而抓错（the harm 被包在 to the harm 里）。
     */
    function adjacentNoun(tokens, from) {
      const DET = /^(the|a|an|this|that|these|those|my|your|his|her|its|our|their|any|some|all|no|every|each)$/i;
      const STOP = /^(to|in|on|at|for|from|with|by|of|about|into|onto|over|under|forward|between|among|through|during|against|without|within|and|or|but|that|which|who|whom|whose|is|are|was|were|be|been|being|must|should|can|could|may|might|will|would|do|does|did)$/i;
      let i = from - 1;
      while (i >= 0 && /^[.,;:!?]$/.test(tokens[i])) i -= 1;
      if (i < 0) return null;
      let start = i;
      let j = i - 1;
      while (j >= 0 && !STOP.test(tokens[j]) && !/^[.,;:!?]$/.test(tokens[j])) {
        start = j;
        if (DET.test(tokens[j])) break;
        j -= 1;
      }
      return { start, end: i + 1, text: tokens.slice(start, i + 1).join(' ') };
    }

/* ── 修饰对象推断：定语/同位语修饰前面的名词，状语修饰同一层的谓语 ── */
    function modifierTarget(part, siblings, tokens) {
      const role = String(part.role || '');
      const list = siblings || [];
      const idx = list.indexOf(part);
      if (idx < 0) return null;
      const txt = (p) => tokens.slice(p.start, p.end).join(' ');
      if (/定语|同位语/.test(role)) {
        // 语法上先行词就贴在引导词前面，先从那里取
        const adj = adjacentNoun(tokens, part.start);
        if (adj) {
          // 如果这个名词恰好是同级某个名词性段的一部分，用那段完整文本（"the pleasure and stimulation" 而不是 "stimulation"）
          const host = list.find((s) => /主语|宾语|表语|中心词/.test(String(s.role || ''))
            && adj.start >= s.start && adj.end <= s.end);
          return host ? txt(host) : adj.text;
        }
        for (let i = idx - 1; i >= 0; i -= 1) {
          const s = list[i];
          if (/主语|宾语|表语|中心词/.test(String(s.role || ''))) return txt(s);
        }
        return null;
      }
      if (/状语/.test(role)) {
        const pred = list.find((s) => /谓语/.test(String(s.role || '')));
        if (pred) return txt(pred);
        return '整句';
      }
      return null;
    }

/* ── 按层级取一个色带颜色：越深越浅，代替层层 marginLeft ───────── */
    /** 从句括号按嵌套层级取色：第 1 层蓝、第 2 层紫、第 3 层琥珀… */
    const CLAUSE_DEPTH_COLORS = ['#4A5FA0', '#7A4B7A', '#9A6B2F', '#2F7070', '#B4552D'];
    const clauseColor = (depth) => CLAUSE_DEPTH_COLORS[depth % CLAUSE_DEPTH_COLORS.length];

    const DEPTH_BASE = '#6E6558';
    const depthTint = (depth) => tintOf(DEPTH_BASE, Math.max(14, 55 - depth * 8));

    /**
     * 语法点标签：从成分的文本与角色里认常见结构。
     * 纯规则、不调模型——认不准的宁可不标，标出来的都是高置信度的。
     */
    function grammarTags(part, tokens) {
      const role = String(part.role || '');
      const text = tokens.slice(part.start, part.end).join(' ');
      const tags = [];

      if (/从句/.test(role)) {
        if (/^(while|although|though|even though|whereas)\b/i.test(text)) tags.push('让步从句');
        else if (/^(because|since|as)\b/i.test(text)) tags.push('原因从句');
        else if (/^(if|unless)\b/i.test(text)) tags.push('条件从句');
        else if (/^(when|whenever|after|before|until|once)\b/i.test(text)) tags.push('时间从句');
        else if (/^(in|on|at|for|to|of|with|by|about|from)\s+which\b/i.test(text)) tags.push('介词＋关系代词 = where');
        else if (/^(which|who|whom|whose)\b/i.test(text)) tags.push('关系词 ' + text.split(' ')[0]);
        else if (/^that\b/i.test(text)) tags.push('关系词 that');
      }

      if (/主语/.test(role) && /^it\b/i.test(text)) tags.push('形式主语 it');
      if (/主语/.test(role) && /^to\s/i.test(text)) tags.push('不定式作主语');
      if (/状语/.test(role) && /^to\s/i.test(text)) tags.push('不定式作目的状语');

      if (/\b(is|are|was|were|be|been|being)\s+\w+(ed|en)\b/i.test(text)) tags.push('被动语态');
      if (/\b(in|on|at|for|from|by|of|about|with)\s+\w+ing\b/i.test(text)) tags.push('介词＋动名词');
      if (/neither\b[\s\S]*\bnor\b/i.test(text)) tags.push('neither…nor 并列否定');
      if (/not only\b[\s\S]*\bbut also\b/i.test(text)) tags.push('not only…but also');
      if (/\bboth\b[\s\S]*\band\b/i.test(text)) tags.push('both…and');

      const modal = text.match(/\b(should|must|can|could|may|might|would|will)\b/i);
      if (modal) tags.push('情态动词 ' + modal[1].toLowerCase());

      if (/定语/.test(role) && /^(in|on|at|for|with|from|around|by|of|about)\b/i.test(text)) tags.push('介词短语作后置定语');
      if (/\b(were to|should have|would have|could have)\b/i.test(text)) tags.push('虚拟语气');

      return [...new Set(tags)];
    }

    /** 形式主语：并列里既有主语 it，又有 to do 主语时，把关系点出来 */
    function formalSubjectHint(part, siblings, tokens) {
      if (!/主语/.test(String(part.role || ''))) return null;
      const txt = (p) => tokens.slice(p.start, p.end).join(' ');
      if (!/^to\s/i.test(txt(part))) return null;
      const dummy = (siblings || []).find((s) => /主语/.test(String(s.role || '')) && /^it$/i.test(txt(s)));
      return dummy ? '↑ 前面那个 it 是形式主语，真正的主语是这一段' : null;
    }

    /* ── 成分树卡片：主干重描边、从句降级、深层折叠、色带缩进 ────── */
    function PartCard({ part, tokens, num, depth, siblings }) {
      const role = String(part.role || '');
      const color = roleColor(role);
      const mod = modifierTarget(part, siblings, tokens);
      const kids = part.children || [];
      const formal = formalSubjectHint(part, siblings, tokens);
      // 主干（顶层谓语）用重描边；从句用细边 + 浅底，让「先看哪一层」由视觉决定
      // 主干：顶层的主语 / 谓语 / 宾语 / 表语（含形式主语后面的真主语）
      const isBackbone = depth === 0 && /主语|谓语|宾语|表语/.test(role);
      const isClause = /从句/.test(role);
      // 第三层起默认折叠：46 词的长句不该一屏半全摊开
      const [open, setOpen] = useState(depth <= 1);
      const showKids = kids.length && (depth <= 1 || open);

      return box({ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
        box({
          padding: isBackbone ? '7px 10px' : '5px 8px',
          borderRadius: 6,
          border: isBackbone ? `2px solid ${color}` : '1px solid ' + T.border,
          borderLeft: `3px solid ${color}`,
          background: isBackbone ? tintOf(color, 12) : (isClause ? T.bg2 : T.bg1)
        },
          box({ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
            num ? text({ fontSize: 10.5, color: T.label3, flex: '0 0 auto' }, '#' + num) : null,
            text({
              fontSize: 11, padding: '1px 6px', borderRadius: 4, flex: '0 0 auto',
              background: mix(color, 18), color,
              fontWeight: isBackbone ? 700 : 400
            }, part.role),
            box({
              flex: '1 1 200px', minWidth: 0,
              fontSize: isBackbone ? 14 : 13.5,
              fontWeight: isBackbone ? 600 : 400,
              lineHeight: '20px', wordBreak: 'break-word', color: T.label1
            }, tokens.slice(part.start, part.end).join(' ')),
            part.zh ? text({ fontSize: 12, color: T.label3, flex: '0 1 auto' }, part.zh) : null
          ),
          mod ? box({ ...small, marginTop: 2 }, `≈ 修饰「${mod}」`) : null,
          (() => {
            const tags = grammarTags(part, tokens);
            if (!tags.length) return null;
            return box({ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 },
              tags.map((t, i) => h('span', {
                key: i,
                style: {
                  fontSize: 10, lineHeight: '15px', padding: '0 5px', borderRadius: 3,
                  background: mix(T.accent, 14), color: T.accent, whiteSpace: 'nowrap'
                }
              }, t)));
          })(),
          formal ? box({ fontSize: 11.5, marginTop: 2, color: T.accent }, formal) : null,
          part.note ? box({ ...small, marginTop: 2 }, part.note) : null,
          kids.length && depth >= 2
            ? h('button', {
              type: 'button',
              onClick: () => setOpen((v) => !v),
              style: {
                marginTop: 4, padding: 0, border: 'none', background: 'transparent',
                cursor: 'pointer', font: 'inherit', fontSize: 11, color: T.label3
              }
            }, open ? '▾ 收起' : `▸ 展开 ${kids.length} 个子成分`)
            : null
        ),
        // 子成分：横向铺开；缩进用一条色带而不是层层 marginLeft，把宽度留给内容
        showKids
          ? box({
            display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'flex-start',
            paddingLeft: 10, borderLeft: `2px solid ${depthTint(depth + 1)}`
          }, kids.map((c, i) => h(PartCard, {
            key: i, part: c, tokens, num: (num ? num + '.' : '') + (i + 1), depth: depth + 1, siblings: kids
          })))
          : (kids.length ? null : null)
      );
    }

    
    /* ── 句子：顶层成分套外框，内部子成分用底色区分 ───────────────── */
    function SentenceParts({ tokens, parts, onPick }) {
      // 每个 token 的最终归属，以及它属于哪个「顶层」成分
      const info = new Array(tokens.length).fill(null);
      const walk = (arr, depth, top) => (arr || []).forEach((p) => {
        const t = top || p;
        for (let i = p.start; i < p.end; i += 1) {
          if (!info[i] || depth >= info[i].depth) info[i] = { role: p.role, depth, part: p, top: t };
        }
        if (p.children?.length) walk(p.children, depth + 1, t);
      });
      walk(parts || [], 0, null);

      // 从句边界：只关心「从句」，按嵌套深度给颜色——用来在句子上画方括号
      const clauseSpans = [];
      const collectClauses = (arr, depth) => (arr || []).forEach((p) => {
        if (/从句/.test(String(p.role || ''))) clauseSpans.push({ start: p.start, end: p.end, depth, role: p.role });
        if (p.children?.length) collectClauses(p.children, depth + 1);
      });
      collectClauses(parts || [], 0);
      // 同一位置可能同时开/闭多层括号：开按外层先，闭按内层先
      const opensAt = (i) => clauseSpans.filter((c) => c.start === i).sort((a, b) => a.depth - b.depth);
      const closesAt = (i) => clauseSpans.filter((c) => c.end === i + 1).sort((a, b) => b.depth - a.depth);

      // 先行词：定语从句修饰的那个名词。句子层最值得看的就是它，单独标出来
      const antecedent = new Set();
      const markAnt = (arr) => (arr || []).forEach((p) => {
        if (/定语/.test(String(p.role || ''))) {
          const target = modifierTarget(p, arr, tokens);
          if (target) {
            const hay = tokens.slice(0, p.start).join(' ');
            const at = hay.lastIndexOf(target);
            if (at >= 0) {
              const before = hay.slice(0, at).trim();
              const from = before ? before.split(/\s+/).length : 0;
              const to = from + target.trim().split(/\s+/).length;
              for (let k = from; k < to; k += 1) antecedent.add(k);
            }
          }
        }
        if (p.children?.length) markAnt(p.children);
      });
      markAnt(parts || []);

      // 按顶层成分分组
      const groups = [];
      tokens.forEach((t, i) => {
        const key = info[i] ? info[i].top : null;
        const last = groups[groups.length - 1];
        if (last && last.top === key) { last.idx.push(i); return; }
        groups.push({ top: key, idx: [i] });
      });

      return box({
        padding: '20px 14px 12px', borderRadius: 8, border: '1px solid ' + T.border, background: T.bg2,
        fontSize: 15.5, lineHeight: '34px'
      },
        groups.map((g, gi) => {
          const top = g.top;
          if (!top) {
            return h('span', { key: gi }, g.idx.map((i) => tokens[i] + ' ').join(''));
          }
          const c = roleColor(top.role);
          // 主干（主/谓/宾/表）用重描边与深底；状语从句等修饰成分轻一档
          const isBone = /主语|谓语|宾语|表语/.test(String(top.role || ''));
          const borderW = isBone ? 2 : 1;
          const bgPct = isBone ? 16 : 5;
          const tagBg = isBone ? c : tintOf(c, 60);
          // 外层：整段一个框；box-decoration-break: clone 让它在换行处也保持闭合
          return h('span', {
            key: gi,
            'data-top': gi,
            onClick: onPick ? (e) => {
              const el = e?.target?.closest?.('[data-tok]');
              const i = el ? Number(el.dataset.tok) : null;
              onPick((i != null && info[i]) ? info[i].part : top);
            } : undefined,
            style: {
              // 与「② 标注」页保持同一套视觉：圆角块 + 标签浮在上沿
              position: 'relative',
              display: 'inline-block',
              border: `${borderW}px solid ${isBone ? c : tintOf(c, 45)}`,
              borderRadius: 8,
              padding: '2px 7px',
              margin: '12px 5px 2px 0',
              background: tintOf(c, bgPct),
              lineHeight: '32px',
              verticalAlign: 'middle',
              cursor: onPick ? 'pointer' : 'default'
            }
          },
            h('span', {
              key: 'tag',
              style: {
                position: 'absolute', top: -9, left: 7,
                padding: '0 6px', borderRadius: 4,
                background: tagBg, color: '#FFF9F2',
                fontSize: isBone ? 10.5 : 10, lineHeight: '15px',
                fontWeight: isBone ? 700 : 500,
                whiteSpace: 'nowrap', pointerEvents: 'none'
              }
            }, top.role),
            h('span', { key: 'body', style: { fontFamily: 'Georgia, "Times New Roman", serif' } },
              g.idx.map((i, k) => {
                const inf = info[i];
                const isAnte = antecedent.has(i);
                const bracket = (key, ch, depth) => h('span', {
                  key,
                  style: {
                    color: clauseColor(depth), fontWeight: 800, fontSize: '1.2em',
                    padding: '0 2px', verticalAlign: 'middle'
                  }
                }, ch);
                return [
                  ...opensAt(i).map((c, oi) => bracket('o' + oi, '[', c.depth)),
                  h('span', {
                    key: i,
                    'data-tok': i,
                    title: inf ? `${inf.role}${inf.part.zh ? ' · ' + inf.part.zh : ''}` : '',
                    style: {
                      // 框内不再铺细小成分的底色（那交给下方成分树），只把先行词标出来
                      fontWeight: isAnte ? 700 : 'normal',
                      borderBottom: isAnte ? `2px solid ${clauseColor(0)}` : 'none',
                      borderRadius: 3,
                      padding: '0 1px'
                    }
                  }, tokens[i] + (k === g.idx.length - 1 ? '' : ' ')),
                  ...closesAt(i).map((c, ci) => bracket('c' + ci, ']', c.depth))
                ];
              }).flat())
          );
        })
      );
    }

    
/* ── ① 结构视图 ───────────────────────────────────────────────── */
    function StructureView({ structure, loading, error, ruleHints, onPick, picked }) {
      if (error) {
        return box({ ...cardStyle, padding: 14 },
          box({ fontSize: 13, color: T.bad, marginBottom: 6 }, 'AI 分析没成功：' + error),
          box({ ...small }, '结构树需要模型生成；可以重试，或先去「② 标注」凭自己的判断拆。'));
      }
      if (!structure) {
        return box({ ...cardStyle, padding: 16 },
          box({ ...body }, loading ? 'AI 正在拆句（约 10–25 秒）…' : '点上方「分析结构」开始。'));
      }
      return box({ display: 'flex', flexDirection: 'column', gap: 14 },
        box({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' },
          box({ fontSize: 12, color: T.label3 },
            `${structure.tokens.length} 词 · 覆盖 ${structure.coverage?.covered ?? 0}/${structure.coverage?.total ?? 0}` +
            (structure.cached ? ' · 缓存命中' : ` · 用时 ${((structure.ms || 0) / 1000).toFixed(1)}s`)),
          text({ ...small }, structure.model || '')),
        h(SentenceParts, { tokens: structure.tokens, parts: structure.parts, onPick }),
        picked ? box({ ...cardStyle, padding: 12, borderLeft: `3px solid ${roleColor(picked.role)}` },
          box({ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
            text({ fontSize: 11, padding: '1px 7px', borderRadius: 4, background: mix(roleColor(picked.role), 18), color: roleColor(picked.role) }, picked.role),
            box({ fontSize: 13.5 }, structure.tokens.slice(picked.start, picked.end).join(' '))),
          picked.zh ? box({ ...small, marginTop: 3 }, picked.zh) : null,
          picked.note ? box({ ...small, marginTop: 2 }, picked.note) : null
        ) : box({ ...small }, '点句子里任意色块，这里显示它被判成什么成分、中文意思。'),
        structure.translation
          ? box({ ...cardStyle, padding: 12 },
            box(tinyLabel, '整句译文'),
            box({ fontSize: 13.5, lineHeight: '22px', marginTop: 3 }, structure.translation))
          : null,
        box({},
          box(sectionTitle, '成分树'),
          box({ display: 'flex', flexDirection: 'column', gap: 10 },
            (structure.parts || []).map((p, i) => h(PartCard, {
              key: i, part: p, tokens: structure.tokens, depth: 0, num: String(i + 1), siblings: structure.parts
            })))),
        ruleHints
      );
    }

function RangeSentence({
      tokens, ranges, selection, dragging, compact,
      onTokenDown, onTokenEnter, onRemoveRange, onDropLabel,
      pickedId, onPickRange, containerRef, onCommit, onClearSel, wasJustFinished
    }) {
      const owner = new Array(tokens.length).fill(null);
      ranges.forEach((r) => { for (let i = r.start; i < r.end; i += 1) owner[i] = r; });
      const lo = selection ? Math.min(selection.start, selection.end) : -1;
      const hi = selection ? Math.max(selection.start, selection.end) : -2;
      const inSel = (i) => !!selection && i >= lo && i <= hi;
      const innerRef = useRef(null);
      const boxRef = containerRef || innerRef;
      const nearestIdx = (x, y) => nearestIndexIn(boxRef.current, x, y);

      // 连续同属一个区间的词合成一块；未划定的词逐词 inline 输出——
      // 只有「已划定的短段」才用 inline-block，整句排版才不会被推着换行
      const groups = [];
      tokens.forEach((t, i) => {
        const r = owner[i] || null;
        const last = groups[groups.length - 1];
        if (last && last.range === r) { last.idx.push(i); return; }
        groups.push({ range: r, idx: [i] });
      });

      const wordEl = (i, withSpace) => h('span', {
        key: i,
        'data-idx': i,
        onMouseDown: (e) => { if (e?.preventDefault) e.preventDefault(); onTokenDown(i); },
        onMouseEnter: () => onTokenEnter(i),
        style: {
          borderRadius: 4,
          // 命中区左右各扩 3px，再用负 margin 抵消：视觉宽度不变，但句末词也好点中
          padding: '0 4px',
          margin: '0 -3px',
          background: inSel(i) ? tintOf(SPAN_COLORS.其他, 26) : 'transparent',
          cursor: 'pointer'
        }
      }, tokens[i] + (withSpace ? ' ' : ''));

      const nodes = [];
      groups.forEach((g, gi) => {
        const r = g.range;
        if (!r) {
          g.idx.forEach((i) => nodes.push(wordEl(i, true)));
          return;
        }
        // 统一用 label / color：S 区、R/L/V 区传的都是这两个字段
        const hasLabel = !!r.label;
        const bd = hasLabel ? (r.color || SPAN_COLORS.其他) : T.border3;
        const removable = r.removable !== false;

        nodes.push(h('span', {
          key: 'g' + gi,
          style: {
            position: 'relative',
            display: 'inline-block',
            margin: compact ? '5px 3px' : '7px 4px',
            padding: compact ? '0 6px' : '1px 8px',
            borderRadius: 8,
            border: `2px ${hasLabel ? 'solid' : 'dashed'} ${bd}`,
            background: tintOf(bd, hasLabel ? 16 : 5),
            verticalAlign: 'middle',
            lineHeight: compact ? '26px' : '30px',
            cursor: 'pointer',
            boxShadow: pickedId === r.id ? `0 0 0 3px ${tintOf(bd, 30)}` : 'none'
          },
          // drop 直接绑在这一段自己身上：不依赖 e.target，也不怕内层元素冒泡
          onDragOver: (e) => { if (e?.preventDefault) e.preventDefault(); },
          onDrop: (e) => {
            if (e?.preventDefault) e.preventDefault();
            if (e?.stopPropagation) e.stopPropagation();
            const label = e?.dataTransfer?.getData?.('text/plain');
            if (label) onDropLabel(r.id, label);
          },
          onClick: () => { if (onPickRange) onPickRange(r.id); }
        },
          hasLabel
            ? h('span', {
              key: 'chip',
              'data-chip': '1',
              style: {
                position: 'absolute', top: -9, left: 8,
                borderRadius: 4, padding: '0 6px',
                fontSize: 10.5, lineHeight: '15px',
                background: bd, color: '#FFF9F2',
                whiteSpace: 'nowrap', pointerEvents: 'none'
              }
            }, r.label)
            : null,
          ...g.idx.map((i, k) => wordEl(i, k !== g.idx.length - 1)),
          removable
            ? h('button', {
              key: 'x',
              type: 'button',
              onMouseDown: (e) => { if (e?.stopPropagation) e.stopPropagation(); },
              onClick: (e) => { if (e?.stopPropagation) e.stopPropagation(); onRemoveRange(r.id); },
              title: '移除这一段',
              style: {
                marginLeft: 4, border: 'none', background: 'transparent',
                cursor: 'pointer', color: T.label3, fontSize: 12, verticalAlign: 'middle', padding: 0, lineHeight: 1
              }
            }, '×')
            : null
        ));
      });

      return h('div', {
        ref: boxRef,
        style: {
          padding: compact ? '12px 12px 8px' : '18px 15px 12px',
          borderRadius: 8,
          border: '1px solid ' + T.border,
          background: T.bg2,
          fontSize: compact ? 15 : 19,
          lineHeight: compact ? '32px' : '40px',
          fontFamily: 'Georgia, "Times New Roman", serif',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          cursor: 'text',
          outline: dragging ? `1px dashed ${mix(T.accent, 55)}` : 'none'
        },
        // 松手就地提交：不依赖 window 监听是否生效
        onMouseUp: (e) => { if (onCommit) onCommit(e); },
        // 点在句子空白处（没落在任何词上）= 放弃这次框选
        onClick: (e) => {
          if (wasJustFinished && wasJustFinished()) return;
          const onWord = e?.target?.closest?.('[data-idx]');
          const onChip = e?.target?.closest?.('[data-chip]');
          if (!onWord && !onChip && onClearSel) onClearSel();
        },
        // 拖动时以指针所在的词为准：mouseenter 会漏词，mousemove 不会
        onMouseMove: (e) => {
          if (!dragging) return;
          const pick = (node) => Number(node?.dataset?.idx);
          let idx = pick(e?.target?.closest?.('[data-idx]'));
          if (!Number.isFinite(idx)) {
            try {
              const under = document.elementFromPoint(e.clientX, e.clientY);
              idx = pick(under?.closest?.('[data-idx]'));
            } catch { idx = NaN; }
          }
          if (!Number.isFinite(idx)) idx = nearestIdx(e.clientX, e.clientY);
          if (Number.isFinite(idx)) onTokenEnter(idx);
        },
        onDragOver: (e) => { if (e?.preventDefault) e.preventDefault(); },
        onDrop: (e) => {
          if (e?.preventDefault) e.preventDefault();
          const label = e?.dataTransfer?.getData?.('text/plain');
          if (!label) return;
          const target = ranges.filter((r) => !r.label).slice(-1)[0];
          if (target) onDropLabel(target.id, label);
        }
      }, ...nodes);
    }


    function useRangeSelector(commit, autoCommit) {
      const boxRef = useRef(null);
      const [sel, setSel] = useState(null);
      const [drag, setDrag] = useState(false);
      const dragRef = useRef(false);
      const selRef = useRef(null);
      const commitRef = useRef(commit);
      commitRef.current = commit;
      const lastFinishRef = useRef(0);
      const apply = (v) => {
        selRef.current = typeof v === 'function' ? v(selRef.current) : v;
        setSel(selRef.current);
      };
      return {
        sel, drag,
        down: (i) => {
          dragRef.current = true;
          setDrag(true);
          apply({ start: i, end: i });
          // down/enter 不再上报，避免刷屏（排查时看得见 finish 就够了）
        },
        enter: (i) => {
          if (!dragRef.current) return;
          const cur = selRef.current;
          if (cur && cur.end === i) return;

          apply((s) => (s ? { ...s, end: i } : { start: i, end: i }));
        },
        finish: (evt) => {
          if (!dragRef.current) return;
          dragRef.current = false;
          setDrag(false);
          const cur = selRef.current;
          if (!cur) { apply(null); return; }
          // 松手时用指针位置再定一次终点：最后一次 mousemove 常常没落在终点词上。
          // 但这一步必须容错——它一旦抛错，整次提交就废了（上一版就是这么坏的）
          let s = cur;
          let nearest = NaN;
          let via = 'mousemove';
          try {
            // 优先信「松手时指针下的元素」——它最接近真实意图
            const el = evt?.target?.closest?.('[data-idx]');
            const byTarget = Number(el?.dataset?.idx);
            if (Number.isFinite(byTarget)) { nearest = byTarget; via = 'target'; }
            else if (evt && Number.isFinite(evt.clientX)) {
              nearest = nearestIndexIn(boxRef.current, evt.clientX, evt.clientY);
              via = 'point';
            }
            if (Number.isFinite(nearest)) s = { start: cur.start, end: nearest };
          } catch (e) { dbg('nearest-error', String(e && e.message)); }
          lastFinishRef.current = Date.now();
          const a = Math.min(s.start, s.end);
          const b = Math.max(s.start, s.end) + 1;
          dbg('finish', {
            autoCommit: !!autoCommit,
            movedEnd: cur.end,
            nearest,
            finalEnd: s.end,
            submitted: [a, b],
            via,
            hasEvt: !!evt,
            x: evt ? evt.clientX : null,
            y: evt ? evt.clientY : null,
            hasContainer: !!boxRef.current
          });
          if (autoCommit) { apply(null); if (commitRef.current) commitRef.current(a, b); }
          else apply({ start: a, end: b - 1 });
        },
        cancel: () => { dragRef.current = false; setDrag(false); apply(null); },
        /** 刚提交完的 250ms 内，忽略「点空白清除」——否则拖到行尾松手会把刚选的抹掉 */
        wasJustFinished: () => Date.now() - lastFinishRef.current < 250,
        boxRef
      };
    }

    /** 把「本句有什么可标」变成一句提示；没有就明说可以跳过 */
    function probeHint(probes, key, withItems, emptyText) {
      const list = probes ? (probes[key] || []) : null;
      if (!probes) return null;
      if (list && list.length) return withItems(list, probes);
      return typeof emptyText === 'function' ? emptyText() : emptyText;
    }

    function AnnotateView({ tokens, work, actions, onGrade, grading }) {
      const { spans, refs, logicPairs, words, wordGuess, translation } = work;
      const sSel = useRangeSelector(actions.addRange, true);
      const rSel = useRangeSelector(null, false);
      const lSel = useRangeSelector(null, false);
      const vSel = useRangeSelector(null, false);

      // 松手统一在 window 上收：四个选择器各自判断自己是否在拖
      useEffect(() => {
        const up = (evt) => { sSel.finish(evt); rSel.finish(evt); lSel.finish(evt); vSel.finish(evt); };
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('mouseup', up);
          return () => { if (typeof window.removeEventListener === 'function') window.removeEventListener('mouseup', up); };
        }
        return undefined;
      }, []);

      const sep = (title, hint, extra) => box({ marginTop: 18, marginBottom: 8, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
        box({ fontSize: 13, fontWeight: 600, color: T.label1 }, title),
        hint ? text({ ...small }, hint) : null,
        extra || null);

      const droppable = (tag) => ({
        draggable: true,
        onDragStart: (e) => {
          try { e.dataTransfer.setData('text/plain', tag); e.dataTransfer.effectAllowed = 'copy'; } catch { /* 靠 drop 兜底 */ }
        }
      });

      const tagButton = (tag, onClick, color) => h('button', {
        key: tag, type: 'button',
        ...droppable(tag),
        onClick,
        title: `把「${tag}」拖到句子上的某一段，或直接点它给最后一个未命名区间`,
        style: {
          padding: '5px 11px', borderRadius: 999, font: 'inherit', fontSize: 12.5, cursor: 'grab',
          border: '1px solid ' + mix(color, 55), background: mix(color, 10), color: T.label1
        }
      }, tag);

      const del = (onClick) => h('button', {
        type: 'button', onClick,
        style: { border: 'none', background: 'transparent', cursor: 'pointer', color: T.label3, fontSize: 13, padding: '0 4px' }
      }, '×');

      const listRow = (key, kids) => box({
        key, display: 'flex', alignItems: 'center', gap: 9,
        padding: '5px 9px', borderRadius: 6, border: '1px solid ' + T.border, background: T.bg2, marginBottom: 4
      }, ...kids);

      const total = spans.filter((s) => s.role).length + refs.length + logicPairs.length + words.length + (translation.trim() ? 1 : 0);
      // 本句没有对应素材时整块置灰，不要让人对着空项发呆
      const noPronouns = !!(work.probes && (work.probes.pronouns || []).length === 0);
      const noLogic = !!(work.probes
        && (work.probes.negators || []).length === 0
        && (work.probes.markers || []).length === 0);
      /* ③ 逻辑只在「容易读反」的结构上出现（not…because / not all / 否定前移 / not until…）。
         普通否定不渲染这一块——以前每句都出现，全是噪音。 */
      const showLogic = !!(work.probes && (work.probes.scopeHints || []).length);
      const dim = (off) => ({
        opacity: off ? 0.4 : 1,
        pointerEvents: off ? 'none' : 'auto',
        display: 'flex', flexDirection: 'column', gap: 8
      });
      const unnamed = spans.filter((s) => !s.role);

      return box({ display: 'flex', flexDirection: 'column' },
        box({ ...cardStyle, padding: 12, marginBottom: 12 },
          box({ fontSize: 13, marginBottom: 4 }, '自己拆一遍'),
          box({ ...body }, '先只管框范围：按住鼠标划过几个词，松手就存下一段。全部框完，再把下面的成分标签拖到对应的段上。别先看结构页——先看就等于抄答案。不用先分析结构：直接拆，提交批改时会生成标准答案再对照。')),

        sep('① 成分', '框完所有段后，点段上的「命名」再点成分标签；块尾 × 取消这一段'),
        tokens.length
          ? h(RangeSentence, {
            tokens,
            ranges: spans.map((s) => ({
              id: s.id, start: s.start, end: s.end,
              label: s.role || null,
              color: s.role ? roleColor(s.role) : T.label3
            })),
            selection: sSel.sel, dragging: sSel.drag,
            onTokenDown: sSel.down, onTokenEnter: sSel.enter, containerRef: sSel.boxRef, onCommit: sSel.finish, onClearSel: sSel.cancel, wasJustFinished: sSel.wasJustFinished,
            onRemoveRange: (id) => actions.removeRange(id),
            onDropLabel: (id, role) => actions.nameRange(id, role),
            pickedId: work.pickedRange,
            onPickRange: actions.pickRange
          })
          : box({ ...small, padding: 16 }, '这句话还没切出词来：先在上方输入或选中一句。'),
        box({ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 },
          ROLE_TAGS.map((tag) => tagButton(tag, () => actions.nameLatest(tag), roleColor(tag)))),
        unnamed.length
          ? box({ ...small, marginTop: 6, color: T.warn }, `还有 ${unnamed.length} 段没命名：点标签或把标签拖上去`)
          : (spans.length ? box({ ...small, marginTop: 6, color: T.ok }, `${spans.length} 段都已命名`) : null),

        sep('② 指代', probeHint(work.probes, 'pronouns',
          (list) => `本句代词：${list.map((p) => p.word).join('、')} —— 拖选一个代词，再拖选它指的那段`,
          '本句没有代词，这一项可以跳过')),
        box(dim(noPronouns),
        h(RangeSentence, {
          tokens, compact: true,
          ranges: [
            ...refs.map((r, i) => ({ id: 'rp' + i, start: r.pron.start, end: r.pron.end, label: '代词', color: T.accent, removable: false })),
            ...refs.map((r, i) => ({ id: 'rt' + i, start: r.target.start, end: r.target.end, label: '所指', color: T.ok, removable: false })),
            ...(rSel.sel ? [{ id: 'rpend', start: rSel.sel.start, end: rSel.sel.end + 1, label: '当前选区', color: T.warn, removable: false }] : []),
            ...(work.refPending ? [{ id: 'rpron', start: work.refPending.start, end: work.refPending.end, label: '代词', color: T.accent, removable: false }] : [])
          ],
          selection: rSel.sel, dragging: rSel.drag,
          onTokenDown: rSel.down, onTokenEnter: rSel.enter, containerRef: rSel.boxRef, onCommit: rSel.finish, onClearSel: rSel.cancel, wasJustFinished: rSel.wasJustFinished,
          onRemoveRange: () => {},
          onDropLabel: () => {}
        }),
        box({ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 },
          btn(false, '取为代词', () => { if (rSel.sel) { actions.takePron(rSel.sel); rSel.cancel(); } }, { disabled: !rSel.sel }),
          btn(false, '取为所指', () => { if (rSel.sel && work.refPending) { actions.takeTarget(rSel.sel); rSel.cancel(); } }, { disabled: !work.refPending || !rSel.sel }),
          work.refPending ? text({ ...small, color: T.warn }, '已选代词，再拖选所指') : null),
        /* 候选制：选好代词后直接点候选，不必再拖选。
           候选来自规则引擎（含 -ing 名词化与向右合并的名词短语），不需要模型。 */
        (() => {
          if (!work.refPending) return null;
          const hit = (work.probes?.pronouns || []).find((p) => p.idx === work.refPending.start);
          const cands = (hit && hit.candidates) || [];
          if (!cands.length) {
            return box({ ...small, marginTop: 6, color: T.label3 },
              '这句代词前面没找到候选名词：多半是指前面整件事，用上面的拖选框出那一段。');
          }
          return box({ marginTop: 8, padding: '8px 10px', borderRadius: 6, background: T.bg2 },
            text({ ...small, color: T.label2 }, '候选（点一个就记下；也可以继续用上面的拖选）：'),
            box({ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 },
              cands.map((c, i) => box({ key: i, display: 'flex', flexDirection: 'column', gap: 2 },
                btn(false, c.text, () => actions.takeTarget({ start: c.start, end: c.end })),
                c.maybePlural ? text({ fontSize: 10.5, color: T.label3 }, '可能是复数') : null))));
        })(),
        refs.length ? box({}, refs.map((r, i) => listRow('r' + i, [
          box({ flex: '0 0 auto', fontSize: 13 }, tokens.slice(r.pron.start, r.pron.end).join(' ')),
          text({ fontSize: 12, color: T.label3 }, '→'),
          box({ flex: 1, fontSize: 13 }, tokens.slice(r.target.start, r.target.end).join(' ')),
          del(() => actions.removeRef(i))
        ]))) : null),

        (() => {
          if (!showLogic) {
            return box({ ...small, marginTop: 6, color: T.label3 },
              work.probes
                ? '③ 逻辑：本句没有容易读反的否定结构（not…because / not all / 否定前移 / not until / 准否定词），这一项跳过。'
                : '③ 逻辑：暂时没取到本句的规则检查结果（不影响你自己标注，刷新或重新选句会重试）。');
          }
          return box(null,
        sep('③ 逻辑', (work.probes.scopeHints || []).length
          ? `本句有 ${work.probes.scopeHints.length} 处容易读反的否定结构 —— 先选触发词，再选它管到哪儿`
          : probeHint(work.probes, 'negators',
            (list, p) => `本句否定词：${list.join('、')}${(p.markers || []).length ? `；引导词：${p.markers.join('、')}` : ''} —— 先选触发词，再选它管到哪儿`,
            '本句没有否定词或从句引导词，这一项可以跳过')),
        box(dim(noLogic),
        h(RangeSentence, {
          tokens, compact: true,
          ranges: [
            ...logicPairs.map((r, i) => ({ id: 'lt' + i, start: r.trigger.start, end: r.trigger.end, label: '触发词', color: T.bad, removable: false })),
            ...logicPairs.map((r, i) => ({ id: 'ls' + i, start: r.scope.start, end: r.scope.end, label: '范围', color: T.warn, removable: false })),
            ...(lSel.sel ? [{ id: 'lcur', start: lSel.sel.start, end: lSel.sel.end + 1, label: '当前选区', color: T.warn, removable: false }] : []),
            ...(work.logicPending ? [{ id: 'ltrig', start: work.logicPending.start, end: work.logicPending.end, label: '触发词', color: T.bad, removable: false }] : [])
          ],
          selection: lSel.sel, dragging: lSel.drag,
          onTokenDown: lSel.down, onTokenEnter: lSel.enter, containerRef: lSel.boxRef, onCommit: lSel.finish, onClearSel: lSel.cancel, wasJustFinished: lSel.wasJustFinished,
          onRemoveRange: () => {},
          onDropLabel: () => {}
        }),
        box({ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 },
          btn(false, '取为触发词', () => { if (lSel.sel) { actions.takeTrigger(lSel.sel); lSel.cancel(); } }, { disabled: !lSel.sel }),
          btn(false, '取为范围', () => { if (lSel.sel && work.logicPending) { actions.takeScope(lSel.sel); lSel.cancel(); } }, { disabled: !work.logicPending || !lSel.sel }),
          work.logicPending ? text({ ...small, color: T.warn }, '已选触发词，再拖选范围') : null),
        logicPairs.length ? box({}, logicPairs.map((r, i) => listRow('l' + i, [
          box({ flex: '0 0 auto', fontSize: 13 }, tokens.slice(r.trigger.start, r.trigger.end).join(' ')),
          text({ fontSize: 12, color: T.label3 }, '管到'),
          box({ flex: 1, fontSize: 13 }, tokens.slice(r.scope.start, r.scope.end).join(' ')),
          del(() => actions.removeLogic(i))
        ]))) : null),
          );
        })(),

        sep('④ 生词', '拖选你不确定的词，写下你猜的意思——猜错才有诊断价值'),
        h(RangeSentence, {
          tokens, compact: true,
          ranges: [
            ...words.map((w, i) => ({ id: 'w' + i, start: w.start, end: w.end, label: '生词', color: T.label2, removable: false })),
            ...(vSel.sel ? [{ id: 'wcur', start: vSel.sel.start, end: vSel.sel.end + 1, label: '当前选区', color: T.accent, removable: false }] : [])
          ],
          selection: vSel.sel, dragging: vSel.drag,
          onTokenDown: vSel.down, onTokenEnter: vSel.enter, containerRef: vSel.boxRef, onCommit: vSel.finish, onClearSel: vSel.cancel, wasJustFinished: vSel.wasJustFinished,
          onRemoveRange: () => {},
          onDropLabel: () => {}
        }),
        box({ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 },
          h('input', {
            value: wordGuess,
            onChange: (e) => actions.setGuess(e.target.value),
            placeholder: '我猜它是……',
            style: { ...inputStyle, flex: '1 1 240px', height: 30 }
          }),
          btn(false, '加入生词', () => { if (vSel.sel) { actions.commitWord(vSel.sel); vSel.cancel(); } }, { disabled: !vSel.sel }),
          btn(false, '只标记 [?] 不猜', () => { if (vSel.sel) { actions.commitMark(vSel.sel); vSel.cancel(); } }, { disabled: !vSel.sel })),
        words.length ? box({ marginTop: 8 }, words.map((w, i) => listRow('w' + i, [
          box({ flex: '0 0 auto', fontSize: 13 }, tokens.slice(w.start, w.end).join(' ')),
          w.unknown && !w.guess
            ? box({ flex: 1, fontSize: 12.5, color: T.warn }, '[?] 未标记意思 —— 别编，先让它空着')
            : box({ flex: 1, fontSize: 12.5, color: T.label2 }, `我猜：${w.guess || '（没写）'}`),
          del(() => actions.removeWord(i))
        ]))) : null,

        sep('⑤ 翻译', '译完再提交——边看结构边写等于抄'),
        h('textarea', {
          value: translation,
          onChange: (e) => actions.setTranslation(e.target.value),
          placeholder: '写下你的中文译文（长定语可以拆成短句）',
          style: {
            width: '100%', minHeight: 92, padding: '9px 11px', borderRadius: 8,
            border: '1px solid ' + T.border, background: T.bg2, color: T.label1,
            fontSize: 13.5, lineHeight: '22px', resize: 'vertical', outline: 'none',
            boxSizing: 'border-box', font: 'inherit'
          }
        }),

        box({ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 18, paddingTop: 12, borderTop: '1px solid ' + T.border },
          btn(true, grading ? '批改中…' : '批改全部', onGrade, { disabled: grading || !total }),
          total ? btn(false, '清空作业', actions.clearAll) : null,
          text({ ...small }, total ? `已填 ${total} 项` : '至少填一项再批改'))
      );
    }

    
    const structureReadyHint = (tokens) => Array.isArray(tokens) && tokens.length > 0;

    /* ── ③ 结果视图 ───────────────────────────────────────────────── */
function VerdictView({ graded, tokens, onShowAnswer, showAnswer, structure, sentence }) {
      if (!graded) return box({ ...body }, '这一句还没有批改结果。左侧「本句批改」里如果有记录，点一条就能回放当次的完整结果。');
      const toks = Array.isArray(tokens) ? tokens : [];
      const sliceText = (a, b) => toks.slice(Number(a) || 0, Number(b) || 0).join(' ');
      const LAYERS = [
        ['S', '句法', graded.S],
        ['R', '指代', graded.R],
        ['L', '逻辑', graded.L],
        ['V', '词汇', graded.V],
        ['E', '表达', graded.E]
      ];
      const stateOf = (layer) => graded.layers?.[layer] ?? 'skip';
      const markOf = (st) => st === 'hit' ? '✔ 掌握' : st === 'miss' ? '✘ 卡住' : '－ 未测';
      const colorOf = (st) => st === 'hit' ? T.ok : st === 'miss' ? T.bad : T.label3;

      const itemLine = (layer, r, i) => {
        if (layer === 'S') {
          const v = r.verdict === 'correct' ? T.ok : r.verdict === 'wrong-role' ? T.warn : T.bad;
          const word = r.verdict === 'correct' ? '✔ 对' : r.verdict === 'wrong-role' ? '✘ 成分错' : '✘ 范围偏';
          return box({ key: i, padding: '7px 10px', borderRadius: 6, border: '1px solid ' + T.border, borderLeft: '3px solid ' + v, background: T.bg1, marginBottom: 6 },
            box({ display: 'flex', gap: 9, alignItems: 'baseline', flexWrap: 'wrap' },
              text({ fontSize: 11.5, color: v }, word),
              text({ fontSize: 13 }, sliceText(r.start, r.end)),
              text({ fontSize: 11.5, color: T.label3 },
                r.verdict === 'correct' ? (r.yourRole || '') : `你标「${r.yourRole || '—'}」，标准「${r.correctRole || '—'}」`)),
            r.comment ? box({ ...small, marginTop: 3 }, r.comment) : null);
        }
        if (layer === 'R') {
          const v = r.verdict === 'correct' ? T.ok : T.bad;
          return box({ key: i, padding: '7px 10px', borderRadius: 6, border: '1px solid ' + T.border, borderLeft: '3px solid ' + v, background: T.bg1, marginBottom: 6 },
            box({ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' },
              text({ fontSize: 13 }, `${r.pron || '—'} → ${r.target || '—'}`),
              text({ fontSize: 11.5, color: T.label3 }, r.expected ? `标准所指：${r.expected}` : '')),
            r.comment ? box({ ...small, marginTop: 3 }, r.comment) : null);
        }
        if (layer === 'L') {
          const v = r.verdict === 'correct' ? T.ok : T.bad;
          return box({ key: i, padding: '7px 10px', borderRadius: 6, border: '1px solid ' + T.border, borderLeft: '3px solid ' + v, background: T.bg1, marginBottom: 6 },
            box({ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' },
              text({ fontSize: 13 }, `${r.trigger || '—'} 管到「${r.scope || '—'}」`),
              text({ fontSize: 11.5, color: T.label3 }, r.expected ? `标准范围：${r.expected}` : '')),
            r.comment ? box({ ...small, marginTop: 3 }, r.comment) : null);
        }
        if (layer === 'V') {
          const v = r.verdict === 'correct' ? T.ok : r.verdict === 'neutral' ? T.label3 : T.warn;
          return box({ key: i, padding: '7px 10px', borderRadius: 6, border: '1px solid ' + T.border, borderLeft: '3px solid ' + v, background: T.bg1, marginBottom: 6 },
            box({ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' },
              text({ fontSize: 13 }, r.word || ''),
              text({ fontSize: 11.5, color: T.label3 }, `你猜：${r.guess || '（没写）'}`),
              r.expected ? text({ fontSize: 11.5, color: T.label2 }, `实际：${r.expected}`) : null),
            r.comment ? box({ ...small, marginTop: 3 }, r.comment) : null);
        }
        const v = r.verdict === 'covered' ? T.ok : T.warn;
        return box({ key: i, padding: '6px 10px', borderRadius: 6, border: '1px solid ' + T.border, borderLeft: '3px solid ' + v, background: T.bg1, marginBottom: 5 },
          box({ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' },
            text({ fontSize: 11.5, color: v }, r.verdict === 'covered' ? '✔ 译到' : '? 疑似漏译'),
            text({ fontSize: 12.5 }, `${r.role || ''}「${sliceText(r.start, r.end)}」`),
            text({ fontSize: 11.5, color: T.label3 }, r.zh || '')));
      };

      return box({ display: 'flex', flexDirection: 'column', gap: 14 },
        box({ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' },
          box({ display: 'flex', alignItems: 'baseline', gap: 6 },
            box({ fontSize: 34, fontWeight: 700, lineHeight: '38px' }, graded.overall == null ? '—' : String(graded.overall)),
            box({ ...small }, '总分')),
          text({ fontSize: 14, color: graded.primary ? T.bad : T.ok },
            graded.primary ? `主卡点：${(LAYERS.find(([k]) => k === graded.primary) || [,'—'])[1]}` : '五层都过线'),
          box({ display: 'flex', gap: 12, flexWrap: 'wrap' },
            LAYERS.map(([key, label]) => box({ key, display: 'flex', gap: 5, alignItems: 'baseline' },
              text({ fontSize: 11.5, color: T.label2 }, label),
              text({ fontSize: 11.5, color: colorOf(stateOf(key)) }, markOf(stateOf(key))))))),

        LAYERS.map(([key, label, data]) => {
          const st = stateOf(key);
          if (!data || data.score === null || data.score === undefined) {
            return box({ key, padding: '8px 11px', borderRadius: 6, border: '1px dashed ' + T.border },
              box({ fontSize: 12.5, color: T.label3 }, `${label}层：这一项没做，未测到`));
          }
          return box({ key, padding: '10px 12px', borderRadius: 8, border: '1px solid ' + T.border, background: T.bg1 },
            box({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 },
              box({ display: 'flex', gap: 8, alignItems: 'baseline' },
                text({ fontSize: 13, fontWeight: 600 }, label + '层'),
                text({ fontSize: 13, color: colorOf(st) }, String(data.score) + ' 分')),
              text({ ...small }, st === 'hit' ? '过关' : '需要练')),
            (data.results || []).map((r, i) => itemLine(key, r, i)),
            (data.missed || []).length ? box({ marginTop: 4 },
              box({ ...tinyLabel, marginBottom: 3 }, `漏标 ${data.missed.length} 段`),
              box({ display: 'flex', flexDirection: 'column', gap: 3 },
                data.missed.map((m, i) => box({ key: i, ...small }, `· ${m.role || ''}「${m.text || ''}」${m.zh ? ' — ' + m.zh : ''}`)))) : null,
            (data.patterns || []).length ? box({ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 },
              data.patterns.map((pt, i) => box({ key: i, padding: '8px 10px', borderRadius: 6, background: T.bg2, border: '1px solid ' + T.border },
                box({ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }, pt.tag || ''),
                box({ ...small }, pt.detail || ''),
                pt.drill ? box({ ...small, marginTop: 3, color: T.label2 }, `练法：${pt.drill}`) : null))) : null
          );
        }),

        (graded.S?.diagnosis?.patterns || []).length ? box({},
          box(sectionTitle, '句法层归因'),
          box({ display: 'flex', flexDirection: 'column', gap: 6 },
            graded.S.diagnosis.patterns.map((pt, i) => box({ key: i, padding: '8px 10px', borderRadius: 6, background: T.bg1, border: '1px solid ' + T.border },
              box({ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }, pt.tag || ''),
              box({ ...small }, pt.detail || ''),
              pt.drill ? box({ ...small, marginTop: 3, color: T.label2 }, `练法：${pt.drill}`) : null)))) : null,

        box({},
          h('button', {
            type: 'button', onClick: onShowAnswer,
            style: { height: 28, padding: '0 11px', borderRadius: 6, fontSize: 12.5, font: 'inherit', cursor: 'pointer', border: '1px solid ' + T.border, background: 'transparent', color: T.label1 }
          }, showAnswer ? '收起标准答案' : '对照标准答案'),
          showAnswer && structure ? box({ marginTop: 10 },
            structure.translation ? box({ ...cardStyle, padding: 12, marginBottom: 10 },
              box(tinyLabel, '整句译文'),
              box({ fontSize: 13.5, marginTop: 3 }, structure.translation)) : null,
            box(sectionTitle, '成分树'),
            /* 与结构页「成分树」保持同一套渲染参数：grid 换成纵向 column，
               并补上 num / siblings —— 少了它们，顶层没有编号、子层从 1 重数、
               「≈ 修饰「…」」挂靠提示也会整块消失（modifierTarget 拿不到 siblings 就返回 null） */
            box({ display: 'flex', flexDirection: 'column', gap: 10 },
              (structure.parts || []).map((p, i) => h(PartCard, { key: i, part: p, tokens: structure.tokens || [], depth: 0, num: String(i + 1), siblings: structure.parts })))
          ) : null)
      );
    }

    
    /* ── 历史回放：一次批改的完整明细（只读，不改当前作业）────────── */
    function AttemptDetail({ attempt }) {
      if (!attempt) return null;
      const d = attempt.detail;
      const when = String(attempt.ts || "").replace("T", " ").slice(0, 16);
      const head = `第 ${attempt.seq || "?"} 次 · ${when}`;
      const scores = attempt.scores || {};
      const chip = (k, label) => text({
        fontSize: 11.5,
        color: scores[k] == null ? T.label3 : (scores[k] >= 80 ? T.ok : T.bad)
      }, `${label} ${scores[k] == null ? "–" : scores[k]}`);

      if (!d) {
        return box({ ...cardStyle, padding: 12, display: 'flex', flexDirection: 'column', gap: 4 },
          box({ fontSize: 12.5, fontWeight: 600 }, head),
          box({ display: 'flex', gap: 10, flexWrap: 'wrap' }, chip('S', '句法'), chip('R', '指代'), chip('L', '逻辑'), chip('V', '词汇'), chip('E', '表达')),
          box({ ...small, marginTop: 4 }, '这条是旧格式记录，只存了分数，没有标注明细。'));
      }

      const tk = d.tokens || [];
      const seg = (s) => tk.slice(s?.start ?? 0, s?.end ?? 0).join(' ');
      const verdicts = d.verdicts || {};
      const comments = [];
      for (const k of ['S', 'R', 'L', 'V', 'E']) {
        for (const r of (verdicts[k] || [])) if (r && r.comment) comments.push(`[${k}] ${r.comment}`);
      }
      const row = (label, value) => box({ display: 'flex', gap: 8, alignItems: 'baseline' },
        text({ flex: '0 0 auto', fontSize: 11.5, color: T.label3 }, label),
        box({ flex: 1, fontSize: 12.5, color: T.label1, wordBreak: 'break-word' }, value));

      return box({ ...cardStyle, padding: 12, display: 'flex', flexDirection: 'column', gap: 5 },
        box({ fontSize: 12.5, fontWeight: 600 }, head),
        box({ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 2 },
          chip('S', '句法'), chip('R', '指代'), chip('L', '逻辑'), chip('V', '词汇'), chip('E', '表达')),
        (d.spans || []).length
          ? box({ display: 'flex', flexDirection: 'column', gap: 3 },
            text({ ...tinyLabel }, '你标的成分'),
            ...(d.spans || []).map((s, i) => row(`${i + 1}. ${s.role}`, seg(s))))
          : null,
        (d.refs || []).length
          ? box({ display: 'flex', flexDirection: 'column', gap: 3 },
            text({ ...tinyLabel }, '你标的指代'),
            ...(d.refs || []).map((r, i) => {
              const v = (verdicts.R || [])[i];
              const mark = v ? (v.verdict === 'correct' ? '✓' : v.verdict === 'partial' ? '△' : '✗') : '';
              return row(`${mark} ${seg(r.pron)} → ${seg(r.target)}`, v?.expected ? `标准：${v.expected}` : '');
            }))
          : null,
        (d.logic || []).length
          ? box({ display: 'flex', flexDirection: 'column', gap: 3 },
            text({ ...tinyLabel }, '你标的否定范围'),
            ...(d.logic || []).map((p) => row(`${seg(p.trigger)} 管到`, seg(p.scope))))
          : null,
        (d.words || []).length
          ? box({ display: 'flex', flexDirection: 'column', gap: 3 },
            text({ ...tinyLabel }, '生词'),
            ...(d.words || []).map((w) => row(seg(w), w.unknown && !w.guess ? '[?] 未标记意思' : `猜：${w.guess || '（空）'}`)))
          : null,
        d.translation
          ? box({ display: 'flex', flexDirection: 'column', gap: 3 },
            text({ ...tinyLabel }, '你的译文'),
            box({ fontSize: 12.5, lineHeight: '20px', color: T.label1 }, d.translation))
          : null,
        comments.length
          ? box({ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2 },
            text({ ...tinyLabel }, '批改要点'),
            ...comments.slice(0, 6).map((c, i) => text({ key: i, fontSize: 12, color: T.label2, lineHeight: '19px' }, c)))
          : null,
        (d.answer || []).length
          ? box({ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 },
            text({ ...tinyLabel }, '当次的标准答案'),
            ...(d.answer || []).slice(0, 10).map((p, i) => row(p.role, p.text)))
          : null);
    }

    /* ── 生词模式 ────────────────────────────────────────────────── */
    /* 词表分级：0=当前生词，1..maxLevel=N 级熟练。
       记住了 → 升一级；没记住 → 直接退回 0 级（后端 /vocab/move 落盘）。 */
    const VOCAB_PAGE = 50;
    function VocabView() {
      const [words, setWords] = useState(null);
      const [maxLevel, setMaxLevel] = useState(3);
      const [tab, setTab] = useState(0);
      const [shown, setShown] = useState(VOCAB_PAGE);
      const [cover, setCover] = useState(false);
      const [onlySnoozed, setOnlySnoozed] = useState(false); // 只看今天推迟的
      const [peek, setPeek] = useState({});
      const [err, setErr] = useState('');

      const load = useCallback(async () => {
        setErr('');
        try {
          const r = await apiGet('/vocab');
          setWords(r.words || []);
          setMaxLevel(r.maxLevel || 3);
        } catch (e) { setErr(String(e.message || e)); }
      }, []);
      useEffect(() => { load(); }, [load]);

      const move = async (w, action) => {
        const prev = { level: w.level, misses: w.misses, snoozed: w.snoozed };
        let next;
        if (action === 'know') next = { level: Math.min(maxLevel, prev.level + 1), misses: 0, snoozed: false };
        else if (action === 'forget') next = { level: 0, misses: prev.misses + 1, snoozed: false };
        else next = { level: prev.level, misses: prev.misses + 1, snoozed: true };
        if (action === 'know' && next.level === prev.level) return;
        // 先改界面再落盘；失败就退回去，别让界面和磁盘对不上
        setWords((list) => list.map((x) => (x.word === w.word ? { ...x, ...next } : x)));
        try { await apiPost('/vocab/move', { word: w.word, action }); }
        catch (e) {
          setWords((list) => list.map((x) => (x.word === w.word ? { ...x, ...prev } : x)));
          setErr('保存失败：' + String(e.message || e));
        }
      };

      if (!words) {
        return box({ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' },
          box(body, err ? '生词表读取失败：' + err : '载入生词表…'),
          err ? btn(false, '重试', load) : null);
      }

      const tabs = [];
      for (let lv = 0; lv <= maxLevel; lv++) {
        tabs.push([lv, lv === 0 ? '当前生词' : `${lv}级熟练`, words.filter((x) => x.level === lv && !x.snoozed).length]);
      }
      // 点了「下次再记」的词今天不出现，过了本机零点自动回来
      const snoozedHere = words.filter((x) => x.level === tab && x.snoozed).length;
      // 推迟的词都处理完后自动退出「只看推迟」，免得停在一个空页面
      const viewSnoozed = onlySnoozed && snoozedHere > 0;
      const list = words.filter((x) => x.level === tab && (viewSnoozed ? x.snoozed : !x.snoozed));
      const visible = list.slice(0, shown);

      const actionBtn = (label, color, onClick, disabled) => h('button', {
        type: 'button', onClick, disabled,
        style: {
          height: 26, padding: '0 10px', borderRadius: 6, font: 'inherit', fontSize: 12,
          cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
          border: '1px solid ' + color, background: mix(color, 10), color: T.label1, whiteSpace: 'nowrap'
        }
      }, label);

      return box({ display: 'flex', flexDirection: 'column', gap: 12 },
        box({ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
          tabs.map(([lv, label, n]) => h('button', {
            key: lv, type: 'button',
            onClick: () => { setTab(lv); setShown(VOCAB_PAGE); setOnlySnoozed(false); },
            style: {
              height: 30, padding: '0 14px', borderRadius: 6, font: 'inherit', fontSize: 13, cursor: 'pointer',
              border: '1px solid ' + (tab === lv ? T.accent : T.border),
              background: tab === lv ? mix(T.accent, 14) : 'transparent',
              color: tab === lv ? T.label1 : T.label2
            }
          }, `${label}（${n}）`)),
          box({ flex: 1 }),
          btn(false, '重新载入', load),
          btn(false, cover ? '显示释义' : '遮住释义', () => { setCover((v) => !v); setPeek({}); })),
        box(small, tab === 0
          ? '记住了点「记住」升到 1 级熟练；还没记住就留在这里。'
          : `记得住点「记住」再升一级${tab >= maxLevel ? '（已是最高级，不再升）' : ''}；这次没想起来点「忘了」，回到当前生词重新记。`),
        snoozedHere ? box({ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
          text({ ...small }, viewSnoozed
            ? `正在看今天推迟的 ${snoozedHere} 个；这里点「记住」「忘了」会照常处理，明天它们也会回到词表。`
            : `今天已推迟 ${snoozedHere} 个（点了「下次再记」），明天再出现。`),
          btn(false, viewSnoozed ? '← 回到词表' : `查看今天推迟的（${snoozedHere}）`, () => { setOnlySnoozed((v) => !v); setShown(VOCAB_PAGE); }, null)) : null,
        err ? text({ ...small, color: T.bad }, err) : null,
        list.length === 0
          ? box({ ...body, padding: '28px 0', textAlign: 'center' }, tab === 0 ? (snoozedHere ? '今天的生词都处理完了，推迟的明天再来。' : '当前生词已清空 🎉') : '这一级还没有词。')
          : box({ display: 'flex', flexDirection: 'column', gap: 6 },
            visible.map((w) => {
              const hidden = cover && !peek[w.word];
              return h('div', {
                key: w.word,
                /* 整行右击 = 记住（等同「✓ 记住」），顺手把浏览器右键菜单压掉 */
                onContextMenu: (e) => { e.preventDefault(); if (w.level < maxLevel) move(w, 'know'); },
                title: '右击这一行 = 记住',
                style: {
                  display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px',
                  /* 没记住的次数越多越红：每次 +9%，封顶 54%（6 次起一样红） */
                  border: '1px solid ' + (w.misses ? mix(T.bad, Math.min(70, 25 + w.misses * 9)) : T.border),
                  borderRadius: 8,
                  background: w.misses ? `color-mix(in srgb, ${T.bad} ${Math.min(54, w.misses * 9)}%, ${T.bg2})` : T.bg2
                }
              },
                text({ flex: '0 0 170px', fontSize: 15, fontWeight: 600, color: T.label1, wordBreak: 'break-all' }, w.word),
                text({ flex: '0 0 34px', fontSize: 11, color: T.label3 }, `×${w.count}`),
                h('span', {
                  /* 按住才显示，松开 / 移出 / 取消都立刻重新遮住 */
                  onPointerDown: (e) => { if (cover && e.button === 0) setPeek((p) => ({ ...p, [w.word]: true })); },
                  onPointerUp: () => setPeek((p) => (p[w.word] ? { ...p, [w.word]: false } : p)),
                  onPointerLeave: () => setPeek((p) => (p[w.word] ? { ...p, [w.word]: false } : p)),
                  onPointerCancel: () => setPeek((p) => (p[w.word] ? { ...p, [w.word]: false } : p)),
                  title: cover ? '左键按住显示释义，松开隐藏；右击 = 记住' : '右击这一行 = 记住',
                  style: {
                    flex: 1, minWidth: 0, fontSize: 13, lineHeight: '20px', color: T.label2,
                    cursor: cover ? 'pointer' : 'default', filter: hidden ? 'blur(6px)' : 'none', touchAction: 'manipulation',
                    userSelect: hidden ? 'none' : 'auto'
                  }
                }, w.meaning || '（暂无释义）'),
                box({ display: 'flex', gap: 6, flex: '0 0 auto', alignItems: 'center' },
                  w.misses ? text({ fontSize: 11, color: T.bad, marginRight: 4, whiteSpace: 'nowrap' }, `没记住 ${w.misses} 次`) : null,
                  w.snoozed ? null : actionBtn('下次再记', T.warn, () => move(w, 'later')),
                  w.level > 0 ? actionBtn('✗ 忘了', T.bad, () => move(w, 'forget')) : null,
                  actionBtn(w.level >= maxLevel ? '✓ 已满级' : '✓ 记住', T.ok, () => move(w, 'know'), w.level >= maxLevel)));
            })),
        list.length > shown
          ? box({ display: 'flex', justifyContent: 'center' }, btn(false, `再显示 ${Math.min(VOCAB_PAGE, list.length - shown)} 个（剩 ${list.length - shown}）`, () => setShown((n) => n + VOCAB_PAGE)))
          : null);
    }

    /* ── ④ 画像 ──────────────────────────────────────────────────── */
    function ProfileView({ profile, onReload }) {
      if (!profile) {
        return box({ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' },
          box(body, '做满几句之后，这里显示你长期卡在哪一层。'),
          btn(false, '载入画像', onReload));
      }
      const [openedRec, setOpenedRec] = useState(null);
      const [recLoading, setRecLoading] = useState(false);
      /* 点历史条目：先拉这一句的全部批改，再按 ts 找到当次，展示明细 */
      const openRecord = async (rec) => {
        if (!rec) return;
        setRecLoading(true);
        try {
          const res = await apiPost('/attempts', { sentence: rec.sentence });
          const hit = (res.attempts || []).find((a) => a.ts === rec.ts) || null;
          setOpenedRec(hit);
        } catch { setOpenedRec(null); } finally { setRecLoading(false); }
      };
      const scoreLine = (r) => ['S', 'R', 'L', 'V', 'E']
        .map((k) => (r?.scores?.[k] == null ? null : `${k}${r.scores[k]}`))
        .filter(Boolean).join(' ') || '—';
      const p = profile.profile || {};
      if (!p.total) {
        return box({ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' },
          box(body, '还没有记录。批改过几次之后会自动累计。'),
          btn(false, '刷新', onReload));
      }
      return box({ display: 'flex', flexDirection: 'column', gap: 16 },
        box({ display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
          box(tinyLabel, `已诊断 ${p.total} 句`),
          btn(false, '刷新', onReload)),
        box({},
          box(sectionTitle, '各层正确率'),
          (p.rows || []).map((r) => box({ key: r.layer, display: 'flex', alignItems: 'center', gap: 12, marginBottom: 7 },
            text({ width: 44, fontSize: 12.5, color: T.label2 }, LAYER_NAME[r.layer] || r.layer),
            box({ flex: 1, height: 10, borderRadius: 5, background: T.bg3, border: '1px solid ' + T.border },
              box({ width: `${r.accuracy ?? 0}%`, height: '100%', background: LAYER_COLOR[r.layer], opacity: 0.75 })),
            text({ width: 70, fontSize: 11.5, color: T.label3, textAlign: 'right' },
              r.answered ? `${r.accuracy}%（${r.hit}/${r.answered}）` : '未测')))),
        p.dominant ? box({ ...cardStyle, padding: 12 },
          box({ fontSize: 14 }, `最常卡在：${LAYER_NAME[p.dominant[0]] || p.dominant[0]}`),
          box({ ...small, marginTop: 3 }, `占总诊断的 ${Math.round((p.dominant[1] / p.total) * 100)}%`)) : null,
        /* 历史列表：点一条看当次分数与卡点；有明细的还能回放「你当时怎么标的」 */
        (profile.records || []).length ? box({},
          box(sectionTitle, '批改历史'),
          box({ display: 'flex', flexDirection: 'column' },
            ...(profile.records || []).slice().reverse().slice(0, 30).map((r, i) => box({
              key: i, display: 'flex', gap: 8, alignItems: 'baseline', padding: '5px 0',
              borderBottom: '1px solid ' + T.border
            },
              text({ flex: '0 0 88px', fontSize: 11.5, color: T.label3 }, String(r.ts || '').replace('T', ' ').slice(5, 16)),
              box({ flex: 1, fontSize: 12, color: T.label1, wordBreak: 'break-word' }, String(r.sentence || '').slice(0, 90)),
              text({ flex: '0 0 auto', fontSize: 11.5, color: T.label3 }, scoreLine(r)),
              btn(false, r.hasDetail ? '回放' : '仅分数', () => openRecord(r), { disabled: recLoading })))),
          box({ ...small, marginTop: 4 }, '回放显示的是当次的标注与批改，不会改动你现在的作业。')) : null,
        openedRec ? box({ marginTop: 4 }, AttemptDetail({ attempt: openedRec })) : null
      );
    }

    /* ── 主页 ────────────────────────────────────────────────────── */
    function MainPage() {
      const [sentence, setSentence] = useState('');
      const [structure, setStructure] = useState(null);
      const [structureError, setStructureError] = useState('');
      const [loading, setLoading] = useState(false);
      const [ruleHints, setRuleHints] = useState(null);
      const [probes, setProbes] = useState(null);
      /* 规则引擎给的 probes（代词候选 / 否定范围），不花钱、不调模型。
         结构接口的 probes 优先，没有就用这一份 —— 保证「不分析也能练指代和逻辑」。 */
      const [ruleProbes, setRuleProbes] = useState(null);
      const [picked, setPicked] = useState(null);
      const [spans, setSpans] = useState([]);
      const [refs, setRefs] = useState([]);
      const [refPending, setRefPending] = useState(null);
      const [logicPairs, setLogicPairs] = useState([]);
      const [logicPending, setLogicPending] = useState(null);
      const [words, setWords] = useState([]);
      const [wordGuess, setWordGuess] = useState('');
      const [translation, setTranslation] = useState('');
      const [pickedRange, setPickedRange] = useState(null);
      const [graded, setGraded] = useState(null);
      const [grading, setGrading] = useState(false);
      const [showAnswer, setShowAnswer] = useState(false);
      const [step, setStep] = useState('structure');
      const [profile, setProfile] = useState(null);
      const [source, setSource] = useState('manual');
      const [papers, setPapers] = useState([]);
      const [paperName, setPaperName] = useState('');
      const [paperSentences, setPaperSentences] = useState([]);
      const [analyzed, setAnalyzed] = useState([]);
      const [paperIndex, setPaperIndex] = useState(0);
      const [llmReady, setLlmReady] = useState(null);
      const [error, setError] = useState('');
      /* 当前句的批改历史（左侧栏常驻列出）与正在回放的那一条 */
      const [sentenceAttempts, setSentenceAttempts] = useState([]);
      const [replayTs, setReplayTs] = useState(null);

      /* 当前正文的 ref：loadPaper 恢复进度时要按「此刻显示的那句」定位，
        用闭包里的 sentence 会拿到首次渲染的空值 */
      const sentenceRef = useRef('');
      useEffect(() => { sentenceRef.current = sentence; }, [sentence]);
      /* 句子文本比较：切句与模型回传可能差在引号/空白上，直接 === 会误判成「不在本文」 */
      const normSent = (s) => String(s ?? '')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
      /* 标注页不依赖结构分析：没有 structure 时按空格本地切词。
         这与后端 tokenize() 完全一致，批改时下标天然对齐 ——
         所以「先自己拆一遍」不该被「必须先分析」拦在门外。 */
      const tokens = structure?.tokens ?? (String(sentence ?? '').trim()
        ? String(sentence).trim().split(/\s+/)
        : []);

      const loadStatus = useCallback(async () => {
        try { const r = await apiGet('/status'); setLlmReady(r.llm); } catch { setLlmReady({ ready: false, reason: '状态未知' }); }
      }, []);

      const analyze = useCallback(async (value) => {
        const s = String(value ?? '').trim();
        if (!s) return;
        setStructureError('');
        setStructure(null);
        setSpans([]);
        setRefs([]); setRefPending(null);
        setLogicPairs([]); setLogicPending(null);
        setWords([]); setWordGuess(''); setTranslation('');
        setGraded(null);
        setPicked(null);
        setShowAnswer(false);
        setLoading(true);
        // 分析不强行跳步骤：在标注页点分析就地分析，别把人拽走
        setStep((prev) => (prev === 'profile' || prev === 'verdict' ? 'structure' : prev));
        try {
          // hints（风险提示）由 /structure 一并带回：规则引擎现算，缓存命中也照样有
          const res = await apiPost('/structure', { sentence: s });
          if (res.ok) {
            setStructure(res);
            setRuleHints(res.hints || null);
            setProbes(res.probes || null);
            setAnalyzed((prev) => (prev.includes(res.sentence) ? prev : [...prev, res.sentence]));
          } else setStructureError(res.error || '生成失败');
        } catch (err) {
          setStructureError(String(err?.message || err));
        } finally {
          setLoading(false);
        }
      }, []);

      /**
       * 换一句：只切句子，不自动分析。
       * 一次分析要 10–25 秒加一次模型调用，不该由「下一句」这种导航动作顺手触发；
       * 也不切步骤——在标注页翻句就该留在标注页。
       */
      const goToSentence = useCallback(async (idx) => {
        const item = paperSentences[idx];
        if (!item) return;
        setPaperIndex(idx);
        setSentence(item.text);
        setStructure(null);
        setStructureError('');
        setRuleHints(null);
        setProbes(null);      // 旧句的代词候选必须一起清掉，否则会串到下一句
        setSpans([]);
        setRefs([]); setRefPending(null);
        setLogicPairs([]); setLogicPending(null);
        setWords([]); setWordGuess(''); setTranslation('');
        setGraded(null);
        setPicked(null);
        setShowAnswer(false);
        // 只查缓存：这句以前分析过就直接载入，没分析过才轮到用户决定要不要花钱
        try {
          const hit = await apiPost('/structure', { sentence: item.text, cacheOnly: true });
          if (hit.cacheHit) { setStructure(hit); setRuleHints(hit.hints || null); }
        } catch { /* 查缓存失败就当没分析过 */ }
      }, [paperSentences]);

      // 序列号必须存在 ref 里：写在组件体内会被每次渲染重置，所有区间就都拿到同一个 id
      const seqRef = useRef(0);
      const nextId = () => { seqRef.current += 1; return seqRef.current; };

      const actions = {
        addRange: (start, end) => {
          // 点在已有区间里 = 选中它（再点成分标签就能命名），不要重复新建一段
          const hit = spans.find((x) => start >= x.start && start < x.end);
          if (hit) { setPickedRange(hit.id); return; }
          setSpans((prev) => [...prev, { id: nextId(), start, end, role: null }].sort((a, b) => a.start - b.start));
        },
        nameRange: (id, role) => setSpans((prev) => prev.map((s) => (s.id === id ? { ...s, role } : s))),
        removeRange: (id) => setSpans((prev) => prev.filter((s) => s.id !== id)),
        /** 点块上的「命名」选中它；再点成分标签就落到这一段 */
        pickRange: (id) => setPickedRange((prev) => (prev === id ? null : id)),
        /**
         * 点成分标签：优先给「手动选中的那一段」命名；
         * 没有选中段时退回给最后一个未命名段——两种路径都不依赖拖拽。
         */
        nameLatest: (role) => {
          setSpans((prev) => {
            let target = -1;
            if (pickedRange != null) {
              target = prev.findIndex((x) => x.id === pickedRange);
            }
            if (target < 0) {
              for (let i = prev.length - 1; i >= 0; i -= 1) {
                if (!prev[i].role) { target = i; break; }
              }
            }
            if (target < 0) return prev;
            const next = prev.slice();
            next[target] = { ...next[target], role };
            return next;
          });
          setPickedRange(null);
        },
        // sel 是闭区间（末位词也算），存进状态时统一转成开区间 [+start, +end+1)
        takePron: (span) => setRefPending({ start: span.start, end: span.end + 1 }),
        takeTarget: (span) => {
          setRefs((prev) => (refPending ? [...prev, { pron: refPending, target: { start: span.start, end: span.end + 1 } }] : prev));
          setRefPending(null);
        },
        removeRef: (i) => setRefs((prev) => prev.filter((_, x) => x !== i)),
        takeTrigger: (span) => setLogicPending({ start: span.start, end: span.end + 1 }),
        takeScope: (span) => {
          setLogicPairs((prev) => (logicPending ? [...prev, { trigger: logicPending, scope: { start: span.start, end: span.end + 1 } }] : prev));
          setLogicPending(null);
        },
        removeLogic: (i) => setLogicPairs((prev) => prev.filter((_, x) => x !== i)),
        commitWord: (span) => {
          setWords((prev) => [...prev, { start: span.start, end: span.end + 1, guess: wordGuess.trim() }]);
          setWordGuess('');
        },
        /* 只标记、不猜义：不确定时先画个 [?]，别编一个意思填进去——
           编出来的假义会污染整句译文（这是实测里最容易出事的一步）。 */
        commitMark: (span) => {
          setWords((prev) => [...prev, { start: span.start, end: span.end + 1, guess: '', unknown: true }]);
          setWordGuess('');
        },
        removeWord: (i) => setWords((prev) => prev.filter((_, x) => x !== i)),
        setGuess: setWordGuess,
        setTranslation: setTranslation,
        clearAll: () => {
          setSpans([]); setRefs([]); setRefPending(null);
          setLogicPairs([]); setLogicPending(null);
          setWords([]); setWordGuess(''); setTranslation('');
          setGraded(null);
        }
      };

      
      const runGrade = useCallback(async () => {
        // 不要求先分析结构：批改接口内部会拿到标准答案再对照
        const src = String(sentence ?? '').trim();
        if (!src) return;
        const hasWork = spans.some((x) => x.role) || refs.length || logicPairs.length || words.length || translation.trim();
        if (!hasWork) return;
        setGrading(true);
        setError('');
        try {
          const res = await apiPost('/annotate', {
            sentence: src,
            spans: spans.filter((x) => x.role).map((x) => ({ start: x.start, end: x.end, role: x.role })),
            refs: refs.map((r) => ({ pron: r.pron, target: r.target })),
            logic: logicPairs.map((p) => ({ trigger: p.trigger, scope: p.scope })),
            words: words.map((w) => ({ start: w.start, end: w.end, guess: w.guess, unknown: w.unknown === true })),
            translation
          });
          if (!res.ok) { setError(res.error || '批改失败'); return; }
          // 批改接口内部已经算过标准答案：顺手填进结构数据，
          // 省掉「批改完还得再点一次分析这一句」这一步
          setStructure((prev) => {
            if (prev?.parts?.length) return prev;
            const covSet = new Set();
            const walk = (arr) => (arr || []).forEach((p) => {
              for (let i = p?.start ?? 0; i < (p?.end ?? 0); i += 1) covSet.add(i);
              walk(p?.children);
            });
            walk(res.answer);
            const total = (res.tokens || []).length;
            return {
              sentence: res.sentence,
              tokens: res.tokens || [],
              translation: res.translation,
              parts: res.answer || [],
              cached: true,
              coverage: { covered: covSet.size, total, ratio: total ? covSet.size / total : 0 }
            };
          });
          /* 切到结果页放到「写完记录」之后：结果页挂载时会拉本句的批改历史 */
          setShowAnswer(false);
          // 只把「测到的层」计入画像；选择题那套已经废弃，画像只认标注批改
          try {
            await apiPost('/record', {
              sentence: src,
              layers: res.layers || {},
              primary: res.primary || undefined,
              wrongLayers: res.wrongLayers || [],
              scores: {
                S: res.S?.score ?? null,
                R: res.R?.score ?? null,
                L: res.L?.score ?? null,
                V: res.V?.score ?? null,
                E: res.E?.score ?? null
              },
              /* 明细一起存：以后「③ 结果」和「④ 画像」都能回放这一次是怎么标的、批改怎么说 */
              detail: {
                tokens: tokens.slice(0, 120),
                spans: spans.filter((x) => x.role).map((x) => ({ start: x.start, end: x.end, role: x.role })),
                refs: refs.map((r) => ({ pron: r.pron, target: r.target })),
                logic: logicPairs.map((p) => ({ trigger: p.trigger, scope: p.scope })),
                words: words.map((w) => ({ start: w.start, end: w.end, guess: w.guess, unknown: w.unknown === true })),
                translation,
                answer: res.answer || [],
                overall: res.overall ?? null,
                verdicts: {
                  S: res.S?.results ?? [], R: res.R?.results ?? [],
                  L: res.L?.results ?? [], V: res.V?.results ?? [],
                  E: res.E?.results ?? null
                }
              }
            });
          } catch { /* 记录失败不影响批改结果 */ }
          /* 记录写完再 setGraded：左侧「本句批改」列表会跟着刷新，
             早于此赋值就会少掉刚做完的这一条 */
          setGraded(res);
          setStep('verdict');
        } catch (err) {
          setError(String(err?.message || err));
        } finally {
          setGrading(false);
        }
      }, [sentence, structure, spans, refs, logicPairs, words, translation]);

      const loadProfile = useCallback(async () => {
        try { setProfile(await apiGet('/profile')); } catch (err) { setError(String(err?.message || err)); }
      }, []);

      // loadPaper 必须先于 loadPapers 定义：后者的依赖数组会立即求值（TDZ）
      const loadPaper = useCallback(async (name) => {
        if (!name) return;
        setLoading(true);
        try {
          const res = await apiGet('/paper?name=' + encodeURIComponent(name));
          const list = res.sentences || [];
          setPaperSentences(list);
          /* 恢复进度：当前正文若在这篇里就定位到它，否则才归零。
             以前无条件归零，会让「1/19」与实际显示的那句脱节，点下一句就跳到第 2 句 */
          const keep = normSent(sentenceRef.current);
          const at = keep ? list.findIndex((x) => normSent(x.text) === keep) : -1;
          setPaperIndex(at >= 0 ? at : 0);
          try {
            const c = await apiPost('/structure/cached', { sentences: list.map((x) => x.text) });
            setAnalyzed(c.analyzed || []);
          } catch { setAnalyzed([]); }
        } catch (err) { setError(String(err?.message || err)); } finally { setLoading(false); }
      }, []);

      const loadPapers = useCallback(async () => {
        try {
          const res = await apiGet('/papers');
          const list = res.papers || [];
          setPapers(list);
          if (list.length) {
            const found = list.some((p) => p.name === paperName);
            const name = found ? paperName : list[0].name;
            setPaperName(name);
            // 同一篇文章才保留进度；上次那篇如果已经不存在，进度必须归零
            if (!paperSentences.length) await loadPaper(name, found);
          }
        } catch (err) { setError(String(err?.message || err)); }
      }, [paperName, paperSentences.length, loadPaper]);

      // 打开面板就回到上次的位置：句子、步骤、句源都存本地
      useEffect(() => {
        try {
          if (typeof localStorage === 'undefined') return;
          const raw = localStorage.getItem(RESTORE_KEY);
          if (!raw) return;
          const st = JSON.parse(raw);
          if (st.sentence) setSentence(st.sentence);
          if (st.source === 'paper' || st.source === 'manual') setSource(st.source);
          if (st.paperName) setPaperName(st.paperName);
          if (typeof st.paperIndex === 'number') setPaperIndex(st.paperIndex);
          if (st.step) setStep(st.step);
          if (st.sentence) {
            // 只查缓存：上次分析过就秒回，没分析过就留一个「分析这一句」按钮
            apiPost('/structure', { sentence: st.sentence, cacheOnly: true })
              .then((hit) => {
                if (hit.cacheHit) { setStructure(hit); setRuleHints(hit.hints || null); setProbes(hit.probes || null); }
              })
              .catch(() => { /* 恢复失败不影响使用 */ });
          }
        } catch { /* 本地存储不可用 */ }
      }, []);

      useEffect(() => {
        try {
          if (typeof localStorage === 'undefined') return;
          localStorage.setItem(RESTORE_KEY, JSON.stringify({ sentence, source, step, paperName, paperIndex }));
        } catch { /* 本地存储不可用 */ }
      }, [sentence, source, step, paperName, paperIndex]);

      useEffect(() => { loadStatus(); }, [loadStatus]);
      useEffect(() => { if (source === 'paper' && !papers.length) loadPapers(); }, [source, papers.length, loadPapers]);
      useEffect(() => { if (step === 'profile' && !profile) loadProfile(); }, [step, profile, loadProfile]);
      /* 切句时用规则引擎取一次 probes（1ms、不花钱、不调模型）：
         这样即便这一句没分析过，指代候选与逻辑提示也能直接用。 */
      useEffect(() => {
        let alive = true;
        const s = String(sentence || '').trim();
        /* 先把旧结果清掉：切句瞬间若还留着上一句的 probes，
           界面会先渲染成「本句代词：that」这种完全不准的提示。 */
        setRuleProbes(null);
        if (!s) { return () => { alive = false; }; }
        (async () => {
          try {
            const res = await apiPost('/analyze', { sentence: s });
            if (alive && res.ok) setRuleProbes(res.probes || null);
          } catch { if (alive) setRuleProbes(null); }
        })();
        return () => { alive = false; };
      }, [sentence]);
      /* 换句或批改完成都重新拉「本句批改历史」——左侧栏常驻，切句回来不会丢 */
      useEffect(() => {
        let alive = true;
        const s = String(sentence || '').trim();
        if (!s) { setSentenceAttempts([]); return () => { alive = false; }; }
        setReplayTs(null);
        (async () => {
          try {
            const res = await apiPost('/attempts', { sentence: s });
            if (alive) setSentenceAttempts(res.attempts || []);
          } catch { if (alive) setSentenceAttempts([]); }
        })();
        return () => { alive = false; };
      }, [sentence, graded]);

      /** 点历史条目：用记录里的明细还原出「当次结果」，直接走结果页那套 UI */
      const replayAttempt = useCallback((a) => {
        const d = a && a.detail;
        const sc = (a && a.scores) || {};
        const nums = ['S', 'R', 'L', 'V', 'E'].map((k) => sc[k]).filter((x) => typeof x === 'number');
        const overall = (d && d.overall != null) ? d.overall : (nums.length ? Math.round(nums.reduce((s, x) => s + x, 0) / nums.length) : null);
        const v = (d && d.verdicts) || {};
        setReplayTs(a.ts);
        setGraded({
          sentence: a.sentence,
          tokens: (d && d.tokens) || [],
          answer: (d && d.answer) || [],
          translation: (d && d.translation) || '',
          overall,
          layers: a.layers || {},
          S: { results: v.S || [], score: sc.S ?? null },
          R: { results: v.R || [], score: sc.R ?? null },
          L: { results: v.L || [], score: sc.L ?? null },
          V: { results: v.V || [], score: sc.V ?? null },
          E: { results: v.E || null, score: sc.E ?? null }
        });
        setStructure((d && d.answer && d.answer.length)
          ? { sentence: a.sentence, tokens: d.tokens || [], translation: d.translation || '', parts: d.answer }
          : null);
        setShowAnswer(false);
        setStep('verdict');
        /* 旧记录没有明细：分数与卡点照常显示，只是看不到当时的标注内容 */
        setError(d ? '' : '这条是旧格式记录：只有分数与卡点，没有保存当时的标注明细。');
      }, []);

      const steps = [['structure', '① 结构'], ['annotate', '② 标注'], ['verdict', '③ 结果'], ['profile', '④ 画像']];
      const currentPaper = paperSentences[paperIndex];
      /* 翻页锚点以「当前正文」为准，paperIndex 只当回退值：
         手动输入的句子、或恢复时留下的陈旧索引，都会让索引与实际显示的那句脱节，
         按索引翻页就会跳到别处（显示第 1 句、实际是文章第 7 句）。 */
      const anchorIdx = paperSentences.findIndex((x) => normSent(x.text) === normSent(sentence));
      const inPaper = anchorIdx >= 0;
      const navBase = inPaper ? anchorIdx : paperIndex;

      // 即使 renderMain 自身同步抛错，也退化成错误卡片而不是白屏
      const safeMain = () => {
        try {
          return renderMain();
        } catch (err) {
          try { console.error('[dsh-english-coach] 主区渲染异常', err); } catch { /* 控制台不可用 */ }
          return h(ErrorCard, { error: err, context: step });
        }
      };

      const renderMain = () => {
        if (step === 'annotate') {
          return h(AnnotateView, {
            tokens,
            work: { spans, refs, refPending, logicPairs, logicPending, words, wordGuess, translation, pickedRange, probes: probes || ruleProbes },
            actions,
            onGrade: runGrade,
            grading
          });
        }
        if (step === 'verdict') {
          return h(VerdictView, {
            graded, tokens, structure, sentence,
            onShowAnswer: () => setShowAnswer((v) => !v),
            showAnswer
          });
        }
        if (step === 'profile') return h(ProfileView, { profile, onReload: loadProfile });
        if (step === 'vocab') return h(VocabView, null);

        if (structure || loading || structureError) {
          return h(StructureView, {
            structure, loading, error: structureError,
            ruleHints: ruleHints ? h(HintBlock, { hints: ruleHints }) : null,
            onPick: setPicked, picked
          });
        }
        // 已经选好句子但还没分析：给一句话的预览和一个按钮，别自动烧一次模型调用
        if (sentence.trim()) {
          return box({ ...cardStyle, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 },
            box({ ...tinyLabel }, '已选句子'),
            box({ fontSize: 14, lineHeight: '22px', color: T.label1 }, sentence.trim()),
            box({ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
              btn(true, '分析这一句', () => analyze(sentence)),
              text({ ...small }, '一次分析约 10–25 秒，同句第二次走缓存'))
          );
        }
        if (source === 'paper') {
          if (!paperSentences.length) {
            return box({ ...body, padding: '22px 0', textAlign: 'center' },
              loading ? '载入句子…' : '先在上方选一篇文章；没有可选文章说明 paper/ 目录为空。');
          }
          return box({},
            box({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10, gap: 12, flexWrap: 'wrap' },
              box(sectionTitle, `${paperName} · 共 ${paperSentences.length} 句`),
              text({ ...small }, analyzed.length
                ? `${analyzed.length} 句已分析（点开秒出） · 其余点一句先选中，再点「分析这一句」`
                : '点一句先选中它，再按「分析这一句」—不会自动花 token')),
            box({ display: 'flex', flexDirection: 'column', gap: 5 },
              paperSentences.map((s, i) => h('button', {
                key: i, type: 'button',
                /* 只选中，不自动分析：简单句可能不需要模型，别替用户决定花不花这一次调用 */
                onClick: () => { setPaperIndex(i); setSentence(s.text); },
                style: {
                  textAlign: 'left', padding: '8px 11px', borderRadius: 6, cursor: 'pointer',
                  border: '1px solid ' + (i === paperIndex ? T.accent : T.border),
                  background: i === paperIndex ? mix(T.accent, 10) : T.bg2,
                  color: T.label1, fontSize: 13, lineHeight: '20px', font: 'inherit'
                }
              }, box({ display: 'flex', gap: 10, alignItems: 'baseline' },
                text({ fontSize: 11, color: T.label3, flex: '0 0 30px' }, `#${i + 1}`),
                text({ fontSize: 11, color: T.label3, flex: '0 0 42px' }, `${s.words} 词`),
                box({ flex: 1, wordBreak: 'break-word' }, s.text),
                analyzed.includes(s.text)
                  ? text({ fontSize: 10.5, color: T.ok, flex: '0 0 auto' }, '● 已析')
                  : null)))));
        }
        return box({ ...body, padding: '22px 0', textAlign: 'center', whiteSpace: 'pre-line' },
          '贴一句英文，点「分析结构」。\n会给成分树和每段中文；然后去「② 标注」自己拆一遍，看看差在哪。');
      };

      return box({ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: T.bg1, color: T.label1 },
        box({ padding: '12px 20px', borderBottom: '1px solid ' + T.border, display: 'flex', flexDirection: 'column', gap: 9 },
          box({ display: 'flex', gap: 8, alignItems: 'center' },
            h('input', {
              value: sentence,
              placeholder: '粘贴一句读不懂的英文…',
              onChange: (e) => setSentence(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') analyze(sentence); },
              style: inputStyle
            }),
            btn(true, loading ? '分析中…' : '分析结构', () => analyze(sentence), { disabled: loading })),
          box({ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
            box({ display: 'flex', gap: 4 },
              [['manual', '手动输入'], ['paper', '阅读文章']].map(([k, label]) => h('button', {
                key: k, type: 'button',
                onClick: () => setSource(k),
                style: {
                  height: 25, padding: '0 10px', borderRadius: 6, font: 'inherit', fontSize: 12, cursor: 'pointer',
                  border: '1px solid ' + (source === k ? T.accent : T.border),
                  background: source === k ? mix(T.accent, 14) : 'transparent',
                  color: T.label1
                }
              }, label))),
            source === 'paper' ? box({ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', flex: 1 },
              h('select', {
                value: paperName,
                onChange: (e) => { setPaperName(e.target.value); loadPaper(e.target.value); },
                style: { ...inputStyle, flex: '0 0 160px', height: 27 }
              }, papers.map((p) => h('option', { key: p.name, value: p.name }, `${p.title} (${p.sentences})`))),
              paperSentences.length ? box({ display: 'flex', gap: 4, alignItems: 'center' },
                btn(false, '上一句', () => goToSentence(Math.max(0, navBase - 1)), { disabled: navBase === 0 }),
                text({ ...small, padding: '0 4px' }, inPaper
                  ? `${anchorIdx + 1}/${paperSentences.length}`
                  : (String(sentence).trim() ? `不在本文 · ${paperIndex + 1}/${paperSentences.length}` : `${paperIndex + 1}/${paperSentences.length}`)),
                btn(false, '下一句', () => goToSentence(Math.min(paperSentences.length - 1, navBase + 1)), { disabled: navBase >= paperSentences.length - 1 })) : null,
              paperSentences.length ? btn(false, '← 句子列表', () => {
                setStructure(null);
                setGraded(null);
                setSentence('');
                setStep('structure');
              }) : null
            ) : null,
            llmReady && !llmReady.ready ? text({ ...small, color: T.warn }, '模型未就绪：' + (llmReady.reason || '')) : null,
            error ? text({ ...small, color: T.bad }, error) : null)),

        box({ display: 'flex', flex: 1, minHeight: 0 },
          box({
            width: 140, flex: '0 0 140px', borderRight: '1px solid ' + T.border,
            padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto'
          },
            steps.map(([key, label]) => h('button', {
              key, type: 'button',
              onClick: () => setStep(key),
              style: {
                textAlign: 'left', padding: '7px 9px', borderRadius: 6, cursor: 'pointer',
                fontSize: 13, font: 'inherit',
                border: '1px solid ' + (step === key ? T.accent : 'transparent'),
                background: step === key ? mix(T.accent, 12) : 'transparent',
                color: step === key ? T.label1 : T.label2
              }
            }, label)),
            /* 生词模式：和句子无关，单独成组，放在四个步骤下面 */
            box({ marginTop: 10, paddingTop: 10, borderTop: '1px solid ' + T.border },
              h('button', {
                type: 'button',
                onClick: () => setStep('vocab'),
                style: {
                  width: '100%', textAlign: 'left', padding: '7px 9px', borderRadius: 6, cursor: 'pointer',
                  fontSize: 13, font: 'inherit',
                  border: '1px solid ' + (step === 'vocab' ? T.accent : 'transparent'),
                  background: step === 'vocab' ? mix(T.accent, 12) : 'transparent',
                  color: step === 'vocab' ? T.label1 : T.label2
                }
              }, '生词模式')),
            /* 本句批改历史：常驻在左侧，切句再回来也不丢；点一条即回放当次结果 */
            sentenceAttempts.length ? box({ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 },
              box({ fontSize: 11, color: T.label3, marginBottom: 2 }, `本句批改（${sentenceAttempts.length}）`),
              ...sentenceAttempts.slice().reverse().map((a, i) => h('button', {
                key: 'h' + i, type: 'button',
                onClick: () => replayAttempt(a),
                title: a.detail ? '回放这一次的标注与批改' : '旧记录，只有分数',
                style: {
                  textAlign: 'left', padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
                  fontSize: 11.5, font: 'inherit', lineHeight: '17px',
                  border: '1px solid ' + (replayTs === a.ts ? T.accent : T.border),
                  background: replayTs === a.ts ? mix(T.accent, 12) : 'transparent',
                  color: replayTs === a.ts ? T.label1 : T.label2
                }
              }, `第 ${a.seq} 次 · ${['S', 'R', 'L', 'V', 'E'].map((k) => (a.scores?.[k] == null ? null : k + a.scores[k])).filter(Boolean).join(' ') || '—'}`))) : null,
            graded ? box({ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 3 },
              box(tinyLabel, replayTs ? '回放·当次总分' : '本句得分'),
              box({ fontSize: 20, fontWeight: 700 }, String(graded.overall ?? graded.score ?? '—')),
              graded.coverage != null ? box({ ...small }, `覆盖 ${graded.coverage}% · 准确 ${graded.precision}%`) : null) : null,
            (spans.length + refs.length + logicPairs.length + words.length + (translation.trim() ? 1 : 0))
              ? box({ marginTop: 12, ...small }, `已填 ${spans.length + refs.length + logicPairs.length + words.length + (translation.trim() ? 1 : 0)} 项`)
              : null),

          box({ flex: 1, minWidth: 0, overflowY: 'auto' },
            box({ maxWidth: CONTENT_MAX, margin: '0 auto', padding: '18px 22px 40px' },
              h(Boundary, null, safeMain())))
        )
      );
    }

    /* ── 规则引擎的风险提示（结构页底部，补充 LLM 给不了的东西）──── */
    function HintBlock({ hints }) {
      if (!hints) return null;
      const rows = [];
      /* 固定块：逐词拼不出来的东西，紧跟风险提示单独成块（L3 形式冻结 / L2 粘合搭配） */
      const fixedRows = [];
      (hints.fixed || []).forEach((x) => fixedRows.push([
        `${x.level || 'L3'} ${x.kind || '固定句式'}`,
        `${x.text} = ${x.meaning}`,
        x.note || ''
      ]));
      (hints.phrases || []).forEach((p) => fixedRows.push(['L2 固定搭配', `${p.phrase} = ${p.meaning}`, '']));
      /* 特殊句式：结构被改过、必须还原语序才能读（倒装 / 强调 / 省略 / 独立主格）*/
      const specialRows = (hints.special || []).map((x) => [x.kind || '特殊句式', x.text || '', x.why || '', x.fix || '']);
      (hints.hiddenSenses || []).forEach((p) => rows.push(['熟词僻义', `${p.word}：${p.sense}`]));
      (hints.academic || []).forEach((p) => rows.push(['学术词义项', `${p.word}：${p.sense}`]));
      if ((hints.negations || []).length) rows.push(['否定', `${hints.negations.join('、')} —— 先确定管到哪`]);
      if ((hints.subjunctive || []).length) rows.push(['虚拟', hints.subjunctive.join('、')]);
      (hints.inversion || []).forEach((x) => rows.push(['倒装/特殊句式', x]));
      (hints.cleft || []).forEach((x) => rows.push(['特殊句式', x]));
      if (hints.passive) rows.push(['被动', '中文可改主动，或加「被/受到/得到」']);
      /* rows 为空时也要能只显示固定块，所以空判定挪到最后 */
      const warnBlock = rows.length ? box({ marginTop: 6 },
        box(sectionTitle, '风险提示（查了词还是译不出的常见原因）'),
        box({ display: 'flex', flexDirection: 'column', gap: 5 },
          rows.map(([k, v], i) => box({ key: i, display: 'flex', gap: 10, alignItems: 'baseline' },
            text({ flex: '0 0 auto', fontSize: 12, color: T.warn }, k),
            text({ ...body, flex: 1 }, v))))) : null;
      const fixedBlock = fixedRows.length ? box({ marginTop: warnBlock ? 12 : 0 },
        box(sectionTitle, '固定句式 / 固定短语（整块读，别逐词拼）'),
        box({ display: 'flex', flexDirection: 'column', gap: 6 },
          fixedRows.map(([k, v, note], i) => box({ key: i, display: 'flex', flexDirection: 'column', gap: 2 },
            box({ display: 'flex', gap: 10, alignItems: 'baseline' },
              text({ flex: '0 0 auto', fontSize: 12, color: T.accent }, k),
              text({ ...body, flex: 1 }, v)),
            note ? text({ fontSize: 12, color: T.label3, lineHeight: '18px' }, note) : null)))) : null;
      if (!warnBlock && !fixedBlock && !specialRows.length) return null;
      const specialBlock = specialRows.length ? box({ marginTop: 12 },
        box(sectionTitle, '特殊句式（先还原语序再读）'),
        box({ display: 'flex', flexDirection: 'column', gap: 7 },
          specialRows.map(([kind, snippet, why, fix], i) => box({ key: i, display: 'flex', flexDirection: 'column', gap: 2 },
            box({ display: 'flex', gap: 8, alignItems: 'baseline' },
              text({ flex: '0 0 auto', fontSize: 12, color: T.warn }, kind),
              text({ flex: 1, fontSize: 12.5, color: T.label1, wordBreak: 'break-word' }, snippet || why)),
            why && snippet ? text({ fontSize: 12, color: T.label3, lineHeight: '18px' }, `判据：${why}`) : null,
            fix ? text({ fontSize: 12, color: T.accent, lineHeight: '18px' }, `怎么读：${fix}`) : null)))) : null;
      return box(null, warnBlock, fixedBlock, specialBlock);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        if (!ctx.slots || typeof ctx.slots.inject !== 'function') return;

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: PANEL_ORDER,
          label: () => '句子诊断'
        }, SidebarIcon));

        let onClose = null;
        try {
          const layout = typeof ctx.get === 'function' ? ctx.get('layout') : ctx.layout;
          if (layout && typeof layout.selectPanel === 'function') {
            onClose = () => { try { layout.selectPanel(null); } catch { /* 宿主未就绪 */ } };
          }
        } catch { /* layout 缺席是合法配置 */ }

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          inject: () => ({ onClose })
        }, MainPage));
      }
    };
  }
});