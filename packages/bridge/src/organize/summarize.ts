const TERM_LEXICON = [
  'javascript', 'typescript', 'react', 'vue', 'css', '前端', '浏览器', '组件', '性能',
  '人工智能', '大模型', 'llm', '智能体', '提示词', '机器学习',
  '产品', '交互', '设计', '用户体验', '投资', '通胀', '股票', '商业', '利率', '估值',
  '效率', '工具', '自动化', '工作流', '知识库', '采集', '隐私', '本地',
] as const;

const STOP_WORDS = new Set([
  '一个', '一种', '一些', '这个', '这些', '可以', '应该', '需要', '以及', '通过', '进行',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into',
]);

function splitSentences(text: string): string[] {
  return (text.match(/[^。！？!?\n]+[。！？!?]?/g) ?? [])
    .map(sentence => sentence.replace(/\s+/g, ' ').trim())
    .filter(sentence => sentence.length >= 12);
}

function titleTerms(title: string): string[] {
  const lower = title.toLowerCase();
  return TERM_LEXICON.filter(term => lower.includes(term)).map(term => term.toLowerCase());
}

export function summarize(text: string, title: string): string {
  const titleKeywords = titleTerms(title);
  const seen = new Set<string>();
  const candidates = splitSentences(text)
    .filter(sentence => {
      const key = sentence.replace(/[\s，。！？!?、；;：:]/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((sentence, index) => ({
      sentence,
      index,
      score:
        Math.max(0, 6 - index) +
        titleKeywords.filter(term => sentence.toLowerCase().includes(term)).length * 5 +
        (sentence.length >= 24 && sentence.length <= 90 ? 3 : 0) +
        (/[。！？!?]$/.test(sentence) ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 4)
    .sort((a, b) => a.index - b.index);

  let result = '';
  for (const candidate of candidates) {
    if (result.length + candidate.sentence.length > 280) break;
    result += candidate.sentence;
  }
  return result || text.replace(/\s+/g, ' ').trim().slice(0, 280);
}

export function keywords(text: string, title: string): string[] {
  const haystack = `${title}\n${title}\n${title}\n${text}`.toLowerCase();
  const scores = new Map<string, number>();
  for (const term of TERM_LEXICON) {
    const normalized = term.toLowerCase();
    let count = 0;
    let offset = 0;
    while ((offset = haystack.indexOf(normalized, offset)) >= 0) {
      count += 1;
      offset += normalized.length;
    }
    if (count > 0 && !STOP_WORDS.has(normalized)) scores.set(normalized, count);
  }
  for (const match of haystack.matchAll(/[a-z][a-z0-9+#.-]{1,24}/g)) {
    const term = match[0];
    if (!STOP_WORDS.has(term)) scores.set(term, (scores.get(term) ?? 0) + 1);
  }
  return [...scores]
    .sort(([a, av], [b, bv]) => bv - av || a.localeCompare(b, 'zh-CN'))
    .slice(0, 8)
    .map(([term]) => term);
}
