package com.shinewriter

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TtsTextChunkerTest {

    @Test
    fun shortText_isNotChunked() {
        val text = "这是一段短文本。"
        val chunks = TtsTextChunker.split(text, 100)
        assertEquals(listOf("这是一段短文本。"), chunks)
    }

    @Test
    fun splitsOnChinesePeriods() {
        val text = "第一句。第二句。第三句。"
        val chunks = TtsTextChunker.split(text, 10)
        assertEquals(
            listOf(
                "第一句。",
                "第二句。",
                "第三句。",
            ),
            chunks,
        )
    }

    @Test
    fun mixedChineseAndEnglish() {
        val text = "Hello world. 你好世界。Next sentence."
        val chunks = TtsTextChunker.split(text, 20)
        assertEquals(
            listOf(
                "Hello world.",
                " 你好世界。",
                "Next sentence.",
            ),
            chunks,
        )
    }

    @Test
    fun blankLinesSeparateParagraphs() {
        val text = "第一段\n\n第二段\n\n第三段"
        val chunks = TtsTextChunker.split(text, 100)
        assertEquals(
            listOf(
                "第一段",
                "第二段",
                "第三段",
            ),
            chunks,
        )
    }

    @Test
    fun longTextWithoutPunctuation_isHardCut() {
        val text = "a".repeat(2000)
        val maxLength = 500
        val chunks = TtsTextChunker.split(text, maxLength)
        assertTrue(chunks.size >= 4)
        for (chunk in chunks) {
            assertTrue(chunk.length <= maxLength)
        }
        assertEquals(text, chunks.joinToString(""))
    }

    @Test
    fun everyChunkRespectsMaxLength() {
        val text = "一二三四五。".repeat(100)
        val maxLength = 30
        val chunks = TtsTextChunker.split(text, maxLength)
        for (chunk in chunks) {
            assertTrue("chunk length ${chunk.length} > $maxLength", chunk.length <= maxLength)
        }
    }

    @Test
    fun concatenationPreservesOriginalContent() {
        val text = "第一句。第二句，第三句；第四句！第五句？最后一句话没有标点"
        val chunks = TtsTextChunker.split(text, 15)
        assertEquals(text, chunks.joinToString(""))
    }

    @Test
    fun emptyStringReturnsEmptyList() {
        assertEquals(emptyList<String>(), TtsTextChunker.split("", 100))
    }

    @Test
    fun whitespaceOnlyReturnsEmptyList() {
        assertEquals(emptyList<String>(), TtsTextChunker.split("   \n\n  \t  ", 100))
    }
}
