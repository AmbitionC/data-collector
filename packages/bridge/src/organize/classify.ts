import { keywords } from './summarize.js';

const CATEGORY_RULES = [
  ['前端开发', ['javascript', 'typescript', 'react', 'vue', '浏览器', 'css', '前端', '组件']],
  ['人工智能', ['ai', '大模型', 'llm', '智能体', '提示词', '机器学习']],
  ['产品与设计', ['产品', '交互', '设计', '用户体验']],
  ['商业与投资', ['投资', '通胀', '股票', '商业', '利率', '估值']],
  ['效率与工具', ['效率', '工具', '自动化', '工作流', '知识库', '采集']],
  ['生活与随笔', ['生活', '旅行', '随笔', '成长']],
] as const;

export interface ClassificationInput {
  title: string;
  text: string;
  suggestedCategory?: string;
  suggestedTags?: string[];
  userCategory?: string;
  userTags?: string[];
}

export interface Classification {
  category: string;
  tags: string[];
}

function cleanList(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, 8);
}

export function classify(input: ClassificationInput): Classification {
  const title = input.title.toLowerCase();
  const text = input.text.toLowerCase();
  const ranked = CATEGORY_RULES.map(([category, terms], order) => ({
    category,
    order,
    score: terms.reduce(
      (score, term) =>
        score + (title.includes(term.toLowerCase()) ? 3 : 0) +
        (text.includes(term.toLowerCase()) ? 1 : 0),
      0,
    ),
  })).sort((a, b) => b.score - a.score || a.order - b.order);
  const automatic = ranked[0]?.score ? ranked[0].category : '其他';
  const generatedTags = keywords(input.text, input.title);
  return {
    category: input.userCategory?.trim() || input.suggestedCategory?.trim() || automatic,
    tags: input.userTags?.length
      ? cleanList(input.userTags)
      : cleanList([...(input.suggestedTags ?? []), ...generatedTags]),
  };
}
