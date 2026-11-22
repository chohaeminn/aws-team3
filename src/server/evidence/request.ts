import express from "express";
import type { Request } from "express";
import type { EvidenceAnalysisInput, EvidenceImage } from "./analyzer.js";

const maxImages = 4;
const maxImageBytes = 3 * 1024 * 1024;
const maxTextBytes = 100 * 1024;
const multipartType = "multipart/form-data";

export const readEvidenceBody = express.raw({
  type: multipartType,
  limit: maxImages * maxImageBytes + maxTextBytes + 100 * 1024,
});

export class InvalidEvidenceInput extends Error {}

export async function parseEvidenceInput(req: Request): Promise<EvidenceAnalysisInput> {
  if (!req.is(multipartType)) {
    const text: unknown = req.body?.text;
    if (typeof text !== "string" || !text.trim()) {
      throw new InvalidEvidenceInput("취소 메일 텍스트를 입력해 주세요.");
    }
    return { text, images: [] };
  }

  const body = req.body as Buffer | undefined;
  let form: FormData;
  try {
    form = await new Response(body ? Uint8Array.from(body) : null, {
      headers: { "Content-Type": req.get("Content-Type") ?? multipartType },
    }).formData();
  } catch {
    throw new InvalidEvidenceInput("증빙 요청 형식을 확인해 주세요.");
  }

  const texts = form.getAll("text");
  const text = texts[0];
  if (texts.length > 1 || (text !== undefined && typeof text !== "string")) {
    throw new InvalidEvidenceInput("취소 메일 텍스트는 한 번만 입력해 주세요.");
  }
  if (text !== undefined && Buffer.byteLength(text) > maxTextBytes) {
    throw new InvalidEvidenceInput("취소 메일 텍스트는 100 KiB 이하로 입력해 주세요.");
  }

  const files = form.getAll("images");
  if (files.length > maxImages) {
    throw new InvalidEvidenceInput("캡처는 최대 4장까지 올릴 수 있어요.");
  }
  const images = await Promise.all(files.map(async (file): Promise<EvidenceImage> => {
    if (typeof file === "string" || (file.type !== "image/png" && file.type !== "image/jpeg")) {
      throw new InvalidEvidenceInput("PNG·JPG 이미지만 올릴 수 있어요.");
    }
    if (file.size === 0 || file.size > maxImageBytes) {
      throw new InvalidEvidenceInput("캡처 파일은 내용이 있어야 하며 3 MiB 이하여야 해요.");
    }
    return { mediaType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
  }));
  if (!text?.trim() && images.length === 0) {
    throw new InvalidEvidenceInput("취소 메일 텍스트를 입력하거나 캡처를 추가해 주세요.");
  }
  return { text: text?.trim() ? text : undefined, images };
}
