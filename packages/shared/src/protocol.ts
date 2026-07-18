import { z } from 'zod';
import { canonicalizeUrl, parseSupportedUrl } from './url.js';

export const collectedImageSchema = z.object({
  url: z.string().url().max(4096),
  alt: z.string().trim().max(500).optional(),
});

export const collectedDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.enum(['wechat', 'zsxq']),
  kind: z.enum(['article', 'post', 'question', 'answer']),
  url: z.string().url().max(4096),
  canonicalUrl: z.string().url().max(4096),
  title: z.string().trim().min(1).max(500),
  author: z.string().trim().max(200).optional(),
  publishedAt: z.iso.datetime().optional(),
  collectedAt: z.iso.datetime(),
  html: z.string().max(10_000_000),
  text: z.string().max(5_000_000),
  images: z.array(collectedImageSchema).max(30),
  suggestedCategory: z.string().trim().max(100).optional(),
  suggestedTags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  userCategory: z.string().trim().max(100).optional(),
  userTags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  sourceMetadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
}).superRefine((document, context) => {
  try {
    const rawUrl = parseSupportedUrl(document.url);
    const canonicalUrl = canonicalizeUrl(rawUrl).href;
    if (document.canonicalUrl !== canonicalUrl) {
      context.addIssue({
        code: 'custom',
        path: ['canonicalUrl'],
        message: 'canonicalUrl 与原始 URL 不一致',
      });
    }
    const expectedSource = rawUrl.hostname === 'mp.weixin.qq.com' ? 'wechat' : 'zsxq';
    if (document.source !== expectedSource) {
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message: '内容来源与 URL 域名不一致',
      });
    }
    if (document.source === 'wechat' && document.kind !== 'article') {
      context.addIssue({
        code: 'custom',
        path: ['kind'],
        message: '微信公众号内容类型必须是 article',
      });
    }
  } catch {
    context.addIssue({
      code: 'custom',
      path: ['url'],
      message: '内容 URL 不在支持列表中',
    });
  }
});

export const wsEnvelopeSchema = z.object({
  protocolVersion: z.literal(1),
  type: z.string().trim().min(1).max(100),
  requestId: z.string().trim().min(1).max(100),
  timestamp: z.iso.datetime(),
  payload: z.unknown(),
});

export const collectJobPayloadSchema = z.object({
  url: z.string().url().max(4096),
  userCategory: z.string().trim().max(100).optional(),
  userTags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
});

export const jobResultPayloadSchema = z.object({
  document: collectedDocumentSchema,
});

export type CollectedDocumentInput = z.infer<typeof collectedDocumentSchema>;
