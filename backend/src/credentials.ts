import { z } from 'zod';

// E-mails antigos continuam válidos como login para não bloquear contas já existentes.
// Novas contas podem usar identificadores simples, como "atendente1".
export const loginSchema = z
  .string()
  .trim()
  .min(1, 'Informe o login.')
  .max(200)
  .regex(
    /^[a-zA-Z0-9._@+-]+$/,
    'Use apenas letras, números, ponto, hífen, sublinhado, + ou @ no login.',
  )
  .transform((value) => value.toLowerCase());

// A única exigência funcional é que a senha não esteja vazia.
export const passwordSchema = z.string().min(1, 'Informe a senha.').max(128);

export const normalizeLogin = (value: string) => value.trim().toLowerCase();
