// Upload de imagens recebidas por WhatsApp para o Cloudflare R2 (compatível com a API S3).
// Cada usuário tem sua própria "pasta" no bucket, isolada pelo celular normalizado.

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY || '',
  },
});

const EXTENSAO_POR_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

function extensaoParaMime(mimeType: string): string {
  return EXTENSAO_POR_MIME[mimeType] || 'jpg';
}

// Sobe a imagem para `clientes/{celular}/{uuid}.{ext}` e retorna a URL pública.
export async function uploadImagem(buffer: Buffer, celular: string, mimeType: string): Promise<string> {
  const key = `clientes/${celular}/${crypto.randomUUID()}.${extensaoParaMime(mimeType)}`;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.CLOUDFLARE_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    }),
  );

  return `${process.env.CLOUDFLARE_PUBLIC_BASE_URL}/${key}`;
}
