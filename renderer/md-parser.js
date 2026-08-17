/* ================================================================
 * md-parser.js — 简易 Markdown → HTML 解析器
 *
 * 通过经典 <script src> 在渲染进程加载（非模块，禁用 require/import/export）。
 * 只暴露唯一全局对象 window.MarkdownParser。
 *
 * 安全说明：输出会被 innerHTML 插入页面，故 Markdown 中所有原始 HTML
 * 一律按普通字符转义（& → &amp;，< → &lt;，> → &gt;，" → &quot;），
 * 行内代码、围栏代码块内容同样先转义再包裹标签，绝不透传原始 HTML。
 *
 * 公共 API：
 *   window.MarkdownParser.parse(mdText)
 *     → { html: string, languages: string[] }
 *   html      完整渲染后的 HTML 字符串
 *   languages 检测到的围栏代码块语言列表（去重）
 * ================================================================ */
(function () {
  'use strict'

  // 模块级语言集合：parse() 开始时清空，围栏解析时累加
  var languages = []

  /* ---------------- 转义与安全 ----------------
   * 顺序：& 必须最先处理，否则会把后来插入的 &amp; 再转一次。
   */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  // URL 安全校验：拦截可执行协议，放行 http/https/mailto/file/相对路径 等
  function isSafeUrl(url) {
    return !/^(javascript|vbscript|data):/i.test(String(url).trim())
  }

  /* ---------------- 行内解析 ----------------
   * renderInline(raw)      接收原始文本，先整体转义再做行内格式化
   * renderInlineEscaped(t) 接收已转义文本（递归复用，避免双重转义）
   * 策略：把“行内代码 / 图片 / 链接”先替换成 \x00 占位符，避免后续
   * 加粗 / 斜体正则误伤代码内容或标签属性，最后统一还原占位符。
   */
  function renderInline(raw) {
    return renderInlineEscaped(escapeHtml(String(raw)))
  }

  function renderInlineEscaped(text) {
    var parts = [] // 占位符对应内容
    function token(html) {
      parts.push(html)
      return '\x00T' + (parts.length - 1) + '\x00'
    }

    // 行内代码 → 占位符（内容已转义，[^\n] 避免跨行匹配）
    text = text.replace(/`([^`\n]+)`/g, function (m, code) {
      return token('<code>' + code + '</code>')
    })

    // 图片：![alt](src)，URL 允许一层平衡圆括号（如 wiki 式链接）
    text = text.replace(/!\[([^\]]*)\]\(((?:[^()]|\([^()]*\))*)\)/g, function (m, alt, src) {
      src = src.split(/\s+/)[0] // 去掉可选的 "title"
      if (!isSafeUrl(src)) return m // 不安全协议：原样输出（已转义）
      return token('<img src="' + src + '" alt="' + alt + '">')
    })

    // 链接：[text](url)，text 递归做行内格式化（支持加粗里套行内代码）
    text = text.replace(/\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)/g, function (m, label, url) {
      url = url.split(/\s+/)[0] // 去掉可选的 "title"
      if (!isSafeUrl(url)) return label // 不安全协议：只显示文字
      return token('<a href="' + url + '">' + renderInlineEscaped(label) + '</a>')
    })

    // 双向链接：[[目标]] 或 [[目标|别名]] → wikilink（Obsidian 风格，点击跳转由前端处理）
    // 注意需放在普通链接之后：wikilink 语法不含 "](url)"，不会被链接正则吞掉
    text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, function (m, target, alias) {
      var shown = (alias != null && alias !== '') ? alias : target
      return token('<a class="wikilink" data-target="' + escapeHtml(target.trim()) + '">'
        + renderInlineEscaped(shown.trim()) + '</a>')
    })

    // 高亮 ==text==（Emerald 淡绿色；放在加粗之前，使 **==x==** / ==**x**== 都能渲染）
    text = text.replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
    // 加粗 **text**
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // 删除线 ~~text~~
    text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // 斜体 *text*（成对的 ** 已被加粗消费，剩余的单个 * 才是斜体）
    text = text.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>')

    // 还原行内代码 / 图片 / 链接
    return text.replace(/\x00T(\d+)\x00/g, function (m, idx) {
      return parts[+idx]
    })
  }

  /* ---------------- 块级判定辅助 ---------------- */
  function isFenceStart(line) {
    return /^(`{3,}|~{3,})/.test(line.trim()) // 围栏代码开头
  }

  function isHr(line) {
    return /^\s*([-*_])\s*\1\s*\1+\s*$/.test(line) // 3 个及以上 - * _
  }

  function isListStart(line) {
    return /^\s*([-*+]|\d+\.)\s+/.test(line) // - * + 或 数字.
  }

  // 表格分隔行：| --- | --- |，必须含管道符与至少 3 个连字符
  function isTableSeparator(line) {
    if (!line) return false
    var t = line.trim()
    return t.indexOf('|') !== -1 && /^[\s|:|-]+$/.test(t) && /-{3,}/.test(t)
  }

  // 判断某行是否为块级起点（用于结束段落的收集）
  function isBlockStart(lines, i) {
    var line = lines[i]
    var t = line.trim()
    if (!t) return false
    if (/^#{1,6}\s+/.test(line)) return true // 标题
    if (isHr(line)) return true // 分割线
    if (/^\s*>\s?/.test(line)) return true // 引用
    if (isListStart(line)) return true // 列表
    if (isFenceStart(t)) return true // 围栏代码
    if (t.startsWith('|') && isTableSeparator(lines[i + 1])) return true // 表格
    return false
  }

  /* ---------------- 块级解析 ---------------- */
  // 主循环：逐行识别并渲染各类块元素。
  // annotate=true（默认）时给每个顶层块包一层 <div class="blk" data-s data-e>，
  // 记录它在源文档中的行号区间——供"所见即所得"编辑器点击块时还原原始 Markdown。
  // 嵌套解析（blockquote 内部）传 false，避免行号错乱（行号相对内层缓冲，不是原文档）。
  function parseBlocks(lines, annotate) {
    var out = []
    var i = 0
    var n = lines.length
    while (i < n) {
      var t = lines[i].trim()
      if (t === '') {
        // 空行作为独立可编辑块（所见即所得：空行可见、可点击、连续换行可续编）。
        // annotate=false（blockquote 内部递归）不产出，保持块级分隔语义。
        if (annotate !== false) {
          out.push('<div class="blk" data-s="' + i + '" data-e="' + i + '"><p class="md-empty"></p></div>')
        }
        i++
        continue
      }
      var start = i
      var blockHtml
      if (isFenceStart(t)) {
        var fence = parseFence(lines, i)
        blockHtml = fence.html
        i = fence.nextIndex
      } else if (/^#{1,6}\s+/.test(lines[i])) {
        blockHtml = parseHeading(lines[i])
        i++
      } else if (isHr(lines[i])) {
        blockHtml = '<hr>'
        i++
      } else if (/^\s*>\s?/.test(lines[i])) {
        var bq = parseBlockquote(lines, i)
        blockHtml = bq.html
        i = bq.nextIndex
      } else if (t.startsWith('|') && isTableSeparator(lines[i + 1])) {
        var table = parseTable(lines, i)
        blockHtml = table.html
        i = table.nextIndex
      } else if (isListStart(lines[i])) {
        var list = parseList(lines, i)
        blockHtml = list.html
        i = list.nextIndex
      } else {
        var para = parseParagraph(lines, i, annotate)
        blockHtml = para.html
        i = para.nextIndex
      }
      if (annotate !== false) {
        out.push('<div class="blk" data-s="' + start + '" data-e="' + (i - 1) + '">' + blockHtml + '</div>')
      } else {
        out.push(blockHtml)
      }
    }
    return out.join('\n')
  }

  // 围栏代码块：```lang 到 ```，内容整体转义，lang 加入 languages
  function parseFence(lines, i) {
    var t = lines[i].trim()
    var m = /^(`{3,}|~{3,})(.*)$/.exec(t)
    var fenceChar = m[1][0]
    var fenceLen = m[1].length
    var lang = (m[2] || '').trim().split(/\s+/)[0] || ''
    if (lang && languages.indexOf(lang) === -1) languages.push(lang) // 去重

    var closeRe = new RegExp('^\\s*' + fenceChar + '{' + fenceLen + ',}\\s*$')
    var buf = []
    i++
    while (i < lines.length && !closeRe.test(lines[i])) {
      buf.push(lines[i])
      i++
    }
    i++ // 跳过结束围栏（没有结束围栏时恰好停在末尾）

    var attr = ''
    if (lang) {
      var safeLang = escapeHtml(lang)
      attr = ' class="language-' + safeLang + '" data-lang="' + safeLang + '"'
    }
    return {
      html: '<pre><code' + attr + '>' + escapeHtml(buf.join('\n')) + '</code></pre>',
      nextIndex: i,
    }
  }

  // 标题：#~###### → <h1>~<h6>
  function parseHeading(line) {
    var m = /^(#{1,6})\s+(.*)$/.exec(line.trim())
    var level = m[1].length
    var content = m[2].trim().replace(/[ \t]+#+$/, '') // 去掉末尾 #（需空格前缀）
    return '<h' + level + '>' + renderInline(content) + '</h' + level + '>'
  }

  // 引用：连续 > 行，去掉 > 后递归解析内部块
  function parseBlockquote(lines, i) {
    var buf = []
    while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
      buf.push(lines[i].replace(/^\s*>\s?/, ''))
      i++
    }
    return { html: '<blockquote>' + parseBlocks(buf, false) + '</blockquote>', nextIndex: i }
  }

  // 段落：空行或块级起点之间；段内单个换行 → <br>
  function parseParagraph(lines, i, annotate) {
    var start = i
    var buf = []
    while (i < lines.length && !isBlockStart(lines, i)) {
      var t = lines[i].trim()
      if (t === '') break
      buf.push(t)
      i++
    }
    var html
    if (buf.length === 1 || annotate === false) {
      // 单行段落 / 嵌套（blockquote 内部，行号相对，不可用于逐行编辑）：合并渲染
      html = renderInline(buf.join('\n')).replace(/\n/g, '<br>\n')
    } else {
      // 顶层软换行段落：逐行渲染并标记 data-line，支持逐行独立编辑（Obsidian 行为）
      html = buf.map(function (ln, k) {
        return '<span class="md-line" data-line="' + (start + k) + '">' + renderInline(ln) + '</span>'
      }).join('<br>\n')
    }
    return {
      html: '<p>' + html + '</p>',
      nextIndex: i,
    }
  }

  /* ---------------- 列表（简单嵌套：缩进越深层级越深） ---------------- */
  function parseList(lines, i) {
    var items = []
    var n = lines.length
    var firstType = null
    var firstIndent = null

    while (i < n) {
      var line = lines[i]
      var m = /^(\s*)([-*+]|\d+\.)\s+/.exec(line)
      if (!m || isHr(line)) break
      var type = /^[-*+]$/.test(m[2]) ? 'ul' : 'ol'
      var indent = m[1].length

      // 同层不同列表类型（如 - 后接 1.）视为新列表，结束当前收集
      if (firstType === null) {
        firstType = type
        firstIndent = indent
      } else if (type !== firstType && indent === firstIndent) {
        break
      }

      var item = { indent: indent, type: type, content: line.slice(m[0].length), lineNo: i + 1 }
      // 任务列表：- [ ] / - [x] → task 标记（勾选态由 [x] 决定），正文去掉 "[ ] " 前缀
      var tm = /^\[( |x|X)\]\s+/.exec(item.content)
      if (tm) {
        item.task = tm[1] === 'x' || tm[1] === 'X'
        item.content = item.content.slice(tm[0].length)
      }
      items.push(item)
      i++
      // 合并本条目的延续行（非空、非块级起点的普通文本）
      while (i < n && lines[i].trim() !== '' && !isBlockStart(lines, i)) {
        item.content += '\n' + lines[i].trim()
        i++
      }
    }

    // 归一化缩进：以组内最小缩进为基准（防御个别行缩进错乱）
    var minIndent = Infinity
    items.forEach(function (it) {
      if (it.indent < minIndent) minIndent = it.indent
    })
    items.forEach(function (it) {
      it.indent -= minIndent
    })

    return { html: buildList(items, 0, items[0].indent), nextIndex: i }
  }

  // 根据缩进递归构造嵌套列表
  function buildList(items, start, baseIndent) {
    var tag = items[start].type === 'ol' ? 'ol' : 'ul'
    var html = '<' + tag + '>'
    var i = start
    var n = items.length
    while (i < n && items[i].indent >= baseIndent) {
      if (items[i].indent > baseIndent) break // 防御：不应出现
      var item = items[i]
      if (item.task !== undefined) {
        // 任务项：checkbox（前端监听 change 回写源文件，data-line 记录源码行号）
        html += '<li class="task-item"><label><input type="checkbox" data-line="' + item.lineNo + '"'
          + (item.task ? ' checked' : '') + '><span>'
          + renderInline(item.content).replace(/\n/g, '<br>\n') + '</span></label>'
      } else {
        html += '<li>' + renderInline(item.content).replace(/\n/g, '<br>\n')
      }
      var j = i + 1
      if (j < n && items[j].indent > baseIndent) {
        var childStart = j
        while (j < n && items[j].indent > baseIndent) j++
        html += buildList(items, childStart, items[childStart].indent)
        i = j
      } else {
        i++
      }
      html += '</li>'
    }
    return html + '</' + tag + '>'
  }

  /* ---------------- 表格：| 开头行 + | --- | --- | 分隔行 ---------------- */
  function parseTable(lines, i) {
    var headerCells = splitCells(lines[i])
    i += 2 // 跳过表头行与分隔行
    var rows = []
    while (i < lines.length) {
      var t = lines[i].trim()
      if (t === '' || !t.startsWith('|')) break
      rows.push(splitCells(t))
      i++
    }

    var html = '<table><thead><tr>'
    headerCells.forEach(function (cell) {
      html += '<th>' + renderInline(cell.trim()) + '</th>'
    })
    html += '</tr></thead>'
    if (rows.length) {
      html += '<tbody>'
      rows.forEach(function (row) {
        html += '<tr>'
        row.forEach(function (cell) {
          html += '<td>' + renderInline(cell.trim()) + '</td>'
        })
        html += '</tr>'
      })
      html += '</tbody>'
    }
    return { html: html + '</table>', nextIndex: i }
  }

  // 按 | 拆分单元格，去掉首尾多余管道符
  function splitCells(row) {
    var s = row.trim()
    if (s.startsWith('|')) s = s.slice(1)
    if (s.endsWith('|')) s = s.slice(0, -1)
    return s.split('|')
  }

  /* ---------------- 对外 API ---------------- */
  window.MarkdownParser = {
    /**
     * 解析 Markdown 文本。
     * @param {string} mdText Markdown 源码
     * @returns {{ html: string, languages: string[] }}
     */
    parse: function (mdText) {
      languages = [] // 每次解析重新收集
      var text = String(mdText == null ? '' : mdText).replace(/\r\n?/g, '\n')
      var lines = text.split('\n')
      return { html: parseBlocks(lines), languages: languages }
    },
  }
})()
