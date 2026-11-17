import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, makeEslint, reports } from './helpers.ts';

const RULE = 'drefyn/no-direct-model-call';
const root = fixture('models');
const eslint = makeEslint(root, { [RULE]: 'error' });

const lintAt = async (path: string, code: string) =>
  reports(await eslint.lintText(code, { filePath: join(root, path) }));
const lint = (code: string) => lintAt('apps/web/src/call.ts', code);

const ENDPOINT = 'Model provider call outside @drefyn/ai';
const SDK = 'Vendor model SDK';

describe('no-direct-model-call', () => {
  it('reports the SDK import, the provider URL and the provider header in the fixture', async () => {
    const badFile = 'apps/web/src/direct.ts';
    const found = await lintAt(badFile, readFileSync(join(root, badFile), 'utf8'));
    expect(found.map((report) => [report.line, report.message.split('.')[0]])).toEqual([
      [1, SDK],
      [6, ENDPOINT],
      [7, ENDPOINT],
    ]);
    expect(new Set(found.map((report) => report.ruleId))).toEqual(new Set([RULE]));
  });

  it.each([
    "export const u = 'https://api.anthropic.com/v1/messages';",
    "export const u = 'https://API.OpenAI.com/v1/models';",
    "export const u = 'https://example.openai.azure.com/openai/deployments';",
    "export const u = 'https://generativelanguage.googleapis.com/v1beta/models';",
    "export const u = 'https://us-central1-aiplatform.googleapis.com/v1/projects';",
    "export const u = 'https://bedrock-runtime.us-east-1.amazonaws.com/model';",
    "export const u = 'https://api.mistral.ai/v1';",
    "export const u = 'https://api.cohere.com/v2/chat';",
    "export const u = 'https://api.groq.com/openai/v1';",
    "export const u = 'https://openrouter.ai/api/v1';",
    "export const u = 'https://api.together.xyz/v1';",
    "export const u = 'https://api.deepseek.com';",
    "export const u = 'https://api.x.ai/v1';",
    "export const p = '/chat/completions';",
    "export const p = '/v1/messages';",
    "export const p = '/v1/completions';",
    "export const h = { 'anthropic-version': '2023-06-01' };",
    "export const h = { 'anthropic-beta': 'x' };",
    'export const u = (base: string) => `${base}/chat/completions`;',
    'export const u = `https://api.anthropic.com/v1/messages`;',
  ])('reports %s', async (code) => {
    const found = await lint(code);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain(ENDPOINT);
  });

  it.each([
    "import Anthropic from '@anthropic-ai/sdk';",
    "import { Bedrock } from '@anthropic-ai/bedrock-sdk';",
    "import OpenAI from 'openai';",
    "import { toFile } from 'openai/uploads';",
    "import { GoogleGenAI } from '@google/genai';",
    "import { GoogleGenerativeAI } from '@google/generative-ai';",
    "import { VertexAI } from '@google-cloud/vertexai';",
    "import { Mistral } from '@mistralai/mistralai';",
    "import { CohereClient } from 'cohere-ai';",
    "import Groq from 'groq-sdk';",
    "import { generateText } from 'ai';",
    "import { anthropic } from '@ai-sdk/anthropic';",
    "import { ChatAnthropic } from '@langchain/anthropic';",
    "import { OpenAI as L } from 'langchain/llms/openai';",
    "import ollama from 'ollama';",
    "import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';",
    "import type Anthropic from '@anthropic-ai/sdk';",
    "export * from 'openai';",
    "export { default } from 'openai';",
    "export const load = () => import('openai');",
    "const sdk = require('@anthropic-ai/sdk');\nexport default sdk;",
    "import sdk = require('openai');\nexport default sdk;",
  ])('reports the SDK in %s', async (code) => {
    const found = await lint(code);
    expect(found.map((report) => report.message.split('.')[0])).toEqual([SDK]);
  });

  it('reports a vendor SDK inside @drefyn/ai too, which speaks the wire formats itself', async () => {
    const found = await lintAt('packages/ai/src/anthropic.ts', "import OpenAI from 'openai';");
    expect(found).toHaveLength(1);
  });

  it.each([
    'packages/ai/src/anthropic.ts',
    'packages/ai/test/support/fake.ts',
    'scripts/lint-rules/src/rule.ts',
  ])('leaves provider URLs alone in %s', async (path) => {
    const code = [
      "export const u = 'https://api.anthropic.com';",
      "export const p = '/chat/completions';",
      "export const h = { 'anthropic-version': '2023-06-01' };",
    ].join('\n');
    expect(await lintAt(path, code)).toEqual([]);
  });

  it.each([
    "export const u = 'https://api.example.com/v1/messages-archive';",
    "export const a = 'aiplatform';",
    "export const m = 'claude-sonnet-5-5';",
    "export const s = 'ai';",
    "import { x } from 'ai-utils';",
    "import { y } from 'openai-compatible-thing';",
    "import { z } from '@drefyn/ai';",
    "export const k = (o: Record<string, string>) => o['x-api-key'];",
    'export const t = `${1}/chat`;',
  ])('leaves %s alone', async (code) => {
    expect(await lint(code)).toEqual([]);
  });

  it('reports a file outside every workspace, which no package can own', async () => {
    const found = reports(
      await eslint.lintText("export const u = 'https://api.openai.com/v1';", {
        filePath: '/tmp/drefyn-outside/x.ts',
      }),
    );
    expect(found).toHaveLength(1);
  });
});
