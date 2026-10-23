import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  commercialConfig,
  geminiAnalyzer,
  inspectEvidence,
  extractionSchema,
  AnalysisFailure,
  normalizeRecipientIdentifier,
} from '../src/commercial-ai.js';

const extraction = {
  patient_name: 'Paciente Sintético',
  readable: true,
  warnings: [],
  payment: null,
  contract: null,
  fields: {
    total_value_cents: 1550000,
    hair_grade_classification: 'Grau 4 A2',
    pack_quantity: null,
    procedure_date: null,
  },
};
const image = () =>
  sharp({ create: { width: 80, height: 120, channels: 3, background: '#c9e5dd' } })
    .png()
    .toBuffer();

test('destinatário: remove só formatação numérica; não aproxima e-mails ou identificadores mascarados', () => {
  assert.equal(normalizeRecipientIdentifier('12.345.678/0001-90'), '12345678000190');
  assert.notEqual(
    normalizeRecipientIdentifier('clinica+pix@teste.com'),
    normalizeRecipientIdentifier('clinicapix@teste.com'),
  );
  assert.notEqual(
    normalizeRecipientIdentifier('cli.nica@teste.com'),
    normalizeRecipientIdentifier('clinica@teste.com'),
  );
  assert.notEqual(normalizeRecipientIdentifier('***.345.678/0001-90'), '12345678000190');
});
test('configuração: sem ativação implícita, sem modelo/chave inventados', () => {
  assert.equal(commercialConfig({}).enabled, false);
  assert.equal(commercialConfig({ COMMERCIAL_AI_ENABLED: 'true' }).aiEnabled, false);
  assert.throws(() =>
    commercialConfig({ COMMERCIAL_EVIDENCE_ENABLED: 'true', COMMERCIAL_AI_ENABLED: 'true' }),
  );
  assert.throws(() => commercialConfig({ COMMERCIAL_AI_DAILY_LIMIT: '-2' }));
  assert.equal(commercialConfig({}).autoValidate, false);
});
test('imagem: decodificação real, limite e MIME declarado não bastam', async () => {
  const bytes = await image();
  const result = await inspectEvidence(bytes, 'image/png');
  assert.match(result.hash, /^[0-9a-f]{64}$/);
  assert.equal((await sharp(result.normalized).metadata()).format, 'jpeg');
  await assert.rejects(() => inspectEvidence(bytes, 'image/jpeg'), { code: 'INVALID_IMAGE' });
  await assert.rejects(() => inspectEvidence(Buffer.from('<svg>bad</svg>'), 'image/png'), {
    code: 'INVALID_IMAGE',
  });
  await assert.rejects(() => inspectEvidence(Buffer.alloc(8 * 1024 * 1024 + 1), 'image/png'), {
    code: 'INVALID_FILE_SIZE',
  });
});
test('Gemini: entrada privada, segredo em header e saída validada, sem ferramentas', async () => {
  const config = { ...commercialConfig({}), model: 'test-model', apiKey: 'synthetic-secret' };
  let called = false;
  const analyzer = geminiAnalyzer(config, (async (url, options) => {
    called = true;
    assert.equal(String(url).includes('synthetic-secret'), false);
    assert.equal((options!.headers as Record<string, string>)['x-goog-api-key'], config.apiKey);
    assert.equal(options!.redirect, 'error');
    const body = JSON.parse(String(options!.body));
    assert.equal(body.tools, undefined);
    assert.ok(body.generationConfig.responseJsonSchema);
    assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
    assert.match(body.systemInstruction.parts[0].text, /NÃO CONFIÁVEIS/);
    return new Response(
      JSON.stringify({
        candidates: [
          { finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(extraction) }] } },
        ],
      }),
    );
  }) as typeof fetch);
  assert.deepEqual(
    await analyzer(
      [{ bytes: await image(), mime: 'image/png' }],
      'contract_summary',
      new AbortController().signal,
    ),
    extraction,
  );
  assert.equal(called, true);
});
test('Gemini: erros permanentes, temporários e conteúdo inválido não viram fatos', async () => {
  for (const [status, retryable] of [
    [403, false],
    [429, true],
    [503, true],
  ] as const) {
    const analyzer = geminiAnalyzer(
      commercialConfig({}),
      (async () => new Response('', { status })) as typeof fetch,
    );
    await assert.rejects(
      () => analyzer([], 'payment', new AbortController().signal),
      (error: unknown) => error instanceof AnalysisFailure && error.retryable === retryable,
    );
  }
  const analyzer = geminiAnalyzer(
    commercialConfig({}),
    (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            { finishReason: 'STOP', content: { parts: [{ text: '{"approved":true}' }] } },
          ],
        }),
      )) as typeof fetch,
  );
  await assert.rejects(() => analyzer([], 'payment', new AbortController().signal), {
    code: 'AI_INVALID_RESULT',
  });
  assert.equal(
    extractionSchema.safeParse({
      ...extraction,
      fields: { ...extraction.fields, procedure_date: '2026-02-31' },
    }).success,
    false,
  );
});
