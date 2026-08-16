/* highlighter.js — 语法高亮器
 * 经典 <script> 标签加载（非模块，禁用 require/import/export），只暴露 window.SyntaxHighlighter。
 * 安全模型：先转义 & < > "（& → &amp; 等），再在转义后的文本上做 token 标记，
 * 任何用户原始内容都不会进入输出 HTML。
 * 公共 API：highlight(code, lang) → HTML 字符串（不支持的语言返回转义纯文本）；supports(lang) → boolean。
 * 语言/别名：js/javascript、ts/typescript、html/xml/svg、css、json、py/python、sh/bash/shell。
 * Token 分类（class="tok tok-xxx"）：keyword string number comment function tag attr punctuation operator boolean */
(function () {
  'use strict'

  // ---------- HTML 转义 ----------
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
  function escapeHtml(str) { return String(str).replace(/[&<>"]/g, function (c) { return ESC[c] }) }

  // ---------- 正则辅助 ----------
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
  function keywordRe(words) {
    var list = words.slice().sort(function (a, b) { return b.length - a.length })
    return new RegExp('\\b(?:' + list.join('|') + ')\\b')
  }

  // ---------- 通用 token 正则（作用在转义后的文本上；双引号串是 &quot;...&quot;） ----------
  var STR_SINGLE = /'(?:\\.|[^'\\\n])*'/
  var STR_DOUBLE = /&quot;(?:\\.|[^&\\\n]|&(?!quot;))*&quot;/
  var STR_TEMPLATE = /`(?:\\.|[^`\\\n])*`/
  var CMT_LINE_JS = /\/\/[^\n]*/, CMT_BLOCK = /\/\*[\s\S]*?\*\//, CMT_HASH = /#[^\n]*/
  var NUMBER = /\b(?:0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/

  // 运算符（转义形态，按长度降序保证最长匹配优先）
  var OP_MASTER = new RegExp('&amp;&amp;= &amp;&amp; &amp;= &lt;&lt;= &gt;&gt;&gt;= &gt;&gt;&gt; &gt;&gt;= &lt;&lt; &gt;&gt; &lt;= &gt;= &lt; &gt; &amp; === !== == != =&gt; ||= || ??= ?? ?. ? **= ** *= += -= /= %= ++ -- = + - * / % ! ~ ^ |'.split(' ').map(escapeRe).join('|'))
  var PUNCT = /[(){}[\];,:.]+/                  // () {} [] ; , : .
  var FUNC_JS = /[A-Za-z_$][\w$]*(?=\s*\()/     // 标识符 + 括号 → 函数
  var FUNC_WORD = /[A-Za-z_]\w*(?=\s*\()/

  // ---------- JavaScript / TypeScript ----------
  var JS_RULES = [
    ['comment', CMT_LINE_JS], ['comment', CMT_BLOCK],
    ['string', STR_SINGLE], ['string', STR_DOUBLE], ['string', STR_TEMPLATE],
    ['number', NUMBER],
    ['boolean', keywordRe('true false null undefined NaN Infinity'.split(' '))],
    ['keyword', keywordRe('abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface let module namespace new of private protected public readonly return set static super switch satisfies this throw try type typeof var void while with yield'.split(' '))],
    ['function', FUNC_JS], ['operator', OP_MASTER], ['punctuation', PUNCT]
  ]

  // ---------- Python ----------
  var PY_RULES = [
    ['comment', CMT_HASH],
    ['string', /'''(?:\\.|[^'\\]|'(?!''))*?'''/],               // '''...'''
    ['string', /&quot;&quot;&quot;[\s\S]*?&quot;&quot;&quot;/], // """..."""
    ['string', STR_SINGLE], ['string', STR_DOUBLE],
    ['number', NUMBER],
    ['boolean', keywordRe('True False None'.split(' '))],
    ['keyword', keywordRe('and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return self try while with yield'.split(' '))],
    ['function', FUNC_WORD], ['operator', OP_MASTER], ['punctuation', PUNCT]
  ]

  // ---------- Shell / Bash ----------
  var SH_RULES = [
    ['comment', CMT_HASH],
    ['string', /'[^'\n]*'/], ['string', STR_DOUBLE], ['string', /`[^`\n]*`/],
    ['boolean', keywordRe('true false'.split(' '))],
    ['number', /\b\d+(?:\.\d+)?\b/],
    ['keyword', keywordRe('if then else elif fi for while until do done case esac in function return exit export local readonly break continue shift source alias unset set echo printf cd pwd ls cat grep sed awk rm mv cp mkdir touch chmod chown tar find curl wget git sudo apt npm node python pip'.split(' '))],
    ['function', FUNC_WORD], ['operator', OP_MASTER], ['punctuation', PUNCT]
  ]

  // ---------- CSS ----------
  var CSS_RULES = [
    ['comment', CMT_BLOCK], ['string', STR_SINGLE], ['string', STR_DOUBLE],
    ['number', /#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|ex|ch|vh|vw|vmin|vmax|%|s|ms|deg|rad|grad|turn|fr|cm|mm|in|pt|pc)?(?![A-Za-z0-9])/],
    ['keyword', /@[a-z-]+/],
    ['keyword', keywordRe('display position top right bottom left z-index float clear overflow overflow-x overflow-y width height min-width max-width min-height max-height margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left color background background-color background-image background-size background-position background-repeat opacity border border-top border-right border-bottom border-left border-color border-width border-style border-radius font font-family font-size font-weight font-style line-height text-align text-decoration text-transform text-shadow letter-spacing word-spacing white-space vertical-align content flex flex-direction flex-wrap justify-content align-items align-content grid grid-template-columns gap column-gap row-gap transform transition animation box-shadow box-sizing cursor visibility list-style filter'.split(' '))],
    ['keyword', /!important/],
    ['function', /[A-Za-z-]+(?=\s*\()/],
    ['operator', /[>+~*|^$]/],
    ['punctuation', /[(){}[\];:,]+/]
  ]

  // ---------- JSON ----------
  var JSON_RULES = [
    ['comment', CMT_LINE_JS], ['comment', CMT_BLOCK],  // 容错：JSONC 风格
    ['string', STR_DOUBLE], ['string', STR_SINGLE],
    ['number', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
    ['boolean', keywordRe('true false null'.split(' '))],
    ['punctuation', /[{}[\],:]+/]
  ]

  var RULES_BY_LANG = { javascript: JS_RULES, typescript: JS_RULES, css: CSS_RULES, json: JSON_RULES, python: PY_RULES, shell: SH_RULES }

  // ---------- HTML / XML / SVG（专用状态机，区分标签名/属性/属性值） ----------
  var NAME_CHAR = /[\w.:-]/
  function isTagStart(escaped, i) {  // &lt; 之后是否紧跟合法标签名
    if (!escaped.startsWith('&lt;', i)) return false
    var j = escaped.startsWith('&lt;/', i) ? i + 5 : i + 4
    var c = escaped[j]
    return c !== undefined && /[A-Za-z_:]/.test(c)
  }
  function findTagEnd(escaped, from) {  // 找标签结束的 &gt;（跳过引号内的）
    var n = escaped.length, i = from + 4, quote = null  // null | 'd' | 's'
    while (i < n) {
      if (quote === 'd') {
        if (escaped.startsWith('&quot;', i)) { quote = null; i += 6 } else { i++ }
      } else if (quote === 's') {
        if (escaped[i] === "'") { quote = null; i++ } else { i++ }
      } else if (escaped.startsWith('&quot;', i)) { quote = 'd'; i += 6 }
      else if (escaped[i] === "'") { quote = 's'; i++ }
      else if (escaped.startsWith('&gt;', i)) { i += 4; break }
      else { i++ }
    }
    return i
  }
  function parseAttrValue(body, i, n, tokens) {  // &quot;...&quot; / '...' / 无引号值
    var close, end, v
    if (body.startsWith('&quot;', i)) {
      close = body.indexOf('&quot;', i + 6); end = close === -1 ? n : close + 6
      tokens.push(['string', body.slice(i, end)]); return end
    }
    if (body[i] === "'") {
      close = body.indexOf("'", i + 1); end = close === -1 ? n : close + 1
      tokens.push(['string', body.slice(i, end)]); return end
    }
    v = i
    while (v < n && !/\s/.test(body[v]) && !body.startsWith('&gt;', v) && !body.startsWith('/&gt;', v)) v++
    tokens.push(['string', body.slice(i, v)])
    return v
  }
  function tokenizeTagBody(body) {  // &lt;div class=&quot;x&quot;&gt; / &lt;/div&gt; / &lt;img /&gt;
    var tokens = [], i, n = body.length, start, k, v
    if (body.startsWith('&lt;/')) { tokens.push(['punctuation', '&lt;/']); i = 5 }
    else { tokens.push(['punctuation', '&lt;']); i = 4 }
    start = i
    while (i < n && NAME_CHAR.test(body[i])) i++  // 标签名
    if (i > start) tokens.push(['tag', body.slice(start, i)])
    while (i < n) {  // 属性与收尾
      if (body.startsWith('/&gt;', i)) { tokens.push(['punctuation', '/&gt;']); i += 5; break }
      if (body.startsWith('&gt;', i)) { tokens.push(['punctuation', '&gt;']); i += 4; break }
      if (/\s/.test(body[i])) {
        start = i
        while (i < n && /\s/.test(body[i])) i++
        tokens.push(['plain', body.slice(start, i)])
        continue
      }
      if (/[A-Za-z_:]/.test(body[i])) {  // 属性名
        start = i
        while (i < n && NAME_CHAR.test(body[i])) i++
        tokens.push(['attr', body.slice(start, i)])
        k = i
        while (k < n && /\s/.test(body[k])) k++
        if (body[k] === '=') {
          if (k > i) tokens.push(['plain', body.slice(i, k)])
          tokens.push(['operator', '='])
          i = k + 1
          v = i
          while (v < n && /\s/.test(body[v])) v++
          if (v > i) tokens.push(['plain', body.slice(i, v)])
          i = parseAttrValue(body, v, n, tokens)
        }  // 布尔属性：i 停在属性名后继续循环
      } else { tokens.push(['plain', body[i]]); i++ }
    }
    return tokens
  }
  function tokenizeHtml(escaped) {  // 注释 > 标签 > 普通文本
    var tokens = [], i = 0, n = escaped.length, close, next, end
    while (i < n) {
      if (escaped.startsWith('&lt;!--', i)) {
        close = escaped.indexOf('--&gt;', i + 7)  // '--&gt;' 是 6 个字符
        if (close !== -1) { tokens.push(['comment', escaped.slice(i, close + 6)]); i = close + 6; continue }
      }
      if (escaped.startsWith('&lt;', i) && isTagStart(escaped, i)) {
        end = findTagEnd(escaped, i)
        tokens = tokens.concat(tokenizeTagBody(escaped.slice(i, end)))
        i = end
        continue
      }
      if (escaped.startsWith('&lt;', i)) { tokens.push(['plain', '&lt;']); i += 4; continue }  // 非标签 <
      next = escaped.indexOf('&lt;', i)
      if (next === -1) { tokens.push(['plain', escaped.slice(i)]); break }
      tokens.push(['plain', escaped.slice(i, next)])
      i = next
    }
    return tokens
  }

  // ---------- 通用正则 tokenizer（合并为单个 master 正则，交替顺序即优先级） ----------
  function tokenize(escaped, rules) {
    var master = new RegExp(rules.map(function (r) { return '(' + r[1].source + ')' }).join('|'), 'g')
    var tokens = [], last = 0, m, g, type
    while ((m = master.exec(escaped)) !== null) {
      if (m[0].length === 0) { master.lastIndex++; continue }  // 防御空匹配
      if (m.index > last) tokens.push(['plain', escaped.slice(last, m.index)])
      type = 'plain'
      for (g = 1; g < m.length; g++) {
        if (m[g] !== undefined) { type = rules[g - 1][0]; break }
      }
      tokens.push([type, m[0]])
      last = m.index + m[0].length
    }
    if (last < escaped.length) tokens.push(['plain', escaped.slice(last)])
    return tokens
  }
  function render(tokens) {  // token → HTML（文本已转义，直接拼接）
    var html = '', i, t
    for (i = 0; i < tokens.length; i++) {
      t = tokens[i]
      if (t[0] === 'plain') html += t[1]
      else html += '<span class="tok tok-' + t[0] + '">' + t[1] + '</span>'
    }
    return html
  }

  // ---------- 语言归一化与公共 API ----------
  var SUPPORTED = { javascript: 1, typescript: 1, html: 1, css: 1, json: 1, python: 1, shell: 1 }
  var ALIASES = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', javascript: 'javascript',
    ts: 'typescript', tsx: 'typescript', typescript: 'typescript',
    py: 'python', py3: 'python', python: 'python',
    sh: 'shell', bash: 'shell', shell: 'shell', zsh: 'shell',
    html: 'html', htm: 'html', xhtml: 'html', xml: 'html', svg: 'html',
    css: 'css', scss: 'css', less: 'css',
    json: 'json', jsonc: 'json',
    md: 'markdown', markdown: 'markdown', mdown: 'markdown'
  }
  function normalizeLang(lang) {
    var key = String(lang == null ? '' : lang).trim().toLowerCase()
    return ALIASES[key] || key
  }
  function supports(lang) { return !!SUPPORTED[normalizeLang(lang)] }
  function highlight(code, lang) {
    var text = String(code == null ? '' : code)
    var escaped = escapeHtml(text)
    var canonical = normalizeLang(lang)
    if (canonical === 'html') return render(tokenizeHtml(escaped))
    var rules = RULES_BY_LANG[canonical]
    if (!rules) return escaped  // 不支持的语言：返回转义后的纯文本
    return render(tokenize(escaped, rules))
  }

  window.SyntaxHighlighter = { highlight: highlight, supports: supports }
})()
