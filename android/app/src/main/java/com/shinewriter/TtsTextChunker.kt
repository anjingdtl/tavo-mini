package com.shinewriter

object TtsTextChunker {

    /**
     * 将长文本切分为适合系统 TTS 单次 speak 的段。
     *
     * 切分优先级：连续空行 > 换行 > 中文句末 > 英文句末 > 分号 > 逗号 > 字符硬切。
     * 过滤纯空白段，保证每段非空且长度不超过 maxLength。
     */
    fun split(text: String, maxLength: Int): List<String> {
        require(maxLength > 0) { "maxLength must be positive" }

        val cleaned = text.trim()
        if (cleaned.isEmpty()) {
            return emptyList()
        }

        val paragraphs = splitByBlankLines(cleaned)
        val result = mutableListOf<String>()

        for (paragraph in paragraphs) {
            val trimmed = paragraph.trim()
            if (trimmed.isEmpty()) continue
            chunkParagraph(trimmed, maxLength, result)
        }

        return result.filter { it.isNotEmpty() }
    }

    private fun splitByBlankLines(text: String): List<String> {
        return text.split(Regex("\n\\s*\n"))
    }

    private fun chunkParagraph(paragraph: String, maxLength: Int, out: MutableList<String>) {
        var remaining = paragraph
        while (remaining.isNotEmpty()) {
            if (remaining.length <= maxLength) {
                out.add(remaining)
                return
            }

            val splitAt = findSplitPoint(remaining, maxLength)
            val chunk = remaining.substring(0, splitAt).trimEnd()
            if (chunk.isNotEmpty()) {
                out.add(chunk)
            }
            remaining = remaining.substring(splitAt).trimStart()
        }
    }

    private fun findSplitPoint(text: String, maxLength: Int): Int {
        val window = text.substring(0, maxLength.coerceAtMost(text.length))

        // 1. 优先在窗口内的最后一个换行处切分
        val newlineIndex = window.lastIndexOf('\n')
        if (newlineIndex > 0) {
            return newlineIndex + 1
        }

        // 2. 中文句末标点（尽量保留标点在前一段）
        val chineseEnd = window.lastIndexOfAny("。！？".toCharArray())
        if (chineseEnd > 0) {
            return chineseEnd + 1
        }

        // 3. 英文句末标点
        val englishEnd = window.lastIndexOfAny(".!?".toCharArray())
        if (englishEnd > 0) {
            return englishEnd + 1
        }

        // 4. 分号
        val semicolonIndex = window.lastIndexOfAny("；;".toCharArray())
        if (semicolonIndex > 0) {
            return semicolonIndex + 1
        }

        // 5. 逗号
        val commaIndex = window.lastIndexOfAny("，,".toCharArray())
        if (commaIndex > 0) {
            return commaIndex + 1
        }

        // 6. 硬切：避免在 UTF-16 代理对中间切开，尽量切到完整字符
        return if (window.length >= 2 &&
            Character.isHighSurrogate(window[window.length - 1])
        ) {
            window.length - 1
        } else {
            window.length
        }
    }
}
